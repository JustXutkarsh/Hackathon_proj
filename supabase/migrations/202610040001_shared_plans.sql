begin;

create schema if not exists countmein_private;
revoke all on schema countmein_private from public, anon, authenticated;

create table countmein_private.plans (
  id uuid primary key default gen_random_uuid(),
  invitation_token uuid not null unique default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  title text not null check (char_length(btrim(title)) between 1 and 70),
  activity text not null check (activity in ('sport', 'outing', 'social')),
  location text not null check (char_length(btrim(location)) between 1 and 90),
  amount integer not null check (amount between 1 and 10000),
  target integer not null check (target between 2 and 50),
  deadline timestamptz not null check (isfinite(deadline)),
  event_at timestamptz not null check (isfinite(event_at) and event_at > deadline),
  state text not null default 'open' check (state in ('open', 'funded', 'cancelled', 'failed')),
  created_at timestamptz not null default clock_timestamp()
);

create table countmein_private.participations (
  plan_id uuid not null references countmein_private.plans(id),
  user_id uuid not null references auth.users(id),
  joined_at timestamptz not null default clock_timestamp(),
  refunded_at timestamptz,
  primary key (plan_id, user_id)
);
create index on countmein_private.plans(owner_id);
create index on countmein_private.participations(user_id);

alter table countmein_private.plans enable row level security;
alter table countmein_private.participations enable row level security;
-- No direct client access, even if someone later grants table privileges.
create policy rpc_only on countmein_private.plans as restrictive for all to anon, authenticated using (false) with check (false);
create policy rpc_only on countmein_private.participations as restrictive for all to anon, authenticated using (false) with check (false);
revoke all on all tables in schema countmein_private from public, anon, authenticated;

-- Definer functions expose only token-scoped summaries, never account identities.
create function public.preview_plan(p_token uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'token', p.invitation_token, 'title', p.title, 'activity', p.activity,
    'location', p.location, 'amount', p.amount, 'target', p.target,
    'deadline', p.deadline, 'event_at', p.event_at,
    'state', case when p.state = 'open' and p.deadline <= statement_timestamp() then 'failed' else p.state end,
    'count', (select count(*) from countmein_private.participations m where m.plan_id = p.id),
    'is_owner', coalesce(p.owner_id = auth.uid(), false),
    'joined', exists(select 1 from countmein_private.participations m where m.plan_id = p.id and m.user_id = auth.uid()),
    'refunded', exists(select 1 from countmein_private.participations m where m.plan_id = p.id and m.user_id = auth.uid() and m.refunded_at is not null)
  ) from countmein_private.plans p where p.invitation_token = p_token;
$$;

create function public.my_plans() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in to view your plans.' using errcode = '28000'; end if;
  return coalesce((select jsonb_agg(public.preview_plan(p.invitation_token) order by p.created_at desc)
    from countmein_private.plans p where p.owner_id = auth.uid() or exists
    (select 1 from countmein_private.participations m where m.plan_id = p.id and m.user_id = auth.uid())), '[]'::jsonb);
end;
$$;

create function public.create_plan(p_title text, p_activity text, p_location text, p_amount integer,
  p_target integer, p_deadline timestamptz, p_event_at timestamptz) returns uuid
language plpgsql security definer set search_path = '' as $$
declare token uuid;
begin
  if auth.uid() is null then raise exception 'Sign in to create a plan.' using errcode = '28000'; end if;
  if p_deadline <= clock_timestamp() then raise exception 'Choose a future funding deadline.'; end if;
  insert into countmein_private.plans(owner_id, title, activity, location, amount, target, deadline, event_at)
  values(auth.uid(), btrim(p_title), p_activity, btrim(p_location), p_amount, p_target, p_deadline, p_event_at)
  returning invitation_token into token;
  return token;
end;
$$;

create function public.act_on_plan(p_token uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare p countmein_private.plans; actor uuid := auth.uid(); n integer;
begin
  if actor is null then raise exception 'Your session expired. Sign in again.' using errcode = '28000'; end if;
  -- All mutations for a plan take the same row lock before checking time or count.
  select * into p from countmein_private.plans where invitation_token = p_token for update;
  if not found then raise exception 'Plan not found.'; end if;
  if p.state = 'open' and p.deadline <= clock_timestamp() then
    update countmein_private.plans set state = 'failed' where id = p.id;
    p.state := 'failed';
  end if;
  if p_action = 'join' then
    if p.state <> 'open' then raise exception 'This plan is no longer accepting demo contributions.'; end if;
    if exists(select 1 from countmein_private.participations where plan_id = p.id and user_id = actor) then
      raise exception 'You have already joined this plan.';
    end if;
    select count(*) into n from countmein_private.participations where plan_id = p.id;
    if n >= p.target then raise exception 'This plan is full.'; end if;
    insert into countmein_private.participations(plan_id, user_id) values(p.id, actor);
    if n + 1 = p.target then update countmein_private.plans set state = 'funded' where id = p.id; end if;
  elsif p_action = 'cancel' then
    if p.owner_id <> actor then raise exception 'Only the organizer can cancel a plan.'; end if;
    if p.state <> 'open' then raise exception 'Only an open plan can be cancelled.'; end if;
    update countmein_private.plans set state = 'cancelled' where id = p.id;
  elsif p_action = 'refund' then
    if p.state not in ('cancelled', 'failed') then raise exception 'Simulated refunds are not open.'; end if;
    update countmein_private.participations set refunded_at = clock_timestamp()
      where plan_id = p.id and user_id = actor and refunded_at is null;
    if not found then raise exception 'No simulated contribution available to refund.'; end if;
  else
    raise exception 'Unknown action.';
  end if;
end;
$$;

revoke all on function public.preview_plan(uuid), public.my_plans(), public.create_plan(text,text,text,integer,integer,timestamptz,timestamptz), public.act_on_plan(uuid,text) from public, anon, authenticated;
grant execute on function public.preview_plan(uuid) to anon, authenticated;
grant execute on function public.my_plans(), public.create_plan(text,text,text,integer,integer,timestamptz,timestamptz), public.act_on_plan(uuid,text) to authenticated;
commit;

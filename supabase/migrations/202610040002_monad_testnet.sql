begin;

alter table countmein_private.plans
  add column payment_mode text not null default 'demo',
  add column contribution_wei numeric(29,0),
  add column recipient_wallet text,
  add column organizer_wallet text,
  add column escrow_address text,
  add column chain_plan_id numeric(78,0),
  add column chain_create_tx text;

alter table countmein_private.plans drop constraint plans_amount_check;
alter table countmein_private.plans add constraint plans_payment_terms_check check (
  (payment_mode = 'demo' and amount between 1 and 10000 and contribution_wei is null and recipient_wallet is null and organizer_wallet is null and escrow_address is null)
  or
  (payment_mode = 'monad_testnet' and amount = 0 and contribution_wei is not null and contribution_wei between 1 and 79228162514264337593543950335
    and recipient_wallet is not null and recipient_wallet ~ '^0x[0-9a-fA-F]{40}$' and recipient_wallet <> '0x0000000000000000000000000000000000000000'
    and organizer_wallet is not null and organizer_wallet ~ '^0x[0-9a-fA-F]{40}$' and organizer_wallet <> '0x0000000000000000000000000000000000000000'
    and escrow_address is not null and escrow_address ~ '^0x[0-9a-fA-F]{40}$' and escrow_address <> '0x0000000000000000000000000000000000000000'
    and deadline = date_trunc('second', deadline) and event_at = date_trunc('second', event_at))
);
alter table countmein_private.plans add constraint plans_chain_reference_check check (
  (chain_plan_id is null and chain_create_tx is null)
  or
  (payment_mode = 'monad_testnet' and chain_plan_id is not null and chain_create_tx is not null
    and chain_plan_id between 0 and 115792089237316195423570985008687907853269984665640564039457584007913129639935 and chain_create_tx ~ '^0x[0-9a-fA-F]{64}$')
);
create unique index plans_chain_plan_id_unique on countmein_private.plans(lower(escrow_address),chain_plan_id) where chain_plan_id is not null;

-- Bookmarks are private navigation aids, never evidence of a deposit.
create table countmein_private.chain_bookmarks (
  plan_id uuid not null references countmein_private.plans(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key(plan_id,user_id)
);
alter table countmein_private.chain_bookmarks enable row level security;
create policy deny_direct_access on countmein_private.chain_bookmarks as restrictive for all using(false) with check(false);
revoke all on countmein_private.chain_bookmarks from public, anon, authenticated;

create or replace function public.preview_plan(p_token uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'token', p.invitation_token, 'title', p.title, 'activity', p.activity,
    'location', p.location, 'amount', p.amount, 'target', p.target,
    'deadline', p.deadline, 'event_at', p.event_at,
    'payment_mode', p.payment_mode,
    'contribution_wei', case when p.contribution_wei is null then null else p.contribution_wei::text end,
    'recipient_wallet', p.recipient_wallet,
    'organizer_wallet', p.organizer_wallet, 'escrow_address', p.escrow_address,
    'chain_plan_id', case when p.chain_plan_id is null then null else p.chain_plan_id::text end,
    'chain_create_tx', p.chain_create_tx,
    'state', case
      when p.payment_mode = 'monad_testnet' and p.chain_plan_id is null then 'awaiting_contract'
      when p.payment_mode = 'monad_testnet' then 'chain'
      when p.state = 'open' and p.deadline <= statement_timestamp() then 'failed'
      else p.state end,
    'count', case when p.payment_mode = 'demo' then (select count(*) from countmein_private.participations m where m.plan_id = p.id) else null end,
    'is_owner', coalesce(p.owner_id = auth.uid(), false),
    'joined', exists(select 1 from countmein_private.participations m where m.plan_id = p.id and m.user_id = auth.uid()),
    'refunded', exists(select 1 from countmein_private.participations m where m.plan_id = p.id and m.user_id = auth.uid() and m.refunded_at is not null)
  ) from countmein_private.plans p where p.invitation_token = p_token;
$$;

create function public.create_chain_plan(p_title text, p_activity text, p_location text, p_contribution_wei text,
  p_target integer, p_deadline timestamptz, p_event_at timestamptz, p_recipient_wallet text, p_organizer_wallet text, p_escrow_address text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare token uuid; contribution numeric(29,0);
begin
  if auth.uid() is null then raise exception 'Sign in to create a plan.' using errcode = '28000'; end if;
  if p_contribution_wei is null or p_contribution_wei !~ '^[0-9]+$' then raise exception 'Invalid testnet contribution.'; end if;
  contribution := p_contribution_wei::numeric;
  if p_deadline <= clock_timestamp() then raise exception 'Choose a future funding deadline.'; end if;
  insert into countmein_private.plans(owner_id, title, activity, location, amount, target, deadline, event_at,
    payment_mode, contribution_wei, recipient_wallet, organizer_wallet, escrow_address)
  values(auth.uid(), btrim(p_title), p_activity, btrim(p_location), 0, p_target, p_deadline, p_event_at,
    'monad_testnet', contribution, p_recipient_wallet, p_organizer_wallet, p_escrow_address)
  returning invitation_token into token;
  return token;
end;
$$;

create function public.attach_chain_plan(p_token uuid, p_chain_plan_id text, p_create_tx text) returns void
language plpgsql security definer set search_path = '' as $$
declare plan countmein_private.plans; chain_id numeric(78,0);
begin
  if auth.uid() is null then raise exception 'Your session expired. Sign in again.' using errcode = '28000'; end if;
  if p_chain_plan_id is null or p_create_tx is null or p_chain_plan_id !~ '^[0-9]+$' or p_create_tx !~ '^0x[0-9a-fA-F]{64}$' then raise exception 'Invalid chain reference.'; end if;
  chain_id := p_chain_plan_id::numeric;
  select * into plan from countmein_private.plans where invitation_token = p_token for update;
  if not found then raise exception 'Plan not found.'; end if;
  if plan.owner_id <> auth.uid() then raise exception 'Only the organizer can attach the escrow plan.'; end if;
  if plan.payment_mode <> 'monad_testnet' then raise exception 'Escrow plan cannot be attached.'; end if;
  if plan.chain_plan_id = chain_id and lower(plan.chain_create_tx) = lower(p_create_tx) then return; end if;
  if plan.chain_plan_id is not null then raise exception 'Escrow plan cannot be attached.'; end if;
  update countmein_private.plans set chain_plan_id = chain_id, chain_create_tx = p_create_tx where id = plan.id;
end;
$$;

create function public.remember_chain_plan(p_token uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare plan countmein_private.plans;
begin
  if auth.uid() is null then raise exception 'Your session expired. Sign in again.' using errcode = '28000'; end if;
  select * into plan from countmein_private.plans where invitation_token = p_token;
  if not found or plan.payment_mode <> 'monad_testnet' or plan.chain_plan_id is null then raise exception 'Escrow plan is not active.'; end if;
  insert into countmein_private.chain_bookmarks(plan_id, user_id)
  values(plan.id, auth.uid()) on conflict do nothing;
end;
$$;

create or replace function public.my_plans() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in to see your plans.' using errcode = '28000'; end if;
  return coalesce((select jsonb_agg(public.preview_plan(p.invitation_token) order by p.created_at desc)
    from countmein_private.plans p where p.owner_id = auth.uid()
      or exists(select 1 from countmein_private.participations m where m.plan_id=p.id and m.user_id=auth.uid())
      or exists(select 1 from countmein_private.chain_bookmarks b where b.plan_id=p.id and b.user_id=auth.uid())), '[]'::jsonb);
end;
$$;

create or replace function public.act_on_plan(p_token uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare p countmein_private.plans; actor uuid := auth.uid(); n integer;
begin
  if actor is null then raise exception 'Your session expired. Sign in again.' using errcode = '28000'; end if;
  select * into p from countmein_private.plans where invitation_token = p_token for update;
  if not found then raise exception 'Plan not found.'; end if;
  if p.payment_mode <> 'demo' then raise exception 'Use the Monad escrow for this plan.'; end if;
  if p.state = 'open' and p.deadline <= clock_timestamp() then
    update countmein_private.plans set state = 'failed' where id = p.id;
    p.state := 'failed';
  end if;
  if p_action = 'join' then
    if p.state <> 'open' then raise exception 'This plan is no longer accepting demo contributions.'; end if;
    if exists(select 1 from countmein_private.participations where plan_id = p.id and user_id = actor) then raise exception 'You have already joined this plan.'; end if;
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
    update countmein_private.participations set refunded_at = clock_timestamp() where plan_id = p.id and user_id = actor and refunded_at is null;
    if not found then raise exception 'No simulated contribution available to refund.'; end if;
  else raise exception 'Unknown action.';
  end if;
end;
$$;

revoke all on function public.create_chain_plan(text,text,text,text,integer,timestamptz,timestamptz,text,text,text),
  public.attach_chain_plan(uuid,text,text), public.remember_chain_plan(uuid) from public, anon, authenticated;
grant execute on function public.create_chain_plan(text,text,text,text,integer,timestamptz,timestamptz,text,text,text),
  public.attach_chain_plan(uuid,text,text), public.remember_chain_plan(uuid) to authenticated;

commit;

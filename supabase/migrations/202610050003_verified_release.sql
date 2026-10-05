begin;

-- Keep historical data, but retire every browser-writable practice/payment RPC.
revoke execute on function public.create_plan(text,text,text,integer,integer,timestamptz,timestamptz),
  public.act_on_plan(uuid,text), public.create_chain_plan(text,text,text,text,integer,timestamptz,timestamptz,text,text,text),
  public.attach_chain_plan(uuid,text,text), public.remember_chain_plan(uuid) from public, anon, authenticated;

alter table countmein_private.plans
  add column chain_id integer not null default 10143 check(chain_id = 10143),
  add column release_version integer not null default 1,
  add column description text not null default '' check(length(description) <= 500),
  add column metadata_hash text unique check(metadata_hash ~ '^0x[0-9a-f]{64}$'),
  add column chain_verified boolean not null default false,
  add column business_state text not null default 'draft' check(business_state in ('draft','open','funded','paid','cancelled','failed')),
  add column chain_count integer not null default 0 check(chain_count between 0 and 50),
  add column synced_block bigint not null default -1,
  add column synced_at timestamptz;

create table countmein_private.wallet_challenges (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nonce text not null unique check(nonce ~ '^[a-f0-9]{64}$'),
  address text not null check(address ~ '^0x[0-9a-f]{40}$'),
  message text not null check(length(message) <= 2048),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(), consumed_at timestamptz
);
create table countmein_private.wallet_links (
  chain_id integer not null check(chain_id=10143),
  address text not null check(address ~ '^0x[0-9a-f]{40}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  verified_at timestamptz not null default clock_timestamp(),
  primary key(chain_id,address)
);
create table countmein_private.chain_receipts (
  chain_id integer not null check(chain_id=10143),
  contract_address text not null check(contract_address ~ '^0x[0-9a-f]{40}$'),
  tx_hash text not null check(tx_hash ~ '^0x[0-9a-f]{64}$'), log_index integer not null check(log_index >= -1),
  plan_id uuid not null references countmein_private.plans(id),
  onchain_plan_id numeric(78,0),
  kind text not null check(kind in ('Created','Joined','Cancelled','Collected','Refunded')),
  actor text not null check(actor ~ '^0x[0-9a-f]{40}$'),
  amount_wei numeric(78,0) not null check(amount_wei >= 0),
  status text not null check(status in ('confirmed','failed','replaced')),
  block_number bigint not null check(block_number >= 0), block_hash text not null check(block_hash ~ '^0x[0-9a-f]{64}$'),
  occurred_at timestamptz not null, canonical boolean not null default true,
  primary key(chain_id,contract_address,tx_hash,log_index)
);
create index receipts_wallet on countmein_private.chain_receipts(actor,occurred_at desc);
create table countmein_private.pending_transactions (
  chain_id integer not null check(chain_id=10143), contract_address text not null,
  tx_hash text not null check(tx_hash ~ '^0x[0-9a-f]{64}$'),
  plan_id uuid not null references countmein_private.plans(id),
  actor text not null check(actor ~ '^0x[0-9a-f]{40}$'), nonce bigint not null check(nonce>=0),
  calldata text not null check(length(calldata)<=2048), value_wei numeric(78,0) not null check(value_wei>=0),
  observed_at timestamptz not null default clock_timestamp(), primary key(chain_id,contract_address,tx_hash)
);
create table countmein_private.sync_cursors (
  chain_id integer not null check(chain_id=10143), contract_address text not null,
  block_number bigint not null, block_hash text, halted boolean not null default false,
  review_note text,
  updated_at timestamptz not null default clock_timestamp(), primary key(chain_id,contract_address)
);
alter table countmein_private.wallet_challenges enable row level security;
alter table countmein_private.wallet_links enable row level security;
alter table countmein_private.chain_receipts enable row level security;
alter table countmein_private.sync_cursors enable row level security;
alter table countmein_private.pending_transactions enable row level security;
create policy deny_direct_access on countmein_private.wallet_challenges as restrictive for all using(false) with check(false);
create policy deny_direct_access on countmein_private.wallet_links as restrictive for all using(false) with check(false);
create policy deny_direct_access on countmein_private.chain_receipts as restrictive for all using(false) with check(false);
create policy deny_direct_access on countmein_private.sync_cursors as restrictive for all using(false) with check(false);
create policy deny_direct_access on countmein_private.pending_transactions as restrictive for all using(false) with check(false);
revoke all on all tables in schema countmein_private from public, anon, authenticated;

create function countmein_private.freeze_terms() returns trigger language plpgsql set search_path='' as $$
begin
  if old.release_version=2 and (to_jsonb(new) - array['chain_plan_id','chain_create_tx','metadata_hash','chain_verified','business_state','chain_count','synced_block','synced_at'])
    is distinct from (to_jsonb(old) - array['chain_plan_id','chain_create_tx','metadata_hash','chain_verified','business_state','chain_count','synced_block','synced_at']) then
    raise exception 'Published terms and draft commitments are immutable.';
  end if;
  if old.metadata_hash is not null and new.metadata_hash is distinct from old.metadata_hash then raise exception 'Metadata commitment is immutable.'; end if;
  if old.release_version=2 and old.chain_plan_id is not null and (new.chain_plan_id is distinct from old.chain_plan_id or new.chain_create_tx is distinct from old.chain_create_tx) then
    raise exception 'Escrow reference is immutable.';
  end if;
  return new;
end;
$$;
create trigger freeze_terms before update on countmein_private.plans for each row execute function countmein_private.freeze_terms();

create function countmein_private.release_view(p countmein_private.plans, p_actor uuid) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('token',p.invitation_token,'title',p.title,'activity',p.activity,'location',p.location,
    'description',p.description,'deadline',p.deadline,'event_at',p.event_at,'target',p.target,
    'payment_mode',p.payment_mode,'chain_id',p.chain_id,'escrow_address',p.escrow_address,'organizer_wallet',p.organizer_wallet,
    'recipient_wallet',p.recipient_wallet,'contribution_wei',p.contribution_wei::text,'chain_plan_id',p.chain_plan_id::text,
    'chain_create_tx',p.chain_create_tx,'metadata_hash',p.metadata_hash,'chain_verified',p.chain_verified,
    'state',p.business_state,'count',case when p.chain_verified then p.chain_count else null end,
    'synced_at',p.synced_at,'is_owner',coalesce(p.owner_id=p_actor,false),
    'joined',exists(select 1 from countmein_private.chain_receipts r join countmein_private.wallet_links w on w.address=r.actor and w.chain_id=r.chain_id
      where r.plan_id=p.id and w.user_id=p_actor and r.kind='Joined' and r.status='confirmed' and r.canonical),
    'refunded',exists(select 1 from countmein_private.chain_receipts r join countmein_private.wallet_links w on w.address=r.actor and w.chain_id=r.chain_id
      where r.plan_id=p.id and w.user_id=p_actor and r.kind='Refunded' and r.status='confirmed' and r.canonical)
      and not exists(select 1 from countmein_private.chain_receipts r join countmein_private.wallet_links w on w.address=r.actor and w.chain_id=r.chain_id
        where r.plan_id=p.id and w.user_id=p_actor and r.kind='Joined' and r.status='confirmed' and r.canonical
          and not exists(select 1 from countmein_private.chain_receipts f where f.plan_id=r.plan_id and f.actor=r.actor
            and f.kind='Refunded' and f.status='confirmed' and f.canonical)));
$$;
create or replace function public.preview_plan(p_token uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select countmein_private.release_view(p,auth.uid()) from countmein_private.plans p
  where p.invitation_token=p_token and p.release_version=2 and (p.chain_verified or p.owner_id=auth.uid());
$$;
create or replace function public.my_plans() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Sign in.' using errcode='28000'; end if;
  return coalesce((select jsonb_agg(countmein_private.release_view(p,auth.uid()) order by p.created_at desc)
    from countmein_private.plans p where p.release_version=2 and (p.owner_id=auth.uid() or exists(
      select 1 from countmein_private.chain_receipts r join countmein_private.wallet_links w on w.address=r.actor and w.chain_id=r.chain_id
      where r.plan_id=p.id and w.user_id=auth.uid() and r.kind='Joined' and r.status='confirmed' and r.canonical))), '[]'::jsonb);
end;
$$;
create function public.my_wallets() returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('address',address,'chain_id',chain_id,'verified_at',verified_at)),'[]'::jsonb)
  from countmein_private.wallet_links where user_id=auth.uid();
$$;
create function public.my_receipts(p_token uuid default null) returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(item order by occurred_at desc),'[]'::jsonb) from (
    select r.occurred_at,jsonb_build_object('token',p.invitation_token,'title',p.title,'kind',r.kind,'amount_wei',r.amount_wei::text,
      'chain_id',r.chain_id,'contract_address',r.contract_address,'onchain_plan_id',r.onchain_plan_id::text,
      'tx_hash',r.tx_hash,'log_index',r.log_index,'wallet_address',r.actor,'status',case when r.canonical then r.status else 'invalidated' end,'occurred_at',r.occurred_at) item
    from countmein_private.chain_receipts r join countmein_private.plans p on p.id=r.plan_id
    where (p_token is null or p.invitation_token=p_token) and (exists(select 1 from countmein_private.wallet_links w where w.address=r.actor and w.chain_id=r.chain_id and w.user_id=auth.uid())
      or (p.owner_id=auth.uid() and r.kind in ('Created','Cancelled','Collected'))) order by r.occurred_at desc limit 200
  ) receipts;
$$;
revoke all on function public.my_wallets(),public.my_receipts(uuid) from public,anon,authenticated;
grant execute on function public.my_wallets(),public.my_receipts(uuid) to authenticated;

-- Only the trusted verifier can call this boundary. It never accepts a browser's payment status.
create function public.release_admin(p_action text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p countmein_private.plans; c countmein_private.wallet_challenges; e jsonb; cursor_row countmein_private.sync_cursors;
  actor uuid := (p_input->>'user_id')::uuid; addr text := lower(p_input->>'address'); token uuid; n integer;
begin
  if p_action='challenge' then
    insert into countmein_private.wallet_challenges(user_id,nonce,address,message,expires_at)
      values(actor,p_input->>'nonce',addr,p_input->>'message',clock_timestamp()+interval '5 minutes')
      on conflict(user_id) do update set nonce=excluded.nonce,address=excluded.address,message=excluded.message,
        expires_at=excluded.expires_at,created_at=clock_timestamp(),consumed_at=null
      where countmein_private.wallet_challenges.created_at < clock_timestamp()-interval '5 seconds';
    get diagnostics n=row_count;
    if n=0 then raise exception 'Wait before requesting another challenge.' using errcode='P0002'; end if;
    return jsonb_build_object('ok',true);
  elsif p_action='challenge_get' then
    select * into c from countmein_private.wallet_challenges where user_id=actor;
    return to_jsonb(c);
  elsif p_action='challenge_consume' then
    select * into c from countmein_private.wallet_challenges where user_id=actor for update;
    if not found or c.nonce is distinct from p_input->>'nonce' or c.address is distinct from addr or c.consumed_at is not null or c.expires_at<=clock_timestamp() then
      raise exception 'Invalid or consumed challenge.' using errcode='28000';
    end if;
    insert into countmein_private.wallet_links(chain_id,address,user_id) values(10143,addr,actor)
      on conflict(chain_id,address) do update set verified_at=clock_timestamp() where countmein_private.wallet_links.user_id=actor;
    get diagnostics n=row_count;
    if n=0 then raise exception 'Wallet already linked to another account.'; end if;
    update countmein_private.wallet_challenges set consumed_at=clock_timestamp() where user_id=actor;
    return jsonb_build_object('address',addr,'chain_id',10143);
  elsif p_action='linked' then
    return to_jsonb(exists(select 1 from countmein_private.wallet_links where chain_id=10143 and address=addr and user_id=actor));
  elsif p_action='draft' then
    if not exists(select 1 from countmein_private.wallet_links where chain_id=10143 and address=addr and user_id=actor) then raise exception 'Verify wallet ownership first.'; end if;
    if coalesce(p_input->>'contribution_wei','') !~ '^[0-9]+$' or coalesce(length(btrim(p_input->>'description')),0) not between 1 and 500 then raise exception 'Invalid plan.'; end if;
    if (p_input->>'deadline')::timestamptz <= clock_timestamp() then raise exception 'Choose a future deadline.'; end if;
    insert into countmein_private.plans(owner_id,title,activity,location,amount,target,deadline,event_at,payment_mode,contribution_wei,recipient_wallet,organizer_wallet,escrow_address,description,release_version)
      values(actor,btrim(p_input->>'title'),p_input->>'activity',btrim(p_input->>'location'),0,(p_input->>'target')::integer,
        (p_input->>'deadline')::timestamptz,(p_input->>'event_at')::timestamptz,'monad_testnet',(p_input->>'contribution_wei')::numeric,
        lower(p_input->>'recipient_wallet'),addr,lower(p_input->>'escrow_address'),btrim(p_input->>'description'),2)
      returning * into p;
    return countmein_private.release_view(p,actor);
  elsif p_action='plan' then
    select * into p from countmein_private.plans where release_version=2 and
      (invitation_token=(p_input->>'token')::uuid or metadata_hash=p_input->>'metadata_hash' or
        (chain_id=10143 and lower(escrow_address)=lower(p_input->>'escrow_address') and chain_plan_id=(p_input->>'chain_plan_id')::numeric));
    return countmein_private.release_view(p,actor);
  elsif p_action='commitment' then
    update countmein_private.plans set metadata_hash=p_input->>'metadata_hash' where invitation_token=(p_input->>'token')::uuid and owner_id=actor and release_version=2 returning * into p;
    return countmein_private.release_view(p,actor);
  elsif p_action='pending' then
    select * into p from countmein_private.plans where invitation_token=(p_input->>'token')::uuid and release_version=2;
    insert into countmein_private.pending_transactions(chain_id,contract_address,tx_hash,plan_id,actor,nonce,calldata,value_wei)
      values(10143,lower(p.escrow_address),lower(p_input->>'hash'),p.id,addr,(p_input->>'nonce')::bigint,p_input->>'data',(p_input->>'value')::numeric)
      on conflict do nothing;
    return jsonb_build_object('ok',true);
  elsif p_action='pending_get' then
    return (select jsonb_build_object('from',t.actor,'to',t.contract_address,'nonce',t.nonce,'data',t.calldata,'value',t.value_wei::text)
      from countmein_private.pending_transactions t join countmein_private.plans linked_plan on linked_plan.id=t.plan_id
      where linked_plan.invitation_token=(p_input->>'token')::uuid and t.tx_hash=lower(p_input->>'hash') and t.chain_id=10143);
  elsif p_action='record' then
    select * into p from countmein_private.plans where invitation_token=(p_input->>'token')::uuid and release_version=2 for update;
    if not found or lower(p.escrow_address) is distinct from lower(p_input->>'escrow_address') or (p_input->>'chain_id')::integer is distinct from 10143 then raise exception 'Wrong deployment.'; end if;
    for e in select value from jsonb_array_elements(p_input->'receipts') loop
      insert into countmein_private.chain_receipts(chain_id,contract_address,tx_hash,log_index,plan_id,onchain_plan_id,kind,actor,amount_wei,status,block_number,block_hash,occurred_at)
        values(10143,lower(p.escrow_address),lower(e->>'tx_hash'),(e->>'log_index')::integer,p.id,(p_input->>'chain_plan_id')::numeric,
          e->>'kind',lower(e->>'actor'),(e->>'amount_wei')::numeric,e->>'status',(e->>'block_number')::bigint,lower(e->>'block_hash'),(e->>'occurred_at')::timestamptz)
        on conflict(chain_id,contract_address,tx_hash,log_index) do update set canonical=true,
          block_number=excluded.block_number,block_hash=excluded.block_hash,occurred_at=excluded.occurred_at
          where countmein_private.chain_receipts.plan_id=excluded.plan_id
            and countmein_private.chain_receipts.kind=excluded.kind and countmein_private.chain_receipts.status=excluded.status
            and countmein_private.chain_receipts.actor=excluded.actor and countmein_private.chain_receipts.amount_wei=excluded.amount_wei;
    end loop;
    if p_input->>'chain_plan_id' is not null and (p_input->>'block_number')::bigint >= p.synced_block then
      update countmein_private.plans set chain_plan_id=(p_input->>'chain_plan_id')::numeric, chain_create_tx=lower(p_input->>'chain_create_tx'),
        chain_verified=true,business_state=p_input->>'state',chain_count=(p_input->>'count')::integer,
        synced_block=(p_input->>'block_number')::bigint,synced_at=clock_timestamp() where id=p.id;
    end if;
    return jsonb_build_object('ok',true);
  elsif p_action='cursor' then
    insert into countmein_private.sync_cursors(chain_id,contract_address,block_number) values(10143,lower(p_input->>'escrow_address'),(p_input->>'start_block')::bigint-1) on conflict do nothing;
    select * into cursor_row from countmein_private.sync_cursors where chain_id=10143 and contract_address=lower(p_input->>'escrow_address');
    return to_jsonb(cursor_row);
  elsif p_action='advance' then
    update countmein_private.sync_cursors set block_number=(p_input->>'block_number')::bigint,block_hash=p_input->>'block_hash',updated_at=clock_timestamp()
      where chain_id=10143 and contract_address=lower(p_input->>'escrow_address') and not halted and block_number=(p_input->>'expected_block')::bigint;
    return jsonb_build_object('ok',true);
  elsif p_action='halt' then
    update countmein_private.sync_cursors set halted=true where chain_id=10143 and contract_address=lower(p_input->>'escrow_address');
    update countmein_private.chain_receipts set canonical=false where chain_id=10143 and contract_address=lower(p_input->>'escrow_address');
    update countmein_private.plans set chain_verified=false where chain_id=10143 and lower(escrow_address)=lower(p_input->>'escrow_address') and release_version=2;
    return jsonb_build_object('halted',true);
  elsif p_action='rebuild_reviewed' then
    if coalesce(length(p_input->>'reason'),0) not between 20 and 500 then raise exception 'Record a chain consistency review first.'; end if;
    update countmein_private.sync_cursors set halted=false,block_number=(p_input->>'start_block')::bigint-1,
      block_hash=null,review_note=p_input->>'reason',updated_at=clock_timestamp()
      where chain_id=10143 and contract_address=lower(p_input->>'escrow_address') and halted;
    get diagnostics n=row_count;
    if n=0 then raise exception 'Only a halted deployment can be reviewed and rebuilt.'; end if;
    return jsonb_build_object('ok',true);
  else raise exception 'Unknown verifier operation.';
  end if;
end;
$$;
revoke all on function public.release_admin(text,jsonb) from public,anon,authenticated;
grant execute on function public.release_admin(text,jsonb) to service_role;
revoke all on all functions in schema countmein_private from public,anon,authenticated;
commit;

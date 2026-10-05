import { readFile,writeFile,mkdir } from 'node:fs/promises';

const directory=new URL('../supabase/repairs/',import.meta.url);
const read=name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const body=sql=>sql.replace(/^begin;\s*/,'').replace(/\s*commit;\s*$/,'');
const release=body(await read('202610050003_verified_release.sql'));
const limits=body(await read('202610050004_request_limits.sql'));
const sql=`-- Repair for the inspected Hackathon_pj schema: 001/002 installed, 003 absent.
-- Generated from the unchanged canonical migrations. No existing rows are removed.
begin;
select pg_advisory_xact_lock(10143,20261005);
do $repair$
begin
  if to_regprocedure('public.create_chain_plan(text,text,text,text,integer,timestamptz,timestamptz,text,text,text)') is null
    or to_regclass('countmein_private.chain_bookmarks') is null then
    raise exception 'Migration 002 is incomplete. Stop and inspect; do not replay 001 or 002.';
  end if;
  if exists(select 1 from (values
    ('payment_mode','text',true),('contribution_wei','numeric(29,0)',false),('recipient_wallet','text',false),
    ('organizer_wallet','text',false),('escrow_address','text',false),('chain_plan_id','numeric(78,0)',false),('chain_create_tx','text',false)
  ) expected(name,type,required) left join pg_attribute a on a.attrelid='countmein_private.plans'::regclass
    and a.attname=expected.name and not a.attisdropped
    where a.attname is null or format_type(a.atttypid,a.atttypmod)<>expected.type or a.attnotnull<>expected.required) then
    raise exception 'Existing funding column types differ. Stop; no data will be changed.';
  end if;
  if to_regprocedure('public.release_admin(text,jsonb)') is null then
    if exists(select 1 from pg_attribute where attrelid='countmein_private.plans'::regclass and attname='release_version' and not attisdropped)
      or to_regclass('countmein_private.wallet_links') is not null or to_regclass('countmein_private.chain_receipts') is not null then
      raise exception 'Partial migration 003 found. Stop and inspect before repairing.';
    end if;
    execute $release$
${release}
    $release$;
  end if;
  if to_regprocedure('public.release_request_limit(text,integer)') is null then
    if to_regclass('countmein_private.request_limits') is not null then raise exception 'Partial migration 004 found. Stop and inspect.'; end if;
    execute $limits$
${limits}
    $limits$;
  end if;
end;
$repair$;
notify pgrst, 'reload schema';
commit;
-- Read-only postflight: all fields should be true.
select to_regprocedure('public.release_admin(text,jsonb)') is not null as release_installed,
  to_regprocedure('public.my_wallets()') is not null as wallet_reads_installed,
  to_regprocedure('public.my_receipts(uuid)') is not null as receipts_installed,
  has_function_privilege('service_role','public.release_admin(text,jsonb)','execute') as verifier_allowed,
  not has_function_privilege('authenticated','public.release_admin(text,jsonb)','execute') as client_verifier_denied,
  not has_function_privilege('anon','public.my_wallets()','execute') as private_wallets_denied,
  not has_function_privilege('authenticated','public.create_chain_plan(text,text,text,text,integer,timestamptz,timestamptz,text,text,text)','execute') as legacy_writes_denied,
  has_function_privilege('service_role','public.release_request_limit(text,integer)','execute') as request_protection_installed;
`;
await mkdir(directory,{recursive:true});
await writeFile(new URL('20261005_verified_release.sql',directory),sql);
console.log('Prepared supabase/repairs/20261005_verified_release.sql from migrations 003 and 004.');

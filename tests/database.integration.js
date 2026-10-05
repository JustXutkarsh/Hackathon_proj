import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

let cluster, admin, directory, config;
const ids = ['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004'];
before(async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  directory = await mkdtemp(join(tmpdir(), 'countmein-pg-'));
  cluster = new EmbeddedPostgres({databaseDir:join(directory,'data'), user:'postgres', password:'local-test-only', port, persistent:false, onLog:() => {}, onError:() => {}});
  await cluster.initialise(); await cluster.start();
  config = {host:'127.0.0.1', port, user:'postgres', password:'local-test-only', database:'postgres'};
  admin = new pg.Client(config); await admin.connect();
  // Supabase supplies these roles, auth.users, and auth.uid(); emulate only that boundary.
  await admin.query(`create role anon nologin; create role authenticated nologin;
    create schema auth; create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as
    $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;`);
  for (const id of ids) await admin.query('insert into auth.users values($1,$2)',[id,id+'@private.example']);
  await admin.query(await readFile(new URL('../supabase/migrations/202610040001_shared_plans.sql',import.meta.url),'utf8'));
  await admin.query(await readFile(new URL('../supabase/migrations/202610040002_monad_testnet.sql',import.meta.url),'utf8'));
});
after(async () => { await admin?.end(); if (cluster) await cluster.stop(); if (directory) await rm(directory,{recursive:true,force:true}); });
async function session(id, fn) {
  const c = new pg.Client(config); await c.connect();
  try {
    await c.query(id ? 'set role authenticated' : 'set role anon');
    await c.query("select set_config('request.jwt.claim.sub', $1, false)",[id || '']);
    return await fn(c);
  } finally { await c.end(); }
}
const call = (id, sql, args=[]) => session(id, async c => (await c.query(sql,args)).rows[0]?.value);
const create = (id=ids[0]) => call(id, "select public.create_plan('Friday football','sport','Turf',50,2,clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours') as value");
const act = (id,token,action) => call(id,'select public.act_on_plan($1,$2) as value',[token,action]);
const preview = (id,token) => call(id,'select public.preview_plan($1) as value',[token]);

test('creation derives owner from auth and does not join; constraints are enforced', async () => {
  const token = await create(); const p = await preview(ids[0],token);
  assert.equal(p.count,0); assert.equal(p.joined,false); assert.equal(p.is_owner,true);
  assert.equal((await preview(ids[1],token)).is_owner,false);
  await assert.rejects(create(null),/permission denied/);
  await assert.rejects(call(ids[0],"select public.create_plan('x','sport','x',0,2,now()+interval '1 hour',now()+interval '2 hours')"),/check constraint/);
  await assert.rejects(call(ids[0],"select public.create_plan('x','sport','x',1,2,now()-interval '1 hour',now()+interval '2 hours')"),/future/);
  await assert.rejects(call(ids[0],"select public.create_plan('x','sport','x',1,2,'infinity','infinity')"),/check constraint/);
  await assert.rejects(call(ids[0],"select public.create_plan('x','sport','x',1,2,now()+interval '2 hours',now()+interval '1 hour')"),/check constraint/);
});
test('anonymous preview exposes no emails, user IDs, or directory; direct access and mutations fail', async () => {
  const token = await create(); await act(ids[1],token,'join');
  const p = await preview(null,token);
  assert.deepEqual(Object.keys(p).sort(),['token','title','activity','location','amount','target','deadline','event_at','state','count','is_owner','joined','refunded','payment_mode','contribution_wei','recipient_wallet','organizer_wallet','escrow_address','chain_plan_id','chain_create_tx'].sort());
  assert.equal(p.count,1); assert.equal(p.joined,false); assert.equal(p.is_owner,false);
  assert.equal(await preview(null,ids[3]),null);
  for (const id of [null,ids[3]]) {
    await assert.rejects(call(id,'select * from countmein_private.plans'),/permission denied/);
    await assert.rejects(call(id,'select * from countmein_private.participations'),/permission denied/);
    await assert.rejects(call(id,"update countmein_private.plans set target=50"),/permission denied/);
  }
  for (const action of ['join','cancel','refund']) await assert.rejects(act(null,token,action),/permission denied/);
  await assert.rejects(call(null,'select public.my_plans()'),/permission denied/);
  assert.deepEqual(await call(ids[3],'select public.my_plans() as value'),[]);
  const policies = await admin.query("select count(*)::int as n from pg_policies where schemaname='countmein_private' and permissive='RESTRICTIVE'");
  assert.equal(policies.rows[0].n,3);
  // Defense in depth: policies still block reads if schema/table grants drift.
  await admin.query('grant usage on schema countmein_private to authenticated; grant select on all tables in schema countmein_private to authenticated');
  try { await session(ids[1],async c => assert.equal((await c.query('select * from countmein_private.participations')).rowCount,0)); }
  finally { await admin.query('revoke usage on schema countmein_private from authenticated; revoke select on all tables in schema countmein_private from authenticated'); }
});
test('duplicate joins, unauthorized cancellation, early and repeat refunds fail', async () => {
  const token = await create(); await act(ids[1],token,'join');
  await assert.rejects(act(ids[1],token,'join'),/already joined/);
  await assert.rejects(act(ids[1],token,'refund'),/not open/);
  await assert.rejects(act(ids[1],token,'cancel'),/Only the organizer/);
  await act(ids[0],token,'cancel');
  await assert.rejects(act(ids[2],token,'refund'),/No simulated/);
  await assert.rejects(act(ids[2],token,'join'),/no longer/);
  const attempts = await Promise.allSettled([act(ids[1],token,'refund'),act(ids[1],token,'refund')]);
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(attempts.filter(x=>x.status==='rejected').length,1);
  assert.equal((await preview(ids[1],token)).refunded,true);
});
test('two live connections competing for the last spot serialize and cannot overfill', async () => {
  const token = await create(); await act(ids[1],token,'join');
  const blocker = new pg.Client(config); await blocker.connect();
  await blocker.query('begin');
  await blocker.query('select id from countmein_private.plans where invitation_token=$1 for update',[token]);
  const attempts = [act(ids[2],token,'join'),act(ids[3],token,'join')];
  const result = Promise.allSettled(attempts);
  try {
    let waiting = 0;
    for (let i=0;i<100 && waiting<2;i++) {
      const r = await admin.query("select count(*)::int as n from pg_stat_activity where wait_event_type='Lock' and query like 'select public.act_on_plan%'");
      waiting = r.rows[0].n;
      if (waiting<2) await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(waiting,2,'Both independent database sessions must be waiting on locks');
  } finally { await blocker.query('commit'); await blocker.end(); }
  const settled = await result;
  assert.equal(settled.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(settled.filter(x=>x.status==='rejected').length,1);
  const p = await preview(ids[0],token); assert.equal(p.count,2); assert.equal(p.state,'funded');
  await assert.rejects(act(ids[0],token,'cancel'),/Only an open/);
  await assert.rejects(act(ids[1],token,'refund'),/not open/);
  await admin.query("update countmein_private.plans set deadline=clock_timestamp()-interval '1 second' where invitation_token=$1",[token]);
  assert.equal((await preview(null,token)).state,'funded');
});
test('deadline failure permits only the participants own refund and blocks further joins', async () => {
  const token = await create(); await act(ids[1],token,'join');
  await admin.query("update countmein_private.plans set deadline=clock_timestamp()-interval '1 second' where invitation_token=$1",[token]);
  assert.equal((await preview(null,token)).state,'failed');
  await assert.rejects(act(ids[2],token,'join'),/no longer/);
  await assert.rejects(act(ids[0],token,'cancel'),/Only an open/);
  await assert.rejects(act(ids[0],token,'refund'),/No simulated/);
  await act(ids[1],token,'refund');
  await assert.rejects(act(ids[1],token,'refund'),/No simulated/);
  assert.equal((await preview(ids[1],token)).refunded,true);
});

test('a join waiting on a lock rechecks wall-clock time after the deadline', async () => {
  const token = await create();
  const blocker = new pg.Client(config); await blocker.connect();
  await blocker.query('begin');
  await blocker.query("update countmein_private.plans set deadline=clock_timestamp()+interval '300 milliseconds' where invitation_token=$1",[token]);
  const attempt = assert.rejects(act(ids[1],token,'join'),/no longer/);
  try { await admin.query('select pg_sleep(0.5)'); }
  finally { await blocker.query('commit'); await blocker.end(); }
  await attempt;
  assert.equal((await preview(null,token)).count,0);
});

test('an authenticated role without a user claim cannot create, list or mutate', async () => {
  const token = await create();
  await session(ids[0],async c => {
    await c.query("select set_config('request.jwt.claim.sub','',false)");
    await assert.rejects(c.query('select public.my_plans()'),/Sign in/);
    await assert.rejects(c.query('select public.act_on_plan($1,$2)',[token,'join']),/session expired/);
    await assert.rejects(c.query("select public.create_plan('x','sport','x',1,2,now()+interval '1 hour',now()+interval '2 hours')"),/Sign in/);
  });
});

const wallet = '0x1111111111111111111111111111111111111111';
const escrow = '0x2222222222222222222222222222222222222222';
const chainCreate = (id=ids[0], amount='10000000000000000', recipient=wallet) => call(id,
  "select public.create_chain_plan('Test football','sport','Turf',$1,2,date_trunc('second',now()+interval '1 hour'),date_trunc('second',now()+interval '2 hours'),$2,$3,$4) as value",
  [amount,recipient,wallet,escrow]);
const attach = (id,token,number='0',hash='0x'+'a'.repeat(64)) => call(id,'select public.attach_chain_plan($1,$2,$3) as value',[token,number,hash]);
test('testnet drafts enforce terms and ownership; references never count as deposits', async () => {
  await assert.rejects(chainCreate(null),/permission denied/);
  for (const amount of [null,'0','-1','1.5','79228162514264337593543950336']) await assert.rejects(chainCreate(ids[0],amount));
  for (const recipient of [null,'0x'+'0'.repeat(40),'not-a-wallet']) await assert.rejects(chainCreate(ids[0],'1',recipient));
  const token = await chainCreate(), draft = await preview(null,token);
  assert.equal(draft.state,'awaiting_contract'); assert.equal(draft.count,null); assert.equal(draft.joined,false);
  for (const action of ['join','cancel','refund']) await assert.rejects(act(ids[0],token,action),/Use the Monad escrow/);
  await assert.rejects(attach(null,token),/permission denied/);
  await assert.rejects(attach(ids[1],token),/Only the organizer/);
  for (const [id,hash] of [[null,'0x'+'a'.repeat(64)],['0',null],['-1','0x'+'a'.repeat(64)],[(2n**256n).toString(),'0x'+'a'.repeat(64)]]) await assert.rejects(attach(ids[0],token,id,hash));
  await attach(ids[0],token); await attach(ids[0],token);
  await assert.rejects(attach(ids[0],token,'1'),/cannot be attached/);
  await assert.rejects(attach(ids[0],await chainCreate()),/unique constraint/);
  await assert.rejects(call(null,'select public.remember_chain_plan($1)',[token]),/permission denied/);
  await call(ids[1],'select public.remember_chain_plan($1)',[token]);
  await call(ids[1],'select public.remember_chain_plan($1)',[token]);
  const bookmarked = (await call(ids[1],'select public.my_plans() as value')).find(p=>p.token===token);
  assert.equal(bookmarked.count,null); assert.equal(bookmarked.joined,false); assert.equal(bookmarked.refunded,false);
  assert.equal((await preview(null,token)).state,'chain');
  assert.equal((await call(ids[2],'select public.my_plans() as value')).some(p=>p.token===token),false);
  await assert.rejects(call(ids[1],'select * from countmein_private.chain_bookmarks'),/permission denied/);
});

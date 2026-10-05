import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, keccak256, Wallet } from 'ethers';
import { compileContract } from '../scripts/compile-contract.mjs';
import { ReleaseService } from '../server/release.mjs';
import { transactionFor } from '../dist/chain.js';

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
  await admin.query(`create role anon nologin; create role authenticated nologin; create role service_role nologin;
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

test('live-schema repair installs only missing release objects, preserves rows and is repeatable',async()=>{
  await admin.query('create database repair_check');const c=new pg.Client({...config,database:'repair_check'});await c.connect();
  try {
    await c.query(`create schema auth;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;insert into auth.users values('${ids[0]}','private@example.test');`);
    for(const name of ['202610040001_shared_plans.sql','202610040002_monad_testnet.sql'])await c.query(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
    await c.query("insert into countmein_private.plans(owner_id,title,activity,location,amount,target,deadline,event_at) values($1,'Existing plan','sport','Existing location',50,6,now()+interval '1 hour',now()+interval '2 hours')",[ids[0]]);
    const before=(await c.query('select to_jsonb(p) as value from countmein_private.plans p')).rows[0].value;
    const repair=await readFile(new URL('../supabase/repairs/20261005_verified_release.sql',import.meta.url),'utf8');
    await c.query(repair);await c.query(repair);
    const after=(await c.query('select to_jsonb(p) as value from countmein_private.plans p')).rows[0].value;
    for(const [key,value] of Object.entries(before))assert.deepEqual(after[key],value);
    assert.equal(after.release_version,1);assert.equal(after.chain_verified,false);
    const checks=(await c.query("select has_function_privilege('authenticated','public.release_admin(text,jsonb)','execute') as client,has_function_privilege('service_role','public.release_admin(text,jsonb)','execute') as server")).rows[0];assert.deepEqual(checks,{client:false,server:true});
    const count=(await c.query('select count(*)::int as n from countmein_private.plans')).rows[0].n;assert.equal(count,1);
  }finally{await c.end();await admin.query('drop database repair_check');}
});

test('durable request limits serialize concurrent callers and deny browser access',async()=>{
  await admin.query(await readFile(new URL('../supabase/migrations/202610050004_request_limits.sql',import.meta.url),'utf8'));
  for(const id of [null,ids[0]]) {
    await assert.rejects(call(id,"select public.release_request_limit('forged',120)"),/permission denied/);
    await assert.rejects(call(id,'select * from countmein_private.request_limits'),/permission denied/);
  }
  const clients=await Promise.all(Array.from({length:8},async()=>{const c=new pg.Client(config);await c.connect();return c;}));
  try{const results=await Promise.all(clients.map(c=>c.query("select public.release_request_limit('concurrent',3) as allowed")));assert.equal(results.filter(r=>r.rows[0].allowed).length,3);}finally{await Promise.all(clients.map(c=>c.end()));}
  await admin.query("update countmein_private.request_limits set started_at=clock_timestamp()-interval '61 seconds' where bucket='concurrent'");
  assert.equal((await admin.query("select public.release_request_limit('concurrent',3) as allowed")).rows[0].allowed,true);
});

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
  assert.equal(policies.rows[0].n,4);
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

test('release wallet proofs, immutable drafts, trusted receipt synchronization and backfills use real Postgres and EVM', async () => {
  await admin.query(await readFile(new URL('../supabase/migrations/202610050003_verified_release.sql',import.meta.url),'utf8'));
  const chain=ganache.provider({logging:{quiet:true},chain:{chainId:10143,hardfork:'shanghai'},wallet:{totalAccounts:5}});
  const provider=new BrowserProvider(chain,undefined,{cacheTimeout:-1}); provider.pollingInterval=10;
  try {
    const [organizer,friend,recipient]=await Promise.all([0,1,2].map(i=>provider.getSigner(i)));
    const artifact=compileContract(),contract=await new ContractFactory(artifact.abi,artifact.bytecode,organizer).deploy(); await contract.waitForDeployment();
    const config={chainId:10143,contractAddress:await contract.getAddress(),runtimeHash:keccak256(artifact.runtime),deploymentBlock:(await contract.deploymentTransaction().wait()).blockNumber};
    const trusted=async(action,input)=>(await admin.query('select public.release_admin($1,$2) as value',[action,input])).rows[0].value;
    const service=new ReleaseService({admin:trusted,provider,config,origin:'https://countmein.example'});
    for (const id of [null,ids[0]]) {
      await assert.rejects(call(id,"select public.release_admin('record','{}')"),/permission denied/);
      await assert.rejects(call(id,"select public.create_plan('x','sport','x',1,2,now()+interval '1 hour',now()+interval '2 hours')"),/permission denied/);
      for(const table of ['chain_receipts','wallet_links','wallet_challenges','pending_transactions','sync_cursors']){
        await assert.rejects(call(id,'select * from countmein_private.'+table),/permission denied/);
        await assert.rejects(call(id,'delete from countmein_private.'+table),/permission denied/);
      }
    }
    await assert.rejects(call(null,'select public.my_receipts()'),/permission denied/);
    const users=[{id:ids[0]},{id:ids[1]}],signers=[organizer,friend];
    for (let i=0;i<2;i++) {
      const address=await signers[i].getAddress();
      const challenge=await service.challenge(users[i],{address});
      const localWallet=signer=>new Wallet(chain.getInitialAccounts()[signer.address.toLowerCase()].secretKey);
      await assert.rejects(service.verifyWallet(users[i],{signature:await localWallet(recipient).signMessage(challenge.message)}),/signature/);
      const signature=await localWallet(signers[i]).signMessage(challenge.message);
      const results=await Promise.allSettled([service.verifyWallet(users[i],{signature}),service.verifyWallet(users[i],{signature})]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1,'Challenge consumption must be atomic');
      assert.equal((await call(users[i].id,'select public.my_wallets() as value')).length,1);
    }
    const now=(await provider.getBlock('latest')).timestamp;
    const body={address:await organizer.getAddress(),title:'Six-a-side',description:'Friends meeting at the local turf.',location:'Neighborhood turf',activity:'sport',
      contribution:'0.01',target:2,deadline:new Date((now+3600)*1000).toISOString(),event_at:new Date((now+7200)*1000).toISOString(),recipient_wallet:await recipient.getAddress(),user_id:ids[3]};
    await assert.rejects(service.draft({id:ids[3]},body),/ownership/);
    for(const change of [{target:51},{contribution:'1e3'},{recipient_wallet:'0x'+'0'.repeat(40)},{description:''},{event_at:body.deadline}]) await assert.rejects(service.draft(users[0],{...body,...change}));
    const p=await service.draft(users[0],body);
    assert.equal(p.is_owner,true); assert.equal(p.state,'draft'); assert.equal(p.count,null);
    assert.equal(await preview(null,p.token),null,'Drafts are not public funding invitations');
    await assert.rejects(admin.query('update countmein_private.plans set title=$1 where invitation_token=$2',['Different agreement',p.token]),/immutable/);
    const creation=await organizer.sendTransaction(transactionFor(p,'create',body.address)); await creation.wait();
    await assert.rejects(service.receipt(users[1],{token:p.token,hash:creation.hash}),/Creation terms|ownership/);
    // The owner may recover from chain success even when the initial database save was missed.
    assert.equal((await service.refresh(p.token,users[0])).status,'recovered');
    let published=await preview(null,p.token); assert.equal(published.chain_verified,true); assert.equal(published.state,'open');
    await assert.rejects(contract.createPlan(body.recipient_wallet,10000000000000000n,2,now+3600,now+7200,p.metadata_hash),/revert|missing revert/);
    const join=await friend.sendTransaction(transactionFor(published,'join',await friend.getAddress())); await join.wait();
    await assert.rejects(service.receipt(users[0],{token:p.token,hash:join.hash}),/ownership/);
    await service.receipt(users[1],{token:p.token,hash:join.hash}); await service.receipt(users[1],{token:p.token,hash:join.hash});
    assert.equal((await preview(null,p.token)).count,1);
    assert.equal((await call(ids[1],'select public.my_receipts() as value')).filter(r=>r.kind==='Joined').length,1);
    assert.equal((await call(ids[0],'select public.my_receipts() as value')).some(r=>r.kind==='Joined'),false,'Organizers cannot read another participant receipt from the account API');
    await admin.query('grant usage on schema countmein_private to anon,authenticated;grant select on countmein_private.chain_receipts,countmein_private.wallet_links to anon,authenticated');
    for(const id of [null,ids[0],ids[1]])for(const table of ['chain_receipts','wallet_links']){
      assert.equal(await call(id,'select count(*)::integer as value from countmein_private.'+table),0,'RLS remains restrictive even if table access is accidentally granted');
    }
    await admin.query('revoke select on countmein_private.chain_receipts,countmein_private.wallet_links from anon,authenticated;revoke usage on schema countmein_private from anon,authenticated');
    const cancel=await organizer.sendTransaction(transactionFor(published,'cancel',body.address)); await cancel.wait();
    const refund=await friend.sendTransaction(transactionFor(published,'refund',await friend.getAddress())); await refund.wait();
    await service.reconcile({pages:1}); await service.reconcile({pages:1});
    const receipts=await call(ids[1],'select public.my_receipts() as value');
    assert.equal(receipts.filter(r=>r.kind==='Refunded').length,1); assert.equal(receipts[0].status,'confirmed');
    assert.equal((await preview(null,p.token)).state,'cancelled');
    assert.equal((await call(ids[1],'select public.my_plans() as value')).find(r=>r.token===p.token).refunded,true);
    assert.equal(JSON.stringify(await preview(null,p.token)).includes('@private.example'),false);
    assert.equal((await service.receipt(users[0],{token:p.token,hash:'0x'+'a'.repeat(64)})).status,'submitted','A browser hash alone cannot confirm payment');
    const replacementPlan=await service.draft(users[0],{...body,title:'Replacement recovery'});
    const publication=await organizer.sendTransaction(transactionFor(replacementPlan,'create',body.address));await publication.wait();
    await service.receipt(users[0],{token:replacementPlan.token,hash:publication.hash});
    const publishedReplacement=await preview(null,replacementPlan.token);
    await chain.request({method:'miner_stop',params:[]});
    const pending=await friend.sendTransaction({...transactionFor(publishedReplacement,'join',friend.address),gasLimit:200000,gasPrice:2000000000n});
    assert.equal((await service.receipt(users[1],{token:replacementPlan.token,hash:pending.hash})).status,'submitted');
    await assert.rejects(call(ids[1],'select * from countmein_private.pending_transactions'),/permission denied/);
    const replacement=await friend.sendTransaction({to:friend.address,value:0n,nonce:pending.nonce,gasLimit:21000,gasPrice:4000000000n});
    await chain.request({method:'evm_mine',params:[]});await chain.request({method:'miner_start',params:[]});await replacement.wait();
    const realProvider=service.provider;
    // Some RPCs forget a replaced transaction; recovery must use the previously verified pending record.
    service.provider=new Proxy(realProvider,{get(target,key){if(key==='getTransaction')return hash=>hash===pending.hash?null:target.getTransaction(hash);const value=target[key];return typeof value==='function'?value.bind(target):value;}});
    const replaced=await service.replacement(users[1],{token:replacementPlan.token,hash:replacement.hash,original_hash:pending.hash});
    service.provider=realProvider;assert.equal(replaced.status,'replaced');assert.equal(await contract.hasJoined(publishedReplacement.chain_plan_id,friend.address),false);
    assert.ok((await call(ids[1],'select public.my_receipts() as value')).some(r=>r.tx_hash===replacement.hash&&r.status==='replaced'));
    await admin.query("update countmein_private.wallet_challenges set created_at=clock_timestamp()-interval '6 seconds' where user_id=$1",[ids[0]]);
    const recipientChallenge=await service.challenge(users[0],{address:recipient.address});
    await service.verifyWallet(users[0],{signature:await new Wallet(chain.getInitialAccounts()[recipient.address.toLowerCase()].secretKey).signMessage(recipientChallenge.message)});
    let multi=await service.draft(users[0],{...body,title:'Multiple linked wallets',target:3});
    const publishMulti=await organizer.sendTransaction(transactionFor(multi,'create',organizer.address));await publishMulti.wait();await service.receipt(users[0],{token:multi.token,hash:publishMulti.hash});multi=await preview(null,multi.token);
    for(const signer of [organizer,recipient]){const deposit=await signer.sendTransaction(transactionFor(multi,'join',signer.address));await deposit.wait();await service.receipt(users[0],{token:multi.token,hash:deposit.hash});}
    const cancelMulti=await organizer.sendTransaction(transactionFor(multi,'cancel',organizer.address));await cancelMulti.wait();await service.receipt(users[0],{token:multi.token,hash:cancelMulti.hash});
    for(const [i,signer] of [organizer,recipient].entries()){
      const claim=await signer.sendTransaction(transactionFor(multi,'refund',signer.address));await claim.wait();await service.receipt(users[0],{token:multi.token,hash:claim.hash});
      assert.equal((await preview(ids[0],multi.token)).refunded,i===1,'Refunding one linked wallet must not hide another wallet remaining claim');
    }
    const invalidCommitment=await service.draft(users[0],{...body,title:'Untrusted manual creation'});
    await(await contract.createPlan(body.recipient_wallet,1n,2,Date.parse(body.deadline)/1000,Date.parse(body.event_at)/1000,invalidCommitment.metadata_hash)).wait();
    await service.reconcile();assert.equal(await preview(null,invalidCommitment.token),null,'Mismatched financial terms must never publish or stall unrelated backfill');
    await admin.query("update countmein_private.sync_cursors set block_hash='0x'||repeat('f',64)");
    await assert.rejects(service.reconcile(),/checkpoint changed/);
    assert.equal(await preview(null,p.token),null,'Invalidated publication must fail closed');
    const invalidated=await call(ids[1],'select public.my_receipts() as value'); assert.ok(invalidated.every(r=>r.status==='invalidated'));
    await assert.rejects(service.admin('rebuild_reviewed',{escrow_address:await contract.getAddress(),start_block:1,reason:'unchecked'}),/review/);
    await service.admin('rebuild_reviewed',{escrow_address:await contract.getAddress(),start_block:1,reason:'Test injected checkpoint corrupt; canonical chain receipts independently checked.'});
    await service.reconcile();assert.equal((await preview(null,p.token)).state,'cancelled');
    assert.equal((await call(ids[1],'select public.my_receipts() as value')).filter(r=>r.kind==='Refunded'&&r.status==='confirmed').length,1);
  } finally { provider.destroy(); await chain.disconnect(); }
});

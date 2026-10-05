import { test,expect } from '@playwright/test';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { createServer } from 'node:net';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ganache from 'ganache';
import { BrowserProvider,ContractFactory,Wallet,keccak256,getBytes } from 'ethers';
import { compileContract } from '../scripts/compile-contract.mjs';
import { ReleaseService } from '../server/release.mjs';
import { transactionFor,formatMon } from '../dist/chain.js';

const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003'];
let database,db,dbConfig,directory,chain,provider,contract,service,accounts;
const state={failRecord:false};
function session(index){const exp=Math.floor(Date.now()/1000)+3600,user={id:ids[index],aud:'authenticated',role:'authenticated',email:`user${index}@example.test`,user_metadata:{display_name:['Organizer','Friend','Alex'][index]}};
  const token=[Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,exp,role:'authenticated'})).toString('base64url'),'test-signature'].join('.');
  return {access_token:token,refresh_token:'test-refresh',expires_at:exp,expires_in:3600,token_type:'bearer',user};}
test.beforeAll(async()=>{
  const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  directory=await mkdtemp(join(tmpdir(),'countmein-browser-'));
  database=new EmbeddedPostgres({databaseDir:join(directory,'data'),user:'postgres',password:'local-test-only',port,persistent:false,onLog:()=>{},onError:()=>{}});
  await database.initialise();await database.start();dbConfig={host:'127.0.0.1',port,user:'postgres',password:'local-test-only',database:'postgres'};db=new pg.Client(dbConfig);await db.connect();
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin;create schema auth;create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
  for(const id of ids)await db.query('insert into auth.users values($1,$2)',[id,'private@example.test']);
  for(const name of ['202610040001_shared_plans.sql','202610040002_monad_testnet.sql','202610050003_verified_release.sql'])await db.query(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  // Public fixture mnemonic. Never fund these wallets on a public network.
  chain=ganache.provider({logging:{quiet:true},chain:{chainId:10143,hardfork:'shanghai'},wallet:{mnemonic:'test test test test test test test test test test test junk'}});
  provider=new BrowserProvider(chain,undefined,{cacheTimeout:-1});provider.pollingInterval=10;accounts=await chain.request({method:'eth_accounts',params:[]});
  const artifact=compileContract();contract=await new ContractFactory(artifact.abi,artifact.bytecode,await provider.getSigner()).deploy();await contract.waitForDeployment();
  service=new ReleaseService({provider,origin:'http://127.0.0.1:4174',config:{chainId:10143,contractAddress:await contract.getAddress(),runtimeHash:keccak256(artifact.runtime),deploymentBlock:1},
    admin:async(action,input)=>{if(action==='record'&&state.failRecord)throw Error('Injected database outage');return (await db.query('select public.release_admin($1,$2) as value',[action,input])).rows[0].value;}});
  for(let i=0;i<2;i++){const c=await service.challenge(session(i).user,{address:accounts[i]});const signature=await new Wallet(chain.getInitialAccounts()[accounts[i]].secretKey).signMessage(c.message);await service.verifyWallet(session(i).user,{signature});}
});
test.afterAll(async()=>{provider?.destroy();await chain?.disconnect();await db?.end();await database?.stop();if(directory)await rm(directory,{recursive:true,force:true});});
async function rpc(actor,name,args){const c=new pg.Client(dbConfig);await c.connect();try{await c.query(actor?'set role authenticated':'set role anon');await c.query("select set_config('request.jwt.claim.sub',$1,false)",[actor||'']);
  const queries={preview_plan:['select public.preview_plan($1) as value',[args.p_token]],my_plans:['select public.my_plans() as value',[]],my_wallets:['select public.my_wallets() as value',[]],my_receipts:['select public.my_receipts($1) as value',[args.p_token||null]]};
  if(!queries[name])throw Error('Unexpected browser RPC '+name);return (await c.query(...queries[name])).rows[0].value;
}finally{await c.end();}}
async function setup(context,index=undefined,control={}){
  if(index!==undefined)await context.addInitScript(value=>localStorage.setItem('sb-test-auth-token',JSON.stringify(value)),session(index));
  const calls=[];
  await context.route('https://test.supabase.co/**',async route=>{
    const req=route.request(),url=new URL(req.url());let actor;try{actor=JSON.parse(Buffer.from(req.headers().authorization.split('.')[1],'base64url')).sub;}catch{}
    const body=req.postDataJSON()||{};calls.push({path:url.pathname,body,query:url.searchParams,actor});
    try{const name=url.pathname.split('/').pop();let data={};if(url.pathname.includes('/rpc/'))data=await rpc(actor,name,body);else if(name==='user'){data=session(Math.max(0,ids.indexOf(actor))).user;if(body.data)data.user_metadata={...data.user_metadata,...body.data};}
      await route.fulfill({json:data});}catch(error){await route.fulfill({status:403,json:{message:error.message,code:'42501'}});}
  });
  await context.route('**/api/release',async route=>{
    if(route.request().method()==='GET')return control.readinessError?route.fulfill({status:503,json:{error:control.readinessError}}):route.fulfill({json:{configured:true,chain_id:10143,contract_address:control.contractAddress || await contract.getAddress(),origin:control.origin || 'http://127.0.0.1:4174'}});
    const body=route.request().postDataJSON();let actor;try{actor=JSON.parse(Buffer.from(route.request().headers().authorization.split('.')[1],'base64url')).sub;}catch{}
    const user=actor?{id:actor}:null,methods={draft:'draft',challenge:'challenge',verify_wallet:'verifyWallet',receipt:'receipt',replacement:'replacement',refresh:'refresh'};
    try{if(!user&&body.action!=='refresh')throw Object.assign(Error('Your session expired.'),{status:401});const method=methods[body.action];const data=method==='refresh'?await service.refresh(body.token,user):await service[method](user,body);await route.fulfill({json:data});}
    catch(error){await route.fulfill({status:error.status||503,json:{error:error.status?error.message:'Database synchronization failed. Your transaction is recoverable.'}});}
  });
  await context.route('https://testnet-rpc.monad.xyz/**',async route=>{const r=route.request().postDataJSON();try{await route.fulfill({json:{jsonrpc:'2.0',id:r.id,result:await chain.request(r)}});}catch(e){await route.fulfill({json:{jsonrpc:'2.0',id:r.id,error:{code:e.code||-32000,message:e.message}}});}});
  if(index!==undefined){control.walletIndex??=index;control.sends??=0;
    await context.exposeBinding('testWalletRequest',async(_,request)=>{
      if(['eth_accounts','eth_requestAccounts'].includes(request.method))return [accounts[control.walletIndex]];
      if(request.method==='personal_sign'){if(control.rejectSignature)throw {code:4001,message:'Signature rejected'};return new Wallet(chain.getInitialAccounts()[request.params[1].toLowerCase()].secretKey).signMessage(getBytes(request.params[0]));}
      if(request.method==='eth_sendTransaction'){control.sends++;if(control.rejectTransaction)throw {code:4001,message:'Transaction rejected'};}
      return chain.request(request);
    });
    await context.addInitScript(()=>{const handlers={};window.ethereum={on:(event,fn)=>(handlers[event]??=[]).push(fn),request:r=>window.testWalletRequest(r),emit:event=>(handlers[event]||[]).forEach(fn=>fn([]))};});
  }
  return calls;
}
async function makePlan(title='Friday football'){
  const now=(await provider.getBlock('latest')).timestamp;
  const p=await service.draft(session(0).user,{address:accounts[0],title,description:'Friends at the neighborhood turf.',location:'Neighborhood turf',activity:'sport',contribution:'0.01',target:2,
    deadline:new Date((now+3600)*1000).toISOString(),event_at:new Date((now+7200)*1000).toISOString(),recipient_wallet:accounts[3]});
  const tx=await (await provider.getSigner(0)).sendTransaction(transactionFor(p,'create',accounts[0]));await tx.wait();await service.receipt(session(0).user,{token:p.token,hash:tx.hash});return service.plan(p.token,session(0).user);
}
async function reviewReady(page){await expect(page.getByRole('button',{name:'Approve in wallet'})).toBeEnabled();}
async function approve(page){await reviewReady(page);await page.getByLabel('I accept these rules and the immutable financial terms and recipient.').check();await page.getByRole('button',{name:'Approve in wallet'}).click();}

test('New Plan opens before wallet/config readiness, preserves unfinished details and retries corrected configuration',async({page,context})=>{
  const control={readinessError:'Shared database migration 002 or 003 is missing. Install the missing migrations in Hackathon_pj, then retry.'};
  await setup(context,0,control);await page.goto('/');await expect(page.locator('#shared-status')).toContainText('migration 002 or 003');
  await page.getByRole('button',{name:'New plan',exact:true}).click();await expect(page.getByRole('heading',{name:'Create a plan'})).toBeVisible();
  await page.setViewportSize({width:375,height:812});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/release-create-mobile.png',fullPage:true});
  await page.getByLabel('Plan title').fill('Unfinished football');await page.getByLabel('Location',{exact:true}).fill('Local turf');await page.getByLabel('Short description').fill('Meet for football.');
  await page.getByLabel('Participant slots').fill('2');await page.getByLabel('Recipient wallet').fill(accounts[3]);await page.getByRole('button',{name:'Save draft for review'}).click();
  await expect(page.locator('#form-error')).toContainText('migration 002 or 003');expect(control.sends).toBe(0);await page.reload();
  await page.getByRole('button',{name:'New plan',exact:true}).click();await expect(page.getByLabel('Plan title')).toHaveValue('Unfinished football');
  control.readinessError=null;await page.getByRole('button',{name:'Save draft for review'}).click();await expect(page).toHaveURL(/\/plan\//);expect(control.sends).toBe(0);
});
test('configuration retry detects origin and browser/server contract mismatches without enabling payments',async({page,context})=>{
  const control={origin:'https://another-origin.example'};await setup(context,0,control);await page.goto('/');await expect(page.locator('#shared-status')).toContainText('APP_ORIGIN');
  control.origin='http://127.0.0.1:4174';control.contractAddress=accounts[4];await page.locator('#shared-status').getByRole('button',{name:'Retry'}).click();
  await expect(page.locator('#shared-status')).toContainText('Browser and server escrow settings differ');expect(control.sends).toBe(0);
  control.contractAddress=await contract.getAddress();await page.locator('#shared-status').getByRole('button',{name:'Retry'}).click();await expect(page.locator('#shared-status')).toBeEmpty();
});

test('anonymous invitation restores through auth, direct reload works, and removed demo routes stay unavailable',async({page,context})=>{
  const p=await makePlan();const log=await setup(context);await page.goto(`/plan/${p.token}`);await page.reload();
  await expect(page.getByRole('heading',{name:p.title,exact:true})).toBeVisible();await expect(page.getByText('0 of 2 wallets',{exact:true})).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/demo credits|practice mode|fake friend/i);
  await page.getByRole('button',{name:'Sign in to participate'}).click();await page.getByLabel('Email',{exact:true}).fill('friend@example.test');await page.getByLabel('Display name').fill('Friend');await page.getByRole('button',{name:'Email sign-in link'}).click();
  await expect(page.getByRole('status').filter({hasText:'Check your email'})).toBeVisible();expect(log.find(x=>x.path.endsWith('/otp')).query.get('redirect_to')).toBe(`http://127.0.0.1:4174/plan/${p.token}`);
  expect((await page.request.get('/local')).status()).toBe(404);expect((await page.request.get('/app.js')).status()).toBe(404);
  await page.setViewportSize({width:375,height:812});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/release-invitation-mobile.png',fullPage:true});
});
test('two accounts publish, recover after database outage, deposit and collect with actual local EVM receipts',async({browser})=>{
  test.setTimeout(90000);const ca=await browser.newContext({permissions:['clipboard-read','clipboard-write']}),cb=await browser.newContext();
  try{await setup(ca,0);await setup(cb,1);const a=await ca.newPage(),b=await cb.newPage();await a.goto('/');await a.getByRole('button',{name:'New plan',exact:true}).click();
    await a.getByLabel('Plan title').fill('Saturday sports');await a.getByLabel('Location',{exact:true}).fill('Neighborhood turf');await a.getByLabel('Short description').fill('Six friends, one match.');await a.getByLabel('Participant slots').fill('2');await a.getByLabel('Recipient wallet').fill(accounts[3]);
    await expect(a.locator('#funding-total')).toHaveText('0.02 test MON');await a.getByRole('button',{name:'Save draft for review'}).click();await expect(a).toHaveURL(/\/plan\//);
    await expect(a.getByRole('button',{name:'Copy invitation link'})).toHaveCount(0);await a.getByRole('button',{name:'Connect wallet',exact:true}).click();await a.getByRole('button',{name:'Review and publish escrow'}).click();
    await reviewReady(a);const before=await contract.nextId();state.failRecord=true;await approve(a);await expect(a.getByRole('status').filter({hasText:'Submitted create.'})).toBeVisible();
    expect(await a.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem('countmein-pending-v2'))).length)).toBe(1);expect(await contract.nextId()).toBe(before+1n);
    await expect(a.getByRole('status').filter({hasText:'Database synchronization failed.'})).toBeVisible();
    state.failRecord=false;await a.reload();await expect(a.getByRole('button',{name:'Copy invitation link'})).toBeVisible();await a.getByRole('button',{name:'Check transaction'}).click();await a.getByRole('button',{name:'Verify receipt'}).click();
    expect(await contract.nextId()).toBe(before+1n);await a.getByRole('button',{name:'Copy invitation link'}).click();const link=await a.evaluate(()=>navigator.clipboard.readText());
    await a.getByRole('button',{name:'Connect wallet',exact:true}).click();await a.getByRole('button',{name:'Review contribution'}).click();await approve(a);await expect(a.getByText('1 of 2 wallets',{exact:true})).toBeVisible();
    await b.goto(link);await b.getByRole('button',{name:'Connect wallet',exact:true}).click();await b.getByRole('button',{name:'Review contribution'}).click();await approve(b);await expect(b.locator('#plan-grid').getByText('Funding confirmed',{exact:true})).toBeVisible();
    await a.getByRole('button',{name:'Refresh',exact:true}).click();await expect(a.getByText('2 of 2 wallets',{exact:true})).toBeVisible();await expect(a.getByText('Not verified',{exact:true})).toBeVisible();
    const balance=await provider.getBalance(accounts[3]);await a.getByRole('button',{name:'Collect funds',exact:true}).click();await approve(a);await expect(a.locator('#plan-grid').getByText('Funds collected',{exact:true})).toBeVisible();expect((await provider.getBalance(accounts[3]))-balance).toBe(20000000000000000n);
    await expect(a.locator('#receipt-list')).toContainText('Collected');await a.screenshot({path:'test-results/release-paid-desktop.png',fullPage:true});
    await expect(a.locator('.shared-detail')).toContainText(formatMon(await provider.getBalance(accounts[0]))+' test MON available');
  }finally{state.failRecord=false;await ca.close();await cb.close();}
});
test('cancellation enables one verified depositor refund and updates its receipt dashboard',async({browser})=>{
  const p=await makePlan('Cancelled outing'),ca=await browser.newContext(),cb=await browser.newContext();
  try{await setup(ca,0);await setup(cb,1);const a=await ca.newPage(),b=await cb.newPage();await b.goto(`/plan/${p.token}`);await b.getByRole('button',{name:'Connect wallet',exact:true}).click();await b.getByRole('button',{name:'Review contribution'}).click();await approve(b);await expect(b.getByText('1 of 2 wallets',{exact:true})).toBeVisible();
    await a.goto(`/plan/${p.token}`);await a.getByRole('button',{name:'Connect wallet',exact:true}).click();await a.getByRole('button',{name:'Cancel plan',exact:true}).click();await approve(a);await expect(a.getByText('Cancelled - refunds available',{exact:true})).toBeVisible();
    await b.getByRole('button',{name:'Refresh',exact:true}).click();await b.getByRole('button',{name:'Claim refund',exact:true}).click();await approve(b);await expect(b.getByText('Refund claimed and verified.',{exact:true}).first()).toBeVisible();await expect(b.getByRole('button',{name:'Claim refund',exact:true})).toHaveCount(0);await expect(b.locator('#receipt-list')).toContainText('Refunded');
    expect(await contract.deposits(p.chain_plan_id,accounts[1])).toBe(0n);
    await expect(b.locator('.shared-detail')).toContainText(formatMon(await provider.getBalance(accounts[1]))+' test MON available');
  }finally{await ca.close();await cb.close();}
});
test('wallet and network changes invalidate a prepared payment before broadcast',async({page,context})=>{
  const p=await makePlan('Wallet change'),control={};await setup(context,1,control);await page.goto(`/plan/${p.token}`);await page.getByRole('button',{name:'Connect wallet',exact:true}).click();await page.getByRole('button',{name:'Review contribution'}).click();
  await reviewReady(page);await page.evaluate(()=>window.ethereum.emit('accountsChanged'));await approve(page);await expect(page.locator('#form-error')).toContainText('Wallet or account changed');expect(control.sends).toBe(0);
  await page.getByRole('button',{name:'Close dialog'}).click();await page.getByRole('button',{name:'Connect wallet',exact:true}).click();await page.getByRole('button',{name:'Review contribution'}).click();await reviewReady(page);await page.evaluate(()=>window.ethereum.emit('chainChanged'));await approve(page);expect(control.sends).toBe(0);
});
test('rejected approval and a last-spot revert never become successful deposits',async({page,context})=>{
  const p=await makePlan('Last spot'),control={rejectTransaction:true};await setup(context,1,control);await page.goto(`/plan/${p.token}`);await page.getByRole('button',{name:'Connect wallet',exact:true}).click();await page.getByRole('button',{name:'Review contribution'}).click();await approve(page);
  await expect(page.locator('#form-error')).toContainText('Wallet request rejected');expect(await contract.hasJoined(p.chain_plan_id,accounts[1])).toBe(false);
  control.rejectTransaction=false;await page.getByRole('button',{name:'Close dialog'}).click();await page.getByRole('button',{name:'Review contribution'}).click();
  await reviewReady(page);
  for(const i of [0,2])await(await contract.connect(await provider.getSigner(i)).join(p.chain_plan_id,{value:10000000000000000n})).wait();
  await approve(page);await expect(page.getByRole('status').filter({hasText:'Transaction reverted'})).toBeVisible();expect(await contract.hasJoined(p.chain_plan_id,accounts[1])).toBe(false);await expect(page.locator('#receipt-list')).toContainText('failed');
});
test('pending transaction survives refresh and is recovered from its mined receipt',async({page,context})=>{
  const p=await makePlan('Pending transaction');await setup(context,1);await page.goto(`/plan/${p.token}`);await page.getByRole('button',{name:'Connect wallet',exact:true}).click();await page.getByRole('button',{name:'Review contribution'}).click();await chain.request({method:'miner_stop',params:[]});
  try{await approve(page);await expect(page.getByRole('button',{name:'Check transaction'})).toBeVisible();await page.reload();await expect(page.getByRole('button',{name:'Check transaction'})).toBeVisible();await chain.request({method:'evm_mine',params:[]});await chain.request({method:'miner_start',params:[]});await page.getByRole('button',{name:'Check transaction'}).click();await page.getByRole('button',{name:'Verify receipt'}).click();await expect(page.getByText('1 of 2 wallets',{exact:true})).toBeVisible();await expect(page.locator('#receipt-list')).toContainText('confirmed');}
  finally{await chain.request({method:'miner_start',params:[]});}
});
test('wallet signature rejection creates no account link; expired email recovery preserves invitation',async({page,context})=>{
  const p=await makePlan('Signature rejection');await setup(context,2,{rejectSignature:true});await page.goto(`/plan/${p.token}`);await page.getByRole('button',{name:'Connect wallet',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Wallet request rejected'})).toBeVisible();expect(await rpc(ids[2],'my_wallets',{})).toEqual([]);
  await page.goto(`/plan/${p.token}#error=access_denied&error_description=Email+link+expired`);await page.reload();await expect(page.getByRole('status').filter({hasText:'Sign-in link expired'})).toBeVisible();await expect(page).toHaveURL(new RegExp(`/plan/${p.token}$`));
});

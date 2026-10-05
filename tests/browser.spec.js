import { test, expect } from '@playwright/test';
import { compileContract } from '../scripts/compile-contract.mjs';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory } from 'ethers';
const token = '11111111-1111-4111-8111-111111111111';
const owner = '00000000-0000-4000-8000-000000000001';
const friend = '00000000-0000-4000-8000-000000000002';
const seed = () => ({token, title:'Friday night football', activity:'sport', location:'Neighborhood turf', amount:50, target:2,
  deadline:new Date(Date.now()+864e5).toISOString(), event_at:new Date(Date.now()+2*864e5).toISOString(), state:'open', count:0, is_owner:false, joined:false, refunded:false});
function session(id) {
  const user = {id,aud:'authenticated',role:'authenticated',email:`${id}@example.test`,user_metadata:{display_name:id === owner ? 'Organizer' : 'Friend'}};
  const exp = Math.floor(Date.now()/1000)+3600;
  const jwt = [Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({sub:id,role:'authenticated',exp})).toString('base64url'),'test-signature'].join('.');
  return {access_token:jwt,refresh_token:'test-refresh',expires_at:exp,expires_in:3600,token_type:'bearer',user};
}
async function signIn(context,id) {
  await context.addInitScript(value => localStorage.setItem('sb-test-auth-token',JSON.stringify(value)),session(id));
}
async function mock(context, getPlan, log = []) {
  await context.route('https://test.supabase.co/**',async route => {
    const request = route.request(); const url = new URL(request.url());
    let actor;
    try { actor = JSON.parse(Buffer.from(request.headers().authorization.split('.')[1],'base64url')).sub; } catch {}
    const body = request.postDataJSON(); log.push({path:url.pathname,query:url.searchParams,body,actor});
    const p = getPlan();
    const view = () => ({...p,is_owner:actor === owner,joined:p.members?.includes(actor) || false,refunded:false,members:undefined});
    let data = {};
    if (url.pathname.endsWith('/preview_plan')) data = view();
    else if (url.pathname.endsWith('/my_plans')) data = actor === owner || p.members?.includes(actor) ? [view()] : [];
    else if (url.pathname.endsWith('/create_plan')) { Object.assign(p,{title:body.p_title,location:body.p_location}); data = token; }
    else if (url.pathname.endsWith('/act_on_plan')) {
      if (!actor) return route.fulfill({status:401,json:{code:'28000',message:'Session expired'}});
      if (body.p_action === 'join') { p.members ||= []; p.members.push(actor); p.count++; }
      data = null;
    } else if (url.pathname.endsWith('/user')) {
      data = session(actor || friend).user;
      if (body?.data) data.user_metadata = {...data.user_metadata,...body.data};
    }
    await route.fulfill({json:data});
  });
}

test('anonymous deep-link preview survives reload; magic link keeps the invitation destination', async ({page,context}) => {
  const log = []; await mock(context,seed,log);
  await page.goto(`/plan/${token}`); await expect(page.getByRole('heading',{name:'Friday night football'})).toBeVisible();
  await page.reload(); await expect(page.getByText('0 of 2 people',{exact:true})).toBeVisible();
  await expect(page.getByText('Practice controls',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Sign in to participate'}).click();
  await page.getByLabel('Email',{exact:true}).fill('friend@example.test'); await page.getByLabel('Display name').fill('Friend');
  await page.getByRole('button',{name:'Email me a sign-in link'}).click();
  await expect(page.getByRole('status').filter({hasText:'Check your email'})).toBeVisible();
  const otp = log.find(x=>x.path.endsWith('/otp'));
  expect(otp.query.get('redirect_to')).toBe(`http://127.0.0.1:4174/plan/${token}`);
  expect(log.some(x=>x.path.endsWith('/act_on_plan'))).toBe(false);
});

test('two isolated browsers create, copy, join once and refresh shared state', async ({browser}) => {
  const a = await browser.newContext({permissions:['clipboard-read','clipboard-write']});
  const b = await browser.newContext(); const plan = seed(); const log = [];
  try {
    await signIn(a,owner); await signIn(b,friend); await mock(a,()=>plan,log); await mock(b,()=>plan,log);
    const pa = await a.newPage(), pb = await b.newPage();
    await pa.goto('/'); await pa.getByRole('button',{name:'New plan'}).click();
    await pa.getByLabel('Plan name').fill('Friday night football'); await pa.getByLabel('Location',{exact:true}).fill('Neighborhood turf');
    await pa.getByRole('button',{name:'Create shared plan'}).click(); await expect(pa).toHaveURL(new RegExp(`/plan/${token}`));
    await expect(pa.getByText('0 of 2 people',{exact:true})).toBeVisible();
    expect(log.find(x=>x.path.endsWith('/create_plan')).body).not.toHaveProperty('owner_id');
    await pa.getByRole('button',{name:'Copy invitation link'}).click();
    expect(await pa.evaluate(()=>navigator.clipboard.readText())).toBe(`http://127.0.0.1:4174/plan/${token}`);
    await pb.goto(`/plan/${token}`);
    await pb.getByRole('button',{name:'Join with 50 simulated demo credits'}).click();
    await expect(pb.getByText('1 of 2 people',{exact:true})).toBeVisible();
    await expect(pb.getByRole('button',{name:'Join with 50 simulated demo credits'})).toHaveCount(0);
    await expect(pb.getByRole('button',{name:'Cancel plan',exact:true})).toHaveCount(0);
    await pa.getByRole('button',{name:'Refresh',exact:true}).click();
    await expect(pa.getByText('1 of 2 people',{exact:true})).toBeVisible();
    await pb.reload(); await expect(pb.getByText('1 of 2 people',{exact:true})).toBeVisible();
    await pa.screenshot({path:'test-results/shared-desktop.png',fullPage:true});
    await pb.setViewportSize({width:375,height:812});
    await expect(pb.getByRole('heading',{name:'Friday night football'})).toBeVisible();
    expect(await pb.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await pb.screenshot({path:'test-results/shared-mobile.png',fullPage:true});
  } finally { await a.close(); await b.close(); }
});

test('network failure gives retry; local demo stays isolated', async ({page,context}) => {
  let failing = true; const log = [];
  await mock(context,seed,log);
  await context.route('**/rest/v1/rpc/preview_plan',async route => failing ? route.abort('failed') : route.fulfill({json:seed()}));
  await page.goto(`/plan/${token}`); await expect(page.getByRole('button',{name:'Retry',exact:true})).toBeVisible();
  failing = false; await page.getByRole('button',{name:'Retry',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Friday night football'})).toBeVisible();
  const before = log.length;
  await page.getByRole('link',{name:'Local demo',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Friday night football'})).toBeVisible();
  await page.getByRole('button',{name:'Count me in'}).first().click();
  await expect(page.getByRole('button',{name:'Practice controls'})).toBeVisible();
  expect(log.length).toBe(before);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('countmein-practice-v1')).plans.length)).toBe(3);
});

test('expired email link is recoverable without losing destination', async ({page,context}) => {
  await mock(context,seed);
  await page.goto(`/plan/${token}#error=access_denied&error_description=Email+link+expired`);
  await expect(page.getByRole('status').filter({hasText:'Request a new sign-in link'})).toBeVisible();
  await expect(page).toHaveURL(`http://127.0.0.1:4174/plan/${token}`);
  await page.getByRole('button',{name:'Sign in to participate'}).click();
  await expect(page.getByLabel('Email',{exact:true})).toBeVisible();
});

test('magic-link callback restores session, edits display name and signs out', async ({page,context}) => {
  await mock(context,seed);
  const s = session(friend);
  await page.goto(`/plan/${token}#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_in=3600&token_type=bearer&type=magiclink`);
  await expect(page.getByRole('button',{name:'Join with 50 simulated demo credits'})).toBeVisible();
  await expect(page).toHaveURL(`http://127.0.0.1:4174/plan/${token}`);
  await page.reload(); await expect(page.locator('#profile')).toHaveText('Friend');
  await page.locator('#profile').click(); await page.getByLabel('Display name').fill('Alex');
  await page.getByRole('button',{name:'Save name'}).click(); await expect(page.locator('#profile')).toHaveText('Alex');
  await page.locator('#profile').click(); await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await expect(page.getByRole('button',{name:'Sign in to participate'})).toBeVisible();
  await page.reload(); await expect(page.locator('#profile')).toHaveText('Sign in');
});

test('pending join disables repeated submissions and refreshes on focus', async ({page,context}) => {
  await signIn(context,friend); const p = seed(); await mock(context,()=>p);
  let finish, calls = 0;
  await context.route('**/rest/v1/rpc/act_on_plan',async route => {
    calls++; await new Promise(resolve => { finish = resolve; });
    p.members = [friend]; p.count = 1; await route.fulfill({json:null});
  });
  await page.goto(`/plan/${token}`);
  const join = page.getByRole('button',{name:'Join with 50 simulated demo credits'});
  await join.click(); await expect(join).toBeDisabled();
  await expect.poll(()=>calls).toBe(1); finish();
  await expect(page.getByText('1 of 2 people',{exact:true})).toBeVisible();
  p.count = 2; p.state = 'funded'; await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Funding confirmed',{exact:true})).toBeVisible();
  expect(calls).toBe(1);
});

const chainSeed = () => ({...seed(),payment_mode:'monad_testnet',state:'awaiting_contract',amount:0,count:null,
  contribution_wei:'10000000000000000',recipient_wallet:'0x3333333333333333333333333333333333333333',
  organizer_wallet:'0x1111111111111111111111111111111111111111',escrow_address:'0x5FbDB2315678afecb367f032d93F642f64180aa3',
  deadline:new Date(Math.floor((Date.now()+864e5)/1000)*1000).toISOString(),event_at:new Date(Math.floor((Date.now()+2*864e5)/1000)*1000).toISOString(),
  chain_plan_id:null,chain_create_tx:null});
test('testnet preview stays separate from demo; responsive recipient and unverified booking', async ({page,context}) => {
  await mock(context,chainSeed);
  await page.goto(`/plan/${token}`);
  await expect(page.getByText('0.01 test MON',{exact:true})).toBeVisible();
  await expect(page.getByText('Recipient:',{exact:false})).toBeVisible();
  await expect(page.getByText('Venue booking:',{exact:false})).toBeVisible();
  await expect(page.getByRole('button',{name:'Deposit',exact:false})).toHaveCount(0);
  await page.screenshot({path:'test-results/testnet-desktop.png',fullPage:true});
  await page.setViewportSize({width:375,height:812});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/testnet-mobile.png',fullPage:true});
  await page.reload(); await expect(page.getByText('0.01 test MON',{exact:true})).toBeVisible();
});
test('rejected wallet approval never attaches an escrow or records a deposit', async ({page,context}) => {
  const p = chainSeed(), log = []; await signIn(context,owner); await mock(context,()=>p,log);
  await context.addInitScript(({runtime,address}) => {
    window.ethereum = {on:()=>{},request:async ({method}) => {
      if (method === 'eth_chainId') return '0x279f';
      if (method === 'eth_getCode') return runtime;
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
      if (method === 'eth_blockNumber') return '0x1';
      if (method === 'eth_estimateGas') return '0x40000';
      if (method === 'eth_sendTransaction') throw {code:4001,message:'Rejected by user'};
      throw Error('Unexpected wallet method '+method);
    }};
  },{runtime:compileContract().runtime,address:p.organizer_wallet});
  await page.goto(`/plan/${token}`);
  await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
  await page.getByRole('button',{name:'Activate testnet escrow'}).click();
  await expect(page.getByRole('status').filter({hasText:'Wallet approval rejected'})).toBeVisible();
  expect(log.some(x=>/attach_chain_plan|act_on_plan|remember_chain_plan/.test(x.path))).toBe(false);
  expect(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('countmein-testnet-tx:')).map(k=>JSON.parse(localStorage.getItem(k))))).toEqual([null]);
  await expect(page.getByText('Awaiting escrow activation',{exact:false})).toBeVisible();
});
test('testnet creation exposes immutable recipient and hides demo contribution', async ({page,context}) => {
  await signIn(context,owner); await mock(context,chainSeed);
  await page.goto('/'); await page.getByRole('button',{name:'New plan'}).click();
  await page.getByLabel('Contribution type').selectOption('monad_testnet');
  await expect(page.getByLabel('Recipient wallet (fixed before deposits)')).toBeVisible();
  await expect(page.getByLabel('Simulated demo credits per person')).toBeHidden();
  await page.setViewportSize({width:375,height:812});
  await page.screenshot({path:'test-results/testnet-create-mobile.png',fullPage:true});
  await page.getByLabel('Contribution type').selectOption('demo');
  await expect(page.getByLabel('Simulated demo credits per person')).toBeVisible();
});

test('two wallet browsers activate, deposit, collect, cancel and refund against a real local EVM', async ({browser}) => {
  test.setTimeout(90000);
  // Public test fixture mnemonic only. Never fund these addresses on a public chain.
  const chain = ganache.provider({logging:{quiet:true},chain:{chainId:10143,hardfork:'shanghai'},wallet:{mnemonic:'test test test test test test test test test test test junk'}});
  const provider = new BrowserProvider(chain,undefined,{cacheTimeout:-1}); provider.pollingInterval = 10;
  const contexts = [];
  try {
    const signer = await provider.getSigner(), accounts = await chain.request({method:'eth_accounts',params:[]});
    const artifact = compileContract(), contract = await new ContractFactory(artifact.abi,artifact.bytecode,signer).deploy();
    await contract.waitForDeployment();
    const p = {...chainSeed(),organizer_wallet:accounts[0],recipient_wallet:accounts[3]};
    expect((await contract.getAddress()).toLowerCase()).toBe(p.escrow_address.toLowerCase());
    let rejectAttach = true;
    for (const [index,id] of [owner,friend].entries()) {
      const context = await browser.newContext(); contexts.push(context);
      await signIn(context,id); await mock(context,()=>p);
      await context.route('**/rest/v1/rpc/attach_chain_plan',async route => {
        if (rejectAttach) return route.fulfill({status:503,json:{message:'Temporary network failure'}});
        const data = route.request().postDataJSON(); p.chain_plan_id = data.p_chain_plan_id; p.chain_create_tx = data.p_create_tx; p.state = 'chain';
        await route.fulfill({json:null});
      });
      await context.route('https://testnet-rpc.monad.xyz/**',async route => {
        const request = route.request().postDataJSON();
        try { await route.fulfill({json:{jsonrpc:'2.0',id:request.id,result:await chain.request({method:request.method,params:request.params})}}); }
        catch (error) { await route.fulfill({json:{jsonrpc:'2.0',id:request.id,error:{code:error.code || -32000,message:error.message}}}); }
      });
      await context.exposeBinding('testWalletRequest',async (_,request) => {
        if (['eth_accounts','eth_requestAccounts'].includes(request.method)) return [accounts[index]];
        if (request.method === 'eth_sendTransaction') expect(request.params[0].from.toLowerCase()).toBe(accounts[index]);
        return chain.request(request);
      });
      await context.addInitScript(()=>{ window.ethereum = {on:()=>{},request:request=>window.testWalletRequest(request)}; });
    }
    const a = await contexts[0].newPage(), b = await contexts[1].newPage();
    await a.goto(`/plan/${token}`); await a.getByRole('button',{name:'Connect wallet',exact:true}).click();
    await a.getByRole('button',{name:'Activate testnet escrow'}).click();
    await expect(a.getByRole('button',{name:'Check submitted transaction'})).toBeEnabled();
    await expect(a.getByRole('status').filter({hasText:'Connection interrupted'})).toBeVisible();
    await a.reload(); await expect(a.getByRole('button',{name:'Check submitted transaction'})).toBeVisible();
    await expect(a.getByRole('button',{name:'Activate testnet escrow'})).toHaveCount(0);
    rejectAttach = false;
    await a.getByRole('button',{name:'Check submitted transaction'}).click();
    await a.getByRole('button',{name:'Check finalized receipt'}).click();
    await expect(a.getByText('0 of 2 wallets',{exact:true})).toBeVisible();
    expect(await contract.nextId()).toBe(1n);
    await a.getByRole('button',{name:'Connect wallet',exact:true}).click();
    await a.getByRole('button',{name:'Deposit 0.01 test MON',exact:true}).click();
    await expect(a.getByText('1 of 2 wallets',{exact:true})).toBeVisible();
    await b.goto(`/plan/${token}`); await b.getByRole('button',{name:'Connect wallet',exact:true}).click();
    await b.getByRole('button',{name:'Deposit 0.01 test MON',exact:true}).click();
    await expect(b.getByRole('button',{name:'Release test MON to recipient'})).toBeVisible();
    await a.getByRole('button',{name:'Refresh',exact:true}).click();
    await expect(a.getByText('2 of 2 wallets',{exact:true})).toBeVisible();
    const before = await provider.getBalance(accounts[3]);
    await b.getByRole('button',{name:'Release test MON to recipient'}).click();
    await expect(b.getByText('Monad Testnet · Recipient paid',{exact:true})).toBeVisible();
    expect((await provider.getBalance(accounts[3]))-before).toBe(20000000000000000n);
    Object.assign(p,{token:'22222222-2222-4222-8222-222222222222',chain_plan_id:null,chain_create_tx:null,state:'awaiting_contract'});
    await a.goto(`/plan/${p.token}`); await a.getByRole('button',{name:'Connect wallet',exact:true}).click();
    await a.getByRole('button',{name:'Activate testnet escrow'}).click();
    await expect(a.getByText('0 of 2 wallets',{exact:true})).toBeVisible();
    await b.goto(`/plan/${p.token}`); await b.getByRole('button',{name:'Connect wallet',exact:true}).click();
    await b.getByRole('button',{name:'Deposit 0.01 test MON',exact:true}).click();
    await expect(b.getByText('1 of 2 wallets',{exact:true})).toBeVisible();
    await a.getByRole('button',{name:'Cancel and open refunds',exact:true}).click();
    await a.getByRole('button',{name:'Approve cancellation in wallet'}).click();
    await expect(a.getByText('Monad Testnet · Refunds open',{exact:true})).toBeVisible();
    await b.getByRole('button',{name:'Refresh',exact:true}).click();
    await b.getByRole('button',{name:'Claim test MON refund'}).click();
    await expect(b.getByText('Refunded: your test MON refund is finalized.',{exact:true})).toBeVisible();
    await expect(b.getByRole('button',{name:'Claim test MON refund'})).toHaveCount(0);
    expect(await contract.deposits(p.chain_plan_id,accounts[1])).toBe(0n);
    await b.screenshot({path:'test-results/testnet-refunded-desktop.png',fullPage:true});
  } finally {
    for (const context of contexts) await context.close();
    provider.destroy(); await chain.disconnect();
  }
});

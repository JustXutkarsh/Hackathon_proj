import { test, expect } from '@playwright/test';
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

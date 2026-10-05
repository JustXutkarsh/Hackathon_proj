import { createClient } from '@supabase/supabase-js';
import { MONAD_TESTNET, walletEscrow, readEscrow, readProvider, verifyProvider, transactionFor, quoteTransaction, parseMon, formatMon, validWallet, checksum, explorerTx, detailsHash } from './chain.js';

const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=v=>new Intl.DateTimeFormat('en-IN',{dateStyle:'medium',timeStyle:'short'}).format(new Date(v));
const inputDate=v=>new Date(v-new Date(v).getTimezoneOffset()*60000).toISOString().slice(0,16);
const token=location.pathname.match(/^\/plan\/([0-9a-f-]{36})\/?$/i)?.[1];
const validPath=location.pathname==='/' || Boolean(token),callback=new URLSearchParams(location.hash.slice(1));
const labels={draft:'Draft',open:'Open for funding',funded:'Funding confirmed',paid:'Funds collected',cancelled:'Cancelled - refunds available',failed:'Deadline missed - refunds available'};
const storageKey='countmein-pending-v2';
let client,user=null,plans=[],receipts=[],wallet=null,filter='all',busy=false,epoch=0,revision=0,ready=false,transactions={},readinessError='Checking testnet service configuration...';
try { transactions=JSON.parse(localStorage.getItem(storageKey)) || {}; } catch {}
const rules='<p>Each wallet can commit one contribution. Contributions stay in escrow while open. Full funding before the deadline lets the fixed recipient collect. Cancellation or a missed target lets each depositor claim a refund.</p><p>Funding does not guarantee attendance, a venue booking, or service delivery. After full funding the organizer cannot cancel or open refunds. After collection the contract cannot recover funds from the recipient. Venue disputes and voluntary repayments are outside these rules.</p><p>Network fees are separate and are not refunded. No platform fees or yield. Wallet addresses do not prove unique people. Keep access to your wallet to claim your onchain rights.</p>';
document.body.classList.add('shared','release');
$('.practice').textContent='Monad testnet — test tokens have no monetary value.';
$('#profile').setAttribute('aria-label','Your account');
$('.section-heading h2').textContent=token?'Your invitation':'Your plans';
$('.section-heading .eyebrow').textContent='COUNTMEIN';
$('#plans').insertAdjacentHTML('afterbegin','<div id="shared-status" class="shared-status" role="status" aria-live="polite"></div>');
$('#stat-plans').previousElementSibling.textContent='OPEN PLANS';
$('#stat-deposits').previousElementSibling.textContent='RECENT CONTRIBUTIONS';
$('#stat-refunds').previousElementSibling.textContent='REFUNDS AVAILABLE';
$('.stats-note p').innerHTML='Funding confirmed?<br><b>Venue booking is separate.</b>';
$('.filters').innerHTML=Object.entries({all:'All',organizing:'I organize',joined:'I joined',open:'Open',funded:'Funding confirmed',paid:'Funds collected',refundable:'Refunds available',refunded:'Refunds claimed'}).map(([value,label])=>`<button data-filter="${value}" class="${value==='all'?'active':''}">${label}</button>`).join('');
$('.filters').hidden=Boolean(token);
$('#plans').insertAdjacentHTML('afterend','<section id="receipt-history"><h2>Your receipts</h2><div id="receipt-list"></div></section>');
if (token) $('#plans').insertAdjacentHTML('afterbegin','<a class="shared-back" href="/">Your plans</a>');
else $('#plans').insertAdjacentHTML('afterbegin','<div id="intro"><h1>CountMeIn</h1><p>Commit together for sports and outings. Fill the group to fund the plan, or claim your contribution back when the target is missed.</p></div>');
$('#close-modal').onclick=()=>{if(!busy)$('#modal').close();};
$('#modal').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
$('#how').onclick=()=>modal('<h2>The funding rules</h2>'+rules);
$('#profile').onclick=()=>account();
$('#new-plan').onclick=()=>create();
$('.filters').onclick=e=>{if(!e.target.dataset.filter)return;filter=e.target.dataset.filter;render();};
function modal(html) {
  $('#modal-content').innerHTML=html+'<p id="form-error" class="error" role="alert"></p>';
  disablePending($('#modal-content'));
  if(!$('#modal').open)$('#modal').showModal();
}
function disablePending(root=document){if(busy)root.querySelectorAll('button,fieldset').forEach(el=>{if(!el.disabled){el.disabled=true;el.dataset.busy='true';}});}
function status(text,retry=false) { $('#shared-status').textContent=text; if(retry){const b=document.createElement('button');b.className='outline';b.textContent='Retry';b.onclick=()=>run(async()=>{await checkReadiness();await refresh();});$('#shared-status').append(b);} }
async function checkReadiness() {
  ready=false;
  try {
    const r=await fetch('/api/release',{signal:AbortSignal.timeout(15000),cache:'no-store'}),result=await r.json();
    if(!r.ok)throw Object.assign(Error(result.error || 'Testnet service is unavailable. Retry or contact the organizer.'),{safe:true});
    if(!MONAD_TESTNET.contractAddress)fail('The browser build is missing MONAD_TESTNET_ESCROW_ADDRESS. Set it for this deployment environment and redeploy.');
    if(result.contract_address && checksum(result.contract_address)!==checksum(MONAD_TESTNET.contractAddress))fail('Browser and server escrow settings differ. Redeploy with matching contract configuration.');
    if(result.origin && result.origin!==location.origin)fail('APP_ORIGIN does not match this website. Configure the exact deployment origin and its Supabase authentication redirects.');
    if(!result.configured || result.chain_id!==10143)fail('The service has not verified Monad testnet configuration. Transactions remain disabled.');
    ready=true;readinessError='';
  }catch(e){readinessError=readable(e);}
  return ready;
}
function readable(e) {
  if(e?.code==='ACTION_REJECTED'||e?.code===4001)return 'Wallet request rejected. No payment was confirmed.';
  if(e?.code==='INSUFFICIENT_FUNDS')return 'Not enough test MON for the contribution and network fee.';
  if(e?.code===4200||e?.code===-32601)return 'This wallet does not support the required request. Use a compatible Monad wallet.';
  if(e?.code==='CALL_EXCEPTION')return 'The contract rejected this action. Refresh its state. A mined reverted transaction may still spend a network fee.';
  if(e?.status===401||e?.code==='28000'||/jwt|session|refresh.token/i.test(e?.message||''))return 'Your session expired. Sign in again.';
  if(e?.safe)return e.message;
  if(/fetch|network|timeout|abort/i.test(e?.message||''))return 'Connection interrupted. A submitted transaction may still succeed. Check its receipt before retrying.';
  return 'This action could not be verified. Refresh and check the receipt before retrying.';
}
function fail(message) { throw Object.assign(Error(message),{safe:true}); }
async function rpc(name,args) {const {data,error}=await client.rpc(name,args);if(error)throw error;return data;}
async function api(action,body={}) {
  const {data}=await client.auth.getSession();
  const r=await fetch('/api/release',{method:'POST',headers:{'Content-Type':'application/json',...(data.session?{Authorization:`Bearer ${data.session.access_token}`}:{})},body:JSON.stringify({action,...body}),signal:AbortSignal.timeout(45000)});
  const result=await r.json(); if(!r.ok)throw Object.assign(Error(result.error),{safe:true,status:r.status}); return result;
}
async function run(fn) {
  if(busy)return;busy=true;
  disablePending();
  if($('#form-error'))$('#form-error').textContent='';
  try{await fn();}catch(e){const text=readable(e);if($('#modal').open)$('#form-error').textContent=text;else status(text,true);
    if(e?.status===401){user=null;wallet=null;epoch++;render();const button=document.createElement('button');button.className='outline';button.textContent='Sign in again';button.onclick=account;($('#modal').open?$('#form-error'):$('#shared-status')).append(button);}
  }
  finally{busy=false;document.querySelectorAll('[data-busy]').forEach(el=>{el.disabled=false;delete el.dataset.busy;});}
}
function savePending(value) {if(value)transactions[token]=value;else delete transactions[token];localStorage.setItem(storageKey,JSON.stringify(transactions));}
function eligibleTotal() {
  return receipts.filter(r=>r.kind==='Joined'&&r.status==='confirmed'&&plans.some(p=>p.token===r.token&&['cancelled','failed'].includes(p.state))&&!receipts.some(ref=>ref.token===r.token&&ref.wallet_address===r.wallet_address&&ref.kind==='Refunded'&&ref.status==='confirmed')).reduce((sum,r)=>sum+BigInt(r.amount_wei),0n);
}
function render() {
  $('#profile').textContent=user?.user_metadata?.display_name || (user?'Account':'Sign in');
  if($('#intro'))$('#intro').hidden=Boolean(user);
  $('#stat-plans').textContent=plans.filter(p=>p.state==='open'&&p.chain_verified).length;
  $('#stat-deposits').innerHTML=esc(formatMon(receipts.filter(r=>r.kind==='Joined'&&r.status==='confirmed').reduce((sum,r)=>sum+BigInt(r.amount_wei),0n)))+' <small>test MON</small>';
  $('#stat-refunds').innerHTML=esc(formatMon(eligibleTotal()))+' <small>test MON</small>';
  document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b.dataset.filter===filter));
  $('#plan-grid').innerHTML=token?(plans[0]?detail(plans[0]):transactions[token]&&user?`<div class="empty"><p>Submitted ${esc(transactions[token].action)}. Its receipt is still pending verification.</p><a href="${esc(explorerTx(transactions[token].hash))}" target="_blank" rel="noopener noreferrer">View transaction</a><button class="outline" data-action="recover">Check transaction</button></div>`:'<div class="empty">Invitation unavailable. The organizer must publish its escrow first.</div>'):
    plans.filter(p=>filter==='all'||filter==='organizing'&&p.is_owner||filter==='joined'&&p.joined||filter==='refunded'&&p.refunded||filter==='refundable'&&p.joined&&!p.refunded&&['cancelled','failed'].includes(p.state)||p.state===filter).map(p=>`<article class="card shared-card"><div class="card-art ${esc(p.activity)}"><span class="big-symbol" aria-hidden="true">${p.activity==='sport'?'&#9678;':'&#9651;'}</span><span class="badge">${esc(labels[p.state])}</span></div><div class="card-body"><h3>${esc(p.title)}</h3><p class="meta">${esc(p.location)}<br>${esc(date(p.event_at))}</p><p>${p.chain_verified?`${p.count} of ${p.target} wallets committed`:'Escrow publication pending'}</p><div class="card-bottom"><div class="price">${esc(formatMon(p.contribution_wei))}<small>test MON per wallet</small></div><a href="/plan/${p.token}">View plan &rarr;</a></div></div></article>`).join('') || '<div class="empty">'+(user?'No plans here yet. Create a plan or open an invitation.':'Sign in to organize a plan, or open an invitation from a friend.')+'</div>';
  $('#receipt-history').hidden=!user;
  $('#receipt-list').innerHTML=receipts.length?receipts.map(r=>`<article class="receipt"><div><strong>${esc(r.title)}</strong><p>${esc(r.kind)} &middot; ${esc(formatMon(r.amount_wei))} test MON &middot; ${esc(r.status)}</p><small>Monad testnet &middot; ${esc(date(r.occurred_at))}</small></div><a class="receipt-hash" href="${esc(explorerTx(r.tx_hash))}" target="_blank" rel="noopener noreferrer">${esc(r.tx_hash)}</a></article>`).join(''):'<p class="meta">No verified transactions yet.</p>';
  disablePending();
}
function detail(p) {
  const c=p.chain,active=wallet?.verified,pending=transactions[token],same=a=>active&&checksum(a)===wallet.address;
  const button=(action,label)=>`<button class="primary" data-action="${action}">${label}</button>`;
  let actions=!user?button('signin','Sign in to participate'):button('connect',wallet?'Reconnect wallet':'Connect wallet');
  if(user&&active&&!pending){
    if(!p.chain_plan_id&&p.is_owner&&same(p.organizer_wallet))actions+=button('create','Review and publish escrow');
    if(p.chain_verified&&c?.state===0&&!c.joined)actions+=button('join','Review contribution');
    if(c?.state===0&&same(p.organizer_wallet))actions+=button('cancel','Cancel plan');
    if(c?.state===1&&(same(p.organizer_wallet)||same(p.recipient_wallet)))actions+=button('collect','Collect funds');
    if(c?.state===2&&c.deposit>0n)actions+=button('refund','Claim refund');
  }
  const share=p.chain_verified?'<button class="outline" data-action="copy">Copy invitation link</button>'+(navigator.share?'<button class="outline" data-action="share">Share invitation</button>':''):'';
  const balance=wallet?.balance==null?'Balance unavailable':`${esc(formatMon(wallet.balance))} test MON available`;
  return `<article class="shared-detail"><span class="badge">${esc(labels[p.state])}</span><h2>${esc(p.title)}</h2><p class="meta">${esc(p.activity)} &middot; ${esc(p.location)}</p><p>${esc(p.description)}</p><div class="detail-grid"><div><small>Funding progress</small><strong>${c?c.count:p.chain_verified?p.count:'—'} of ${p.target} wallets</strong></div><div><small>Your contribution</small><strong>${esc(formatMon(p.contribution_wei))} test MON</strong></div><div><small>Total required funding</small><strong>${esc(formatMon(BigInt(p.contribution_wei)*BigInt(p.target)))} test MON</strong></div><div><small>Funding deadline</small><strong>${esc(date(p.deadline))}</strong></div><div><small>Event time</small><strong>${esc(date(p.event_at))}</strong></div><div><small>Venue booking</small><strong>Not verified</strong></div></div><p>Recipient: <code class="wallet-address">${esc(p.recipient_wallet)}</code></p><p>Wallet: <code class="wallet-address">${esc(wallet?.address || 'Not connected')}</code>${wallet?`<br><small>Monad testnet &middot; ${balance}</small>`:''}</p>${p.chainError?`<p class="error" role="alert">${esc(p.chainError)}</p>`:''}${c?.joined?`<p>${c.state===2&&c.deposit===0n?'Refund claimed and verified.':'Your wallet has a confirmed contribution.'}</p>`:''}${pending?`<p role="status">Submitted ${esc(pending.action)}. Confirmation pending. <a href="${esc(explorerTx(pending.hash))}" target="_blank" rel="noopener noreferrer">View transaction</a></p>`:''}<div class="actions">${actions}${share}<button class="outline" data-action="refresh">Refresh</button>${user&&(pending||p.is_owner&&!p.chain_plan_id)?button('recover','Check transaction'):''}</div><div class="notice">${rules}<p>Transactions, wallets, and funding terms are public onchain. The unlisted invitation does not make blockchain activity private. The description is stored offchain; avoid sensitive personal information.</p></div></article>`;
}
async function refresh(success='') {
  if(!client||!validPath)return;
  const request=++revision;$('#plan-grid').setAttribute('aria-busy','true');status('Loading plans and verified receipts...');
  try{
    if(token&&ready)await api('refresh',{token});
    const next=token?await rpc('preview_plan',{p_token:token}):user?await rpc('my_plans'):[];
    const loaded=token?(next?[next]:[]):next;
    const history=user?await rpc('my_receipts',{p_token:token||null}):[];
    const connected=wallet;
    if(connected){try{const balance=await connected.provider.getBalance(connected.address);if(wallet===connected)connected.balance=balance;}catch{if(wallet===connected)connected.balance=null;}}
    for(const p of loaded)if(p.chain_verified&&p.chain_plan_id&&ready){try{p.chain=await readEscrow(p,wallet?.address);p.state=p.chain.state===2?(p.chain.cancelled?'cancelled':'failed'):['open','funded','','paid'][p.chain.state];p.count=p.chain.count;}catch(e){p.chainError=readable(e);}}
    if(request!==revision)return;
    plans=loaded.filter(p=>p.payment_mode==='monad_testnet'&&p.chain_id===10143);receipts=history;render();status(success || readinessError,!ready);
  }catch(e){if(request===revision)status(readinessError || readable(e),true);}finally{if(request===revision)$('#plan-grid').removeAttribute('aria-busy');}
}
async function connect() {
  if(!user)return account();
  if(!ready && !await checkReadiness())fail(readinessError);
  const identity=user.id,w=await walletEscrow(),generation=epoch;
  if(user?.id!==identity)fail('Account changed. Connect again.');
  const linked=await rpc('my_wallets');
  if(!linked.some(item=>checksum(item.address)===w.address)){
    status('Approve the wallet ownership signature. This does not send tokens.');
    const challenge=await api('challenge',{address:w.address});
    const signature=await w.signer.signMessage(challenge.message);
    if(generation!==epoch||user?.id!==identity)fail('Wallet or account changed. Connect again.');
    await api('verify_wallet',{signature});
  }
  if(generation!==epoch||user?.id!==identity)fail('Wallet or account changed. Connect again.');
  const balance=await w.provider.getBalance(w.address);
  if(generation!==epoch||user?.id!==identity)fail('Wallet or account changed. Connect again.');
  wallet={...w,verified:true,balance};
  await refresh('Wallet ownership verified. Monad testnet connected.');
}
async function prepare(p,action) {
  if(!await checkReadiness())fail(readinessError);
  if(!wallet?.verified)fail('Connect and verify your wallet first.');
  const generation=epoch,identity=user.id,w=await walletEscrow();
  if(w.address!==wallet.address)fail('Wallet changed. Reconnect and verify it.');
  await api('refresh',{token:p.token});
  p=await rpc('preview_plan',{p_token:p.token});
  if(!p)fail('Plan is unavailable.');
  if(p.metadata_hash!==detailsHash(p))fail('Plan commitment does not match the invitation.');
  if(action==='create'){
    if(p.chain_plan_id) {await refresh('Existing escrow recovered.');return;}
    if(!p.is_owner||checksum(p.organizer_wallet)!==w.address)fail('Use the organizer wallet for publication.');
  }else{
    if(!p.chain_verified)fail('Escrow has not been verified.');
    await readEscrow(p,w.address);
  }
  const quote=await quoteTransaction(w.provider,transactionFor(p,action,w.address),w.address),request=quote.request;
  const cost=quote.cost,balance=await w.provider.getBalance(w.address);
  if(balance<cost+request.value)fail('Not enough test MON for this contribution and its network fee.');
  if(generation!==epoch||identity!==user?.id)fail('Wallet or account changed. Prepare the transaction again.');
  const names={create:'Publish escrow',join:'Commit contribution',cancel:'Cancel and open refunds',collect:'Collect funds',refund:'Claim refund'};
  modal(`<h2>${esc(names[action])}</h2><p>${esc(p.title)}</p><p>Monad testnet &middot; ${p.target} funded wallet slots<br>Your contribution: <strong>${esc(formatMon(p.contribution_wei))} test MON</strong><br>Total required: <strong>${esc(formatMon(BigInt(p.contribution_wei)*BigInt(p.target)))} test MON</strong><br>Funding deadline: ${esc(date(p.deadline))} (${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)})</p><p>Recipient: <code class="wallet-address">${esc(p.recipient_wallet)}</code></p><p>Estimated network fee at current RPC price: <strong>${esc(formatMon(cost))} test MON</strong>. This is not a fee cap. Your wallet sets the final fee; review it before signing. Monad charges for the full gas limit.</p><details><summary>Transaction details</summary><p>Chain ID: 10143<br>Transaction value: ${esc(formatMon(request.value))} test MON<br>Estimated gas: ${quote.estimatedGas}<br>Gas limit (7.5% margin): ${request.gasLimit}<br>RPC gas price: ${esc(formatMon(quote.gasPrice*1000000000n))} gwei</p><p>Escrow destination: <code class="wallet-address">${esc(request.to)}</code></p><p>Metadata commitment: <code class="wallet-address">${esc(p.metadata_hash)}</code></p><p>Calldata: <code class="wallet-address">${esc(request.data)}</code></p></details><p>This submits an onchain transaction. Publication permanently fixes the recipient and financial terms. It does not deposit the organizer's contribution.</p>${rules}<label class="check-label"><input type="checkbox" id="acknowledge"> I accept these rules and the immutable financial terms and recipient.</label><button class="primary full" id="approve-transaction">Approve in wallet</button>`);
  $('#approve-transaction').onclick=()=>run(async()=>{
    if(!$('#acknowledge').checked)fail('Acknowledge the funding rules before continuing.');
    if(generation!==epoch||identity!==user?.id)fail('Wallet or account changed. Prepare the transaction again.');
    if(transactions[token])fail('Check the submitted transaction before sending again.');
    await verifyProvider(w.provider);
    const current=await w.provider.send('eth_accounts',[]);
    if(!current[0]||checksum(current[0])!==w.address)fail('Connected wallet changed. Reconnect.');
    if(generation!==epoch||identity!==user?.id)fail('Wallet or account changed. Prepare the transaction again.');
    localStorage.setItem(storageKey,JSON.stringify(transactions));
    status('Awaiting wallet approval.');
    const hash=await w.signer.sendUncheckedTransaction(request);
    savePending({hash,address:w.address,action,submitted_at:new Date().toISOString()});
    $('#modal').close();render();status('Submitted. Waiting for a verified receipt.');
    for(let i=0;i<10;i++){const result=await api('receipt',{token,hash});if(result.status!=='submitted'){savePending(null);await refresh(result.status==='failed'?'Transaction reverted. Your network fee may have been spent; check the receipt.':action==='refund'?'Refund claimed and verified.':'Transaction confirmed and verified.');return;}await new Promise(resolve=>setTimeout(resolve,1500));}
    status('Submitted. Check transaction to recover its receipt.');
  });
}
$('#plan-grid').onclick=e=>{
  const action=e.target.closest('[data-action]')?.dataset.action;if(!action||busy)return;
  if(action==='signin')return account();if(action==='refresh')return refresh();
  if(action==='copy'||action==='share')return run(async()=>{const url=`${location.origin}/plan/${token}`;if(action==='share')await navigator.share({title:plans[0].title,url});else{await navigator.clipboard.writeText(url);status('Invitation link copied.');}});
  if(action==='connect')return run(connect);
  if(action==='recover'){
    modal(`<h2>Check transaction</h2><form id="recover-form"><fieldset><label for="transaction-hash">Submitted or replacement transaction hash</label><input id="transaction-hash" value="${esc(transactions[token]?.hash || '')}" pattern="0x[0-9a-fA-F]{64}" required><button class="primary full">Verify receipt</button></fieldset></form>`);
    $('#recover-form').onsubmit=e=>{e.preventDefault();const hash=$('#transaction-hash').value.trim();run(async()=>{const pending=transactions[token],result=await api(pending&&hash!==pending.hash?'replacement':'receipt',{token,hash,original_hash:pending?.hash});if(result.status==='submitted'){status('Not finalized yet. Keep this transaction tracked.');return;}savePending(null);$('#modal').close();await refresh(result.status==='confirmed'?'Receipt verified.':result.status==='failed'?'Transaction reverted. Retry only if the contract still permits it.':'Original transaction replaced or cancelled.');});};return;
  }
  return run(()=>prepare(plans[0],action));
};
function create() {
  if(!user)return account();
  modal(`<h2>Create a plan</h2><form id="create-form"><fieldset><label for="title">Plan title</label><input id="title" name="title" maxlength="70" required><div class="row"><div><label for="activity">Activity</label><select id="activity" name="activity"><option value="sport">Sports</option><option value="outing">Outing</option><option value="social">Get-together</option></select></div><div><label for="location">Location</label><input id="location" name="location" maxlength="90" required></div></div><label for="description">Short description</label><textarea id="description" name="description" maxlength="500" rows="3" required></textarea><div class="row"><div><label for="contribution">Contribution in test MON</label><input id="contribution" name="contribution" inputmode="decimal" value="0.01" required></div><div><label for="target">Participant slots</label><input id="target" name="target" type="number" min="2" max="50" step="1" value="6" required></div></div><p>Total required funding: <strong id="funding-total">0.06 test MON</strong></p><label for="deadline">Funding deadline</label><input id="deadline" name="deadline" type="datetime-local" value="${inputDate(Date.now()+86400000)}" required><label for="event_at">Event time</label><input id="event_at" name="event_at" type="datetime-local" value="${inputDate(Date.now()+172800000)}" required><label for="recipient_wallet">Recipient wallet</label><input id="recipient_wallet" name="recipient_wallet" placeholder="0x..." spellcheck="false" required><p>Financial terms and recipient cannot change after publication. Creating a plan does not deposit your contribution.</p><button class="primary full">Save draft for review</button></fieldset></form>`);
  const draftKey=`countmein-unfinished-v2:${user.id}`;
  try{const saved=JSON.parse(sessionStorage.getItem(draftKey));if(saved)for(const [name,value] of Object.entries(saved)){const field=$('#create-form').elements.namedItem(name);if(field)field.value=value;}}catch{}
  $('#create-form').insertAdjacentHTML('afterbegin',`<p>Times use ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}. Saving to the shared database requires wallet ownership verification (a signature, not a payment). Saved drafts are fixed for review; create another draft to change terms. Publication makes them immutable onchain.</p><p id="creation-readiness" class="error" role="status">${esc(readinessError)}</p>`);
  $('#create-form').insertAdjacentHTML('beforeend','<button type="button" class="outline full" id="save-unfinished">Keep unfinished details on this device</button><p id="unfinished-status" role="status"></p>');
  const saveUnfinished=()=>sessionStorage.setItem(draftKey,JSON.stringify(Object.fromEntries(new FormData($('#create-form')))));
  $('#create-form').oninput=saveUnfinished;
  $('#save-unfinished').onclick=()=>{saveUnfinished();$('#unfinished-status').textContent='Unfinished details kept for this account in this browser tab. Not shared or published onchain.';};
  const total=()=>{try{const n=Number($('#target').value);$('#funding-total').textContent=Number.isInteger(n)&&n>=2&&n<=50?formatMon(parseMon($('#contribution').value)*BigInt(n))+' test MON':'—';}catch{$('#funding-total').textContent='Enter a valid contribution';}};
  total();
  $('#target').oninput=$('#contribution').oninput=total;
  $('#create-form').onsubmit=e=>{e.preventDefault();saveUnfinished();const f=Object.fromEntries(new FormData(e.target)),identity=user.id;run(async()=>{
    f.target=Number(f.target);f.deadline=new Date(f.deadline).toISOString();f.event_at=new Date(f.event_at).toISOString();parseMon(f.contribution);
    if(!validWallet(f.recipient_wallet))fail('Enter a valid nonzero recipient wallet.');
    if(!Number.isInteger(f.target)||f.target<2||f.target>50)fail('Choose 2 to 50 participant slots.');
    if(Date.parse(f.deadline)<=Date.now()||Date.parse(f.event_at)<=Date.parse(f.deadline))fail('Choose a future funding deadline and a later event time.');
    if(!await checkReadiness())fail(readinessError);
    if(!wallet?.verified)await connect();
    if(user?.id!==identity||!wallet?.verified)fail('Account or wallet changed. Review your draft again.');
    f.address=wallet.address;const generation=epoch,p=await api('draft',f);
    if(generation!==epoch||user?.id!==identity)fail('Draft saved for the original organizer. Reconnect before publishing it.');
    sessionStorage.removeItem(draftKey);location.assign(`/plan/${p.token}`);
  });};
}
function account() {
  if(!client)return modal('<h2>Sign-in unavailable</h2><p>Set the public Supabase project URL and publishable key for this deployment, then redeploy. No payment can be submitted.</p>');
  if(!user){modal('<h2>Sign in to CountMeIn</h2><p>Your invitation will be preserved in the email sign-in link.</p><form id="auth-form"><fieldset><label for="email">Email</label><input id="email" type="email" maxlength="254" autocomplete="email" required><label for="display-name">Display name</label><input id="display-name" maxlength="30" autocomplete="nickname" required><button class="primary full">Email sign-in link</button></fieldset></form>');
    $('#auth-form').onsubmit=e=>{e.preventDefault();run(async()=>{const name=$('#display-name').value.trim();if(!name)fail('Enter a display name.');const {error}=await client.auth.signInWithOtp({email:$('#email').value.trim(),options:{emailRedirectTo:location.origin+(token?`/plan/${token}`:'/'),data:{display_name:name}}});if(error)throw error;$('#modal').close();status('Check your email. The sign-in link returns to your invitation.');});};
  }else{modal(`<h2>Your account</h2><form id="profile-form"><fieldset><label for="display-name">Display name</label><input id="display-name" maxlength="30" value="${esc(user.user_metadata?.display_name || '')}" required><button class="primary full">Save name</button></fieldset></form><button id="signout" class="outline full">Sign out</button>`);
    $('#profile-form').onsubmit=e=>{e.preventDefault();run(async()=>{const name=$('#display-name').value.trim();if(!name)fail('Enter a display name.');const {data,error}=await client.auth.updateUser({data:{display_name:name}});if(error)throw error;user=data.user;$('#modal').close();render();});};
    $('#signout').onclick=()=>run(async()=>{const {error}=await client.auth.signOut({scope:'local'});if(error)throw error;user=null;wallet=null;epoch++;$('#modal').close();await refresh('Signed out. Your wallet retains its onchain rights.');});
  }
}
const invalidate=()=>{wallet=null;epoch++;if(!busy)refresh('Wallet changed or disconnected. Reconnect before transacting.');};
window.ethereum?.on?.('accountsChanged',invalidate);window.ethereum?.on?.('chainChanged',invalidate);window.ethereum?.on?.('disconnect',invalidate);
window.addEventListener('offline',()=>status('You are offline. Submitted transactions can still confirm; reconnect to check their receipts.'));
if(!validPath)status('Invalid invitation link.');
else if(!__SUPABASE_URL__||!__SUPABASE_KEY__){render();status('CountMeIn authentication requires deployment configuration.');}
else{
  client=createClient(__SUPABASE_URL__,__SUPABASE_KEY__,{auth:{flowType:'implicit',persistSession:true,autoRefreshToken:true,detectSessionInUrl:true},global:{fetch:(input,init={})=>fetch(input,{...init,signal:init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)})}});
  const {data,error}=await client.auth.getSession();user=data.session?.user || null;
  if(callback.has('access_token')||callback.has('error_description'))history.replaceState(null,'',location.pathname);
  await checkReadiness();
  render();await refresh();
  if(!ready)status(readinessError,true);
  if(error||callback.has('error_description'))status('Sign-in link expired or could not be verified. Request a new sign-in link.');
  client.auth.onAuthStateChange((event,session)=>{const old=user?.id;user=session?.user || null;if(old!==user?.id){wallet=null;epoch++;plans=[];receipts=[];render();setTimeout(()=>refresh(event==='SIGNED_OUT'?'Signed out.':''),0);}});
  const resume=()=>{if(!document.hidden&&!busy)run(async()=>{if(!ready)await checkReadiness();await refresh();});};window.addEventListener('focus',resume);document.addEventListener('visibilitychange',resume);setInterval(resume,30000);
}

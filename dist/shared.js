import { createClient } from '@supabase/supabase-js';
import { validatePlan } from './model.js';
import { MONAD_TESTNET, walletEscrow, readEscrow, readProvider, verifyProvider, transactionFor, verifyTransaction, finalizedReceipt, parseCreated, parseMon, formatMon, validWallet, checksum, explorerTx } from './chain.js';

const $ = s => document.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = value => new Intl.DateTimeFormat('en-IN', {dateStyle:'medium', timeStyle:'short'}).format(new Date(value));
const localInput = value => { const d = new Date(value); return new Date(value - d.getTimezoneOffset()*60000).toISOString().slice(0,16); };
const path = location.pathname.match(/^\/plan\/([0-9a-f-]{36})\/?$/i);
const token = path?.[1];
const invalidPath = location.pathname !== '/' && !token;
const callbackError = new URLSearchParams(location.hash.slice(1)).get('error_description');
const authCallback = location.hash.includes('access_token=') || Boolean(callbackError);
let client, user = null, plans = [], filter = 'all', pending = false, revision = 0, refreshing = false;
let walletAddress = null;
const trackingKey = `countmein-testnet-tx:${MONAD_TESTNET.contractAddress}:${token}`;
let tracked = null;
try { tracked = JSON.parse(localStorage.getItem(trackingKey)); } catch {}
function track(value) {
  tracked = value;
  if (value) localStorage.setItem(trackingKey,JSON.stringify(value));
  else localStorage.removeItem(trackingKey);
}

document.body.classList.add('shared');
$('.practice').innerHTML = '<span class="status-dot"></span> SHARED PLANS <span class="practice-copy">Demo credits or testnet tokens. No real payments.</span><a href="/local">Local demo</a>';
$('#profile').setAttribute('aria-label', 'Your account');
$('#profile').textContent = 'Sign in';
$('nav a').href = '/';
$('.section-heading h2').textContent = token ? 'Your invitation' : 'Your shared plans';
$('.section-heading .eyebrow').textContent = 'COUNTMEIN';
$('#plans').insertAdjacentHTML('afterbegin', '<div id="shared-status" class="shared-status" role="status" aria-live="polite"></div>');
$('.filters').hidden = Boolean(token);
$('#stat-plans').previousElementSibling.textContent = 'OPEN DEMO PLANS';
$('.stats-note p').innerHTML = 'Refunds are claimed individually.<br><b>Gas is not refunded.</b>';
for (const [value,label] of Object.entries({open:'Filling up (demo)',funded:'Confirmed (demo)',refundable:'Refunds (demo)'})) $(`[data-filter="${value}"]`).textContent = label;
$('.filters').insertAdjacentHTML('beforeend','<button data-filter="testnet">Testnet</button>');
if (token) $('#plans').insertAdjacentHTML('afterbegin', '<a class="shared-back" href="/">Your plans</a>');
$('#close-modal').onclick = () => { if (!pending) $('#modal').close(); };
$('#modal').addEventListener('cancel', event => { if (pending) event.preventDefault(); });
const rules = '<p>Every contribution and refund is simulated demo credits. Your contribution stays committed while the plan is open. Filling every spot confirms funding; a missed target or organizer cancellation opens refunds.</p><p>Creating a plan does not join you. Funding confirmation is not a venue-booking guarantee.</p>';
$('#how').onclick = () => modal('<h2>Clear commitments.</h2><p>Demo plans use simulated credits. Monad Testnet plans use public wallet transactions and test MON only. No real payments.</p><p>Deposits stay committed while open. Filling all spots confirms funding; cancellation or a missed target opens individual refunds. Creating does not join you. Funding never guarantees a venue booking.</p>');
$('#profile').onclick = () => account();
$('#create').onclick = $('#new-plan').onclick = () => create();
$('.filters').onclick = event => {
  if (!event.target.dataset.filter) return;
  filter = event.target.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
  render();
};

function modal(html) {
  if (pending) return;
  $('#modal-content').innerHTML = html + '<p id="form-error" class="error" role="alert"></p>';
  if (!$('#modal').open) $('#modal').showModal();
}
function message(text, retry = false) {
  $('#shared-status').textContent = text;
  if (retry) {
    const b = document.createElement('button'); b.className = 'outline'; b.textContent = 'Retry';
    b.onclick = () => refresh(); $('#shared-status').append(b);
  }
  if (text.includes('session expired')) {
    const b = document.createElement('button'); b.className = 'outline'; b.textContent = 'Sign in again';
    b.onclick = async () => {
      await run(async () => { const {error} = await client.auth.signOut({scope:'local'}); if (error) throw error; user = null; plans = []; render(); });
      if (!user) account();
    };
    $('#shared-status').append(b);
  }
}
function readable(error) {
  if (error?.code === 'ACTION_REJECTED' || error?.code === 4001) return 'Wallet approval rejected. No transaction was submitted.';
  if (error?.code === 'CALL_EXCEPTION') return 'Transaction failed or is no longer allowed. Refresh the escrow state.';
  if (error?.code === 'PGRST202') return 'Shared plans are not ready yet. The database setup is incomplete.';
  if (error?.code === '28000' || /jwt|expired|refresh.token/i.test(error?.message || '')) return 'Your session expired. Sign in again to continue.';
  if (/fetch|network|timeout|abort/i.test(error?.message || '')) return 'Connection interrupted. Retry to check the latest plan state before trying again.';
  return error?.message || 'Something went wrong. Please retry.';
}
async function rpc(name, args) {
  const {data, error} = await client.rpc(name, args);
  if (error) throw error;
  return data;
}
async function run(work) {
  if (pending) return;
  pending = true;
  document.querySelectorAll('button, fieldset').forEach(el => { if (!el.disabled) { el.disabled = true; el.dataset.busy = 'true'; } });
  if ($('#form-error')) $('#form-error').textContent = '';
  try { await work(); }
  catch (error) {
    const text = readable(error);
    if ($('#modal').open) $('#form-error').textContent = text;
    else message(text, true);
  } finally {
    pending = false;
    document.querySelectorAll('[data-busy]').forEach(el => { el.disabled = false; delete el.dataset.busy; });
  }
}
function stateLabel(p) {
  if (p.payment_mode === 'monad_testnet') return p.chain ? ['Open for test MON','Funding confirmed','Refunds open','Recipient paid'][p.chain.state] : p.chain_plan_id ? 'Check escrow state' : 'Awaiting escrow activation';
  return p.state === 'funded' ? 'Funding confirmed' : p.state === 'cancelled' ? 'Cancelled - refunds open' : p.state === 'failed' ? 'Deadline missed - refunds open' : `${p.target-p.count} ${p.target-p.count === 1 ? 'spot' : 'spots'} left`;
}
function render() {
  $('#profile').textContent = user?.user_metadata?.display_name || (user ? 'Account' : 'Sign in');
  $('#stat-plans').textContent = plans.filter(p => p.state === 'open').length;
  $('#stat-deposits').innerHTML = plans.filter(p => p.joined && !p.refunded).reduce((n,p) => n+p.amount,0) + ' <small>demo credits</small>';
  $('#stat-refunds').innerHTML = plans.filter(p => p.joined && !p.refunded && ['failed','cancelled'].includes(p.state)).reduce((n,p) => n+p.amount,0) + ' <small>demo credits</small>';
  if (token) {
    $('#plan-grid').innerHTML = plans.length ? detail(plans[0]) : '<div class="empty">Invitation not found. Check the link with your organizer.</div>';
    return;
  }
  const visible = plans.filter(p => filter === 'all' || (filter === 'testnet' ? p.payment_mode === 'monad_testnet' : filter === 'refundable' ? ['failed','cancelled'].includes(p.state) : p.state === filter));
  $('#plan-grid').innerHTML = visible.length ? visible.map(p => `<article class="card shared-card"><div class="card-art ${esc(p.activity)}"><span class="big-symbol" aria-hidden="true">${p.activity === 'sport' ? '&#9678;' : '&#9651;'}</span><span class="badge">${esc(stateLabel(p))}</span></div><div class="card-body"><h3>${esc(p.title)}</h3><div class="meta">${esc(date(p.event_at))}<br>${esc(p.location)}</div><p>${p.payment_mode === 'monad_testnet' ? 'Monad Testnet - open to verify funding' : `${p.count} of ${p.target} people committed`}</p><div class="card-bottom"><div class="price">${p.payment_mode === 'monad_testnet' ? esc(formatMon(p.contribution_wei)) : p.amount}<small>${p.payment_mode === 'monad_testnet' ? 'test MON / wallet' : 'simulated demo credits / person'}</small></div><a href="/plan/${p.token}">View plan &rarr;</a></div></div></article>`).join('') : `<div class="empty">${user ? 'No shared plans here yet. Create one or open an invitation.' : 'Sign in to see your plans, or open an invitation from a friend.'}</div>`;
}
function detail(p) {
  if (p.payment_mode === 'monad_testnet') return chainDetail(p);
  const refundable = ['failed','cancelled'].includes(p.state);
  let action = '';
  if (!user) action = '<button class="primary" data-action="signin">Sign in to participate</button>';
  else if (p.state === 'open' && !p.joined) action = `<button class="primary" data-action="join">Join with ${p.amount} simulated demo credits</button>`;
  else if (refundable && p.joined && !p.refunded) action = `<button class="primary" data-action="refund">Claim ${p.amount} simulated demo credits</button>`;
  return `<article class="shared-detail"><span class="badge">${esc(stateLabel(p))}</span><h2>${esc(p.title)}</h2><p class="meta">${esc(p.activity)} &middot; ${esc(p.location)}</p><div class="detail-grid"><div><small>Participation</small><strong>${p.count} of ${p.target} people</strong></div><div><small>Simulated contribution per person</small><strong>${p.amount} demo credits</strong></div><div><small>Funding deadline</small><strong>${esc(date(p.deadline))}</strong></div><div><small>Event time</small><strong>${esc(date(p.event_at))}</strong></div></div><p>${p.refunded ? 'Your simulated refund has been claimed.' : p.joined ? 'You are in. Your simulated contribution is recorded.' : 'You have not contributed to this plan.'}${p.is_owner ? ' You are the organizer.' : ''}</p><div class="actions">${action}<button class="outline" data-action="copy">Copy invitation link</button><button class="outline" data-action="refresh">Refresh</button></div>${p.is_owner && p.state === 'open' ? '<button class="text-button" data-action="cancel">Cancel plan</button>' : ''}<div class="notice">${rules}</div></article>`;
}
$('#plan-grid').onclick = event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action || pending) return;
  if (action === 'signin') return account();
  if (action === 'refresh') return refresh();
  if (action === 'copy') return run(async () => {
    const link = `${location.origin}/plan/${token}`;
    try { await navigator.clipboard.writeText(link); message('Invitation link copied. Anyone with this link can preview the plan.'); }
    catch { message('Clipboard unavailable. Copy the invitation from the address bar.'); }
  });
  if (plans[0]?.payment_mode === 'monad_testnet') return chainAction(action);
  if (action === 'cancel') {
    modal('<h2>Cancel this plan?</h2><p>Every participant can claim their own simulated refund. This cannot be undone.</p><button id="confirm-cancel" class="primary full">Cancel plan and open refunds</button>');
    $('#confirm-cancel').onclick = () => mutate('cancel');
  } else mutate(action);
};
function chainDetail(p) {
  const c = p.chain, ownerWallet = walletAddress && checksum(walletAddress) === checksum(p.organizer_wallet);
  const button = (action,label) => `<button class="primary" data-action="${action}">${label}</button>`;
  let actions = !user ? button('signin','Sign in to participate') : button('connect',walletAddress ? 'Change / reconnect wallet' : 'Connect wallet');
  if (user && !tracked && walletAddress) {
    if (!p.chain_plan_id && p.is_owner && ownerWallet && Date.parse(p.deadline) > Date.now()) actions += button('create','Activate testnet escrow');
    if (c?.state === 0 && !c.joined) actions += button('join',`Deposit ${esc(formatMon(p.contribution_wei))} test MON`);
    if (c?.state === 0 && ownerWallet) actions += button('cancel','Cancel and open refunds');
    if (c?.state === 1) actions += button('collect','Release test MON to recipient');
    if (c?.state === 2 && c.deposit > 0n) actions += button('refund','Claim test MON refund');
  }
  const recover = user && (tracked || (!p.chain_plan_id && p.is_owner));
  return `<article class="shared-detail"><span class="badge">Monad Testnet &middot; ${esc(stateLabel(p))}</span><h2>${esc(p.title)}</h2><p class="meta">${esc(p.activity)} &middot; ${esc(p.location)}</p><div class="detail-grid"><div><small>Finalized participation</small><strong>${c ? `${c.count} of ${p.target} wallets` : 'Not verified'}</strong></div><div><small>Contribution per wallet</small><strong>${esc(formatMon(p.contribution_wei))} test MON</strong></div><div><small>Funding deadline</small><strong>${esc(date(p.deadline))}</strong></div><div><small>Event time</small><strong>${esc(date(p.event_at))}</strong></div></div><p>Recipient: <code class="wallet-address">${esc(p.recipient_wallet)}</code></p><p>Connected wallet: <code class="wallet-address">${esc(walletAddress || 'None')}</code></p><p>Venue booking: <strong>Not verified</strong></p>${p.chainError ? `<p class="error" role="alert">${esc(p.chainError)}</p>` : ''}<p>${c?.joined ? c.state === 2 && c.deposit === 0n ? 'Refunded: your test MON refund is finalized.' : 'Your wallet has a finalized deposit.' : 'No deposit verified for the connected wallet.'}</p>${tracked ? `<p role="status">Submitted ${esc(tracked.action)}. Awaiting finalized confirmation. <a href="${esc(explorerTx(tracked.hash))}" target="_blank" rel="noopener noreferrer">View transaction</a></p>` : ''}<div class="actions">${actions}<button class="outline" data-action="copy">Copy invitation link</button><button class="outline" data-action="refresh">Refresh</button>${recover ? button('recover',tracked ? 'Check submitted transaction' : 'Recover escrow transaction') : ''}</div><div class="notice"><p>Test tokens only; gas is paid in test MON. Deposits stay committed while open. Full funding releases to the fixed recipient; cancellation or a missed target opens individual refunds. Funding is not a venue-booking guarantee.</p><p>Creating does not join you. One slot per wallet; this is not verified-person participation. Wallet activity is public on the blockchain. Experimental, unaudited escrow.</p></div></article>`;
}
async function settleTransaction(p, hash) {
  const action = tracked?.action || 'create', address = tracked?.address || p.organizer_wallet;
  await verifyProvider(readProvider());
  let receipt;
  try { receipt = await verifyTransaction(p,action,address,hash); }
  catch (error) {
    if (tracked?.nonce !== undefined && hash !== tracked.hash) {
      const provider = readProvider(), replacement = await provider.getTransaction(hash);
      if (replacement && checksum(replacement.from) === checksum(address) && replacement.nonce === tracked.nonce && await finalizedReceipt(hash)) {
        track(null); await refresh('Original transaction was replaced or cancelled. No success has been attributed to it.'); return;
      }
    }
    throw error;
  }
  if (!receipt) { message('Submitted. Not finalized yet; check again before sending anything else.',true); return; }
  if (receipt.status !== 1) {
    track(null); await refresh('Transaction failed on-chain. No successful deposit was recorded.'); return;
  }
  if (action === 'create') {
    await rpc('attach_chain_plan',{p_token:p.token,p_chain_plan_id:parseCreated(receipt,p.escrow_address),p_create_tx:hash});
  } else {
    await readEscrow(p,address);
    await rpc('remember_chain_plan',{p_token:p.token});
  }
  track(null);
  await refresh(action === 'refund' ? 'Refunded. Test MON refund finalized.' : 'Confirmed. Transaction finalized on Monad Testnet.');
}
function chainAction(action) {
  const p = plans[0];
  if (!user) return account();
  if (action === 'recover') {
    modal(`<h2>Check transaction</h2><form id="recover-form"><fieldset><label for="transaction-hash">${tracked ? 'Submitted or speed-up transaction hash' : 'Escrow creation transaction hash'}</label><input id="transaction-hash" value="${esc(tracked?.hash || '')}" pattern="0x[0-9a-fA-F]{64}" required><button class="primary full">Check finalized receipt</button></fieldset></form><p>Only a matching, finalized escrow transaction can be confirmed.</p>`);
    $('#recover-form').onsubmit = event => { event.preventDefault(); const hash = $('#transaction-hash').value.trim(); run(async () => {
      await settleTransaction(p,hash); $('#modal').close();
    }); };
    return;
  }
  if (action === 'cancel') {
    modal('<h2>Cancel testnet plan?</h2><p>Finalized cancellation opens individual test MON refunds and cannot be undone.</p><button class="primary full" id="confirm-chain-cancel">Approve cancellation in wallet</button>');
    $('#confirm-chain-cancel').onclick = () => submitChain(p,'cancel');
    return;
  }
  return submitChain(p,action);
}
function submitChain(p,action) {
  return run(async () => {
    message('Awaiting wallet connection or approval...');
    const wallet = await walletEscrow(); walletAddress = wallet.address;
    if (action === 'connect') { await refresh('Wallet connected to Monad Testnet.'); return; }
    if (tracked) throw Error('A submitted transaction is still being tracked. Check its receipt first.');
    if (checksum(p.escrow_address) !== checksum(MONAD_TESTNET.contractAddress)) throw Error('Escrow deployment does not match this app.');
    if (action === 'create') {
      if (!p.is_owner || checksum(wallet.address) !== checksum(p.organizer_wallet)) throw Error('Use the organizer wallet selected when creating this draft.');
      if (p.chain_plan_id) throw Error('Escrow already attached. Refresh this plan.');
    } else await readEscrow(p,wallet.address);
    // Confirm persistent storage works before asking the wallet to broadcast.
    localStorage.setItem(trackingKey, 'null');
    message('Awaiting approval in your wallet. Nothing is confirmed yet.');
    const tx = await wallet.signer.sendTransaction(transactionFor(p,action,wallet.address));
    track({action,address:wallet.address,hash:tx.hash,nonce:tx.nonce});
    $('#modal').close(); render();
    message('Submitted. Waiting for finalized confirmation; do not submit again.');
    for (let i=0; i<10; i++) {
      if (await finalizedReceipt(tx.hash)) { await settleTransaction(p,tx.hash); return; }
      await new Promise(resolve => setTimeout(resolve,2000));
    }
    message('Submitted, not finalized yet. Use Check submitted transaction to continue.');
  });
}
window.ethereum?.on?.('accountsChanged', () => { walletAddress = null; if (!pending) refresh(); });
window.ethereum?.on?.('chainChanged', () => { walletAddress = null; if (!pending) refresh(); });

function mutate(action) {
  return run(async () => {
    await rpc('act_on_plan', {p_token:token, p_action:action});
    $('#modal').close();
    await refresh('Saved. Shared state updated. All contributions and refunds are simulated demo credits.');
  });
}
async function refresh(success = '') {
  if (!client || invalidPath) return;
  const request = ++revision;
  refreshing = true;
  $('#plan-grid').setAttribute('aria-busy', 'true');
  message('Loading shared plans...');
  try {
    const next = token ? await rpc('preview_plan', {p_token:token}) : user ? await rpc('my_plans') : [];
    if (request !== revision) return;
    const loaded = token ? (next ? [next] : []) : next;
    if (token && loaded[0]?.payment_mode === 'monad_testnet' && loaded[0].chain_plan_id) {
      try { loaded[0].chain = await readEscrow(loaded[0],walletAddress); }
      catch (error) { loaded[0].chainError = readable(error); }
    }
    if (request !== revision) return;
    plans = loaded;
    render(); message(success);
  } catch (error) {
    if (request === revision) message(readable(error), true);
  } finally {
    if (request === revision) { refreshing = false; $('#plan-grid').removeAttribute('aria-busy'); }
  }
}
function account() {
  if (!client) return message('Shared plans are not configured yet. The local demo is available.');
  if (!user) {
    modal('<h2>Join your crew.</h2><p>We will email you a sign-in link. Your invitation stays with you.</p><form id="auth-form"><fieldset><label for="email">Email</label><input id="email" type="email" autocomplete="email" maxlength="254" required><label for="display-name">Display name</label><input id="display-name" maxlength="30" autocomplete="nickname" required><button class="primary full">Email me a sign-in link</button></fieldset></form>');
    $('#auth-form').onsubmit = event => { event.preventDefault(); run(async () => {
      const name = $('#display-name').value.trim();
      if (!name) throw Error('Enter a display name.');
      const {error} = await client.auth.signInWithOtp({email:$('#email').value.trim(), options:{emailRedirectTo:location.origin + (token ? `/plan/${token}` : '/'), data:{display_name:name}}});
      if (error) throw error;
      $('#modal').close(); message('Check your email for the sign-in link. It will return you to this plan.');
    }); };
  } else {
    modal(`<h2>Your account</h2><form id="profile-form"><fieldset><label for="display-name">Display name</label><input id="display-name" maxlength="30" value="${esc(user.user_metadata?.display_name || '')}" required><button class="primary full">Save name</button></fieldset></form><button id="signout" class="outline full">Sign out</button>`);
    $('#profile-form').onsubmit = event => { event.preventDefault(); run(async () => {
      const name = $('#display-name').value.trim(); if (!name) throw Error('Enter a display name.');
      const {data, error} = await client.auth.updateUser({data:{display_name:name}});
      if (error) throw error;
      user = data.user; render(); $('#modal').close(); message('Display name saved.');
    }); };
    $('#signout').onclick = () => run(async () => {
      const {error} = await client.auth.signOut({scope:'local'}); if (error) throw error;
      user = null; plans = []; render(); $('#modal').close(); await refresh('Signed out.');
    });
  }
}
function create() {
  if (!user) return account();
  modal(`<h2>Start a shared plan</h2><form id="create-form"><fieldset><label for="title">Plan name</label><input name="title" id="title" maxlength="70" required><div class="row"><div><label for="category">Activity</label><select name="category" id="category"><option value="sport">Sports</option><option value="outing">Outing</option><option value="social">Get-together</option></select></div><div><label for="location">Location</label><input name="location" id="location" maxlength="90" required></div></div><div class="row"><div><label for="amount">Simulated demo credits per person</label><input name="amount" id="amount" type="number" min="1" max="10000" step="1" value="50" required></div><div><label for="target">Required participants</label><input name="target" id="target" type="number" min="2" max="50" step="1" value="4" required></div></div><label for="deadline">Funding deadline</label><input name="deadline" id="deadline" type="datetime-local" value="${localInput(Date.now()+864e5)}" required><label for="eventAt">Event time</label><input name="eventAt" id="eventAt" type="datetime-local" value="${localInput(Date.now()+2*864e5)}" required><p>Creating does not join you. All contributions are simulated demo credits.</p><button class="primary full">Create shared plan</button></fieldset></form>`);
  $('#create-form fieldset').insertAdjacentHTML('afterbegin', `<label for="payment-mode">Contribution type</label><select id="payment-mode" name="paymentMode"><option value="demo">Simulated demo credits</option><option value="monad_testnet" ${MONAD_TESTNET.contractAddress ? '' : 'disabled'}>Monad Testnet${MONAD_TESTNET.contractAddress ? '' : ' (deployment required)'}</option></select><div id="chain-fields" hidden><label for="test-mon">Test MON per wallet</label><input id="test-mon" name="testMon" inputmode="decimal" value="0.01"><label for="recipient-wallet">Recipient wallet (fixed before deposits)</label><input id="recipient-wallet" name="recipientWallet" placeholder="0x..." spellcheck="false" autocomplete="off"><p>Test tokens only. Wallet addresses and transactions are public. One slot per wallet, not per person.</p></div>`);
  $('#payment-mode').onchange = () => {
    const chain = $('#payment-mode').value === 'monad_testnet';
    $('#chain-fields').hidden = !chain;
    $('#amount').parentElement.hidden = chain;
    $('#amount').disabled = chain;
    $('#test-mon').required = $('#recipient-wallet').required = chain;
    $('#create-form fieldset > p').textContent = chain ? 'Creating a draft does not deposit tokens. Activate its escrow next. Funding does not guarantee a venue booking.' : 'Creating does not join you. All contributions are simulated demo credits.';
  };
  $('#create-form').onsubmit = event => {
    event.preventDefault();
    const f = new FormData(event.target);
    run(async () => {
      const chain = f.get('paymentMode') === 'monad_testnet';
      const p = validatePlan({title:f.get('title').trim(), location:f.get('location').trim(), category:f.get('category'), amount:chain ? 1 : Number(f.get('amount')), target:Number(f.get('target')), deadline:new Date(f.get('deadline')).getTime(), eventAt:new Date(f.get('eventAt')).getTime()});
      const args = {p_title:p.title, p_activity:p.category, p_location:p.location, p_target:p.target, p_deadline:new Date(p.deadline).toISOString(), p_event_at:new Date(p.eventAt).toISOString()};
      if (chain) {
        const amount = parseMon(f.get('testMon')), recipient = f.get('recipientWallet').trim();
        if (!validWallet(recipient)) throw Error('Enter a valid nonzero recipient wallet.');
        const wallet = await walletEscrow(); walletAddress = wallet.address;
        Object.assign(args,{p_contribution_wei:amount.toString(),p_recipient_wallet:checksum(recipient),p_organizer_wallet:wallet.address,p_escrow_address:MONAD_TESTNET.contractAddress});
      } else args.p_amount = p.amount;
      const created = await rpc(chain ? 'create_chain_plan' : 'create_plan', args);
      location.assign(`/plan/${created}`);
    });
  };
}

if (invalidPath) {
  render(); message('Invalid invitation link. Ask the organizer for the complete URL.');
} else if (!__SUPABASE_URL__ || !__SUPABASE_KEY__) {
  render(); message('Shared plans are not configured yet. You can still use the local demo.');
} else {
  client = createClient(__SUPABASE_URL__, __SUPABASE_KEY__, {auth:{flowType:'implicit', persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}, global:{fetch:(input, options = {}) => fetch(input, {...options, signal:options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)})}});
  const {data, error} = await client.auth.getSession();
  user = data.session?.user || null;
  if (authCallback) history.replaceState(null, '', location.pathname);
  render(); await refresh();
  if (error || callbackError) message(readable(error || Error(callbackError)) + ' Request a new sign-in link.');
  client.auth.onAuthStateChange((event, session) => {
    const previous = user?.id;
    user = session?.user || null;
    if (previous !== user?.id || event === 'USER_UPDATED') {
      plans = []; render();
      // Leave the auth callback before making another Supabase request.
      setTimeout(() => refresh(event === 'SIGNED_OUT' ? 'Session ended. Sign in again to participate.' : ''), 0);
    }
  });
  const resume = () => { if (!document.hidden && !pending && !refreshing) refresh(); };
  window.addEventListener('focus', resume);
  document.addEventListener('visibilitychange', resume);
  setInterval(resume, 30000);
}

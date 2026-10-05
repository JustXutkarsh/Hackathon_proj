import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, keccak256, ZeroAddress } from 'ethers';
import { compileContract } from '../scripts/compile-contract.mjs';
import { detailsHash, parseMon, parseCreated, verifyProvider, readEscrow, verifyTransaction, finalizedReceipt, transactionFor, quoteTransaction } from '../dist/chain.js';

let chain, provider, contract, owner, a, b, recipient, config, plan;
before(async () => {
  chain = ganache.provider({logging:{quiet:true},wallet:{totalAccounts:5},chain:{chainId:10143,hardfork:'shanghai'}});
  provider = new BrowserProvider(chain,undefined,{cacheTimeout:-1}); provider.pollingInterval = 10;
  [owner,a,b,recipient] = await Promise.all([0,1,2,3].map(i=>provider.getSigner(i)));
  const artifact = compileContract();
  contract = await new ContractFactory(artifact.abi,artifact.bytecode,owner).deploy(); await contract.waitForDeployment();
  config = {chainId:10143,contractAddress:await contract.getAddress(),runtimeHash:keccak256(artifact.runtime)};
  const now = (await provider.getBlock('latest')).timestamp;
  plan = {token:'11111111-1111-4111-8111-111111111111',title:'Football',activity:'sport',location:'Turf',
    organizer_wallet:await owner.getAddress(),recipient_wallet:await recipient.getAddress(),escrow_address:config.contractAddress,
    contribution_wei:parseMon('0.01').toString(),target:2,deadline:new Date((now+3600)*1000).toISOString(),event_at:new Date((now+7200)*1000).toISOString()};
  const tx = await owner.sendTransaction(transactionFor(plan,'create',plan.organizer_wallet));
  plan.chain_create_tx = tx.hash; plan.chain_plan_id = parseCreated(await tx.wait(),config.contractAddress);
});
after(async () => { provider?.destroy(); await chain?.disconnect(); });

test('Monad fee quotes round a small gas margin up without overriding wallet fee prices', async () => {
  const request=transactionFor(plan,'create',plan.organizer_wallet);
  const stub={estimateGas:async tx=>{assert.deepEqual(tx,{...request,from:plan.organizer_wallet});return 201n;},
    send:async(method,args)=>{assert.equal(method,'eth_gasPrice');assert.deepEqual(args,[]);return '0x17bfac7c00';}};
  const quote=await quoteTransaction(stub,request,plan.organizer_wallet);
  assert.equal(quote.request.gasLimit,217n);assert.equal(quote.gasPrice,102000000000n);assert.equal(quote.cost,217n*102000000000n);
  assert.deepEqual(Object.keys(quote.request).sort(),['data','gasLimit','to','value']);assert.equal(quote.request.value,0n);
  stub.send=async()=> '0x0';await assert.rejects(quoteTransaction(stub,request,plan.organizer_wallet),/estimate is unavailable/);
  stub.estimateGas=async()=>{throw Error('simulation reverted');};await assert.rejects(quoteTransaction(stub,request,plan.organizer_wallet),/simulation reverted/);
});
test('exact decimal amounts and verified deployment/network are required', async () => {
  assert.equal(parseMon('0.000000000000000001'),1n);
  for (const value of ['0','-1','1e3','0.0000000000000000001','NaN']) assert.throws(()=>parseMon(value));
  await verifyProvider(provider,config);
  await assert.rejects(verifyProvider(provider,{...config,chainId:1}),/Wrong network/);
  await assert.rejects(verifyProvider(provider,{...config,contractAddress:ZeroAddress}),/bytecode/);
});
test('creation proof binds receipt, emitter, wallet, metadata and every funding term', async () => {
  const receipt = await finalizedReceipt(plan.chain_create_tx,provider);
  assert.equal(parseCreated(receipt,config.contractAddress),plan.chain_plan_id);
  assert.throws(()=>parseCreated({...receipt,status:0},config.contractAddress),/not successful/);
  assert.throws(()=>parseCreated({...receipt,logs:receipt.logs.map(log=>({...log,address:ZeroAddress}))},config.contractAddress),/No CountMeIn/);
  const state = await readEscrow(plan,null,provider,config);
  assert.equal(state.count,0); assert.equal(state.state,0);
  for (const change of [{title:'Tampered'},{recipient_wallet:await a.getAddress()},{organizer_wallet:await a.getAddress()},{contribution_wei:'1'},{chain_plan_id:'99'},{token:'22222222-2222-4222-8222-222222222222'}]) {
    await assert.rejects(readEscrow({...plan,...change},null,provider,config));
  }
  assert.notEqual(detailsHash(plan),detailsHash({...plan,location:'Another turf'}));
  await assert.rejects(verifyTransaction(plan,'join',plan.organizer_wallet,plan.chain_create_tx,provider),/does not match/);
});
test('missing, unfinalized and noncanonical receipts never confirm', async () => {
  assert.equal(await finalizedReceipt('0x'+'f'.repeat(64),provider),null);
  const receipt = await provider.getTransactionReceipt(plan.chain_create_tx);
  const stub = {getTransactionReceipt:async()=>receipt,getBlock:async()=>({number:receipt.blockNumber-1})};
  assert.equal(await finalizedReceipt(plan.chain_create_tx,stub),null);
  stub.getBlock = async tag => tag === 'finalized' ? {number:receipt.blockNumber} : {hash:'different'};
  assert.equal(await finalizedReceipt(plan.chain_create_tx,stub),null);
});
test('simultaneous last-slot transactions cannot overfill; payout is fixed and once only', async () => {
  const price = BigInt(plan.contribution_wei);
  await (await contract.connect(a).join(plan.chain_plan_id,{value:price})).wait();
  await chain.request({method:'miner_stop',params:[]});
  const attempts = await Promise.all([b,owner].map(s=>contract.connect(s).join(plan.chain_plan_id,{value:price,gasLimit:200000})));
  await chain.request({method:'evm_mine',params:[]});
  await chain.request({method:'miner_start',params:[]});
  const results = await Promise.allSettled(attempts.map(tx=>tx.wait()));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
  for (let i=0; i<attempts.length; i++) {
    const receipt = await verifyTransaction(plan,'join',await [b,owner][i].getAddress(),attempts[i].hash,provider);
    assert.equal(receipt.status,results[i].status === 'fulfilled' ? 1 : 0);
  }
  const state = await readEscrow(plan,await a.getAddress(),provider,config);
  assert.equal(state.count,2); assert.equal(state.state,1); assert.equal(state.joined,true);
  await assert.rejects(contract.connect(a).join(plan.chain_plan_id,{value:price}));
  await assert.rejects(contract.cancel(plan.chain_plan_id));
  await assert.rejects(contract.connect(a).claimRefund(plan.chain_plan_id,await a.getAddress()));
  const before = await provider.getBalance(plan.recipient_wallet);
  await (await contract.connect(a).collect(plan.chain_plan_id)).wait();
  assert.equal((await provider.getBalance(plan.recipient_wallet))-before,price*2n);
  await assert.rejects(contract.collect(plan.chain_plan_id));
  assert.equal((await readEscrow(plan,null,provider,config)).state,3);
});

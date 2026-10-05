import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import solc from 'solc';
import ganache from 'ganache';
import { BrowserProvider,ContractFactory,ZeroAddress,ZeroHash,parseEther,keccak256,toUtf8Bytes } from 'ethers';
import { compileContract } from '../scripts/compile-contract.mjs';
let chain,provider,contract,owner,a,b,recipient,receiverArtifact;
const price=parseEther('0.01');
before(async()=>{
  chain=ganache.provider({logging:{quiet:true},chain:{chainId:10143,hardfork:'shanghai'},wallet:{totalAccounts:6}});
  provider=new BrowserProvider(chain,undefined,{cacheTimeout:-1});provider.pollingInterval=10;
  [owner,a,b,recipient]=await Promise.all([0,1,2,3].map(i=>provider.getSigner(i)));
  const artifact=compileContract();contract=await new ContractFactory(artifact.abi,artifact.bytecode,owner).deploy();await contract.waitForDeployment();
  const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'Receiver.sol':{content:readFileSync(new URL('./fixtures/Receiver.sol',import.meta.url),'utf8')}},settings:{evmVersion:'paris',optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}})));
  assert.equal((output.errors||[]).filter(e=>e.severity==='error').length,0);receiverArtifact=output.contracts['Receiver.sol'].Receiver;
});
after(async()=>{provider?.destroy();await chain?.disconnect();});
const tx=async value=>(await value).wait();
async function create(to=recipient.address,hash=ZeroHash){const now=(await provider.getBlock('latest')).timestamp,id=await contract.nextId();await tx(contract.createPlan(to,price,2,now+100,now+200,hash));return id;}
async function receiver(){const c=await new ContractFactory(receiverArtifact.abi,receiverArtifact.evm.bytecode.object,owner).deploy(await contract.getAddress());await c.waitForDeployment();return c;}
const balance=async address=>BigInt(await chain.request({method:'eth_getBalance',params:[address,'latest']}));
test('rejected recipient transfers preserve funded rights; only recipient can redirect and collect once',async()=>{
  const r=await receiver(),id=await create(await r.getAddress());await tx(r.configure(true,0,id));
  await tx(contract.connect(a).join(id,{value:price}));await tx(contract.connect(b).join(id,{value:price}));
  await assert.rejects(tx(contract.collect(id,{gasLimit:300000})));assert.equal(await contract.stateOf(id),1n);
  await assert.rejects(tx(contract.collectTo(id,recipient.address,{gasLimit:300000})));
  await assert.rejects(tx(contract.connect(a).collectTo(id,recipient.address,{gasLimit:300000})));
  await assert.rejects(tx(r.redirect(id,ZeroAddress,{gasLimit:300000})));
  const before=await balance(recipient.address);await tx(r.redirect(id,recipient.address));
  assert.equal((await balance(recipient.address))-before,price*2n);assert.equal(await contract.stateOf(id),3n);
  await assert.rejects(tx(r.redirect(id,recipient.address,{gasLimit:300000})));
});
test('failed refund stays claimable; reentrant depositor receives exactly one contribution',async()=>{
  const r=await receiver(),address=await r.getAddress(),id=await create();await tx(r.join(id,{value:price}));await tx(contract.cancel(id));
  await tx(r.configure(true,0,id));await assert.rejects(tx(r.refund(id,address,{gasLimit:300000})));
  assert.equal(await contract.deposits(id,address),price);
  await tx(r.configure(false,1,id));const before=await balance(address);await tx(r.refund(id,address));
  assert.equal((await balance(address))-before,price);assert.equal(await r.reentryBlocked(),true);assert.equal(await contract.deposits(id,address),0n);
  await assert.rejects(tx(r.refund(id,address,{gasLimit:300000})));
});
test('reentrant recipient cannot collect twice or consume funds belonging to another plan',async()=>{
  const r=await receiver(),address=await r.getAddress(),id=await create(address),other=await create();
  await tx(contract.connect(a).join(other,{value:price}));
  await tx(contract.connect(a).join(id,{value:price}));await tx(contract.connect(b).join(id,{value:price}));
  await tx(r.configure(false,2,id));const before=await balance(address);await tx(contract.collect(id));
  assert.equal((await balance(address))-before,2n*price);assert.equal(await r.reentryBlocked(),true);
  assert.equal(await contract.deposits(other,a.address),price);assert.equal(await contract.stateOf(other),0n);
  await tx(contract.cancel(other));await tx(contract.connect(a).claimRefund(other,a.address));
  assert.equal(await balance(await contract.getAddress()),0n);
});
test('exact deadline excludes deposits; funded plans retain rights after the deadline',async()=>{
  const id=await create(),terms=await contract.plans(id);
  await tx(contract.connect(a).join(id,{value:price}));
  await chain.request({method:'evm_setTime',params:[Number(terms.deadline)*1000]});await chain.request({method:'evm_mine',params:[]});
  assert.equal((await provider.getBlock('latest')).timestamp,Number(terms.deadline));assert.equal(await contract.stateOf(id),2n);
  await assert.rejects(tx(contract.connect(b).join(id,{value:price,gasLimit:200000})));await tx(contract.connect(a).claimRefund(id,a.address));
  const funded=await create();await tx(contract.connect(a).join(funded,{value:price}));await tx(contract.connect(b).join(funded,{value:price}));
  await chain.request({method:'evm_increaseTime',params:[101]});await chain.request({method:'evm_mine',params:[]});
  assert.equal(await contract.stateOf(funded),1n);await tx(contract.collect(funded));
});
test('nonzero metadata commitment prevents accidental duplicate escrow creation',async()=>{
  const hash=keccak256(toUtf8Bytes('unique invitation')),now=(await provider.getBlock('latest')).timestamp;
  await tx(contract.connect(a).createPlan(recipient.address,price,2,now+100,now+200,hash));
  const id=await create(recipient.address,hash);
  assert.equal(await contract.metadataUsed(await owner.getAddress(),hash),true);assert.equal(await contract.metadataPlanId(await owner.getAddress(),hash),id);
  assert.ok(await contract.createdBlock(id)>0n);await assert.rejects(create(recipient.address,hash));
  assert.notEqual(await contract.metadataPlanId(a.address,hash),id,'Another wallet cannot reserve the organizer commitment');
});

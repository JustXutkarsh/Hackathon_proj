import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet,keccak256 } from 'ethers';
import { SiweMessage } from 'siwe';
import { ReleaseService,HttpError } from '../server/release.mjs';
import { handle } from '../api/release.js';

const user={id:'00000000-0000-4000-8000-000000000001'},origin='https://countmein.example';
function response(){return {headers:{},setHeader(k,v){this.headers[k]=v;},end(body){this.body=JSON.parse(body);}};}
test('API requires trusted authentication and exact origin, ignores client identity and hides internal errors',async()=>{
  const calls=[],runtime={origin,auth:{auth:{getUser:async token=>token==='valid'?{data:{user}}:{data:{user:null},error:true}}},service:{
    draft:async(actor,body)=>{calls.push({actor,body});return {owner:actor.id};},refresh:async()=>({status:'synchronized'})}};
  const request=(body,headers={})=>({method:'POST',headers:{origin,'content-type':'application/json',authorization:'Bearer valid',...headers},body});
  for(const [req,code] of [[request({action:'draft'},{origin:'https://attacker.example'}),403],[request({action:'draft'},{authorization:''}),401],
    [request({action:'draft'},{authorization:'Bearer forged'}),401],[request('{invalid'),400],[request({action:'__proto__'}),400],
    [request({action:'draft',title:'x'.repeat(13000)}),413],[request({action:'draft'},{'content-type':'text/plain'}),415]]){
    const res=response();await handle(req,res,runtime);assert.equal(res.statusCode,code);assert.equal(res.headers['Cache-Control'],'no-store');
  }
  let res=response();await handle(request({action:'draft',user_id:'attacker'}),res,runtime);assert.equal(res.body.owner,user.id);assert.equal(calls.length,1);
  res=response();await handle(request({action:'refresh'},{authorization:''}),res,runtime);assert.equal(res.statusCode,200);
  runtime.service.draft=async()=>{throw Error('password=secret; SQL private_table');};res=response();await handle(request({action:'draft'}),res,runtime);
  assert.equal(res.statusCode,503);assert.doesNotMatch(JSON.stringify(res.body),/password|SQL|private_table/);
});
test('signed wallet linking rejects altered domain, nonce, account, expired challenge and replay',async()=>{
  const wallet=Wallet.createRandom();let challenge,clock=new Date(),links=0;
  const provider={send:async()=> '0x279f',getCode:async address=>address.toLowerCase()===wallet.address.toLowerCase()?'0x':'0x1234'};
  const service=new ReleaseService({origin,provider,now:()=>clock,config:{chainId:10143,contractAddress:'0x'+'1'.repeat(40),runtimeHash:keccak256('0x1234')},
    admin:async(action,input)=>{
      if(action==='challenge')challenge={...input,address:input.address.toLowerCase(),expires_at:new Date(+clock+300000).toISOString()};
      if(action==='challenge_get')return challenge;
      if(action==='challenge_consume'){if(challenge.consumed_at)throw new HttpError(409,'Consumed');challenge.consumed_at=clock;links++;return {address:input.address};}
    }});
  const issued=await service.challenge(user,{address:wallet.address}),correct=challenge.message;
  for(const changes of [{domain:'attacker.example'},{nonce:'a'.repeat(64)},{requestId:'other-account'},{uri:'https://attacker.example'},{chainId:1}]){
    challenge.message=new SiweMessage({...new SiweMessage(correct),...changes}).prepareMessage();
    await assert.rejects(service.verifyWallet(user,{signature:await wallet.signMessage(challenge.message)}));
  }
  challenge.message=correct;await assert.rejects(service.verifyWallet(user,{signature:await Wallet.createRandom().signMessage(correct)}));
  clock=new Date(+clock+300001);await assert.rejects(service.verifyWallet(user,{signature:await wallet.signMessage(issued.message)}),/expired/);
  clock=new Date(+clock-300001);const signature=await wallet.signMessage(correct);await service.verifyWallet(user,{signature});
  await assert.rejects(service.verifyWallet(user,{signature}),/already used/);assert.equal(links,1);
});

import { randomBytes } from 'node:crypto';
import { SiweMessage } from 'siwe';
import { Interface, Contract, getAddress, toBeHex, zeroPadValue } from 'ethers';
import { ESCROW_ABI, detailsHash, transactionFor, finalizedReceipt, verifyProvider, readEscrow, parseCreated, parseMon, validWallet } from '../dist/chain.js';

const iface = new Interface(ESCROW_ABI);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class HttpError extends Error { constructor(status,message) { super(message); this.status=status; } }
const requireValue = (condition,message='Invalid request.') => { if (!condition) throw new HttpError(400,message); };
const labels = {createPlan:'Created',join:'Joined',cancel:'Cancelled',collect:'Collected',collectTo:'Collected',claimRefund:'Refunded'};
const actions = {createPlan:'create',join:'join',cancel:'cancel',collect:'collect',claimRefund:'refund'};
const creationMatches=(p,e)=>e.name==='PlanCreated' && e.args.detailsHash===detailsHash(p)
  && e.args.organizer.toLowerCase()===p.organizer_wallet.toLowerCase() && e.args.recipient.toLowerCase()===p.recipient_wallet.toLowerCase()
  && e.args.price===BigInt(p.contribution_wei) && e.args.target===BigInt(p.target)
  && e.args.deadline===BigInt(Date.parse(p.deadline)/1000) && e.args.eventAt===BigInt(Date.parse(p.event_at)/1000);

export class ReleaseService {
  constructor({admin,provider,config,origin,now=()=>new Date()}) {
    Object.assign(this,{admin,provider,config,origin,now});
  }
  async linked(user,address) {
    if (!user || !validWallet(address) || !await this.admin('linked',{user_id:user.id,address})) throw new HttpError(403,'Verify ownership of this wallet first.');
  }
  async challenge(user,body) {
    await verifyProvider(this.provider,this.config);
    requireValue(validWallet(body.address),'Enter a valid wallet address.');
    const address=getAddress(body.address), nonce=randomBytes(32).toString('hex'), issued=this.now();
    // Contract-account signature validation is intentionally unsupported in this release.
    if (await this.provider.getCode(address)!=='0x') throw new HttpError(400,'This release supports externally owned wallets. Contract wallets can exercise their rights directly onchain.');
    const message=new SiweMessage({domain:new URL(this.origin).host,address,statement:'Link this wallet to your CountMeIn account. This does not authorize a payment.',
      uri:this.origin,version:'1',chainId:10143,nonce,issuedAt:issued.toISOString(),expirationTime:new Date(+issued+300000).toISOString(),requestId:user.id}).prepareMessage();
    await this.admin('challenge',{user_id:user.id,address,nonce,message});
    return {message};
  }
  async verifyWallet(user,body) {
    requireValue(typeof body.signature==='string' && body.signature.length<=1024,'Invalid wallet signature.');
    const challenge=await this.admin('challenge_get',{user_id:user.id});
    if (!challenge || challenge.consumed_at || Date.parse(challenge.expires_at)<=+this.now()) throw new HttpError(400,'Wallet challenge expired or already used. Request a new one.');
    const message=new SiweMessage(challenge.message);
    requireValue(message.uri===this.origin && message.chainId===10143 && message.requestId===user.id && message.address.toLowerCase()===challenge.address,'Invalid wallet challenge.');
    if (await this.provider.getCode(message.address)!=='0x') throw new HttpError(400,'Contract wallet signatures are unsupported.');
    try { const result=await message.verify({signature:body.signature,domain:new URL(this.origin).host,nonce:challenge.nonce,time:this.now().toISOString()}); if (!result.success) throw Error('Invalid signature'); }
    catch { throw new HttpError(400,'Wallet signature does not match this challenge.'); }
    return this.admin('challenge_consume',{user_id:user.id,address:message.address,nonce:challenge.nonce});
  }
  async draft(user,body) {
    await verifyProvider(this.provider,this.config);
    await this.linked(user,body.address);
    const text=(key,max)=>{requireValue(typeof body[key]==='string',`Enter a valid ${key}.`);const value=body[key].trim();requireValue(value.length>0&&value.length<=max,`Enter a valid ${key}.`);return value;};
    let contribution;try{contribution=parseMon(String(body.contribution));}catch{throw new HttpError(400,'Enter a positive contribution with at most 18 decimal places.');}
    const deadline=new Date(body.deadline),event=new Date(body.event_at);
    requireValue(Number.isInteger(body.target) && body.target>=2 && body.target<=50,'Choose 2 to 50 participant slots.');
    requireValue(Number.isFinite(+deadline) && +deadline>+this.now() && +deadline%1000===0 && +event>+deadline && +event%1000===0,'Choose a future deadline and a later event time.');
    requireValue(['sport','outing','social'].includes(body.activity),'Choose an activity.');
    requireValue(validWallet(body.recipient_wallet),'Enter a valid nonzero recipient.');
    const p=await this.admin('draft',{user_id:user.id,address:body.address,title:text('title',70),description:text('description',500),location:text('location',90),
      activity:body.activity,contribution_wei:contribution.toString(),target:body.target,deadline:deadline.toISOString(),event_at:event.toISOString(),
      recipient_wallet:getAddress(body.recipient_wallet),escrow_address:this.config.contractAddress});
    return this.admin('commitment',{user_id:user.id,token:p.token,metadata_hash:detailsHash(p)});
  }
  async plan(token,user) {
    requireValue(uuid.test(token),'Invalid invitation.');
    const p=await this.admin('plan',{token,user_id:user?.id});
    if (!p?.token) throw new HttpError(404,'Invitation not found.');
    if (p.chain_id!==10143 || p.escrow_address.toLowerCase()!==this.config.contractAddress.toLowerCase()) throw new HttpError(409,'This plan uses a different escrow deployment.');
    return p;
  }
  async receipt(user,{token,hash}) {
    requireValue(/^0x[0-9a-fA-F]{64}$/.test(hash),'Enter a valid transaction hash.');
    const p=await this.plan(token,user);
    await verifyProvider(this.provider,this.config);
    await this.checkCursor();
    const receipt=await finalizedReceipt(hash,this.provider);
    const tx=await this.provider.getTransaction(hash);
    if (!receipt && !tx) return {status:'submitted'};
    requireValue(tx?.to?.toLowerCase()===this.config.contractAddress.toLowerCase(),'Transaction targets another contract.');
    await this.linked(user,tx.from);
    if (!receipt) {
      this.validateTx(p,tx);
      await this.admin('pending',{token,hash,address:tx.from,nonce:tx.nonce,data:tx.data,value:tx.value.toString()});
      return {status:'submitted'};
    }
    return this.processReceipt(p,receipt,tx);
  }
  async replacement(user,{token,hash,original_hash}) {
    const p=await this.plan(token,user);
    await verifyProvider(this.provider,this.config); await this.checkCursor();
    requireValue(/^0x[0-9a-fA-F]{64}$/.test(original_hash) && /^0x[0-9a-fA-F]{64}$/.test(hash),'Enter valid transaction hashes.');
    const stored=await this.admin('pending_get',{token,hash:original_hash});
    const original=await this.provider.getTransaction(original_hash) || (stored?{...stored,value:BigInt(stored.value)}:null),replacement=await this.provider.getTransaction(hash);
    requireValue(original?.to?.toLowerCase()===this.config.contractAddress.toLowerCase(),'Original transaction is not from this escrow.');
    await this.linked(user,original.from);
    const action=this.validateTx(p,original);
    requireValue(replacement?.from.toLowerCase()===original.from.toLowerCase() && replacement.nonce===original.nonce,'Replacement must have the same wallet and nonce.');
    const receipt=await finalizedReceipt(hash,this.provider);
    if(!receipt)return {status:'submitted'};
    requireValue(!await finalizedReceipt(original_hash,this.provider),'Original transaction already finalized.');
    if(replacement.to?.toLowerCase()===original.to.toLowerCase() && replacement.data===original.data && replacement.value===original.value) return this.processReceipt(p,receipt,replacement);
    const block=await this.provider.getBlock(receipt.blockNumber);
    await this.admin('record',{token,chain_id:10143,escrow_address:this.config.contractAddress,chain_plan_id:p.chain_plan_id,chain_create_tx:p.chain_create_tx,
      receipts:[{tx_hash:hash,actor:original.from,log_index:-1,kind:labels[action.name],amount_wei:'0',status:'replaced',block_number:receipt.blockNumber,
        block_hash:receipt.blockHash,occurred_at:new Date(block.timestamp*1000).toISOString()}]});
    return {status:'replaced',hash};
  }
  validateTx(p,tx) {
    requireValue(tx?.to?.toLowerCase()===this.config.contractAddress.toLowerCase(),'Transaction targets another contract.');
    let parsed; try { parsed=iface.parseTransaction({data:tx.data,value:tx.value}); } catch {}
    requireValue(parsed && labels[parsed.name],'Transaction is not a supported escrow action.');
    if (parsed.name==='createPlan') {
      requireValue(tx.from.toLowerCase()===p.organizer_wallet.toLowerCase() && tx.data===transactionFor(p,'create',tx.from).data && tx.value===0n,'Creation terms do not match this invitation.');
    } else {
      requireValue(p.chain_plan_id!==null && parsed.args[0].toString()===p.chain_plan_id,'Transaction belongs to another plan.');
      requireValue(tx.value===(parsed.name==='join'?BigInt(p.contribution_wei):0n),'Incorrect contribution amount.');
      if (actions[parsed.name] && parsed.name!=='claimRefund') requireValue(tx.data===transactionFor(p,actions[parsed.name],tx.from).data,'Unexpected transaction data.');
    }
    return parsed;
  }
  async processReceipt(p,receipt,tx) {
    const parsed=this.validateTx(p,tx);
    const block=await this.provider.getBlock(receipt.blockNumber);
    requireValue(block?.hash===receipt.blockHash,'Receipt is no longer canonical.');
    const base={tx_hash:receipt.hash,actor:tx.from,block_number:receipt.blockNumber,block_hash:receipt.blockHash,occurred_at:new Date(block.timestamp*1000).toISOString()};
    const records=[];
    if (receipt.status===0) records.push({...base,log_index:-1,kind:labels[parsed.name],amount_wei:parsed.name==='join'?p.contribution_wei:'0',status:'failed'});
    else {
      const expected={createPlan:'PlanCreated',join:'Joined',cancel:'Cancelled',collect:'Collected',collectTo:'Collected',claimRefund:'Refunded'}[parsed.name];
      for (const log of receipt.logs) {
        if (log.address.toLowerCase()!==this.config.contractAddress.toLowerCase()) continue;
        let event; try { event=iface.parseLog(log); } catch { continue; }
        if (event?.name!==expected) continue;
        const args=event.args;
        if (parsed.name==='createPlan') {
          const id=parseCreated(receipt,this.config.contractAddress);
          requireValue(!p.chain_plan_id || p.chain_plan_id===id,'Invitation already uses another escrow.');
          p={...p,chain_plan_id:id,chain_create_tx:receipt.hash};
        } else requireValue(args.id.toString()===p.chain_plan_id,'Receipt contains another plan.');
        if (event.name==='Joined' || event.name==='Refunded') requireValue(args.participant.toLowerCase()===tx.from.toLowerCase() && args.amount===BigInt(p.contribution_wei),'Participant or amount mismatch.');
        if (event.name==='Refunded') requireValue(args.to.toLowerCase()===parsed.args[1].toLowerCase(),'Refund destination mismatch.');
        if (event.name==='Collected') requireValue(args.recipient.toLowerCase()===p.recipient_wallet.toLowerCase() && args.amount===BigInt(p.contribution_wei)*BigInt(p.target) && args.to.toLowerCase()===(parsed.name==='collectTo'?parsed.args[1]:p.recipient_wallet).toLowerCase(),'Payout terms mismatch.');
        records.push({...base,actor:event.name==='Collected'?p.recipient_wallet:tx.from,log_index:log.index,kind:labels[parsed.name],
          amount_wei:event.name==='Joined'||event.name==='Refunded'||event.name==='Collected'?args.amount.toString():'0',status:'confirmed'});
      }
      requireValue(records.length===1,'Expected escrow event is missing.');
    }
    const snapshot=p.chain_plan_id!==null?await readEscrow(p,null,this.provider,this.config):null;
    await this.admin('record',{token:p.token,chain_id:10143,escrow_address:this.config.contractAddress,chain_plan_id:p.chain_plan_id,chain_create_tx:p.chain_create_tx,
      receipts:records,...(snapshot?{state:businessState(snapshot),count:snapshot.count,block_number:snapshot.blockNumber}: {})});
    return {status:receipt.status===1?'confirmed':'failed',hash:receipt.hash,kind:labels[parsed.name]};
  }
  async recordEvents(p,receipt) {
    const block=await this.provider.getBlock(receipt.blockNumber);
    requireValue(receipt.status===1 && block?.hash===receipt.blockHash,'Invalid backfill receipt.');
    const records=[];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase()!==this.config.contractAddress.toLowerCase()) continue;
      let e; try { e=iface.parseLog(log); } catch { continue; }
      if (!e || !['PlanCreated','Joined','Cancelled','Collected','Refunded'].includes(e.name)) continue;
      if(e.name==='PlanCreated'){
        if(!creationMatches(p,e))continue;
        p={...p,chain_plan_id:e.args.id.toString(),chain_create_tx:receipt.hash};
      }
      if (e.args.id.toString()!==p.chain_plan_id) continue;
      const amount=['Joined','Refunded'].includes(e.name)?BigInt(p.contribution_wei):e.name==='Collected'?BigInt(p.contribution_wei)*BigInt(p.target):0n;
      if (amount) requireValue(e.args.amount===amount,'Backfill event amount mismatch.');
      if (e.name==='Collected') requireValue(e.args.recipient.toLowerCase()===p.recipient_wallet.toLowerCase(),'Backfill recipient mismatch.');
      records.push({tx_hash:receipt.hash,log_index:log.index,kind:e.name==='PlanCreated'?'Created':e.name,
        actor:e.args.participant || e.args.recipient || p.organizer_wallet,amount_wei:amount.toString(),status:'confirmed',
        block_number:receipt.blockNumber,block_hash:receipt.blockHash,occurred_at:new Date(block.timestamp*1000).toISOString()});
    }
    const snapshot=await readEscrow(p,null,this.provider,this.config);
    await this.admin('record',{token:p.token,chain_id:10143,escrow_address:this.config.contractAddress,chain_plan_id:p.chain_plan_id,chain_create_tx:p.chain_create_tx,
      receipts:records,state:businessState(snapshot),count:snapshot.count,block_number:snapshot.blockNumber});
  }
  async refresh(token,user) {
    const p=await this.plan(token,user);
    if (!p.chain_verified && !p.is_owner) throw new HttpError(404,'This invitation has not been published.');
    await this.checkCursor();
    if (!p.chain_plan_id) {
      if (!p.metadata_hash && p.is_owner) await this.admin('commitment',{user_id:user.id,token:p.token,metadata_hash:detailsHash(p)});
      await verifyProvider(this.provider,this.config);
      const contract=new Contract(this.config.contractAddress,ESCROW_ABI,this.provider),hash=detailsHash(p);
      const block=await this.provider.getBlock('finalized');
      if (await contract.metadataUsed(p.organizer_wallet,hash,{blockTag:block.number})) {
        const id=await contract.metadataPlanId(p.organizer_wallet,hash,{blockTag:block.number}),created=await contract.createdBlock(id,{blockTag:block.number});
        const logs=await this.provider.getLogs({address:this.config.contractAddress,fromBlock:Number(created),toBlock:Number(created),topics:[iface.getEvent('PlanCreated').topicHash,zeroPadValue(toBeHex(id),32)]});
        const receipt=logs[0]?await finalizedReceipt(logs[0].transactionHash,this.provider):null;
        if (!receipt) throw new HttpError(503,'Escrow creation is awaiting confirmation. Check its receipt before retrying.');
        await this.recordEvents(p,receipt);
        return {status:'recovered'};
      }
      return {status:'draft'};
    }
    const snapshot=await readEscrow(p,null,this.provider,this.config);
    await this.admin('record',{token:p.token,chain_id:10143,escrow_address:this.config.contractAddress,chain_plan_id:p.chain_plan_id,chain_create_tx:p.chain_create_tx,
      receipts:[],state:businessState(snapshot),count:snapshot.count,block_number:snapshot.blockNumber});
    return {status:'synchronized'};
  }
  async checkCursor() {
    const cursor=await this.admin('cursor',{escrow_address:this.config.contractAddress,start_block:this.config.deploymentBlock});
    if (cursor.halted) throw new HttpError(503,'Receipt synchronization is paused pending a chain consistency review.');
    if (cursor.block_hash && (await this.provider.getBlock(Number(cursor.block_number)))?.hash!==cursor.block_hash) {
      await this.admin('halt',{escrow_address:this.config.contractAddress});
      throw new HttpError(503,'Chain checkpoint changed. Receipt synchronization has been paused.');
    }
    return cursor;
  }
  async reconcile({pages=4}={}) {
    await verifyProvider(this.provider,this.config);
    let cursor=await this.checkCursor(), processed=0;
    const finalized=await this.provider.getBlock('finalized');
    for (let page=0;page<pages && Number(cursor.block_number)<finalized.number;page++) {
      const from=Number(cursor.block_number)+1,to=Math.min(from+999,finalized.number);
      const logs=await this.provider.getLogs({address:this.config.contractAddress,fromBlock:from,toBlock:to});
      const hashes=[...new Set(logs.map(log=>log.transactionHash))];
      for (const hash of hashes) {
        const receipt=await finalizedReceipt(hash,this.provider);
        if (!receipt) throw new HttpError(503,'Backfill receipt is not finalized.');
        const affected=new Map();
        for (const log of receipt.logs) {
          if (log.address.toLowerCase()!==this.config.contractAddress.toLowerCase()) continue;
          let event; try { event=iface.parseLog(log); } catch { continue; }
          if (!event) continue;
          const p=await this.admin('plan',event.name==='PlanCreated'?{metadata_hash:event.args.detailsHash}:
            {escrow_address:this.config.contractAddress,chain_plan_id:event.args.id.toString()});
          if (p?.token && (event.name!=='PlanCreated'||creationMatches(p,event))) affected.set(p.token,p);
        }
        for (const p of affected.values()) { await this.recordEvents(p,receipt); processed++; }
      }
      const end=await this.provider.getBlock(to);
      await this.admin('advance',{escrow_address:this.config.contractAddress,expected_block:Number(cursor.block_number),block_number:to,block_hash:end.hash});
      cursor=await this.checkCursor();
    }
    return {processed,checkpoint:Number(cursor.block_number),finalized:finalized.number,lag_blocks:finalized.number-Number(cursor.block_number)};
  }
}
export const businessState = c => ['open','funded',c.cancelled?'cancelled':'failed','paid'][c.state];

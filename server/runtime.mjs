import { createClient } from '@supabase/supabase-js';
import { JsonRpcProvider, FetchRequest, keccak256 } from 'ethers';
import { readFileSync } from 'node:fs';
import { ReleaseService, HttpError } from './release.mjs';

const project='ednddqfwazggfsdaklwp';
let runtime;
export function getRuntime() {
  if (runtime) return runtime;
  const url=process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key=process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secret=process.env.SUPABASE_SERVICE_ROLE_KEY, origin=process.env.APP_ORIGIN;
  const address=process.env.MONAD_TESTNET_ESCROW_ADDRESS;
  const block=Number(process.env.MONAD_TESTNET_DEPLOYMENT_BLOCK);
  if (url!==`https://${project}.supabase.co` || !key || !secret || !origin || !address || !Number.isSafeInteger(block) || block<0 || process.env.MONAD_TESTNET_DEPLOYMENT_BLOCK===undefined) {
    throw new HttpError(503,'CountMeIn testnet service requires deployment configuration.');
  }
  const site=new URL(origin);
  if (site.origin!==origin || (site.protocol!=='https:' && !['127.0.0.1','localhost'].includes(site.hostname))) throw new HttpError(503,'Application origin is not configured correctly.');
  const rpc=process.env.MONAD_TESTNET_RPC_URL || 'https://testnet-rpc.monad.xyz';
  if (new URL(rpc).protocol!=='https:') throw new HttpError(503,'Testnet RPC must use HTTPS.');
  const artifact=JSON.parse(readFileSync(new URL('../artifacts/CountMeIn.json',import.meta.url),'utf8'));
  const config={chainId:10143,contractAddress:address,runtimeHash:keccak256(artifact.runtime),deploymentBlock:block};
  const request=new FetchRequest(rpc); request.timeout=12000;
  const provider=new JsonRpcProvider(request,undefined,{batchMaxCount:1,cacheTimeout:-1});
  const options={auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init={})=>fetch(input,{...init,signal:AbortSignal.timeout(12000)})}};
  const db=createClient(url,secret,options), auth=createClient(url,key,options);
  const admin=async(action,input)=>{
    const {data,error}=await db.rpc('release_admin',{p_action:action,p_input:input});
    if (error) {
      if (error.code==='P0002') throw new HttpError(429,'Wait a few seconds before requesting another wallet challenge.');
      if (action==='challenge_consume') throw new HttpError(409,'Wallet challenge was consumed or this wallet belongs to another account.');
      throw new HttpError(503,'Database synchronization failed. Your onchain transaction can still be recovered.');
    }
    return data;
  };
  runtime={service:new ReleaseService({admin,provider,config,origin}),auth,origin};
  return runtime;
}
export async function authenticated(req,runtime,optional=false) {
  const header=req.headers.authorization || '';
  if (optional && !header) return null;
  if (!/^Bearer [^\s]+$/.test(header)) throw new HttpError(401,'Your session expired. Sign in again.');
  const {data,error}=await runtime.auth.auth.getUser(header.slice(7));
  if (error || !data.user) throw new HttpError(401,'Your session expired. Sign in again.');
  return data.user;
}
export async function readBody(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415,'Use a JSON request.');
  if (Number(req.headers['content-length'])>12000) throw new HttpError(413,'Request is too large.');
  if (req.body) {
    let value;try {value=typeof req.body==='string'?JSON.parse(req.body):req.body;}catch {throw new HttpError(400,'Invalid JSON request.');}
    if (JSON.stringify(value).length>12000) throw new HttpError(413,'Request is too large.');
    return value;
  }
  let body=''; for await (const chunk of req) { body+=chunk; if (body.length>12000) throw new HttpError(413,'Request is too large.'); }
  try { return JSON.parse(body); } catch { throw new HttpError(400,'Invalid JSON request.'); }
}
export function reply(res,status,data) {
  res.setHeader('Content-Type','application/json'); res.setHeader('Cache-Control','no-store');
  res.statusCode=status; res.end(JSON.stringify(data));
}
export function failure(res,error) {
  reply(res,error instanceof HttpError?error.status:503,{error:error instanceof HttpError?error.message:'Verification is unavailable. Retry; no payment has been marked successful.'});
}

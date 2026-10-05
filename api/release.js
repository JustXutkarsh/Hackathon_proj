import { getRuntime,authenticated,readBody,reply,failure } from '../server/runtime.mjs';
import { HttpError } from '../server/release.mjs';

export default async function handler(req,res) {
  try {return await handle(req,res,getRuntime());}catch(error){failure(res,error);}
}
export async function handle(req,res,runtime) {
  try {
    if (req.method==='GET') {
      await runtime.service.verifyDeployment();await runtime.service.checkCursor();
      return reply(res,200,{network:'Monad testnet',chain_id:10143,configured:true,contract_address:runtime.service.config.contractAddress,origin:runtime.origin});
    }
    if (req.method!=='POST') throw new HttpError(405,'Method not allowed.');
    if (req.headers.origin!==runtime.origin) throw new HttpError(403,'Request origin is not allowed.');
    const body=await readBody(req);
    if (!body || typeof body!=='object' || Array.isArray(body)) throw new HttpError(400,'Invalid request.');
    const methods={challenge:'challenge',verify_wallet:'verifyWallet',draft:'draft',receipt:'receipt',replacement:'replacement',refresh:'refresh'};
    const method=Object.hasOwn(methods,body.action)?methods[body.action]:null;
    if (!method) throw new HttpError(400,'Unknown operation.');
    const user=await authenticated(req,runtime,method==='refresh');
    await runtime.rateLimit?.(req,user);
    const result=method==='refresh'?await runtime.service.refresh(body.token,user):await runtime.service[method](user,body);
    reply(res,200,result);
  } catch(error) { failure(res,error); }
}

import { timingSafeEqual } from 'node:crypto';
import { getRuntime,reply,failure } from '../server/runtime.mjs';
import { HttpError } from '../server/release.mjs';

export default async function handler(req,res) {
  try {
    if (req.method!=='GET') throw new HttpError(405,'Method not allowed.');
    const secret=process.env.CRON_SECRET, actual=Buffer.from(req.headers.authorization || ''),expected=Buffer.from(`Bearer ${secret || ''}`);
    if (!secret || secret.length<32 || actual.length!==expected.length || !timingSafeEqual(actual,expected)) throw new HttpError(401,'Scheduler authentication failed.');
    reply(res,200,await getRuntime().service.reconcile());
  } catch(error) { failure(res,error); }
}

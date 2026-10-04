import { build } from 'esbuild';
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '';
if (Boolean(url) !== Boolean(key)) throw Error('Set both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.');
if (url && !/^https:\/\/[^/]+\/?$/.test(url)) throw Error('SUPABASE_URL must be an HTTPS project origin.');
if (key && !key.startsWith('sb_publishable_')) {
  let role;
  try { role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role; } catch {}
  if (role !== 'anon') throw Error('Use a publishable key or legacy anon key, never a secret/service-role key.');
}
await build({entryPoints:['dist/shared.js'], bundle:true, format:'esm', outfile:'dist/shared.bundle.js',
  define:{__SUPABASE_URL__:JSON.stringify(url), __SUPABASE_KEY__:JSON.stringify(key)}});
console.log(url ? 'Shared app configured with public Supabase settings.' : 'Shared app built without credentials; local demo remains available.');

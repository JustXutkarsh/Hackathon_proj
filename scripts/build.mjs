import { build } from 'esbuild';
import { keccak256, isAddress, ZeroAddress } from 'ethers';
import { compileContract } from './compile-contract.mjs';
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '';
const monadRpc = process.env.MONAD_TESTNET_RPC_URL || 'https://testnet-rpc.monad.xyz';
const monadExplorer = process.env.MONAD_TESTNET_EXPLORER_URL || 'https://testnet.monadscan.com';
const escrowAddress = process.env.MONAD_TESTNET_ESCROW_ADDRESS || '';
if (Boolean(url) !== Boolean(key)) throw Error('Set both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.');
if (url && !/^https:\/\/[^/]+\/?$/.test(url)) throw Error('SUPABASE_URL must be an HTTPS project origin.');
if (key && !key.startsWith('sb_publishable_')) {
  let role;
  try { role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role; } catch {}
  if (role !== 'anon') throw Error('Use a publishable key or legacy anon key, never a secret/service-role key.');
}
if (escrowAddress && (!isAddress(escrowAddress) || escrowAddress === ZeroAddress)) throw Error('MONAD_TESTNET_ESCROW_ADDRESS must be a contract address.');
for (const value of [monadRpc, monadExplorer]) if (new URL(value).protocol !== 'https:') throw Error('Monad URLs must use HTTPS.');
await build({entryPoints:['dist/shared.js'], bundle:true, format:'esm', outfile:'dist/shared.bundle.js',
  define:{__SUPABASE_URL__:JSON.stringify(url), __SUPABASE_KEY__:JSON.stringify(key),
    __MONAD_RPC_URL__:JSON.stringify(monadRpc), __MONAD_EXPLORER_URL__:JSON.stringify(monadExplorer),
    __MONAD_ESCROW_ADDRESS__:JSON.stringify(escrowAddress),
    __MONAD_RUNTIME_HASH__:JSON.stringify(keccak256(compileContract().runtime))}});
console.log(url ? 'Shared app configured with public Supabase settings.' : 'Shared app built without credentials; local demo remains available.');
console.log(escrowAddress ? `Monad escrow configured at ${escrowAddress}.` : 'Monad payment UI built; contract deployment is still required.');

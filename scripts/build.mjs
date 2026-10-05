import { build } from 'esbuild';
import { keccak256, isAddress, ZeroAddress } from 'ethers';
import { compileContract } from './compile-contract.mjs';
import { mkdir,copyFile,writeFile,readFile } from 'node:fs/promises';
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '';
const monadRpc = process.env.MONAD_TESTNET_RPC_URL || 'https://testnet-rpc.monad.xyz';
const monadExplorer = process.env.MONAD_TESTNET_EXPLORER_URL || 'https://testnet.monadscan.com';
const escrowAddress = process.env.MONAD_TESTNET_ESCROW_ADDRESS || '';
const outputDirectory=process.env.BUILD_DIRECTORY || 'build';
if (Boolean(url) !== Boolean(key)) throw Error('Set both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.');
if (url && !/^https:\/\/[^/]+\/?$/.test(url)) throw Error('SUPABASE_URL must be an HTTPS project origin.');
if (key && !key.startsWith('sb_publishable_')) {
  let role;
  try { role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role; } catch {}
  if (role !== 'anon') throw Error('Use a publishable key or legacy anon key, never a secret/service-role key.');
}
if (escrowAddress && (!isAddress(escrowAddress) || escrowAddress === ZeroAddress)) throw Error('MONAD_TESTNET_ESCROW_ADDRESS must be a contract address.');
for (const value of [monadRpc, monadExplorer]) if (new URL(value).protocol !== 'https:') throw Error('Monad URLs must use HTTPS.');
const artifact=compileContract(),record=JSON.parse(await readFile(new URL('../artifacts/CountMeIn.json',import.meta.url),'utf8'));
if(record.runtime!==artifact.runtime||record.bytecode!==artifact.bytecode)throw Error('Contract artifact is stale. Run npm run artifact and review its diff.');
await mkdir(outputDirectory,{recursive:true});
await build({entryPoints:['dist/release.js'], bundle:true, format:'esm', outfile:`${outputDirectory}/release.bundle.js`,
  define:{__SUPABASE_URL__:JSON.stringify(url), __SUPABASE_KEY__:JSON.stringify(key),
    __MONAD_RPC_URL__:JSON.stringify(monadRpc), __MONAD_EXPLORER_URL__:JSON.stringify(monadExplorer),
    __MONAD_ESCROW_ADDRESS__:JSON.stringify(escrowAddress),
    __MONAD_RUNTIME_HASH__:JSON.stringify(keccak256(artifact.runtime))}});
for(const name of ['styles.css','shared.css'])await copyFile(`dist/${name}`,`${outputDirectory}/${name}`);
await copyFile('dist/release.html',`${outputDirectory}/index.html`);
await writeFile(`${outputDirectory}/entry.js`,"import './release.bundle.js';\n");
console.log(url ? 'CountMeIn configured with public Supabase settings.' : 'CountMeIn built; authentication configuration is required.');
console.log(escrowAddress ? `Monad escrow configured at ${escrowAddress}.` : 'Monad payment UI built; contract deployment is still required.');

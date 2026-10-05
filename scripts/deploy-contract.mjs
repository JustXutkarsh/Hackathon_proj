import { mkdir, writeFile, access } from 'node:fs/promises';
import { ethers } from 'ethers';
import solc from 'solc';
import { compileContract } from './compile-contract.mjs';

const rpcUrl = process.env.MONAD_TESTNET_RPC_URL || 'https://testnet-rpc.monad.xyz';
const privateKey = process.env.MONAD_DEPLOYER_PRIVATE_KEY;
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw Error('Set MONAD_DEPLOYER_PRIVATE_KEY privately to a funded Monad Testnet account.');
const recordPath = new URL('../deployments/monad-testnet.json',import.meta.url);
try { await access(recordPath); throw Error('Deployment record already exists. Inspect its transaction before deploying again.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const artifact = compileContract();
const provider = new ethers.JsonRpcProvider(rpcUrl,undefined,{batchMaxCount:1,cacheTimeout:-1});
if (BigInt(await provider.send('eth_chainId',[])) !== 10143n) throw Error('RPC is not Monad Testnet (chain 10143).');
const wallet = new ethers.Wallet(privateKey,provider);
const balance = await provider.getBalance(wallet.address);
if (balance === 0n) throw Error(`Deployer ${wallet.address} has no testnet MON. Use https://faucet.monad.xyz first.`);
console.log(`Deploying from ${wallet.address} with ${ethers.formatEther(balance)} MON...`);
const contract = await new ethers.ContractFactory(artifact.abi,artifact.bytecode,wallet).deploy();
const deploymentTx = contract.deploymentTransaction();
console.log(`Submitted ${deploymentTx.hash}`);
await mkdir(new URL('../deployments/',import.meta.url),{recursive:true});
await writeFile(recordPath,JSON.stringify({status:'submitted',address:await contract.getAddress(),transactionHash:deploymentTx.hash},null,2)+'\n');
const receipt = await deploymentTx.wait(3,120000);
if (receipt.status !== 1) throw Error('Deployment transaction failed.');
if (await provider.getCode(await contract.getAddress()) !== artifact.runtime) throw Error('Deployed runtime mismatch.');
const record = {network:'Monad Testnet',chainId:10143,address:await contract.getAddress(),transactionHash:deploymentTx.hash,
  blockNumber:receipt.blockNumber,deployer:wallet.address,compiler:solc.version(),deployedAt:new Date().toISOString()};
await writeFile(recordPath,JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify(record,null,2));
console.log(`Set MONAD_TESTNET_ESCROW_ADDRESS=${record.address} locally and in Vercel.`);
provider.destroy();

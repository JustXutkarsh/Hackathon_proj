import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { ethers } from 'ethers';
import solc from 'solc';
import { compileContract } from './compile-contract.mjs';

const rpcUrl = process.env.MONAD_TESTNET_RPC_URL || 'https://testnet-rpc.monad.xyz';
const privateKey = process.env.MONAD_DEPLOYER_PRIVATE_KEY;
const recordPath = new URL('../deployments/monad-testnet.json',import.meta.url);
let record;
try {record=JSON.parse(await readFile(recordPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const resume=process.argv.includes('--resume');
if(record&&!resume)throw Error('Deployment record exists. Use --resume to verify that transaction; never deploy again blindly.');
if(resume&&!record)throw Error('No recorded deployment to resume.');
if(new URL(rpcUrl).protocol!=='https:')throw Error('Use an HTTPS Monad testnet RPC.');
const artifact = compileContract();
const provider = new ethers.JsonRpcProvider(rpcUrl,undefined,{batchMaxCount:1,cacheTimeout:-1});
try {
if (BigInt(await provider.send('eth_chainId',[])) !== 10143n) throw Error('RPC is not Monad Testnet (chain 10143).');
if(!record){
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw Error('Set MONAD_DEPLOYER_PRIVATE_KEY privately to a funded dedicated testnet wallet. Never paste it into chat.');
const wallet = new ethers.Wallet(privateKey,provider);
const balance = await provider.getBalance(wallet.address);
if (balance === 0n) throw Error(`Deployer ${wallet.address} has no testnet MON. Use https://faucet.monad.xyz first.`);
console.log(`Deploying from ${wallet.address} with ${ethers.formatEther(balance)} MON...`);
const contract = await new ethers.ContractFactory(artifact.abi,artifact.bytecode,wallet).deploy();
const deploymentTx = contract.deploymentTransaction();
console.log(`Submitted ${deploymentTx.hash}`);
await mkdir(new URL('../deployments/',import.meta.url),{recursive:true});
record={status:'submitted',network:'Monad Testnet',chainId:10143,address:await contract.getAddress(),transactionHash:deploymentTx.hash,deployer:wallet.address,
  compiler:solc.version(),settings:artifact.input.settings,runtimeHash:ethers.keccak256(artifact.runtime),abi:artifact.abi};
await writeFile(recordPath,JSON.stringify(record,null,2)+'\n');
}
if(record.chainId!==10143||record.runtimeHash!==ethers.keccak256(artifact.runtime))throw Error('Recorded deployment does not match this source build.');
const receipt=await provider.waitForTransaction(record.transactionHash,1,120000);
if (receipt.status !== 1) throw Error('Deployment transaction failed.');
for(let i=0;;i++){
  const finalized=await provider.getBlock('finalized');
  if(finalized&&finalized.number>=receipt.blockNumber)break;
  if(i>=60)throw Error('Deployment is not finalized yet. Resume later.');
  await new Promise(resolve=>setTimeout(resolve,2000));
}
if((await provider.getBlock(receipt.blockNumber))?.hash!==receipt.blockHash||receipt.contractAddress?.toLowerCase()!==record.address.toLowerCase())throw Error('Deployment receipt is not canonical or has another address.');
if (await provider.getCode(record.address) !== artifact.runtime) throw Error('Deployed runtime mismatch.');
Object.assign(record,{status:'confirmed',blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,deployedAt:new Date().toISOString(),sourceVerified:false});
await writeFile(recordPath,JSON.stringify(record,null,2)+'\n');
console.log(`Finalized ${record.transactionHash} at block ${record.blockNumber}. Source verification is still required.`);
console.log(`Set MONAD_TESTNET_ESCROW_ADDRESS=${record.address} locally and in Vercel.`);
console.log(`Set MONAD_TESTNET_DEPLOYMENT_BLOCK=${record.blockNumber}. Upload artifacts/CountMeIn.json input as Solidity Standard JSON to the testnet explorer.`);
}finally{provider.destroy();}

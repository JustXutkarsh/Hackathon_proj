import { BrowserProvider, Contract, Interface, JsonRpcProvider, FetchRequest, getAddress, isAddress, ZeroAddress, keccak256, parseEther, toUtf8Bytes, formatEther } from 'ethers';

export const MONAD_TESTNET = {
  chainId:10143, chainIdHex:'0x279f', name:'Monad Testnet',
  rpcUrl:typeof __MONAD_RPC_URL__ === 'undefined' ? '' : __MONAD_RPC_URL__,
  explorerUrl:typeof __MONAD_EXPLORER_URL__ === 'undefined' ? '' : __MONAD_EXPLORER_URL__,
  contractAddress:typeof __MONAD_ESCROW_ADDRESS__ === 'undefined' ? '' : __MONAD_ESCROW_ADDRESS__,
  runtimeHash:typeof __MONAD_RUNTIME_HASH__ === 'undefined' ? '' : __MONAD_RUNTIME_HASH__,
};
export const ESCROW_ABI = [
  'function plans(uint256) view returns (address organizer,address recipient,uint96 price,uint64 deadline,uint64 eventAt,uint16 target,uint16 joined,uint8 state,bytes32 detailsHash)',
  'function stateOf(uint256) view returns (uint8)',
  'function hasJoined(uint256,address) view returns (bool)',
  'function deposits(uint256,address) view returns (uint256)',
  'function cancelled(uint256) view returns (bool)',
  'function metadataUsed(address,bytes32) view returns (bool)', 'function metadataPlanId(address,bytes32) view returns (uint256)',
  'function createdBlock(uint256) view returns (uint256)',
  'function createPlan(address,uint96,uint16,uint64,uint64,bytes32) returns (uint256)',
  'function join(uint256) payable', 'function cancel(uint256)',
  'function claimRefund(uint256,address)', 'function collect(uint256)', 'function collectTo(uint256,address)',
  'event PlanCreated(uint256 indexed id,address indexed organizer,address indexed recipient,uint96 price,uint16 target,uint64 deadline,uint64 eventAt,bytes32 detailsHash)',
  'event Joined(uint256 indexed id,address indexed participant,uint256 amount)',
  'event Funded(uint256 indexed id)', 'event Cancelled(uint256 indexed id)',
  'event Refunded(uint256 indexed id,address indexed participant,address indexed to,uint256 amount)',
  'event Collected(uint256 indexed id,address indexed recipient,address indexed to,uint256 amount)',
];
const iface = new Interface(ESCROW_ABI);
const invalid=message=>Object.assign(Error(message),{safe:true});
const seconds = value => BigInt(new Date(value).getTime()/1000);
export const checksum = getAddress;
export const validWallet = value => isAddress(value) && value.toLowerCase() !== ZeroAddress;
export function parseMon(value) {
  if (!/^\d+(\.\d{1,18})?$/.test(String(value))) throw Error('Enter test MON with at most 18 decimal places.');
  const amount = parseEther(String(value));
  if (amount <= 0n || amount >= 2n**96n) throw Error('Test MON contribution is outside the supported range.');
  return amount;
}
export const formatMon = value => formatEther(BigInt(value));
export const explorerTx = hash => `${MONAD_TESTNET.explorerUrl}/tx/${hash}`;
export const detailsHash = p => keccak256(toUtf8Bytes(JSON.stringify([
  'CountMeIn/monad-testnet/v2',String(p.chain_id || 10143),p.token,p.title,p.activity,p.location,
  checksum(p.escrow_address),checksum(p.organizer_wallet),checksum(p.recipient_wallet),
  String(p.contribution_wei),p.target,seconds(p.deadline).toString(),seconds(p.event_at).toString(),
])));

let reader;
export function readProvider() {
  if (!reader) {
    const request = new FetchRequest(MONAD_TESTNET.rpcUrl); request.timeout = 15000;
    reader = new JsonRpcProvider(request, undefined, {batchMaxCount:1,cacheTimeout:-1});
  }
  return reader;
}
export async function verifyProvider(provider, config = MONAD_TESTNET) {
  if (!config.contractAddress) throw invalid('Monad escrow is not deployed yet.');
  if (BigInt(await provider.send('eth_chainId',[])) !== BigInt(config.chainId)) throw invalid('Wrong network. Use Monad Testnet.');
  if (keccak256(await provider.getCode(config.contractAddress)) !== config.runtimeHash) throw invalid('Escrow bytecode does not match this app. Transactions are disabled.');
}
export function assertChainTerms(p, c) {
  if (checksum(c.organizer) !== checksum(p.organizer_wallet) || checksum(c.recipient) !== checksum(p.recipient_wallet) ||
      c.price !== BigInt(p.contribution_wei) || c.target !== BigInt(p.target) ||
      c.deadline !== seconds(p.deadline) || c.eventAt !== seconds(p.event_at) || c.detailsHash !== detailsHash(p)) {
    throw Error('Escrow terms do not match this invitation. Transactions are disabled.');
  }
}
export function parseCreated(receipt, address) {
  if (receipt.status !== 1 || !receipt.to || checksum(receipt.to) !== checksum(address)) throw Error('Escrow creation was not successful.');
  for (const log of receipt.logs || []) {
    if (checksum(log.address) !== checksum(address)) continue;
    try {
      const event = iface.parseLog(log);
      if (event?.name === 'PlanCreated') return event.args.id.toString();
    } catch {}
  }
  throw Error('No CountMeIn creation event in this receipt.');
}
export async function finalizedReceipt(hash, provider = readProvider()) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw Error('Enter a valid transaction hash.');
  const receipt = await provider.getTransactionReceipt(hash);
  if (!receipt) return null;
  const block = await provider.getBlock('finalized');
  if (!block || receipt.blockNumber > block.number) return null;
  if ((await provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash) return null;
  return receipt;
}
export function transactionFor(p, action, address) {
  const args = action === 'create' ? [p.recipient_wallet,BigInt(p.contribution_wei),p.target,seconds(p.deadline),seconds(p.event_at),detailsHash(p)] :
    action === 'refund' ? [p.chain_plan_id,address] : [p.chain_plan_id];
  const method = {create:'createPlan',join:'join',cancel:'cancel',refund:'claimRefund',collect:'collect'}[action];
  if (!method) throw Error('Unknown escrow action.');
  return {to:p.escrow_address,data:iface.encodeFunctionData(method,args),value:action === 'join' ? BigInt(p.contribution_wei) : 0n};
}
export async function quoteTransaction(provider, request, address) {
  const estimatedGas = await provider.estimateGas({...request,from:address});
  // Monad bills the gas limit. Use its documented 7.5% starting margin, rounded up.
  const gasLimit = (estimatedGas*10750n+9999n)/10000n;
  const gasPrice = BigInt(await provider.send('eth_gasPrice',[]));
  if (estimatedGas <= 0n || gasPrice <= 0n) throw invalid('Network fee estimate is unavailable. Retry.');
  return {request:{...request,gasLimit},estimatedGas,gasPrice,cost:gasLimit*gasPrice};
}
export async function verifyTransaction(p, action, address, hash, provider = readProvider()) {
  const receipt = await finalizedReceipt(hash,provider);
  if (!receipt) return null;
  const tx = await provider.getTransaction(hash), expected = transactionFor(p,action,address);
  if (!tx || checksum(tx.from) !== checksum(address) || !tx.to || checksum(tx.to) !== checksum(expected.to) ||
      tx.data !== expected.data || tx.value !== expected.value) throw Error('Transaction does not match this action and wallet.');
  return receipt;
}
export async function readEscrow(p, walletAddress, provider = readProvider(), config = MONAD_TESTNET) {
  if (!config.contractAddress || checksum(p.escrow_address) !== checksum(config.contractAddress)) throw Error('This plan uses another escrow deployment. Transactions are disabled.');
  await verifyProvider(provider,config);
  const receipt = await verifyTransaction(p,'create',p.organizer_wallet,p.chain_create_tx,provider);
  if (!receipt || parseCreated(receipt,p.escrow_address) !== p.chain_plan_id) throw Error('Escrow creation is not finalized or does not match this invitation.');
  const block = await provider.getBlock('finalized');
  const contract = new Contract(p.escrow_address,ESCROW_ABI,provider), options = {blockTag:block.number};
  const terms = await contract.plans(p.chain_plan_id,options);
  assertChainTerms(p,terms);
  const state = Number(await contract.stateOf(p.chain_plan_id,options));
  const joined = walletAddress ? await contract.hasJoined(p.chain_plan_id,walletAddress,options) : false;
  const deposit = walletAddress ? await contract.deposits(p.chain_plan_id,walletAddress,options) : 0n;
  const cancelled = await contract.cancelled(p.chain_plan_id,options);
  if ((await provider.getBlock(block.number))?.hash !== block.hash) throw Error('Chain changed while reading. Refresh before transacting.');
  return {state,count:Number(terms.joined),joined,deposit,cancelled,blockNumber:block.number,blockHash:block.hash};
}
export async function walletEscrow() {
  if (!window.ethereum) throw invalid('Install a compatible wallet to use Monad Testnet.');
  if (BigInt(await window.ethereum.request({method:'eth_chainId'})) !== 10143n) {
    try { await window.ethereum.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x279f'}]}); }
    catch (error) {
      if (error.code !== 4902 && error.data?.originalError?.code !== 4902) throw error;
      await window.ethereum.request({method:'wallet_addEthereumChain',params:[{chainId:'0x279f',chainName:'Monad Testnet',
        nativeCurrency:{name:'Test MON',symbol:'MON',decimals:18},rpcUrls:[MONAD_TESTNET.rpcUrl],blockExplorerUrls:[MONAD_TESTNET.explorerUrl]}]});
      await window.ethereum.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x279f'}]});
    }
  }
  const provider = new BrowserProvider(window.ethereum,undefined,{cacheTimeout:-1});
  await verifyProvider(provider);
  const signer = await provider.getSigner();
  return {provider,signer,address:await signer.getAddress()};
}

import { getRuntime } from '../server/runtime.mjs';
const {service}=getRuntime();
try {
  if(process.argv.includes('--rebuild-reviewed')){
    await service.admin('rebuild_reviewed',{escrow_address:service.config.contractAddress,start_block:service.config.deploymentBlock,reason:process.env.CHAIN_REVIEW_REASON});
  }
  const rounds=process.argv.includes('--backfill')?100:1;
  for(let i=0;i<rounds;i++) {
    const result=await service.reconcile();console.log(JSON.stringify(result));
    if(!result.lag_blocks)break;
  }
} finally {service.provider.destroy();}

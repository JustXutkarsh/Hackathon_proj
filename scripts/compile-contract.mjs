import { readFileSync } from 'node:fs';
import solc from 'solc';

export function compileContract() {
  const source = readFileSync(new URL('../contracts/CountMeIn.sol', import.meta.url), 'utf8');
  const input={language:'Solidity',
    sources:{'CountMeIn.sol':{content:source}}, settings:{optimizer:{enabled:true,runs:200},
      evmVersion:'paris',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}};
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter(e => e.severity === 'error');
  if (errors.length) throw Error(errors.map(e => e.formattedMessage).join('\n'));
  const artifact = output.contracts['CountMeIn.sol'].CountMeIn;
  return {abi:artifact.abi, bytecode:'0x'+artifact.evm.bytecode.object, runtime:'0x'+artifact.evm.deployedBytecode.object,input};
}

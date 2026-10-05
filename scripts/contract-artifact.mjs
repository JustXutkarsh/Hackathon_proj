import { writeFile } from 'node:fs/promises';
import solc from 'solc';
import { compileContract } from './compile-contract.mjs';
const artifact=compileContract();
await writeFile(new URL('../artifacts/CountMeIn.json',import.meta.url),JSON.stringify({contractName:'CountMeIn',compiler:solc.version(),
  settings:{optimizer:{enabled:true,runs:200},evmVersion:'paris'},...artifact},null,2)+'\n');
console.log('Reproducible CountMeIn artifact generated.');

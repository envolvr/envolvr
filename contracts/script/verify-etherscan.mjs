// Verifies a deployed contract's source on Etherscan (robin.etherscan.io for
// Robinhood Chain). forge's own verify-contract does not know chain 4663 yet, so
// this takes forge's standard JSON input and submits it to Etherscan's API.
//
//   ETHERSCAN_KEY=… node script/verify-etherscan.mjs <address> <src/X.sol:X> [constructor args hex] [chain id]
//
// Constructor args come from `cast abi-encode 'c(address)' 0x…`. Chain id
// defaults to 4663 (Robinhood Chain mainnet). Run from contracts/.
import { execFileSync } from 'node:child_process';

const [address, contract, args = '0x', chainId = '4663'] = process.argv.slice(2);
const key = process.env.ETHERSCAN_KEY;
if (!address || !contract?.includes(':') || !key) {
  console.error('usage: ETHERSCAN_KEY=… node script/verify-etherscan.mjs <address> <src/X.sol:X> [args hex] [chain id]');
  process.exit(1);
}

const input = execFileSync('forge', ['verify-contract', address, contract, '--show-standard-json-input'], { encoding: 'utf8', maxBuffer: 64 << 20 });
const name = contract.split(':')[1];
const artifact = JSON.parse(execFileSync('forge', ['inspect', contract, 'metadata'], { encoding: 'utf8' }));
const api = `https://api.etherscan.io/v2/api?chainid=${chainId}`;

const submit = await (await fetch(api, {
  method: 'POST',
  body: new URLSearchParams({
    apikey: key,
    module: 'contract',
    action: 'verifysourcecode',
    contractaddress: address,
    sourceCode: input,
    codeformat: 'solidity-standard-json-input',
    contractname: contract,
    compilerversion: `v${artifact.compiler.version}`,
    constructorArguements: args.replace(/^0x/, ''),
    licenseType: '5', // Apache-2.0
  }),
})).json();
if (submit.status !== '1') {
  console.error(`${name}: ${submit.result}`);
  process.exit(1);
}

for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const check = await (await fetch(`${api}&${new URLSearchParams({ apikey: key, module: 'contract', action: 'checkverifystatus', guid: submit.result })}`)).json();
  if (!String(check.result).includes('Pending')) {
    console.log(`${name}: ${check.result}`);
    process.exit(check.status === '1' ? 0 : 1);
  }
}
console.error(`${name}: still pending after 150 s (guid ${submit.result})`);
process.exit(1);

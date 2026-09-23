// node src/cli.ts reference <repo> <revision>   root from hub metadata (publish this)
// node src/cli.ts local <dir>                    root from files on disk (boot step)
//
// Set HF_TOKEN for gated repositories. Prints the manifest as JSON.

import { manifestFromDirectory, manifestFromHub } from './manifest.ts';

const [command, ...args] = process.argv.slice(2);

if (command === 'reference' && args.length === 2) {
  console.log(JSON.stringify(await manifestFromHub(args[0], args[1], process.env.HF_TOKEN), null, 2));
} else if (command === 'local' && args.length === 1) {
  console.log(JSON.stringify(await manifestFromDirectory(args[0]), null, 2));
} else {
  console.error('usage: node src/cli.ts reference <repo> <revision> | local <dir>');
  process.exit(2);
}

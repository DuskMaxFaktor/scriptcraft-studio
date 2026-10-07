// A stand-in for the GitHub CLI in tests: "repo create --push" pushes into a local bare repository
// (FAKE_GH_REMOTES), so publishing is tested end to end without touching a real GitHub account.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const user = 'TestUser';

if (args[0] === '--version') {
  console.log('gh version 0.0.0-fake');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  if (process.env.FAKE_GH_LOGGED === '1') {
    console.log(`github.com\n  ✓ Logged in to github.com account ${user} (keyring)`);
    process.exit(0);
  }
  console.error('You are not logged into any GitHub hosts. To log in, run: gh auth login');
  process.exit(1);
}
if (args[0] === 'repo' && args[1] === 'create') {
  const name = args[2];
  const opt = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  const source = opt('--source');
  const remotes = process.env.FAKE_GH_REMOTES;
  const bare = path.join(remotes, `${name}.git`);
  if (fs.existsSync(bare)) {
    console.error(`GraphQL: Name already exists on this account (createRepository)`);
    process.exit(1);
  }
  execFileSync('git', ['init', '--bare', '-q', '--initial-branch=main', bare]);
  fs.writeFileSync(path.join(remotes, `${name}.json`), JSON.stringify({ visibility: args.includes('--public') ? 'public' : 'private', description: opt('--description') }));
  // Like the real one: the remote is the GitHub address; pushes go to the local bare repository
  const remote = opt('--remote') || 'origin';
  execFileSync('git', ['-C', source, 'remote', 'add', remote, `https://github.com/${user}/${name}.git`]);
  execFileSync('git', ['-C', source, 'config', `remote.${remote}.pushurl`, bare]);
  if (args.includes('--push')) execFileSync('git', ['-C', source, 'push', '-q', '-u', 'origin', 'HEAD'], { stdio: 'ignore' });
  console.log(`https://github.com/${user}/${name}`);
  process.exit(0);
}
console.error(`fake gh: unsupported command ${args.join(' ')}`);
process.exit(2);

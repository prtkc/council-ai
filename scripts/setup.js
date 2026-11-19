// Run through scripts/setup.sh. Installs, opens sign-in, and starts Council, with no questions.
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import path from 'node:path';
import { APP_ROOT, install, login, setUpPath, toolName, toolStatus } from '../src/setup.js';

setUpPath();
const asked = process.argv.slice(2).filter((a) => ['claude', 'chatgpt'].includes(a));
const wanted = asked.length ? asked : ['claude', 'chatgpt'];
const port = Number(process.env.COUNCIL_PORT || 4317);
const url = `http://127.0.0.1:${port}`;

let status = await toolStatus();
for (const p of wanted) {
  if (status[p].installed) { console.log(`✓ ${toolName(p)} tool is already installed.`); continue; }
  console.log(`Installing the ${toolName(p)} tool. This can take a few minutes…`);
  await install(p);
}
status = await toolStatus();

const needSignIn = [];
for (const p of wanted) {
  const s = status[p];
  if (!s.installed) console.log(`✗ ${toolName(p)} could not be installed: ${s.job.message || 'unknown error'}`);
  else if (s.signedIn) console.log(`✓ ${toolName(p)} is signed in.`);
  else {
    await login(p);
    needSignIn.push(toolName(p));
    console.log(`→ Opened a Terminal window to sign in to ${toolName(p)}.`);
  }
}

async function running() {
  try { return (await (await fetch(`${url}/api/health`)).json()).app === 'council'; } catch { return false; }
}
if (await running()) {
  console.log(`✓ Council is already running at ${url}`);
} else {
  const log = openSync(path.join(APP_ROOT, 'council.log'), 'a');
  spawn(process.execPath, [path.join(APP_ROOT, 'src/main.js')], { cwd: APP_ROOT, detached: true, stdio: ['ignore', log, log], env: process.env }).unref();
  for (let i = 0; i < 40 && !(await running()); i++) await new Promise((r) => setTimeout(r, 250));
  console.log(await running() ? `✓ Council is running at ${url}. It opens in Chrome, and keeps running after this window closes.` : `✗ Council did not start. See ${path.join(APP_ROOT, 'council.log')}.`);
}

if (needSignIn.length) {
  console.log(`\nNext: in the Terminal window${needSignIn.length > 1 ? 's' : ''} that opened, sign in to ${needSignIn.join(' and ')} and finish in the browser. Council's start page turns green when each one is ready.`);
}
const usable = wanted.filter((p) => status[p].installed);
process.exit(usable.length ? 0 : 1);

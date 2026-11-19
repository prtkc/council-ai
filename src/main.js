#!/usr/bin/env node
// Starts Council on this machine only and opens it in a Chrome app window.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Council } from './council.js';
import { Playgrounds } from './playground.js';
import { createServer } from './server.js';
import { setUpPath } from './setup.js';

setUpPath();
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_PORT = Number(process.env.COUNCIL_PORT || 4317);
const noOpen = process.argv.includes('--no-open') || Boolean(process.env.COUNCIL_NO_OPEN);

function openWindow(url) {
  if (noOpen) return;
  execFile('open', ['-na', 'Google Chrome', '--args', `--app=${url}`], (err) => {
    if (err) execFile('open', [url]);
  });
}

async function isCouncil(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`);
    return (await r.json()).app === 'council';
  } catch { return false; }
}

const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
});

const council = new Council({ root: process.env.COUNCIL_RUNS_DIR || path.join(ROOT, 'runs') });
await council.load();
const playgrounds = new Playgrounds({ root: process.env.COUNCIL_PLAYGROUNDS_DIR || path.join(ROOT, 'playgrounds') });
await playgrounds.load();
const server = createServer(council, playgrounds);

let port = BASE_PORT;
for (;;) {
  try {
    await listen(server, port);
    break;
  } catch (e) {
    if (e.code !== 'EADDRINUSE' || port > BASE_PORT + 10) throw e;
    if (await isCouncil(port)) {
      console.log(`Council is already running at http://127.0.0.1:${port}`);
      openWindow(`http://127.0.0.1:${port}`);
      process.exit(0);
    }
    port += 1;
  }
}

const url = `http://127.0.0.1:${port}`;
console.log(`Council is running at ${url}\nKeep this window open. Press Ctrl+C to quit.`);
openWindow(url);

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    await Promise.all([council.shutdown(), playgrounds.shutdown()]);
    process.exit(0);
  });
}

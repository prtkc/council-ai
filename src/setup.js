// First-run setup: finds, installs, and signs in to the two command-line tools.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cleanEnv } from './providers.js';

const exec = promisify(execFile);
export const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const toolsDir = () => process.env.COUNCIL_TOOLS_DIR || path.join(APP_ROOT, '.tools');

const TOOLS = {
  claude: { pkg: '@anthropic-ai/claude-code', bin: () => process.env.COUNCIL_CLAUDE_BIN || 'claude', login: 'claude auth login --claudeai' },
  chatgpt: { pkg: '@openai/codex', bin: () => process.env.COUNCIL_CODEX_BIN || 'codex', login: 'codex login' },
};

const jobs = { claude: { state: 'idle', message: '' }, chatgpt: { state: 'idle', message: '' } };
let queue = Promise.resolve();

// Tools already on this Mac win. Tools Council installs are the fallback.
export function setUpPath(env = process.env, home = env.HOME || '') {
  const parts = [
    path.dirname(process.execPath), ...(env.PATH || '').split(':'),
    path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(toolsDir(), 'node_modules/.bin'),
  ];
  env.PATH = [...new Set(parts.filter(Boolean))].join(':');
}

export const parseClaudeStatus = (text) => {
  const d = JSON.parse(text);
  return { installed: true, signedIn: Boolean(d.loggedIn) && d.authMethod === 'claude.ai', plan: d.subscriptionType || null };
};
export const parseCodexStatus = (text) => ({ installed: true, signedIn: /logged in using chatgpt/i.test(text), plan: null });

export async function toolStatus() {
  const check = async (bin, args, read) => {
    try {
      const { stdout, stderr } = await exec(bin, args, { env: cleanEnv(), timeout: 10000 });
      return read(stdout.trim() ? stdout : stderr); // Codex prints its login status to stderr.
    } catch (e) {
      return { installed: e.code !== 'ENOENT', signedIn: false, plan: null };
    }
  };
  const [claude, chatgpt] = await Promise.all([
    check(TOOLS.claude.bin(), ['auth', 'status'], parseClaudeStatus),
    check(TOOLS.chatgpt.bin(), ['login', 'status'], parseCodexStatus),
  ]);
  return { claude: { ...claude, job: jobs.claude }, chatgpt: { ...chatgpt, job: jobs.chatgpt } };
}

function runInstall(tool, job) {
  return new Promise((resolve) => {
    let log = '';
    const child = spawn('npm', ['install', '--prefix', toolsDir(), '--no-audit', '--no-fund', '--loglevel=error', tool.pkg], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const add = (b) => { log = (log + b).slice(-1500); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('error', (e) => { Object.assign(job, { state: 'failed', message: e.message }); resolve(); });
    child.on('close', (code) => {
      if (job.state === 'failed') return resolve();
      Object.assign(job, code === 0 ? { state: 'done', message: '' } : { state: 'failed', message: log.trim().slice(-500) || `npm exited with code ${code}.` });
      resolve();
    });
  });
}

export async function install(provider) {
  const tool = TOOLS[provider];
  if (!tool) throw new Error('Unknown tool.');
  const job = jobs[provider];
  if (job.state === 'running') return;
  Object.assign(job, { state: 'running', message: '' });
  await fs.mkdir(toolsDir(), { recursive: true });
  queue = queue.then(() => runInstall(tool, job)); // npm cannot run twice in one folder.
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function loginScript(provider, pathValue = process.env.PATH) {
  const tool = TOOLS[provider];
  if (!tool) throw new Error('Unknown tool.');
  return `#!/bin/zsh -l
export PATH=${shellQuote(pathValue)}
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY CODEX_API_KEY
clear
echo "Signing in for Council. Follow the steps in your browser."
echo
${tool.login}
echo
echo "You can close this window and go back to Council."
read -k 1 "?Press any key to close."
`;
}

// Sign-in needs a real terminal, so it opens in its own Terminal window.
export async function login(provider) {
  const text = loginScript(provider);
  await fs.mkdir(toolsDir(), { recursive: true });
  const file = path.join(toolsDir(), `sign-in-${provider}.command`);
  await fs.writeFile(file, text, { mode: 0o700 });
  await fs.chmod(file, 0o700);
  if (!process.env.COUNCIL_NO_OPEN) await exec('open', [file]);
  return file;
}

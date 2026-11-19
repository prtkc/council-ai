// The models and effort levels offered in the dropdowns.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanEnv } from './providers.js';

const exec = promisify(execFile);
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CACHE_MS = 5 * 60 * 1000;

// The Claude CLI has no command that lists models, so this list is maintained here.
const CLAUDE_MODELS = [
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', note: 'may need usage credits' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
].map((m) => ({ ...m, efforts: CLAUDE_EFFORTS, defaultEffort: null }));

async function codexModels() {
  const bin = process.env.COUNCIL_CODEX_BIN || 'codex';
  const { stdout } = await exec(bin, ['debug', 'models'], { env: cleanEnv(), timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  return (parsed.models || parsed)
    .filter((m) => m.visibility === 'list')
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
    .map((m) => ({
      id: m.slug,
      label: m.display_name || m.slug,
      efforts: (m.supported_reasoning_levels || []).map((r) => r.effort),
      defaultEffort: m.default_reasoning_level || null,
    }));
}

let cached = null;
export async function loadCatalog() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const chatgpt = await codexModels().catch(() => []);
  const value = {
    claude: { name: 'Claude', efforts: CLAUDE_EFFORTS, models: CLAUDE_MODELS },
    chatgpt: { name: 'ChatGPT', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], models: chatgpt },
  };
  if (chatgpt.length) cached = { at: Date.now(), value };
  return value;
}

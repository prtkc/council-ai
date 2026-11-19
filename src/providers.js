// Runs the locally installed, subscription-signed-in CLIs. Never uses API keys.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';

const CLAUDE_TOOLS = 'Read,Write,Edit,Glob,Grep,WebSearch,WebFetch';

// Removes anything that could switch a CLI to API billing or inherit another session's login.
export function cleanEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(ANTHROPIC_|CLAUDE|OPENAI_|AWS_BEARER_TOKEN|VERTEX_|CODEX_API_KEY|CODEX_ACCESS_TOKEN)/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export function claudeCommand({ model, effort }) {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', 'dontAsk',
    '--tools', CLAUDE_TOOLS,
    '--allowedTools', 'Read(./**)', 'Edit(./**)', 'Write(./**)', 'WebSearch', 'WebFetch',
    '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
  ];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return { bin: process.env.COUNCIL_CLAUDE_BIN || 'claude', args };
}

export function codexCommand({ model, effort, cwd }) {
  const args = [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '-C', cwd,
    '-c', 'forced_login_method="chatgpt"',
    '-c', 'project_root_markers=[]',
    '-c', 'default_permissions="council"',
    '-c', 'permissions.council.filesystem={":minimal"="read",":project_roots"={"."="write"}}',
    '-c', 'permissions.council.network={enabled=false}',
    '-c', 'web_search="live"',
  ];
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  args.push('-');
  return { bin: process.env.COUNCIL_CODEX_BIN || 'codex', args };
}

const short = (v, n = 4000) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > n ? `${s.slice(0, n)}\n… (truncated)` : s;
};

function claudeToolTitle(name, input = {}) {
  const target = input.file_path || input.path || input.pattern || input.query || input.url || '';
  const verb = { Read: 'Read', Write: 'Wrote', Edit: 'Edited', Glob: 'Listed', Grep: 'Searched files for', WebSearch: 'Searched the web for', WebFetch: 'Opened' }[name] || name;
  return `${verb} ${target}`.trim();
}

export function createClaudeParser(emit) {
  const state = { text: '', final: null, error: null, thinking: new Map() };
  const flushNote = () => {
    if (state.text.trim()) emit({ type: 'activity', item: { id: `note-${Date.now()}-${Math.random()}`, kind: 'note', title: 'Progress note', detail: short(state.text), status: 'done' } });
    state.text = '';
    emit({ type: 'replace', text: '' });
  };
  return {
    state,
    line(d) {
      if (d.type === 'system' && d.subtype === 'init' && d.apiKeySource && d.apiKeySource !== 'none') {
        state.error = `Stopped: Claude tried to use an API key (${d.apiKeySource}). Council only uses your subscription login.`;
        state.fatal = true;
      } else if (d.type === 'stream_event') {
        const e = d.event || {};
        if (e.type === 'message_start') { state.message = (state.message || 0) + 1; state.thinking.clear(); }
        if (e.type === 'content_block_start' && e.content_block?.type === 'text') flushNote();
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          state.text += e.delta.text;
          emit({ type: 'delta', text: e.delta.text });
        }
        if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') {
          const t = (state.thinking.get(e.index) || '') + e.delta.thinking;
          state.thinking.set(e.index, t);
          emit({ type: 'activity', item: { id: `think-${state.message || 0}-${e.index}`, kind: 'thinking', title: 'Thinking', detail: short(t), status: 'done' } });
        }
      } else if (d.type === 'assistant') {
        for (const b of d.message?.content || []) {
          if (b.type === 'tool_use') emit({ type: 'activity', item: { id: b.id, kind: 'tool', title: claudeToolTitle(b.name, b.input), detail: short(b.input), status: 'running' } });
        }
      } else if (d.type === 'user') {
        for (const b of d.message?.content || []) {
          if (b.type === 'tool_result') {
            const body = Array.isArray(b.content) ? b.content.map((c) => c.text || '').join('\n') : b.content;
            emit({ type: 'activity', item: { id: b.tool_use_id, result: short(body), status: b.is_error ? 'error' : 'done' } });
          }
        }
      } else if (d.type === 'result') {
        if (d.is_error) state.error = d.result || (d.errors || []).join('; ') || 'Claude reported an error.';
        else state.final = d.result ?? state.text;
      }
    },
    finish: () => ({ output: state.final, error: state.error }),
  };
}

function codexItem(i) {
  switch (i.type) {
    case 'command_execution':
      return { kind: 'command', title: `Ran ${short(i.command, 140)}`, result: short(i.aggregated_output || ''), status: i.status === 'in_progress' ? 'running' : i.exit_code === 0 ? 'done' : 'error' };
    case 'web_search': {
      const a = i.action || {};
      const what = a.url || a.queries?.join(', ') || a.query || i.query || 'the web';
      return { kind: 'tool', title: a.url ? `Opened ${what}` : `Searched the web for ${what}`, status: 'done' };
    }
    case 'file_change':
      return { kind: 'tool', title: `Changed ${(i.changes || []).map((c) => c.path).join(', ') || 'files'}`, detail: short(i.changes), status: i.status === 'failed' ? 'error' : 'done' };
    case 'reasoning':
      return { kind: 'thinking', title: 'Thinking', detail: short(i.text || ''), status: 'done' };
    case 'todo_list':
      return { kind: 'note', title: 'Plan', detail: (i.items || []).map((t) => `${t.completed ? '[x]' : '[ ]'} ${t.text}`).join('\n'), status: 'done' };
    case 'mcp_tool_call':
      return { kind: 'tool', title: `Used ${i.tool || 'a tool'}`, detail: short(i.arguments), status: i.status === 'failed' ? 'error' : 'done' };
    case 'error':
      return { kind: 'note', title: 'Warning', detail: short(i.message), status: 'error' };
    default:
      return null;
  }
}

export function createCodexParser(emit) {
  const state = { message: null, error: null, lastWarning: null, completed: false };
  return {
    state,
    line(d) {
      if (d.type === 'item.started' || d.type === 'item.updated' || d.type === 'item.completed') {
        const i = d.item || {};
        if (i.type === 'agent_message') {
          if (d.type !== 'item.completed') return;
          if (state.message?.trim()) emit({ type: 'activity', item: { id: `note-${i.id}`, kind: 'note', title: 'Progress note', detail: short(state.message), status: 'done' } });
          state.message = i.text || '';
          emit({ type: 'replace', text: state.message });
          return;
        }
        const item = codexItem(i);
        if (item) emit({ type: 'activity', item: { id: i.id, ...item } });
      } else if (d.type === 'turn.failed') {
        state.error = d.error?.message || 'ChatGPT reported an error.';
      } else if (d.type === 'error') {
        state.lastWarning = d.message;
        emit({ type: 'activity', item: { id: `warn-${Date.now()}`, kind: 'note', title: 'Connection notice', detail: short(d.message), status: 'error' } });
      } else if (d.type === 'turn.completed') {
        state.completed = true;
      }
    },
    finish: () => ({
      output: state.completed ? state.message : null,
      error: state.error || (state.completed ? null : state.lastWarning),
    }),
  };
}

export function friendlyError(agent, message) {
  const m = String(message || 'The process ended without an answer.');
  if (/ENOENT/.test(m)) return `${agent === 'claude' ? 'Claude Code' : 'Codex CLI'} was not found on this Mac's PATH.`;
  if (/authenticate|oauth|not logged in|log ?in|unauthorized|401/i.test(m)) {
    return `${m}\n\nSign in by running "${agent === 'claude' ? 'claude auth login' : 'codex login'}" in Terminal, then re-run this step.`;
  }
  if (/usage limit|rate limit|429|quota/i.test(m)) return `${m}\n\nYour plan's limit may be used up. Re-run this step once it resets.`;
  return m;
}

// Runs one agent turn. Resolves with the final text, rejects on failure or abort.
export function runAgent({ agent, prompt, cwd, model, effort, signal, onEvent = () => {} }) {
  return new Promise((resolve, reject) => {
    const { bin, args } = agent === 'claude' ? claudeCommand({ model, effort }) : codexCommand({ model, effort, cwd: path.resolve(cwd) });
    const parser = (agent === 'claude' ? createClaudeParser : createCodexParser)(onEvent);
    let stderr = '';
    let killTimer;
    const child = spawn(bin, args, { cwd, env: cleanEnv(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
    const abort = () => { kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 3000); };
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });

    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    child.stderr.on('data', (b) => { stderr = (stderr + b).slice(-4000); });
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (l) => {
      let d;
      try { d = JSON.parse(l); } catch { return; }
      try { parser.line(d); } catch (e) { parser.state.error ||= e.message; }
      if (parser.state.fatal) abort();
    });
    const rlClosed = new Promise((r) => rl.once('close', r));

    child.on('error', (e) => { clearTimeout(killTimer); reject(new Error(friendlyError(agent, e.code === 'ENOENT' ? 'ENOENT' : e.message))); });
    child.on('close', async (code) => {
      await rlClosed;
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      const { output, error } = parser.finish();
      if (parser.state.fatal) return reject(new Error(error));
      if (signal?.aborted) return reject(Object.assign(new Error('Stopped'), { aborted: true }));
      if (error || code !== 0 || !output?.trim()) {
        const noise = /^Reading additional input from stdin\.*\s*/;
        return reject(new Error(friendlyError(agent, error || stderr.replace(noise, '').trim() || `Exited with code ${code} and no answer.`)));
      }
      resolve(output);
    });
  });
}

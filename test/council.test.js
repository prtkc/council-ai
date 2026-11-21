import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Council } from '../src/council.js';
import { createServer } from '../src/server.js';
import { claudeCommand, cleanEnv, createClaudeParser, createCodexParser, codexCommand } from '../src/providers.js';
import { migrateRun, parseOutput, validateConfig } from '../src/workflow.js';

const cfg = (extra = {}) => ({ prompts: { a: 'Topic A', b: 'Topic B' }, maxTurns: 2, ...extra });
const wait = async (fn, ms = 3000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function make(runAgent) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'council-test-'));
  const calls = [];
  const c = new Council({ root, catalog: async () => null, runAgent: async (a) => { calls.push(a); return runAgent(a, calls); } });
  await c.load();
  return { c, calls, root };
}
const echo = (a, calls) => `answer ${calls.length} from ${a.agent}`;
const finished = (c, r) => () => c.stateOf(r) === 'complete';

test('runs every phase in order, with parallel first phases and alternating turns', async () => {
  const { c, calls } = await make(echo);
  const r = await c.create(cfg({ firstSpeaker: 'b', drafter: 'b' }));
  await wait(finished(c, r));
  assert.deepEqual(r.steps.map((s) => s.id), ['independent-a', 'independent-b', 'revise-a', 'revise-b', 'turn-1', 'turn-2', 'final-draft', 'final-check', 'final-apply']);
  assert.deepEqual(r.steps.slice(4).map((s) => s.agent), ['b', 'a', 'b', 'a', 'b']);
  assert.match(calls[2].prompt + calls[3].prompt, /answer 2 from chatgpt/);
  assert.equal(c.combinedStep(r).id, 'final-apply');
  await c.flush();
  assert.equal(await fs.readFile(path.join(c.dir(r.id), 'combined.md'), 'utf8'), c.combinedStep(r).output);
});

test('independent answers cannot see each other and use private folders', async () => {
  const { c, calls } = await make(echo);
  const r = await c.create(cfg({ maxTurns: 0 }));
  await wait(finished(c, r));
  const [a, b] = calls;
  assert.ok(a.prompt.includes('Topic A') && !a.prompt.includes('Topic B'));
  assert.ok(b.prompt.includes('Topic B') && !b.prompt.includes('Topic A'));
  assert.notEqual(a.cwd, b.cwd);
  assert.equal(calls[2].cwd, c.workspace(r.id));
});

test('pause holds new steps, and edits made while paused reach later prompts', async () => {
  const { c, calls } = await make(echo);
  const r = await c.create(cfg({ startPaused: true, maxTurns: 0 }));
  assert.equal(calls.length, 0);
  c.editStep(r, 'independent-a', { prompt: 'Edited topic' });
  c.resume(r);
  await wait(() => r.steps[1].status === 'done' && r.steps[0].status === 'done');
  c.pause(r);
  await wait(() => c.stateOf(r) === 'paused' || c.stateOf(r) === 'complete');
  await wait(finished(c, { ...r, steps: r.steps.slice(0, 1) }));
  assert.ok(calls[0].prompt.includes('Edited topic'));
  assert.ok(calls.some((x) => x.prompt.includes('<your_brief>\nEdited topic')));
});

test('editing an answer marks later work stale, and re-run uses the edit', async () => {
  const { c, calls } = await make(echo);
  const r = await c.create(cfg({ maxTurns: 0 }));
  await wait(finished(c, r));
  c.editStep(r, 'independent-b', { output: 'HUMAN CORRECTION' });
  const v = c.view(r);
  assert.equal(v.steps.find((s) => s.id === 'revise-a').stale, true);
  assert.equal(v.steps.find((s) => s.id === 'independent-a').stale, false);
  assert.ok(r.steps[1].originalOutput);
  const before = calls.length;
  c.rerun(r, 'revise-a');
  await wait(() => calls.length > before && c.stateOf(r) === 'complete');
  assert.ok(calls[before].prompt.includes('HUMAN CORRECTION'));
  assert.equal(r.steps.find((s) => s.id === 'revise-b').history.length, 0);
  assert.equal(r.steps.find((s) => s.id === 'final-draft').history.length, 1);
});

test('a failed step blocks the run until retried', async () => {
  let fail = true;
  const { c } = await make((a, calls) => {
    if (a.agent === 'chatgpt' && fail) throw new Error('limit reached');
    return echo(a, calls);
  });
  const r = await c.create(cfg({ maxTurns: 0 }));
  await wait(() => c.stateOf(r) === 'attention');
  assert.equal(r.steps.find((s) => s.id === 'revise-a').status, 'pending');
  fail = false;
  c.rerun(r, 'independent-b');
  await wait(finished(c, r));
});

test('stopping aborts only that step and pauses the run', async () => {
  const { c } = await make((a) => new Promise((_, rej) => a.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { aborted: true })))));
  const r = await c.create(cfg());
  await wait(() => c.active.size === 2);
  c.stopStep(r, 'independent-a');
  await wait(() => r.steps[0].status === 'stopped');
  assert.equal(r.steps[1].status, 'running');
  assert.equal(r.paused, true);
  await c.shutdown();
});

test('dialogue ends early only when both sides agree consecutively', async () => {
  const { c } = await make((a) => (/turn \d of at most/.test(a.prompt) ? 'Done talking\n[[AGREED]]' : 'x'));
  const r = await c.create(cfg({ maxTurns: 5 }));
  await wait(finished(c, r));
  assert.deepEqual(r.steps.filter((s) => s.kind === 'turn').map((s) => s.status), ['done', 'done', 'skipped', 'skipped', 'skipped']);
  assert.equal(r.steps.find((s) => s.id === 'turn-1').output, 'Done talking');
});

test('the turn limit can change before the final document starts', async () => {
  const { c } = await make(echo);
  const r = await c.create(cfg({ startPaused: true, maxTurns: 1, firstSpeaker: 'a' }));
  c.setMaxTurns(r, 3);
  assert.deepEqual(r.steps.filter((s) => s.kind === 'turn').map((s) => s.agent), ['a', 'b', 'a']);
  assert.equal(r.steps.at(-3).id, 'final-draft');
  c.setMaxTurns(r, 0);
  assert.equal(r.steps.filter((s) => s.kind === 'turn').length, 0);
});

test('runs reload after a restart, with interrupted steps marked', async () => {
  const { c, root } = await make(() => new Promise(() => {}));
  const r = await c.create(cfg());
  await wait(() => r.steps[0].status === 'running');
  await c.flush();
  const again = new Council({ root });
  await again.load();
  const loaded = again.get(r.id);
  assert.equal(loaded.steps[0].status, 'stopped');
  assert.equal(loaded.paused, true);
});

test('parsers extract final text, tool activity, and failures', () => {
  const events = [];
  const cl = createClaudeParser((e) => events.push(e));
  cl.line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } });
  cl.line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'WebSearch', input: { query: 'q' } }] } });
  cl.line({ type: 'result', result: 'final' });
  assert.equal(cl.finish().output, 'final');
  assert.ok(events.some((e) => e.item?.title === 'Searched the web for q'));

  const api = createClaudeParser(() => {});
  api.line({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' });
  assert.equal(api.state.fatal, true);

  const cx = createCodexParser(() => {});
  cx.line({ type: 'item.completed', item: { id: '1', type: 'agent_message', text: 'working' } });
  cx.line({ type: 'item.completed', item: { id: '2', type: 'agent_message', text: 'answer' } });
  assert.equal(cx.finish().output, null);
  cx.line({ type: 'turn.completed' });
  assert.equal(cx.finish().output, 'answer');
});

test('API keys never reach the CLIs, and Codex stays in its folder', () => {
  const env = cleanEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'x', CODEX_API_KEY: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'x' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
  const { args } = codexCommand({ cwd: '/w' });
  assert.ok(args.includes('project_root_markers=[]'));
  assert.ok(!args.some((a) => /danger|bypass/.test(a)));
});

test('server rejects foreign sites and paths outside the workspace', async () => {
  const { c } = await make(echo);
  const r = await c.create(cfg({ startPaused: true }));
  const server = createServer(c);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const json = { 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/api/runs`, { method: 'POST', headers: { ...json, origin: 'https://evil.example' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/api/runs/${r.id}/pause`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 400);
    assert.equal((await fetch(`${base}/api/runs/${r.id}/file?path=${encodeURIComponent('../run.json')}`)).status, 400);
    await fs.symlink('/etc/hosts', path.join(c.workspace(r.id), 'link'));
    assert.equal((await fetch(`${base}/api/runs/${r.id}/file?path=link`)).status, 400);
    const put = await fetch(`${base}/api/runs/${r.id}/file`, { method: 'PUT', headers: json, body: JSON.stringify({ path: 'notes/a.txt', content: 'hello' }) });
    assert.equal(put.status, 200);
    const got = await (await fetch(`${base}/api/runs/${r.id}/file?path=notes/a.txt`)).json();
    assert.equal(got.content, 'hello');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('any two models can face each other, with distinct names and their own settings', async () => {
  const { c, calls } = await make(echo);
  const seat = { provider: 'claude', model: 'claude-haiku-5-5', effort: 'high' };
  const r = await c.create(cfg({ maxTurns: 0, seats: { a: seat, b: { ...seat, effort: 'low' } } }));
  await wait(finished(c, r));
  assert.deepEqual([r.seats.a.name, r.seats.b.name], ['Claude A', 'Claude B']);
  assert.ok(calls.every((x) => x.agent === 'claude' && x.model === 'claude-haiku-5-5'));
  assert.deepEqual(calls.slice(0, 2).map((x) => x.effort), ['high', 'low']);
});

test('models and efforts are checked against the catalog', () => {
  const catalog = { claude: { efforts: ['low'], models: [{ id: 'm1', label: 'Model One', efforts: ['low'] }] }, chatgpt: { efforts: ['low'], models: [] } };
  const base = { prompts: { a: 'x', b: 'y' }, maxTurns: 0 };
  const ok = validateConfig({ ...base, seats: { a: { provider: 'claude', model: 'm1', effort: 'low' }, b: { provider: 'claude', model: 'm1' } } }, catalog);
  assert.deepEqual([ok.seats.a.name, ok.seats.b.name], ['Model One A', 'Model One B']);
  assert.throws(() => validateConfig({ ...base, seats: { a: { provider: 'claude', model: 'nope' } } }, catalog), /not an available/);
  assert.throws(() => validateConfig({ ...base, seats: { a: { provider: 'claude', model: 'm1', effort: 'max' } } }, catalog), /does not support/);
  assert.throws(() => validateConfig({ ...base, seats: { a: { model: '--evil' } } }), /Invalid model/);
});

test('effort reaches both CLIs', () => {
  assert.deepEqual(claudeCommand({ effort: 'max' }).args.slice(-2), ['--effort', 'max']);
  assert.ok(codexCommand({ cwd: '/w', effort: 'ultra' }).args.includes('model_reasoning_effort="ultra"'));
});

test('summaries and agreement markers are removed from answers', () => {
  assert.deepEqual(parseOutput('Body\n[[AGREED]]\n[[SUMMARY: A said B erred.]]'), { output: 'Body', summary: 'A said B erred.', agreed: true });
  assert.deepEqual(parseOutput('Body\n[[SUMMARY: S]]\n[[AGREED]]'), { output: 'Body', summary: 'S', agreed: true });
  assert.deepEqual(parseOutput('Plain'), { output: 'Plain', summary: null, agreed: false });
});

test('the adversarial level shapes review prompts and flags finished reviews', async () => {
  const { c, calls } = await make(echo);
  const r = await c.create(cfg({ maxTurns: 1, stance: 5 }));
  await wait(finished(c, r));
  assert.ok(calls.find((x) => x.prompt.includes('Review of')).prompt.includes('Ruthless'));
  assert.ok(!calls[0].prompt.includes('Ruthless'));
  c.editRun(r, { stance: 1 });
  const v = c.view(r);
  assert.equal(v.steps.find((s) => s.id === 'turn-1').stale, true);
  assert.equal(v.steps.find((s) => s.id === 'independent-a').stale, false);
});

test('runs saved by the earlier version still load', () => {
  const old = { models: { claude: 'x', chatgpt: '' }, prompts: { claude: 'P', chatgpt: 'Q' }, firstSpeaker: 'chatgpt', drafter: 'claude', steps: [{ id: 'independent-chatgpt', agent: 'chatgpt' }, { id: 'turn-1', agent: 'claude' }] };
  const r = migrateRun(old);
  assert.deepEqual(r.prompts, { a: 'P', b: 'Q' });
  assert.equal(r.firstSpeaker, 'b');
  assert.equal(r.seats.a.model, 'x');
  assert.deepEqual(r.steps.map((s) => [s.id, s.agent]), [['independent-b', 'b'], ['turn-1', 'a']]);
});

test('hurry mode lowers effort, keeps one more turn each, and can be undone', async () => {
  const { c, calls } = await make(echo);
  const r = await c.create(cfg({ startPaused: true, maxTurns: 6, seats: { a: { provider: 'claude', effort: 'max' }, b: { provider: 'chatgpt', effort: 'high' } } }));
  c.setHurry(r, true);
  assert.deepEqual(r.steps.filter((s) => s.kind === 'turn').map((s) => s.status), ['pending', 'pending', 'skipped', 'skipped', 'skipped', 'skipped']);
  c.setHurry(r, false);
  assert.equal(r.steps.filter((s) => s.status === 'skipped').length, 0);
  c.setHurry(r, true);
  c.resume(r);
  await wait(finished(c, r));
  assert.ok(calls.every((x) => x.effort === 'low'));
  assert.ok(calls.every((x) => x.prompt.includes('asked to hurry up')));
  assert.ok(r.steps.filter((s) => s.status === 'done').every((s) => s.hurried));
});

test('ending a slow step keeps its partial answer and moves on', async () => {
  const { c } = await make((a, calls) => (calls.length === 1
    ? new Promise((_, rej) => { a.onEvent({ type: 'delta', text: 'Partial thoughts so far' }); a.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { aborted: true }))); })
    : echo(a, calls)));
  const r = await c.create(cfg({ maxTurns: 0 }));
  await wait(() => r.steps[0].output === 'Partial thoughts so far');
  c.endStep(r, 'independent-a');
  await wait(finished(c, r));
  assert.equal(r.steps[0].status, 'done');
  assert.equal(r.steps[0].endedEarly, true);
  assert.equal(r.paused, false);
});

test('after a run, you can keep chatting with any model about the whole output', async () => {
  const { c, calls } = await make(echo);
  const r = await c.create(cfg({ maxTurns: 0 }));
  await wait(finished(c, r));
  await c.sendChat(r, { text: 'Make it a Google Doc', provider: 'chatgpt', model: '', effort: 'low', apps: true });
  await wait(() => r.chat.at(-1).status === 'done');
  const last = calls.at(-1);
  assert.equal(last.agent, 'chatgpt');
  assert.equal(last.apps, true);
  assert.match(last.prompt, /<request>\nMake it a Google Doc\n<\/request>/);
  assert.match(last.prompt, /<combined_document>\nanswer \d+ from claude/);
  assert.deepEqual(r.chat.map((m) => m.role), ['user', 'assistant']);
  await c.sendChat(r, { text: 'Thanks', provider: 'claude' });
  await wait(() => r.chat.at(-1).status === 'done');
  assert.match(calls.at(-1).prompt, /<chat_so_far>\n### The user\nMake it a Google Doc/);
  assert.equal(calls.at(-1).apps, false);
});

test('chat waits until the run has finished', async () => {
  const { c } = await make(() => new Promise(() => {}));
  const r = await c.create(cfg());
  await wait(() => r.steps[0].status === 'running');
  await assert.rejects(c.sendChat(r, { text: 'hi', provider: 'claude' }), /Wait for the run to finish/);
  await c.shutdown();
});

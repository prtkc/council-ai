import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Playgrounds, buildTurnPrompt, nextSpeaker, parseMarkers } from '../src/playground.js';

const wait = async (fn, ms = 3000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function make(reply) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-test-'));
  const calls = [];
  const p = new Playgrounds({ root, runAgent: async (a) => { calls.push(a); return reply(a, calls); } });
  await p.load();
  return { p, calls, root };
}
const names = (pg) => pg.messages.map((m) => m.name);
const reply = (next, extra = '') => `Message.${extra}\n[[NEXT: ${next}]]\n[[SUMMARY_S: short]]\n[[SUMMARY_M: medium one]]\n[[SUMMARY_L: long one]]`;

test('markers are stripped and summaries kept', () => {
  const { text, tags } = parseMarkers('Hello team.\n[[DONE]]\n[[NEXT: Coder]]\n[[SUMMARY_S: hi]]\n[[SUMMARY_M: hi all]]\n[[SUMMARY_L: hi everyone]]');
  assert.equal(text, 'Hello team.');
  assert.deepEqual(tags, { SUMMARY_L: 'hi everyone', SUMMARY_M: 'hi all', SUMMARY_S: 'hi', NEXT: 'Coder', DONE: true });
});

test('the head speaks first, hands off, and gets the floor back', async () => {
  const order = ['Coder', 'Tester', 'Manager', 'Designer', 'Coder', 'Tester', 'Coder', 'Tester'];
  const { p } = await make((a, calls) => reply(order[calls.length - 1]));
  const pg = await p.create('team');
  p.edit(pg, { topic: 'Build a to-do app', maxTurns: 9, headEvery: 3 });
  p.start(pg);
  await wait(() => p.stateOf(pg) === 'complete');
  assert.deepEqual(names(pg), ['Manager', 'Coder', 'Tester', 'Manager', 'Designer', 'Coder', 'Tester', 'Manager', 'Tester']);
  assert.equal(pg.messages[0].summaries.s, 'short');
  assert.equal(pg.messages[0].to, pg.agents.find((a) => a.name === 'Coder').id);
});

test('only the head can finish a project early', async () => {
  const script = [reply('Coder'), reply('Manager', '\n[[DONE]]'), reply('Coder', '\n[[DONE]]'), reply('Coder')];
  const { p } = await make((a, calls) => script[calls.length - 1]);
  const pg = await p.create('team');
  p.edit(pg, { topic: 'x', maxTurns: 10 });
  p.start(pg);
  await wait(() => p.stateOf(pg) === 'complete');
  assert.deepEqual(names(pg), ['Manager', 'Coder', 'Manager']);
  assert.deepEqual(pg.messages.map((m) => m.done), [false, false, true]);
});

test('open conversations support all three turn rules', () => {
  const pg = { mode: 'open', turnRule: 'round', headEvery: 4, agents: ['A', 'B', 'C'].map((n) => ({ id: n, name: n })), messages: [] };
  const said = (id, next) => pg.messages.push({ kind: 'agent', agentId: id, next, status: 'done' });
  assert.equal(nextSpeaker(pg).id, 'A');
  said('A', 'A');
  assert.equal(nextSpeaker(pg).id, 'B');
  pg.turnRule = 'choose';
  said('B', 'A');
  assert.equal(nextSpeaker(pg).id, 'A');
  pg.turnRule = 'random';
  for (let i = 0; i < 20; i++) assert.notEqual(nextSpeaker(pg).id, 'B');
  pg.turnRule = 'choose';
  pg.messages = [];
  for (let i = 0; i < 6; i++) said(i % 2 ? 'B' : 'A', i % 2 ? 'A' : 'B');
  assert.equal(nextSpeaker(pg).id, 'C', 'someone left out too long is brought in');
});

test('a message from you goes to the agent you address, and into everyone\'s context', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { p, calls } = await make(async (a, c) => { if (c.length === 1) await gate; return reply('Pop fan'); });
  const pg = await p.create('debate');
  p.edit(pg, { maxTurns: 3 });
  p.start(pg);
  await wait(() => calls.length === 1);
  p.post(pg, { text: 'What about Queen?', to: pg.agents.find((a) => a.name === 'Music historian').id });
  release();
  await wait(() => p.stateOf(pg) === 'complete');
  assert.deepEqual(names(pg), ['Rock fan', 'You', 'Music historian', 'Pop fan']);
  assert.match(calls[1].prompt, /The user → Music historian:\nWhat about Queen\?/);
});

test('re-running from a message archives later ones and uses your edits', async () => {
  const { p, calls } = await make(() => reply('Pop fan'));
  const pg = await p.create('debate');
  p.edit(pg, { maxTurns: 3 });
  p.start(pg);
  await wait(() => p.stateOf(pg) === 'complete');
  p.editMessage(pg, pg.messages[0].id, { text: 'EDITED OPENING' });
  const second = pg.messages[1];
  p.rerunFrom(pg, second.id);
  await wait(() => p.stateOf(pg) === 'complete');
  assert.equal(pg.history.length, 1);
  assert.equal(pg.messages[1].name, second.name);
  assert.match(calls.at(-2).prompt, /EDITED OPENING/);
});

test('a failed turn blocks until retried or skipped', async () => {
  let fail = true;
  const { p } = await make((a, c) => { if (fail && c.length === 2) throw new Error('limit'); return reply('Pop fan'); });
  const pg = await p.create('debate');
  p.edit(pg, { maxTurns: 3 });
  p.start(pg);
  await wait(() => p.stateOf(pg) === 'attention');
  const failed = pg.messages.at(-1);
  p.skip(pg, failed.id);
  await wait(() => p.stateOf(pg) === 'complete');
  assert.equal(pg.messages[1].status, "skipped");
  assert.notEqual(pg.messages[2].agentId, failed.agentId);
  fail = false;
});

test('prompts name the roster, the brief, and the closing format', async () => {
  const { p } = await make(() => '');
  const pg = await p.create('team');
  pg.topic = 'Ship a landing page';
  const coder = pg.agents.find((a) => a.name === 'Coder');
  const text = buildTurnPrompt(pg, coder);
  assert.match(text, /You are Coder\./);
  assert.match(text, /Manager \(head\)/);
  assert.match(text, /Ship a landing page/);
  assert.match(text, /\[\[NEXT: name of who should speak next, one of: Manager, Product manager, Designer, Tester, Red teamer\]\]/);
});

test('playgrounds reload after a restart', async () => {
  const { p, root } = await make(() => new Promise(() => {}));
  const pg = await p.create('debate');
  p.start(pg);
  await wait(() => pg.messages.length === 1);
  await p.shutdown();
  const again = new Playgrounds({ root });
  await again.load();
  assert.equal(again.get(pg.id).messages[0].status, 'stopped');
  assert.equal(again.stateOf(again.get(pg.id)), 'attention');
});

test('hurry mode finishes a playground within three more turns, at low effort', async () => {
  const { p, calls } = await make(() => reply('Pop fan'));
  const pg = await p.create('debate');
  p.edit(pg, { maxTurns: 20 });
  p.setHurry(pg, true);
  assert.equal(p.view(pg).limit, 3);
  p.start(pg);
  await wait(() => p.stateOf(pg) === 'complete');
  assert.equal(p.view(pg).turns, 3);
  assert.ok(calls.every((x) => x.effort === 'low' && /asked to hurry up/.test(x.prompt)));
  p.resume(pg);
  assert.equal(pg.hurry, false, 'continuing goes back to normal');
  await p.shutdown();
});

test('ending a turn early keeps what was said and hands on', async () => {
  const { p } = await make((a, calls) => (calls.length === 1
    ? new Promise((_, rej) => { a.onEvent({ type: 'delta', text: 'I was about to say' }); a.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { aborted: true }))); })
    : reply('Pop fan')));
  const pg = await p.create('debate');
  p.edit(pg, { maxTurns: 2 });
  p.start(pg);
  await wait(() => pg.messages[0]?.text === 'I was about to say');
  p.end(pg);
  await wait(() => p.stateOf(pg) === 'complete');
  assert.deepEqual(pg.messages.map((m) => [m.status, Boolean(m.endedEarly)]), [['done', true], ['done', false]]);
  assert.equal(pg.messages[0].summaries.s, 'I was about to say');
});

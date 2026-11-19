import test from 'node:test';
import assert from 'node:assert/strict';
import { install, loginScript, parseClaudeStatus, parseCodexStatus, setUpPath } from '../src/setup.js';

test('only subscription logins count as signed in', () => {
  assert.equal(parseClaudeStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}').signedIn, true);
  assert.equal(parseClaudeStatus('{"loggedIn":true,"authMethod":"console"}').signedIn, false);
  assert.equal(parseCodexStatus('Logged in using ChatGPT').signedIn, true);
  assert.equal(parseCodexStatus('Logged in using an API key').signedIn, false);
});

test('sign-in scripts use subscription login and safely quote the path', () => {
  const s = loginScript('claude', "/a b/it's");
  assert.ok(s.includes('claude auth login --claudeai'));
  assert.ok(s.includes(`export PATH='/a b/it'\\''s'`));
  assert.ok(s.includes('unset ANTHROPIC_API_KEY'));
  assert.ok(loginScript('chatgpt', '/x').includes('codex login'));
  assert.throws(() => loginScript('other', '/x'), /Unknown tool/);
});

test('existing tools come before ones Council installs', () => {
  const env = { HOME: '/h', PATH: '/mine:/usr/bin' };
  setUpPath(env);
  const parts = env.PATH.split(':');
  assert.ok(parts.indexOf('/mine') < parts.findIndex((p) => p.endsWith('.tools/node_modules/.bin')));
  assert.ok(parts.includes('/h/.local/bin'));
});

test('only known tools can be installed', () => {
  assert.throws(() => install('left-pad'), /Unknown tool/);
});

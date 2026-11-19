#!/usr/bin/env node
// A stand-in for the Claude CLI, for trying the interface without using any plan limits.
if (process.argv.includes('auth')) {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'test double' }));
  process.exit(0);
}
let prompt = '';
for await (const c of process.stdin) prompt += c;
const send = (d) => console.log(JSON.stringify(d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS || 60);

let text = '**Test double reply.** This text did not come from Claude.\n\n- It streams word by word\n- It proves the interface works';
if (prompt.includes('## Review of')) text = "## Review of ChatGPT's answer\nA test review.\n\n## Revised answer\nA test revision that keeps the useful points.";
if (/turn \d+ of at most/.test(prompt)) text = 'A test conversation message, replying to the latest point.';
if (prompt.includes('Write the combined document') || prompt.includes('Produce the final version')) text = '# Combined test document\n\n## Findings\n\n| Source | Point |\n| --- | --- |\n| Both | Test content |\n\n## Open disagreements\n\nNone.';

text += '\n\n[[SUMMARY: The test double gave a placeholder reply for the user.]]';

send({ type: 'system', subtype: 'init', apiKeySource: 'none' });
send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${process.pid}`, name: 'WebSearch', input: { query: 'test search' } }] } });
await sleep(delay * 3);
send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${process.pid}`, content: 'Test results' }] } });
send({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
for (const w of text.split(/(?<=\s)/)) {
  send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: w } } });
  await sleep(delay);
}
send({ type: 'result', subtype: 'success', is_error: false, result: text });

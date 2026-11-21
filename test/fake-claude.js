#!/usr/bin/env node
// A stand-in for the Claude CLI, for trying the interface without using any plan limits.
if (process.argv.includes('mcp')) {
  console.log('claude.ai Google Drive: https://example.invalid - ✔ Connected');
  process.exit(0);
}
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

if (prompt.includes('<request>')) text = `Test double follow-up reply. Connected apps: ${process.argv.includes('--strict-mcp-config') ? 'off' : 'on'}.`;
const playground = prompt.match(/You are (.+?)\. Your role:[\s\S]*one of: (.+?)\]\]/);
if (playground) {
  const [, me, list] = playground;
  const others = list.split(', ');
  const next = others[Math.floor(Math.random() * others.length)];
  text = `Test double speaking as ${me}. I have looked at the brief and I want ${next} to weigh in next on the plan and the trade-offs.\n\n[[NEXT: ${next}]]\n[[SUMMARY_S: ${me} passes to ${next}.]]\n[[SUMMARY_M: I've read the brief. ${next}, can you take the next part and tell us the trade-offs?]]\n[[SUMMARY_L: I've gone through the brief and sketched where we stand. ${next}, I'd like you to take the next part, walk us through the trade-offs you see, and flag anything that could block us later.]]`;
} else if (!prompt.includes('<request>')) {
  text += '\n\n[[SUMMARY: The test double gave a placeholder reply for the user.]]';
}

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

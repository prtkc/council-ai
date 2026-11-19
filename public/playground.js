import { esc, markdown } from '/markdown.js';

const $ = (sel, root = document) => root.querySelector(sel);
const EFFORT_LABEL = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };
const STATE_LABEL = { draft: 'Setting up', running: 'Running', pausing: 'Pausing after this message', paused: 'Paused', attention: 'Needs attention', complete: 'Finished' };
const SIZES = [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']];
const SPEEDS = [0.5, 1, 1.5, 2, 4];
const YOU = { id: 'you', name: 'You', x: 50, y: 93 };
let meta = null;

const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const stripMarkers = (t) => t.replace(/\s*\[\[(?:N|S|D)[\s\S]*$/, '');
// The page's security policy blocks inline style attributes, so positions are set from script.
const placeAll = (box) => box.querySelectorAll('[data-x]').forEach((el) => { el.style.left = `${el.dataset.x}%`; el.style.top = `${el.dataset.y}%`; });
const words = (t) => String(t || '').split(/\s+/).filter(Boolean).length;

async function loadMeta(api) {
  if (!meta) {
    const [models, templates] = await Promise.all([api('/models'), api('/playgrounds/templates')]);
    meta = { providers: models.providers, ...templates };
  }
  return meta;
}

// --- Template picker ---
export async function renderPlaygroundPicker({ main, api, guard }) {
  const { templates } = await loadMeta(api);
  main.innerHTML = `<div class="page narrow">
    <header class="page-head"><h1>New playground</h1><p class="muted">Put several AI agents in one room. Give each a role, and watch them work on a project or just talk.</p></header>
    <div class="template-grid">${templates.map((t) => `<button class="template" data-template="${t.id}"><strong>${esc(t.label)}</strong><span class="muted small">${esc(t.description)}</span></button>`).join('')}</div>
  </div>`;
  main.querySelector('.template-grid').addEventListener('click', guard(async (e) => {
    const b = e.target.closest('[data-template]');
    if (!b) return;
    b.disabled = true;
    const { playground } = await api('/playgrounds', 'POST', { template: b.dataset.template });
    location.hash = `#/playground/${playground.id}`;
  }));
}

// --- Playground page ---
export function renderPlayground(id, { main, api, guard, toast, watch }) {
  let pg = null;
  let selected = null;
  let panel = 'chat';
  let replay = null;
  let dragging = null;
  const openSecs = new Set();
  const edits = new Map();
  const sigs = new Map();
  let file = null;
  let disposed = false;

  main.innerHTML = '<div class="pg" id="pg-root"><p class="muted">Loading…</p></div>';
  const root = $('#pg-root');
  const path = (rest = '') => `/playgrounds/${id}${rest}`;
  const apply = (data) => { if (data?.playground) { pg = data.playground; render(); } return data; };
  const call = (rest, method = 'POST', body) => api(path(rest), method, body).then(apply);
  const agentOf = (aid) => (aid === 'you' ? YOU : pg.agents.find((a) => a.id === aid));
  const sizeOf = () => pg.summarySize || 'm';
  const summaryOf = (m) => m.summaries?.[sizeOf()] || '';
  const shown = () => pg.messages.filter((m) => m.status === 'done');

  const es = watch(`?playground=${encodeURIComponent(id)}`);
  es.addEventListener('snapshot', (e) => { pg = JSON.parse(e.data).playground; render(); });
  const live = (e, fn) => {
    const d = JSON.parse(e.data);
    const m = pg?.messages.find((x) => x.id === d.messageId);
    if (m) { fn(m, d); updateLive(m); }
  };
  es.addEventListener('delta', (e) => live(e, (m, d) => { m.text += d.text; }));
  es.addEventListener('replace', (e) => live(e, (m, d) => { m.text = d.text; }));
  es.addEventListener('activity', (e) => live(e, (m, d) => {
    const i = m.activity.findIndex((a) => a.id === d.item.id);
    if (i >= 0) m.activity[i] = d.item; else m.activity.push(d.item);
  }));
  loadMeta(api).then(() => render()).catch((e) => toast(e.message));

  function shell() {
    root.innerHTML = `
      <header class="pg-head" id="pg-head"></header>
      <div class="pg-body">
        <section class="pg-stage">
          <details class="pg-setup" id="pg-setup"><summary>Setup</summary><div id="setup-body"></div></details>
          <div class="canvas" id="canvas" aria-label="Playground canvas">
            <svg class="arrows" id="arrows" aria-hidden="true"><defs><marker id="arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs><line id="arrow-line"/></svg>
            <div id="nodes"></div>
            <div id="bubbles"></div>
            <p class="canvas-hint muted small" id="canvas-hint"></p>
          </div>
          <div class="replay-bar" id="replay-bar" hidden></div>
        </section>
        <aside class="pg-side" id="side"></aside>
      </div>`;
  }

  function render() {
    if (disposed || !pg || !meta) return;
    if (!$('#pg-head', root)) shell();
    document.title = `${pg.title} · Council`;
    document.querySelectorAll('#pg-list a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#/playground/${pg.id}`));
    renderHead();
    renderSetup();
    renderStage();
    renderSide();
    renderReplayBar();
  }

  function renderHead() {
    const head = $('#pg-head', root);
    if (head.contains(document.activeElement)) return;
    const s = pg.state;
    const main = s === 'draft' ? '<button class="primary" data-do="start">Start</button>'
      : s === 'running' ? '<button data-do="pause">Pause</button>'
      : s === 'pausing' ? '<button disabled>Pausing…</button>'
      : s === 'complete' ? '<button data-do="resume">Continue</button>'
      : '<button class="primary" data-do="resume">Resume</button>';
    head.innerHTML = `
      <div class="pg-title-wrap"><input class="pg-title" id="pg-title" value="${esc(pg.title)}" aria-label="Playground title"><span class="pill state-${s === 'draft' ? 'paused' : s}">${STATE_LABEL[s]}</span>
        <span class="muted small">${pg.mode === 'project' ? 'Project' : 'Open conversation'} · ${pg.turns} of ${pg.limit} turns${pg.hurry ? " (hurrying)" : ""}</span></div>
      <div class="head-actions">
        <div class="seg" role="group" aria-label="Summary size">${SIZES.map(([k, l]) => `<button data-size="${k}" aria-pressed="${sizeOf() === k}">${l}</button>`).join('')}</div>
        ${s !== 'draft' && s !== 'complete' ? `<button class="hurry" data-do="hurry" aria-pressed="${Boolean(pg.hurry)}" title="${pg.hurry ? 'Go back to normal effort and the full turn limit' : 'Use low effort and short replies from the next turn, and finish within three more turns'}">${pg.hurry ? 'Hurrying' : 'Hurry up'}</button>` : ''}
        ${s === 'running' || s === 'pausing' ? '<button data-do="end" title="End this turn now, keep what was said, and move to the next speaker">End turn</button><button data-do="stop" title="Stop this turn and pause the playground">Stop</button>' : ''}
        ${main}
        <button data-do="replay" ${shown().length ? '' : 'disabled'} aria-pressed="${Boolean(replay)}">${replay ? 'Exit replay' : 'Replay'}</button>
        <button data-do="files" aria-pressed="${panel === 'files'}">Files</button>
      </div>`;
  }

  function renderSetup() {
    const box = $('#pg-setup', root);
    if (!box.dataset.init) { box.open = pg.state === 'draft'; box.dataset.init = '1'; }
    if (box.dataset.state === 'draft' && pg.state !== 'draft') box.open = false;
    box.dataset.state = pg.state;
    if (box.contains(document.activeElement)) return;
    const project = pg.mode === 'project';
    $('#setup-body', root).innerHTML = `
      <div class="setup-grid">
        <label>Mode<select data-field="mode" ${pg.started ? 'disabled' : ''}><option value="project" ${project ? 'selected' : ''}>Project, led by a head agent</option><option value="open" ${project ? '' : 'selected'}>Open conversation</option></select></label>
        ${project
          ? `<label>Head checks in at least every<select data-field="headEvery">${[2, 3, 4, 5, 6, 8, 10].map((n) => `<option value="${n}" ${pg.headEvery === n ? 'selected' : ''}>${n} turns</option>`).join('')}</select></label>`
          : `<label>Who speaks next<select data-field="turnRule">${Object.entries(meta.turnRules).map(([k, l]) => `<option value="${k}" ${pg.turnRule === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`}
        <label>Maximum turns<input type="number" min="1" max="200" data-field="maxTurns" value="${pg.maxTurns}"></label>
      </div>
      <label>${project ? 'Project brief' : 'Topic'}<textarea data-field="topic" rows="3" placeholder="${project ? 'What should the team build or decide?' : 'What should they talk about?'}">${esc(pg.topic)}</textarea></label>
      <p class="muted small">${project ? 'The head agent speaks first, plans the work, and hands off. The floor comes back to the head when someone hands it back, or after the turns above.' : 'Agents reply in character. "Speakers choose" lets each pick who answers, and brings in anyone left out.'} Everyone shares one workspace folder.</p>`;
  }

  // --- Canvas ---
  function currentFocus() {
    if (replay) {
      const m = shown()[replay.i];
      return m ? { msg: m, typing: false } : null;
    }
    const running = pg.messages.find((m) => m.status === 'running');
    if (running) return { msg: running, typing: true };
    const last = shown().at(-1);
    return last ? { msg: last, typing: false } : null;
  }

  function renderStage() {
    const nodes = $('#nodes', root);
    if (dragging) return;
    const focus = currentFocus();
    const speakerId = focus ? (focus.msg.kind === 'user' ? 'you' : focus.msg.agentId) : null;
    const hasYou = pg.messages.some((m) => m.kind === 'user') || focus?.msg.to === 'you';
    const people = [...pg.agents, ...(hasYou ? [YOU] : [])];
    nodes.innerHTML = people.map((a) => {
      const you = a === YOU;
      const model = you ? 'You' : a.model ? a.model.replace(/^claude-/, '') : meta.providers[a.provider]?.name || a.provider;
      return `<div class="node ${you ? 'you' : `c${a.color}`} ${a.id === speakerId ? 'speaking' : ''} ${a.id === selected ? 'selected' : ''}" data-aid="${a.id}" data-x="${a.x}" data-y="${a.y}" ${you ? '' : 'tabindex="0" role="button"'} aria-label="${esc(a.name)}">
        <div class="avatar">${esc(initials(a.name))}</div>
        <div class="node-name">${esc(a.name)}${a.id === pg.headId ? ' <span class="crown">Head</span>' : ''}</div>
        <div class="node-role">${esc(model)}</div>
      </div>`;
    }).join('');
    placeAll(nodes);
    $('#canvas-hint', root).textContent = replay ? '' : pg.agents.length ? 'Click empty space to add an agent. Drag to move. Click an agent to edit it.' : 'Click anywhere to add your first agent.';
    $('#canvas', root).classList.toggle('replaying', Boolean(replay));
    drawBubble(focus);
  }

  function drawBubble(focus) {
    const bubbles = $('#bubbles', root);
    const line = $('#arrow-line', root);
    line.setAttribute('visibility', 'hidden');
    if (!focus) { bubbles.innerHTML = ''; return; }
    const { msg, typing } = focus;
    const who = agentOf(msg.kind === 'user' ? 'you' : msg.agentId);
    if (!who) { bubbles.innerHTML = ''; return; }
    const text = typing ? '' : summaryOf(msg);
    const below = who.y < 30;
    const color = who === YOU ? 'you' : `c${who.color}`;
    const key = `${msg.id}:${typing}:${sizeOf()}`;
    if (bubbles.dataset.key !== key) {
      bubbles.dataset.key = key;
      bubbles.innerHTML = `<div class="bubble ${color} ${below ? 'below' : ''} ${typing ? 'typing' : ''}" data-x="${who.x}" data-y="${who.y}">${typing ? '<span></span><span></span><span></span>' : esc(text)}</div>`;
      placeAll(bubbles);
      // Keeps the bubble inside the canvas, with its tail still pointing at the speaker.
      const el = bubbles.firstElementChild;
      const c = $('#canvas', root).getBoundingClientRect();
      const half = el.offsetWidth / 2;
      const x = (who.x * c.width) / 100;
      const fit = Math.min(Math.max(x, half + 8), c.width - half - 8);
      el.style.left = `${fit}px`;
      el.style.setProperty('--tail', `${x - fit}px`);
    }
    const target = msg.to ? agentOf(msg.to) : null;
    if (target && target !== who && !typing) {
      const c = $('#canvas', root).getBoundingClientRect();
      const [x1, y1, x2, y2] = [who.x * c.width / 100, who.y * c.height / 100, target.x * c.width / 100, target.y * c.height / 100];
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const pad = 34;
      line.setAttribute('x1', x1 + ((x2 - x1) * pad) / len);
      line.setAttribute('y1', y1 + ((y2 - y1) * pad) / len);
      line.setAttribute('x2', x2 - ((x2 - x1) * pad) / len);
      line.setAttribute('y2', y2 - ((y2 - y1) * pad) / len);
      line.setAttribute('class', who === YOU ? 'you' : `c${who.color}`);
      line.setAttribute('visibility', 'visible');
    }
  }

  // --- Side panel ---
  function renderSide() {
    const side = $('#side', root);
    if (side.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) {
      if (panel === 'chat') renderMessages();
      return;
    }
    if (panel === 'agent' && selected && pg.agents.some((a) => a.id === selected)) return renderAgentEditor(side);
    if (panel === 'files') return renderFiles(side);
    panel = 'chat';
    if (!$('#timeline', side)) {
      side.innerHTML = `<div class="side-head"><strong>Conversation</strong><span class="muted small" id="side-count"></span></div>
        <div class="timeline" id="timeline"></div>
        <form class="composer" id="composer">
          <textarea name="text" rows="2" placeholder="Join in as You…" aria-label="Your message"></textarea>
          <div class="composer-row"><label class="small">To <select name="to"></select></label><button class="primary" type="submit">Send</button></div>
        </form>`;
      sigs.clear();
    }
    const to = $('#composer select', side);
    const keep = to.value;
    to.innerHTML = `<option value="">Everyone</option>${pg.agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}`;
    to.value = pg.agents.some((a) => a.id === keep) ? keep : '';
    $('#composer', side).hidden = Boolean(replay);
    renderMessages();
  }

  function msgHtml(m, index) {
    const a = m.kind === 'user' ? YOU : agentOf(m.agentId);
    const to = m.to ? agentOf(m.to)?.name : m.kind === 'user' ? 'Everyone' : '';
    const color = m.kind === 'user' ? 'you' : `c${a?.color ?? 0}`;
    const running = m.status === 'running';
    const key = (s) => `${m.id}:${s}`;
    const editing = edits.has(m.id);
    const actions = [];
    if (running) actions.push(['end', 'End turn'], ['stop', 'Stop']);
    if (m.status === 'done' && !replay) actions.push(['edit', 'Edit'], ['rerun', m.kind === 'agent' ? 'Re-run from here' : 'Remove and continue']);
    if (['failed', 'stopped'].includes(m.status)) actions.push(['rerun', 'Retry'], ['skip', 'Skip']);
    if (m.kind === 'agent' && !replay) actions.push(['prompt', 'Prompt']);
    const sum = m.status === 'done' ? summaryOf(m) : '';
    return `<article class="msg ${color} ${m.kind} status-${m.status} ${replay && index === replay.i ? 'current' : ''}" data-mid="${m.id}">
      <header><span class="dot"></span><strong>${esc(m.name || a?.name || 'Agent')}</strong>${to ? ` <span class="muted">→ ${esc(to)}</span>` : ''}
        <span class="muted small msg-meta">${running ? 'typing…' : m.status === 'done' ? '' : esc(m.status)}${m.edited ? ' · edited' : ''}${m.done ? ' · finished' : ''}${m.hurried ? ' · hurried' : ''}${m.endedEarly ? ' · ended early' : ''}</span></header>
      ${sum ? `<p class="msg-sum">${esc(sum)}</p>` : ''}
      ${running ? `<div class="msg-live prose">${markdown(stripMarkers(m.text)) || '<p class="muted small">Thinking…</p>'}</div>` : ''}
      ${m.error ? `<div class="notice ${m.status === 'failed' ? 'bad' : ''}">${esc(m.error).replace(/\n/g, '<br>')}</div>` : ''}
      ${editing ? `<div class="editor"><textarea data-edit="${m.id}" aria-label="Message">${esc(edits.get(m.id))}</textarea><div class="editor-actions"><button class="primary" data-act="save">Save</button><button data-act="cancel">Cancel</button></div></div>`
        : m.status !== 'running' && m.text && m.kind === 'agent' ? `<details data-sec="${key('full')}" ${openSecs.has(key('full')) ? 'open' : ''}><summary>Full message</summary><div class="prose">${markdown(m.text)}</div></details>` : ''}
      ${m.kind === 'user' && !editing && sum !== m.text ? `<div class="prose">${markdown(m.text)}</div>` : ''}
      ${m.activity?.length ? `<details data-sec="${key('work')}" ${openSecs.has(key('work')) || running ? 'open' : ''}><summary>Working steps <span data-count>${m.activity.length}</span></summary><ul class="activity">${m.activity.map((x) => `<li class="act ${x.kind} ${x.status}"><span class="act-dot"></span><div><div class="act-title">${esc(x.title)}</div></div></li>`).join('')}</ul></details>` : ''}
      <div class="prompt-slot"></div>
      ${actions.length ? `<footer class="msg-actions">${actions.map(([k, l]) => `<button class="link" data-act="${k}">${l}</button>`).join('')}</footer>` : ''}
    </article>`;
  }

  function renderMessages() {
    const tl = $('#timeline', root);
    if (!tl) return;
    const list = replay ? shown().slice(0, replay.i + 1) : pg.messages;
    $('#side-count', root).textContent = replay ? `Replay ${replay.i + 1} of ${shown().length}` : `${pg.turns} of ${pg.limit} turns`;
    const stick = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 80;
    const ids = list.map((m) => m.id).join();
    if (tl.dataset.ids !== ids) {
      tl.dataset.ids = ids;
      tl.innerHTML = list.length ? list.map((m) => `<div data-slot="${m.id}"></div>`).join('') : '<p class="muted small empty-chat">Nobody has spoken yet.</p>';
      sigs.clear();
    }
    list.forEach((m, i) => {
      const slot = tl.querySelector(`[data-slot="${m.id}"]`);
      const sig = JSON.stringify([m, sizeOf(), edits.has(m.id), replay?.i === i, Boolean(replay)]);
      if (!slot || sigs.get(m.id) === sig) return;
      if (slot.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') return;
      sigs.set(m.id, sig);
      slot.innerHTML = msgHtml(m, i);
    });
    if (replay) tl.querySelector('.msg.current')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    else if (stick) tl.scrollTop = tl.scrollHeight;
  }

  function updateLive(m) {
    if (updateLive.t) return;
    updateLive.t = setTimeout(() => {
      updateLive.t = null;
      sigs.delete(m.id);
      if (panel === 'chat' && !replay) renderMessages();
    }, 120);
  }

  function renderAgentEditor(side) {
    const a = pg.agents.find((x) => x.id === selected);
    const options = Object.entries(meta.providers).map(([p, info]) => `<optgroup label="${esc(info.name)}"><option value="${p}:">${esc(info.name)} (default model)</option>${info.models.map((mo) => `<option value="${p}:${esc(mo.id)}">${esc(mo.label)}</option>`).join('')}</optgroup>`).join('');
    const entry = meta.providers[a.provider]?.models.find((mo) => mo.id === a.model);
    const efforts = entry?.efforts || meta.providers[a.provider]?.efforts || [];
    side.innerHTML = `<div class="side-head"><strong>Agent</strong><button class="link" data-do="close-panel">Back to conversation</button></div>
      <div class="agent-editor c${a.color}">
        <div class="agent-hero"><div class="avatar">${esc(initials(a.name))}</div><div class="colors">${[...Array(8).keys()].map((c) => `<button class="swatch c${c}" data-color="${c}" aria-label="Color ${c + 1}" aria-pressed="${a.color === c}"></button>`).join('')}</div></div>
        <label>Name<input data-agent="name" maxlength="40" value="${esc(a.name)}"></label>
        <label>Role<textarea data-agent="role" rows="5" placeholder="What does this agent do, believe, or care about?">${esc(a.role)}</textarea></label>
        <div class="presets"><span class="muted small">Use a preset:</span>${meta.presets.map((p) => `<button class="chip" data-preset="${esc(p.name)}">${esc(p.name)}</button>`).join('')}</div>
        <label>Model<select data-agent="model">${options}</select></label>
        <label>Effort and thinking<select data-agent="effort"><option value="">Default</option>${efforts.map((e) => `<option value="${e}" ${a.effort === e ? 'selected' : ''}>${EFFORT_LABEL[e] || e}</option>`).join('')}</select></label>
        ${pg.mode === 'project' ? `<label class="check"><input type="checkbox" data-agent="head" ${a.id === pg.headId ? 'checked' : ''}> Head of the project</label>` : ''}
        <p class="muted small">Changes apply from this agent's next turn.</p>
        <button class="danger" data-do="remove-agent">Remove agent</button>
      </div>`;
    $('[data-agent="model"]', side).value = `${a.provider}:${a.model}`;
  }

  async function renderFiles(side) {
    if ($('#pg-files', side)) return;
    side.innerHTML = `<div class="side-head"><strong>Workspace files</strong><button class="link" data-do="close-panel">Back to conversation</button></div><div id="pg-files"><p class="muted small">Loading…</p></div>`;
    const { files } = await api(path('/files'));
    const box = $('#pg-files', side);
    if (!box) return;
    box.innerHTML = `<div class="doc-bar"><span class="muted small">${files.length} file${files.length === 1 ? '' : 's'}</span><button class="link" data-do="refresh-files">Refresh</button></div>
      ${files.map((f) => `<button class="file" data-file="${esc(f.path)}">${esc(f.path)}</button>`).join('') || '<p class="muted small">No files yet. Anything the agents create appears here.</p>'}
      <div id="pg-file-view"></div>`;
  }

  // --- Replay ---
  function renderReplayBar() {
    const bar = $('#replay-bar', root);
    bar.hidden = !replay;
    if (!replay) return;
    const total = shown().length;
    bar.innerHTML = `
      <button data-rp="prev" aria-label="Previous message">⏮</button>
      <button class="primary" data-rp="toggle" aria-label="${replay.playing ? 'Pause' : 'Play'}">${replay.playing ? '⏸' : '▶'}</button>
      <button data-rp="next" aria-label="Next message">⏭</button>
      <input type="range" min="0" max="${Math.max(total - 1, 0)}" value="${replay.i}" data-rp="scrub" aria-label="Position in replay">
      <span class="small muted">${replay.i + 1} / ${total}</span>
      <label class="small">Speed <select data-rp="speed">${SPEEDS.map((s) => `<option value="${s}" ${replay.speed === s ? 'selected' : ''}>${s}×</option>`).join('')}</select></label>`;
  }

  function schedule() {
    clearTimeout(replay?.timer);
    if (!replay?.playing) return;
    const m = shown()[replay.i];
    const delay = (1600 + words(summaryOf(m)) * 330) / replay.speed;
    replay.timer = setTimeout(() => {
      if (!replay) return;
      if (replay.i >= shown().length - 1) { replay.playing = false; render(); return; }
      replay.i += 1;
      render();
      schedule();
    }, delay);
  }

  function setReplay(i, playing = replay.playing) {
    replay.i = Math.max(0, Math.min(shown().length - 1, i));
    replay.playing = playing;
    render();
    schedule();
  }

  // --- Events ---
  const patchAgent = (body) => call(`/agents/${selected}`, 'PATCH', body);

  root.addEventListener('click', guard(async (e) => {
    const b = e.target.closest('button');
    const canvas = e.target.closest('#canvas');
    if (canvas && !b) {
      const node = e.target.closest('.node');
      if (node || replay) return;
      if (e.target.closest('.bubble')) return;
      const r = canvas.getBoundingClientRect();
      const data = await call('/agents', 'POST', { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 });
      selected = data.agentId;
      panel = 'agent';
      render();
      return;
    }
    if (!b) return;
    const d = b.dataset;
    if (d.do === 'start') return call('/start');
    if (d.do === 'pause') return call('/pause');
    if (d.do === 'resume') return call('/resume');
    if (d.do === 'stop') return call('/stop');
    if (d.do === 'end') return call('/end');
    if (d.do === 'hurry') {
      await call('/hurry', 'POST', { on: !pg.hurry });
      toast(pg.hurry ? `Hurrying: low effort and short replies from the next turn, finishing by turn ${pg.limit}.` : 'Back to normal.');
      return undefined;
    }
    if (d.do === 'files') { panel = panel === 'files' ? 'chat' : 'files'; $('#side', root).innerHTML = ''; return render(); }
    if (d.do === 'close-panel') { panel = 'chat'; selected = null; $('#side', root).innerHTML = ''; return render(); }
    if (d.do === 'refresh-files') { $('#side', root).innerHTML = ''; return render(); }
    if (d.do === 'replay') {
      if (replay) { clearTimeout(replay.timer); replay = null; sigs.clear(); return render(); }
      replay = { i: 0, playing: true, speed: 1, timer: null };
      panel = 'chat'; selected = null; $('#side', root).innerHTML = '';
      return setReplay(0, true);
    }
    if (d.do === 'remove-agent') {
      if (!confirm('Remove this agent? Its past messages stay in the conversation.')) return undefined;
      const aid = selected;
      selected = null; panel = 'chat'; $('#side', root).innerHTML = '';
      return call(`/agents/${aid}`, 'DELETE');
    }
    if (d.size) { pg.summarySize = d.size; sigs.clear(); render(); return call('', 'PATCH', { summarySize: d.size }); }
    if (d.rp) {
      if (d.rp === 'prev') return setReplay(replay.i - 1, false);
      if (d.rp === 'next') return setReplay(replay.i + 1, false);
      if (d.rp === 'toggle') {
        const atEnd = replay.i >= shown().length - 1;
        return setReplay(atEnd && !replay.playing ? 0 : replay.i, !replay.playing);
      }
      return undefined;
    }
    if (d.color !== undefined) return patchAgent({ color: Number(d.color) });
    if (d.preset) {
      const p = meta.presets.find((x) => x.name === d.preset);
      return patchAgent({ name: p.name, role: p.role }).catch((err) => { toast(err.message); return patchAgent({ role: p.role }); });
    }
    if (d.file) {
      const f = await api(path(`/file?path=${encodeURIComponent(d.file)}`));
      file = d.file;
      $('#pg-file-view', root).innerHTML = `<div class="doc-bar"><strong class="small">${esc(d.file)}</strong>${f.binary ? '' : '<button class="primary" data-do="save-file">Save</button>'}</div>${f.binary ? `<p class="muted">${esc(f.note)}</p>` : `<textarea id="pg-file-editor" spellcheck="false" aria-label="File contents">${esc(f.content)}</textarea>`}`;
      return undefined;
    }
    if (d.do === 'save-file') { await api(path('/file'), 'PUT', { path: file, content: $('#pg-file-editor', root).value }); toast('Saved.'); return undefined; }

    const mid = b.closest('[data-mid]')?.dataset.mid;
    if (!d.act || !mid) return undefined;
    const m = pg.messages.find((x) => x.id === mid);
    if (d.act === 'stop') return call('/stop');
    if (d.act === 'end') return call('/end');
    if (d.act === 'skip') return call(`/messages/${mid}/skip`);
    if (d.act === 'rerun') {
      const later = pg.messages.length - 1 - pg.messages.indexOf(m);
      if (later > 0 && !confirm(`This replaces this message and the ${later} after it. They are kept in the playground file. Continue?`)) return undefined;
      return call(`/messages/${mid}/rerun`);
    }
    if (d.act === 'edit') { edits.set(mid, m.text); sigs.delete(mid); return renderMessages(); }
    if (d.act === 'cancel') { edits.delete(mid); sigs.delete(mid); return renderMessages(); }
    if (d.act === 'save') { await call(`/messages/${mid}`, 'PATCH', { text: edits.get(mid) }); edits.delete(mid); sigs.delete(mid); return renderMessages(); }
    if (d.act === 'prompt') {
      const slot = b.closest('.msg').querySelector('.prompt-slot');
      if (slot.innerHTML) { slot.innerHTML = ''; return undefined; }
      const { prompt } = await api(path(`/messages/${mid}/prompt`));
      slot.innerHTML = `<pre class="prompt">${esc(prompt || 'No prompt was saved for this message.')}</pre>`;
    }
    return undefined;
  }));

  root.addEventListener('change', guard(async (e) => {
    const t = e.target;
    if (t.dataset.field) {
      const v = ['maxTurns', 'headEvery'].includes(t.dataset.field) ? Number(t.value) : t.value;
      return call('', 'PATCH', { [t.dataset.field]: v });
    }
    if (t.id === 'pg-title') return call('', 'PATCH', { title: t.value });
    if (t.dataset.agent === 'model') {
      const [provider, ...rest] = t.value.split(':');
      return patchAgent({ provider, model: rest.join(':'), effort: '' }).then(() => { $('#side', root).innerHTML = ''; render(); });
    }
    if (t.dataset.agent === 'head') return patchAgent({ head: t.checked });
    if (t.dataset.agent) return patchAgent({ [t.dataset.agent]: t.value });
    if (t.dataset.rp === 'speed') { replay.speed = Number(t.value); return schedule(); }
    return undefined;
  }));

  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.edit) edits.set(t.dataset.edit, t.value);
    if (t.dataset.rp === 'scrub') setReplay(Number(t.value), false);
  });

  root.addEventListener('toggle', (e) => {
    const sec = e.target.dataset?.sec;
    if (!sec) return;
    if (e.target.open) openSecs.add(sec); else openSecs.delete(sec);
  }, true);

  root.addEventListener('submit', guard(async (e) => {
    if (e.target.id !== 'composer') return;
    e.preventDefault();
    const f = e.target;
    const text = f.text.value.trim();
    if (!text) return;
    await call('/messages', 'POST', { text, to: f.to.value || null });
    f.text.value = '';
  }));

  root.addEventListener('keydown', (e) => {
    if (e.target.name === 'text' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.target.form.requestSubmit(); }
    if (e.target.classList?.contains('node') && e.key === 'Enter' && !replay) {
      selected = e.target.dataset.aid;
      panel = 'agent';
      $('#side', root).innerHTML = '';
      render();
    }
  });

  // Dragging agents, and clicking one to edit it.
  root.addEventListener('pointerdown', (e) => {
    const node = e.target.closest('.node');
    if (!node || replay || node.dataset.aid === 'you' || e.button !== 0) return;
    const canvas = $('#canvas', root).getBoundingClientRect();
    dragging = { node, id: node.dataset.aid, startX: e.clientX, startY: e.clientY, moved: false, canvas };
    node.setPointerCapture(e.pointerId);
  });
  root.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (Math.hypot(e.clientX - dragging.startX, e.clientY - dragging.startY) > 4) dragging.moved = true;
    if (!dragging.moved) return;
    const { canvas, node } = dragging;
    dragging.x = Math.min(97, Math.max(3, ((e.clientX - canvas.left) / canvas.width) * 100));
    dragging.y = Math.min(95, Math.max(5, ((e.clientY - canvas.top) / canvas.height) * 100));
    node.style.left = `${dragging.x}%`;
    node.style.top = `${dragging.y}%`;
  });
  root.addEventListener('pointerup', guard(async () => {
    if (!dragging) return;
    const d = dragging;
    dragging = null;
    if (d.moved) {
      const a = pg.agents.find((x) => x.id === d.id);
      Object.assign(a, { x: d.x, y: d.y });
      await call(`/agents/${d.id}`, 'PATCH', { x: d.x, y: d.y });
      return;
    }
    selected = selected === d.id && panel === 'agent' ? null : d.id;
    panel = selected ? 'agent' : 'chat';
    $('#side', root).innerHTML = '';
    render();
  }));

  const onResize = () => { if (pg && meta) drawBubble(currentFocus()); };
  window.addEventListener('resize', onResize);

  return () => {
    disposed = true;
    es.close();
    clearTimeout(replay?.timer);
    window.removeEventListener('resize', onResize);
  };
}

import { esc, markdown } from '/markdown.js';
import { renderNew } from '/new-run.js';

const EFFORT_LABEL = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };
const STATE_LABEL = { running: 'Running', pausing: 'Pausing after current step', paused: 'Paused', attention: 'Needs attention', complete: 'Complete' };
const STATUS_LABEL = { pending: 'Waiting', running: 'Working', done: 'Done', failed: 'Failed', stopped: 'Stopped', skipped: 'Skipped' };
const PHASES = [
  { key: 'independent', title: 'Independent work', note: 'Each works alone, without seeing the other.', match: (s) => s.kind === 'independent', layout: 'pair' },
  { key: 'revise', title: 'Cross-review', note: "Each reviews the other's answer, then revises its own.", match: (s) => s.kind === 'revise', layout: 'pair' },
  { key: 'dialogue', title: 'Conversation', note: 'They talk directly, up to your turn limit.', match: (s) => s.kind === 'turn', layout: 'chat' },
  { key: 'final', title: 'Combined document', note: 'One drafts, the other checks, and the first applies the fixes.', match: (s) => s.kind.startsWith('final'), layout: 'stack' },
];

const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');
const ui = { run: null, tab: 'workflow', source: null, edits: new Map(), toggled: new Map(), sigs: new Map(), dirty: new Set(), layout: '', file: null, docEdit: null, rulesDraft: null };

async function api(path, method = 'GET', body) {
  const opts = { method };
  if (method !== 'GET') { opts.headers = { 'content-type': 'application/json' }; opts.body = JSON.stringify(body ?? {}); }
  const res = await fetch(`/api${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 5000);
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message); } };
const stepOf = (id) => ui.run?.steps.find((s) => s.id === id);
const seatName = (seat) => ui.run.seats[seat].name;
const seatClass = (seat) => {
  const { a, b } = ui.run.seats;
  return `agent-${ui.run.seats[seat].provider} seat-${seat}${a.provider === b.provider && seat === 'b' ? ' alt' : ''}`;
};
// Hides the end-of-reply markers while an answer is still streaming.
const visibleOutput = (s) => (s.status === 'running' ? s.output.replace(/\s*\[\[(?:S|A)[\s\S]*$/, '') : s.output);
const runPath = (rest = '') => `/runs/${ui.run.id}${rest}`;
const applyRun = (data) => { if (data.run && data.run.id === ui.run?.id) { ui.run = data.run; renderRun(); } };

function duration(s) {
  if (!s.startedAt) return '';
  const secs = Math.max(0, Math.round(((s.endedAt ? new Date(s.endedAt) : Date.now()) - new Date(s.startedAt)) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
}

// --- Sidebar ---
const runsSource = new EventSource('/api/runs/events');
runsSource.addEventListener('runs', (e) => {
  const { runs } = JSON.parse(e.data);
  $('#run-list').innerHTML = runs.length
    ? runs.map((r) => `<a href="#/run/${r.id}" class="${r.id === ui.run?.id ? 'active' : ''}"><span class="dot state-${r.state}"></span><span class="run-name">${esc(r.title)}</span></a>`).join('')
    : '<p class="muted small">No runs yet.</p>';
});

// --- Run page ---
function openRun(id) {
  ui.source?.close();
  Object.assign(ui, { run: null, tab: 'workflow', layout: '', file: null, docEdit: null, rulesDraft: null, bulk: null });
  ui.edits.clear(); ui.toggled.clear(); ui.sigs.clear();
  main.innerHTML = '<div class="page"><p class="muted">Loading…</p></div>';
  const es = new EventSource(`/api/runs/${id}/events`);
  ui.source = es;
  es.addEventListener('snapshot', (e) => { ui.run = JSON.parse(e.data).run; renderRun(); });
  es.addEventListener('delta', (e) => { const d = JSON.parse(e.data); const s = stepOf(d.stepId); if (s) { s.output += d.text; markLive(s.id); } });
  es.addEventListener('replace', (e) => { const d = JSON.parse(e.data); const s = stepOf(d.stepId); if (s) { s.output = d.text; markLive(s.id); } });
  es.addEventListener('activity', (e) => {
    const d = JSON.parse(e.data); const s = stepOf(d.stepId);
    if (!s) return;
    const i = s.activity.findIndex((a) => a.id === d.item.id);
    if (i >= 0) s.activity[i] = d.item; else s.activity.push(d.item);
    markLive(s.id);
  });
}

function shell() {
  main.innerHTML = `<div class="page">
    <header class="run-head" id="run-head"></header>
    <ol class="stepper" id="stepper"></ol>
    <div class="tabs" role="tablist">${[['workflow', 'Workflow'], ['document', 'Combined document'], ['files', 'Files'], ['setup', 'Setup']].map(([k, l]) => `<button role="tab" data-tab="${k}">${l}</button>`).join('')}</div>
    <section id="tab-body"></section></div>`;
  ui.layout = '';
}

function renderRun() {
  const r = ui.run;
  if (!r) return;
  if (!$('#run-head')) shell();
  document.title = `${r.title} · Council`;
  document.querySelectorAll('#run-list a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#/run/${r.id}`));
  const canPause = !r.paused && r.state !== 'complete';
  const canResume = r.paused && r.state !== 'complete';
  $('#run-head').innerHTML = `
    <div><h1>${esc(r.title)}</h1><span class="pill state-${r.state}">${STATE_LABEL[r.state]}</span></div>
    <div class="head-actions">
      <label class="turns">Stance <select id="run-stance" title="How adversarial the participants are">${r.stances.map((s) => `<option value="${s.id}" ${s.id === r.stance ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select></label>
      <label class="turns">Max turns <input id="max-turns" type="number" min="0" max="50" value="${r.maxTurns}" ${stepOf('final-draft').status !== 'pending' ? 'disabled' : ''}></label>
      ${canPause ? '<button data-run="pause">Pause</button>' : ''}${canResume ? '<button class="primary" data-run="resume">Resume</button>' : ''}
    </div>`;
  $('#stepper').innerHTML = PHASES.map((p) => {
    const steps = r.steps.filter(p.match);
    const done = steps.filter((s) => ['done', 'skipped'].includes(s.status)).length;
    const status = steps.some((s) => ['failed', 'stopped'].includes(s.status)) ? 'blocked' : steps.some((s) => s.status === 'running') ? 'active' : steps.length && done === steps.length ? 'finished' : steps.length ? 'upcoming' : 'finished';
    return `<li class="${status}"><span class="phase-name">${p.title}</span><span class="small muted">${done}/${steps.length}</span></li>`;
  }).join('');
  document.querySelectorAll('[data-tab]').forEach((b) => { b.setAttribute('aria-selected', b.dataset.tab === ui.tab); });
  renderTab();
}

function renderTab() {
  if (ui.tab === 'workflow') return renderWorkflow();
  ui.layout = '';
  ui.sigs.clear();
  if (ui.tab === 'document') return renderDocument();
  if (ui.tab === 'files') { if (!$('#files-view')) renderFiles(); return undefined; }
  return renderSetup();
}

function renderWorkflow() {
  const body = $('#tab-body');
  const layout = ui.run.steps.map((s) => s.id).join();
  if (ui.layout !== layout) {
    ui.layout = layout;
    ui.sigs.clear();
    body.innerHTML = '<div class="view-bar"><span class="muted small">Prompts, working steps, and replies</span><button data-bulk="collapse">Collapse all</button><button data-bulk="expand">Expand all</button></div>' + PHASES.map((p) => {
      const steps = ui.run.steps.filter(p.match);
      return `<section class="phase"><header><h2>${p.title}</h2><p class="muted small">${p.note}</p></header>
        <div class="cards ${p.layout}">${steps.map((s) => `<article id="card-${s.id}"></article>`).join('') || '<p class="muted small">No turns in this run.</p>'}</div></section>`;
    }).join('');
  }
  ui.run.steps.forEach(renderCard);
}

const editKey = (id, field) => `${id}:${field}`;
// Order: an open editor, then your click on that section, then Collapse/Expand all, then the default.
function isOpen(s, sec) {
  if (sec === 'prompt' && ui.edits.has(editKey(s.id, 'prompt'))) return true;
  return ui.toggled.get(editKey(s.id, sec)) ?? ui.bulk ?? (sec === 'output' || (sec === 'activity' && s.status === 'running'));
}

function activityHtml(s) {
  return s.activity.map((a) => `<li class="act ${a.kind} ${a.status}"><span class="act-dot"></span><div><div class="act-title">${esc(a.title)}</div>${a.detail || a.result ? `<details><summary>Details</summary>${a.detail ? `<pre>${esc(a.detail)}</pre>` : ''}${a.result ? `<pre>${esc(a.result)}</pre>` : ''}</details>` : ''}</div></li>`).join('') || '<li class="muted small">Nothing yet.</li>';
}

function outputHtml(s) {
  const text = visibleOutput(s);
  if (text) return `<div class="prose">${markdown(text)}</div>${s.status === 'running' ? '<span class="cursor"></span>' : ''}`;
  if (s.status === 'running') return '<p class="muted small working">Working…</p>';
  return '';
}

function editor(key, value, label) {
  return `<div class="editor"><textarea data-edit="${esc(key)}" aria-label="${label}">${esc(ui.edits.get(key) ?? value)}</textarea><div class="editor-actions"><button class="primary" data-act="save" data-key="${esc(key)}">Save</button><button data-act="cancel" data-key="${esc(key)}">Cancel</button></div></div>`;
}

function renderCard(s) {
  const el = $(`#card-${s.id}`);
  if (!el) return;
  const pk = editKey(s.id, 'prompt'); const ok = editKey(s.id, 'output');
  const sig = JSON.stringify([s, ui.edits.has(pk), ui.edits.has(ok), ui.bulk, ...['prompt', 'activity', 'output'].map((sec) => ui.toggled.get(editKey(s.id, sec)))]);
  if (ui.sigs.get(s.id) === sig) return;
  if (el.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') return;
  const prevScroll = $('.output', el)?.scrollTop;
  ui.sigs.set(s.id, sig);
  ui.dirty.delete(s.id);
  const running = s.status === 'running';
  const buttons = [];
  if (running) buttons.push(['stop', 'Stop']);
  if (s.status === 'done') buttons.push(['edit-output', 'Edit answer'], ['rerun', s.stale ? 'Re-run with changes' : 'Re-run from here']);
  if (['failed', 'stopped', 'skipped'].includes(s.status)) buttons.push(['rerun', s.status === 'skipped' ? 'Run this step' : 'Retry']);
  if (['pending', 'failed', 'stopped'].includes(s.status)) buttons.push(['edit-output', 'Write answer'], ['skip', 'Skip']);
  const notices = [];
  if (s.error) notices.push(`<div class="notice ${s.status === 'failed' ? 'bad' : ''}">${esc(s.error).replace(/\n/g, '<br>')}</div>`);
  if (s.stale) notices.push('<div class="notice warn">Something this step relied on has changed. Re-run to use the update.</div>');
  if (s.skipReason) notices.push(`<div class="notice">${esc(s.skipReason)}</div>`);
  const tags = [s.manual && 'written by you', s.originalOutput != null && 'edited by you', s.promptEdited && 'prompt edited', s.agreed && 'agreed'].filter(Boolean);
  el.className = `card ${seatClass(s.agent)} status-${s.status}`;
  el.innerHTML = `
    <header class="card-head">
      <div class="who"><span class="avatar"></span><div><strong>${esc(seatName(s.agent))}</strong><span class="muted small">${esc(s.title)}</span></div></div>
      <div class="card-state"><span class="status">${STATUS_LABEL[s.status]}</span><span class="muted small" data-elapsed="${s.id}">${duration(s)}</span></div>
    </header>
    ${s.summary ? `<p class="summary">${esc(s.summary)}${s.originalOutput != null ? ' <span class="muted">(written before your edit)</span>' : ''}</p>` : ''}
    ${tags.length ? `<div class="tags">${tags.map((t) => `<span>${t}</span>`).join('')}</div>` : ''}
    ${notices.join('')}
    <details data-sec="prompt" ${isOpen(s, 'prompt') ? 'open' : ''}><summary>Prompt</summary>
      ${ui.edits.has(pk) ? editor(pk, s.prompt, 'Prompt') : `<pre class="prompt">${esc(s.prompt)}</pre>${running ? '' : `<div class="inline-actions"><button class="link" data-act="edit-prompt">Edit prompt</button>${s.promptEdited ? '<button class="link" data-act="reset-prompt">Use automatic prompt</button>' : ''}</div>`}`}
    </details>
    <details data-sec="activity" ${isOpen(s, 'activity') ? 'open' : ''}><summary>Working steps <span data-count>${s.activity.length}</span></summary><ul class="activity">${activityHtml(s)}</ul></details>
    ${ui.edits.has(ok) ? editor(ok, s.output, 'Answer') : outputHtml(s) ? `<details data-sec="output" ${isOpen(s, 'output') ? 'open' : ''}><summary>Reply</summary><div class="output">${outputHtml(s)}</div></details>` : ''}
    ${buttons.length ? `<footer class="card-actions">${buttons.map(([a, l]) => `<button data-act="${a}">${l}</button>`).join('')}</footer>` : ''}`;
  el.dataset.step = s.id;
  if (prevScroll) $('.output', el).scrollTop = prevScroll;
}

function markLive(id) {
  ui.dirty.add(id);
  if (markLive.timer) return;
  markLive.timer = setTimeout(() => {
    markLive.timer = null;
    for (const sid of ui.dirty) {
      const s = stepOf(sid); const el = $(`#card-${sid}`);
      if (!s || !el) continue;
      const out = $('.output', el);
      if (out) {
        const stick = out.scrollHeight - out.scrollTop - out.clientHeight < 60;
        out.innerHTML = outputHtml(s);
        if (stick) out.scrollTop = out.scrollHeight;
      }
      const list = $('.activity', el);
      if (list) list.innerHTML = activityHtml(s);
      const count = $('[data-count]', el);
      if (count) count.textContent = s.activity.length;
    }
    ui.dirty.clear();
    if (ui.tab === 'document' && !ui.docEdit) renderDocument();
  }, 100);
}

function laterWorkExists(s) {
  const steps = ui.run.steps; const at = steps.findIndex((x) => x.group === s.group);
  return steps.slice(at).some((x) => x.group !== s.group && x.startedAt);
}

async function cardAction(act, s, key) {
  const pk = editKey(s.id, 'prompt'); const ok = editKey(s.id, 'output');
  const patch = (b) => api(runPath(`/steps/${s.id}`), 'PATCH', b).then(applyRun);
  const post = (a) => api(runPath(`/steps/${s.id}/${a}`), 'POST').then(applyRun);
  const redraw = () => { ui.sigs.delete(s.id); renderCard(s); };
  if (act === 'stop') return post('stop');
  if (act === 'skip') return post('skip');
  if (act === 'rerun') {
    if (laterWorkExists(s) && !confirm('Re-run this step and every step after it? Previous versions are kept in the run file, but later answers here will be replaced.')) return undefined;
    return post('rerun');
  }
  if (act === 'edit-output') { ui.edits.set(ok, s.output); return redraw(); }
  if (act === 'edit-prompt') { ui.edits.set(pk, s.prompt); ui.toggled.set(pk, true); return redraw(); }
  if (act === 'reset-prompt') return patch({ prompt: null });
  if (act === 'cancel') { ui.edits.delete(key); return redraw(); }
  if (act === 'save') {
    const field = key.endsWith(':prompt') ? 'prompt' : 'output';
    await patch({ [field]: ui.edits.get(key) });
    ui.edits.delete(key);
    return redraw();
  }
  return undefined;
}

// --- Combined document ---
function renderDocument() {
  const body = $('#tab-body');
  const s = stepOf(ui.run.combinedStepId) || ui.run.steps.find((x) => x.kind.startsWith('final') && x.kind !== 'final-check' && x.status === 'running');
  if (ui.docEdit != null && $('#doc-editor')) return;
  if (!s) { body.innerHTML = '<div class="empty"><h2>Not written yet</h2><p class="muted">The combined document appears here once the final phase begins.</p></div>'; return; }
  const ready = s.status === 'done';
  const label = s.id === 'final-apply' ? 'Final version' : ready ? 'Draft, not yet checked' : 'Being written';
  body.innerHTML = `<div class="doc">
    <div class="doc-bar"><span class="muted small">${label}</span><div>${ready ? '<button data-doc="edit">Edit</button><button data-doc="copy">Copy</button><button data-doc="download">Download .md</button>' : ''}</div></div>
    ${ui.docEdit != null ? `<textarea id="doc-editor" aria-label="Combined document">${esc(ui.docEdit)}</textarea><div class="editor-actions"><button class="primary" data-doc="save">Save</button><button data-doc="cancel">Cancel</button></div>` : `<article class="prose page-doc">${markdown(visibleOutput(s))}</article>`}
  </div>`;
}

async function docAction(a) {
  const s = stepOf(ui.run.combinedStepId);
  if (!s) return;
  if (a === 'edit') { ui.docEdit = s.output; renderDocument(); }
  if (a === 'cancel') { ui.docEdit = null; $('#tab-body').innerHTML = ''; renderDocument(); }
  if (a === 'save') {
    const output = $('#doc-editor').value;
    ui.docEdit = null;
    $('#tab-body').innerHTML = '';
    applyRun(await api(runPath(`/steps/${s.id}`), 'PATCH', { output }));
  }
  if (a === 'copy') { await navigator.clipboard.writeText(s.output); toast('Copied.'); }
  if (a === 'download') {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([s.output], { type: 'text/markdown' }));
    link.download = `${ui.run.title.replace(/[^\w -]+/g, '').trim().slice(0, 60) || 'council'}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  }
}

// --- Files ---
async function renderFiles() {
  const body = $('#tab-body');
  body.innerHTML = '<div class="files" id="files-view"><div class="file-list" id="file-list"><p class="muted small">Loading…</p></div><div class="file-pane" id="file-pane"><p class="muted">Pick a file to view or edit it.</p></div></div>';
  const { files } = await api(runPath('/files'));
  $('#file-list').innerHTML = `<div class="doc-bar"><span class="muted small">${files.length} file${files.length === 1 ? '' : 's'}</span><button class="link" data-file-refresh>Refresh</button></div>${files.map((f) => `<button class="file" data-file="${esc(f.path)}">${esc(f.path)}<span class="muted small">${f.size < 1024 ? `${f.size} B` : `${Math.round(f.size / 1024)} KB`}</span></button>`).join('') || '<p class="muted small">No files yet. Anything the agents create appears here.</p>'}`;
}
async function openFile(p) {
  const d = await api(runPath(`/file?path=${encodeURIComponent(p)}`));
  ui.file = p;
  $('#file-pane').innerHTML = `<div class="doc-bar"><strong class="small">${esc(p)}</strong>${d.binary ? '' : '<button class="primary" data-file-save>Save</button>'}</div>${d.binary ? `<p class="muted">${esc(d.note)}</p>` : `<textarea id="file-editor" spellcheck="false" aria-label="File contents">${esc(d.content)}</textarea>`}`;
}

// --- Setup ---
function renderSetup() {
  if ($('#rules') && document.activeElement === $('#rules')) return;
  const r = ui.run;
  $('#tab-body').innerHTML = `<div class="setup">
    <label>Title<input id="run-title" value="${esc(r.title)}" maxlength="200"></label>
    <label><span>Ground rules <span class="muted">(sent ahead of every prompt)</span></span><textarea id="rules" rows="10">${esc(ui.rulesDraft ?? r.groundRules)}</textarea></label>
    <div class="form-actions"><button class="primary" data-setup="save">Save</button><span class="muted small">Steps that already ran are flagged so you can re-run them.</span></div>
    <details class="plain"><summary>Also added to the end of every prompt</summary><pre>${esc(r.promptSuffix)}</pre></details>
    <dl>${['a', 'b'].map((s, i) => `<dt>Participant ${i + 1}</dt><dd>${esc(seatName(s))}, ${esc(r.seats[s].model || 'default model')}, ${esc(EFFORT_LABEL[r.seats[s].effort] || 'default')} effort</dd>`).join('')}<dt>First speaker</dt><dd>${esc(seatName(r.firstSpeaker))}</dd><dt>Document drafter</dt><dd>${esc(seatName(r.drafter))}</dd><dt>Run ID</dt><dd><code>${r.id}</code></dd></dl>
  </div>`;
}

// --- Events ---
main.addEventListener('toggle', (e) => {
  const sec = e.target.dataset?.sec; const id = e.target.closest?.('[data-step]')?.dataset.step;
  if (!sec || !id) return;
  const s = stepOf(id);
  if (s && e.target.open !== isOpen(s, sec)) ui.toggled.set(editKey(id, sec), e.target.open);
}, true);
main.addEventListener('input', (e) => { if (e.target.dataset?.edit) ui.edits.set(e.target.dataset.edit, e.target.value); if (e.target.id === 'doc-editor') ui.docEdit = e.target.value; if (e.target.id === 'rules') ui.rulesDraft = e.target.value; });
main.addEventListener('change', guard(async (e) => {
  if (e.target.id === 'run-stance') applyRun(await api(runPath(), 'PATCH', { stance: Number(e.target.value) }));
  if (e.target.id === 'max-turns') {
    try { applyRun(await api(runPath('/turns'), 'POST', { maxTurns: Number(e.target.value) })); } catch (err) { e.target.value = ui.run.maxTurns; throw err; }
  }
}));
main.addEventListener('click', guard(async (e) => {
  const b = e.target.closest('button');
  if (!b || !ui.run) return;
  const d = b.dataset;
  if (d.tab) { ui.tab = d.tab; $('#tab-body').innerHTML = ''; renderRun(); return; }
  if (d.bulk) { ui.bulk = d.bulk === 'expand'; ui.toggled.clear(); renderWorkflow(); return; }
  if (d.run) { applyRun(await api(runPath(`/${d.run}`), 'POST')); return; }
  if (d.doc) { await docAction(d.doc); return; }
  if ('fileRefresh' in d) { await renderFiles(); return; }
  if (d.file) { await openFile(d.file); return; }
  if ('fileSave' in d) { await api(runPath('/file'), 'PUT', { path: ui.file, content: $('#file-editor').value }); toast('Saved.'); return; }
  if (d.setup) { ui.rulesDraft = null; applyRun(await api(runPath(), 'PATCH', { title: $('#run-title').value, groundRules: $('#rules').value })); toast('Saved.'); return; }
  const id = b.closest('[data-step]')?.dataset.step;
  if (d.act && id) await cardAction(d.act, stepOf(id), d.key);
}));
setInterval(() => document.querySelectorAll('[data-elapsed]').forEach((el) => { const s = stepOf(el.dataset.elapsed); if (s?.status === 'running') el.textContent = duration(s); }), 1000);

function route() {
  const m = location.hash.match(/^#\/run\/([\w-]+)$/);
  if (m) { openRun(m[1]); return; }
  ui.run = null;
  ui.source?.close();
  document.title = 'Council';
  guard(renderNew)({ main, api, guard });
}
window.addEventListener('hashchange', route);
route();

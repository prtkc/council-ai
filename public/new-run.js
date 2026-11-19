import { esc } from '/markdown.js';

const $ = (sel, root = document) => root.querySelector(sel);
const EFFORT_LABEL = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };
const SEATS = [['a', 1, 'claude'], ['b', 2, 'chatgpt']];
const TOOL_INFO = { claude: 'Uses your Claude subscription', chatgpt: 'Uses your ChatGPT plan through Codex' };

export async function renderNew({ main, api, guard }) {
  main.innerHTML = '<div class="page narrow"><p class="muted">Loading…</p></div>';
  const hash = location.hash;
  let { providers, stances } = await api('/models');
  if (location.hash !== hash) return;

  let status = null;
  const waiting = {};
  const tests = {};
  const touched = {};
  const ids = Object.keys(providers);
  const isReady = (p) => Boolean(status?.[p]?.installed && status[p].signedIn);

  const modelFor = (value) => {
    const [provider, ...rest] = value.split(':');
    const id = rest.join(':');
    return { provider, id, entry: providers[provider].models.find((m) => m.id === id) };
  };
  const modelOptions = () => Object.entries(providers).map(([p, info]) => `<optgroup label="${esc(info.name)}" data-provider="${p}">
    <option value="${p}:">${esc(info.name)} (default model)</option>
    ${info.models.map((m) => `<option value="${p}:${esc(m.id)}">${esc(m.label)}${m.note ? ` (${esc(m.note)})` : ''}</option>`).join('')}
  </optgroup>`).join('');

  main.innerHTML = `
  <div class="page narrow">
    <header class="page-head"><h1>Start a council</h1><p class="muted">Two AI participants work separately, review each other, talk it through, and produce one document. Everything runs on your Mac with your own plans.</p></header>
    <div class="connections" id="connections">${ids.map((a) => `<div class="conn agent-${a}" data-agent="${a}"></div>`).join('')}</div>
    <p class="setup-note muted" id="setup-note" hidden></p>
    <form id="new-form" class="form">
      <label><span>Title <span class="muted">(optional)</span></span><input name="title" maxlength="200" autocomplete="off"></label>
      <div class="seat-grid">
        ${SEATS.map(([s, n]) => `<fieldset class="seat" data-seat="${s}"><legend>Participant ${n}</legend>
          <label>Model<select name="model_${s}"></select></label>
          <label>Effort and thinking<select name="effort_${s}"></select></label>
        </fieldset>`).join('')}
      </div>
      <label class="check"><input type="checkbox" name="same" checked> Give both the same starting prompt</label>
      <div class="prompt-grid" id="prompt-grid">
        <label><span id="prompt-label-a">Starting prompt</span><textarea name="prompt_a" rows="8" required placeholder="What should they work on?"></textarea></label>
        <label id="second-prompt" hidden><span id="prompt-label-b"></span><textarea name="prompt_b" rows="8"></textarea></label>
      </div>
      <label>How adversarial should they be?
        <input name="stance" type="range" min="1" max="${stances.length}" step="1" value="2" aria-describedby="stance-text">
        <span class="stance-scale muted small"><span>${esc(stances[0].label)}</span><span>${esc(stances.at(-1).label)}</span></span>
        <span id="stance-text" class="stance-text small"></span>
      </label>
      <div class="row-3">
        <label>Maximum conversation turns<input name="maxTurns" type="number" min="0" max="50" value="6" required></label>
        <label>Who speaks first<select name="firstSpeaker"></select></label>
        <label>Who drafts the document<select name="drafter"></select></label>
      </div>
      <label class="check"><input type="checkbox" name="startPaused"> Start paused so I can review the first prompts</label>
      <div class="form-actions"><button class="primary" type="submit" name="start">Start council</button><span class="muted small" id="start-note">Each run gets its own folder. Agents can only change files there.</span></div>
    </form>
  </div>`;

  const f = $('#new-form');
  const names = () => {
    const raw = SEATS.map(([s]) => {
      const { provider, entry } = modelFor(f[`model_${s}`].value);
      return entry?.label || providers[provider].name;
    });
    return raw[0] === raw[1] ? [`${raw[0]} A`, `${raw[1]} B`] : raw;
  };
  const refreshEffort = (s) => {
    const { provider, entry } = modelFor(f[`model_${s}`].value);
    const select = f[`effort_${s}`];
    const keep = select.value;
    const efforts = entry?.efforts || providers[provider].efforts;
    const fallback = entry?.defaultEffort ? `Default (${EFFORT_LABEL[entry.defaultEffort] || entry.defaultEffort})` : 'Default';
    select.innerHTML = `<option value="">${esc(fallback)}</option>${efforts.map((e) => `<option value="${esc(e)}">${esc(EFFORT_LABEL[e] || e)}</option>`).join('')}`;
    select.value = efforts.includes(keep) ? keep : '';
  };
  const refreshNames = () => {
    const [a, b] = names();
    for (const name of ['firstSpeaker', 'drafter']) {
      const v = f[name].value || 'a';
      f[name].innerHTML = `<option value="a">${esc(a)}</option><option value="b">${esc(b)}</option>`;
      f[name].value = v;
    }
    $('#prompt-label-a').textContent = f.same.checked ? 'Starting prompt' : `Prompt for ${a}`;
    $('#prompt-label-b').textContent = `Prompt for ${b}`;
  };
  const fillModels = () => {
    for (const [s, , preferred] of SEATS) {
      const select = f[`model_${s}`];
      const keep = select.value || `${preferred}:`;
      select.innerHTML = modelOptions();
      select.value = keep;
      if (!select.value) select.value = `${keep.split(':')[0]}:`;
      refreshEffort(s);
    }
    refreshNames();
  };
  const setProvider = (s, provider) => {
    f[`model_${s}`].value = `${provider}:`;
    refreshEffort(s);
  };

  // Steers each participant toward a tool that is ready to use.
  const applyReadiness = () => {
    if (!status) return;
    const ready = ids.filter(isReady);
    for (const [s, , preferred] of SEATS) {
      const select = f[`model_${s}`];
      select.querySelectorAll('optgroup').forEach((g) => { g.disabled = !isReady(g.dataset.provider); });
      const current = modelFor(select.value).provider;
      if (!touched[s] && isReady(preferred) && current !== preferred) setProvider(s, preferred);
      else if (!isReady(current) && ready.length) setProvider(s, ready[0]);
    }
    refreshNames();
    f.start.disabled = !ready.length;
    $('#start-note').textContent = ready.length ? 'Each run gets its own folder. Agents can only change files there.' : 'Set up Claude or ChatGPT above to begin.';
    const note = $('#setup-note');
    note.hidden = ready.length === ids.length;
    note.textContent = ready.length
      ? 'You can start now. Both participants will use the tool that is ready, or you can set up the other one too.'
      : 'Set up at least one to begin. One is enough, because a model can work against itself.';
  };

  const renderTool = (a) => {
    const st = status?.[a];
    const job = st?.job;
    let text = 'Checking…';
    let cls = 'muted';
    const actions = [];
    if (st) {
      if (job.state === 'running') text = 'Installing. This can take a few minutes…';
      else if (!st.installed) {
        text = job.state === 'failed' ? `Install failed: ${job.message}` : 'Not installed';
        cls = job.state === 'failed' ? 'bad' : 'muted';
        actions.push(['install', job.state === 'failed' ? 'Try again' : 'Install', '']);
      } else if (!st.signedIn) {
        text = waiting[a] ? 'Finish signing in using the Terminal window and your browser…' : 'Installed, not signed in';
        actions.push(['login', waiting[a] ? 'Open sign-in again' : 'Sign in', '']);
      } else {
        text = `Signed in${st.plan ? ` (${st.plan})` : ''}`;
        cls = 'good';
        actions.push(['test', 'Test connection', 'link'], ['login', 'Sign in again', 'link']);
      }
    }
    const t = tests[a];
    if (t === 'running') { text = 'Sending a short test…'; cls = 'muted'; }
    else if (t?.ok) { text = 'Working'; cls = 'good'; }
    else if (t) { text = t.error; cls = 'bad'; }
    const html = `<strong>${esc(providers[a].name)}</strong><span class="muted small">${TOOL_INFO[a]}</span>
      <span class="conn-state small ${cls}">${esc(text)}</span>
      <div class="conn-actions">${actions.map(([act, label, c]) => `<button type="button" class="${c}" data-setup="${act}" ${t === 'running' ? 'disabled' : ''}>${label}</button>`).join('')}</div>`;
    const el = $(`[data-agent="${a}"]`);
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  };

  const refreshStatus = async () => {
    const before = status;
    status = await api('/status');
    for (const a of ids) {
      if (isReady(a)) waiting[a] = false;
      if (before?.[a]?.signedIn && !status[a].signedIn) delete tests[a];
    }
    if (ids.some((a) => status[a].installed && !providers[a].models.length)) {
      const fresh = await api('/models');
      if (ids.some((a) => fresh.providers[a].models.length !== providers[a].models.length)) {
        providers = fresh.providers;
        fillModels();
      }
    }
    ids.forEach(renderTool);
    applyReadiness();
  };
  const poll = async () => {
    if (!document.contains(f)) return;
    await refreshStatus().catch(() => {});
    if (document.contains(f)) setTimeout(poll, ids.every(isReady) ? 15000 : 2500);
  };

  fillModels();
  ids.forEach(renderTool);
  const refreshStance = () => {
    const s = stances.find((x) => x.id === Number(f.stance.value));
    $('#stance-text').innerHTML = `<strong>${esc(s.label)}.</strong> ${esc(s.description)}`;
  };
  refreshStance();
  for (const [s] of SEATS) {
    f[`model_${s}`].addEventListener('change', () => { touched[s] = true; refreshEffort(s); refreshNames(); });
  }
  f.stance.addEventListener('input', refreshStance);
  f.same.addEventListener('change', () => {
    $('#second-prompt').hidden = f.same.checked;
    $('#prompt-grid').classList.toggle('two', !f.same.checked);
    f.prompt_b.required = !f.same.checked;
    refreshNames();
  });
  f.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const seat = (s) => {
      const { provider, id } = modelFor(f[`model_${s}`].value);
      return { provider, model: id, effort: f[`effort_${s}`].value };
    };
    const { run } = await api('/runs', 'POST', {
      title: f.title.value,
      prompts: { a: f.prompt_a.value, b: f.same.checked ? f.prompt_a.value : f.prompt_b.value },
      seats: { a: seat('a'), b: seat('b') }, stance: Number(f.stance.value),
      maxTurns: Number(f.maxTurns.value), firstSpeaker: f.firstSpeaker.value, drafter: f.drafter.value, startPaused: f.startPaused.checked,
    });
    location.hash = `#/run/${run.id}`;
  }));
  $('#connections').addEventListener('click', guard(async (e) => {
    const action = e.target.dataset?.setup;
    if (!action) return;
    const a = e.target.closest('[data-agent]').dataset.agent;
    if (action === 'test') {
      tests[a] = 'running';
      renderTool(a);
      try { tests[a] = await api('/test-connection', 'POST', { agent: a }); } catch (err) { tests[a] = { ok: false, error: err.message }; }
      renderTool(a);
      return;
    }
    delete tests[a];
    if (action === 'login') waiting[a] = true;
    status = await api('/setup', 'POST', { provider: a, action });
    ids.forEach(renderTool);
    applyReadiness();
  }));
  poll();
}

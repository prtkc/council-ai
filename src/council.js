// Run state, scheduling, editing, and persistence.
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadCatalog } from './models.js';
import { runAgent as defaultRunAgent } from './providers.js';
import {
  DEFAULT_GROUND_RULES, MAX_TURNS_LIMIT, SEATS, STANCES, STANCE_KINDS, buildPrompt, getStep, groupIndex, groupsOf,
  makeSteps, migrateRun, parseOutput, promptSuffix, turnStep, turnsOf, validateConfig,
} from './workflow.js';

export class ConflictError extends Error {}
export class NotFoundError extends Error {}

const SETTLED = new Set(['done', 'skipped']);
const BLOCKED = new Set(['failed', 'stopped']);
const now = () => new Date().toISOString();

export class Council extends EventEmitter {
  constructor({ root, runAgent = defaultRunAgent, catalog = loadCatalog }) {
    super();
    this.root = root;
    this.catalog = catalog;
    this.runAgent = runAgent;
    this.runs = new Map();
    this.active = new Map();
    this.saveTimers = new Map();
    this.snapshotTimers = new Map();
  }

  dir(id) { return path.join(this.root, id); }
  workspace(id) { return path.join(this.dir(id), 'workspace'); }
  get(id) {
    const run = this.runs.get(id);
    if (!run) throw new NotFoundError('Run not found.');
    return run;
  }
  step(run, stepId) {
    const s = getStep(run, stepId);
    if (!s) throw new NotFoundError('Step not found.');
    return s;
  }

  async load() {
    await fs.mkdir(this.root, { recursive: true });
    for (const e of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      try {
        const run = migrateRun(JSON.parse(await fs.readFile(path.join(this.dir(e.name), 'run.json'), 'utf8')));
        let interrupted = false;
        for (const s of run.steps) {
          if (s.status === 'running') {
            Object.assign(s, { status: 'stopped', error: 'Council closed while this step was running.', endedAt: now() });
            interrupted = true;
          }
        }
        if (interrupted) run.paused = true;
        this.runs.set(run.id, run);
      } catch { /* ignore folders that are not valid runs */ }
    }
  }

  async create(input) {
    const cfg = validateConfig(input, await this.catalog());
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const id = `${stamp}-${randomBytes(3).toString('hex')}`;
    const run = {
      id, title: cfg.title, createdAt: now(), prompts: cfg.prompts, maxTurns: cfg.maxTurns,
      firstSpeaker: cfg.firstSpeaker, drafter: cfg.drafter, seats: cfg.seats, stance: cfg.stance, stanceSeq: 0,
      groundRules: DEFAULT_GROUND_RULES, rulesSeq: 0, paused: cfg.startPaused, seq: 0, steps: makeSteps(cfg),
    };
    for (const a of SEATS) await fs.mkdir(path.join(this.workspace(id), 'drafts', a), { recursive: true });
    this.runs.set(id, run);
    await this.saveNow(run);
    this.tick(run);
    return run;
  }

  list() {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => ({ id: r.id, title: r.title, createdAt: r.createdAt, state: this.stateOf(r) }));
  }

  stateOf(run) {
    const has = (fn) => run.steps.some(fn);
    const running = has((s) => s.status === 'running');
    if (running) return run.paused ? 'pausing' : 'running';
    if (run.steps.every((s) => SETTLED.has(s.status))) return 'complete';
    if (has((s) => BLOCKED.has(s.status))) return 'attention';
    return run.paused ? 'paused' : 'running';
  }

  combinedStep(run) {
    return ['final-apply', 'final-draft'].map((id) => getStep(run, id)).find((s) => s?.status === 'done') || null;
  }

  isStale(run, s) {
    if (s.status !== 'done' || !s.startSeq) return false;
    if (s.promptEditSeq > s.startSeq || run.rulesSeq > s.startSeq) return true;
    if (STANCE_KINDS.has(s.kind) && run.stanceSeq > s.startSeq) return true;
    const mine = groupIndex(run, s.group);
    return run.steps.some((o) => groupIndex(run, o.group) < mine && Math.max(o.editSeq, o.promptEditSeq) > s.startSeq);
  }

  view(run) {
    const steps = run.steps.map((s) => {
      const showSent = s.sentPrompt != null && (s.status === 'running' || (s.status === 'done' && s.promptOverride == null));
      const prompt = showSent ? s.sentPrompt : s.promptOverride ?? buildPrompt(run, s);
      const { history, ...rest } = s;
      return { ...rest, prompt, promptEdited: s.promptOverride != null, stale: this.isStale(run, s), previousAttempts: history.length };
    });
    return {
      ...run, steps, state: this.stateOf(run), combinedStepId: this.combinedStep(run)?.id || null,
      promptSuffix: promptSuffix(run, 'a'), stances: STANCES.map(({ id, label, description }) => ({ id, label, description })),
    };
  }

  tick(run) {
    for (const group of groupsOf(run)) {
      const steps = run.steps.filter((s) => s.group === group);
      if (steps.every((s) => SETTLED.has(s.status))) continue;
      if (!run.paused) steps.filter((s) => s.status === 'pending').forEach((s) => this.start(run, s));
      break;
    }
    this.changed(run);
  }

  start(run, s) {
    const token = randomUUID();
    const controller = new AbortController();
    const key = `${run.id}/${s.id}`;
    const body = s.promptOverride ?? buildPrompt(run, s);
    Object.assign(s, {
      status: 'running', output: '', summary: null, originalOutput: null, activity: [], error: null, sentPrompt: body,
      startedAt: now(), endedAt: null, startSeq: ++run.seq, editSeq: 0, promptEditSeq: 0, manual: false, agreed: false, skipReason: null,
    });
    this.active.set(key, { token, controller });
    const live = () => this.active.get(key)?.token === token;
    const cwd = s.kind === 'independent' ? path.join(this.workspace(run.id), 'drafts', s.agent) : this.workspace(run.id);
    const seat = run.seats[s.agent];

    Promise.resolve()
      .then(() => {
        mkdirSync(cwd, { recursive: true });
        return this.runAgent({
          agent: seat.provider, prompt: `${run.groundRules}\n\n---\n\n${body}\n\n---\n\n${promptSuffix(run, s.agent)}`,
          cwd, model: seat.model, effort: seat.effort,
          signal: controller.signal, onEvent: (e) => { if (live()) this.onAgentEvent(run, s, e); },
        });
      })
      .then((text) => {
        if (!live()) return;
        this.active.delete(key);
        const { output, summary, agreed } = parseOutput(text);
        Object.assign(s, { status: 'done', output, summary, agreed: s.kind === 'turn' && agreed, endedAt: now() });
        this.endDialogueIfAgreed(run, s);
        this.tick(run);
      })
      .catch((err) => {
        if (!live()) return;
        this.active.delete(key);
        Object.assign(s, { status: err.aborted ? 'stopped' : 'failed', error: err.aborted ? 'Stopped by you.' : err.message, endedAt: now() });
        this.tick(run);
      });
  }

  endDialogueIfAgreed(run, s) {
    if (!s.agreed) return;
    const turns = turnsOf(run);
    const prev = turns.find((t) => t.turn === s.turn - 1);
    if (!prev?.agreed) return;
    for (const t of turns) {
      if (t.turn > s.turn && t.status === 'pending') Object.assign(t, { status: 'skipped', skipReason: 'Both agreed nothing was left to discuss.' });
    }
  }

  onAgentEvent(run, s, e) {
    if (e.type === 'delta') {
      s.output += e.text;
      this.emit('event', run.id, { type: 'delta', stepId: s.id, text: e.text });
    } else if (e.type === 'replace') {
      s.output = e.text;
      this.emit('event', run.id, { type: 'replace', stepId: s.id, text: e.text });
    } else if (e.type === 'activity') {
      const at = s.activity.findIndex((a) => a.id === e.item.id);
      if (at >= 0) s.activity[at] = { ...s.activity[at], ...e.item };
      else s.activity.push({ at: now(), ...e.item });
      if (s.activity.length > 500) s.activity.shift();
      this.emit('event', run.id, { type: 'activity', stepId: s.id, item: s.activity[at >= 0 ? at : s.activity.length - 1] });
    }
    this.scheduleSave(run);
  }

  // --- User controls ---

  pause(run) { run.paused = true; this.changed(run); }
  resume(run) { run.paused = false; this.tick(run); }

  stopStep(run, stepId) {
    const s = this.step(run, stepId);
    const a = this.active.get(`${run.id}/${s.id}`);
    if (!a) throw new ConflictError('That step is not running.');
    run.paused = true;
    a.controller.abort();
    this.changed(run);
  }

  rerun(run, stepId) {
    const target = this.step(run, stepId);
    const at = groupIndex(run, target.group);
    if (run.steps.some((s) => groupIndex(run, s.group) < at && !SETTLED.has(s.status))) {
      throw new ConflictError('Finish or skip the earlier steps first.');
    }
    for (const s of run.steps) {
      if (s !== target && groupIndex(run, s.group) <= at) continue;
      const key = `${run.id}/${s.id}`;
      const a = this.active.get(key);
      if (a) { this.active.delete(key); a.controller.abort(); }
      if (s.sentPrompt != null) s.history.push({ at: now(), status: s.status, prompt: s.sentPrompt, output: s.output, error: s.error });
      Object.assign(s, {
        status: 'pending', output: '', summary: null, originalOutput: null, sentPrompt: null, activity: [], error: null,
        startedAt: null, endedAt: null, startSeq: 0, editSeq: 0, promptEditSeq: 0, manual: false, agreed: false, skipReason: null,
      });
    }
    run.paused = false;
    this.tick(run);
  }

  skip(run, stepId) {
    const s = this.step(run, stepId);
    if (s.status === 'running') throw new ConflictError('Stop this step before skipping it.');
    Object.assign(s, { status: 'skipped', skipReason: 'Skipped by you.', editSeq: ++run.seq, endedAt: now() });
    this.tick(run);
  }

  editStep(run, stepId, { prompt, output }) {
    const s = this.step(run, stepId);
    if (s.status === 'running') throw new ConflictError('Stop this step before editing it.');
    if (prompt !== undefined) {
      if (prompt !== null && (typeof prompt !== 'string' || !prompt.trim())) throw new Error('The prompt cannot be empty.');
      s.promptOverride = prompt;
      s.promptEditSeq = ++run.seq;
    }
    if (output !== undefined) {
      if (typeof output !== 'string' || !output.trim()) throw new Error('The answer cannot be empty.');
      if (s.status === 'done' && s.originalOutput == null) s.originalOutput = s.output;
      if (s.status !== 'done') Object.assign(s, { status: 'done', manual: true, error: null, endedAt: now() });
      s.output = output;
      s.editSeq = ++run.seq;
    }
    this.tick(run);
  }

  editRun(run, { title, groundRules, stance }) {
    if (typeof title === 'string' && title.trim()) run.title = title.trim().slice(0, 200);
    if (stance !== undefined && Number(stance) !== run.stance) {
      if (!STANCES.some((s) => s.id === Number(stance))) throw new Error('Unknown adversarial level.');
      run.stance = Number(stance);
      run.stanceSeq = ++run.seq;
    }
    if (typeof groundRules === 'string' && groundRules !== run.groundRules) {
      run.groundRules = groundRules;
      run.rulesSeq = ++run.seq;
    }
    this.changed(run);
  }

  setMaxTurns(run, value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > MAX_TURNS_LIMIT) throw new Error(`Maximum turns must be from 0 to ${MAX_TURNS_LIMIT}.`);
    if (getStep(run, 'final-draft').status !== 'pending') throw new ConflictError('The final document has started. Re-run from a dialogue turn before changing the turn limit.');
    const turns = turnsOf(run);
    const used = Math.max(0, ...turns.filter((t) => t.status !== 'pending' && !t.skipReason?.startsWith('Both')).map((t) => t.turn));
    if (n < used) throw new ConflictError(`${used} turns have already happened.`);
    run.steps = run.steps.filter((s) => s.kind !== 'turn' || s.turn <= n);
    const at = run.steps.findIndex((s) => s.id === 'final-draft');
    const add = [];
    for (let t = turns.length + 1; t <= n; t++) add.push(turnStep(t, run.firstSpeaker));
    run.steps.splice(at, 0, ...add);
    run.maxTurns = n;
    this.tick(run);
  }

  // --- Persistence and notifications ---

  changed(run) {
    this.scheduleSave(run);
    if (this.snapshotTimers.has(run.id)) return;
    this.snapshotTimers.set(run.id, setTimeout(() => {
      this.snapshotTimers.delete(run.id);
      this.emit('event', run.id, { type: 'snapshot', run: this.view(run) });
      this.emit('runs');
    }, 40));
  }

  scheduleSave(run) {
    if (this.saveTimers.has(run.id)) return;
    this.saveTimers.set(run.id, setTimeout(() => {
      this.saveTimers.delete(run.id);
      this.saveNow(run).catch((e) => console.error('Could not save run:', e.message));
    }, 250));
  }

  async saveNow(run) {
    const dir = this.dir(run.id);
    const write = async (name, text) => {
      const tmp = path.join(dir, `.${name}.${randomBytes(3).toString('hex')}`);
      await fs.writeFile(tmp, text);
      await fs.rename(tmp, path.join(dir, name));
    };
    await write('run.json', JSON.stringify(run, null, 1));
    const doc = this.combinedStep(run);
    if (doc) await write('combined.md', doc.output);
  }

  async flush() {
    for (const t of this.saveTimers.values()) clearTimeout(t);
    this.saveTimers.clear();
    await Promise.all([...this.runs.values()].map((r) => this.saveNow(r).catch(() => {})));
  }

  async shutdown() {
    for (const a of this.active.values()) a.controller.abort();
    for (const t of this.snapshotTimers.values()) clearTimeout(t);
    await this.flush();
  }
}

// Local-only HTTP server: the browser UI, a JSON API, and live updates.
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConflictError, NotFoundError } from './council.js';
import { runAgent } from './providers.js';
import { install, login, toolStatus } from './setup.js';
import { STANCES } from './workflow.js';
import { PRESETS, TEMPLATES, TURN_RULES } from './playground.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/markdown.js': ['markdown.js', 'text/javascript'], '/new-run.js': ['new-run.js', 'text/javascript'], '/playground.js': ['playground.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MAX_BODY = 8 * 1024 * 1024;
const MAX_FILE = 1024 * 1024;

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw new Error('Expected JSON.');
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('Request is too large.');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function testConnection(agent) {
  const dir = await fs.mkdtemp(path.join(os.homedir(), '.council-test-'));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    await runAgent({ agent, prompt: 'Reply with only the word OK.', cwd: dir, signal: controller.signal });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.aborted ? 'Timed out after two minutes.' : e.message };
  } finally {
    clearTimeout(timer);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// Resolves a user-supplied path to a location that is really inside the workspace.
async function safePath(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel)) throw new Error('Invalid file path.');
  const realRoot = await fs.realpath(root);
  const target = path.resolve(realRoot, rel);
  if (!target.startsWith(realRoot + path.sep)) throw new Error('That path is outside the workspace.');
  let dir = path.dirname(target);
  for (;;) {
    try { dir = await fs.realpath(dir); break; } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      dir = path.dirname(dir);
    }
  }
  if (dir !== realRoot && !dir.startsWith(realRoot + path.sep)) throw new Error('That path is outside the workspace.');
  const info = await fs.lstat(target).catch(() => null);
  if (info?.isSymbolicLink()) throw new Error('Symbolic links cannot be opened here.');
  return { target, info };
}

async function listFiles(root) {
  const out = [];
  const walk = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (out.length >= 2000 || e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const st = await fs.stat(full);
        out.push({ path: path.relative(root, full), size: st.size, modifiedAt: st.mtime.toISOString() });
      }
    }
  };
  await walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// The workspace file browser, shared by councils and playgrounds. Returns true when it handled the request.
async function fileRoute(root, rest, m, req, url, res) {
  if (m === 'GET' && rest === '/files') { send(res, 200, { files: await listFiles(root) }); return true; }
  if (rest !== '/file') return false;
  if (m === 'GET') {
    const { target, info } = await safePath(root, url.searchParams.get('path'));
    if (!info?.isFile()) throw new NotFoundError('File not found.');
    if (info.size > MAX_FILE) { send(res, 200, { binary: true, note: 'This file is too large to open here.' }); return true; }
    const buf = await fs.readFile(target);
    send(res, 200, buf.includes(0) ? { binary: true, note: 'This is a binary file.' } : { content: buf.toString('utf8') });
    return true;
  }
  if (m === 'PUT') {
    const body = await readJson(req);
    if (typeof body.content !== 'string') throw new Error('Missing file content.');
    const { target } = await safePath(root, body.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body.content);
    send(res, 200, { ok: true });
    return true;
  }
  return false;
}

export function createServer(council, playgrounds = null) {
  const clients = new Map();
  const listClients = new Set();
  const sse = (res, name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

  council.on('event', (id, e) => { for (const res of clients.get(id) || []) sse(res, e.type, e); });
  council.on('runs', () => { const runs = council.list(); for (const res of listClients) sse(res, 'runs', { runs }); });

  const openStream = (req, res, set, first) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    set.add(res);
    first();
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); set.delete(res); });
  };

  const pgClients = new Map();
  const pgListClients = new Set();
  if (playgrounds) {
    playgrounds.on('event', (id, e) => { for (const res of pgClients.get(id) || []) sse(res, e.type, e); });
    playgrounds.on('list', () => { const list = playgrounds.list(); for (const res of pgListClients) sse(res, 'playgrounds', { playgrounds: list }); });
  }

  // One live connection per page: browsers allow only six per site, so separate streams for
  // the sidebar and the open item ran out when several Council windows were open.
  const streams = new Set();
  const broadcast = (pick, name, data) => { for (const s of streams) if (pick(s)) sse(s.res, name, data); };
  council.on('event', (id, e) => broadcast((s) => s.run === id, e.type, e));
  council.on('runs', () => broadcast(() => true, 'runs', { runs: council.list() }));
  if (playgrounds) {
    playgrounds.on('event', (id, e) => broadcast((s) => s.playground === id, e.type, e));
    playgrounds.on('list', () => broadcast(() => true, 'playgrounds', { playgrounds: playgrounds.list() }));
  }
  function openUnifiedStream(req, res, url) {
    const run = url.searchParams.get('run');
    const playground = url.searchParams.get('playground');
    const runObj = run ? council.get(run) : null;
    const pgObj = playground && playgrounds ? playgrounds.get(playground) : null;
    const entry = { res, run: runObj?.id || null, playground: pgObj?.id || null };
    const set = { add: () => streams.add(entry), delete: () => streams.delete(entry) };
    return openStream(req, res, set, () => {
      sse(res, 'runs', { runs: council.list() });
      if (playgrounds) sse(res, 'playgrounds', { playgrounds: playgrounds.list() });
      if (runObj) sse(res, 'snapshot', { type: 'snapshot', run: council.view(runObj) });
      if (pgObj) sse(res, 'snapshot', { type: 'snapshot', playground: playgrounds.view(pgObj) });
    });
  }

  async function playgroundRoute(p, m, req, url, res) {
    if (m === 'GET' && p === '/api/playgrounds') return send(res, 200, { playgrounds: playgrounds.list() });
    if (m === 'GET' && p === '/api/playgrounds/events') return openStream(req, res, pgListClients, () => sse(res, 'playgrounds', { playgrounds: playgrounds.list() }));
    if (m === 'GET' && p === '/api/playgrounds/templates') {
      const templates = Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label, description: t.description }));
      return send(res, 200, { templates, presets: PRESETS, turnRules: TURN_RULES });
    }
    if (m === 'POST' && p === '/api/playgrounds') {
      const pg = await playgrounds.create((await readJson(req)).template);
      return send(res, 201, { playground: playgrounds.view(pg) });
    }
    const g = p.match(/^\/api\/playgrounds\/(\d{14}-[0-9a-f]{6})(\/.*)?$/);
    if (!g) return send(res, 404, { error: 'Not found.' });
    const pg = playgrounds.get(g[1]);
    const rest = g[2] || '';
    const out = () => send(res, 200, { playground: playgrounds.view(pg) });
    if (m === 'GET' && !rest) return out();
    if (m === 'PATCH' && !rest) { playgrounds.edit(pg, await readJson(req)); return out(); }
    if (m === 'GET' && rest === '/events') {
      if (!pgClients.has(pg.id)) pgClients.set(pg.id, new Set());
      return openStream(req, res, pgClients.get(pg.id), () => sse(res, 'snapshot', { type: 'snapshot', playground: playgrounds.view(pg) }));
    }
    const action = rest.match(/^\/(start|pause|resume|stop|end)$/);
    if (m === 'POST' && action) { await readJson(req); playgrounds[action[1]](pg); return out(); }
    if (m === 'POST' && rest === '/hurry') { playgrounds.setHurry(pg, (await readJson(req)).on); return out(); }
    if (m === 'POST' && rest === '/agents') {
      const agent = playgrounds.addAgent(pg, await readJson(req));
      return send(res, 200, { playground: playgrounds.view(pg), agentId: agent.id });
    }
    const ag = rest.match(/^\/agents\/(a[0-9a-f]{6})$/);
    if (ag && m === 'PATCH') { playgrounds.editAgent(pg, ag[1], await readJson(req)); return out(); }
    if (ag && m === 'DELETE') { playgrounds.removeAgent(pg, ag[1]); return out(); }
    if (m === 'POST' && rest === '/messages') { playgrounds.post(pg, await readJson(req)); return out(); }
    const mg = rest.match(/^\/messages\/(m\d+)(?:\/(rerun|skip|prompt))?$/);
    if (mg && m === 'PATCH' && !mg[2]) { playgrounds.editMessage(pg, mg[1], await readJson(req)); return out(); }
    if (mg && m === 'GET' && mg[2] === 'prompt') return send(res, 200, { prompt: playgrounds.message(pg, mg[1]).prompt || null });
    if (mg && m === 'POST' && mg[2] === 'rerun') { await readJson(req); playgrounds.rerunFrom(pg, mg[1]); return out(); }
    if (mg && m === 'POST' && mg[2] === 'skip') { await readJson(req); playgrounds.skip(pg, mg[1]); return out(); }
    if (await fileRoute(playgrounds.workspace(pg.id), rest, m, req, url, res)) return undefined;
    return send(res, 404, { error: 'Not found.' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const { port } = server.address();
      const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      // Blocks other websites and DNS-rebinding pages from reaching this local server.
      if (!allowed.has(req.headers.host)) return send(res, 403, { error: 'Forbidden host.' });
      if (req.headers.origin && !allowed.has(req.headers.origin.replace(/^http:\/\//, ''))) return send(res, 403, { error: 'Forbidden origin.' });
      if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return send(res, 403, { error: 'Forbidden request.' });

      const url = new URL(req.url, `http://${req.headers.host}`);
      const p = url.pathname;
      const m = req.method;

      if (m === 'GET' && STATIC[p]) {
        const [file, type] = STATIC[p];
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
        return res.end(await fs.readFile(path.join(PUBLIC, file)));
      }
      if (!p.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });
      if (m === 'GET' && p === '/api/health') return send(res, 200, { app: 'council' });
      if (m === 'GET' && p === '/api/status') return send(res, 200, await toolStatus());
      if (m === 'POST' && p === '/api/setup') {
        const { provider, action } = await readJson(req);
        if (action === 'install') install(provider); // Runs in the background; the page polls for progress.
        else if (action === 'login') await login(provider);
        else throw new Error('Unknown setup action.');
        return send(res, 200, await toolStatus());
      }
      if (m === 'GET' && p === '/api/models') {
        return send(res, 200, { providers: await council.catalog(), stances: STANCES.map(({ id, label, description }) => ({ id, label, description })) });
      }
      if (m === 'POST' && p === '/api/test-connection') {
        const { agent } = await readJson(req);
        if (!['claude', 'chatgpt'].includes(agent)) throw new Error('Unknown agent.');
        return send(res, 200, await testConnection(agent));
      }
      if (m === 'GET' && p === '/api/stream') return openUnifiedStream(req, res, url);
      if (m === 'GET' && p === '/api/runs') return send(res, 200, { runs: council.list() });
      if (m === 'GET' && p === '/api/runs/events') return openStream(req, res, listClients, () => sse(res, 'runs', { runs: council.list() }));
      if (m === 'POST' && p === '/api/runs') {
        const run = await council.create(await readJson(req));
        return send(res, 201, { run: council.view(run) });
      }

      if (playgrounds && p.startsWith('/api/playgrounds')) return await playgroundRoute(p, m, req, url, res);

      const r = p.match(/^\/api\/runs\/(\d{14}-[0-9a-f]{6})(\/.*)?$/);
      if (!r) return send(res, 404, { error: 'Not found.' });
      const run = council.get(r[1]);
      const rest = r[2] || '';
      const done = () => send(res, 200, { run: council.view(run) });

      if (m === 'GET' && !rest) return done();
      if (m === 'PATCH' && !rest) { council.editRun(run, await readJson(req)); return done(); }
      if (m === 'GET' && rest === '/events') {
        if (!clients.has(run.id)) clients.set(run.id, new Set());
        return openStream(req, res, clients.get(run.id), () => sse(res, 'snapshot', { type: 'snapshot', run: council.view(run) }));
      }
      if (m === 'POST' && rest === '/pause') { await readJson(req); council.pause(run); return done(); }
      if (m === 'POST' && rest === '/resume') { await readJson(req); council.resume(run); return done(); }
      if (m === 'POST' && rest === '/hurry') { council.setHurry(run, (await readJson(req)).on); return done(); }
      if (m === 'POST' && rest === '/turns') { council.setMaxTurns(run, (await readJson(req)).maxTurns); return done(); }

      const st = rest.match(/^\/steps\/([a-z0-9-]+)(?:\/(stop|end|rerun|skip))?$/);
      if (st) {
        if (m === 'PATCH' && !st[2]) { council.editStep(run, st[1], await readJson(req)); return done(); }
        if (m === 'POST' && st[2]) {
          await readJson(req);
          if (st[2] === 'stop') council.stopStep(run, st[1]);
          if (st[2] === 'end') council.endStep(run, st[1]);
          if (st[2] === 'rerun') council.rerun(run, st[1]);
          if (st[2] === 'skip') council.skip(run, st[1]);
          return done();
        }
      }

      if (await fileRoute(council.workspace(run.id), rest, m, req, url, res)) return undefined;
      return send(res, 404, { error: 'Not found.' });
    } catch (e) {
      const code = e instanceof NotFoundError ? 404 : e instanceof ConflictError ? 409 : 400;
      if (res.headersSent) return res.end();
      return send(res, code, { error: e.message });
    }
  });
  return server;
}

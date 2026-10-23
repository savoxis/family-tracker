'use strict';
/**
 * Kitchen Board server. Zero dependencies, Node 18+.
 *
 * Keeps the board's collections in one JSON file so every screen on the home network
 * (kitchen monitor, phones, tablets) shares the same chores, stars and calendar.
 *
 *   GET    /api/health           -> { ok: true }
 *   GET    /api/state            -> { rev, data: { <collection>: { <id>: <doc> } } }
 *   PUT    /api/<coll>/<id>      -> body is one JSON object; replaces that document
 *   DELETE /api/<coll>/<id>      -> removes that document
 *   anything else                -> static files from the web folder
 *
 * There is no login. Run it on a trusted LAN only. Do not port-forward it.
 *
 * Env: PORT (8080), DATA_DIR (./data), PUBLIC_DIR (./public, else ../web)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'board.json');
const PUBLIC_DIR = path.resolve(
  process.env.PUBLIC_DIR ||
    (fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : path.join(__dirname, '..', 'web'))
);
const MAX_BODY = 256 * 1024;
const COLLECTIONS = ['members', 'chores', 'rewards', 'events', 'ledger', 'meals', 'groceries', 'notes', 'config'];
const ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

/* ---------- storage ---------- */
function emptyData() {
  const d = {};
  COLLECTIONS.forEach((c) => { d[c] = {}; });
  return d;
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (j && typeof j.rev === 'number' && j.data && typeof j.data === 'object') {
      COLLECTIONS.forEach((c) => { if (!j.data[c] || typeof j.data[c] !== 'object') j.data[c] = {}; });
      return { state: j, fresh: false };
    }
    console.error('board.json has an unexpected shape, refusing to overwrite it: ' + DATA_FILE);
    process.exit(1);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('Could not read ' + DATA_FILE + ': ' + e.message);
      process.exit(1);
    }
    return { state: { rev: 1, data: emptyData() }, fresh: true };
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const loaded = load();
const state = loaded.state;

// Writes are queued so two quick taps can never interleave a half-written file.
let saving = Promise.resolve();
function persist() {
  saving = saving.catch(() => {}).then(async () => {
    const tmp = DATA_FILE + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(state));
    await fs.promises.rename(tmp, DATA_FILE);
  });
  return saving;
}

/* ---------- http helpers ---------- */
function send(res, status, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, extra || {}));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, failed = false;
    const chunks = [];
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > MAX_BODY) { failed = true; reject(Object.assign(new Error('too large'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        resolve(v);
      } catch (e) { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

async function api(req, res, parts) {
  if (parts.length === 1 && parts[0] === 'health') return send(res, 200, { ok: true });
  if (parts.length === 1 && parts[0] === 'state') {
    if (req.method !== 'GET') return send(res, 405, { error: 'method' });
    return send(res, 200, state);
  }
  if (parts.length === 2) {
    const coll = parts[0];
    let id;
    try { id = decodeURIComponent(parts[1]); } catch (e) { return send(res, 400, { error: 'bad id' }); }
    if (!COLLECTIONS.includes(coll)) return send(res, 404, { error: 'unknown collection' });
    if (!ID_RE.test(id) || id === '__proto__') return send(res, 400, { error: 'bad id' });
    if (req.method === 'PUT') {
      let body;
      try { body = await readBody(req); }
      catch (e) { return send(res, e.status || 400, { error: 'bad body' }, { Connection: 'close' }); }
      state.data[coll][id] = body;
    } else if (req.method === 'DELETE') {
      delete state.data[coll][id];
    } else {
      return send(res, 405, { error: 'method' });
    }
    state.rev += 1;
    try { await persist(); } catch (e) { return send(res, 500, { error: 'could not save' }); }
    return send(res, 200, { rev: state.rev });
  }
  return send(res, 404, { error: 'not found' });
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (rel.includes('\0')) { res.writeHead(400); return res.end(); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'api') return await api(req, res, parts.slice(1));
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'server' });
  }
});

function start() {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('Kitchen Board on port ' + PORT + ', data in ' + DATA_FILE + (loaded.fresh ? ' (new)' : ''));
  });
}
if (loaded.fresh) persist().then(start, start); else start();

function stop() {
  server.close(() => saving.then(() => process.exit(0), () => process.exit(1)));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

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
 * Backups: a copy of the board goes to DATA_DIR/backups/board-<UTC time>.json at start and then
 * every BACKUP_HOURS, skipped when nothing changed, newest BACKUP_KEEP files kept.
 *
 * Google Calendar: set ICS_URLS to one or more "secret address in iCal format" links, written as
 * Label|https://... and separated by commas or new lines. The server reads them every
 * ICS_MINUTES and keeps matching events (ids starting gcal-) in the events collection, so the
 * page needs nothing extra. Read-only: edits to those events on the board are overwritten at the
 * next sync. The links are secrets, so they are never logged or served.
 *
 * Google Keep shopping list (unofficial, see keep.js and keepsync.js): set KEEP_EMAIL,
 * KEEP_MASTER_TOKEN and KEEP_LIST (the list's title). The grocery list is then kept in step with
 * that Keep list every KEEP_MINUTES and a few seconds after any grocery change on the board.
 * KEEP_HEADERS names category headers that have no items yet (comma separated). KEEP_DRYRUN=1
 * only logs what would change. The token is a secret and is never logged.
 *
 * Text alerts to the parents (Textbelt, see sms.js): set TEXTBELT_KEY and SMS_TO (phone numbers,
 * comma separated). Texts go out when a chore needs approval and when a reward is cashed in. Set
 * SMS_REMIND_AT=HH:MM (board time) for a daily "chores left" nudge. SMS_DAILY_MAX (12) caps
 * texts per day, SMS_DRYRUN=1 only logs. The key and numbers are secrets and are never logged in full.
 *
 * Env: PORT (8080), DATA_DIR (./data), PUBLIC_DIR (./public, else ../web),
 *      BACKUP_HOURS (6, 0 turns backups off), BACKUP_KEEP (28),
 *      ICS_URLS (none), ICS_MINUTES (15), BOARD_TZ (the calendar's own zone, else UTC),
 *      KEEP_EMAIL, KEEP_MASTER_TOKEN, KEEP_LIST, KEEP_HEADERS, KEEP_MINUTES (2), KEEP_DRYRUN,
 *      TEXTBELT_KEY, SMS_TO, SMS_REMIND_AT, SMS_DAILY_MAX (12), SMS_DRYRUN
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const ics = require('./ics');
const { Keep } = require('./keep');
const keepsync = require('./keepsync');
const sms = require('./sms');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'board.json');
const PUBLIC_DIR = path.resolve(
  process.env.PUBLIC_DIR ||
    (fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : path.join(__dirname, '..', 'web'))
);
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_MS = Math.round(parseFloat(process.env.BACKUP_HOURS || '6') * 3600 * 1000) || 0;
const BACKUP_KEEP = Math.max(1, parseInt(process.env.BACKUP_KEEP || '28', 10) || 28);
const BACKUP_RE = /^board-\d{8}-\d{6}\.json$/;
const ICS_MS = Math.max(1000, Math.round(parseFloat(process.env.ICS_MINUTES || '15') * 60 * 1000) || 900000);
const ICS_FEEDS = (process.env.ICS_URLS || '').split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean).map((s, i) => {
  const k = s.indexOf('|');
  const label = (k > 0 ? s.slice(0, k) : 'Calendar ' + (i + 1)).trim();
  const url = (k > 0 ? s.slice(k + 1) : s).trim().replace(/^webcal:/i, 'https:');
  return /^https?:\/\//i.test(url) ? { label, url } : null;
}).filter(Boolean);
const KEEP_MS = Math.max(1000, Math.round(parseFloat(process.env.KEEP_MINUTES || '2') * 60 * 1000) || 120000);
const KEEP_ON = !!(process.env.KEEP_EMAIL && process.env.KEEP_MASTER_TOKEN && process.env.KEEP_LIST);
let keepSync = null;
const SMS_TO = (process.env.SMS_TO || '').split(/[,;\r\n]+/).map((s) => s.replace(/\D/g, '')).filter((s) => s.length >= 10 && s.length <= 11);
const SMS_ON = !!(process.env.TEXTBELT_KEY && SMS_TO.length);
let smsOut = null;
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

/* ---------- backups ---------- */
async function backup() {
  try {
    await saving.catch(() => {});
    await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
    const names = (await fs.promises.readdir(BACKUP_DIR)).filter((n) => BACKUP_RE.test(n)).sort();
    const body = JSON.stringify(state);
    if (names.length) {
      const last = await fs.promises.readFile(path.join(BACKUP_DIR, names[names.length - 1]), 'utf8').catch(() => null);
      if (last === body) return null;
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const name = 'board-' + stamp + '.json';
    const tmp = path.join(BACKUP_DIR, name + '.tmp');
    await fs.promises.writeFile(tmp, body);
    await fs.promises.rename(tmp, path.join(BACKUP_DIR, name));
    if (!names.includes(name)) names.push(name);
    for (const old of names.slice(0, Math.max(0, names.length - BACKUP_KEEP))) {
      await fs.promises.unlink(path.join(BACKUP_DIR, old)).catch(() => {});
    }
    console.log('Backup written: ' + name);
    return name;
  } catch (e) {
    console.error('Backup failed: ' + e.message);
    return null;
  }
}

/* ---------- google calendar (read-only iCal feeds) ---------- */
async function fetchFeed(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = await r.text();
    if (text.length > 8e6) throw new Error('feed too large');
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('not a calendar');
    return text;
  } finally { clearTimeout(timer); }
}

// Never put the URL in a message: Node's own errors can echo it, so only a short code is shown.
const feedError = (e) => (e && e.cause && e.cause.code) || (e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'error');

function applyFeed(label, docs) {
  const events = state.data.events;
  let changed = 0;
  for (const [id, d] of docs) {
    if (JSON.stringify(events[id]) !== JSON.stringify(d)) { events[id] = d; changed++; }
  }
  for (const id of Object.keys(events)) {
    if (events[id] && events[id].src === 'gcal' && events[id].cal === label && !docs.has(id)) { delete events[id]; changed++; }
  }
  if (changed) { state.rev += 1; persist().catch((e) => console.error('Could not save calendar events: ' + e.message)); }
  return changed;
}

async function syncCalendars() {
  for (const feed of ICS_FEEDS) {
    try {
      const docs = ics.build(await fetchFeed(feed.url), { label: feed.label, boardTz: process.env.BOARD_TZ });
      const changed = applyFeed(feed.label, docs);
      if (changed) console.log('Calendar "' + feed.label + '": ' + docs.size + ' events, ' + changed + ' changed');
    } catch (e) {
      console.error('Calendar "' + feed.label + '" sync failed: ' + feedError(e));
    }
  }
}

function dropOrphanCalendarEvents() {
  const labels = new Set(ICS_FEEDS.map((f) => f.label));
  let n = 0;
  for (const id of Object.keys(state.data.events)) {
    const e = state.data.events[id];
    if (e && e.src === 'gcal' && !labels.has(e.cal)) { delete state.data.events[id]; n++; }
  }
  if (n) { state.rev += 1; persist().catch(() => {}); }
}

/* ---------- google keep shopping list (unofficial) ---------- */
function applyKeepToBoard(p) {
  const g = state.data.groceries;
  for (const s of p.boardSet) if (g[s.id]) g[s.id] = Object.assign({}, g[s.id], { title: s.title, done: s.done });
  for (const a of p.boardAdd) g[a.id] = { title: a.title, done: a.done, at: Date.now() };
  for (const id of p.boardDel) delete g[id];
  state.rev += 1;
  persist().catch((e) => console.error('Could not save grocery changes: ' + e.message));
}

function startKeep() {
  keepSync = keepsync.create({
    keep: new Keep({ email: process.env.KEEP_EMAIL, masterToken: process.env.KEEP_MASTER_TOKEN, authUrl: process.env.KEEP_AUTH_URL, apiUrl: process.env.KEEP_API_URL }),
    listTitle: process.env.KEEP_LIST,
    headerNames: (process.env.KEEP_HEADERS || '').split(',').map((s) => s.trim()).filter(Boolean),
    pairsFile: path.join(DATA_DIR, 'keep-sync.json'),
    dryRun: process.env.KEEP_DRYRUN === '1',
    board: () => new Map(Object.entries(state.data.groceries).map(([id, d]) => [id, { title: String(d.title || ''), done: !!d.done }])),
    applyBoard: applyKeepToBoard,
    log: (m, isErr) => (isErr ? console.error(m) : console.log(m))
  });
  console.log('Keep sync on' + (process.env.KEEP_DRYRUN === '1' ? ' (dry run, nothing is written)' : ''));
  keepSync.run();
  setInterval(keepSync.run, KEEP_MS).unref();
}

/* ---------- text alerts to the parents ---------- */
function smsTz() {
  const tz = process.env.BOARD_TZ || process.env.TZ || 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return 'UTC'; }
}

function smsLedger(before, after) {
  for (const ev of sms.ledgerEvents(before, after)) {
    const m = state.data.members[ev.mid];
    const who = (m && m.name) || 'Someone';
    if (ev.kind === 'approve') {
      const c = state.data.chores[ev.key.split('_').slice(1).join('_')];
      smsOut.notify('approve', who, (c && c.title) || 'a chore');
    } else {
      smsOut.notify('cash', who, ev.title + ' (' + ev.cost + (ev.cost === 1 ? ' star)' : ' stars)'));
    }
  }
}

// Once a day, shortly after SMS_REMIND_AT, text who still has chores left. A restart late at night does not resend.
function smsNudge() {
  const at = /^(\d{1,2}):(\d{2})$/.exec(process.env.SMS_REMIND_AT || '');
  if (!at) return;
  const tz = smsTz(), t = sms.localDay(Date.now(), tz), mins = t.h * 60 + t.mi, from = (+at[1]) * 60 + (+at[2]);
  if (mins < from || mins > from + 120) return;
  const file = path.join(DATA_DIR, 'sms-state.json');
  let last = '';
  try { last = JSON.parse(fs.readFileSync(file, 'utf8')).reminded; } catch (e) { /* first run */ }
  if (last === t.key) return;
  try { fs.writeFileSync(file, JSON.stringify({ reminded: t.key })); } catch (e) { console.error('Could not save text state: ' + e.message); return; }
  const rows = sms.choresLeft(state.data, Date.now(), tz);
  if (!rows.length) return;
  smsOut.send(rows.map((r) => r.name + ' still has ' + r.left.length + (r.left.length === 1 ? ' chore' : ' chores') + ' left today (' + sms.listWords(r.left, 3) + ').').join(' '));
}

function startSms() {
  smsOut = sms.create({
    key: process.env.TEXTBELT_KEY, to: SMS_TO, tz: smsTz(), url: process.env.SMS_URL,
    dailyMax: parseInt(process.env.SMS_DAILY_MAX || '12', 10) || 12, dryRun: process.env.SMS_DRYRUN === '1',
    batchMs: process.env.SMS_BATCH_MS ? parseInt(process.env.SMS_BATCH_MS, 10) : undefined,
    log: (m, isErr) => (isErr ? console.error(m) : console.log(m))
  });
  console.log('Text alerts on for ' + SMS_TO.length + ' number' + (SMS_TO.length === 1 ? '' : 's') + (process.env.SMS_DRYRUN === '1' ? ' (dry run)' : '')
    + (process.env.SMS_REMIND_AT ? ', evening nudge at ' + process.env.SMS_REMIND_AT : ''));
  smsNudge();
  setInterval(smsNudge, 60000).unref();
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
      const before = state.data[coll][id];
      state.data[coll][id] = body;
      if (coll === 'ledger' && smsOut) { try { smsLedger(before, body); } catch (e) { console.error('Text alert failed: ' + e.message); } }
    } else if (req.method === 'DELETE') {
      delete state.data[coll][id];
    } else {
      return send(res, 405, { error: 'method' });
    }
    state.rev += 1;
    try { await persist(); } catch (e) { return send(res, 500, { error: 'could not save' }); }
    if (coll === 'groceries' && keepSync) keepSync.soon();
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
    if (BACKUP_MS > 0) {
      backup();
      setInterval(backup, BACKUP_MS).unref();
    }
    if (KEEP_ON) startKeep();
    if (SMS_ON) startSms();
    dropOrphanCalendarEvents();
    if (ICS_FEEDS.length) {
      console.log('Calendar sync on for: ' + ICS_FEEDS.map((f) => f.label).join(', '));
      syncCalendars();
      setInterval(syncCalendars, ICS_MS).unref();
    }
  });
}
if (loaded.fresh) persist().then(start, start); else start();

function stop() {
  server.close(() => saving.then(() => process.exit(0), () => process.exit(1)));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

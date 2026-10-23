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
 * comma separated). Texts go out when a chore needs approval (after SMS_APPROVE_DELAY_MIN, 60, and
 * only if it is still waiting then) and when a reward is cashed in. Set
 * SMS_REMIND_AT=HH:MM (board time) for a daily "chores left" nudge. SMS_DAILY_MAX (12) caps
 * texts per day, SMS_DRYRUN=1 only logs. The key and numbers are secrets and are never logged in full.
 *
 * ParentSquare (see parentsquare.js): PARENTSQUARE_USER, PARENTSQUARE_PASSWORD and PS_SCHOOLS
 * (school id and the child it belongs to, like 13482:Xander,13486:Bastian). The server signs in
 * itself, renews the session, and keeps recent school posts and the unread message count in the
 * school collection, tied to the right child, for the School view on the board. It also lists the
 * message conversations (who wrote, how many, when; the text only if PS_MESSAGE_PREVIEW=1, and a
 * conversation is never opened, which would mark it read) and puts your own appointment sign-ups
 * on the calendar. PS_TEACHERS (Xander:Kayla Knight,Bastian:Keli Bruehling) names each child's
 * teacher. PS_MINUTES (15). The password is never logged.
 *
 * Calendar feeds can be tied to a family member with Label@Member|url (their events then show in
 * that person's color), and every synced event carries a source: google, school or calendar.
 *
 * Messaging a teacher: POST /api/school-message {sid, tid, text, pin} sends a ParentSquare message to a
 * teacher named in PS_TEACHERS (a reply in the existing conversation, or a new one). The approval PIN
 * from Setup is checked here, not in the page: 5 wrong tries lock it for 10 minutes, PS_SEND_MAX (5) caps
 * messages per hour, and only teachers the server found itself can be written to.
 *
 * School lunch menu (needs GEMINI_API_KEY): MENU_PAGE is the district's menu page (several pages can be listed,
 * separated by commas, such as the schools' own sites). Its monthly elementary menu PDF
 * (MENU_MATCH, default "elementary", picks which file) is read once by Gemini, each school day's lunch goes on the
 * calendar, No school days are marked, and the Food card shows today's lunch on school days. MENU_HOURS (6) is how
 * often the page is checked, MENU_LABEL names the calendar source.
 *
 * Reading a conversation: POST /api/school-thread {sid, chat, pin} returns the messages of a conversation
 * the server listed, after the same PIN check. The text is returned and never stored. Opening a
 * conversation marks it read on ParentSquare.
 *
 * Flyer reader (see gemini.js): GEMINI_API_KEY turns it on. Each new public school post is read once with
 * Gemini (text and up to two pictures) for a short summary, what to do or bring, and dates it states.
 * GEMINI_DAILY_MAX (15) keeps inside the free allowance, GEMINI_MODEL (gemini-3.5-flash-lite) picks the model.
 * Messages are never sent to Gemini. The key is never logged.
 *
 * Env: PORT (8080), DATA_DIR (./data), PUBLIC_DIR (./public, else ../web),
 *      GEMINI_API_KEY, GEMINI_DAILY_MAX, GEMINI_MODEL, PS_SEND_MAX,
 *      BACKUP_HOURS (6, 0 turns backups off), BACKUP_KEEP (28),
 *      ICS_URLS (none), ICS_MINUTES (15), BOARD_TZ (the calendar's own zone, else UTC),
 *      PARENTSQUARE_USER, PARENTSQUARE_PASSWORD, PS_SCHOOLS, PS_TEACHERS, PS_MESSAGE_PREVIEW, PS_MINUTES (15),
 *      KEEP_EMAIL, KEEP_MASTER_TOKEN, KEEP_LIST, KEEP_HEADERS, KEEP_MINUTES (2), KEEP_DRYRUN,
 *      TEXTBELT_KEY, SMS_TO, SMS_REMIND_AT, SMS_DAILY_MAX (12), SMS_DRYRUN
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ics = require('./ics');
const { Keep } = require('./keep');
const keepsync = require('./keepsync');
const sms = require('./sms');
const parentsquare = require('./parentsquare');
const gemini = require('./gemini');
const menu = require('./menu');

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
  const head = (k > 0 ? s.slice(0, k) : 'Calendar ' + (i + 1)).trim();
  const at = head.indexOf('@'); // Label@Member shows that feed's events as that family member's
  const label = (at > 0 ? head.slice(0, at) : head).trim();
  const who = at > 0 ? head.slice(at + 1).trim() : '';
  const url = (k > 0 ? s.slice(k + 1) : s).trim().replace(/^webcal:/i, 'https:');
  const host = (/^https?:\/\/([^/]+)/i.exec(url) || [])[1] || '';
  const source = /google\.com$/i.test(host) ? 'google' : /parentsquare\.com$/i.test(host) ? 'school' : 'calendar';
  return /^https?:\/\//i.test(url) ? { label, who, source, url } : null;
}).filter(Boolean);
const memberIdByName = (name) => {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return '';
  const hit = Object.entries(state.data.members).find(([, m]) => String((m && m.name) || '').trim().toLowerCase() === want);
  return hit ? hit[0] : '';
};
const KEEP_MS = Math.max(1000, Math.round(parseFloat(process.env.KEEP_MINUTES || '2') * 60 * 1000) || 120000);
const KEEP_ON = !!(process.env.KEEP_EMAIL && process.env.KEEP_MASTER_TOKEN && process.env.KEEP_LIST);
let keepSync = null;
const SMS_TO = (process.env.SMS_TO || '').split(/[,;\r\n]+/).map((s) => s.replace(/\D/g, '')).filter((s) => s.length >= 10 && s.length <= 11);
const SMS_ON = !!(process.env.TEXTBELT_KEY && SMS_TO.length);
let smsOut = null;
let psApi = null;
let gem = null;
const MAX_BODY = 256 * 1024;
const COLLECTIONS = ['members', 'chores', 'rewards', 'events', 'ledger', 'meals', 'groceries', 'notes', 'config', 'school'];
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
      const docs = ics.build(await fetchFeed(feed.url), { label: feed.label, boardTz: process.env.BOARD_TZ, who: memberIdByName(feed.who), source: feed.source });
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

function smsLedger(before, after, docId) {
  for (const ev of sms.ledgerEvents(before, after)) {
    const m = state.data.members[ev.mid];
    const who = (m && m.name) || 'Someone';
    if (ev.kind === 'approve') {
      const c = state.data.chores[ev.key.split('_').slice(1).join('_')];
      // Still waiting for a grown-up when the delay is up? Only then is a text sent.
      const waiting = () => { const d = state.data.ledger[docId]; return !!d && (d.pend || {})[ev.key] > 0 && !((d.done || {})[ev.key] > 0); };
      smsOut.notify('approve', who, (c && c.title) || 'a chore', waiting);
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
    approveDelayMs: process.env.SMS_APPROVE_DELAY_MS ? parseInt(process.env.SMS_APPROVE_DELAY_MS, 10) : (process.env.SMS_APPROVE_DELAY_MIN ? Math.round(parseFloat(process.env.SMS_APPROVE_DELAY_MIN) * 60000) : undefined),
    log: (m, isErr) => (isErr ? console.error(m) : console.log(m))
  });
  console.log('Text alerts on for ' + SMS_TO.length + ' number' + (SMS_TO.length === 1 ? '' : 's') + (process.env.SMS_DRYRUN === '1' ? ' (dry run)' : '')
    + (process.env.SMS_REMIND_AT ? ', evening nudge at ' + process.env.SMS_REMIND_AT : ''));
  smsNudge();
  setInterval(smsNudge, 60000).unref();
}

/* ---------- parentsquare: school posts and unread messages for the School view ---------- */
function applySchool(docs, okIds, skip) {
  const col = state.data.school;
  skip = skip || new Set();
  let changed = 0;
  for (const [id, d0] of docs) {
    const d = d0.kind === 'status' ? d0 : Object.assign({}, d0, { child: memberIdByName(d0.childName) });
    delete d.body; // the post text is only for the flyer reader, it is not kept on the board
    const ai = gem && d.kind === 'post' ? gem.cached(id) : null;
    if (ai) d.ai = ai;
    const old = col[id];
    const same = d.kind === 'status' ? !!old && old.ok === d.ok && old.message === d.message : JSON.stringify(old) === JSON.stringify(d);
    if (!same) { col[id] = d; changed++; }
  }
  // Anything ParentSquare no longer lists goes away, but only for schools and kinds that were read this time.
  for (const id of Object.keys(col)) {
    const e = col[id];
    if (e && e.src === 'parentsquare' && e.kind !== 'status' && !docs.has(id) && okIds.indexOf(e.sid) > -1 && !skip.has(e.sid + '|' + e.kind)) { delete col[id]; changed++; }
  }
  // Appointments you signed up for also go on the calendar, in that child's color, marked as coming from the school.
  const evs = state.data.events;
  for (const [id, d] of docs) {
    if (d.kind !== 'signup') continue;
    const ev = { title: d.title, allDay: false, sd: d.sd, ed: d.sd, st: d.st, et: d.et, loc: '', who: memberIdByName(d.childName), src: 'parentsquare', cal: d.school, source: 'school', sid: d.sid };
    if (JSON.stringify(evs[id]) !== JSON.stringify(ev)) { evs[id] = ev; changed++; }
  }
  for (const id of Object.keys(evs)) {
    const e = evs[id];
    if (e && e.src === 'parentsquare' && !docs.has(id) && okIds.indexOf(e.sid) > -1 && !skip.has(e.sid + '|signup')) { delete evs[id]; changed++; }
  }
  const posts = Object.keys(col).filter((id) => col[id] && col[id].kind === 'post').sort((a, b) => String(col[b].at).localeCompare(String(col[a].at)));
  for (const id of posts.slice(60)) { delete col[id]; changed++; }
  if (changed) { state.rev += 1; persist().catch((e) => console.error('Could not save school posts: ' + e.message)); }
  // The flyer reader looks at public posts it has not read yet, a few a day, newest first.
  if (gem) gem.offer([...docs].filter(([, d]) => d.kind === 'post').map(([id, d]) => ({ id, title: d.title, author: d.author, body: d.body, snippet: d.snippet, images: d.images, at: d.at })));
}

// Dates the flyer reader found go on the calendar, once, in the child's color. They are marked as read by AI so they
// get checked, and an event that is deleted is not put back because a post is only ever read once.
function addFlyerEvents(docId, doc, r) {
  const evs = state.data.events;
  const plusHour = (t) => { const [h, m] = t.split(':').map(Number); return h >= 23 ? '23:59' : String(h + 1).padStart(2, '0') + ':' + String(m).padStart(2, '0'); };
  let n = 0;
  (r.events || []).forEach((e, i) => {
    const id = 'ai-' + docId.replace(/[^A-Za-z0-9]/g, '') + '-' + i;
    if (evs[id]) return;
    const t = String(e.title).toLowerCase();
    // already on the calendar (from the school feed, for example) under much the same name that day
    const dup = Object.values(evs).some((x) => x && x.sd === e.date && String(x.title || '').length > 2 && (String(x.title).toLowerCase().includes(t) || t.includes(String(x.title).toLowerCase())));
    if (dup) return;
    evs[id] = { title: e.title, allDay: !e.time, sd: e.date, ed: e.date, st: e.time, et: e.time ? plusHour(e.time) : '', loc: '', note: e.details || '', who: doc.child || '',
      src: 'flyer', cal: doc.school || '', source: 'flyer', sid: doc.sid };
    n++;
  });
  return n;
}

// The school lunch menu: each school day's lunch goes on the calendar (and No school days are marked), and the
// per-day menu is kept in the school collection for the Food card. Both are replaced when the district updates a menu.
function applyMenu(m) {
  const col = state.data.school, evs = state.data.events;
  const label = process.env.MENU_LABEL || 'School lunch';
  const always = m.everyday || { breakfast: [], lunch: [] };
  const dates = [...m.days.keys()].sort(), first = dates[0];
  let changed = 0;
  const put = (coll, id, doc) => { if (JSON.stringify(coll[id]) !== JSON.stringify(doc)) { coll[id] = doc; changed++; } };
  const clipTo = (s, n) => (s.length > n ? s.slice(0, n - 3).trim() + '...' : s);
  for (const [date, d] of m.days) {
    put(col, 'menu-' + date, { src: 'menu', kind: 'menu', date, noSchool: d.noSchool, note: d.note, breakfast: d.breakfast, lunch: d.lunch });
    if (d.noSchool) {
      put(evs, 'menu-' + date, { title: clipTo('No school' + (d.note ? ': ' + d.note : ''), 80), allDay: true, sd: date, ed: date, st: '', et: '', loc: '', note: '', who: '', src: 'menu', cal: label, source: 'menu', mk: 'noschool' });
    } else if (d.lunch.length) {
      const note = 'Lunch: ' + d.lunch.join(' / ') + (always.lunch.length ? '. Always available: ' + always.lunch.join(', ') : '')
        + (d.breakfast.length ? '. Breakfast: ' + d.breakfast.join(' / ') : '');
      put(evs, 'menu-' + date, { title: clipTo('Lunch: ' + d.lunch.join(' / '), 90), allDay: true, sd: date, ed: date, st: '', et: '', loc: '', note, who: '', src: 'menu', cal: label, source: 'menu', mk: 'lunch' });
    } else if (evs['menu-' + date]) { delete evs['menu-' + date]; changed++; }
  }
  put(col, 'menu-always', { src: 'menu', kind: 'menuAlways', lunch: always.lunch, breakfast: always.breakfast });
  // a day the district dropped from an updated menu goes away, but days before the menu's first day are history and stay
  for (const id of Object.keys(col)) { const e = col[id]; if (e && e.kind === 'menu' && e.date >= first && !m.days.has(e.date)) { delete col[id]; changed++; } }
  for (const id of Object.keys(evs)) { const e = evs[id]; if (e && e.src === 'menu' && e.sd >= first && !m.days.has(e.sd)) { delete evs[id]; changed++; } }
  if (changed) {
    state.rev += 1;
    persist().catch((e) => console.error('Could not save the lunch menu: ' + e.message));
    console.log('Lunch menu: ' + m.days.size + ' days, ' + changed + ' changed');
  }
}

function startMenu() {
  const poller = menu.create({
    pages: process.env.MENU_PAGE.split(/[,\s]+/).filter((u) => /^https?:\/\//i.test(u)), match: process.env.MENU_MATCH || undefined, gem, file: path.join(DATA_DIR, 'menu-cache.json'),
    onData: applyMenu, log: (m, isErr) => (isErr ? console.error(m) : console.log(m))
  });
  const run = () => poller.poll().catch((e) => console.error('Lunch menu check failed: ' + (e.name === 'TimeoutError' ? 'timeout' : e.message)));
  console.log('Lunch menu on, watching ' + process.env.MENU_PAGE.split(/[,\s]+/).filter(Boolean).map((u) => { try { return new URL(u).host; } catch (e) { return '?'; } }).join(', '));
  setTimeout(run, process.env.MENU_DELAY_MS ? parseInt(process.env.MENU_DELAY_MS, 10) : 15000).unref();
  setInterval(run, Math.max(1000, Math.round(parseFloat(process.env.MENU_HOURS || '6') * 3600 * 1000) || 21600000)).unref();
}

function startGemini() {
  gem = gemini.create({
    key: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL || undefined, base: process.env.GEMINI_BASE || undefined, tz: smsTz(),
    dailyMax: parseInt(process.env.GEMINI_DAILY_MAX || '15', 10) || 15,
    file: path.join(DATA_DIR, 'ai-cache.json'),
    onResult: (id, r) => {
      const doc = state.data.school[id];
      if (!doc) return;
      doc.ai = r;
      const added = addFlyerEvents(id, doc, r);
      if (added) console.log('Flyer reader: ' + added + ' date' + (added === 1 ? '' : 's') + ' added to the calendar');
      state.rev += 1;
      persist().catch((e) => console.error('Could not save a school summary: ' + e.message));
    },
    log: (m, isErr) => (isErr ? console.error(m) : console.log(m))
  });
  console.log('Flyer reader on (' + (process.env.GEMINI_MODEL || gemini.DEFAULT_MODEL) + ', up to ' + (parseInt(process.env.GEMINI_DAILY_MAX || '15', 10) || 15) + ' a day)');
}

function startParentSquare() {
  const schools = process.env.PS_SCHOOLS.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf(':');
    return { id: (i > 0 ? s.slice(0, i) : s).trim(), child: i > 0 ? s.slice(i + 1).trim() : '' };
  }).filter((s) => /^\d+$/.test(s.id));
  if (!schools.length) { console.error('ParentSquare: PS_SCHOOLS has no school ids (use 13482:Xander,13486:Bastian)'); return; }
  const ps = parentsquare.create({
    base: process.env.PS_BASE, user: process.env.PARENTSQUARE_USER, password: process.env.PARENTSQUARE_PASSWORD, schools,
    minLoginGapMs: process.env.PS_LOGIN_GAP_MS ? parseInt(process.env.PS_LOGIN_GAP_MS, 10) : undefined,
    onData: applySchool, tz: smsTz(), preview: process.env.PS_MESSAGE_PREVIEW === '1',
    teachers: (process.env.PS_TEACHERS || '').split(',').map((x) => { const i = x.indexOf(':'); return i > 0 ? { child: x.slice(0, i).trim(), name: x.slice(i + 1).trim() } : null; }).filter((x) => x && x.child && x.name),
    log: (m, isErr) => (isErr ? console.error(m) : console.log(m))
  });
  psApi = ps;
  const run = () => ps.poll().catch((e) => console.error('ParentSquare poll failed: ' + e.message));
  console.log('ParentSquare on for ' + schools.map((s) => (s.child ? s.child + ' at ' : '') + 'school ' + s.id).join(', '));
  run();
  setInterval(run, Math.max(1000, Math.round(parseFloat(process.env.PS_MINUTES || '15') * 60 * 1000) || 900000)).unref();
}

/* ---------- messaging a child's teacher, only with the approval PIN ---------- */
const pinFails = []; // when wrong PINs were tried
const sentAt = [];   // when messages were sent
// The grown-up PIN, checked here and not in the page. Wrong tries are counted for everything that needs it, and five
// of them lock it for ten minutes. Returns null when the PIN is right, otherwise the answer to send back.
function pinGate(b, t) {
  while (pinFails.length && t - pinFails[0] > 600000) pinFails.shift();
  const pin = String((((state.data.config || {}).display) || {}).pin || '');
  if (!pin) return { status: 403, error: 'Set an approval PIN in Setup first' };
  if (pinFails.length >= 5) return { status: 429, error: 'Too many wrong PINs. Try again in a few minutes' };
  const given = Buffer.from(String(b.pin || '')), want = Buffer.from(pin);
  if (!(given.length === want.length && crypto.timingSafeEqual(given, want))) { pinFails.push(t); return { status: 403, error: 'Wrong PIN' }; }
  return null;
}

// Reads one conversation with a teacher, for a grown-up who gave the PIN. The text is handed back and not kept
// on the board, so it is not in the board data or its backups.
async function schoolThread(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (!psApi) return send(res, 503, { error: 'Messages are not set up' });
  let b;
  try { b = await readBody(req); } catch (e) { return send(res, e.status || 400, { error: 'bad body' }, { Connection: 'close' }); }
  const gate = pinGate(b, Date.now());
  if (gate) return send(res, gate.status, { error: gate.error });
  const m = Object.values(state.data.school).find((d) => d && d.kind === 'message' && d.sid === String(b.sid) && d.chat === String(b.chat));
  if (!m) return send(res, 404, { error: 'That conversation is not available' });
  try {
    const messages = await psApi.readThread({ sid: m.sid, chat: m.chat });
    return send(res, 200, { ok: true, name: m.name, messages });
  } catch (e) {
    return send(res, 502, { error: e.message });
  }
}

async function schoolMessage(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (!psApi) return send(res, 503, { error: 'Messaging is not set up' });
  let b;
  try { b = await readBody(req); } catch (e) { return send(res, e.status || 400, { error: 'bad body' }, { Connection: 'close' }); }
  const t = Date.now();
  while (sentAt.length && t - sentAt[0] > 3600000) sentAt.shift();
  const gate = pinGate(b, t);
  if (gate) return send(res, gate.status, { error: gate.error });
  // Only a teacher the server itself found and listed can be written to, never an id the page makes up.
  const tc = Object.values(state.data.school).find((d) => d && d.kind === 'teacher' && d.sid === String(b.sid) && d.tid === String(b.tid));
  if (!tc) return send(res, 404, { error: 'That teacher is not available to message' });
  const text = String(b.text || '').trim();
  if (!text || text.length > 1500) return send(res, 400, { error: 'Write a message first (up to 1500 characters)' });
  if (sentAt.length >= (parseInt(process.env.PS_SEND_MAX || '5', 10) || 5)) return send(res, 429, { error: 'Message limit for this hour reached' });
  sentAt.push(t);
  try {
    const r = await psApi.send({ sid: tc.sid, teacherId: tc.tid, text });
    setTimeout(() => psApi.poll().catch(() => {}), 4000).unref();
    return send(res, 200, { ok: true, teacher: r.teacher, replied: r.replied });
  } catch (e) {
    return send(res, 502, { error: e.message });
  }
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
  if (parts.length === 1 && parts[0] === 'school-message') return schoolMessage(req, res);
  if (parts.length === 1 && parts[0] === 'school-thread') return schoolThread(req, res);
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
      if (coll === 'ledger' && smsOut) { try { smsLedger(before, body, id); } catch (e) { console.error('Text alert failed: ' + e.message); } }
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
    if (process.env.GEMINI_API_KEY) startGemini();
    if (gem && process.env.MENU_PAGE) startMenu();
    if (process.env.PARENTSQUARE_USER && process.env.PARENTSQUARE_PASSWORD && process.env.PS_SCHOOLS) startParentSquare();
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

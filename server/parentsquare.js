'use strict';
/**
 * ParentSquare reader for the Kitchen Board. Zero dependencies.
 *
 * Signs in with the family's own ParentSquare login, reads each school's posts page, and hands the
 * board documents for the School view: recent posts tied to the right child, and the unread message
 * count per school. Message contents are never read, only the unread count.
 *
 * The password is only ever sent to ParentSquare's own sign-in form. The session lives in memory
 * and is renewed when it expires. Sign-in attempts are rate limited and stop after repeated
 * failures, so a wrong password cannot lock the account. Nothing secret is logged.
 *
 * This reads the website the way a browser does, so it can break when ParentSquare changes its
 * pages, and ParentSquare's terms may not allow automated access. Keep the poll gentle.
 */
const { toInstant, validTz } = require('./ics');

const BASE = 'https://www.parentsquare.com';
const UA = 'Mozilla/5.0 (compatible; KitchenBoard/1.0; family use)';

const decode = (s) => String(s || '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
const clip = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trim() + '...' : s; };
const text = (html) => decode(String(html).replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// The pictures in a post's body (flyers and photos live on ParentSquare's public image host). Skips tiny
// tracking pixels and icons, keeps each address once, and caps the count so a newsletter cannot flood the board.
function images(chunk) {
  const out = [];
  const desc = chunk.indexOf('class="description');
  for (const m of (desc > -1 ? chunk.slice(desc, desc + 60000) : '').matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = decode((/\bsrc="([^"]+)"/i.exec(tag) || [])[1] || '').trim();
    if (!/^https:\/\//i.test(src) || src.length > 500 || out.indexOf(src) > -1) continue;
    const w = parseInt((/\bwidth="?(\d+)/i.exec(tag) || [])[1] || '0', 10), h = parseInt((/\bheight="?(\d+)/i.exec(tag) || [])[1] || '0', 10);
    if ((w && w <= 48) || (h && h <= 48) || /emoji|spacer|pixel|tracking|beacon/i.test(src + (/class="([^"]*)"/i.exec(tag) || [])[1])) continue;
    out.push(src);
    if (out.length >= 4) break;
  }
  return out;
}

// Pulls the posts and the unread message count out of a school's posts page.
function parseFeed(html) {
  const posts = [];
  for (const chunk of html.split('<div id="feed_').slice(1)) {
    const id = /^(\d+)"/.exec(chunk);
    const t = /id="feed-title-\d+"[^>]*>([^<]*)</.exec(chunk);
    if (!id || !t) continue;
    const head = chunk.slice(0, 6000);
    const a = /aria-label="Posted by ([^"]+)"/.exec(head);
    let level = '';
    try { level = (JSON.parse(decode((/data-feed-levels="([^"]*)"/.exec(head) || [])[1] || '[]'))[0]) || ''; } catch (e) { level = ''; }
    if (!level) { const lv = /class="text-dark">([^<]+)</.exec(head); level = lv ? decode(lv[1]).trim() : ''; }
    const ts = /data-timestamp="([^"]+)"/.exec(head);
    let at = '';
    if (ts) { const d = new Date(ts[1].replace(' ', 'T')); if (!isNaN(d.getTime())) at = d.toISOString(); }
    const meta = /<ul class="feed-metadata">([\s\S]*?)<\/ul>/.exec(head);
    const chips = [];
    if (meta) for (const m of meta[1].matchAll(/color-highlight">(?:\s*<span[^>]*>)?\s*([^<]+?)\s*</g)) chips.push(decode(m[1]).trim());
    const ev = /dates=(\d{8})T(\d{6})Z/.exec(head);
    const eventAt = ev ? new Date(Date.UTC(+ev[1].slice(0, 4), +ev[1].slice(4, 6) - 1, +ev[1].slice(6, 8), +ev[2].slice(0, 2), +ev[2].slice(2, 4), +ev[2].slice(4, 6))).toISOString() : '';
    const body = /class="description[^"]*"[^>]*>([\s\S]{0,7000})/.exec(chunk);
    posts.push({
      id: id[1], title: decode(t[1]).trim(), author: a ? decode(a[1]).trim() : '', level, at,
      pinned: head.indexOf('fa-thumb-tack') > -1, chips, eventAt, snippet: body ? clip(text(body[1]), 240) : '', images: images(chunk),
      body: body ? clip(text(body[1]), 2500) : ''
    });
  }
  const u = /Unread Messages:<\/span>\s*(\d+)/.exec(html);
  const sn = /<title>[^|<]*\|\s*([^|<]+?)\s*\|/.exec(html);
  const me = /\/schools\/\d+\/users\/(\d+)\/chats/.exec(html);
  return { posts, unread: u ? parseInt(u[1], 10) : 0, school: sn ? decode(sn[1]).trim() : '', uid: me ? me[1] : '' };
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const WDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const pad = (n) => (n < 10 ? '0' : '') + n;
function to24(t) {
  const m = /(\d{1,2}):(\d{2})\s*(am|pm)/i.exec(t || '');
  if (!m) return '';
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return pad(h) + ':' + m[2];
}
// "Friday, Oct 30" has no year, so take the year that makes the weekday fit and lands nearest to now.
function dateFor(weekday, mon, day, nowMs) {
  const wd = WDAYS.indexOf(String(weekday).slice(0, 3).toLowerCase()), mo = MONTHS[String(mon).slice(0, 3).toLowerCase()];
  if (wd < 0 || mo === undefined) return '';
  const y0 = new Date(nowMs).getUTCFullYear();
  let best = '', gap = Infinity;
  for (const y of [y0 - 1, y0, y0 + 1]) {
    const d = new Date(Date.UTC(y, mo, day));
    if (d.getUTCDay() !== wd || d.getUTCMonth() !== mo) continue;
    const g = Math.abs(d.getTime() - nowMs);
    if (g < gap) { gap = g; best = y + '-' + pad(mo + 1) + '-' + pad(day); }
  }
  return best;
}

// Your own appointment slots from a school's Sign Ups page: the slot's day and time, which teacher's list it is on
// and which student it was for. Only entries made by this login (uid) are returned, other families are ignored.
function parseSignups(html, uid, nowMs) {
  const out = [];
  if (!uid) return out;
  for (const chunk of html.split('<div id="feed_').slice(1)) {
    const post = /^(\d+)"/.exec(chunk);
    const ttl = /class="subject[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(chunk);
    if (!post || !ttl) continue;
    const title = text(ttl[1]);
    for (const m of chunk.matchAll(/<li id="sign_up_(\d+)" class="col-sign-ups-entry[\s\S]*?<\/li>/g)) {
      if (m[0].indexOf('/users/' + uid + '"') < 0) continue;
      const before = chunk.slice(0, m.index);
      const last = (re) => { let r = null, x; const g = new RegExp(re.source, 'g'); while ((x = g.exec(before))) r = x; return r; };
      const tm = last(/wish-list-item-time"[^>]*>\s*([^<]+?)\s*</);
      const nm = last(/wish-list-item-name"[^>]*>\s*<p>([^<]*)</);
      const dh = last(/wish-list-date[^"]*"[^>]*>([\s\S]{0,300}?)<\/div>/);
      const dm = dh && /(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})/.exec(text(dh[1]));
      const times = (tm ? decode(tm[1]) : '').match(/\d{1,2}:\d{2}\s*[ap]m/gi) || [];
      const date = dm ? dateFor(dm[1], dm[2], parseInt(dm[3], 10), nowMs) : '';
      if (!date || !times.length) continue;
      const st = to24(times[0]);
      out.push({ id: m[1], post: post[1], title, slot: nm ? decode(nm[1]).trim() : '', date, st, et: to24(times[1] || times[0]) || st });
    }
  }
  return out;
}

// The message list for one school: who wrote, how many messages, when the last one came. Conversations are never
// opened (opening one marks it read on ParentSquare). The last-message text is only kept when preview is asked for.
function parseChats(html, tz, preview) {
  const out = [];
  const zone = validTz(tz) ? tz : 'UTC';
  for (const chunk of html.split('class="a-chat-thread a-chat-thread-').slice(1)) {
    const id = /^(\d+)/.exec(chunk);
    const head = chunk.slice(0, 2500);
    const lab = /aria-label="([^"]+)"/.exec(head);
    if (!id || !lab) continue;
    const l = decode(lab[1]);
    const nm = /^(?:Conversation with|Group conversation(?: with)?)\s*(.+?)\.\s+(\d+)\s+messages?\s+total/i.exec(l);
    const when = /Last message sent:\s*(?:[A-Za-z]{3}\s+)?(\d{1,2})\/(\d{1,2})\/(\d{2}),\s*(\d{1,2}):(\d{2})\s*([ap]m)/i.exec(l);
    let at = '';
    if (when) {
      let h = parseInt(when[4], 10) % 12;
      if (/pm/i.test(when[6])) h += 12;
      at = new Date(toInstant({ y: 2000 + parseInt(when[3], 10), m: parseInt(when[1], 10), d: parseInt(when[2], 10), h, mi: parseInt(when[5], 10), s: 0 }, zone)).toISOString();
    }
    const pv = /class="reaction-icons">([^<]*)</.exec(head);
    out.push({ id: id[1], name: nm ? nm[1].trim() : clip(l.split('.')[0], 60), count: nm ? parseInt(nm[2], 10) : 0, at, preview: preview && pv ? clip(decode(pv[1]), 160) : '' });
  }
  return out;
}

// "Appointment Sign Ups - Bruehling" becomes "Appointment with Bruehling" so the calendar entry reads naturally.
function appointmentTitle(title) {
  const m = /^(.*?)\s*sign[- ]?ups?\s*[-:]\s*(.+)$/i.exec(String(title || '').trim());
  return m ? ((m[1] || 'Appointment').trim() + ' with ' + m[2].trim()) : (String(title || '').trim() || 'Appointment');
}

// The form token any ParentSquare page carries in its head (or in a form).
const csrf = (html) => { const m = /<meta name="csrf-token" content="([^"]+)"/.exec(html) || /name="authenticity_token" value="([^"]+)"/.exec(html); return m ? decode(m[1]) : ''; };

function create(o) {
  const base = (o.base || BASE).replace(/\/$/, '');
  const log = o.log || (() => {});
  const schools = o.schools; // [{id, child}] child is the board member this school belongs to; name is learned from the page
  const jar = new Map();
  let fails = 0, lastTry = 0, stopped = false;
  const now = o.now || Date.now;
  const uids = new Map();            // school id -> this login's user id there
  const teachers = new Map();        // 'sid|name' -> {id, name, role, sid}
  const threads = new Map();         // 'sid|name' -> conversation id, so a message can be a reply in the existing thread
  let lastSend = 0, sending = Promise.resolve();

  const cookieHeader = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');
  function eat(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const [pair] = c.split(';');
      const k = pair.indexOf('=');
      if (k < 1) continue;
      const name = pair.slice(0, k).trim(), val = pair.slice(k + 1).trim();
      if (!val || /max-age=0/i.test(c)) jar.delete(name); else jar.set(name, val);
    }
  }
  async function req(path, init) {
    const res = await fetch(base + path, Object.assign({ redirect: 'manual', signal: AbortSignal.timeout(25000) }, init, {
      headers: Object.assign({ 'User-Agent': UA, Cookie: cookieHeader() }, (init && init.headers) || {})
    }));
    eat(res);
    return res;
  }
  const toSignin = (res) => res.status >= 300 && res.status < 400 && /\/signin|\/sessions/.test(res.headers.get('location') || '');

  // One careful sign-in. Returns true on success. Never logs the password.
  async function login() {
    if (stopped) return false;
    if (now() - lastTry < (o.minLoginGapMs === undefined ? 600000 : o.minLoginGapMs)) return false;
    lastTry = now();
    jar.clear();
    try {
      const page = await (await req('/signin')).text();
      const at = page.indexOf('action="/sessions"');
      const tok = /name="authenticity_token" value="([^"]+)"/.exec(at > -1 ? page.slice(at) : page);
      if (!tok) throw new Error('sign-in page has changed');
      const form = new URLSearchParams({ authenticity_token: decode(tok[1]), 'session[email]': o.user, 'session[password]': o.password, commit: 'Sign in' });
      const utf = /name="utf8" value="([^"]*)"/.exec(page);
      if (utf) form.set('utf8', decode(utf[1]));
      const res = await req('/sessions', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base, Referer: base + '/signin' }, body: form.toString() });
      const where = res.headers.get('location') || '';
      if (res.status >= 300 && res.status < 400 && !/\/signin|\/sessions/.test(where)) {
        fails = 0;
        log('ParentSquare: signed in');
        return true;
      }
      throw new Error(res.status >= 300 && res.status < 400 ? 'sign-in refused' : 'sign-in refused (HTTP ' + res.status + ')');
    } catch (e) {
      fails += 1;
      log('ParentSquare sign-in failed (' + fails + '): ' + e.message, true);
      if (fails >= 3) {
        stopped = true;
        log('ParentSquare sign-in stopped after 3 failures. Check the login in the env file and restart.', true);
      }
      return false;
    }
  }

  // A page of the signed-in site, or null if it cannot be read. Only list pages are fetched this way,
  // never a single conversation (opening one marks it read on ParentSquare).
  async function getPage(path) {
    const res = await req(path);
    if (toSignin(res)) { jar.clear(); return null; }
    if (res.status !== 200) return null;
    const html = await res.text();
    return html.indexOf('name="session[password]"') > -1 ? null : html;
  }

  async function fetchSchool(s) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!jar.size && !(await login())) return null;
      const res = await req('/schools/' + s.id + '/feeds');
      if (toSignin(res)) { jar.clear(); continue; }
      if (res.status !== 200) { log('ParentSquare school ' + s.id + ': HTTP ' + res.status, true); return null; }
      const html = await res.text();
      if (html.indexOf('name="session[password]"') > -1) { jar.clear(); continue; }
      const feed = parseFeed(html);
      if (feed.uid) uids.set(s.id, feed.uid);
      // Sign-ups and the message list are extras. If either cannot be read the posts still come through.
      // null means "could not be read", which must never be mistaken for "there are none".
      let signups = null, chats = null;
      try {
        const su = await getPage('/schools/' + s.id + '/sign_ups');
        if (su && feed.uid) signups = parseSignups(su, feed.uid, now());
        const ch = feed.uid ? await getPage('/schools/' + s.id + '/users/' + feed.uid + '/chats') : null;
        if (ch) chats = parseChats(ch, o.tz, !!o.preview);
      } catch (e) { log('ParentSquare school ' + s.id + ' sign-ups or messages failed: ' + (e.name === 'TimeoutError' ? 'timeout' : 'network'), true); }
      return Object.assign(feed, { signups, chats });
    }
    return null;
  }

  // Finds a teacher the way ParentSquare's own recipient picker does (a read-only search), so the board only ever
  // offers people that were named in the settings and that ParentSquare itself lists as contacts.
  async function findTeacher(s, name) {
    const key = s.id + '|' + name.toLowerCase();
    if (teachers.has(key)) return teachers.get(key);
    const last = name.trim().split(/\s+/).pop();
    const res = await req('/schools/' + s.id + '/users/autocomplete?limit=25&chat=1&query=' + encodeURIComponent(last), { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
    if (res.status !== 200) return null;
    let j; try { j = await res.json(); } catch (e) { return null; }
    const list = Array.isArray(j) && Array.isArray(j[0]) ? j[0] : [];
    const hit = list.filter((u) => u && String(u.name || '').trim().toLowerCase() === name.trim().toLowerCase() && !u.is_student);
    if (hit.length !== 1) { log('ParentSquare: could not pin down teacher "' + name + '" (' + hit.length + ' matches)', true); return null; }
    const t = { id: String(hit[0].id), name: hit[0].name, role: ((hit[0].role || [])[0]) || '', sid: s.id };
    teachers.set(key, t);
    return t;
  }

  // Sends one message to one teacher: a reply in the existing conversation if there is one, otherwise a new direct
  // message. Only a teacher that findTeacher() returned can be written to, so the board cannot message anyone else.
  // Exactly one attempt, never retried, so a message cannot go out twice by accident.
  function send(a) {
    const run = async () => {
      if (stopped) throw new Error('ParentSquare sign-in is not working');
      const s = schools.find((x) => x.id === a.sid);
      const t = [...teachers.values()].find((x) => x.sid === a.sid && x.id === String(a.teacherId));
      const uid = uids.get(a.sid);
      if (!s || !t || !uid) throw new Error('that teacher is not available to message');
      const text = String(a.text || '').trim();
      if (!text || text.length > 1500) throw new Error('the message is empty or too long');
      const wait = (o.minSendGapMs === undefined ? 5000 : o.minSendGapMs) - (now() - lastSend);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastSend = now();
      if (!jar.size && !(await login())) throw new Error('could not sign in to ParentSquare');
      const thread = threads.get(a.sid + '|' + t.name.toLowerCase());
      const formPage = thread ? '/schools/' + a.sid + '/users/' + uid + '/chats' : '/schools/' + a.sid + '/users/' + uid + '/chats/new?private=true';
      const html = await getPage(formPage);
      const token = html ? csrf(html) : '';
      if (!token) throw new Error('ParentSquare did not give a form to send with');
      const form = new URLSearchParams({ utf8: '\u2713', authenticity_token: token, message: text });
      let path;
      if (thread) path = '/users/' + uid + '/chats/' + thread + '/messages';
      else {
        path = '/schools/' + a.sid + '/users/' + uid + '/chats';
        form.set('institute_id', a.sid); form.set('institute_type', 'School'); form.set('private', 'true'); form.set('users', t.id); form.set('recipient_data', '');
      }
      const res = await req(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base, Referer: base + formPage }, body: form.toString() });
      const where = res.headers.get('location') || '';
      const accepted = res.status >= 300 && res.status < 400 ? !/\/signin|\/sessions|\/new/.test(where) : res.status === 200 || res.status === 201 || res.status === 204;
      if (!accepted) throw new Error('ParentSquare did not accept the message (HTTP ' + res.status + '). Check ParentSquare before trying again');
      log('ParentSquare: message sent for ' + (s.child || 'a child'));
      return { ok: true, teacher: t.name, replied: !!thread };
    };
    const p = sending.then(run, run);
    sending = p.catch(() => {});
    return p;
  }

  // One look at every school. Hands o.onData(docs, okSchoolIds) the documents for the School view.
  // A school that could not be read is left alone, so its last known posts stay on the board.
  async function poll() {
    const docs = new Map(), ok = [], skip = new Set(); // skip: 'schoolId|kind' pairs that could not be read this time
    if (!stopped) {
      for (const s of schools) {
        let r;
        try { r = await fetchSchool(s); } catch (e) { log('ParentSquare school ' + s.id + ' failed: ' + (e.name === 'TimeoutError' ? 'timeout' : 'network'), true); continue; }
        if (!r) continue;
        ok.push(s.id);
        if (r.school) s.name = r.school;
        for (const p of r.posts) {
          const key = 'ps-' + p.id;
          if (docs.has(key)) continue; // a district post is listed in every school's feed
          // District posts belong to everyone. Everything else in a school's feed (the school itself, or a class or
          // group like "3rd Grade 2026-2027") belongs to that school's child.
          const district = /district/i.test(p.level) && p.level !== r.school;
          const sameAsSchool = !p.level || !r.school || p.level === r.school;
          docs.set(key, {
            src: 'parentsquare', kind: 'post', sid: s.id, title: p.title, author: p.author, school: district ? p.level : (s.name || ''),
            level: district ? 'district' : sameAsSchool ? 'school' : 'class', group: district || sameAsSchool ? '' : p.level,
            childName: district ? '' : (s.child || ''), at: p.at, pinned: p.pinned, chips: p.chips,
            eventAt: p.eventAt, snippet: p.snippet, images: p.images, url: base + '/feeds/' + p.id,
            body: p.body // only passed along for the flyer reader, the server does not store it
          });
        }
        docs.set('ps-unread-' + s.id, { src: 'parentsquare', kind: 'unread', sid: s.id, n: r.unread, school: s.name || '', childName: s.child || '', url: base + '/schools/' + s.id + '/feeds' });
        if (!r.signups) skip.add(s.id + '|signup');
        if (!r.chats) skip.add(s.id + '|message');
        for (const g of (r.signups || [])) {
          docs.set('ps-su-' + g.id, { src: 'parentsquare', kind: 'signup', sid: s.id, title: appointmentTitle(g.title), post: g.post, slot: g.slot, sd: g.date, st: g.st, et: g.et,
            school: s.name || '', childName: s.child || '', url: base + '/feeds/' + g.post });
        }
        // Newest conversations first. ParentSquare reports how many messages are unread, so that many of the newest are flagged.
        const recent = (r.chats || []).filter((c) => c.at && now() - new Date(c.at).getTime() < 45 * 864e5).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 5);
        recent.forEach((c, i) => {
          docs.set('ps-chat-' + c.id, { src: 'parentsquare', kind: 'message', sid: s.id, name: c.name, count: c.count, at: c.at, unread: i < r.unread, preview: c.preview,
            school: s.name || '', childName: s.child || '', url: base + '/schools/' + s.id + '/users/' + (uids.get(s.id) || '') + '/chats/' + c.id });
        });
        for (const c of (r.chats || [])) threads.set(s.id + '|' + String(c.name).toLowerCase(), c.id);
        for (const tn of (o.teachers || []).filter((x) => x.child && x.child.toLowerCase() === String(s.child || '').toLowerCase())) {
          let t = null;
          try { t = await findTeacher(s, tn.name); } catch (e) { log('ParentSquare teacher lookup failed: ' + (e.name === 'TimeoutError' ? 'timeout' : 'network'), true); }
          if (!t) skip.add(s.id + '|teacher');
          if (t) docs.set('ps-teacher-' + s.id + '-' + t.id, { src: 'parentsquare', kind: 'teacher', sid: s.id, tid: t.id, name: t.name, role: t.role, school: s.name || '', childName: s.child || '', canReply: threads.has(s.id + '|' + t.name.toLowerCase()) });
        }
      }
    }
    docs.set('ps-status', ok.length === schools.length ? { src: 'parentsquare', kind: 'status', ok: true, at: new Date(now()).toISOString() }
      : { src: 'parentsquare', kind: 'status', ok: false, at: new Date(now()).toISOString(),
        message: stopped ? 'ParentSquare sign-in stopped, check the login' : 'Could not read ' + (ok.length ? 'every school' : 'ParentSquare') + ' just now' });
    if (o.onData) o.onData(docs, ok, skip);
    return docs;
  }

  return { poll, login, parseFeed, send };
}

module.exports = { create, parseFeed, parseSignups, parseChats, appointmentTitle };

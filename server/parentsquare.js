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
const BASE = 'https://www.parentsquare.com';
const UA = 'Mozilla/5.0 (compatible; KitchenBoard/1.0; family use)';

const decode = (s) => String(s || '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
const clip = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trim() + '...' : s; };
const text = (html) => decode(String(html).replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

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
      pinned: head.indexOf('fa-thumb-tack') > -1, chips, eventAt, snippet: body ? clip(text(body[1]), 240) : ''
    });
  }
  const u = /Unread Messages:<\/span>\s*(\d+)/.exec(html);
  const sn = /<title>[^|<]*\|\s*([^|<]+?)\s*\|/.exec(html);
  return { posts, unread: u ? parseInt(u[1], 10) : 0, school: sn ? decode(sn[1]).trim() : '' };
}

function create(o) {
  const base = (o.base || BASE).replace(/\/$/, '');
  const log = o.log || (() => {});
  const schools = o.schools; // [{id, child}] child is the board member this school belongs to; name is learned from the page
  const jar = new Map();
  let fails = 0, lastTry = 0, stopped = false;
  const now = o.now || Date.now;

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

  async function fetchSchool(s) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!jar.size && !(await login())) return null;
      const res = await req('/schools/' + s.id + '/feeds');
      if (toSignin(res)) { jar.clear(); continue; }
      if (res.status !== 200) { log('ParentSquare school ' + s.id + ': HTTP ' + res.status, true); return null; }
      const html = await res.text();
      if (html.indexOf('name="session[password]"') > -1) { jar.clear(); continue; }
      return parseFeed(html);
    }
    return null;
  }

  // One look at every school. Hands o.onData(docs, okSchoolIds) the documents for the School view.
  // A school that could not be read is left alone, so its last known posts stay on the board.
  async function poll() {
    const docs = new Map(), ok = [];
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
          // A post from the school's own level belongs to that school's child. District posts belong to everyone.
          const own = !p.level || !r.school || p.level === r.school;
          docs.set(key, {
            src: 'parentsquare', kind: 'post', sid: s.id, title: p.title, author: p.author, school: own ? (s.name || '') : p.level,
            level: own ? 'school' : 'district', childName: own ? (s.child || '') : '', at: p.at, pinned: p.pinned, chips: p.chips,
            eventAt: p.eventAt, snippet: p.snippet, url: base + '/feeds/' + p.id
          });
        }
        docs.set('ps-unread-' + s.id, { src: 'parentsquare', kind: 'unread', sid: s.id, n: r.unread, school: s.name || '', childName: s.child || '', url: base + '/schools/' + s.id + '/feeds' });
      }
    }
    docs.set('ps-status', ok.length === schools.length ? { src: 'parentsquare', kind: 'status', ok: true, at: new Date(now()).toISOString() }
      : { src: 'parentsquare', kind: 'status', ok: false, at: new Date(now()).toISOString(),
        message: stopped ? 'ParentSquare sign-in stopped, check the login' : 'Could not read ' + (ok.length ? 'every school' : 'ParentSquare') + ' just now' });
    if (o.onData) o.onData(docs, ok);
    return docs;
  }

  return { poll, login, parseFeed };
}

module.exports = { create, parseFeed };

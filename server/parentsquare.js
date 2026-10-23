'use strict';
/**
 * ParentSquare watcher for the Kitchen Board. Zero dependencies.
 *
 * Signs in with the family's own ParentSquare login, reads each school's posts page, and tells
 * the parents (through the notify function) about new school posts and new unread messages.
 * Message contents are never read, only the unread count.
 *
 * The password is only ever sent to ParentSquare's own sign-in form. The session lives in memory
 * and is renewed when it expires. Sign-in attempts are rate limited and stop after repeated
 * failures, so a wrong password cannot lock the account. Nothing secret is logged.
 *
 * This reads the website the way a browser does, so it can break when ParentSquare changes its
 * pages, and ParentSquare's terms may not allow automated access. Keep the poll gentle.
 */
const fs = require('fs');

const BASE = 'https://www.parentsquare.com';
const UA = 'Mozilla/5.0 (compatible; KitchenBoard/1.0; family use)';

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&apos;/g, "'");
const clip = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trim() + '...' : s; };

// Pulls posts and the unread message count out of a school's posts page.
function parseFeed(html) {
  const posts = [];
  const parts = html.split('class="feed-title"').slice(1);
  for (const chunk of parts) {
    const head = chunk.slice(0, 2500);
    const t = /id="feed-title-(\d+)"[^>]*>([^<]*)</.exec(head);
    if (!t) continue;
    const a = /aria-label="Posted by ([^"]+)"/.exec(head);
    const lv = /class="text-dark">([^<]+)</.exec(head);
    posts.push({ id: t[1], title: decode(t[2]).trim(), author: a ? decode(a[1]).trim() : '', level: lv ? decode(lv[1]).trim() : '' });
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
  let fails = 0, lastTry = 0, stopped = false, stopNotified = false;
  const now = o.now || Date.now;
  let seen = null;

  function loadSeen() {
    if (seen) return seen;
    try { seen = JSON.parse(fs.readFileSync(o.stateFile, 'utf8')); } catch (e) { seen = null; }
    return seen;
  }
  function saveSeen() { try { fs.writeFileSync(o.stateFile + '.tmp', JSON.stringify(seen)); fs.renameSync(o.stateFile + '.tmp', o.stateFile); } catch (e) { log('Could not save ParentSquare state: ' + e.message, true); } }

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
        if (!stopNotified && o.notify) { stopNotified = true; o.notify('ParentSquare login is not working, so school alerts are paused.'); }
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

  async function poll() {
    if (stopped) return;
    const first = loadSeen() === null;
    if (first) seen = { posts: {}, unread: {} };
    const newPosts = [], unreadUp = [];
    for (const s of schools) {
      let r;
      try { r = await fetchSchool(s); } catch (e) { log('ParentSquare school ' + s.id + ' failed: ' + (e.name === 'TimeoutError' ? 'timeout' : 'network'), true); continue; }
      if (!r) continue;
      if (r.school) s.name = r.school;
      for (const p of r.posts) {
        if (seen.posts[p.id]) continue;
        seen.posts[p.id] = 1;
        // A post from the school's own level belongs to that school's child. District posts show up in every
        // feed and belong to everyone, so they are noted once.
        const own = !p.level || !r.school || p.level === r.school;
        if (!first) newPosts.push({ who: own ? (s.child || s.name) : 'District', school: own ? s.name : '', title: p.title, author: p.author });
      }
      const prev = seen.unread[s.id];
      if (!first && prev !== undefined && r.unread > prev) unreadUp.push({ who: s.child || s.name, school: s.name, n: r.unread });
      seen.unread[s.id] = r.unread;
    }
    const ids = Object.keys(seen.posts);
    if (ids.length > 600) for (const id of ids.slice(0, ids.length - 400)) delete seen.posts[id];
    saveSeen();
    if (first) log('ParentSquare: watching ' + schools.map((s) => (s.child ? s.child + ' at ' : '') + (s.name || s.id)).join(', ') + ', ' + Object.keys(seen.posts).length + ' existing posts noted');
    if (!o.notify) return;
    const tag = (p) => p.who + (p.school ? ' (' + p.school + ')' : '');
    const one = (p) => tag(p) + ': "' + clip(p.title, 60) + '"' + (p.author ? ' by ' + p.author : '');
    if (newPosts.length) {
      o.notify(newPosts.length === 1 ? 'New school post for ' + one(newPosts[0]) : newPosts.length + ' new school posts. ' + newPosts.slice(0, 3).map(one).join('; ') + (newPosts.length > 3 ? '; and ' + (newPosts.length - 3) + ' more' : ''));
    }
    for (const u of unreadUp) o.notify(u.who + '\'s school (' + u.school + '): you have ' + u.n + ' unread ParentSquare message' + (u.n === 1 ? '' : 's') + '.');
  }

  return { poll, login, parseFeed };
}

module.exports = { create, parseFeed };

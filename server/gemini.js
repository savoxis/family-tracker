'use strict';
/**
 * Flyer reader for the Kitchen Board. Zero dependencies.
 *
 * Reads each public school post once with Google's Gemini (title, text and up to two pictures) and keeps a
 * plain-language summary, what a parent needs to do or bring, and any dates the post states. Results are cached
 * on disk so a post is never read twice, and a daily cap keeps well inside the free allowance.
 *
 * Only public school posts go to Google. Message conversations and anything private never do. The free tier may
 * use what is sent to improve Google's products, which is one more reason to keep it to public announcements.
 * The API key is a secret: it is sent only to Google in a request header and never logged.
 */
const fs = require('fs');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
// A small fast model that answers in a second or two. The "latest" aliases can point at slower thinking models that never
// answer within a minute, which burned the daily allowance on timeouts, so the model is pinned.
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const MAX_IMAGE = 4 * 1024 * 1024;

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trim() + '...' : s; };
const dayKey = (ms, tz) => {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return p.year + '-' + p.month + '-' + p.day;
};

async function fetchImage(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE) return null;
    return { mime, data: buf.toString('base64') };
  } catch (e) { return null; }
}

const PROMPT = (today) => 'You read one school announcement for a busy parent and pull out what matters. Today is ' + today + '. '
  + 'Reply with JSON only, in this shape: {"summary": one plain sentence under 140 characters saying what the post is about, '
  + '"action": what a parent needs to do or bring, with any deadline, under 140 characters, or "" if nothing is needed, '
  + '"events": [{"title": short name of the event or of that day, "date": "YYYY-MM-DD", "time": "HH:MM" in 24-hour time or "", '
  + '"details": what to do, wear or bring that day, under 120 characters, or ""}]}. '
  + 'When a post lists something for each day of a week, like a spirit week, give one event per day with that day\'s theme as the title and what to do or wear as the details. '
  + 'Dates may leave out the year, so use the year that puts the date soonest after today. '
  + 'Use only facts that are in the text or the pictures. List an event only when the post states a specific date. '
  + 'If a picture is only decoration or has no information, ignore it. Do not guess.';

// Turns the model's answer into something safe to store and show.
function clean(raw, today) {
  let j;
  try { j = typeof raw === 'string' ? JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) : raw; } catch (e) { return null; }
  if (!j || typeof j !== 'object') return null;
  const horizon = Date.parse(today + 'T00:00:00Z') + 400 * 864e5, floor = Date.parse(today + 'T00:00:00Z') - 2 * 864e5;
  const events = (Array.isArray(j.events) ? j.events : []).map((e) => ({ title: clip(e && e.title, 80), date: String((e && e.date) || ''), time: String((e && e.time) || ''), details: clip(e && e.details, 140) }))
    .filter((e) => e.title && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && Date.parse(e.date + 'T00:00:00Z') >= floor && Date.parse(e.date + 'T00:00:00Z') <= horizon)
    .map((e) => ({ title: e.title, date: e.date, time: /^([01]\d|2[0-3]):[0-5]\d$/.test(e.time) ? e.time : '', details: e.details })).slice(0, 8);
  const summary = clip(j.summary, 160), action = clip(j.action, 160);
  if (!summary && !action && !events.length) return null;
  return { summary, action, events };
}

async function readPost(o, post, today) {
  const parts = [{ text: PROMPT(today) + '\n\nPost title: ' + clip(post.title, 200) + '\nPosted by: ' + clip(post.author, 80) + '\nPost text: ' + clip(post.body || post.snippet, 2500) }];
  for (const u of (post.images || []).slice(0, 2)) {
    const im = await fetchImage(u);
    if (im) parts.push({ inline_data: { mime_type: im.mime, data: im.data } });
  }
  return clean(await generate(o, parts), today);
}

// One request to Gemini, the answer as text. The key goes in a header and nowhere else.
async function generate(o, parts) {
  const res = await fetch((o.base || BASE) + '/models/' + o.model + ':generateContent', {
    method: 'POST', signal: AbortSignal.timeout(45000),
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': o.key },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } })
  });
  if (res.status === 429) throw Object.assign(new Error('Gemini daily limit reached'), { quota: true });
  if (!res.ok) throw new Error('Gemini HTTP ' + res.status);
  const j = await res.json().catch(() => ({}));
  const text = (((j.candidates || [])[0] || {}).content || {}).parts;
  return (text || []).map((p) => p.text || '').join('');
}

const MENU_PROMPT = (today) => 'This is one month of a school lunch menu, laid out as a calendar. Today is ' + today + '. '
  + 'Reply with JSON only, in this shape: {"month": "YYYY-MM", "everyday": {"breakfast": [items offered every day], "lunch": [items offered every day]}, '
  + '"days": [{"date": "YYYY-MM-DD", "noSchool": true or false, "note": "", "breakfast": [items], "lunch": [items]}]}. '
  + 'Include every school day the calendar shows. A day marked no school has noSchool true and empty lists. '
  + 'Each item is one short menu choice as printed, with obvious typos fixed, for example "Chicken Tenders w/fries". '
  + 'Use only what the menu says. Do not invent days or items.';

// Makes the model's menu answer safe to store: real dates in one month, short lists of short items.
function cleanMenu(raw, today) {
  let j;
  try { j = typeof raw === 'string' ? JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) : raw; } catch (e) { return null; }
  if (!j || typeof j !== 'object' || !Array.isArray(j.days)) return null;
  const t0 = Date.parse(today + 'T00:00:00Z'), items = (a) => (Array.isArray(a) ? a : []).map((x) => clip(x, 70)).filter(Boolean).slice(0, 8);
  const seen = new Set(), days = [];
  for (const d of j.days) {
    const date = String((d && d.date) || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || seen.has(date)) continue;
    const t = Date.parse(date + 'T00:00:00Z');
    if (isNaN(t) || t < t0 - 60 * 864e5 || t > t0 + 75 * 864e5) continue;
    seen.add(date);
    const no = !!d.noSchool;
    days.push({ date, noSchool: no, note: clip(d.note, 80), breakfast: no ? [] : items(d.breakfast), lunch: no ? [] : items(d.lunch) });
  }
  if (days.filter((d) => !d.noSchool && d.lunch.length).length < 3) return null; // too little to be a real menu
  const ev = j.everyday && typeof j.everyday === 'object' ? j.everyday : {};
  return { month: /^\d{4}-\d{2}$/.test(String(j.month || '')) ? j.month : days[0].date.slice(0, 7), everyday: { breakfast: items(ev.breakfast), lunch: items(ev.lunch) }, days: days.sort((a, b) => (a.date < b.date ? -1 : 1)) };
}

function create(o) {
  const log = o.log || (() => {});
  const now = o.now || Date.now;
  const tz = o.tz || 'UTC';
  const dailyMax = o.dailyMax || 15;
  const model = o.model || DEFAULT_MODEL;
  let failsInARow = 0;
  let st = { day: '', used: 0, stop: false, posts: {} };
  try { const j = JSON.parse(fs.readFileSync(o.file, 'utf8')); if (j && typeof j === 'object') st = Object.assign(st, j, { posts: j.posts || {} }); } catch (e) { /* first run */ }
  let running = false, queue = new Map();

  const save = () => { try { fs.writeFileSync(o.file + '.tmp', JSON.stringify(st)); fs.renameSync(o.file + '.tmp', o.file); } catch (e) { log('Could not save Gemini cache: ' + e.message, true); } };
  const cached = (id) => (st.posts[id] && st.posts[id].r) || null;

  // Posts worth reading: a picture to read, or text that was cut short. Newest first, each one once, nothing old.
  function offer(posts) {
    for (const p of posts) {
      if (!p || !p.id || st.posts[p.id] || queue.has(p.id)) continue;
      if (!((p.images && p.images.length) || String(p.body || p.snippet || '').length >= 200)) continue;
      if (p.at && now() - new Date(p.at).getTime() > 30 * 864e5) continue;
      queue.set(p.id, p);
    }
    return run();
  }

  async function run() {
    if (running) return;
    running = true;
    try {
      const today = dayKey(now(), tz);
      if (st.day !== today) { st.day = today; st.used = 0; st.stop = false; }
      const todo = [...queue.values()].sort((a, b) => String(b.at || '') < String(a.at || '') ? -1 : 1);
      for (const p of todo) {
        if (st.stop || st.used >= dailyMax) break;
        queue.delete(p.id);
        st.used += 1;
        try {
          const r = await readPost({ key: o.key, model, base: o.base }, p, today);
          failsInARow = 0;
          st.posts[p.id] = { r: r || { summary: '', action: '', events: [] }, at: new Date(now()).toISOString() };
          save();
          if (r && o.onResult) o.onResult(p.id, r);
          log('Gemini: read a school post' + (r ? '' : ' (nothing useful found)') + ', ' + st.used + ' of ' + dailyMax + ' used today');
        } catch (e) {
          if (e.quota) { st.stop = true; log('Gemini: daily limit reached, stopping for today', true); }
          else {
            log('Gemini failed: ' + (e.name === 'TimeoutError' ? 'timeout' : e.message), true);
            // two failures in a row means something is wrong, so stop for the day instead of using up the allowance
            failsInARow += 1;
            if (failsInARow >= 2) { st.stop = true; log('Gemini: stopping for today after repeated failures', true); }
          }
          save();
        }
        await new Promise((r) => setTimeout(r, o.gapMs === undefined ? 2000 : o.gapMs));
      }
      save();
    } finally { running = false; }
  }

  // Reads a menu PDF. It may go a little past the daily cap for posts (the cap is below the real allowance on purpose),
  // since one menu a month matters more than one more post.
  async function readMenu(buf) {
    const today = dayKey(now(), tz);
    if (st.day !== today) { st.day = today; st.used = 0; st.stop = false; }
    if (st.stop || st.used >= dailyMax + 3) throw Object.assign(new Error('the Gemini allowance for today is used up'), { quota: true });
    if (!buf || !buf.length || buf.length > 8 * 1024 * 1024) throw new Error('the menu file is empty or too large');
    st.used += 1; save();
    try {
      const text = await generate({ key: o.key, model, base: o.base }, [{ text: MENU_PROMPT(today) }, { inline_data: { mime_type: 'application/pdf', data: Buffer.from(buf).toString('base64') } }]);
      const r = cleanMenu(text, today);
      if (!r) throw new Error('that did not look like a menu');
      log('Gemini: read a lunch menu (' + r.days.length + ' days), ' + st.used + ' used today');
      return r;
    } catch (e) { if (e.quota) { st.stop = true; save(); } throw e; }
  }

  return { offer, cached, readMenu, stats: () => ({ used: st.used, day: st.day, stop: st.stop, read: Object.keys(st.posts).length, waiting: queue.size }) };
}

module.exports = { create, clean, cleanMenu, DEFAULT_MODEL };

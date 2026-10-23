'use strict';
/**
 * Text message alerts for the parents through Textbelt. Zero dependencies.
 *
 * - approval requests: a kid finished a chore and it needs a grown-up's OK
 * - reward cash-ins
 * - an evening "chores left" nudge, once a day
 *
 * Quick bursts are combined into one text, repeats are dropped, and a daily cap protects the
 * credits. The API key and the phone numbers are secrets: they come from the environment, are
 * never logged in full, and never leave this file's requests to Textbelt.
 */
const TEXTBELT = 'https://textbelt.com/text';
const CASHIN_SKIP = /^(Adjustment|Bonus|Allowance paid)/;

const mask = (n) => '***' + String(n).slice(-4);
function listWords(items, max) {
  const l = items.slice(0, max || 4);
  const more = items.length - l.length;
  if (more > 0) l.push(more + ' more');
  return l.length < 2 ? l.join('') : l.slice(0, -1).join(', ') + ' and ' + l[l.length - 1];
}

// What changed in one ledger document: new approval requests and new reward cash-ins.
function ledgerEvents(before, after) {
  const out = [];
  const old = before || {}, nu = after || {};
  for (const k of Object.keys(nu.pend || {})) {
    if (nu.pend[k] > 0 && !((old.pend || {})[k] > 0) && !((nu.done || {})[k] > 0)) out.push({ kind: 'approve', mid: nu.memberId, key: k });
  }
  for (const k of Object.keys(nu.spent || {})) {
    const sp = nu.spent[k];
    if (!sp || (old.spent || {})[k] || !(sp.cost > 0) || CASHIN_SKIP.test(sp.title || '')) continue;
    out.push({ kind: 'cash', mid: nu.memberId, title: sp.title || 'a reward', cost: sp.cost });
  }
  return out;
}

/* ---------- the evening nudge: who still has chores left today ---------- */
function localDay(now, tz) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' }).formatToParts(new Date(now))) p[x.type] = x.value;
  const pad = (n) => (n < 10 ? '0' : '') + n;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
    key: p.year + '-' + pad(+p.month) + '-' + pad(+p.day) };
}

// Same rules as the page: daily chores only, rotation by day or week, weekday filter.
function choresLeft(data, now, tz) {
  const t = localDay(now, tz);
  const days = Math.floor(Date.UTC(t.y, t.m - 1, t.d) / 864e5);
  const onDuty = (c, mid) => {
    const ids = (c.memberIds || []).slice().sort();
    if (!c.rot || ids.length < 2) return true;
    return ids[(c.rot === 'week' ? Math.floor((days + 3) / 7) : days) % ids.length] === mid;
  };
  const out = [];
  for (const mid of Object.keys(data.members || {})) {
    const mine = Object.keys(data.chores || {}).map((id) => Object.assign({ id }, data.chores[id])).filter((c) => {
      if (c.routine || c.weekly || (c.memberIds || []).indexOf(mid) < 0 || !onDuty(c, mid)) return false;
      return !c.days || !c.days.length || c.days.indexOf(t.wd) > -1;
    });
    if (!mine.length) continue;
    const done = (id) => Object.values(data.ledger || {}).some((l) => l.memberId === mid && (l.done || {})[t.key + '_' + id] > 0);
    const left = mine.filter((c) => !done(c.id)).map((c) => c.title);
    if (left.length) out.push({ mid, name: data.members[mid].name, left });
  }
  return out;
}

function create(o) {
  const log = o.log || (() => {});
  const url = o.url || TEXTBELT;
  const tz = o.tz || 'UTC';
  const now = o.now || Date.now;
  const batchMs = o.batchMs === undefined ? 30000 : o.batchMs;
  // Approval requests wait, so a parent who approves on the board in the meantime is never texted.
  const approveDelayMs = o.approveDelayMs === undefined ? 3600000 : o.approveDelayMs;
  const dailyMax = o.dailyMax || 12;
  const recent = new Map();
  const buckets = new Map();
  let day = '', count = 0, lowWarned = '';

  async function post(phone, message) {
    const res = await fetch(url, {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ phone, message, key: o.key }).toString()
    });
    return res.json().catch(() => ({}));
  }

  // Sends one message to every parent. Drops repeats from the last 10 minutes and anything over the daily cap.
  async function send(message, opts) {
    message = ('Kitchen Board: ' + message).slice(0, 300);
    const t = now(), today = localDay(t, tz).key;
    if (day !== today) { day = today; count = 0; }
    for (const [m, at] of recent) if (t - at > 600000) recent.delete(m);
    if (recent.has(message)) return { skipped: 'repeat' };
    if (!(opts && opts.force) && count >= dailyMax) { log('Text skipped, daily limit of ' + dailyMax + ' reached'); return { skipped: 'cap' }; }
    recent.set(message, t);
    count += 1;
    if (o.dryRun) { log('Text dry run, would send: ' + message); return { dryRun: true }; }
    let quota;
    for (const phone of o.to) {
      try {
        const r = await post(phone, message);
        if (r.success) { quota = r.quotaRemaining; log('Text sent to ' + mask(phone) + ', credits left ' + r.quotaRemaining); }
        else log('Text to ' + mask(phone) + ' failed: ' + (r.error || 'unknown'), true);
      } catch (e) { log('Text to ' + mask(phone) + ' failed: ' + (e.name === 'TimeoutError' ? 'timeout' : 'network'), true); }
    }
    if (quota !== undefined && quota <= (o.lowAt || 20) && lowWarned !== today) {
      lowWarned = today;
      await send('Text credits are running low (' + quota + ' left).', { force: true });
    }
    return { sent: true, quota };
  }

  function flush(bk) {
    const b = buckets.get(bk); buckets.delete(bk);
    if (!b) return;
    // Anything that no longer needs saying (already approved) is dropped when the time comes.
    const items = b.items.filter((i) => !i.check || i.check()).map((i) => i.text);
    if (!items.length) return;
    if (b.kind === 'approve') send(b.who + ' finished ' + listWords(items) + '. Needs your OK.');
    else send(b.who + ' cashed in ' + listWords(items) + '.');
  }

  // Collects bursts (a kid ticking three chores) into a single text. check() says if it still matters at send time.
  function notify(kind, who, text, check) {
    const bk = kind + '|' + who;
    let b = buckets.get(bk);
    if (!b) {
      b = { kind, who, items: [] };
      buckets.set(bk, b);
      const timer = setTimeout(() => flush(bk), kind === 'approve' ? approveDelayMs : batchMs);
      if (timer.unref) timer.unref();
    }
    if (!b.items.some((i) => i.text === text)) b.items.push({ text, check });
  }

  return { send, notify, flush: () => { for (const k of [...buckets.keys()]) flush(k); } };
}

module.exports = { create, ledgerEvents, choresLeft, localDay, listWords };

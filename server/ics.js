'use strict';
/**
 * Minimal iCalendar reader for the Kitchen Board. Zero dependencies.
 *
 * build(text, opts) turns a calendar feed (Google "secret address in iCal format", ParentSquare
 * subscribe link, any .ics) into board event documents
 * ({title, allDay, sd, ed, st, et, loc, who, src, cal, source}) for a window of days
 * around now. Recurring events are expanded into one document per day they occur. Times are
 * shown in the board time zone. Supports DAILY, WEEKLY, MONTHLY and YEARLY rules with INTERVAL,
 * COUNT, UNTIL, BYDAY (with 1MO or -1FR style numbers), BYMONTHDAY and BYMONTH, plus EXDATE,
 * moved or cancelled single occurrences (RECURRENCE-ID) and STATUS:CANCELLED.
 */
const crypto = require('crypto');

const DAY = 864e5;
const pad = (n) => (n < 10 ? '0' : '') + n;
const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / DAY);
const ymd = (n) => { const t = new Date(n * DAY); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const key = (n) => { const o = ymd(n); return o.y + '-' + pad(o.m) + '-' + pad(o.d); };
const dow = (n) => (((n + 4) % 7) + 7) % 7; // 0 = Sunday
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/* ---------- time zones ---------- */
const fmts = new Map();
function dtf(tz) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    fmts.set(tz, f);
  }
  return f;
}
const validTz = (tz) => { try { dtf(tz); return true; } catch (e) { return false; } };
function wallOf(ms, tz) {
  const o = {};
  for (const p of dtf(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}
function toInstant(w, tz) {
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  if (tz === 'UTC') return guess;
  const off = (ms) => { const x = wallOf(ms, tz); return Date.UTC(x.y, x.m - 1, x.d, x.h, x.mi, x.s) - Math.floor(ms / 1000) * 1000; };
  let t = guess - off(guess);
  const o2 = off(t);
  if (guess - o2 !== t) t = guess - o2;
  return t;
}

/* ---------- parsing ---------- */
function unescapeText(s) { return s.replace(/\\([nN,;\\])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c)); }

function splitLine(line) {
  let q = false, i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ':' && !q) break;
  }
  if (i >= line.length) return null;
  const bits = line.slice(0, i).split(';');
  const params = {};
  for (const b of bits.slice(1)) {
    const k = b.indexOf('=');
    if (k > 0) params[b.slice(0, k).toUpperCase()] = b.slice(k + 1).replace(/^"|"$/g, '');
  }
  return { name: bits[0].toUpperCase(), params, value: line.slice(i + 1) };
}

function parseDate(value, params, defTz) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  if (m[4] === undefined || (params && params.VALUE === 'DATE')) return { allDay: true, y: +m[1], m: +m[2], d: +m[3] };
  const tz = m[7] ? 'UTC' : (params && params.TZID && validTz(params.TZID) ? params.TZID : defTz);
  return { allDay: false, y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0), tz };
}

function parseDuration(v) {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return 0;
  return ((+m[1] || 0) * 7 + (+m[2] || 0)) * DAY + (+m[3] || 0) * 36e5 + (+m[4] || 0) * 6e4 + (+m[5] || 0) * 1e3;
}

function parseRule(value, defTz) {
  const r = {};
  for (const part of value.split(';')) {
    const k = part.indexOf('=');
    if (k > 0) r[part.slice(0, k).toUpperCase()] = part.slice(k + 1);
  }
  const ints = (s) => s.split(',').map((x) => parseInt(x, 10)).filter((x) => !isNaN(x));
  const rule = {
    freq: (r.FREQ || '').toUpperCase(),
    interval: Math.max(1, parseInt(r.INTERVAL || '1', 10) || 1),
    count: r.COUNT ? parseInt(r.COUNT, 10) : 0,
    until: r.UNTIL ? parseDate(r.UNTIL, {}, defTz) : null,
    wkst: r.WKST && WD[r.WKST.toUpperCase()] !== undefined ? WD[r.WKST.toUpperCase()] : 1
  };
  if (r.BYDAY) {
    rule.byday = r.BYDAY.split(',').map((t) => {
      const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(t.trim());
      return m ? { n: m[1] ? parseInt(m[1], 10) : 0, wd: WD[m[2].toUpperCase()] } : null;
    }).filter(Boolean);
  }
  if (r.BYMONTHDAY) rule.bymonthday = ints(r.BYMONTHDAY);
  if (r.BYMONTH) rule.bymonth = ints(r.BYMONTH);
  return rule;
}

function parseIcs(text, defTz) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const evs = [];
  let cur = null, alarm = false;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { ex: [] }; alarm = false; continue; }
    if (line === 'END:VEVENT') { if (cur) evs.push(cur); cur = null; continue; }
    if (!cur) continue;
    if (line === 'BEGIN:VALARM') { alarm = true; continue; }
    if (line === 'END:VALARM') { alarm = false; continue; }
    if (alarm) continue;
    const p = splitLine(line);
    if (!p) continue;
    switch (p.name) {
      case 'UID': cur.uid = p.value; break;
      case 'SUMMARY': cur.title = unescapeText(p.value); break;
      case 'LOCATION': cur.loc = unescapeText(p.value); break;
      case 'STATUS': cur.status = p.value.toUpperCase(); break;
      case 'DTSTART': cur.start = parseDate(p.value, p.params, defTz); break;
      case 'DTEND': cur.end = parseDate(p.value, p.params, defTz); break;
      case 'DURATION': cur.dur = parseDuration(p.value); break;
      case 'RRULE': cur.rrule = parseRule(p.value, defTz); break;
      case 'RECURRENCE-ID': cur.recId = parseDate(p.value, p.params, defTz); break;
      case 'EXDATE':
        for (const v of p.value.split(',')) { const d = parseDate(v, p.params, defTz); if (d) cur.ex.push(d); }
        break;
      default: break;
    }
  }
  return evs;
}

/* ---------- recurrence ---------- */
function nthMatch(b, day) {
  const { y, m, d } = ymd(day);
  if (dow(day) !== b.wd) return false;
  if (b.n === 0) return true;
  if (b.n > 0) return Math.ceil(d / 7) === b.n;
  return Math.ceil((daysIn(y, m) - d + 1) / 7) === -b.n;
}

function matchDay(rule, s, startDay, day) {
  const { y, m, d } = ymd(day);
  const w = dow(day);
  const domMatch = () => {
    if (rule.bymonthday) return rule.bymonthday.some((v) => (v > 0 ? v === d : d === daysIn(y, m) + 1 + v));
    if (rule.byday) return rule.byday.some((b) => nthMatch(b, day));
    return d === s.d;
  };
  if (rule.bymonth && rule.freq !== 'YEARLY' && !rule.bymonth.includes(m)) return false;
  switch (rule.freq) {
    case 'DAILY':
      if ((day - startDay) % rule.interval) return false;
      return !rule.byday || rule.byday.some((b) => b.wd === w);
    case 'WEEKLY': {
      const wk = (x) => Math.floor((x - ((dow(x) - rule.wkst + 7) % 7)) / 7);
      if ((wk(day) - wk(startDay)) % rule.interval) return false;
      const wds = rule.byday ? rule.byday.map((b) => b.wd) : [dow(startDay)];
      return wds.includes(w);
    }
    case 'MONTHLY':
      if (((y - s.y) * 12 + (m - s.m)) % rule.interval) return false;
      return domMatch();
    case 'YEARLY':
      if ((y - s.y) % rule.interval) return false;
      if (!(rule.bymonth || [s.m]).includes(m)) return false;
      return domMatch();
    default:
      return false;
  }
}

function recurDays(ev, endDay) {
  const rule = ev.rrule, s = ev.start;
  const startDay = dayNum(s.y, s.m, s.d);
  const out = [];
  const untilInst = rule.until && !rule.until.allDay && !s.allDay ? toInstant(rule.until, rule.until.tz) : null;
  const untilDay = rule.until ? dayNum(rule.until.y, rule.until.m, rule.until.d) : null;
  let count = 0;
  for (let day = startDay; day <= endDay && out.length < 800; day++) {
    if (!matchDay(rule, s, startDay, day)) continue;
    if (untilInst !== null) {
      const o = ymd(day);
      if (toInstant({ y: o.y, m: o.m, d: o.d, h: s.h, mi: s.mi, s: s.s }, s.tz) > untilInst) break;
    } else if (untilDay !== null && day > untilDay) break;
    count++;
    if (rule.count && count > rule.count) break;
    out.push(day);
  }
  return out;
}

/* ---------- build board documents ---------- */
function build(text, opts) {
  opts = opts || {};
  const wr = /^X-WR-TIMEZONE:(\S+)/m.exec(text);
  const boardTz = [opts.boardTz, wr && wr[1], 'UTC'].filter(Boolean).find(validTz);
  const today = Math.floor((opts.now === undefined ? Date.now() : opts.now) / DAY);
  const from = key(today - (opts.pastDays === undefined ? 45 : opts.pastDays));
  const to = key(today + (opts.futureDays === undefined ? 200 : opts.futureDays));
  const label = opts.label || 'Calendar';
  const evs = parseIcs(text, boardTz);

  const idOf = (ev, origKey) => 'gcal-' + crypto.createHash('sha1').update((ev.uid || ev.title || '') + '|' + origKey).digest('hex').slice(0, 16);

  function doc(ev, occDay) {
    const s = ev.start;
    const base = { title: (ev.title || '').trim() || '(No title)' };
    let sd, ed, st = '', et = '';
    if (s.allDay) {
      const endDay = ev.end && ev.end.allDay ? dayNum(ev.end.y, ev.end.m, ev.end.d) : dayNum(s.y, s.m, s.d) + 1;
      const span = Math.max(1, endDay - dayNum(s.y, s.m, s.d));
      sd = key(occDay); ed = key(occDay + span - 1);
    } else {
      let dur = 0;
      if (ev.end && !ev.end.allDay) dur = toInstant(ev.end, ev.end.tz) - toInstant(s, s.tz);
      else if (ev.dur) dur = ev.dur;
      if (dur < 0) dur = 0;
      const o = ymd(occDay);
      const t0 = toInstant({ y: o.y, m: o.m, d: o.d, h: s.h, mi: s.mi, s: s.s }, s.tz);
      const a = wallOf(t0, boardTz), b = wallOf(t0 + dur, boardTz);
      sd = a.y + '-' + pad(a.m) + '-' + pad(a.d); ed = b.y + '-' + pad(b.m) + '-' + pad(b.d);
      st = pad(a.h) + ':' + pad(a.mi); et = pad(b.h) + ':' + pad(b.mi);
    }
    return { sd, ed, d: Object.assign(base, { allDay: !!s.allDay, sd, ed, st, et, loc: (ev.loc || '').trim(), who: opts.who || '', src: 'gcal', cal: label, source: opts.source || 'calendar' }) };
  }

  const dayOf = (v, tz) => {
    if (v.allDay) return dayNum(v.y, v.m, v.d);
    const w = wallOf(toInstant(v, v.tz), tz);
    return dayNum(w.y, w.m, w.d);
  };

  const out = new Map();
  const masters = evs.filter((e) => e.start && !e.recId && e.status !== 'CANCELLED');
  const overrides = evs.filter((e) => e.start && e.recId);
  const endDay = today + (opts.futureDays === undefined ? 200 : opts.futureDays) + 2;

  for (const ev of masters) {
    const s = ev.start;
    const tz = s.allDay ? boardTz : s.tz;
    const startDay = dayNum(s.y, s.m, s.d);
    let days;
    if (ev.rrule && ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(ev.rrule.freq)) {
      const skip = new Set(ev.ex.map((x) => dayOf(x, tz)));
      days = recurDays(ev, endDay).filter((d) => !skip.has(d));
    } else {
      days = [startDay];
    }
    for (const day of days) {
      const x = doc(ev, day);
      if (x.ed >= from && x.sd <= to) out.set(idOf(ev, key(day)), x.d);
    }
  }
  for (const ev of overrides) {
    const master = evs.find((e) => e.uid === ev.uid && !e.recId && e.start);
    const tz = master ? (master.start.allDay ? boardTz : master.start.tz) : boardTz;
    const id = idOf(ev, key(dayOf(ev.recId, tz)));
    if (ev.status === 'CANCELLED') { out.delete(id); continue; }
    const x = doc(ev, dayNum(ev.start.y, ev.start.m, ev.start.d));
    if (x.ed >= from && x.sd <= to) out.set(id, x.d); else out.delete(id);
  }
  return out;
}

module.exports = { build, parseIcs };

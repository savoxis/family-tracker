'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { build } = require('./ics');

const NOW = Date.UTC(2026, 9, 22, 19, 0, 0); // 2026-10-22, window is 2026-09-07 to 2027-05-10
const wrap = (events, extra) => 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-TIMEZONE:America/Los_Angeles\r\n' + (extra || '')
  + events.map((e) => 'BEGIN:VEVENT\r\n' + e.join('\r\n') + '\r\nEND:VEVENT').join('\r\n') + '\r\nEND:VCALENDAR\r\n';
const run = (events, extra) => build(wrap(events, extra), { now: NOW, label: 'T' });
const all = (m) => Array.from(m.values());
const byTitle = (m, t) => all(m).filter((d) => d.title === t);

test('all-day events: end date is inclusive on the board', () => {
  const m = run([
    ['UID:a', 'SUMMARY:One day', 'DTSTART;VALUE=DATE:20261024', 'DTEND;VALUE=DATE:20261025'],
    ['UID:b', 'SUMMARY:Three days', 'DTSTART;VALUE=DATE:20261024', 'DTEND;VALUE=DATE:20261027']
  ]);
  const one = byTitle(m, 'One day')[0], three = byTitle(m, 'Three days')[0];
  assert.deepStrictEqual([one.allDay, one.sd, one.ed, one.st, one.et], [true, '2026-10-24', '2026-10-24', '', '']);
  assert.deepStrictEqual([three.sd, three.ed], ['2026-10-24', '2026-10-26']);
  assert.strictEqual(one.src, 'gcal');
  assert.strictEqual(one.cal, 'T');
});

test('UTC times are shown in the calendar zone, text is unescaped, folded lines join', () => {
  const m = run([['UID:c', 'SUMMARY:Dentist\\, Dr. Lee', 'LOCATION:Main St\\; Suite 2', 'DTSTART:20261026T160000Z', 'DTEND:20261026T173000Z',
    'DESCRIPTION:long', ' folded', 'BEGIN:VALARM', 'SUMMARY:should be ignored', 'END:VALARM']]);
  const d = all(m)[0];
  assert.strictEqual(d.title, 'Dentist, Dr. Lee');
  assert.strictEqual(d.loc, 'Main St; Suite 2');
  assert.deepStrictEqual([d.allDay, d.sd, d.st, d.ed, d.et], [false, '2026-10-26', '09:00', '2026-10-26', '10:30']);
});

test('weekly rule with BYDAY, COUNT and EXDATE keeps the wall-clock time across daylight saving', () => {
  const m = run([['UID:w', 'SUMMARY:Practice', 'DTSTART;TZID=America/Los_Angeles:20261019T180000', 'DTEND;TZID=America/Los_Angeles:20261019T190000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5', 'EXDATE;TZID=America/Los_Angeles:20261021T180000']]);
  const got = byTitle(m, 'Practice').map((d) => d.sd).sort();
  assert.deepStrictEqual(got, ['2026-10-19', '2026-10-26', '2026-10-28', '2026-11-02']);
  assert.ok(byTitle(m, 'Practice').every((d) => d.st === '18:00' && d.et === '19:00'));
});

test('interval, until, monthly last Friday, yearly', () => {
  const m = run([
    ['UID:i', 'SUMMARY:Biweekly', 'DTSTART;VALUE=DATE:20261001', 'DTEND;VALUE=DATE:20261002', 'RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261031'],
    ['UID:m', 'SUMMARY:Last Friday', 'DTSTART;VALUE=DATE:20260101', 'DTEND;VALUE=DATE:20260102', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR'],
    ['UID:y', 'SUMMARY:Birthday', 'DTSTART;VALUE=DATE:20150315', 'DTEND;VALUE=DATE:20150316', 'RRULE:FREQ=YEARLY'],
    ['UID:d', 'SUMMARY:Daily', 'DTSTART;VALUE=DATE:20261020', 'DTEND;VALUE=DATE:20261021', 'RRULE:FREQ=DAILY;COUNT=3']
  ]);
  assert.deepStrictEqual(byTitle(m, 'Biweekly').map((d) => d.sd).sort(), ['2026-10-01', '2026-10-15', '2026-10-29']);
  const lf = byTitle(m, 'Last Friday').map((d) => d.sd);
  for (const x of ['2026-10-30', '2026-11-27', '2026-12-25', '2027-01-29']) assert.ok(lf.includes(x), x);
  assert.ok(!lf.includes('2026-10-23'));
  assert.deepStrictEqual(byTitle(m, 'Birthday').map((d) => d.sd), ['2027-03-15']);
  assert.deepStrictEqual(byTitle(m, 'Daily').map((d) => d.sd).sort(), ['2026-10-20', '2026-10-21', '2026-10-22']);
});

test('moved and cancelled occurrences, cancelled events, and ids stay stable', () => {
  const events = [
    ['UID:r', 'SUMMARY:Class', 'DTSTART;TZID=America/Los_Angeles:20261005T150000', 'DTEND;TZID=America/Los_Angeles:20261005T160000', 'RRULE:FREQ=WEEKLY;COUNT=4'],
    ['UID:r', 'SUMMARY:Class (moved)', 'RECURRENCE-ID;TZID=America/Los_Angeles:20261012T150000', 'DTSTART;TZID=America/Los_Angeles:20261013T170000', 'DTEND;TZID=America/Los_Angeles:20261013T180000'],
    ['UID:r', 'SUMMARY:Class', 'RECURRENCE-ID;TZID=America/Los_Angeles:20261019T150000', 'DTSTART;TZID=America/Los_Angeles:20261019T150000', 'STATUS:CANCELLED'],
    ['UID:x', 'SUMMARY:Cancelled whole', 'DTSTART;VALUE=DATE:20261030', 'STATUS:CANCELLED']
  ];
  const m = run(events);
  const cls = all(m).filter((d) => d.title.startsWith('Class')).map((d) => d.sd + ' ' + d.st + ' ' + d.title).sort();
  assert.deepStrictEqual(cls, ['2026-10-05 15:00 Class', '2026-10-13 17:00 Class (moved)', '2026-10-26 15:00 Class']);
  assert.strictEqual(byTitle(m, 'Cancelled whole').length, 0);
  assert.deepStrictEqual(Array.from(run(events).keys()).sort(), Array.from(m.keys()).sort());
  assert.ok(Array.from(m.keys()).every((k) => /^gcal-[0-9a-f]{16}$/.test(k)));
});

test('events outside the window are left out, and junk does not throw', () => {
  const m = run([
    ['UID:o', 'SUMMARY:Ancient', 'DTSTART;VALUE=DATE:20200101', 'DTEND;VALUE=DATE:20200102'],
    ['UID:f', 'SUMMARY:Far future', 'DTSTART;VALUE=DATE:20300101', 'DTEND;VALUE=DATE:20300102'],
    ['UID:j', 'SUMMARY:No start'],
    ['UID:k', 'SUMMARY:Bad rule', 'DTSTART;VALUE=DATE:20261101', 'RRULE:FREQ=SECONDLY']
  ]);
  assert.deepStrictEqual(all(m).map((d) => d.title), ['Bad rule']);
  assert.strictEqual(build('BEGIN:VCALENDAR\r\nEND:VCALENDAR', { now: NOW }).size, 0);
});

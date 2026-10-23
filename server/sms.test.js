'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const sms = require('./sms');

function fakeTextbelt(quota) {
  const got = [];
  const srv = http.createServer((req, res) => {
    const b = [];
    req.on('data', (c) => b.push(c));
    req.on('end', () => {
      const f = Object.fromEntries(new URLSearchParams(Buffer.concat(b).toString()));
      got.push(f);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(f.key === 'good-key' ? { success: true, quotaRemaining: quota === undefined ? 100 : quota, textId: '1' } : { success: false, error: 'Invalid key' }));
    });
  });
  return { srv, got, listen: () => new Promise((r) => srv.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + srv.address().port + '/text'))) };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('ledger changes become approval and cash-in events, and only new ones', () => {
  const doc = (o) => Object.assign({ memberId: 'm1', done: {}, spent: {}, pend: {} }, o);
  assert.deepStrictEqual(sms.ledgerEvents(doc(), doc({ pend: { '2026-10-22_c1': 1 } })), [{ kind: 'approve', mid: 'm1', key: '2026-10-22_c1' }]);
  assert.deepStrictEqual(sms.ledgerEvents(doc({ pend: { a_c1: 1 } }), doc({ pend: { a_c1: 1 } })), []); // already asked
  assert.deepStrictEqual(sms.ledgerEvents(doc(), doc({ pend: { a_c1: 1 }, done: { a_c1: 1 } })), []); // already approved
  assert.deepStrictEqual(sms.ledgerEvents(doc({ pend: { a_c1: 1 } }), doc({ pend: { a_c1: 0 } })), []); // taken back
  const cash = sms.ledgerEvents(doc(), doc({ spent: { s1: { cost: 3, title: 'Ice cream', at: 1 }, s2: { cost: -1, title: 'Bonus', at: 1 }, s3: { cost: 1, title: 'Adjustment', at: 1 }, s4: { cost: 9, title: 'Allowance paid $2.25', at: 1 } } }));
  assert.deepStrictEqual(cash, [{ kind: 'cash', mid: 'm1', title: 'Ice cream', cost: 3 }]);
  assert.deepStrictEqual(sms.ledgerEvents(null, null), []);
});

test('word lists read naturally and stay short', () => {
  assert.strictEqual(sms.listWords(['A']), 'A');
  assert.strictEqual(sms.listWords(['A', 'B']), 'A and B');
  assert.strictEqual(sms.listWords(['A', 'B', 'C']), 'A, B and C');
  assert.strictEqual(sms.listWords(['A', 'B', 'C', 'D', 'E', 'F']), 'A, B, C, D and 2 more');
});

test('chores left follows the page rules: daily only, weekday, rotation, done today', () => {
  const NOW = Date.UTC(2026, 9, 22, 12, 0, 0); // Thursday 2026-10-22
  const data = {
    members: { m1: { name: 'Ava' }, m2: { name: 'Ben' }, m3: { name: 'Dad' } },
    chores: {
      c1: { title: 'Make bed', memberIds: ['m1', 'm2'], days: [] },
      c2: { title: 'Homework', memberIds: ['m1'], days: [4] }, // Thursday
      c3: { title: 'Mow lawn', memberIds: ['m1'], days: [6] }, // Saturday, not today
      c4: { title: 'Laundry', memberIds: ['m1'], weekly: true },
      c5: { title: 'Brush teeth', memberIds: ['m1'], routine: true },
      c6: { title: 'Trash', memberIds: ['m1', 'm2'], rot: 'day' }
    },
    ledger: { m1_2026_10: { memberId: 'm1', done: { '2026-10-22_c1': 1 } } }
  };
  const rows = sms.choresLeft(data, NOW, 'UTC');
  const by = Object.fromEntries(rows.map((r) => [r.name, r.left.slice().sort()]));
  assert.ok(!by.Dad, 'someone with no chores is skipped');
  assert.deepStrictEqual(by.Ava.filter((t) => t !== 'Trash'), ['Homework']); // bed done, lawn is Saturday, laundry weekly, teeth is a routine
  assert.ok(by.Ben.includes('Make bed'));
  // rotation hands Trash to exactly one of them today
  assert.strictEqual([by.Ava, by.Ben].filter((l) => l.includes('Trash')).length, 1);
});

test('a burst becomes one text, repeats and the daily cap are respected, the key stays out of logs', async () => {
  const fk = fakeTextbelt();
  const url = await fk.listen();
  const logs = [];
  let t = Date.UTC(2026, 9, 22, 12, 0, 0);
  const s = sms.create({ key: 'good-key', to: ['5555550101', '5555550102'], url, batchMs: 30, dailyMax: 3, now: () => t, log: (m) => logs.push(m) });
  try {
    s.notify('approve', 'Ava', 'Homework'); s.notify('approve', 'Ava', 'Make bed'); s.notify('approve', 'Ava', 'Homework');
    await wait(250);
    assert.strictEqual(fk.got.length, 2); // one message, two parents
    assert.strictEqual(fk.got[0].message, 'Kitchen Board: Ava finished Homework and Make bed. Needs your OK.');
    assert.deepStrictEqual(fk.got.map((g) => g.phone).sort(), ['5555550101', '5555550102']);
    assert.ok(fk.got.every((g) => g.key === 'good-key'));
    await s.send('Ava finished Homework and Make bed. Needs your OK.'); // identical within 10 minutes
    assert.strictEqual(fk.got.length, 2);
    await s.send('one'); await s.send('two'); // third message of the day
    assert.strictEqual(fk.got.length, 6);
    const over = await s.send('three');
    assert.deepStrictEqual(over, { skipped: 'cap' });
    assert.strictEqual(fk.got.length, 6);
    t += 864e5; // next day the cap resets
    await s.send('three');
    assert.strictEqual(fk.got.length, 8);
    const all = logs.join('\n');
    assert.ok(!all.includes('good-key') && !all.includes('5555550101') && all.includes('***0101'), all);
  } finally { fk.srv.close(); }
});

test('failures are logged without crashing, and low credits warn once a day', async () => {
  const bad = fakeTextbelt();
  const burl = await bad.listen();
  const logs = [];
  const s1 = sms.create({ key: 'wrong', to: ['5555550101'], url: burl, log: (m) => logs.push(m) });
  await s1.send('hello');
  assert.ok(logs.some((l) => /failed: Invalid key/.test(l)));
  bad.srv.close();
  const low = fakeTextbelt(5);
  const lurl = await low.listen();
  const s2 = sms.create({ key: 'good-key', to: ['5555550101'], url: lurl, lowAt: 20, log: () => {} });
  await s2.send('one'); await s2.send('two');
  const warns = low.got.filter((g) => /running low/.test(g.message));
  assert.strictEqual(warns.length, 1);
  low.srv.close();
  const dead = sms.create({ key: 'k', to: ['5555550101'], url: 'http://127.0.0.1:1/', log: (m) => logs.push(m) });
  await dead.send('hello');
  assert.ok(logs.some((l) => /failed: network/.test(l)));
  const dry = sms.create({ key: 'k', to: ['5555550101'], dryRun: true, url: 'http://127.0.0.1:1/', log: (m) => logs.push(m) });
  assert.deepStrictEqual(await dry.send('dry'), { dryRun: true });
});

test('server texts the parents for approvals, cash-ins and the evening nudge', async () => {
  const fk = fakeTextbelt();
  const url = await fk.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-sms-'));
  const port = 22000 + Math.floor(Math.random() * 1000);
  const n = new Date();
  const hhmm = String(n.getUTCHours()).padStart(2, '0') + ':' + String(n.getUTCMinutes()).padStart(2, '0');
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ rev: 1, data: {
    members: { m1: { name: 'Ava' } }, chores: { c1: { title: 'Make bed', memberIds: ['m1'], days: [] }, c2: { title: 'Homework', memberIds: ['m1'], days: [] } },
    rewards: {}, events: {}, ledger: {}, meals: {}, groceries: {}, notes: {}, config: {}
  } }));
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dir, PUBLIC_DIR: path.join(__dirname, '..', 'web'), BACKUP_HOURS: '0',
      TEXTBELT_KEY: 'good-key', SMS_TO: '(555) 555-0101, 555-555-0102', SMS_URL: url, SMS_BATCH_MS: '150', BOARD_TZ: 'UTC', SMS_REMIND_AT: hhmm })
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const put = (p, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'PUT', path: p, headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', resolve); });
    r.on('error', reject); r.end(JSON.stringify(body));
  });
  const until = async (fn) => { for (let i = 0; i < 100; i++) { const v = fn(); if (v) return v; await wait(100); } return null; };
  try {
    // the nudge fires at start: Ava has two chores left
    assert.ok(await until(() => fk.got.find((g) => /still has 2 chores left today \(Make bed and Homework\)|still has 2 chores left today \(Homework and Make bed\)/.test(g.message))), 'no evening nudge: ' + JSON.stringify(fk.got));
    assert.deepStrictEqual([...new Set(fk.got.map((g) => g.phone))].sort(), ['5555550101', '5555550102']); // numbers cleaned up
    const before = fk.got.length;
    // a kid sends two chores for approval, they arrive as one text
    await put('/api/ledger/m1_2026-10', { memberId: 'm1', month: '2026-10', done: {}, spent: {}, rt: {}, pend: { '2026-10-22_c1': 1 } });
    await put('/api/ledger/m1_2026-10', { memberId: 'm1', month: '2026-10', done: {}, spent: {}, rt: {}, pend: { '2026-10-22_c1': 1, '2026-10-22_c2': 2 } });
    assert.ok(await until(() => fk.got.slice(before).find((g) => /Ava finished Make bed and Homework\. Needs your OK\./.test(g.message))), 'no approval text: ' + JSON.stringify(fk.got.slice(before)));
    assert.strictEqual(fk.got.slice(before).length, 2);
    const mid = fk.got.length;
    // a reward is cashed in
    await put('/api/ledger/m1_2026-10', { memberId: 'm1', month: '2026-10', done: {}, rt: {}, pend: { '2026-10-22_c1': 1, '2026-10-22_c2': 2 }, spent: { s1: { cost: 3, title: 'Ice cream', at: Date.now() } } });
    assert.ok(await until(() => fk.got.slice(mid).find((g) => /Ava cashed in Ice cream \(3 stars\)\./.test(g.message))), 'no cash-in text');
    assert.ok(!log.includes('good-key') && !log.includes('5555550101') && !log.includes('555-0101'), 'secret leaked into the log');
  } finally {
    await new Promise((r) => { proc.on('exit', r); proc.kill('SIGTERM'); });
    fk.srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

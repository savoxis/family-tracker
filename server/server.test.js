'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
let proc;

function startServer() {
  return new Promise((resolve, reject) => {
    proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: DATA, PUBLIC_DIR: path.join(__dirname, '..', 'web') })
    });
    proc.stdout.on('data', (d) => { if (String(d).includes('Kitchen Board on port')) resolve(); });
    proc.on('error', reject);
    setTimeout(() => reject(new Error('server did not start')), 5000).unref();
  });
}
function stopServer() {
  return new Promise((resolve) => { proc.on('exit', resolve); proc.kill('SIGTERM'); });
}
function req(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const json = (r) => JSON.parse(r.text);
const JSON_H = { 'Content-Type': 'application/json' };

before(startServer);
after(async () => { await stopServer(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('health and empty state', async () => {
  assert.strictEqual(json(await req('GET', '/api/health')).ok, true);
  const s = json(await req('GET', '/api/state'));
  assert.strictEqual(typeof s.rev, 'number');
  assert.deepStrictEqual(Object.keys(s.data.members), []);
});

test('put, read back, bump rev, delete', async () => {
  const r0 = json(await req('GET', '/api/state')).rev;
  const put = await req('PUT', '/api/chores/c1', JSON.stringify({ title: 'Make bed', stars: 1 }), JSON_H);
  assert.strictEqual(put.status, 200);
  const s = json(await req('GET', '/api/state'));
  assert.strictEqual(s.data.chores.c1.title, 'Make bed');
  assert.ok(s.rev > r0);
  assert.strictEqual((await req('DELETE', '/api/chores/c1')).status, 200);
  assert.strictEqual(json(await req('GET', '/api/state')).data.chores.c1, undefined);
});

test('ids the page really uses are accepted', async () => {
  for (const [c, id] of [['ledger', 'abc123_2026-10'], ['meals', '2026-10-22'], ['config', 'display']]) {
    assert.strictEqual((await req('PUT', '/api/' + c + '/' + id, '{"a":1}', JSON_H)).status, 200, c + '/' + id);
  }
});

test('rejects bad input', async () => {
  assert.strictEqual((await req('PUT', '/api/nope/x', '{}', JSON_H)).status, 404);
  assert.strictEqual((await req('PUT', '/api/chores/' + encodeURIComponent('../x'), '{}', JSON_H)).status, 400);
  assert.strictEqual((await req('PUT', '/api/chores/__proto__', '{}', JSON_H)).status, 400);
  assert.strictEqual((await req('PUT', '/api/chores/x', '[1]', JSON_H)).status, 400);
  assert.strictEqual((await req('PUT', '/api/chores/x', 'not json', JSON_H)).status, 400);
  assert.strictEqual((await req('POST', '/api/state', '{}', JSON_H)).status, 405);
  const big = JSON.stringify({ pad: 'x'.repeat(300 * 1024) });
  let status;
  try { status = (await req('PUT', '/api/notes/big', big, JSON_H)).status; } catch (e) { status = 'reset'; }
  assert.ok(status === 413 || status === 'reset', 'oversize body got ' + status);
  assert.strictEqual(json(await req('GET', '/api/health')).ok, true);
});

test('serves the page and blocks path tricks', async () => {
  const home = await req('GET', '/');
  assert.strictEqual(home.status, 200);
  assert.match(home.text, /Kitchen Board/);
  assert.strictEqual((await req('GET', '/fonts/fonts.css')).status, 200);
  assert.strictEqual((await req('GET', '/..%2fserver%2fserver.js')).status, 404);
  assert.strictEqual((await req('GET', '/%2e%2e/server/server.js')).status, 404);
  assert.strictEqual((await req('GET', '/nope.html')).status, 404);
});

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}
const listBackups = (dir) => {
  try { return fs.readdirSync(path.join(dir, 'backups')).filter((n) => /^board-\d{8}-\d{6}\.json$/.test(n)).sort(); } catch (e) { return []; }
};

test('writes a backup at start that holds the board', async () => {
  const names = await waitFor(() => { const n = listBackups(DATA); return n.length ? n : null; }, 3000);
  assert.ok(names, 'no backup appeared');
  const b = JSON.parse(fs.readFileSync(path.join(DATA, 'backups', names[0]), 'utf8'));
  assert.strictEqual(typeof b.rev, 'number');
  assert.ok(b.data && b.data.members);
});

test('keeps only the newest BACKUP_KEEP backups and skips unchanged ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bk-'));
  const bdir = path.join(dir, 'backups');
  fs.mkdirSync(bdir);
  const old = ['20200101-000000', '20200102-000000', '20200103-000000', '20200104-000000', '20200105-000000'];
  old.forEach((s) => fs.writeFileSync(path.join(bdir, 'board-' + s + '.json'), '{}'));
  const p = 19000 + Math.floor(Math.random() * 1000);
  const run = () => spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(p), DATA_DIR: dir, PUBLIC_DIR: path.join(__dirname, '..', 'web'), BACKUP_KEEP: '3' })
  });
  const quit = (c) => new Promise((resolve) => { c.on('exit', resolve); c.kill('SIGTERM'); });
  let c = run();
  try {
    const names = await waitFor(() => { const n = listBackups(dir); return n.length === 3 && !n.includes('board-20200101-000000.json') ? n : null; }, 4000);
    assert.ok(names, 'expected 3 backups, got ' + listBackups(dir).join(','));
    assert.ok(names[2] > 'board-20200105-000000.json', 'newest backup should be the new one');
    await quit(c);
    c = run();
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepStrictEqual(listBackups(dir), names, 'restart with no change must not add a backup');
  } finally {
    await quit(c);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('syncs a calendar feed into events, follows changes, and never logs the link', async () => {
  const soon = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  const cal = (titles) => 'BEGIN:VCALENDAR\r\nX-WR-TIMEZONE:America/Los_Angeles\r\n' + titles.map((t, i) =>
    'BEGIN:VEVENT\r\nUID:t' + i + '\r\nSUMMARY:' + t + '\r\nDTSTART;VALUE=DATE:' + soon + '\r\nEND:VEVENT\r\n').join('') + 'END:VCALENDAR\r\n';
  let feed = cal(['Feed one', 'Feed two']);
  const feedSrv = http.createServer((q, r) => { r.end(q.url.includes('secret-token') ? feed : 'nope'); });
  await new Promise((r) => feedSrv.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cal-'));
  const p = 20000 + Math.floor(Math.random() * 1000);
  const url = 'http://127.0.0.1:' + feedSrv.address().port + '/cal/secret-token/basic.ics';
  const c = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(p), DATA_DIR: dir, PUBLIC_DIR: path.join(__dirname, '..', 'web'), ICS_URLS: 'Test@Kid|' + url, ICS_MINUTES: '0.02', BACKUP_HOURS: '0' })
  });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { out += d; });
  const state = () => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: p, path: '/api/state' }, (res) => {
      const b = []; res.on('data', (x) => b.push(x)); res.on('end', () => resolve(JSON.parse(Buffer.concat(b).toString())));
    }).on('error', () => resolve(null));
  });
  const titles = async () => { const s = await state(); return s ? Object.values(s.data.events).map((e) => e.title).sort() : []; };
  const until = async (want) => { for (let i = 0; i < 100; i++) { const t = await titles(); if (JSON.stringify(t) === JSON.stringify(want)) return t; await new Promise((r) => setTimeout(r, 100)); } return titles(); };
  try {
    assert.deepStrictEqual(await until(['Feed one', 'Feed two']), ['Feed one', 'Feed two']);
    const s = await state();
    const e = Object.values(s.data.events)[0];
    assert.strictEqual(e.src, 'gcal');
    assert.strictEqual(e.cal, 'Test');
    assert.strictEqual(e.source, 'calendar'); // not Google or a school, so a plain calendar feed
    assert.strictEqual(e.who, ''); // Kid is not a family member yet
    await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: p, method: 'PUT', path: '/api/members/kid1', headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', resolve); });
      r.on('error', reject); r.end(JSON.stringify({ name: 'kid' }));
    });
    let bound = false;
    for (let i = 0; i < 80 && !bound; i++) { bound = Object.values((await state()).data.events).every((x) => x.who === 'kid1'); if (!bound) await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(bound, 'events were not tied to the family member named in Label@Member');
    feed = cal(['Feed two']);
    assert.deepStrictEqual(await until(['Feed two']), ['Feed two']);
    assert.ok(!out.includes('secret-token'), 'the feed link leaked into the log');
  } finally {
    await new Promise((r) => { c.on('exit', r); c.kill('SIGTERM'); });
    feedSrv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('data survives a restart', async () => {
  await req('PUT', '/api/members/m1', JSON.stringify({ name: 'Test Kid' }), JSON_H);
  await stopServer();
  await startServer();
  assert.strictEqual(json(await req('GET', '/api/state')).data.members.m1.name, 'Test Kid');
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { plan, norm } = require('./keepsync');

const item = (id, text, o) => Object.assign({ id, text, checked: false, type: 'LIST_ITEM', sortValue: '100' }, o || {});
const hdr = (id, text, o) => item(id, text, o);
const base = () => [
  hdr('H1', 'Produce'), hdr('H2', 'Dairy'), hdr('H3', 'Other '), hdr('H4', 'Dry'), hdr('H5', 'Bakery', { checked: true }),
  item('a1', 'Apples \u{1F34E} ', { checked: true, superListItemId: 'H1', sortValue: '300' }),
  item('m1', 'Milk', { checked: true, superListItemId: 'H2', sortValue: '100' }),
  item('m2', 'Milk \u{1F95B}', { checked: true, superListItemId: 'H2', sortValue: '200' }),
  item('m3', 'milk', { checked: true, sortValue: '900' }),
  item('f1', 'Flour', { checked: true, superListItemId: 'H4' }),
  item('f2', 'Bread', { checked: true, superListItemId: 'H5' }),
  item('t1', 'Tape', { checked: true, superListItemId: 'H3' }),
  item('c1', 'Cereal', { superListItemId: 'H4' })
];
const run = (board, items, pairs, extra) => plan(Object.assign({
  board: new Map(Object.entries(board)), items: items || base(), pairs: pairs || {}, headerNames: [], newBoardId: (k) => 'keep-' + k
}, extra || {}));

test('names match ignoring emoji, case and spacing', () => {
  assert.strictEqual(norm('  Apples \u{1F34E}️  '), 'apples');
  assert.strictEqual(norm('Bell pepper \u{1F96B} \u{1F336}️ '), 'bell pepper');
});

test('adding on the board unchecks an existing item first, preferring one under a category', () => {
  const p = run({ g1: { title: 'milk', done: false } });
  assert.deepStrictEqual(p.keepAdd, []);
  assert.strictEqual(p.keepEdit.length, 1);
  assert.strictEqual(p.keepEdit[0].k, 'm2'); // under Dairy, highest sort among indented
  assert.strictEqual(p.keepEdit[0].checked, false);
  assert.deepStrictEqual(p.boardSet, [{ id: 'g1', title: 'Milk \u{1F95B}', done: false }]); // board takes Keep's wording
  assert.strictEqual(p.pairs.g1.k, 'm2');
});

test('headers are never treated as items, even with no children yet', () => {
  const p = run({}, base().concat([hdr('H9', 'Freezer')]), {}, { headerNames: ['Freezer'] });
  assert.deepStrictEqual(p.boardAdd.map((b) => b.title), ['Cereal']); // only the active real item
  const q = run({ g: { title: 'Freezer', done: false } }, base().concat([hdr('H9', 'Freezer')]), {}, { headerNames: ['Freezer'] });
  assert.strictEqual(q.keepAdd.length, 1); // a board item called Freezer does not grab the header
});

test('a brand new item is filed under the category its words belong to, else Other', () => {
  const p = run({ g1: { title: 'Bread flour', done: false }, g2: { title: 'Cheesecake', done: false } });
  const by = Object.fromEntries(p.keepAdd.map((a) => [a.text, a.parent]));
  assert.strictEqual(by['Bread flour'], 'H4'); // flour lives under Dry; Bakery is a checked header so it is skipped
  assert.strictEqual(by['Cheesecake'], 'H3');
});

test('active Keep items come to the board once, checked history stays off it', () => {
  const p = run({});
  assert.deepStrictEqual(p.boardAdd, [{ id: 'keep-c1', title: 'Cereal', done: false }]);
  assert.strictEqual(Object.keys(p.pairs).length, 1);
});

test('checking and unchecking flows both ways, keep wins a tie, deletes follow Keep', () => {
  const items = base();
  const pairs = { g1: { k: 'c1', title: 'Cereal', done: false } };
  // board checks it -> Keep checked
  let p = run({ g1: { title: 'Cereal', done: true } }, items, pairs);
  assert.deepStrictEqual(p.keepEdit, [{ k: 'c1', checked: true }]);
  // Keep checks it -> board done
  items.find((n) => n.id === 'c1').checked = true;
  p = run({ g1: { title: 'Cereal', done: false } }, items, pairs);
  assert.deepStrictEqual(p.boardSet, [{ id: 'g1', title: 'Cereal', done: true }]);
  assert.deepStrictEqual(p.keepEdit, []);
  // both changed: Keep wins
  p = run({ g1: { title: 'Granola', done: true } }, items, { g1: { k: 'c1', title: 'Oats', done: false } });
  assert.deepStrictEqual(p.boardSet, [{ id: 'g1', title: 'Cereal', done: true }]);
  assert.deepStrictEqual(p.keepEdit, []);
  // Keep item gone -> board item removed
  p = run({ g1: { title: 'Cereal', done: false } }, items.filter((n) => n.id !== 'c1'), pairs);
  assert.deepStrictEqual(p.boardDel, ['g1']);
});

test('removing an item on the board checks it in Keep but never deletes history', () => {
  const p = run({}, base(), { g1: { k: 'c1', title: 'Cereal', done: false } });
  assert.deepStrictEqual(p.keepEdit, [{ k: 'c1', checked: true }]);
  assert.strictEqual(Object.keys(p.pairs).length, 0);
  const q = run({}, base().map((n) => (n.id === 'c1' ? Object.assign({}, n, { checked: true }) : n)), { g1: { k: 'c1', title: 'Cereal', done: true } });
  assert.deepStrictEqual(q.keepEdit, []);
});

/* ---------- end to end against a fake Keep ---------- */
function fakeKeep() {
  const nodes = new Map();
  let version = 0;
  const put = (n) => { version += 1; nodes.set(n.id, Object.assign({}, nodes.get(n.id) || {}, n, { kind: 'notes#node', baseVersion: String(version), _v: version, serverId: 'srv-' + n.id })); };
  const T = { kind: 'notes#timestamps', created: '2026-01-01T00:00:00.000000Z', updated: '2026-01-01T00:00:00.000000Z' };
  put({ id: 'L1', type: 'LIST', title: 'Shop', parentId: 'root', timestamps: T, nodeSettings: { newListItemPlacement: 'BOTTOM' } });
  for (const [id, text, checked, sup] of [['H1', 'Produce', false], ['H2', 'Dairy', false], ['H3', 'Other', false], ['a1', 'Apples \u{1F34E}', true, 'H1'], ['m1', 'Milk \u{1F95B}', true, 'H2'], ['t1', 'Tape', true, 'H3']]) {
    put({ id, type: 'LIST_ITEM', parentId: 'L1', parentServerId: 'srv-L1', text, checked, superListItemId: sup || null, sortValue: '1000', timestamps: T });
  }
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      if (req.url === '/auth') return res.end('Auth=fake-token\n');
      if (req.headers.authorization !== 'OAuth fake-token') { res.statusCode = 401; return res.end(JSON.stringify({ error: { code: 401 } })); }
      const j = JSON.parse(body);
      for (const n of j.nodes || []) put(n);
      const since = parseInt(j.targetVersion || '0', 10);
      const out = [...nodes.values()].filter((n) => n._v > since).map((n) => { const c = Object.assign({}, n); delete c._v; return c; });
      res.end(JSON.stringify({ nodes: out, toVersion: String(version), truncated: false }));
    });
  });
  return { srv, nodes, put, items: () => [...nodes.values()].filter((n) => n.type === 'LIST_ITEM') };
}

test('server keeps the grocery list in step with Keep, end to end', async () => {
  const fk = fakeKeep();
  await new Promise((r) => fk.srv.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-keep-'));
  const port = 21000 + Math.floor(Math.random() * 1000);
  const base_ = 'http://127.0.0.1:' + fk.srv.address().port + '/';
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(port), DATA_DIR: dir, PUBLIC_DIR: path.join(__dirname, '..', 'web'), BACKUP_HOURS: '0',
      KEEP_EMAIL: 'x@example.com', KEEP_MASTER_TOKEN: 'aas_et/secret-token-value', KEEP_LIST: 'Shop', KEEP_MINUTES: '0.02',
      KEEP_AUTH_URL: base_ + 'auth', KEEP_API_URL: base_
    })
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'Content-Type': 'application/json' } }, (res) => {
      const b = []; res.on('data', (x) => b.push(x)); res.on('end', () => resolve(Buffer.concat(b).toString()));
    });
    r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
  });
  const groceries = async () => { try { return JSON.parse(await call('GET', '/api/state')).data.groceries; } catch (e) { return {}; } };
  const until = async (fn) => { for (let i = 0; i < 120; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
  try {
    await until(async () => /Keep sync on/.test(log));
    // 1. add Milk on the board: the checked Milk in Keep is unchecked, nothing new is created
    const before = fk.items().length;
    await call('PUT', '/api/groceries/g1', { title: 'milk', done: false, at: 1 });
    assert.ok(await until(() => { const m = fk.nodes.get('m1'); return m && m.checked === false; }), 'Milk was not unchecked in Keep');
    assert.strictEqual(fk.items().length, before, 'a duplicate was created');
    assert.ok(await until(async () => (await groceries()).g1 && (await groceries()).g1.title === 'Milk \u{1F95B}'), 'board did not take Keep wording');
    // 2. an unknown item is created in Keep under Other
    await call('PUT', '/api/groceries/g2', { title: 'Bread flour', done: false, at: 2 });
    const made = await until(() => fk.items().find((n) => n.text === 'Bread flour'));
    assert.ok(made, 'new item not created');
    assert.strictEqual(made.superListItemId, 'H3');
    assert.strictEqual(made.parentId, 'L1');
    // 3. someone unchecks Apples in Keep: it appears on the board
    fk.put({ id: 'a1', checked: false });
    assert.ok(await until(async () => Object.values(await groceries()).some((g) => g.title === 'Apples \u{1F34E}' && !g.done)), 'Apples did not reach the board');
    // 4. checking Milk on the board checks it in Keep
    await call('PUT', '/api/groceries/g1', { title: 'Milk \u{1F95B}', done: true, at: 1 });
    assert.ok(await until(() => fk.nodes.get('m1').checked === true), 'Milk was not checked in Keep');
    assert.ok(!log.includes('secret-token-value'), 'the token leaked into the log');
  } finally {
    await new Promise((r) => { proc.on('exit', r); proc.kill('SIGTERM'); });
    fk.srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

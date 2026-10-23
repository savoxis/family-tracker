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

test('data survives a restart', async () => {
  await req('PUT', '/api/members/m1', JSON.stringify({ name: 'Test Kid' }), JSON_H);
  await stopServer();
  await startServer();
  assert.strictEqual(json(await req('GET', '/api/state')).data.members.m1.name, 'Test Kid');
});

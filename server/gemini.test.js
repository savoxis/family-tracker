'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const gemini = require('./gemini');

const TODAY = '2026-10-22';
const NOW = Date.UTC(2026, 9, 22, 20, 0, 0);

// A stand-in for Gemini and for the picture host.
function fake(opts) {
  opts = opts || {};
  const seen = { calls: [], keys: [], imageParts: 0 };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url.startsWith('/img/')) {
        res.setHeader('Content-Type', req.url.includes('notimage') ? 'text/html' : 'image/png');
        return res.end(Buffer.from('fakepng'));
      }
      seen.keys.push(req.headers['x-goog-api-key']);
      const b = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const parts = (b.contents[0] || {}).parts || [];
      seen.calls.push(parts[0].text);
      seen.imageParts += parts.filter((p) => p.inline_data).length;
      if (opts.quota && seen.calls.length > opts.quota) { res.statusCode = 429; return res.end('{}'); }
      if (opts.fail) { res.statusCode = 500; return res.end('{}'); }
      res.setHeader('Content-Type', 'application/json');
      const answer = opts.answer || { summary: 'Picture day is Thursday.', action: 'Send the form back by Friday.', events: [{ title: 'Picture day', date: '2026-10-29', time: '08:30' }, { title: 'Far away', date: '2031-01-01', time: '' }, { title: 'Bad date', date: 'soon', time: '' }] };
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: typeof answer === 'string' ? answer : JSON.stringify(answer) }] } }] }));
    });
  });
  seen.srv = srv;
  seen.listen = () => new Promise((r) => srv.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + srv.address().port)));
  return seen;
}
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ai-')), 'ai.json');
const post = (id, o) => Object.assign({ id: 'ps-' + id, title: 'Picture day', author: 'Ms. Lee', body: 'x'.repeat(250), images: [], at: new Date(NOW - 3600000).toISOString() }, o || {});
const mk = (f, base, extra) => {
  const out = { results: {}, logs: [] };
  out.g = gemini.create(Object.assign({ key: 'secret-key-123', base, tz: 'UTC', file: f, now: () => NOW, gapMs: 0, onResult: (id, r) => { out.results[id] = r; }, log: (m) => out.logs.push(m) }, extra || {}));
  return out;
};

test('the model answer is cleaned: bad dates, far dates and empty answers are dropped', () => {
  const a = gemini.clean('```json\n{"summary":"  Picture   day ","action":"","events":[{"title":"Picture day","date":"2026-10-29","time":"8:30"},{"title":"Far","date":"2031-01-01"},{"title":"","date":"2026-10-30"},{"title":"Old","date":"2020-01-01"}]}\n```', TODAY);
  assert.deepStrictEqual(a, { summary: 'Picture day', action: '', events: [{ title: 'Picture day', date: '2026-10-29', time: '', details: '' }] });
  // a spirit week: one event per day, each with what to wear or do
  const week = gemini.clean(JSON.stringify({ summary: 'Red Ribbon Week', action: 'Dress up each day', events: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((d, i) => ({ title: d + ' theme', date: '2026-10-' + (26 + i), time: '', details: 'Wear something for ' + d })) }), TODAY);
  assert.deepStrictEqual(week.events.map((e) => [e.title, e.date, e.details]), [['Mon theme', '2026-10-26', 'Wear something for Mon'], ['Tue theme', '2026-10-27', 'Wear something for Tue'], ['Wed theme', '2026-10-28', 'Wear something for Wed'], ['Thu theme', '2026-10-29', 'Wear something for Thu'], ['Fri theme', '2026-10-30', 'Wear something for Fri']]);
  assert.strictEqual(gemini.clean('not json', TODAY), null);
  assert.strictEqual(gemini.clean('{"summary":"","action":"","events":[]}', TODAY), null);
  const long = gemini.clean('{"summary":"' + 'a'.repeat(400) + '"}', TODAY).summary;
  assert.ok(long.length <= 162 && long.endsWith('...'), 'long summaries are cut short: ' + long.length);
});

test('reads a post with a picture once, sends the key only as a header, keeps the cache across restarts', async () => {
  const f = fake();
  const base = await f.listen();
  const file = tmpFile();
  const t = mk(file, base);
  try {
    await t.g.offer([post(1, { images: [base + '/img/a.png', base + '/img/notimage.png'] })]);
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.imageParts, 1, 'only the real picture is sent, the page that is not an image is skipped');
    assert.deepStrictEqual(f.keys, ['secret-key-123']);
    assert.ok(/Post text: x{200}/.test(f.calls[0]) && /Today is 2026-10-22/.test(f.calls[0]));
    assert.deepStrictEqual(t.results['ps-1'], { summary: 'Picture day is Thursday.', action: 'Send the form back by Friday.', events: [{ title: 'Picture day', date: '2026-10-29', time: '08:30', details: '' }] });
    assert.ok(!t.logs.join('\n').includes('secret-key-123'), 'the key leaked into the log');
    await t.g.offer([post(1, { images: [base + '/img/a.png'] })]);
    assert.strictEqual(f.calls.length, 1, 'a post is never read twice');
    const t2 = mk(file, base); // a restart remembers
    await t2.g.offer([post(1, { images: [base + '/img/a.png'] })]);
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(t2.g.cached('ps-1').summary, 'Picture day is Thursday.');
  } finally { f.srv.close(); }
});

test('only worthwhile, recent posts are read, newest first, and never past the daily cap', async () => {
  const f = fake();
  const base = await f.listen();
  const t = mk(tmpFile(), base, { dailyMax: 2 });
  try {
    await t.g.offer([
      post(1, { title: 'old flyer', images: [base + '/img/a.png'], at: new Date(NOW - 40 * 864e5).toISOString() }),
      post(2, { title: 'short words', body: 'Bring a pencil.', snippet: 'Bring a pencil.' }),
      post(3, { title: 'older', images: [base + '/img/a.png'], at: new Date(NOW - 5 * 3600000).toISOString() }),
      post(4, { title: 'newest', images: [base + '/img/a.png'], at: new Date(NOW - 1 * 3600000).toISOString() }),
      post(5, { title: 'middle', images: [base + '/img/a.png'], at: new Date(NOW - 3 * 3600000).toISOString() })
    ]);
    assert.strictEqual(f.calls.length, 2, 'the cap of 2 holds');
    assert.ok(/newest/.test(f.calls[0]) && /middle/.test(f.calls[1]), 'newest first');
    assert.ok(!f.calls.some((c) => /old flyer|short words/.test(c)));
    assert.strictEqual(t.g.stats().used, 2);
  } finally { f.srv.close(); }
});

test('two failures in a row stop the day, so a broken setup cannot use up the allowance', async () => {
  const f = fake({ fail: true });
  const base = await f.listen();
  const t = mk(tmpFile(), base);
  try {
    await t.g.offer([1, 2, 3, 4, 5].map((n) => post(n, { images: [base + '/img/a.png'], at: new Date(NOW - n * 3600000).toISOString() })));
    assert.strictEqual(f.calls.length, 2, 'only two attempts, then it stops');
    assert.ok(t.logs.some((l) => /repeated failures/.test(l)));
    assert.strictEqual(t.g.cached('ps-1'), null, 'nothing is marked as read');
    assert.strictEqual(gemini.DEFAULT_MODEL, 'gemini-3.5-flash-lite');
  } finally { f.srv.close(); }
});

test('a daily limit from Google stops the day quietly and nothing is marked as read', async () => {
  const f = fake({ quota: 1 });
  const base = await f.listen();
  const t = mk(tmpFile(), base);
  try {
    await t.g.offer([post(1, { images: [base + '/img/a.png'] }), post(2, { images: [base + '/img/a.png'], at: new Date(NOW - 7200000).toISOString() }), post(3, { images: [base + '/img/a.png'], at: new Date(NOW - 9000000).toISOString() })]);
    assert.strictEqual(f.calls.length, 2, 'stops right after the first refusal');
    assert.ok(t.results['ps-1'] && !t.results['ps-2']);
    assert.strictEqual(t.g.cached('ps-2'), null);
    assert.ok(t.logs.some((l) => /daily limit/.test(l)));
  } finally { f.srv.close(); }
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const menu = require('./menu');
const gemini = require('./gemini');

const iso = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const day = (n, l, extra) => Object.assign({ date: iso(n), noSchool: false, note: '', breakfast: ['Pancakes'], lunch: l }, extra || {});
const sample = (shift) => ({ month: iso(shift).slice(0, 7), everyday: { breakfast: ['Cereal'], lunch: ['PB&J Sandwich'] },
  days: [day(shift + 1, ['Chicken Tenders', 'Turkey Sandwich']), day(shift + 2, ['Pizza', 'Taco Salad']), day(shift + 3, ['Corn Dog', 'Mac and Cheese-V']), day(shift + 4, [], { noSchool: true, breakfast: [] })] });

// A stand-in for the district site and the schools' own sites, serving pages and PDF files.
function fakeSite(files) {
  const site = { hits: [], files };
  site.srv = http.createServer((req, res) => {
    site.hits.push(req.url);
    if (req.url === '/district') return res.end('<a href="/f/elementary__menu_oct.pdf">Elementary</a> <a href="/f/middle_school_menu_oct.pdf">Middle</a> <a href="/f/high_school_menu_oct.pdf">High</a> <a href="/f/form.pdf">Meal form</a>');
    if (req.url === '/school') return res.end('<a href="/f/elementary__menu_oct_1.pdf?v=2&amp;x=1">Menu</a>');
    if (req.url === '/broken') { res.statusCode = 500; return res.end('no'); }
    const m = /^\/f\/([^?]+)/.exec(req.url);
    if (m && site.files[m[1]]) { res.setHeader('Content-Type', 'application/pdf'); return res.end(site.files[m[1]]); }
    res.statusCode = 404; res.end();
  });
  site.listen = () => new Promise((r) => site.srv.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + site.srv.address().port)));
  return site;
}
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-menu-')), 'cache.json');

test('only menu PDFs for the chosen level are picked, relative and encoded links work, repeats are dropped', () => {
  const html = '<a href="/f/elementary__menu_oct.pdf">x</a><a href="https://files.example.com/11650/Elementary%20Menu%20Nov.pdf">y</a><a href="/f/middle_school_menu_oct.pdf">z</a>'
    + '<a href="/f/meal_preference_request_forms.pdf">w</a><a href="elementary__menu_oct.pdf">dup</a><a href="/x/elementary_menu_dec.pdf?a=1&amp;b=2">q</a><a href="/f/elementary_schedule.pdf">no</a>';
  assert.deepStrictEqual(menu.menuLinks(html, 'https://site.example.org/menus/page', 'elementary'), [
    'https://site.example.org/f/elementary__menu_oct.pdf', 'https://files.example.com/11650/Elementary%20Menu%20Nov.pdf', 'https://site.example.org/menus/elementary__menu_oct.pdf', 'https://site.example.org/x/elementary_menu_dec.pdf?a=1&b=2']);
  assert.deepStrictEqual(menu.menuLinks(html, 'https://site.example.org/', 'middle'), ['https://site.example.org/f/middle_school_menu_oct.pdf']);
});

test('one read per distinct menu even when three pages link it, nothing re-read, a changed file is re-read, and a failed re-read keeps the last good one', async () => {
  const pdfA = Buffer.from('menu-bytes-A'), pdfB = Buffer.from('menu-bytes-B');
  const site = fakeSite({ 'elementary__menu_oct.pdf': pdfA, 'elementary__menu_oct_1.pdf': pdfA });
  const base = await site.listen();
  const file = tmpFile();
  let reads = 0, fail = null;
  const gem = { readMenu: async (buf) => { reads += 1; if (fail) throw Object.assign(new Error(fail), { quota: fail === 'limit' }); return sample(buf.toString().endsWith('B') ? 40 : 0); } };
  const seen = [];
  const m = menu.create({ pages: [base + '/district', base + '/school', base + '/broken'], gem, file, log: () => {}, onData: (d) => seen.push(d) });
  try {
    const r1 = await m.poll();
    assert.deepStrictEqual([r1.links, r1.read, reads], [2, 1, 1], 'the same bytes under two names are read once: ' + JSON.stringify(r1));
    assert.strictEqual(seen[0].days.size, 4);
    assert.deepStrictEqual(seen[0].everyday.lunch, ['PB&J Sandwich']);
    await m.poll();
    assert.strictEqual(reads, 1, 'unchanged files cost nothing');
    // a new process remembers (the cache is on disk)
    const m2 = menu.create({ pages: [base + '/district'], gem, file, log: () => {}, onData: () => {} });
    await m2.poll();
    assert.strictEqual(reads, 1);
    // the district replaces the file: it is read again, and if that fails the last good reading is kept
    site.files['elementary__menu_oct.pdf'] = pdfB; site.files['elementary__menu_oct_1.pdf'] = pdfB;
    fail = 'limit';
    await m.poll();
    assert.strictEqual(reads, 2, 'one failed attempt, not another one for the same file under its second name');
    const last = seen[seen.length - 1];
    assert.ok(last.days.has(iso(1)) && !last.days.has(iso(41)), 'the last good menu stays in use');
    fail = null;
    const r4 = await m.poll();
    assert.strictEqual(r4.read, 1, 'read once the limit is over');
    assert.ok(seen[seen.length - 1].days.has(iso(41)), 'the new menu is in use');
  } finally { site.srv.close(); }
});

test('a menu entered by hand is used without any Gemini request, and no readable page is an error not an empty menu', async () => {
  const pdf = Buffer.from('hand-entered-menu');
  const site = fakeSite({ 'elementary__menu_oct.pdf': pdf });
  const base = await site.listen();
  const file = tmpFile();
  const sha1 = require('node:crypto').createHash('sha1').update(pdf).digest('hex');
  fs.writeFileSync(file, JSON.stringify({ 'https://old.example.org/elementary__menu_oct.pdf': { hash: sha1, parsed: sample(0), manual: true } }));
  let reads = 0, got = null;
  const m = menu.create({ pages: [base + '/district'], gem: { readMenu: async () => { reads += 1; return sample(0); } }, file, log: () => {}, onData: (d) => { got = d; } });
  try {
    await m.poll();
    assert.strictEqual(reads, 0, 'the hand-entered menu matched by content');
    assert.strictEqual(got.days.size, 4);
    const bad = menu.create({ pages: [base + '/broken'], gem: { readMenu: async () => sample(0) }, file: tmpFile(), log: () => {}, onData: () => assert.fail('must not report anything') });
    await assert.rejects(bad.poll(), /no menu page could be read/);
  } finally { site.srv.close(); }
});

test('the model menu answer is checked: real dates, short items, and too little is refused', () => {
  const today = iso(0);
  const ok = gemini.cleanMenu(JSON.stringify(sample(0)), today);
  assert.strictEqual(ok.days.length, 4);
  assert.deepStrictEqual(ok.days[3].lunch, [], 'no-school day has no menu');
  assert.strictEqual(gemini.cleanMenu('nonsense', today), null);
  assert.strictEqual(gemini.cleanMenu(JSON.stringify({ days: [day(1, ['A'])] }), today), null, 'one day is not a menu');
  const odd = sample(0); odd.days.push({ date: '2031-01-01', lunch: ['Far away'] }, { date: 'tomorrow', lunch: ['Bad'] }, day(1, ['duplicate']), day(2, new Array(12).fill('x'.repeat(200))));
  const c = gemini.cleanMenu(JSON.stringify(odd), today);
  assert.strictEqual(c.days.length, 4, 'far, malformed and repeated dates are dropped');
  const two = c.days.find((d) => d.date === iso(2));
  assert.ok(two.lunch.length === 2, 'the sample day keeps its two items');
});

test('server: the lunch goes on the calendar for school days, no school is marked, nothing doubles on a second look', async () => {
  const pdf = Buffer.from('fake-menu-bytes');
  const site = fakeSite({ 'elementary__menu_oct.pdf': pdf });
  const base = await site.listen();
  let gemCalls = 0, gotPdf = false;
  const gem = http.createServer((req, res) => {
    const b = []; req.on('data', (c) => b.push(c));
    req.on('end', () => {
      gemCalls += 1;
      const body = JSON.parse(Buffer.concat(b).toString());
      gotPdf = body.contents[0].parts.some((p) => p.inline_data && p.inline_data.mime_type === 'application/pdf');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(sample(0)) }] } }] }));
    });
  });
  await new Promise((r) => gem.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-menusrv-'));
  const port = 24000 + Math.floor(Math.random() * 1000);
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, {
    PORT: String(port), DATA_DIR: dir, PUBLIC_DIR: path.join(__dirname, '..', 'web'), BACKUP_HOURS: '0', GEMINI_API_KEY: 'k', GEMINI_BASE: 'http://127.0.0.1:' + gem.address().port,
    MENU_PAGE: base + '/district', MENU_DELAY_MS: '100', MENU_HOURS: '0.0005', MENU_LABEL: 'District lunch' }) });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const state = () => new Promise((resolve) => { http.get({ host: '127.0.0.1', port, path: '/api/state' }, (res) => { const b = []; res.on('data', (x) => b.push(x)); res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(b).toString())); } catch (e) { resolve(null); } }); }).on('error', () => resolve(null)); });
  try {
    let st = null;
    for (let i = 0; i < 100; i++) { st = await state(); if (st && Object.values(st.data.events).some((e) => e.src === 'menu')) break; await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(st && Object.values(st.data.events).some((e) => e.src === 'menu'), 'no menu events appeared: ' + log);
    const evs = Object.entries(st.data.events).filter(([, e]) => e.src === 'menu');
    assert.strictEqual(evs.length, 4);
    const lunch = st.data.events['menu-' + iso(1)];
    assert.deepStrictEqual([lunch.title, lunch.allDay, lunch.mk, lunch.source, lunch.cal], ['Lunch: Chicken Tenders / Turkey Sandwich', true, 'lunch', 'menu', 'District lunch']);
    assert.ok(/Lunch: Chicken Tenders \/ Turkey Sandwich\. Always available: PB&J Sandwich\. Breakfast: Pancakes/.test(lunch.note), lunch.note);
    const no = st.data.events['menu-' + iso(4)];
    assert.deepStrictEqual([no.title, no.mk], ['No school', 'noschool']);
    assert.strictEqual(st.data.school['menu-' + iso(2)].lunch[0], 'Pizza');
    assert.deepStrictEqual(st.data.school['menu-always'].lunch, ['PB&J Sandwich']);
    assert.ok(gotPdf, 'the PDF itself was sent to Gemini');
    // wait for at least one more look at the page, nothing is read or duplicated again
    const before = site.hits.filter((u) => u === '/district').length;
    for (let i = 0; i < 100 && site.hits.filter((u) => u === '/district').length <= before; i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(site.hits.filter((u) => u === '/district').length > before, 'the page was not looked at again');
    assert.strictEqual(gemCalls, 1, 'one Gemini request for the whole month');
    const st2 = await state();
    assert.strictEqual(Object.values(st2.data.events).filter((e) => e.src === 'menu').length, 4);
  } finally {
    await new Promise((r) => { proc.on('exit', r); proc.kill('SIGTERM'); });
    site.srv.close(); gem.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

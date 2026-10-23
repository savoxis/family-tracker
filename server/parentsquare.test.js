'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const ps = require('./parentsquare');

const post = (id, title, author, level) => '<div class="feed-title"><div class="subject"><a href="/feeds/' + id + '"><span id="feed-title-' + id + '" role="heading">' + title
  + '</span></a></div><ul class="feed-metadata"><li><a class="user-name " aria-label="Posted by ' + author + '" href="/u">' + author + '</a></li><li><span class="text-dark">' + level + '</span></li></ul></div>';

// A small stand-in for ParentSquare: CSRF token, cookie session, redirect to /signin when signed out.
function fakeSite() {
  const site = { logins: 0, session: 'sess-1', schools: {}, user: 'parent@example.com', pass: 'correct horse', paths: [] };
  const page = (id) => {
    const s = site.schools[id] || { name: 'Unknown', posts: [], unread: 0 };
    return '<html><head><title>Posts | ' + s.name + ' | ParentSquare</title></head><body>'
      + (s.unread ? '<a href="/chats">Messages <span class="badge"><span class="sr-only">Unread Messages:</span> ' + s.unread + ' </span></a>' : '<a href="/chats">Messages</a>')
      + s.posts.map((p) => post(p[0], p[1], p[2], p[3])).join('') + '</body></html>';
  };
  site.srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      site.paths.push(req.method + ' ' + req.url);
      const cookie = req.headers.cookie || '';
      if (req.url === '/signin') {
        res.setHeader('Set-Cookie', 'ps_s=anon; Path=/; HttpOnly');
        return res.end('<form action="/sessions" method="post"><input type="hidden" name="utf8" value="&#x2713;"><input type="hidden" name="authenticity_token" value="TOK&#x2B;1"><input name="session[email]"><input type="password" name="session[password]"></form>');
      }
      if (req.url === '/sessions' && req.method === 'POST') {
        const f = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
        site.logins += 1;
        if (f.authenticity_token === 'TOK+1' && f['session[email]'] === site.user && f['session[password]'] === site.pass) {
          res.setHeader('Set-Cookie', 'ps_s=' + site.session + '; Path=/; HttpOnly');
          res.statusCode = 302; res.setHeader('Location', '/'); return res.end();
        }
        res.statusCode = 302; res.setHeader('Location', '/signin'); return res.end();
      }
      const m = /^\/schools\/(\d+)\/feeds$/.exec(req.url);
      if (m) {
        if (!cookie.includes('ps_s=' + site.session)) { res.statusCode = 302; res.setHeader('Location', '/signin'); return res.end(); }
        return res.end(page(m[1]));
      }
      res.statusCode = 404; res.end();
    });
  });
  site.listen = () => new Promise((r) => site.srv.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + site.srv.address().port)));
  return site;
}
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ps-')), 'seen.json');

test('reads posts, the school name and the unread count out of the page', () => {
  const html = '<title>Posts | Brockway Elementary | ParentSquare</title><a>Messages <span class="badge"><span class="sr-only">Unread Messages:</span> 3 </span></a>'
    + post(11, 'Picture Day &amp; Retakes', 'Ms. Lee', 'Brockway Elementary') + post(12, 'Board update', 'Dr. Kim', 'Winston Dillard School District');
  const r = ps.parseFeed(html);
  assert.strictEqual(r.school, 'Brockway Elementary');
  assert.strictEqual(r.unread, 3);
  assert.deepStrictEqual(r.posts.map((p) => [p.id, p.title, p.author, p.level]), [['11', 'Picture Day & Retakes', 'Ms. Lee', 'Brockway Elementary'], ['12', 'Board update', 'Dr. Kim', 'Winston Dillard School District']]);
  assert.deepStrictEqual(ps.parseFeed('<html></html>'), { posts: [], unread: 0, school: '' });
});

test('signs in, notes existing posts silently, then tells the parents about new ones for the right child', async () => {
  const site = fakeSite();
  const base = await site.listen();
  site.schools = {
    1: { name: 'Brockway Elementary', unread: 1, posts: [[101, 'Old news', 'Ms. Lee', 'Brockway Elementary']] },
    2: { name: 'McGovern Elementary', unread: 0, posts: [[201, 'Old McGovern news', 'Mr. Ray', 'McGovern Elementary']] }
  };
  const sent = [], logs = [];
  const stateFile = tmp();
  const mk = () => ps.create({ base, user: site.user, password: site.pass, schools: [{ id: '1', child: 'Xander' }, { id: '2', child: 'Bastian' }], stateFile, notify: (m) => sent.push(m), log: (m) => logs.push(m), minLoginGapMs: 0 });
  try {
    const w = mk();
    await w.poll();
    assert.deepStrictEqual(sent, [], 'the first look only notes what is already there');
    assert.strictEqual(site.logins, 1);
    assert.ok(logs.some((l) => /watching Xander at Brockway Elementary, Bastian at McGovern Elementary/.test(l)), logs.join('|'));
    // new school-level posts go to the matching child, a district post shows in both feeds but is told once
    const district = [301, 'District closure', 'Dr. Kim', 'Winston Dillard School District'];
    site.schools[1].posts.unshift([102, 'Trunk or Treat', 'Ms. Lee', 'Brockway Elementary'], district);
    site.schools[2].posts.unshift([202, 'Field trip form', 'Mr. Ray', 'McGovern Elementary'], district);
    await w.poll();
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0], /^3 new school posts\./); // the district post is in both feeds but counts once
    assert.match(sent[0], /Xander \(Brockway Elementary\): "Trunk or Treat" by Ms\. Lee/);
    assert.match(sent[0], /District: "District closure" by Dr\. Kim/);
    assert.match(sent[0], /Bastian \(McGovern Elementary\): "Field trip form" by Mr\. Ray/);
    assert.strictEqual((sent[0].match(/District closure/g) || []).length, 1);
    await w.poll();
    assert.strictEqual(sent.length, 1, 'nothing new, nothing sent');
    // one new post names the child plainly
    site.schools[2].posts.unshift([203, 'Library day', 'Mr. Ray', 'McGovern Elementary']);
    await w.poll();
    assert.strictEqual(sent[1], 'New school post for Bastian (McGovern Elementary): "Library day" by Mr. Ray');
    // unread messages are tied to that child's school, and only when the count goes up
    site.schools[1].unread = 2;
    await w.poll();
    assert.strictEqual(sent[2], "Xander's school (Brockway Elementary): you have 2 unread ParentSquare messages.");
    site.schools[1].unread = 1;
    await w.poll();
    assert.strictEqual(sent.length, 3, 'a falling count is not news');
    // after a restart the old posts are not told again
    const w2 = mk();
    await w2.poll();
    assert.strictEqual(sent.length, 3);
    assert.ok(!logs.join('\n').includes(site.pass), 'the password leaked into the log');
  } finally { site.srv.close(); }
});

test('an expired session signs in again quietly', async () => {
  const site = fakeSite();
  const base = await site.listen();
  site.schools = { 1: { name: 'Brockway Elementary', unread: 0, posts: [[1, 'A', 'x', 'Brockway Elementary']] } };
  const sent = [];
  const w = ps.create({ base, user: site.user, password: site.pass, schools: [{ id: '1', child: 'Xander' }], stateFile: tmp(), notify: (m) => sent.push(m), minLoginGapMs: 0 });
  try {
    await w.poll();
    assert.strictEqual(site.logins, 1);
    site.session = 'sess-2'; // the old session no longer works
    site.schools[1].posts.unshift([2, 'B', 'x', 'Brockway Elementary']);
    await w.poll();
    assert.strictEqual(site.logins, 2);
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0], /"B"/);
  } finally { site.srv.close(); }
});

test('a wrong password stops after three tries and tells the parents once', async () => {
  const site = fakeSite();
  const base = await site.listen();
  site.schools = { 1: { name: 'Brockway Elementary', unread: 0, posts: [] } };
  const sent = [], logs = [];
  const w = ps.create({ base, user: site.user, password: 'wrong', schools: [{ id: '1', child: 'Xander' }], stateFile: tmp(), notify: (m) => sent.push(m), log: (m) => logs.push(m), minLoginGapMs: 0 });
  try {
    for (let i = 0; i < 6; i++) await w.poll();
    assert.strictEqual(site.logins, 3, 'must not keep hammering the sign-in');
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0], /login is not working/);
    assert.ok(!logs.join('\n').includes('wrong'), 'password in log');
  } finally { site.srv.close(); }
});

test('sign-in attempts respect the minimum gap', async () => {
  const site = fakeSite();
  const base = await site.listen();
  site.schools = { 1: { name: 'Brockway Elementary', unread: 0, posts: [] } };
  const w = ps.create({ base, user: site.user, password: 'wrong', schools: [{ id: '1', child: 'Xander' }], stateFile: tmp(), minLoginGapMs: 600000 });
  try {
    await w.poll(); await w.poll(); await w.poll();
    assert.strictEqual(site.logins, 1);
  } finally { site.srv.close(); }
});

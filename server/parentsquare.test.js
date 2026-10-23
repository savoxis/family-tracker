'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ps = require('./parentsquare');

// Markup shaped like ParentSquare's posts page.
const post = (o) => '<div id="feed_' + o.id + '" data-feed-levels="[&quot;' + o.level + '&quot;]" data-current-feed-level="x"><div class="feed-show feed-main feed-box "><div class="feed-title"><div class="feed-icon">'
  + (o.pinned ? '<div class="name-avatar feed-school"><i class="fa fa-thumb-tack"></i></div>' : '<div class="name-avatar">LD</div>') + '</div><div class="subject"><a href="/feeds/' + o.id + '"><span id="feed-title-' + o.id + '" role="heading">' + o.title
  + '</span></a></div><ul class="feed-metadata">' + (o.chips || []).map((c) => (/RSVP/.test(c) ? '<div class="color-highlight"><span class="rsvp-total">' + c + '</span></div>' : '<span class="color-highlight">' + c + '</span>')).join('<span aria-hidden="true">&bull;</span>')
  + '<li class="feed-metadata-from"><a class="user-name " aria-label="Posted by ' + o.author + '" href="/u">' + o.author + '</a></li><li class="feed-metadata-time"><span class="time-ago" data-timestamp="' + (o.ts || '2026-10-05 16:00:00+00:00') + '"></span><span class="text-dark">' + o.level + '</span></li></ul></div>'
  + (o.event ? '<a href="http://www.google.com/calendar/event?action=TEMPLATE&amp;text=x&amp;dates=' + o.event + '/20261031T230000Z">Google Calendar</a>' : '')
  + '<div class="description truncated-text" dir="ltr"><!-- note --><p>' + (o.body || '') + '</p>' + (o.imgs || '') + '</div></div></div>';

// A small stand-in for ParentSquare: CSRF token, cookie session, redirect to /signin when signed out.
function fakeSite() {
  const site = { logins: 0, session: 'sess-1', schools: {}, user: 'parent@example.com', pass: 'correct horse', down: {}, paths: [], signups: {}, chats: {}, sent: [], reject: false, wp: [] };
  const page = (id) => {
    const s = site.schools[id] || { name: 'Unknown', posts: [], unread: 0 };
    return '<html><head><title>Posts | ' + s.name + ' | ParentSquare</title></head><body>'
      + '<a href="/schools/' + id + '/users/777/chats">inbox</a>' + (s.unread ? '<a href="/chats">Messages <span class="badge"><span class="sr-only">Unread Messages:</span> ' + s.unread + ' </span></a>' : '<a href="/chats">Messages</a>')
      + s.posts.map(post).join('') + '</body></html>';
  };
  site.srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const cookie = req.headers.cookie || '';
      site.paths.push(req.method + ' ' + req.url);
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
        if (site.down[m[1]]) { res.statusCode = 500; return res.end('oops'); }
        return res.end(page(m[1]));
      }
      const authed = cookie.includes('ps_s=' + site.session);
      let x;
      if ((x = /^\/schools\/(\d+)\/sign_ups$/.exec(req.url))) {
        if (!authed) { res.statusCode = 302; res.setHeader('Location', '/signin'); return res.end(); }
        if (site.down['su' + x[1]]) { res.statusCode = 500; return res.end('oops'); }
        return res.end(site.signups[x[1]] || '');
      }
      if (req.method === 'GET' && (x = /^\/schools\/(\d+)\/users\/777\/chats$/.exec(req.url))) {
        if (!authed) { res.statusCode = 302; res.setHeader('Location', '/signin'); return res.end(); }
        return res.end('<meta name="csrf-token" content="CSRF-OK">' + (site.chats[x[1]] || ''));
      }
      if ((x = /^\/schools\/(\d+)\/users\/777\/chats\/new\?private=true$/.exec(req.url))) {
        if (!authed) { res.statusCode = 302; res.setHeader('Location', '/signin'); return res.end(); }
        return res.end('<meta name="csrf-token" content="CSRF-OK"><form id="user-chat-form"></form>');
      }
      if (/^\/schools\/(\d+)\/users\/autocomplete\?/.test(req.url)) {
        if (!authed) { res.statusCode = 302; res.setHeader('Location', '/signin'); return res.end(); }
        const knight = /query=Knight/.test(req.url);
        return res.end(JSON.stringify([[knight ? { id: 14347788, name: 'Kayla Knight', role: ['Teacher', null], is_student: false }
          : { id: 14347987, name: 'Keli Bruehling', role: ['Teacher', null], is_student: false }, { id: 555, name: 'Keli Bruehling Jr', role: ['Student'], is_student: true }], 2]));
      }
      // sending: a new conversation, or a reply in an existing one
      if (req.method === 'POST' && ((x = /^\/schools\/(\d+)\/users\/777\/chats$/.exec(req.url)) || (x = /^\/users\/777\/chats\/(\d+)\/messages$/.exec(req.url)))) {
        const f = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
        site.wp.push(req.method + ' ' + req.url);
        if (!authed || f.authenticity_token !== 'CSRF-OK' || !f.message || site.reject) { res.statusCode = 422; return res.end('nope'); }
        const isNew = /^\/schools\//.test(req.url);
        site.sent.push(isNew ? { kind: 'new', sid: x[1], form: f } : { kind: 'reply', chat: x[1], form: f });
        res.statusCode = 302; res.setHeader('Location', '/schools/1/users/777/chats/' + (isNew ? '99' : x[1])); return res.end();
      }
      res.statusCode = 404; res.end();
    });
  });
  site.listen = () => new Promise((r) => site.srv.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + site.srv.address().port)));
  return site;
}
const slot = (id, time, who) => '<div id="wish_list_item_' + id + '" class="wish-list-item-row"><div class="wish-list-item-name"><p>Appointment Time Slot</p></div><div class="wish-list-item-time"> ' + time + ' </div>'
  + (who || []).map((w, i) => '<li id="sign_up_' + id + i + '" class="col-sign-ups-entry hover-box"><a href="/schools/1/users/' + w[0] + '">' + w[1] + '</a><span class="ml-5">(' + w[2] + ')</span></li>').join('') + '</div>';
const signupPost = (id, title, body) => '<div id="feed_' + id + '" data-feed-levels="[&quot;x&quot;]"><div class="feed-show"><div class="feed-title"><div class="subject center-aligned" role="heading"> ' + title + ' </div></div>' + body + '</div></div>';
const dateHead = (t) => '<div class="wish-list-date space-between "><span>' + t + '</span></div>';
const chatItem = (id, name, n, when, preview) => '<a class="a-chat-thread a-chat-thread-' + id + ' " role="button" aria-label="Conversation with ' + name + '. ' + n + ' messages total. Last message sent: ' + when + '" aria-selected="false"><span class="user-thread-chat-name-' + id + '">' + name
  + '</span><span class="badge badge-outline">' + n + '</span><div class="date">' + when + '</div><span class="reaction-icons">' + (preview || '') + '</span></a>';
const mk = (site, base, extra) => {
  const out = { calls: [], logs: [] };
  out.w = ps.create(Object.assign({ base, user: site.user, password: site.pass, schools: [{ id: '1', child: 'Xander' }, { id: '2', child: 'Bastian' }], minLoginGapMs: 0,
    onData: (docs, ok, skip) => out.calls.push({ docs, ok, skip }), log: (m) => out.logs.push(m) }, extra || {}));
  return out;
};

test('reads posts, flags, event dates, previews and the unread count out of the page', () => {
  const html = '<title>Posts | Brockway Elementary | ParentSquare</title><a>Messages <span class="badge"><span class="sr-only">Unread Messages:</span> 3 </span></a>'
    + post({ id: 11, title: 'Picture Day &amp; Retakes', author: 'Ms. Lee', level: 'Brockway Elementary', pinned: true, body: 'Bring a smile. &nbsp;Forms due Friday.' })
    + post({ id: 12, title: 'Trunk or Treat', author: 'Dr. Kim', level: 'Winston Dillard School District', chips: ['1 form', '4 RSVPs', '2/25 Sign Ups', '1 file'], event: '20261031T220000Z', ts: '2026-10-16 20:28:14+00:00' });
  const r = ps.parseFeed(html);
  assert.strictEqual(r.school, 'Brockway Elementary');
  assert.strictEqual(r.unread, 3);
  assert.strictEqual(r.posts.length, 2);
  const [a, b] = r.posts;
  assert.deepStrictEqual([a.id, a.title, a.author, a.level, a.pinned, a.snippet], ['11', 'Picture Day & Retakes', 'Ms. Lee', 'Brockway Elementary', true, 'Bring a smile. Forms due Friday.']);
  assert.deepStrictEqual([b.pinned, b.chips, b.level, b.at, b.eventAt], [false, ['1 form', '4 RSVPs', '2/25 Sign Ups', '1 file'], 'Winston Dillard School District', '2026-10-16T20:28:14.000Z', '2026-10-31T22:00:00.000Z']);
  assert.deepStrictEqual(ps.parseFeed('<html></html>'), { posts: [], unread: 0, school: '', uid: '' });
});

test('post pictures are collected once, small and tracking images are skipped', () => {
  const flyer = 'https://posts.example.com/inline_images_abc_1-flyer+one.png';
  const imgs = '<img src="' + flyer + '"><img src="' + flyer + '"><img src="https://x.example.com/p.gif" width="1" height="1"><img src="http://insecure.example.com/a.png">'
    + '<img class="emoji" src="https://x.example.com/smile.png"><img src="https://posts.example.com/photo&amp;x=1.jpg" width="640"><img src="https://x.example.com/2.jpg"><img src="https://x.example.com/3.jpg"><img src="https://x.example.com/4.jpg">';
  const r = ps.parseFeed('<title>Posts | Brockway Elementary | ParentSquare</title>' + post({ id: 5, title: 'Flyer', author: 'x', level: 'Brockway Elementary', imgs })
    + post({ id: 6, title: 'No pictures', author: 'x', level: 'Brockway Elementary' }));
  assert.deepStrictEqual(r.posts[0].images, [flyer, 'https://posts.example.com/photo&x=1.jpg', 'https://x.example.com/2.jpg', 'https://x.example.com/3.jpg']);
  assert.deepStrictEqual(r.posts[1].images, []);
});

test('each post lands with the right child, district posts once, unread counts per school', async () => {
  const site = fakeSite();
  const base = await site.listen();
  const district = { id: 301, title: 'District closure', author: 'Dr. Kim', level: 'Winston Dillard School District' };
  site.schools = {
    1: { name: 'Brockway Elementary', unread: 2, posts: [{ id: 102, title: 'Trunk or Treat', author: 'Ms. Lee', level: 'Brockway Elementary', chips: ['1 form'] }, { id: 103, title: 'Spelling list', author: 'Mr. Park', level: 'Room 12 2026-2027' }, district] },
    2: { name: 'McGovern Elementary', unread: 0, posts: [{ id: 202, title: 'Field trip', author: 'Mr. Ray', level: 'McGovern Elementary' }, district] }
  };
  const t = mk(site, base);
  try {
    const docs = await t.w.poll();
    assert.strictEqual(site.logins, 1);
    assert.deepStrictEqual(t.calls[0].ok, ['1', '2']);
    assert.deepStrictEqual([...docs.keys()].sort(), ['ps-102', 'ps-103', 'ps-202', 'ps-301', 'ps-status', 'ps-unread-1', 'ps-unread-2']);
    // a class or group post in a school's feed belongs to that school's child, not to the district
    assert.deepStrictEqual([docs.get('ps-103').childName, docs.get('ps-103').level, docs.get('ps-103').group, docs.get('ps-103').school], ['Xander', 'class', 'Room 12 2026-2027', 'Brockway Elementary']);
    const d = (k) => docs.get(k);
    assert.deepStrictEqual([d('ps-102').childName, d('ps-102').level, d('ps-102').school, d('ps-102').chips], ['Xander', 'school', 'Brockway Elementary', ['1 form']]);
    assert.deepStrictEqual([d('ps-202').childName, d('ps-202').school], ['Bastian', 'McGovern Elementary']);
    assert.deepStrictEqual([d('ps-301').childName, d('ps-301').level, d('ps-301').school], ['', 'district', 'Winston Dillard School District']);
    assert.deepStrictEqual([d('ps-unread-1').n, d('ps-unread-1').childName], [2, 'Xander']);
    assert.deepStrictEqual([d('ps-unread-2').n, d('ps-unread-2').childName], [0, 'Bastian']);
    assert.strictEqual(d('ps-102').url, base + '/feeds/102');
    assert.strictEqual(d('ps-status').ok, true);
    assert.ok(!t.logs.join('\n').includes(site.pass), 'the password leaked into the log');
  } finally { site.srv.close(); }
});

test('an expired session signs in again quietly', async () => {
  const site = fakeSite();
  const base = await site.listen();
  site.schools = { 1: { name: 'Brockway Elementary', unread: 0, posts: [{ id: 1, title: 'A', author: 'x', level: 'Brockway Elementary' }] } };
  const t = mk(site, base, { schools: [{ id: '1', child: 'Xander' }] });
  try {
    await t.w.poll();
    assert.strictEqual(site.logins, 1);
    site.session = 'sess-2'; // the old session no longer works
    site.schools[1].posts.unshift({ id: 2, title: 'B', author: 'x', level: 'Brockway Elementary' });
    const docs = await t.w.poll();
    assert.strictEqual(site.logins, 2);
    assert.ok(docs.has('ps-2') && docs.get('ps-status').ok);
  } finally { site.srv.close(); }
});

test('a school that cannot be read is left alone, the others still update', async () => {
  const site = fakeSite();
  const base = await site.listen();
  site.schools = {
    1: { name: 'Brockway Elementary', unread: 0, posts: [{ id: 1, title: 'A', author: 'x', level: 'Brockway Elementary' }] },
    2: { name: 'McGovern Elementary', unread: 0, posts: [{ id: 2, title: 'B', author: 'x', level: 'McGovern Elementary' }] }
  };
  site.down[2] = true;
  const t = mk(site, base);
  try {
    const docs = await t.w.poll();
    assert.deepStrictEqual(t.calls[0].ok, ['1']);
    assert.ok(docs.has('ps-1') && !docs.has('ps-2'));
    assert.strictEqual(docs.get('ps-status').ok, false);
    assert.match(docs.get('ps-status').message, /every school/);
  } finally { site.srv.close(); }
});

test('a wrong password stops after three tries and says so on the board', async () => {
  const site = fakeSite();
  const base = await site.listen();
  site.schools = { 1: { name: 'Brockway Elementary', unread: 0, posts: [] } };
  const t = mk(site, base, { password: 'wrong', schools: [{ id: '1', child: 'Xander' }] });
  try {
    let last;
    for (let i = 0; i < 6; i++) last = await t.w.poll();
    assert.strictEqual(site.logins, 3, 'must not keep hammering the sign-in');
    assert.strictEqual(last.get('ps-status').ok, false);
    assert.match(last.get('ps-status').message, /sign-in stopped/);
    assert.ok(!t.logs.join('\n').includes('wrong'), 'password in log');
  } finally { site.srv.close(); }
});

const NOW = Date.UTC(2026, 9, 22, 20, 0, 0);

test('your own appointment slots are picked out of the sign-ups page, other families are ignored', () => {
  const html = signupPost(901, 'Appointment Sign Ups - Bruehling', dateHead('Friday, Oct 30')
    + slot(1, '10:00 AM to 10:15 AM', [[999, 'Other Parent', 'Other Kid']])
    + slot(2, '12:00 PM to 12:15 PM', [[777, 'Zachary Child', 'Sebastian Child']])
    + slot(3, '12:20 PM to 12:35 PM', []) + dateHead('Monday, Nov 2') + slot(4, '1:05 PM to 1:20 PM', [[777, 'Zachary Child', 'Sebastian Child']]))
    + signupPost(902, 'Volunteers', dateHead('Saturday, Oct 31') + slot(5, '3:00 PM to 4:00 PM', [[999, 'Someone', 'Else']]));
  const r = ps.parseSignups(html, '777', NOW);
  assert.deepStrictEqual(r.map((g) => [g.post, g.title, g.date, g.st, g.et]), [['901', 'Appointment Sign Ups - Bruehling', '2026-10-30', '12:00', '12:15'], ['901', 'Appointment Sign Ups - Bruehling', '2026-11-02', '13:05', '13:20']]);
  assert.deepStrictEqual(ps.parseSignups(html, '', NOW), [], 'without a user id nothing can be told apart');
  assert.strictEqual(ps.appointmentTitle('Appointment Sign Ups - Bruehling'), 'Appointment with Bruehling');
  assert.strictEqual(ps.appointmentTitle('Conference Sign-Up: Ms. Frost'), 'Conference with Ms. Frost');
  assert.strictEqual(ps.appointmentTitle('Volunteers'), 'Volunteers');
});

test('the message list gives who, how many and when in board time, and the text only on request', () => {
  const html = chatItem(11, 'Kayla Knight', 8, 'Thu 10/22/26, 3:05 pm', 'A private note') + chatItem(12, 'Front Office', 2, 'Mon 10/05/26, 9:30 am', '');
  const a = ps.parseChats(html, 'America/Los_Angeles', false);
  assert.deepStrictEqual(a.map((c) => [c.id, c.name, c.count, c.at, c.preview]), [['11', 'Kayla Knight', 8, '2026-10-22T22:05:00.000Z', ''], ['12', 'Front Office', 2, '2026-10-05T16:30:00.000Z', '']]);
  assert.strictEqual(ps.parseChats(html, 'America/Los_Angeles', true)[0].preview, 'A private note');
  assert.deepStrictEqual(ps.parseChats('<html></html>', 'UTC', false), []);
});

test('sign-ups, messages and teachers arrive tied to the right child, and no conversation is ever opened', async () => {
  const site = fakeSite();
  const base = await site.listen();
  site.schools = { 1: { name: 'Brockway Elementary', unread: 1, posts: [] }, 2: { name: 'McGovern Elementary', unread: 0, posts: [] } };
  site.chats = { 1: chatItem(11, 'Kayla Knight', 8, 'Thu 10/22/26, 3:05 pm', 'secret words') + chatItem(12, 'Front Office', 2, 'Mon 10/05/26, 9:30 am') };
  site.signups = { 2: signupPost(901, 'Appointment Sign Ups - Bruehling', dateHead('Friday, Oct 30') + slot(2, '12:00 PM to 12:15 PM', [[777, 'Zachary Child', 'Sebastian Child']])) };
  const t = mk(site, base, { tz: 'America/Los_Angeles', now: () => NOW, teachers: [{ child: 'Bastian', name: 'Keli Bruehling' }, { child: 'Xander', name: 'Nobody Here' }] });
  try {
    const docs = await t.w.poll();
    const su = docs.get('ps-su-20');
    assert.deepStrictEqual([su.title, su.sd, su.st, su.et, su.childName, su.school], ['Appointment with Bruehling', '2026-10-30', '12:00', '12:15', 'Bastian', 'McGovern Elementary']);
    const m = docs.get('ps-chat-11');
    assert.deepStrictEqual([m.name, m.count, m.at, m.unread, m.childName, m.preview], ['Kayla Knight', 8, '2026-10-22T22:05:00.000Z', true, 'Xander', '']);
    assert.strictEqual(docs.get('ps-chat-12').unread, false);
    assert.ok(!JSON.stringify([...docs.values()]).includes('secret words'), 'message text must not be stored unless asked for');
    const tc = docs.get('ps-teacher-2-14347987');
    assert.deepStrictEqual([tc.name, tc.role, tc.childName], ['Keli Bruehling', 'Teacher', 'Bastian']);
    assert.ok(![...docs.keys()].some((k) => k.startsWith('ps-teacher-1-')), 'an unknown teacher is not offered');
    assert.ok(!site.paths.some((p) => /\/chats\/\d+/.test(p)), 'a conversation page was opened: ' + site.paths.filter((p) => /chats/.test(p)).join(' '));
    assert.ok(site.paths.some((p) => /autocomplete/.test(p)));
  } finally { site.srv.close(); }
});

test('a page that cannot be read is skipped, not treated as empty', async () => {
  const site = fakeSite();
  const base = await site.listen();
  site.schools = { 1: { name: 'Brockway Elementary', unread: 0, posts: [] } };
  site.down.su1 = true;
  site.chats = { 1: '<html><body>No conversations yet</body></html>' };
  const t = mk(site, base, { schools: [{ id: '1', child: 'Xander' }], tz: 'UTC' });
  try {
    await t.w.poll();
    const skip = t.calls[0].skip;
    assert.ok(skip.has('1|signup'), 'sign-ups failed so they must be left alone');
    assert.ok(!skip.has('1|message'));
  } finally { site.srv.close(); }
});

test('a message to a teacher is a new conversation, or a reply when one exists, with exactly the form ParentSquare expects', async () => {
  const site = fakeSite();
  const base = await site.listen();
  site.schools = { 1: { name: 'Brockway Elementary', unread: 0, posts: [] }, 2: { name: 'McGovern Elementary', unread: 0, posts: [] } };
  site.chats = { 1: chatItem(11, 'Kayla Knight', 8, 'Thu 10/22/26, 3:05 pm') };
  const t = mk(site, base, { tz: 'UTC', now: () => NOW, minSendGapMs: 0, teachers: [{ child: 'Bastian', name: 'Keli Bruehling' }, { child: 'Xander', name: 'Kayla Knight' }] });
  try {
    const docs = await t.w.poll();
    assert.strictEqual(docs.get('ps-teacher-2-14347987').canReply, false, 'no conversation with Bruehling yet');
    assert.strictEqual(docs.get('ps-teacher-1-14347788').canReply, true, 'Knight already has a conversation');
    // Bastian's teacher: no conversation, so a new direct message
    const r1 = await t.w.send({ sid: '2', teacherId: '14347987', text: '  Thank you, we will see you Friday.  ' });
    assert.deepStrictEqual([r1.ok, r1.teacher, r1.replied], [true, 'Keli Bruehling', false]);
    assert.strictEqual(site.sent[0].kind, 'new');
    const f = site.sent[0].form;
    assert.deepStrictEqual([f.institute_id, f.institute_type, f.private, f.users, f.message, f.authenticity_token, f.recipient_data], ['2', 'School', 'true', '14347987', 'Thank you, we will see you Friday.', 'CSRF-OK', '']);
    // Xander's teacher: reply in the existing conversation
    const r2 = await t.w.send({ sid: '1', teacherId: '14347788', text: 'Thanks for letting me know.' });
    assert.strictEqual(r2.replied, true);
    assert.deepStrictEqual([site.sent[1].kind, site.sent[1].chat, site.sent[1].form.message], ['reply', '11', 'Thanks for letting me know.']);
    assert.ok(!site.paths.some((p) => /\/chats\/\d+/.test(p) && p.startsWith('GET')), 'a conversation page was opened');
  } finally { site.srv.close(); }
});

test('only a teacher the server found can be messaged, empty and huge messages are refused, a refusal is not retried', async () => {
  const site = fakeSite();
  const base = await site.listen();
  site.schools = { 2: { name: 'McGovern Elementary', unread: 0, posts: [] } };
  const t = mk(site, base, { schools: [{ id: '2', child: 'Bastian' }], tz: 'UTC', minSendGapMs: 0, teachers: [{ child: 'Bastian', name: 'Keli Bruehling' }] });
  try {
    await t.w.poll();
    await assert.rejects(t.w.send({ sid: '2', teacherId: '555', text: 'hello' }), /not available/);
    await assert.rejects(t.w.send({ sid: '2', teacherId: '999', text: 'hello' }), /not available/);
    await assert.rejects(t.w.send({ sid: '2', teacherId: '14347987', text: '   ' }), /empty or too long/);
    await assert.rejects(t.w.send({ sid: '2', teacherId: '14347987', text: 'x'.repeat(1501) }), /empty or too long/);
    assert.strictEqual(site.wp.length, 0, 'nothing was posted for any of those');
    site.reject = true;
    await assert.rejects(t.w.send({ sid: '2', teacherId: '14347987', text: 'hello' }), /did not accept the message/);
    assert.strictEqual(site.wp.length, 1, 'exactly one attempt, no retry');
    assert.strictEqual(site.sent.length, 0);
  } finally { site.srv.close(); }
});

// The whole server against the stand-in ParentSquare: the PIN gate, the lockout and the hourly cap.
async function serverWithSite(extraEnv, seed, posts) {
  const site = fakeSite();
  const base = await site.listen();
  site.schools = { 1: { name: 'Brockway Elementary', unread: 0, posts: [] }, 2: { name: 'McGovern Elementary', unread: 0, posts: posts || [] } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-psmsg-'));
  if (seed) fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ rev: 1, data: Object.assign({ members: {}, chores: {}, rewards: {}, events: {}, ledger: {}, meals: {}, groceries: {}, notes: {}, config: {}, school: {} }, seed) }));
  const port = 23000 + Math.floor(Math.random() * 1000);
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, {
    PORT: String(port), DATA_DIR: dir, PUBLIC_DIR: path.join(__dirname, '..', 'web'), BACKUP_HOURS: '0', PS_BASE: base, PARENTSQUARE_USER: site.user, PARENTSQUARE_PASSWORD: site.pass,
    PS_SCHOOLS: '1:Xander,2:Bastian', PS_TEACHERS: 'Bastian:Keli Bruehling', PS_LOGIN_GAP_MS: '0', PS_MINUTES: '60', BOARD_TZ: 'UTC' }, extraEnv || {}) });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'Content-Type': 'application/json' } }, (res) => {
      const b = []; res.on('data', (x) => b.push(x)); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(b).toString()); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject); if (body !== undefined) r.write(JSON.stringify(body)); r.end();
  });
  const until = async (fn) => { for (let i = 0; i < 100; i++) { let v = null; try { v = await fn(); } catch (e) { /* the server is still starting */ } if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
  const ready = await until(async () => { const s = (await call('GET', '/api/state')).json; return s && Object.values(s.data.school).some((d) => d.kind === 'teacher'); });
  const stop = async () => { await new Promise((r) => { proc.on('exit', r); proc.kill('SIGTERM'); }); site.srv.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { site, call, ready, stop, log: () => log };
}

test('server: messaging needs the PIN, locks after five wrong tries, and only reaches a listed teacher', async () => {
  const s = await serverWithSite();
  try {
    assert.ok(s.ready, 'the teacher was not found: ' + s.log());
    const body = (o) => Object.assign({ sid: '2', tid: '14347987', text: 'Private words for the teacher', pin: '4321' }, o);
    assert.strictEqual((await s.call('POST', '/api/school-message', body())).status, 403, 'no PIN set yet');
    await s.call('PUT', '/api/config/display', { pin: '4321' });
    assert.strictEqual((await s.call('POST', '/api/school-message', body({ tid: '1234' }))).status, 404, 'a made-up teacher id');
    assert.strictEqual((await s.call('POST', '/api/school-message', body({ sid: '1' }))).status, 404, 'right id, wrong school');
    assert.strictEqual((await s.call('POST', '/api/school-message', body({ text: '   ' }))).status, 400);
    for (let i = 0; i < 5; i++) assert.strictEqual((await s.call('POST', '/api/school-message', body({ pin: '000' + i }))).status, 403);
    const locked = await s.call('POST', '/api/school-message', body());
    assert.strictEqual(locked.status, 429, 'even the right PIN is refused during the lockout');
    assert.strictEqual(s.site.sent.length, 0, 'nothing reached ParentSquare');
    assert.ok(!s.log().includes('Private words') && !s.log().includes('4321'), 'message or PIN in the log');
  } finally { await s.stop(); }
});

test('server: the right PIN sends one message, and the hourly cap holds', async () => {
  const s = await serverWithSite({ PS_SEND_MAX: '2' });
  try {
    assert.ok(s.ready, 'the teacher was not found: ' + s.log());
    await s.call('PUT', '/api/config/display', { pin: '4321' });
    const send = (text) => s.call('POST', '/api/school-message', { sid: '2', tid: '14347987', text, pin: '4321' });
    const r = await send('See you at the conference');
    assert.deepStrictEqual([r.status, r.json && r.json.ok, r.json && r.json.teacher], [200, true, 'Keli Bruehling']);
    assert.strictEqual(s.site.sent.length, 1);
    assert.strictEqual(s.site.sent[0].form.message, 'See you at the conference');
    assert.strictEqual((await send('A second note')).status, 200);
    assert.strictEqual((await send('A third note')).status, 429, 'over the hourly cap');
    assert.strictEqual(s.site.sent.length, 2);
    assert.ok(!s.log().includes('See you at the conference') && !s.log().includes('4321'), 'message or PIN in the log');
  } finally { await s.stop(); }
});

test('server: dates the flyer reader finds go on the calendar in the child color, once, without doubling up', async () => {
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  let geminiCalls = 0, geminiKey = '';
  const gem = http.createServer((req, res) => {
    const b = []; req.on('data', (c) => b.push(c));
    req.on('end', () => {
      geminiCalls += 1; geminiKey = req.headers['x-goog-api-key'];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'Red Ribbon Week is next week.', action: 'Dress up each day.', events: [
        { title: 'Mismatch Monday', date: day(3), time: '', details: 'Wear mismatched clothes' },
        { title: 'Twin Tuesday', date: day(4), time: '', details: 'Dress like a friend' },
        { title: 'Assembly', date: day(5), time: '08:30', details: '' }] }) }] } }] }));
    });
  });
  await new Promise((r) => gem.listen(0, '127.0.0.1', r));
  const seed = { members: { m2: { name: 'Bastian', color: '#D9780F', order: 1 } },
    events: { pre: { title: 'Assembly', allDay: false, sd: day(5), ed: day(5), st: '08:30', et: '09:30', who: '', loc: '' } } };
  const s = await serverWithSite({ GEMINI_API_KEY: 'gem-secret-key', GEMINI_BASE: 'http://127.0.0.1:' + gem.address().port, GEMINI_DAILY_MAX: '5' }, seed,
    [{ id: 777, title: 'Red Ribbon Week Next Week', author: 'Ms. Frost', level: 'McGovern Elementary', body: 'Dress up each day. '.repeat(20) }]);
  try {
    assert.ok(s.ready, 'server did not start: ' + s.log());
    const flyer = await (async () => { for (let i = 0; i < 100; i++) { const st = (await s.call('GET', '/api/state')).json; const f = Object.entries(st.data.events).filter(([, e]) => e.src === 'flyer'); if (f.length >= 2) return { st, f }; await new Promise((r) => setTimeout(r, 100)); } return null; })();
    assert.ok(flyer, 'no flyer events appeared: ' + s.log());
    const byTitle = Object.fromEntries(flyer.f.map(([, e]) => [e.title, e]));
    const m = byTitle['Mismatch Monday'];
    assert.deepStrictEqual([m.sd, m.allDay, m.note, m.who, m.source, m.cal], [day(3), true, 'Wear mismatched clothes', 'm2', 'flyer', 'McGovern Elementary']);
    assert.strictEqual(byTitle['Twin Tuesday'].note, 'Dress like a friend');
    assert.strictEqual(flyer.f.length, 2, 'the Assembly was already on the calendar, so it is not doubled up');
    assert.strictEqual(Object.values(flyer.st.data.events).filter((e) => e.title === 'Assembly').length, 1);
    const post = Object.values(flyer.st.data.school).find((d) => d.kind === 'post');
    assert.deepStrictEqual([post.ai.summary, post.ai.events.length, post.body], ['Red Ribbon Week is next week.', 3, undefined]);
    assert.strictEqual(geminiCalls, 1);
    assert.strictEqual(geminiKey, 'gem-secret-key');
    assert.ok(!s.log().includes('gem-secret-key'), 'the Gemini key leaked into the log');
  } finally { await s.stop(); gem.close(); }
});

test('sign-in attempts respect the minimum gap', async () => {
  const site = fakeSite();
  const base = await site.listen();
  site.schools = { 1: { name: 'Brockway Elementary', unread: 0, posts: [] } };
  const t = mk(site, base, { password: 'wrong', schools: [{ id: '1', child: 'Xander' }], minLoginGapMs: 600000 });
  try {
    await t.w.poll(); await t.w.poll(); await t.w.poll();
    assert.strictEqual(site.logins, 1);
  } finally { site.srv.close(); }
});

'use strict';
/**
 * Unofficial Google Keep client for the Kitchen Board shopping list. Zero dependencies.
 *
 * Google has no public Keep API for personal accounts. This speaks the same private protocol the
 * Keep Android app uses, ported from the open source gpsoauth and gkeepapi projects, so it can
 * break whenever Google changes it. Use a dedicated Google account that the list is shared with.
 *
 * The master token is a long-lived credential. It is never logged and never leaves this file's
 * requests to Google.
 */
const http = require('http');
const https = require('https');

const AUTH_URL = 'https://android.clients.google.com/auth';
const API_URL = 'https://www.googleapis.com/notes/v1/';
const SCOPES = 'oauth2:https://www.googleapis.com/auth/memento https://www.googleapis.com/auth/reminders';
const CLIENT_SIG = '38918a453d07199354f8b19af05ec6562ced5788';
// Google is picky about the TLS handshake on the auth endpoint (see gpsoauth), so the cipher list is fixed.
const CIPHERS = 'ECDHE+AESGCM:ECDHE+CHACHA20:DHE+AESGCM:DHE+CHACHA20:ECDH+AES:DH+AES:RSA+AESGCM:RSA+AES:!aNULL:!eNULL:!MD5:!DSS';
const SORT_DELTA = 10000;

const stamp = (ms) => new Date(ms).toISOString().replace(/Z$/, '000Z'); // Keep uses microsecond style
const EPOCH = '1970-01-01';
const live = (t) => !!t && !String(t).startsWith(EPOCH);
const genId = () => Math.floor(Date.now()).toString(16) + '.' + [0, 1].map(() => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')).join('');

function authRequest(url, form) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = new URLSearchParams(form).toString();
    const lib = u.protocol === 'http:' ? http : https;
    const opts = {
      host: u.hostname, port: u.port || undefined, path: u.pathname, method: 'POST', timeout: 20000,
      headers: { 'Accept-Encoding': 'identity', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'GoogleAuth/1.4', 'Content-Length': Buffer.byteLength(body) }
    };
    if (u.protocol === 'https:') opts.ciphers = CIPHERS;
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const out = {};
        for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
          const k = line.indexOf('=');
          if (k > 0) out[line.slice(0, k)] = line.slice(k + 1);
        }
        resolve(out);
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('auth timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(body);
  });
}

class Keep {
  constructor(o) {
    this.email = o.email;
    this.masterToken = o.masterToken;
    this.deviceId = o.deviceId || '0123456789abcdef';
    this.authUrl = o.authUrl || AUTH_URL;
    this.apiUrl = o.apiUrl || API_URL;
    this.token = null;
    this.version = null;
    this.nodes = new Map();
    this.session = 's--' + Date.now() + '--' + Math.floor(1e9 + Math.random() * 9e9);
  }

  async refresh() {
    const r = await authRequest(this.authUrl, {
      accountType: 'HOSTED_OR_GOOGLE', Email: this.email, has_permission: 1, EncryptedPasswd: this.masterToken,
      service: SCOPES, source: 'android', androidId: this.deviceId, app: 'com.google.android.keep', client_sig: CLIENT_SIG,
      device_country: 'us', operatorCountry: 'us', lang: 'en', sdk_version: 17, google_play_services_version: 240913000
    });
    if (!r.Auth) throw new Error('Google sign-in refused: ' + (r.Error || 'no token'));
    this.token = r.Auth;
  }

  async call(nodes) {
    const payload = {
      nodes: nodes || [],
      clientTimestamp: stamp(Date.now()),
      requestHeader: {
        clientSessionId: this.session, clientPlatform: 'ANDROID', clientVersion: { major: '9', minor: '9', build: '9', revision: '9' },
        capabilities: ['NC', 'PI', 'LB', 'AN', 'SH', 'DR', 'TR', 'IN', 'SNB', 'MI', 'CO'].map((type) => ({ type }))
      }
    };
    if (this.version !== null) payload.targetVersion = this.version;
    let delay = 2000;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!this.token) await this.refresh();
      const res = await fetch(this.apiUrl + 'changes', {
        method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { Authorization: 'OAuth ' + this.token, 'Content-Type': 'application/json', 'User-Agent': 'x-gkeepapi/0.16.0 (https://github.com/kiwiz/gkeepapi)' },
        body: JSON.stringify(payload)
      });
      const j = await res.json().catch(() => ({}));
      if (!j.error) return j;
      const code = j.error.code || res.status;
      if (code === 401) { this.token = null; continue; }
      if (code === 429) { await new Promise((r) => setTimeout(r, delay)); delay = Math.min(delay * 2, 60000); continue; }
      throw new Error('Keep API error ' + code);
    }
    throw new Error('Keep API kept refusing the request');
  }

  merge(changes) {
    for (const n of changes.nodes || []) {
      if (n.parentId !== undefined) this.nodes.set(n.id, n);
      else this.nodes.delete(n.id);
    }
  }

  // Send nodes (maybe none) and fold in everything the server reports, until it has no more to say.
  async sync(out) {
    let send = out || [];
    for (let i = 0; i < 50; i++) {
      const ch = await this.call(send);
      send = [];
      if (ch.forceFullResync) { this.version = null; this.nodes.clear(); continue; }
      this.merge(ch);
      this.version = ch.toVersion;
      if (!ch.truncated) return;
    }
    throw new Error('Keep sync did not finish');
  }

  findList(title) {
    const want = String(title).trim().toLowerCase();
    const c = [...this.nodes.values()].filter((n) => n.type === 'LIST' && !live(n.timestamps && n.timestamps.trashed) && !live(n.timestamps && n.timestamps.deleted)
      && String(n.title || '').trim().toLowerCase() === want);
    c.sort((a, b) => String((b.timestamps || {}).updated || '').localeCompare(String((a.timestamps || {}).updated || '')));
    return c[0] || null;
  }

  items(list) {
    return [...this.nodes.values()].filter((n) => n.type === 'LIST_ITEM' && n.parentId === list.id && !live(n.timestamps && n.timestamps.deleted));
  }

  // Request bodies in the shape the Keep app sends. Callers pass these to sync().
  newItem(list, text, checked, parent) {
    const now = stamp(Date.now());
    // Indented items sort among their siblings under the same header.
    const peers = this.items(list).filter((n) => (parent ? n.superListItemId === parent.id : !n.superListItemId));
    const sorts = peers.map((n) => parseInt(n.sortValue, 10) || 0);
    const down = (list.nodeSettings && list.nodeSettings.newListItemPlacement) !== 'TOP';
    const sort = sorts.length ? (down ? Math.min(...sorts) - SORT_DELTA : Math.max(...sorts) + SORT_DELTA) : Math.floor(1e9 + Math.random() * 9e9);
    return {
      id: genId(), kind: 'notes#node', type: 'LIST_ITEM', parentId: list.id, sortValue: sort, text,
      timestamps: { kind: 'notes#timestamps', created: now, updated: now, userEdited: now },
      nodeSettings: { newListItemPlacement: 'BOTTOM', graveyardState: 'COLLAPSED', checkedListItemsPolicy: 'GRAVEYARD' },
      annotationsGroup: { kind: 'notes#annotationsGroup' },
      parentServerId: list.serverId, superListItemId: parent ? parent.id : null, checked: !!checked
    };
  }

  editItem(raw, change) {
    const now = stamp(Date.now());
    const ts = raw.timestamps || {};
    const t = { kind: 'notes#timestamps', created: ts.created || now, updated: now, userEdited: now };
    if (ts.trashed) t.trashed = ts.trashed;
    if (change.deleted) t.deleted = now;
    const n = {
      id: raw.id, kind: 'notes#node', type: 'LIST_ITEM', parentId: raw.parentId, sortValue: raw.sortValue,
      text: change.text !== undefined ? change.text : raw.text,
      timestamps: t,
      nodeSettings: raw.nodeSettings || { newListItemPlacement: 'BOTTOM', graveyardState: 'COLLAPSED', checkedListItemsPolicy: 'GRAVEYARD' },
      annotationsGroup: { kind: 'notes#annotationsGroup' },
      parentServerId: raw.parentServerId, superListItemId: raw.superListItemId || null,
      checked: change.checked !== undefined ? !!change.checked : !!raw.checked
    };
    if (raw.baseVersion !== undefined) n.baseVersion = raw.baseVersion;
    if (raw.serverId !== undefined) n.serverId = raw.serverId;
    return n;
  }
}

module.exports = { Keep, genId };

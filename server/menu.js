'use strict';
/**
 * School lunch menus for the Kitchen Board. Zero dependencies.
 *
 * Looks at the district's menu page and the schools' own sites (o.pages) for the monthly menu PDFs (the elementary one, by
 * default), reads each new or changed PDF once with Gemini (see gemini.js readMenu), and hands the per-day menu to the
 * server. The PDFs are public files, nothing is signed in to. A menu is remembered by its contents, so the same file
 * linked from three pages, or one that was entered by hand, is not read again: a month costs one Gemini request.
 *
 * It reads a district's web page the way a browser does, so it can break if they rename files or change the page.
 */
const crypto = require('crypto');
const fs = require('fs');

const UA = 'Mozilla/5.0 (compatible; KitchenBoard/1.0; family use)';

// The menu PDFs linked from the page whose file name says "menu" and matches (elementary by default).
function menuLinks(html, page, match) {
  const want = new RegExp(match || 'elementary', 'i');
  const out = [];
  for (const m of String(html).matchAll(/href="([^"]+\.pdf[^"]*)"/gi)) {
    const href = m[1].replace(/&amp;/g, '&');
    let file = href.split('?')[0].split('/').pop();
    try { file = decodeURIComponent(file); } catch (e) { /* keep as is */ }
    if (!/menu/i.test(file) || !want.test(file)) continue;
    let url;
    try { url = new URL(href, page).toString(); } catch (e) { continue; }
    if (out.indexOf(url) < 0) out.push(url);
  }
  return out;
}

function create(o) {
  const log = o.log || (() => {});
  let cache = {};
  try { const j = JSON.parse(fs.readFileSync(o.file, 'utf8')); if (j && typeof j === 'object') cache = j; } catch (e) { /* first run */ }
  const save = () => { try { fs.writeFileSync(o.file + '.tmp', JSON.stringify(cache)); fs.renameSync(o.file + '.tmp', o.file); } catch (e) { log('Could not save the menu cache: ' + e.message, true); } };

  async function get(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(25000), headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res;
  }

  const byHash = (hash) => { const k = Object.keys(cache).find((u) => cache[u] && cache[u].hash === hash && cache[u].parsed); return k ? cache[k].parsed : null; };

  // One look at the pages. Calls o.onData({days, everyday}) when at least one menu is known, otherwise leaves things alone.
  async function poll() {
    const links = [];
    let pagesOk = 0, lastErr = '';
    for (const page of (o.pages || [o.page])) {
      try {
        const found = menuLinks(await (await get(page)).text(), page, o.match);
        pagesOk += 1;
        for (const u of found) if (links.indexOf(u) < 0) links.push(u);
      } catch (e) { lastErr = e.name === 'TimeoutError' ? 'timeout' : e.message; log('Menu page not read: ' + lastErr, true); }
    }
    if (!pagesOk) throw new Error('no menu page could be read (' + lastErr + ')');
    const days = new Map();
    let everyday = null, read = 0, stopReading = false; // stopReading: Gemini's limit was hit, so no more requests this time
    for (const url of links) {
      let buf;
      try { buf = Buffer.from(await (await get(url)).arrayBuffer()); } catch (e) { log('Lunch menu file not fetched: ' + (e.name === 'TimeoutError' ? 'timeout' : e.message), true); continue; }
      const hash = crypto.createHash('sha1').update(buf).digest('hex');
      let parsed = byHash(hash);
      if (parsed && !(cache[url] && cache[url].hash === hash)) { cache[url] = { hash, parsed }; save(); }
      if (!parsed) {
        if (stopReading) {
          parsed = cache[url] ? cache[url].parsed : null;
          if (!parsed) continue;
        } else {
          try {
            parsed = await o.gem.readMenu(buf);
            cache[url] = { hash, parsed };
            save();
            read += 1;
          } catch (e) {
            log('Lunch menu not read: ' + e.message, true);
            if (e.quota) stopReading = true;
            parsed = cache[url] ? cache[url].parsed : null; // keep the last good reading of a menu that changed but could not be re-read
            if (!parsed) continue;
          }
        }
      }
      for (const d of parsed.days) days.set(d.date, d);
      if (parsed.everyday && (parsed.everyday.lunch.length || parsed.everyday.breakfast.length)) everyday = parsed.everyday;
    }
    if (days.size && o.onData) o.onData({ days, everyday });
    return { links: links.length, days: days.size, read };
  }

  return { poll };
}

module.exports = { create, menuLinks };

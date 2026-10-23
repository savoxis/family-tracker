'use strict';
/**
 * Two-way merge between the board's grocery list and a Google Keep list. Zero dependencies.
 *
 * How the Keep list is used: category headers (Produce, Dairy, ...) stay unchecked, items sit
 * indented under a header, an item is checked when it is bought and unchecked to put it back on
 * the list. So the board shows only unchecked items, and:
 *   - an item added on the board first looks for an existing item with the same name and unchecks
 *     it, and only creates a new one (under the category that name already lives in, else "Other");
 *   - checking an item on either side checks it on the other;
 *   - Keep history is never deleted from the board side: removing an item on the board checks it.
 * An item deleted in Keep is removed from the board.
 */
const crypto = require('crypto');
const fs = require('fs');

const EMOJI = /[\u{1F000}-\u{1FFFF}\u{2190}-\u{2BFF}\u{FE0F}\u{200D}]/gu;
const norm = (s) => String(s || '').normalize('NFKC').replace(EMOJI, '').replace(/\s+/g, ' ').trim().toLowerCase();
const clip = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function analyze(items, headerNames) {
  const kids = new Map();
  for (const n of items) {
    if (n.superListItemId) kids.set(n.superListItemId, (kids.get(n.superListItemId) || 0) + 1);
  }
  const names = new Set((headerNames || []).map(norm));
  const isHeader = (n) => !n.superListItemId && (kids.has(n.id) || names.has(norm(n.text)));
  return { isHeader };
}

const words = (s) => norm(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2).map((w) => w.replace(/(ies)$/, 'y').replace(/(es|s)$/, ''));

// The category an item name belongs under: the active header that holds the most items sharing
// its words (the last word counts double, it is usually the noun). Falls back to "Other".
function categorize(items, byId, isHeader, title) {
  const ws = words(title);
  const head = ws[ws.length - 1];
  const votes = new Map();
  for (const n of items) {
    if (isHeader(n) || !n.superListItemId) continue;
    const p = byId.get(n.superListItemId);
    if (!p || p.checked || !isHeader(p)) continue;
    const nw = words(n.text);
    let score = 0;
    for (const w of ws) if (nw.includes(w)) score += w === head ? 2 : 1;
    if (score) votes.set(p.id, (votes.get(p.id) || 0) + score);
  }
  let best = null;
  for (const [id, c] of votes) if (!best || c > best[1]) best = [id, c];
  if (best) return byId.get(best[0]);
  return items.find((n) => isHeader(n) && !n.checked && norm(n.text) === 'other') || null;
}

function plan(o) {
  const board = o.board, items = o.items, pairs = o.pairs || {};
  const byId = new Map(items.map((n) => [n.id, n]));
  const { isHeader } = analyze(items, o.headerNames);
  const out = { boardSet: [], boardAdd: [], boardDel: [], keepEdit: [], keepAdd: [], pairs: {} };
  const used = new Set();
  const paired = new Set();

  for (const [bid, p] of Object.entries(pairs)) {
    const b = board.get(bid), k = byId.get(p.k);
    if (!b && !k) continue;
    if (!k) { out.boardDel.push(bid); continue; }
    used.add(k.id);
    if (!b) {
      if (!k.checked) out.keepEdit.push({ k: k.id, checked: true });
      continue;
    }
    paired.add(bid);
    const kTitle = clip(k.text), bTitle = clip(b.title);
    const kChanged = kTitle !== p.title || !!k.checked !== p.done;
    const bChanged = bTitle !== p.title || !!b.done !== p.done;
    if (kChanged) {
      if (bTitle !== kTitle || !!b.done !== !!k.checked) out.boardSet.push({ id: bid, title: kTitle, done: !!k.checked });
      out.pairs[bid] = { k: k.id, title: kTitle, done: !!k.checked };
    } else if (bChanged) {
      const e = { k: k.id };
      if (bTitle !== p.title) e.text = bTitle;
      if (!!b.done !== p.done) e.checked = !!b.done;
      out.keepEdit.push(e);
      out.pairs[bid] = { k: k.id, title: bTitle, done: !!b.done };
    } else {
      out.pairs[bid] = p;
    }
  }

  const free = items.filter((n) => !used.has(n.id) && !isHeader(n));
  // Added on the board: reuse an existing Keep item before creating one.
  for (const [bid, b] of board) {
    if (paired.has(bid) || !norm(b.title)) continue;
    const key = norm(b.title), title = clip(b.title), done = !!b.done;
    const same = free.filter((n) => !used.has(n.id) && norm(n.text) === key);
    const active = same.find((n) => !n.checked);
    const old = same.filter((n) => n.checked).sort((a, c) => (c.superListItemId ? 1 : 0) - (a.superListItemId ? 1 : 0) || parseInt(c.sortValue, 10) - parseInt(a.sortValue, 10))[0];
    const hit = active || old;
    if (hit) {
      used.add(hit.id);
      if (!!hit.checked !== done) out.keepEdit.push({ k: hit.id, checked: done });
      out.pairs[bid] = { k: hit.id, title: clip(hit.text), done };
      if (clip(hit.text) !== title) out.boardSet.push({ id: bid, title: clip(hit.text), done });
    } else {
      const parent = categorize(items, byId, isHeader, b.title);
      out.keepAdd.push({ bid, text: title, checked: done, parent: parent ? parent.id : null });
    }
  }
  // Active in Keep, new to the board.
  for (const n of free) {
    if (used.has(n.id) || n.checked) continue;
    const id = o.newBoardId(n.id);
    if (board.has(id)) continue;
    out.boardAdd.push({ id, title: clip(n.text), done: false });
    out.pairs[id] = { k: n.id, title: clip(n.text), done: false };
  }
  return out;
}

function loadPairs(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && j.pairs && typeof j.pairs === 'object' ? j.pairs : {}; } catch (e) { return {}; }
}
function savePairs(file, pairs) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ pairs }));
  fs.renameSync(tmp, file);
}

const boardId = (kid) => 'keep-' + crypto.createHash('sha1').update(kid).digest('hex').slice(0, 12);

function create(o) {
  const log = o.log || (() => {});
  let running = false, again = false, timer = null;

  async function once() {
    await o.keep.sync();
    const list = o.keep.findList(o.listTitle);
    if (!list) throw new Error('list "' + o.listTitle + '" not found in Keep');
    const items = o.keep.items(list);
    const p = plan({ board: o.board(), items, pairs: loadPairs(o.pairsFile), headerNames: o.headerNames, newBoardId: boardId });
    const keepOps = p.keepEdit.length + p.keepAdd.length;
    const boardOps = p.boardSet.length + p.boardAdd.length + p.boardDel.length;
    const total = Object.keys(p.pairs).length;
    if (keepOps > 40 || p.boardDel.length > 15 || (p.boardDel.length >= 5 && p.boardDel.length > total / 2)) {
      throw new Error('refusing a suspiciously large change (' + keepOps + ' Keep writes, ' + p.boardDel.length + ' board deletes)');
    }
    if (o.dryRun) {
      if (keepOps || boardOps) log('Keep dry run, would change Keep: ' + p.keepEdit.length + ' edits, ' + p.keepAdd.length + ' new; board: ' + p.boardAdd.length + ' new, ' + p.boardSet.length + ' updated, ' + p.boardDel.length + ' removed');
      return p;
    }
    if (boardOps) o.applyBoard(p);
    if (keepOps) {
      const byId = new Map(items.map((n) => [n.id, n]));
      const nodes = p.keepEdit.map((e) => o.keep.editItem(byId.get(e.k), e));
      for (const a of p.keepAdd) {
        const node = o.keep.newItem(list, a.text, a.checked, a.parent ? byId.get(a.parent) : null);
        p.pairs[a.bid] = { k: node.id, title: a.text, done: !!a.checked };
        nodes.push(node);
      }
      await o.keep.sync(nodes);
    }
    savePairs(o.pairsFile, p.pairs);
    if (keepOps || boardOps) log('Keep sync: Keep ' + p.keepEdit.length + ' edits, ' + p.keepAdd.length + ' new; board ' + p.boardAdd.length + ' new, ' + p.boardSet.length + ' updated, ' + p.boardDel.length + ' removed');
    return p;
  }

  async function run() {
    if (running) { again = true; return null; }
    running = true;
    try { return await once(); }
    catch (e) { log('Keep sync failed: ' + e.message, true); return null; }
    finally { running = false; if (again) { again = false; setTimeout(run, 1500).unref(); } }
  }

  function soon(ms) {
    clearTimeout(timer);
    timer = setTimeout(run, ms || 4000);
    timer.unref();
  }

  return { run, soon, once };
}

module.exports = { plan, create, norm, boardId };

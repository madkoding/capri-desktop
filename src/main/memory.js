'use strict';

// Her long-term memory, in plain files you can read, edit or delete: ~/.capri/memory/ (CAPRI_HOME moves it).
//   <category>.jsonl   one entry per line: { id, cat, text, tags, created, updated, hits, pinned }
//   MEMORY.md          the same, as a readable index (rewritten on every change)
// Categories split what she keeps: profile (who you are), preference (how you like things), fact
// (things about your world), project (what you work on), episode (summaries of past chats).
// Recall is local keyword search (BM25 over accent-stripped, prefix-stemmed words), nudged by how
// often a memory was useful and how recent it is. Nothing is sent anywhere to find a memory.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const CATEGORIES = ['profile', 'preference', 'fact', 'project', 'episode'];
const MAX_PER_CATEGORY = 200;
const SAME = 0.7; // word overlap above which two memories are the same one
const WEIGHT = { profile: 1.2, preference: 1.2, project: 1.1, fact: 1, episode: 0.8 };
const STOP = new Set(('the and for you are was with that this have from but not what when how can les des une est pas que qui dans pour avec sur '
  + 'los las una por con del que para como pero esto est mas muy sus mis tus le la el un en de et ou au aux ce ne se sa son ses mon ton '
  + 'um uma dos das nao com mais').split(' '));

const root = () => path.join(process.env.CAPRI_HOME || path.join(os.homedir(), '.capri'));
const dir = () => path.join(root(), 'memory');
const fileOf = (cat) => path.join(dir(), `${cat}.jsonl`);

function words(text) {
  return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.slice(0, 6));
}

function load(cat) {
  try {
    return fs.readFileSync(fileOf(cat), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; } // a hand-edited bad line is skipped
    });
  } catch {
    return [];
  }
}

function write(cat, entries) {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${fileOf(cat)}.tmp`;
  fs.writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
  fs.renameSync(tmp, fileOf(cat)); // atomic: a crash never leaves half a file
  index();
}

const all = () => CATEGORIES.flatMap(load);

function index() {
  const lines = ['# Capri memory', '', 'Plain files: edit or delete any line. `pinned` ones are always on her mind.', ''];
  for (const cat of CATEGORIES) {
    const entries = load(cat);
    if (!entries.length) continue;
    lines.push(`## ${cat}`, ...entries.map((e) => `- ${e.pinned ? '📌 ' : ''}${e.text}${e.tags.length ? ` _(${e.tags.join(', ')})_` : ''}`), '');
  }
  fs.writeFileSync(path.join(dir(), 'MEMORY.md'), lines.join('\n'));
}

function similar(a, b) {
  const x = new Set(words(a));
  const y = new Set(words(b));
  if (!x.size || !y.size) return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= SAME;
}

// Keeps something. The same thing said again updates the old memory instead of piling up.
function add({ text, cat = 'fact', tags = [], pinned = false }) {
  text = String(text || '').trim().slice(0, 500);
  if (!text) return null;
  if (!CATEGORIES.includes(cat)) cat = 'fact';
  tags = [...new Set(tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean))].slice(0, 6);
  const entries = load(cat);
  const now = Date.now();
  const same = entries.find((e) => similar(e.text, text));
  let entry;
  if (same) {
    Object.assign(same, { text, updated: now, tags: [...new Set([...same.tags, ...tags])].slice(0, 6), pinned: same.pinned || pinned });
    entry = same;
  } else {
    entry = { id: randomUUID().slice(0, 8), cat, text, tags, created: now, updated: now, hits: 0, pinned };
    entries.push(entry);
  }
  // too many: the oldest, least useful, unpinned ones go first
  while (entries.length > MAX_PER_CATEGORY) {
    const worst = entries.filter((e) => !e.pinned && e !== entry).sort((a, b) => a.hits - b.hits || a.updated - b.updated)[0];
    if (!worst) break;
    entries.splice(entries.indexOf(worst), 1);
  }
  write(cat, entries);
  return entry;
}

// The memories that bear on `query`, best first, within `budget` characters. Pinned ones come first.
// Recalled ones count a hit, so what keeps being useful stays.
function rank(query) {
  const docs = all();
  if (!docs.length) return [];
  const q = [...new Set(words(query))];
  const tokens = docs.map((e) => words(`${e.text} ${e.tags.join(' ')}`));
  const avg = tokens.reduce((n, t) => n + t.length, 0) / docs.length || 1;
  const df = (w) => tokens.filter((t) => t.includes(w)).length;
  const scored = docs.map((e, i) => {
    let bm = 0;
    for (const w of q) {
      const tf = tokens[i].filter((x) => x === w).length;
      if (!tf) continue;
      const idf = Math.log(1 + (docs.length - df(w) + 0.5) / (df(w) + 0.5));
      bm += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * tokens[i].length) / avg));
    }
    const age = (Date.now() - e.updated) / 864e5;
    return { e, score: bm * (WEIGHT[e.cat] || 1) * (1 + 0.15 * Math.log1p(e.hits)) * (0.5 + 0.5 * Math.exp(-age / 90)) };
  });
  return scored;
}

// The best match for `query`, or null: no hit counted (used to forget a specific thing)
function find(query) {
  return rank(query).filter((s) => s.score > 0).sort((a, b) => b.score - a.score)[0]?.e || null;
}

function recall(query, { limit = 6, budget = 1200 } = {}) {
  const scored = rank(query);
  const picked = [];
  let used = 0;
  const take = (e) => {
    if (picked.length >= limit || used + e.text.length > budget) return;
    picked.push(e);
    used += e.text.length;
  };
  scored.filter((s) => s.e.pinned).forEach((s) => take(s.e));
  scored.filter((s) => !s.e.pinned && s.score > 0).sort((a, b) => b.score - a.score).forEach((s) => take(s.e));
  const byCat = {};
  for (const e of picked) (byCat[e.cat] ||= []).push(e.id);
  for (const [cat, ids] of Object.entries(byCat)) {
    const entries = load(cat);
    entries.forEach((e) => { if (ids.includes(e.id)) e.hits++; });
    write(cat, entries);
  }
  return picked;
}

// Forgets by id, or everything (no argument). Returns how many went.
function forget(id) {
  let n = 0;
  for (const cat of CATEGORIES) {
    const entries = load(cat);
    const kept = id ? entries.filter((e) => e.id !== id) : [];
    n += entries.length - kept.length;
    if (kept.length !== entries.length) write(cat, kept);
  }
  return n;
}

const list = (cat) => (cat ? load(cat) : all());

// What goes into her prompt for this message
function prompt(query, skip = new Set()) {
  const found = recall(query).filter((e) => !skip.has(e.text));
  return found.length
    ? `What you remember about the user (use it only when it fits, never recite it):\n${found.map((e) => `- ${e.text}`).join('\n')}`
    : '';
}

// Turns a model's answer into memories: it was asked for durable facts as a JSON array
// [{ cat, text, tags }]. Whatever isn't valid is dropped.
function ingest(raw) {
  const json = /\[[\s\S]*\]/.exec(String(raw))?.[0];
  let items = [];
  try { items = JSON.parse(json); } catch { return 0; }
  return (Array.isArray(items) ? items : []).slice(0, 8)
    .filter((i) => i && typeof i.text === 'string' && i.text.length > 3)
    .map((i) => add({ cat: i.cat, text: i.text, tags: Array.isArray(i.tags) ? i.tags : [] })).filter(Boolean).length;
}

const EXTRACT = 'From this conversation, list only durable facts worth remembering about the USER (who they are, preferences, '
  + 'projects, decisions). No small talk, nothing about you, nothing already obvious. Answer ONLY a JSON array like '
  + '[{"cat":"profile|preference|fact|project|episode","text":"short sentence","tags":["word"]}], or [] if nothing.';

module.exports = { CATEGORIES, add, recall, find, forget, list, prompt, ingest, EXTRACT, dir, index };

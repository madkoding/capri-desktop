'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.CAPRI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-mem-'));
const memory = require('../src/main/memory');

test('adds, dedups and recalls by keywords (accents ignored)', () => {
  memory.add({ cat: 'profile', text: 'Se llama Mochi y trabaja en Electrón' });
  memory.add({ cat: 'profile', text: 'Se llama Mochi y trabaja en Electron' }); // same thing again
  memory.add({ cat: 'preference', text: 'Prefiere respuestas cortas', tags: ['estilo'] });
  assert.equal(memory.list('profile').length, 1);
  const found = memory.recall('en que trabaja mochi con electron');
  assert.equal(found[0].cat, 'profile');
  assert.ok(found[0].hits >= 0);
  assert.equal(memory.recall('zzz nada').length, 0);
});

test('pinned memories always come back; MEMORY.md is written', () => {
  memory.add({ cat: 'fact', text: 'Never mention the weather', pinned: true });
  assert.ok(memory.recall('unrelated').some((e) => e.pinned));
  assert.match(fs.readFileSync(path.join(memory.dir(), 'MEMORY.md'), 'utf8'), /📌 Never mention the weather/);
});

test('ingest takes a model answer, ignores junk, forget removes', () => {
  assert.equal(memory.ingest('not json'), 0);
  assert.equal(memory.ingest('Sure! [{"cat":"project","text":"Builds a desktop pet called Capri","tags":["capri"]},{"x":1}]'), 1);
  const [entry] = memory.list('project');
  assert.equal(memory.forget(entry.id), 1);
  assert.equal(memory.list('project').length, 0);
  assert.ok(memory.forget() >= 1);
  assert.equal(memory.list().length, 0);
});

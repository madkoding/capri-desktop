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

test('chat can list and forget memories without a model', () => {
  const { answer } = require('../src/main/memory-chat');
  assert.match(answer('¿Qué recuerdas de mí?', 'es'), /Aún no recuerdo/);
  memory.add({ cat: 'preference', text: 'Le gusta el café sin azúcar' });
  assert.match(answer('que recuerdas de mi', 'es'), /café sin azúcar/);
  assert.equal(answer('olvida que le gusta el café', 'es').startsWith('Olvidado'), true);
  assert.equal(memory.list().length, 0);
  assert.equal(answer('hola, ¿cómo estás?', 'es'), null);
});

test('meaning-based recall finds a memory that shares no words with the question', async () => {
  // a toy embedder: "car"/"coche"/"auto" are the same direction, "cat"/"gato" another, plus a little noise per text
  const concepts = [['car', 'coche', 'auto', 'drive', 'conduce'], ['cat', 'gato', 'pet'], ['pizza', 'food'], ['music', 'guitar'], ['code', 'bug'], ['sea', 'beach']];
  const embedder = async (texts) => texts.map((t) => concepts.map((c) => (c.some((w) => t.toLowerCase().includes(w)) ? 1 : 0.05))
    .concat([t.length % 7 / 100]));
  memory.forget();
  ['Has a red coche', 'Owns a gato named Tom', 'Loves pizza', 'Plays guitar', 'Fixes a bug daily', 'Lives near the beach']
    .forEach((text) => memory.add({ cat: 'fact', text }));
  embedder.id = 'toy';
  await memory.embedPending(embedder);
  const other = Object.assign(embedder, { id: 'other' }); // vectors from another model are not mixed in
  assert.equal(await memory.promptWith('which auto do I drive', other), '');
  embedder.id = 'toy';
  const found = await memory.promptWith('which auto do I drive', embedder);
  assert.match(found, /red coche/);
  assert.doesNotMatch(found, /pizza/);
  const words = await memory.promptWith('which auto do I drive', null); // no embedder: words only, finds nothing
  assert.equal(words, '');
  memory.forget();
});

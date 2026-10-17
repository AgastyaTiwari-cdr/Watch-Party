import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOGUE, fuzzySearch, editDistance, normalize } from '../public/search.js';
import { isValidYouTubeId } from '../public/youtube-utils.js';

const top = query => fuzzySearch(query)[0]?.title;

test('catalogue entries are well formed and unique', () => {
  const ids = new Set();
  for (const item of CATALOGUE) {
    assert.equal(isValidYouTubeId(item.id), true, `${item.title} has a valid video id`);
    assert.equal(ids.has(item.id), false, `${item.title} is not duplicated`);
    ids.add(item.id);
    assert.ok(item.title && item.creator && item.category);
  }
});

test('empty query returns the whole catalogue in order', () => {
  assert.deepEqual(fuzzySearch('   '), CATALOGUE);
});

test('exact and partial titles rank first', () => {
  assert.equal(top('sintel'), 'Sintel');
  assert.equal(top('big buck'), 'Big Buck Bunny');
  assert.equal(top('tears'), 'Tears of Steel');
});

test('typos, transpositions and missing letters still find the movie', () => {
  assert.equal(top('sintle'), 'Sintel');
  assert.equal(top('big buk bunny'), 'Big Buck Bunny');
  assert.equal(top('elefants dream'), 'Elephants Dream');
  assert.equal(top('cosmos laundrmat'), 'Cosmos Laundromat');
  assert.equal(top('caminades'), 'Caminandes: Llamigos');
});

test('category, creator and tag words are searchable', () => {
  assert.ok(fuzzySearch('music').every(i => i.category === 'Music' || /music/.test(i.tags)));
  assert.ok(fuzzySearch('lofi').some(i => i.title.includes('lofi')));
  assert.ok(fuzzySearch('dragon').some(i => i.title === 'Sintel'));
  assert.ok(fuzzySearch('blender').length >= 8);
});

test('every query word must match (AND semantics) and nonsense returns nothing', () => {
  assert.equal(fuzzySearch('sintel bunny').length, 0);
  assert.equal(fuzzySearch('zzzzqqqq').length, 0);
});

test('helpers behave', () => {
  assert.equal(normalize('  Café — Déjà Vu!! '), 'cafe deja vu');
  assert.equal(editDistance('abc', 'acb'), 1);
  assert.equal(editDistance('kitten', 'sitting', 5), 3);
  assert.ok(editDistance('short', 'muchlongerword', 2) > 2);
});

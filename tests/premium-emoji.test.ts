import { test } from 'node:test';
import assert from 'node:assert/strict';
const { buildPremiumEmojiEntities } = require('../src/bot/premium-emoji');

test('maps known emoji with UTF-16 offsets', () => {
  const text = '💎 TON balance';
  const entities = buildPremiumEmojiEntities(text);
  assert.equal(entities.length, 1);
  assert.equal(entities[0].type, 'custom_emoji');
  assert.equal(entities[0].offset, 0);
  assert.equal(entities[0].length, 2); // surrogate pair
  assert.equal(entities[0].custom_emoji_id, '5384426402495893753');
});

test('no mapped emoji → empty (backward compatible)', () => {
  assert.deepEqual(buildPremiumEmojiEntities('hello world 👛'), []);
});

test('multiple emoji sorted and non-overlapping', () => {
  const entities = buildPremiumEmojiEntities('🎉 done ✅');
  assert.equal(entities.length, 2);
  assert.ok(entities[0].offset < entities[1].offset);
});

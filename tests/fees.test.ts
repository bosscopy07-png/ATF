import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.FEE_PLATFORM_BASE = 'input';
process.env.FEE_TON_TO_TOKEN_PERCENT = '2';
process.env.FEE_TOKEN_TO_TON_INPUT_PERCENT = '2';
process.env.FEE_TOKEN_TO_TON_OUTPUT_PERCENT = '1';
process.env.FEE_TOKEN_TO_TOKEN_PERCENT = '2';
process.env.FEE_RELAY_TRANSFER_PERCENT = '2';

const { FeeEngine } = require('../src/config/fees');

test('platform fee rounds down — never overcharges', () => {
  // 2% of 999 = 19.98 → 19
  const fee = FeeEngine.percentOf(999n, 2);
  assert.equal(fee, 19n);
});

test('input-fee plan deducts from input only (no double charge)', () => {
  const plan = FeeEngine.planSwapFees('ton_to_token', 1000n, 500n);
  assert.equal(plan.platformFeeInputBase, 20n);
  assert.equal(plan.platformFeeOutputBase, 0n);
  assert.equal(plan.netInputBase, 980n);
  assert.equal(plan.netOutputBase, 500n); // output untouched for ton→token
});

test('token→ton charges 2% input AND 1% TON output independently', () => {
  const plan = FeeEngine.planSwapFees('token_to_ton', 1000n, 1000n);
  assert.equal(plan.platformFeeInputBase, 20n);
  assert.equal(plan.tonOutputFeeBase, 10n);
  assert.equal(plan.netOutputBase, 990n);
});

test('fee never exceeds amount', () => {
  const plan = FeeEngine.planSwapFees('token_to_token', 50n, 10n);
  assert.ok(plan.netInputBase > 0n);
});

test('relay fee: 2% on requested amount', () => {
  const { platformFeeNano, totalDebitNano } = FeeEngine.planRelayFee(1000n);
  assert.equal(platformFeeNano, 20n);
  assert.equal(totalDebitNano, 1020n);
});

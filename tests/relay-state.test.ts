import { test } from 'node:test';
import assert from 'node:assert/strict';

test('relay state machine enum accepts all states', async () => {
  const { TransferOperation } = require('../src/models/TransferOperation');
  const states = ['CREATED','VALIDATED','AWAITING_CONFIRMATION','FUNDING','FUNDED','SENDING','COMPLETED','FAILED','EXPIRED','RECOVERY_REQUIRED'];
  for (const s of states) {
    const doc = new TransferOperation({
      operationId: `op-${s}`,
      idempotencyKey: `k-${s}`,
      userId: '507f1f77bcf86cd799439011',
      relayAddressId: '507f1f77bcf86cd799439012',
      relayAddress: 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c',
      state: s,
      requestedAmountNano: '1000',
      platformFeeNano: '20',
      fundingAmountNano: '1100',
      forwardFeeEstimateNano: '15',
      minReserveNano: '10',
      totalDebitNano: '1100',
      destinationAddress: 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c',
      expiresAt: new Date(Date.now() + 60000),
    });
    const err = doc.validateSync();
    assert.equal(err, undefined, `state ${s} should validate`);
  }
});

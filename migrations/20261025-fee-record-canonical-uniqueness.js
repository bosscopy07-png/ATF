// Canonicalizes platform-fee records before the fixed code rolls out:
//   1. backfills metadata.feeKey on all swap-fee records,
//   2. dedupes to ONE platform-fee record per swap (keep completed > real
//      txHash > oldest), absorbing losers as non-retryable,
//   3. repairs stale swap mirrors (feeStatus/feeTxHash) from the canonical
//      record — a placeholder is NEVER treated as a delivered hash,
//   4. installs the unique partial index enforcing one record per swap.
// Idempotent — safe to re-run.
// Usage: mongosh "<uri>" migrations/20261025-fee-record-canonical-uniqueness.js

const FEE_PENDING = /^fee-pending-/;

// 1) Backfill feeKey -------------------------------------------------------
db.transactions.updateMany(
  { type: 'fee', 'metadata.feeKind': 'swap_platform_fee', 'metadata.feeKey': { $exists: false } },
  [{ $set: { 'metadata.feeKey': { $concat: ['$metadata.swapTxId', ':platform'] } } }]
);
db.transactions.updateMany(
  { type: 'fee', 'metadata.feeKind': 'swap_ton_output_fee', 'metadata.feeKey': { $exists: false } },
  [{ $set: { 'metadata.feeKey': { $concat: ['$metadata.swapTxId', ':ton_output'] } } }]
);

// 2) Dedupe platform-fee records per swap ----------------------------------
const seenSwaps = new Set();
db.transactions.find({ type: 'fee', 'metadata.feeKind': 'swap_platform_fee' })
  .forEach((rec) => {
    const swapTxId = rec.metadata && rec.metadata.swapTxId;
    if (!swapTxId || seenSwaps.has(swapTxId)) return;
    seenSwaps.add(swapTxId);

    const group = db.transactions.find({
      type: 'fee',
      'metadata.feeKind': 'swap_platform_fee',
      'metadata.swapTxId': swapTxId,
    }).toArray();
    if (group.length <= 1) return;

    const rank = (d) =>
      (d.status === 'completed' ? 2 : 0) +
      (!FEE_PENDING.test(d.txHash || '') ? 1 : 0);
    const best = group.sort((a, b) =>
      rank(b) - rank(a) || (a.createdAt - b.createdAt))[0];

    for (const loser of group) {
      if (loser._id.equals(best._id)) continue;
      db.transactions.updateOne({ _id: loser._id }, {
        $set: {
          status: 'failed',
          'metadata.absorbedDuplicate': true,
          'metadata.feeOutcome': 'uncertain',
          'metadata.error': 'absorbed by canonical fee record ' + best._id.toString(),
        },
      });
    }
    // Repoint any swap that referenced a loser.
    db.transactions.updateMany(
      {
        'metadata.feeTxId': {
          $in: group.filter((g) => !g._id.equals(best._id)).map((g) => g._id),
        },
      },
      { $set: { 'metadata.feeTxId': best._id } }
    );
    print(`deduped swap ${swapTxId}: kept ${best._id}, absorbed ${group.length - 1}`);
  });

// 3) Repair stale swap mirrors from the canonical records ------------------
db.transactions.find({ type: 'fee', 'metadata.feeKind': 'swap_platform_fee', status: 'completed' })
  .forEach((fee) => {
    if (FEE_PENDING.test(fee.txHash || '')) {
      // A completed record must never carry the placeholder as its hash.
      db.transactions.updateOne(
        { _id: fee._id, txHash: FEE_PENDING },
        { $set: { txHash: 'unknown-' + fee._id.toString() } }
      );
      return;
    }
    const res = db.transactions.updateOne(
      { _id: fee.metadata.swapTxId, feeStatus: { $ne: 'completed' } },
      { $set: { feeStatus: 'completed', feeTxHash: fee.txHash } }
    );
    if (res.modifiedCount > 0) print(`repaired stale mirror for swap ${fee.metadata.swapTxId}`);
  });
// feeTxHash holding a placeholder is not a real hash — clear it.
db.transactions.updateMany(
  { feeTxHash: FEE_PENDING },
  { $unset: { feeTxHash: '' } }
);

// 4) Unique index — one canonical fee record per swap+feeKind --------------
db.transactions.createIndex(
  { 'metadata.feeKey': 1 },
  {
    unique: true,
    name: 'uniq_fee_record_per_swap',
    partialFilterExpression: { 'metadata.feeKey': { $type: 'string' } },
  }
);
print('unique index uniq_fee_record_per_swap created');

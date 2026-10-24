
(async () => {
  const mongoose = require('mongoose');

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is missing');
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const { Transaction } = require('./dist/models/Transaction');

    // Step 1: Inspect the specified transaction.
    const targetId = '6adce9161cd2342f5c4a106b';

    const target = await Transaction.findById(targetId)
      .select([
        'status',
        'feeStatus',
        'createdAt',
        'metadata.walletAddress',
        'metadata.swapOutcome',
        'metadata.actualOutputBaseUnits',
        'metadata.tonBalanceBeforeGasAdvance',
        'metadata.preSwapTonBalanceNano',
        'metadata.gasAdvanceAmountNano',
        'metadata.gasRecoveryWalletAddress',
      ].join(' '))
      .lean();

    console.log('\n--- TARGET TRANSACTION ---');
    console.log(target || `Transaction not found: ${targetId}`);

    // Step 2: Find swaps older than 24 hours.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const filter = {
      type: 'swap',
      status: { $in: ['pending', 'processing'] },
      createdAt: { $lt: cutoff },
    };

    const staleSwaps = await Transaction.find(filter)
      .select('_id status createdAt feeStatus metadata.swapOutcome')
      .sort({ createdAt: 1 })
      .lean();

    console.log('\n--- STALE SWAPS MATCHING FILTER ---');
    console.log('Cutoff:', cutoff.toISOString());
    console.log('Matching swaps:', staleSwaps.length);

    for (const swap of staleSwaps) {
      console.log({
        id: String(swap._id),
        status: swap.status,
        createdAt: swap.createdAt,
        feeStatus: swap.feeStatus,
        swapOutcome: swap.metadata?.swapOutcome,
      });
    }

    if (staleSwaps.length === 0) {
      console.log('No stale swaps to update.');
      return;
    }

    // Step 3: Mark matching swaps failed.
    const result = await Transaction.updateMany(
      filter,
      {
        $set: {
          status: 'failed',
          'metadata.swapOutcome': 'failed',
          'metadata.error': 'stale pre-fix swap, manually failed',
        },
      }
    );

    console.log('\n--- UPDATE RESULT ---');
    console.log('Matched:', result.matchedCount);
    console.log('Modified:', result.modifiedCount);
    console.log('Cleanup complete.');
  } finally {
    await mongoose.disconnect();
  }
})().catch(error => {
  console.error('Stale swap cleanup failed:', error);
  process.exitCode = 1;
});
    

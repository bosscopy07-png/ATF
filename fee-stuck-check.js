
(async () => {
  const mongoose = require('mongoose');

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is missing');
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const { Transaction } = require('./dist/models/Transaction');

    const fees = await Transaction.find({
      type: 'fee',
      'metadata.feeKind': 'swap_platform_fee',
    })
      .select([
        'status',
        'txHash',
        'metadata.feeOutcome',
        'metadata.attempts',
        'metadata.nextRetryAt',
        'metadata.error',
        'updatedAt',
      ].join(' '))
      .sort({ updatedAt: -1 })
      .limit(10)
      .lean();

    console.log('\n--- LATEST 10 SWAP PLATFORM FEE RECORDS ---');
    console.log('Records found:', fees.length);

    for (const fee of fees) {
      console.log({
        id: String(fee._id),
        status: fee.status,
        txHash: fee.txHash || 'NONE',
        feeOutcome: fee.metadata?.feeOutcome ?? 'NONE',
        attempts: fee.metadata?.attempts ?? 0,
        nextRetryAt: fee.metadata?.nextRetryAt ?? null,
        error: fee.metadata?.error ?? null,
        updatedAt: fee.updatedAt ?? null,
      });
    }
  } finally {
    await mongoose.disconnect();
  }
})().catch(error => {
  console.error('Fee status check failed:', error);
  process.exitCode = 1;
});

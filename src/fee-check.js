
(async () => {
  const mongoose = require('mongoose');

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is missing');
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const { Transaction } = require('./dist/models/Transaction');

    const swaps = await Transaction.find({ type: 'swap' })
      .sort({ createdAt: -1 })
      .limit(3)
      .lean();

    console.log('\n--- LATEST 3 SWAPS ---');

    for (const s of swaps) {
      console.log(
        String(s._id),
        'status=' + s.status,
        'fee=' + s.fee,
        'feeStatus=' + s.feeStatus,
        'feeTxId=' + ((s.metadata || {}).feeTxId || 'NONE')
      );
    }

    const fees = await Transaction.find({ type: 'fee' })
      .sort({ createdAt: -1 })
      .limit(3)
      .lean();

    console.log('\n--- LATEST 3 FEE TRANSACTIONS ---');

    for (const f of fees) {
      console.log(
        'FEE:',
        String(f._id),
        'status=' + f.status,
        'amount=' + f.amount,
        'txHash=' + (f.txHash || 'NONE')
      );
    }
  } finally {
    await mongoose.disconnect();
  }
})().catch(error => {
  console.error('Fee check failed:', error);
  process.exitCode = 1;
});

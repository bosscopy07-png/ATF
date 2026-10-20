
(async () => {
  const mongoose = require('mongoose');

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is missing');
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const { Transaction } = require('./dist/models/Transaction');

    const cutoff = new Date(Date.now() - 30 * 60 * 1000);

    const filter = {
      type: 'swap',
      status: { $in: ['pending', 'processing'] },
      createdAt: { $lt: cutoff },
    };

    const stuck = await Transaction.find(filter).lean();

    console.log('Stranded swaps found:', stuck.length);

    for (const s of stuck) {
      console.log(
        String(s._id),
        'status=' + s.status,
        'fee=' + s.fee,
        'feeStatus=' + s.feeStatus,
        'created=' + (s.createdAt?.toISOString?.() || 'UNKNOWN')
      );
    }

    if (stuck.length === 0) {
      console.log('No stranded swaps found. Nothing changed.');
      return;
    }

    console.log(
      '\nWARNING: This will change the status of these swaps to pending.'
    );
    console.log(
      'Only proceed if the swap reconciliation logic safely verifies existing on-chain execution and fee state.'
    );

    const res = await Transaction.updateMany(
      filter,
      { $set: { status: 'pending' } }
    );

    console.log('Requeued to pending:', res.modifiedCount);
  } finally {
    await mongoose.disconnect();
  }
})().catch(error => {
  console.error('Requeue script failed:', error);
  process.exitCode = 1;
});

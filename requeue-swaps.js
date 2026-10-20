
(async () => {
  const mongoose = require('mongoose');

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is missing');
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
        'created=' + s.createdAt?.toISOString()
      );
    }

    const result = await Transaction.updateMany(
      filter,
      { $set: { status: 'pending' } }
    );

    console.log('Requeued to pending:', result.modifiedCount);
    console.log('Sweep completed.');
  } finally {
    await mongoose.disconnect();
  }
})().catch(error => {
  console.error('Sweep failed:', error);
  process.exitCode = 1;
});
  

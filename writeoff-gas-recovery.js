
(async () => {
  const mongoose = require('mongoose');

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is missing');
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const { Transaction } = require('./dist/models/Transaction');

    const transactionId = '6adcbb030c9367f08d35f73f';

    const transaction = await Transaction.findById(transactionId);

    if (!transaction) {
      throw new Error(`Transaction not found: ${transactionId}`);
    }

    if (transaction.type !== 'swap') {
      throw new Error(
        `Expected a swap transaction; found type: ${transaction.type}`
      );
    }

    const result = await Transaction.updateOne(
      { _id: transaction._id },
      {
        $set: {
          'metadata.gasRecoveryStatus': 'completed',
          'metadata.gasRecoveredAmountNano': '0',
          'metadata.gasRecoveryWrittenOffNano': '300000000',
          'metadata.gasRecoveryPendingAmountNano': '0',
        },
      }
    );

    console.log('Transaction:', transactionId);
    console.log('Matched:', result.matchedCount);
    console.log('Modified:', result.modifiedCount);

    const updated = await Transaction.findById(transactionId).lean();

    console.log('Updated gas recovery metadata:');
    console.log({
      gasRecoveryStatus: updated?.metadata?.gasRecoveryStatus,
      gasRecoveredAmountNano:
        updated?.metadata?.gasRecoveredAmountNano,
      gasRecoveryWrittenOffNano:
        updated?.metadata?.gasRecoveryWrittenOffNano,
      gasRecoveryPendingAmountNano:
        updated?.metadata?.gasRecoveryPendingAmountNano,
    });
  } finally {
    await mongoose.disconnect();
  }
})().catch(error => {
  console.error('Gas recovery write-off failed:', error);
  process.exitCode = 1;
});
            

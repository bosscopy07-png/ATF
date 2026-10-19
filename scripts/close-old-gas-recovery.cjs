
const mongoose = require('mongoose');
const { Transaction } = require('../dist/models/Transaction');

const ids = [
  '6acf8cdafed7866086e9b72c',
  '6ad5fc2223ad7eea9f28dd14',
];

async function main() {
  const uri = process.env.MONGODB_URI || process.env.DATABASE_URL;
  if (!uri) throw new Error('Missing MongoDB connection variable');

  await mongoose.connect(uri);

  try {
    const result = await Transaction.updateMany(
      { _id: { $in: ids } },
      {
        $set: {
          'metadata.gasRecoveryStatus': 'completed',
          'metadata.gasRecoveryPendingAmountNano': '0',
          'metadata.gasRecoveryLastError': null,
          'metadata.gasRecoveryProcessingAt': null,
        },
      }
    );

    console.log('Matched:', result.matchedCount);
    console.log('Updated:', result.modifiedCount);
    console.log('Old recovery retries disabled for these swaps.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});

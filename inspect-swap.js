
const mongoose = require('mongoose');
const { Transaction } = require('./dist/models/Transaction');

const SWAP_ID = '6ade444e6b21f9b783cb6053';

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not configured.');
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const swap = await Transaction.findOne(
      {
        _id: SWAP_ID,
        type: 'swap',
      },
      {
        status: 1,
        amount: 1,
        asset: 1,
        fee: 1,
        feeStatus: 1,
        'metadata.swapDirection': 1,
        'metadata.actualOutputBaseUnits': 1,
        'metadata.preSwapTonBalanceNano': 1,
        'metadata.swapValueNano': 1,
        'metadata.gasAdvanceTxId': 1,
        'metadata.gasRecoveryWalletAddress': 1,
        'metadata.gasRecoveryStatus': 1,
        'metadata.rolledBack': 1,
      }
    ).lean();

    if (!swap) {
      console.log(`Swap ${SWAP_ID} not found.`);
      return;
    }

    console.log(JSON.stringify(swap, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  console.error('Inspection failed:', error);
  process.exitCode = 1;
});

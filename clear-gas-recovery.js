
const mongoose = require('mongoose');
const { Transaction } = require('./dist/models/Transaction');

const SWAP_ID = '6adce9161cd2342f5c4a106b';
const WRITTEN_OFF_NANO = '300000000';

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is missing.');
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB.');

  try {
    const swap = await Transaction.findOne({
      _id: SWAP_ID,
      type: 'swap',
    });

    if (!swap) {
      throw new Error(`Swap ${SWAP_ID} not found.`);
    }

    const metadata = swap.metadata || {};

    console.log('Current gas recovery state:', {
      status: metadata.gasRecoveryStatus,
      recoveredNano: metadata.gasRecoveredAmountNano,
      pendingNano: metadata.gasRecoveryPendingAmountNano,
      writtenOffNano: metadata.gasRecoveryWrittenOffNano,
    });

    metadata.gasRecoveryStatus = 'completed';
    metadata.gasRecoveredAmountNano =
      String(metadata.gasRecoveredAmountNano ?? '0');
    metadata.gasRecoveryWrittenOffNano = WRITTEN_OFF_NANO;
    metadata.gasRecoveryPendingAmountNano = '0';
    metadata.gasRecoveryProcessingAt = null;
    metadata.gasRecoveryLastError =
      'Gas recovery manually closed; remaining 300000000 nanoTON written off.';

    swap.metadata = metadata;
    swap.markModified('metadata');

    await swap.save();

    const verified = await Transaction.findById(SWAP_ID).lean();
    const finalMetadata = verified?.metadata || {};

    console.log('\nGas recovery cleared successfully:');
    console.log({
      swapId: SWAP_ID,
      gasRecoveryStatus: finalMetadata.gasRecoveryStatus,
      gasRecoveredAmountNano:
        finalMetadata.gasRecoveredAmountNano,
      gasRecoveryWrittenOffNano:
        finalMetadata.gasRecoveryWrittenOffNano,
      gasRecoveryPendingAmountNano:
        finalMetadata.gasRecoveryPendingAmountNano,
      mainSwapStatus: verified?.status,
    });
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  console.error('Failed to clear gas recovery:', error);
  process.exitCode = 1;
});

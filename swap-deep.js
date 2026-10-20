
(async () => {
  const mongoose = require('mongoose');

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is missing');
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const { Transaction } = require('./dist/models/Transaction');

    const swap = await Transaction.findOne({
      type: 'swap',
      status: 'processing',
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!swap) {
      console.log('No processing swap found.');
      return;
    }

    const m = swap.metadata || {};

    console.log('swap:', String(swap._id));
    console.log('txHash:', swap.txHash);
    console.log('toAddress:', swap.toAddress);
    console.log(
      'direction:', m.swapDirection,
      'ageMin:', Math.round(
        (Date.now() - new Date(swap.createdAt).getTime()) / 60000
      )
    );
    console.log(
      'preSwapAtf:', m.preSwapAtfBalanceNano,
      'preSwapTon:', m.preSwapTonBalanceNano
    );
    console.log(
      'minOutput:', m.minOutputBaseUnits || m.swapMinOutputBaseUnits,
      'swapValue:', m.swapValueNano
    );

    if (!process.env.TON_RPC_URL) {
      console.log('TON_RPC_URL is missing; skipping blockchain scan.');
      return;
    }

    const { TonClient, Address } = require('@ton/ton');

    const client = new TonClient({
      endpoint: process.env.TON_RPC_URL,
      apiKey: process.env.TON_API_KEY,
    });

    try {
      const address = Address.parse(swap.toAddress);
      const txs = await client.getTransactions(address, { limit: 100 });

      const hash = swap.txHash
        ? String(swap.txHash).replace(/^0x/, '').toLowerCase()
        : '';

      const foundTx = txs.find(
        tx => tx.hash().toString('hex').toLowerCase() === hash
      );

      console.log(
        'txHash found at router (last 100):',
        Boolean(foundTx)
      );

      if (foundTx) {
        const description = foundTx.description;

        console.log(
          'bounced:',
          foundTx.inMessage && 'bounced' in foundTx.inMessage
            ? foundTx.inMessage.bounced
            : 'n/a',
          'computeOk:', description?.computePhase?.success,
          'actionOk:', description?.actionPhase?.success
        );
      } else {
        console.log(
          'Transaction not found in the last 100 transactions; this does not prove it failed.'
        );
      }
    } catch (error) {
      console.log('Router scan error:', error.message);
    }
  } finally {
    await mongoose.disconnect();
  }
})().catch(error => {
  console.error('Swap diagnostic failed:', error);
  process.exitCode = 1;
});

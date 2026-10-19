
const mongoose = require("mongoose");

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing in Render environment");
  }

  console.log("Connecting to MongoDB...");
  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const { Transaction } = require("../dist/models/Transaction");
    const collection = Transaction.collection;

    console.log("Connection successful. Starting repair...");

    // STEP 1: Convert boolean attempt counters to 1 or 0.
    const boolFix = await collection.updateMany(
      { "metadata.gasRecoveryAttempted": { $type: "bool" } },
      [{
        $set: {
          "metadata.gasRecoveryAttempted": {
            $cond: [
              { $eq: ["$metadata.gasRecoveryAttempted", true] },
              1,
              0
            ]
          }
        }
      }]
    );

    console.log("STEP 1 - Counters fixed:", boolFix.modifiedCount);

    // STEP 2: Release processing locks older than 10 minutes.
    const cutoff = new Date(Date.now() - 10 * 60 * 1000);

    const lockFix = await collection.updateMany(
      {
        "metadata.gasRecoveryStatus": "processing",
        "metadata.gasRecoveryProcessingAt": { $lt: cutoff }
      },
      {
        $set: {
          "metadata.gasRecoveryStatus": "pending",
          "metadata.gasRecoveryProcessingAt": null
        }
      }
    );

    console.log("STEP 2 - Stale locks released:", lockFix.modifiedCount);

    // STEP 3: Report swaps awaiting recovery.
    const pending = await collection.find(
      {
        "metadata.gasRecoveryStatus": {
          $in: ["pending", "partial", "failed"]
        }
      },
      {
        projection: {
          _id: 1,
          "metadata.gasRecoveryStatus": 1,
          "metadata.gasRecoveryAttempted": 1,
          "metadata.gasRecoveryPendingAmountNano": 1
        }
      }
    ).toArray();

    console.log("STEP 3 - Swaps awaiting recovery:", pending.length);

    for (const item of pending) {
      console.log({
        id: String(item._id),
        status: item.metadata?.gasRecoveryStatus,
        attempts: item.metadata?.gasRecoveryAttempted,
        pendingNano: item.metadata?.gasRecoveryPendingAmountNano ?? "0"
      });
    }

    console.log("Repair script completed.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  console.error("GAS RECOVERY ERROR:", error);
  process.exitCode = 1;
});
          

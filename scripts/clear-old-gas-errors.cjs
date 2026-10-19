
const mongoose = require("mongoose");

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing");
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const { Transaction } = require("../dist/models/Transaction");

    const ids = [
      "8acf8dcade760a08a9c76f2c",
      "8ad5f1-592d-af7eea9f2b014"
    ];

    const objectIds = ids.map(id => {
      if (mongoose.isValidObjectId(id)) {
        return new mongoose.Types.ObjectId(id);
      }
      return id;
    });

    console.log("Starting old gas-recovery error cleanup...");

    const result = await Transaction.collection.updateMany(
      {
        _id: { $in: objectIds },
        "metadata.gasRecoveryStatus": "partial"
      },
      {
        $set: {
          "metadata.gasRecoveryAttempted": 0,
          "metadata.gasRecoveryLastError": null
        }
      }
    );

    console.log("Records matched:", result.matchedCount);
    console.log("Records modified:", result.modifiedCount);
    console.log("Recovery status and pending amounts preserved.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  console.error("CLEANUP FAILED:", error);
  process.exitCode = 1;
});

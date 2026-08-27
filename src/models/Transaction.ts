import mongoose, { Schema, Document } from 'mongoose';

export type TransactionType = 'deposit' | 'withdrawal' | 'swap' | 'fee' | 'fee_transfer';
export type TransactionStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface ITransaction extends Document {
  userId: mongoose.Types.ObjectId;
  type: TransactionType;
  asset: 'TON' | 'ATF';
  amount: string;
  fee?: string;
  feeAsset?: string;
  feePercentage?: number;
  feeWallet?: string;
  feeTxHash?: string;
  feeStatus?: TransactionStatus;
  status: TransactionStatus;
  txHash?: string;
  fromAddress?: string;
  toAddress?: string;
  reconciledAt?: Date;
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const TransactionSchema = new Schema<ITransaction>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['deposit', 'withdrawal', 'swap', 'fee', 'fee_transfer'], required: true },
    asset: { type: String, enum: ['TON', 'ATF'], required: true },
    amount: { type: String, required: true },
    fee: { type: String },
    feeAsset: { type: String },
    feePercentage: { type: Number },
    feeWallet: { type: String },
    feeTxHash: { type: String },
    feeStatus: { type: String, enum: ['pending', 'processing', 'completed', 'failed'] },
    status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
    txHash: { type: String, index: true },
    fromAddress: { type: String },
    toAddress: { type: String },
    reconciledAt: { type: Date },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

TransactionSchema.index({ txHash: 1, type: 1 }, { unique: true, sparse: true });

export const Transaction = mongoose.model<ITransaction>('Transaction', TransactionSchema);
                                      

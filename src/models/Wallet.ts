import mongoose, { Schema, Document } from 'mongoose';

export interface IWallet extends Document {
  userId: mongoose.Types.ObjectId;
  address: string;
  encryptedMnemonic: string;
  iv: string;
  tag: string;
  isImported: boolean;
  createdAt: Date;
}

const WalletSchema = new Schema<IWallet>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    address: { type: String, required: true, unique: true },
    encryptedMnemonic: { type: String, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    isImported: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const Wallet = mongoose.model<IWallet>('Wallet', WalletSchema);

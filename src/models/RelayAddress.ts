import mongoose, { Schema, Document } from 'mongoose';

export type RelayAddressStatus = 'active' | 'retired' | 'hidden' | 'recovery_required';

export interface IRelayAddress extends Document {
  userId: mongoose.Types.ObjectId;
  /** Public TON address (unique across platform). */
  address: string;
  label: string;
  /** Encrypted 24-word mnemonic — AES-256-GCM via existing encryption util. */
  encryptedMnemonic: string;
  iv: string;
  tag: string;
  walletVersion: 'v4r2' | 'v5r1';
  status: RelayAddressStatus;
  /**
   * Ten-day reuse cooldown anchor. Address is not selectable for a NEW
   * transfer until Date.now() >= nextEligibleAt (and safety checks pass).
   * Does NOT erase history or ownership.
   */
  nextEligibleAt?: Date;
  retiredAt?: Date;
  retireReason?: string;
  /** Last known on-chain TON balance (nano), refreshed by reconciler. */
  cachedBalanceNano: string;
  lastActivityAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const RelayAddressSchema = new Schema<IRelayAddress>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    address: { type: String, required: true, unique: true, index: true },
    label: { type: String, required: true },
    encryptedMnemonic: { type: String, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    walletVersion: { type: String, enum: ['v4r2', 'v5r1'], required: true },
    status: { type: String, enum: ['active', 'retired', 'hidden', 'recovery_required'], default: 'active', index: true },
    nextEligibleAt: { type: Date },
    retiredAt: { type: Date },
    retireReason: { type: String },
    cachedBalanceNano: { type: String, default: '0' },
    lastActivityAt: { type: Date },
  },
  { timestamps: true }
);

RelayAddressSchema.index({ userId: 1, status: 1 });

export const RelayAddress = mongoose.model<IRelayAddress>('RelayAddress', RelayAddressSchema);

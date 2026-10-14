import mongoose, { Schema, Document } from 'mongoose';

export type TokenVerification = 'verified' | 'community' | 'suspicious' | 'blacklisted';

export interface ISupportedToken extends Document {
  /** Jetton master address (user-friendly bounceable). Unique. */
  masterAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  verification: TokenVerification;
  imageUrl?: string;
  /** Last price seen from provider (USD string, Decimal-safe). */
  lastPriceUsd?: string;
  priceSource?: string;
  priceUpdatedAt?: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const SupportedTokenSchema = new Schema<ISupportedToken>(
  {
    masterAddress: { type: String, required: true, unique: true, index: true },
    symbol: { type: String, required: true, index: true },
    name: { type: String, required: true },
    decimals: { type: Number, required: true, min: 0, max: 18 },
    verification: {
      type: String,
      enum: ['verified', 'community', 'suspicious', 'blacklisted'],
      default: 'community',
      index: true,
    },
    imageUrl: { type: String },
    lastPriceUsd: { type: String },
    priceSource: { type: String },
    priceUpdatedAt: { type: Date },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

SupportedTokenSchema.index({ symbol: 1, isActive: 1 });
SupportedTokenSchema.index({ name: 1, isActive: 1 });

export const SupportedToken = mongoose.model<ISupportedToken>('SupportedToken', SupportedTokenSchema);

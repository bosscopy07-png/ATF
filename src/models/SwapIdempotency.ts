import mongoose, { Schema, Document } from 'mongoose';

export type SwapIdempotencyStatus = 'processing' | 'completed' | 'failed';

/**
 * Per-swap execution idempotency record.
 *
 * Keyed by `swap:<userId>:<confirmationId>`. A confirmationId is minted once
 * per prepared quote (see SwapConfirmation.confirmationId) and travels with
 * the confirmation through the Telegram session, so N rapid taps of the same
 * CONFIRM button all carry the same confirmationId and therefore the same
 * key — guaranteeing at most one execution per confirmed quote, even across
 * multiple server instances sharing this MongoDB.
 */
export interface ISwapIdempotency extends Document {
  key: string;
  userId: number;
  confirmationId: string;
  status: SwapIdempotencyStatus;
  transactionId?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const SwapIdempotencySchema = new Schema<ISwapIdempotency>(
  {
    key: { type: String, required: true, unique: true },
    userId: { type: Number, required: true, index: true },
    confirmationId: { type: String, required: true },
    status: { type: String, enum: ['processing', 'completed', 'failed'], required: true, default: 'processing' },
    transactionId: { type: String },
    error: { type: String },
  },
  { timestamps: true }
);

export const SwapIdempotency = mongoose.model<ISwapIdempotency>('SwapIdempotency', SwapIdempotencySchema);

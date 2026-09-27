import mongoose, { Schema, Document } from 'mongoose';

/**
 * Fixed-window rate limit counter, backed by MongoDB (no Redis in this
 * project). One document per (operation, subject, window).
 */
export interface IRateLimitHit extends Document {
  key: string;
  count: number;
  expiresAt: Date;
}

const RateLimitHitSchema = new Schema<IRateLimitHit>({
  key: { type: String, required: true, unique: true },
  count: { type: Number, required: true, default: 0 },
  expiresAt: { type: Date, required: true },
});

// Auto-clean expired windows.
RateLimitHitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RateLimitHit = mongoose.model<IRateLimitHit>('RateLimitHit', RateLimitHitSchema);

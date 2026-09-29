import mongoose, { Schema, Document } from 'mongoose';

export interface IPriceCache extends Document {
  asset: string;
  price: number;
  currency: string;
  source: string;
  change24hPercent?: number | null;
  timestamp: Date;
}

const PriceCacheSchema = new Schema<IPriceCache>(
  {
    asset: { type: String, required: true, index: true },
    price: { type: Number, required: true },
    currency: { type: String, required: true },
    source: { type: String, required: true },
    change24hPercent: { type: Number, default: null },
    // 🕐 TTL raised to 1h so the stale-cache fallback actually has something to serve
    timestamp: { type: Date, default: Date.now, expires: 3600 },
  },
  { timestamps: true }
);

export const PriceCache = mongoose.model<IPriceCache>('PriceCache', PriceCacheSchema);

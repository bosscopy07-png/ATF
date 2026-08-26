import mongoose, { Schema, Document } from 'mongoose';

export interface IPriceCache extends Document {
  asset: string;
  price: number;
  currency: string;
  source: string;
  timestamp: Date;
}

const PriceCacheSchema = new Schema<IPriceCache>(
  {
    asset: { type: String, required: true, index: true },
    price: { type: Number, required: true },
    currency: { type: String, required: true },
    source: { type: String, required: true },
    timestamp: { type: Date, default: Date.now, expires: 300 }, // TTL 5 minutes
  },
  { timestamps: true }
);

export const PriceCache = mongoose.model<IPriceCache>('PriceCache', PriceCacheSchema);

import mongoose, { Schema, Document } from 'mongoose';

export interface IReferral extends Document {
  referrerId: number;
  referredId: number;
  createdAt: Date;
}

const ReferralSchema = new Schema<IReferral>(
  {
    referrerId: { type: Number, required: true, index: true },
    referredId: { type: Number, required: true, unique: true },
  },
  { timestamps: true }
);

export const Referral = mongoose.model<IReferral>('Referral', ReferralSchema);

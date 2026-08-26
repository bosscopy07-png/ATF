import mongoose, { Schema, Document } from 'mongoose';

export interface IAdminAction extends Document {
  adminId: number;
  action: string;
  target?: string;
  oldValue?: string;
  newValue?: string;
  result?: string;
  ip?: string;
  createdAt: Date;
}

const AdminActionSchema = new Schema<IAdminAction>(
  {
    adminId: { type: Number, required: true, index: true },
    action: { type: String, required: true },
    target: { type: String },
    oldValue: { type: String },
    newValue: { type: String },
    result: { type: String },
    ip: { type: String },
  },
  { timestamps: true }
);

export const AdminAction = mongoose.model<IAdminAction>('AdminAction', AdminActionSchema);

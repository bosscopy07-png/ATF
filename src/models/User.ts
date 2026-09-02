import mongoose, { Schema, Document } from 'mongoose';

export interface IUser extends Document {
  telegramId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  isFrozen: boolean;
  tonBalance: string;
  atfBalance: string;
  state: string;
  stateData: Record<string, any>;
  lastBotMessageId?: number;
  lastAction?: string; // <-- ADD THIS
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    telegramId: { type: Number, required: true, unique: true, index: true },
    username: { type: String },
    firstName: { type: String },
    lastName: { type: String },
    isAdmin: { type: Boolean, default: false },
    isSuperAdmin: { type: Boolean, default: false },
    isFrozen: { type: Boolean, default: false },
    tonBalance: { type: String, default: '0' },
    atfBalance: { type: String, default: '0' },
    state: { type: String, default: 'idle' },
    stateData: { type: Schema.Types.Mixed, default: {} },
    lastBotMessageId: { type: Number, required: false },
    lastAction: { type: String, default: 'main_menu' }, // <-- ADD THIS
  },
  { timestamps: true }
);

export const User = mongoose.model<IUser>('User', UserSchema);

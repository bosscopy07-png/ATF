import mongoose, { Schema, Document } from 'mongoose';

/**
 * Generic distributed lock, backed by MongoDB.
 *
 * The project has no Redis instance, and MongoDB is already the one
 * datastore shared by every server/worker instance, so it is the correct
 * place for a lock that must work across multiple Render instances.
 *
 * Acquisition is a single atomic `findOneAndUpdate` (see
 * `src/utils/distributed-lock.ts`), so two instances racing for the same
 * key can never both succeed.
 */
export interface ILock extends Document {
  key: string;
  owner: string;
  expiresAt: Date;
  acquiredAt: Date;
}

const LockSchema = new Schema<ILock>({
  key: { type: String, required: true, unique: true },
  owner: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  acquiredAt: { type: Date, required: true },
});

// Belt-and-suspenders background cleanup. Correctness never depends on this —
// acquire() always re-checks expiresAt itself — this just keeps the
// collection tidy for locks whose holder crashed without releasing.
LockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Lock = mongoose.model<ILock>('Lock', LockSchema);

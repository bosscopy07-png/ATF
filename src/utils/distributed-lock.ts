import crypto from 'crypto';
import { Lock } from '../models/Lock';

/**
 * Acquire a short-lived distributed lock keyed by `key`.
 *
 * Implementation notes (why this is safe across multiple instances):
 * - The unique index on `Lock.key` plus a single atomic `findOneAndUpdate`
 *   means only one caller can ever win the race for a given key, regardless
 *   of how many server/worker instances are running.
 * - If a previous holder crashed without releasing, the lock's `expiresAt`
 *   still lets a new caller take it over once it has expired — the filter
 *   only matches "no lock" or "lock already expired".
 * - This is intentionally NOT an in-memory boolean: an in-memory flag only
 *   protects one process, and Render can run several instances of the web
 *   service concurrently.
 *
 * Returns a release() function, or null if the lock is currently held by
 * someone else.
 */
export async function acquireLock(
  key: string,
  ttlMs: number
): Promise<{ release: () => Promise<void> } | null> {
  const owner = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  try {
    await Lock.findOneAndUpdate(
      { key, expiresAt: { $lte: now } },
      { $set: { key, owner, expiresAt, acquiredAt: now } },
      { upsert: true }
    );
  } catch (error: any) {
    // Duplicate key error (E11000) => someone else holds a live lock.
    if (error?.code === 11000) {
      return null;
    }
    throw error;
  }

  // The findOneAndUpdate above can also match+update a *live* lock we don't
  // actually own if the filter matched nothing and upsert raced with a
  // concurrent expiry cleanup. Guard against that by re-reading and
  // confirming ownership before declaring success.
  const current = await Lock.findOne({ key });
  if (!current || current.owner !== owner) {
    return null;
  }

  return {
    release: async () => {
      // Only release the lock if we still own it — never clobber a lock
      // acquired by someone else after our TTL expired.
      await Lock.deleteOne({ key, owner });
    },
  };
}

/**
 * Convenience wrapper: run `fn` while holding the lock, releasing it
 * afterwards no matter what. Throws if the lock could not be acquired.
 */
export async function withLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  onBusy?: () => never
): Promise<T> {
  const lock = await acquireLock(key, ttlMs);
  if (!lock) {
    if (onBusy) onBusy();
    throw new Error('This operation is already in progress. Please wait a moment and try again.');
  }

  try {
    return await fn();
  } finally {
    await lock.release().catch(() => {
      /* best-effort release; TTL will reclaim it either way */
    });
  }
      }

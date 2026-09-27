import { RateLimitHit } from '../models/RateLimitHit';

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

/**
 * Fixed-window rate limiter backed by MongoDB (no Redis in this project).
 *
 * Keyed by `${operation}:${subject}`, e.g. `swap:prepare:<telegramId>` or
 * `swap:execute:<telegramId>`, so different operations never share a budget
 * and normal bot navigation is never throttled by, say, swap execution
 * limits.
 *
 * A single atomic `$inc` means concurrent requests from multiple instances
 * still count correctly against the same window.
 */
export async function checkRateLimit(
  operation: string,
  subject: string | number,
  limit: number,
  windowMs: number
): Promise<void> {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const key = `${operation}:${subject}:${windowStart}`;
  const expiresAt = new Date(windowStart + windowMs);

  const hit = await RateLimitHit.findOneAndUpdate(
    { key },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
    { upsert: true, new: true }
  );

  if (hit.count > limit) {
    throw new RateLimitError('Too many requests. Please slow down and try again in a moment.');
  }
}

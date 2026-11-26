import crypto from 'node:crypto';

export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * Constant-time token comparison using crypto.timingSafeEqual over SHA-256 digests
 * so buffer lengths are always identical (32 bytes) with zero length side-channel.
 */
export function timingSafeTokenEqual(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const hashA = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function createRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
}) {
  const { windowMs, maxRequests } = options;
  const hits = new Map<string, number[]>();

  return {
    check(key: string, nowMs: number = Date.now()): RateLimitDecision {
      const safeKey = key || 'default';
      const cutoff = nowMs - windowMs;
      const existing = (hits.get(safeKey) || []).filter((ts) => ts > cutoff);

      if (existing.length >= maxRequests) {
        const oldest = existing[0];
        const retryAfterMs = Math.max(1000, oldest + windowMs - nowMs);
        hits.set(safeKey, existing);
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        };
      }

      existing.push(nowMs);
      hits.set(safeKey, existing);

      // Periodic bound on keys map to prevent memory growth
      if (hits.size > 1000) {
        for (const [k, timestamps] of hits.entries()) {
          if (timestamps.every((t) => t <= cutoff)) {
            hits.delete(k);
          }
        }
      }

      return {
        allowed: true,
        remaining: Math.max(0, maxRequests - existing.length),
        retryAfterSeconds: 0,
      };
    },
    reset(): void {
      hits.clear();
    },
  };
}

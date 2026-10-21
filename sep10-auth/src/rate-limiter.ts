/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import { RequestHandler } from 'express';

export interface RateLimiterOptions {
  windowMs?: number;
  maxRequests?: number;
  keyGenerator?: (req: import('express').Request) => string;
  store?: RateLimitStore;
  /**
   * Return `true` (or a promise resolving to `true`) to exempt a request from
   * rate limiting, e.g. internal health checkers or trusted partner IPs.
   * Skipped requests never consume tokens.
   */
  skip?: (req: import('express').Request) => boolean | Promise<boolean>;
  /** Send the IETF draft `RateLimit-*` headers on every response. @default true */
  standardHeaders?: boolean;
}

export interface RateLimitDecision {
  allowed: boolean;
  count: number;
  resetAt: number;
}

export interface RateLimitStore {
  consume(
    key: string,
    now: number,
    windowMs: number,
    maxRequests: number,
  ): RateLimitDecision | Promise<RateLimitDecision>;
}

interface RateLimitEntry {
  timestamps: number[];
}

const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const DEFAULT_MAX_REQUESTS = 100;

function defaultKeyGenerator(req: import('express').Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly store = new Map<string, RateLimitEntry>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  consume(
    key: string,
    now: number,
    windowMs: number,
    maxRequests: number,
  ): RateLimitDecision {
    this.ensureSweepTimer(windowMs);

    let entry = this.store.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.store.set(key, entry);
    }

    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

    if (entry.timestamps.length >= maxRequests) {
      return {
        allowed: false,
        count: entry.timestamps.length,
        resetAt: entry.timestamps[0] + windowMs,
      };
    }

    entry.timestamps.push(now);
    return {
      allowed: true,
      count: entry.timestamps.length,
      resetAt: entry.timestamps[0] + windowMs,
    };
  }

  private ensureSweepTimer(windowMs: number): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.store) {
        entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);
        if (entry.timestamps.length === 0) {
          this.store.delete(key);
        }
      }
    }, windowMs);

    if (this.sweepTimer.unref) {
      this.sweepTimer.unref();
    }
  }
}

function validatePositiveInteger(value: number, optionName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `rateLimiter: "${optionName}" must be a positive integer. Received ${value}.`,
    );
  }
}

/**
 * Creates an Express middleware that rate-limits incoming requests.
 *
 * Uses a simple in-memory sliding-window counter keyed by client IP (or a
 * custom key generator). Old entries are pruned lazily when the window
 * expires — no external store (Redis, etc.) is required.
 *
 * When the limit is exceeded the middleware responds with **429**
 * and a JSON body:
 *
 * ```json
 * { "error": "rate_limit_exceeded", "retryAfter": <seconds> }
 * ```
 *
 * Unless `standardHeaders` is `false`, every response also carries the IETF
 * draft `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers.
 *
 * @example
 * ```ts
 * import express from 'express';
 * import { rateLimiter } from 'sep10-auth';
 *
 * const app = express();
 *
 * // 10 requests per 30 seconds
 * app.use('/api/challenge', rateLimiter({ windowMs: 30_000, maxRequests: 10 }));
 * ```
 */
export function rateLimiter(options: RateLimiterOptions = {}): RequestHandler {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const keyFn = options.keyGenerator ?? defaultKeyGenerator;
  validatePositiveInteger(windowMs, 'windowMs');
  validatePositiveInteger(maxRequests, 'maxRequests');
  const standardHeaders = options.standardHeaders ?? true;
  const store = options.store ?? new InMemoryRateLimitStore();

  const skip = options.skip;

  const consume: RequestHandler = (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    Promise.resolve(store.consume(key, now, windowMs, maxRequests))
      .then((decision) => {
        if (standardHeaders) {
          res.set({
            'RateLimit-Limit': String(maxRequests),
            'RateLimit-Remaining': String(Math.max(0, maxRequests - decision.count)),
            'RateLimit-Reset': String(Math.max(0, Math.ceil((decision.resetAt - now) / 1000))),
          });
        }
        if (!decision.allowed) {
          const retryAfter = Math.max(
            1,
            Math.ceil((decision.resetAt - now) / 1000),
          );
          res
            .status(429)
            .set('Retry-After', String(retryAfter))
            .json({ error: 'rate_limit_exceeded', retryAfter });
          return;
        }
        next();
      })
      .catch(next);
  };

  if (!skip) return consume;

  return (req, res, next) => {
    Promise.resolve()
      .then(() => skip(req))
      .then((skipped) => (skipped ? next() : consume(req, res, next)), next);
  };
}

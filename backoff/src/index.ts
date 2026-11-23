/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

export type JitterStrategy = 'half' | 'full' | 'none';

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  jitter?: boolean;
  randomFn?: () => number;
  jitterStrategy?: JitterStrategy;
  jitterMin?: number;
  jitterMax?: number;
}

export interface RetryWithBackoffOptions extends BackoffOptions {
  /** Total attempts before giving up, including the first. Defaults to 3. */
  maxAttempts?: number;
  /**
   * Total elapsed-time budget in milliseconds. Retrying stops when the next
   * delay would push elapsed time past this budget. Defaults to unbounded.
   */
  maxElapsedMs?: number;
  /** Predicate to decide if an error should trigger a retry. Defaults to () => true. */
  shouldRetry?: (err: unknown) => boolean;
  /** Injectable sleep function so callers or tests can avoid real delays. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Optional AbortSignal to cancel pending sleep and abort retries. */
  signal?: AbortSignal;
  /**
   * Invoked before each retry sleep with the 0-based attempt index, the error
   * that triggered the retry, and the computed delay in milliseconds.
   */
  onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
}

export type RetryOptions = RetryWithBackoffOptions;

/**
 * Abort-aware sleep: resolves after `ms`, rejects with an `AbortError`
 * when `signal` aborts, and always clears its timer (no open handles).
 */
export function sleep(ms: number, options: { signal?: AbortSignal } = {}): Promise<void> {
  const { signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? createAbortError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? createAbortError());
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Aborted', 'AbortError');
  }
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

// randomFn is injectable (defaulting to Math.random) so tests can assert an
// exact delay instead of a range, and so callers can disable jitter entirely
// for deterministic timing assertions.
export function computeBackoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  if (!Number.isFinite(attempt) || attempt < 0) {
    throw new RangeError(
      `computeBackoffDelayMs: attempt must be a non-negative finite number, received ${attempt}`,
    );
  }

  const baseMs = options.baseMs ?? 500;
  const maxMs = options.maxMs ?? 30000;
  const jitter = options.jitter ?? true;
  const randomFn = options.randomFn ?? Math.random;

  const uncapped = baseMs * 2 ** attempt;
  const capped = Math.min(maxMs, uncapped);

  if (!jitter || options.jitterStrategy === 'none') {
    return capped;
  }

  const defaultMin = options.jitterStrategy === 'full' ? 0 : 0.5;
  const defaultMax = 1;
  const min = options.jitterMin ?? defaultMin;
  const max = options.jitterMax ?? defaultMax;

  const jitterFactor = min + randomFn() * (max - min);
  return capped * jitterFactor;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(signal.reason ?? new Error('Aborted'));
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error('Aborted'));
        },
        { once: true },
      );
    }
  });

/**
 * Generic retry loop that executes `fn` with exponential backoff on failure.
 *
 * @param fn Async function to execute. Receives the 0-based attempt index.
 * @param options Retry options controlling attempts, backoff, and retry filtering.
 * @returns Result of `fn` upon success.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryWithBackoffOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  if (maxAttempts < 1) {
    throw new RangeError(
      `retryWithBackoff: maxAttempts must be at least 1, received ${maxAttempts}`,
    );
  }

  const maxElapsedMs = options.maxElapsedMs;
  if (maxElapsedMs !== undefined && (!Number.isFinite(maxElapsedMs) || maxElapsedMs < 0)) {
    throw new RangeError(
      `retryWithBackoff: maxElapsedMs must be a non-negative finite number, received ${maxElapsedMs}`,
    );
  }

  const shouldRetry = options.shouldRetry ?? (() => true);
  const sleepFn = options.sleepFn ?? ((ms: number) => defaultSleep(ms, options.signal));

  let elapsedMs = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('Aborted');
    }

    try {
      return await fn(attempt);
    } catch (err) {
      const isLastAttempt = attempt + 1 >= maxAttempts;
      if (isLastAttempt || !shouldRetry(err)) {
        throw err;
      }

      const delay = computeBackoffDelayMs(attempt, options);
      if (maxElapsedMs !== undefined && elapsedMs + delay > maxElapsedMs) {
        throw err;
      }

      options.onRetry?.({ attempt, error: err, delayMs: delay });
      await sleepFn(delay);
      elapsedMs += delay;
    }
  }

  throw new Error(`retryWithBackoff: failed after ${maxAttempts} attempts`);
}

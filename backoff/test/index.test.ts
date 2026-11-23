import { computeBackoffDelayMs, withRetry } from '../src/index';

describe('computeBackoffDelayMs', () => {
  it('grows exponentially with the attempt number when jitter is disabled', () => {
    const delays = [0, 1, 2, 3, 4].map((attempt) =>
      computeBackoffDelayMs(attempt, { jitter: false }),
    );

    expect(delays).toEqual([500, 1000, 2000, 4000, 8000]);
  });

  it('caps the delay at maxMs', () => {
    const delay = computeBackoffDelayMs(10, { jitter: false, maxMs: 30000 });
    expect(delay).toBe(30000);
  });

  it('respects a custom baseMs', () => {
    const delay = computeBackoffDelayMs(2, { jitter: false, baseMs: 100 });
    expect(delay).toBe(400);
  });

  it('is deterministic when a fixed randomFn is injected', () => {
    const delay = computeBackoffDelayMs(1, { randomFn: () => 0.5 });
    // uncapped = 500 * 2^1 = 1000, jitter factor = 0.5 + 0.5*0.5 = 0.75
    expect(delay).toBe(750);
  });

  it('applies jitter within the documented [0.5, 1) range of the capped value', () => {
    const first = computeBackoffDelayMs(3, { randomFn: Math.random });
    const second = computeBackoffDelayMs(3, { randomFn: Math.random });

    const cappedValue = 500 * 2 ** 3;

    for (const delay of [first, second]) {
      expect(delay).toBeGreaterThanOrEqual(cappedValue * 0.5);
      expect(delay).toBeLessThan(cappedValue);
    }
  });

  it('returns baseMs for attempt 0', () => {
    const delay = computeBackoffDelayMs(0, { jitter: false, baseMs: 500 });
    expect(delay).toBe(500);
  });

  it('handles very large attempt numbers gracefully', () => {
    const delay = computeBackoffDelayMs(100, { jitter: false, maxMs: 60000 });
    expect(delay).toBe(60000);
  });

  it('respects maxMs cap even with custom baseMs', () => {
    const delay = computeBackoffDelayMs(5, { jitter: false, baseMs: 1000, maxMs: 5000 });
    expect(delay).toBe(5000);
  });

  it('produces correct delays with minMs option (attempt 1 with base 500)', () => {
    const delay = computeBackoffDelayMs(1, { jitter: false });
    expect(delay).toBe(1000);
  });

  it('minimum jitter bound is exactly 0.5x the capped value', () => {
    const cappedValue = 500 * Math.pow(2, 4);
    const delay = computeBackoffDelayMs(4, { randomFn: () => 0, jitter: true });
    expect(delay).toBe(cappedValue * 0.5);
  });

  it('maximum jitter bound approaches but never reaches 1.0x the capped value', () => {
    const cappedValue = 500 * Math.pow(2, 2);
    const delay = computeBackoffDelayMs(2, { randomFn: () => 0.9999, jitter: true });
    expect(delay).toBeLessThan(cappedValue);
    expect(delay).toBeGreaterThan(cappedValue * 0.9);
  });

  it('jitter disabled flag prevents jitter application', () => {
    const delay1 = computeBackoffDelayMs(3, { randomFn: () => 0.2, jitter: false });
    const delay2 = computeBackoffDelayMs(3, { randomFn: () => 0.8, jitter: false });
    expect(delay1).toBe(delay2);
    expect(delay1).toBe(500 * Math.pow(2, 3));
  });

  it('applies consistent jitter multiplier across different base values', () => {
    const jitterFactor = 0.75;
    const randomFn = () => 0.5;

    const delay1 = computeBackoffDelayMs(2, { randomFn, baseMs: 100 });
    const delay2 = computeBackoffDelayMs(2, { randomFn, baseMs: 200 });

    const expectedDelay1 = 100 * Math.pow(2, 2) * jitterFactor;
    const expectedDelay2 = 200 * Math.pow(2, 2) * jitterFactor;

    expect(delay1).toBe(expectedDelay1);
    expect(delay2).toBe(expectedDelay2);
  });

  it('caps take precedence over jitter calculations', () => {
    const uncappedValue = 500 * Math.pow(2, 10);
    const maxCap = 30000;

    const delay = computeBackoffDelayMs(10, { randomFn: () => 0.9, maxMs: maxCap });
    expect(delay).toBeLessThanOrEqual(maxCap);
    expect(delay).toBeGreaterThanOrEqual(maxCap * 0.5);
  });

  it('returns exactly min(maxMs, baseMs * 2**attempt) when jitter is disabled', () => {
    const testCases = [
      { attempt: 0, baseMs: 500, maxMs: 30000, expected: 500 },
      { attempt: 1, baseMs: 500, maxMs: 30000, expected: 1000 },
      { attempt: 2, baseMs: 500, maxMs: 30000, expected: 2000 },
      { attempt: 5, baseMs: 500, maxMs: 30000, expected: 16000 },
      { attempt: 6, baseMs: 500, maxMs: 30000, expected: 30000 },
      { attempt: 7, baseMs: 500, maxMs: 30000, expected: 30000 },
      { attempt: 3, baseMs: 100, maxMs: 5000, expected: 800 },
      { attempt: 4, baseMs: 100, maxMs: 5000, expected: 1600 },
      { attempt: 5, baseMs: 100, maxMs: 5000, expected: 3200 },
      { attempt: 6, baseMs: 100, maxMs: 5000, expected: 5000 },
    ];

    for (const { attempt, baseMs, maxMs, expected } of testCases) {
      const delay = computeBackoffDelayMs(attempt, { jitter: false, baseMs, maxMs });
      expect(delay).toBe(expected);
    }
  });

  it('never exceeds maxMs at high attempt counts and does not overflow or produce NaN', () => {
    const maxMs = 30000;
    const testAttempts = [10, 20, 50, 100, 1000];

    for (const attempt of testAttempts) {
      const delay = computeBackoffDelayMs(attempt, { jitter: false, maxMs });
      expect(delay).toBe(maxMs);
      expect(Number.isNaN(delay)).toBe(false);
      expect(Number.isFinite(delay)).toBe(true);
    }
  });

  it('throws RangeError for invalid attempt values (NaN, negative, Infinity)', () => {
    expect(() => computeBackoffDelayMs(NaN)).toThrow(RangeError);
    expect(() => computeBackoffDelayMs(-1)).toThrow(RangeError);
    expect(() => computeBackoffDelayMs(Infinity)).toThrow(RangeError);
  });
});

describe('withRetry onRetry hook', () => {
  it('invokes onRetry with attempt, error, and delayMs on each retry', async () => {
    const error = new Error('boom');
    const onRetry = jest.fn();
    const fn = jest.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, {
        retries: 2,
        jitter: false,
        onRetry,
        sleepFn: () => Promise.resolve(),
      }),
    ).rejects.toBe(error);

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, {
      attempt: 0,
      error,
      delayMs: 500,
    });
    expect(onRetry).toHaveBeenNthCalledWith(2, {
      attempt: 1,
      error,
      delayMs: 1000,
    });
  });
});

describe('withRetry maxElapsedMs budget', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stops retrying when the next delay would exceed the total time budget', async () => {
    const error = new Error('boom');
    const fn = jest.fn().mockRejectedValue(error);

    // Delays with jitter disabled: 500, 1000, 2000, 4000...
    // Budget of 1200ms: after attempt 0 (500ms) elapsed=500, next delay 1000
    // would push elapsed to 1500 > 1200, so retrying stops after the first retry.
    const promise = withRetry(fn, {
      retries: 10,
      jitter: false,
      maxElapsedMs: 1200,
    });

    // Attach a rejection handler before advancing timers to avoid unhandled rejections.
    const assertion = expect(promise).rejects.toBe(error);

    await jest.advanceTimersByTimeAsync(500);

    await assertion;

    // First call plus one retry (the 500ms delay fit within the budget).
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry at all when the first delay already exceeds the budget', async () => {
    const error = new Error('boom');
    const fn = jest.fn().mockRejectedValue(error);

    const promise = withRetry(fn, {
      retries: 5,
      jitter: false,
      maxElapsedMs: 100,
    });

    const assertion = expect(promise).rejects.toBe(error);

    await jest.advanceTimersByTimeAsync(0);

    await assertion;

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('still retries up to maxAttempts when the budget is generous', async () => {
    const error = new Error('boom');
    const fn = jest.fn().mockRejectedValue(error);

    const promise = withRetry(fn, {
      retries: 2,
      jitter: false,
      maxElapsedMs: 60000,
    });

    const assertion = expect(promise).rejects.toBe(error);

    // 500 + 1000 = 1500ms of total delay for two retries.
    await jest.advanceTimersByTimeAsync(1500);

    await assertion;

    expect(fn).toHaveBeenCalledTimes(3);
  });
});

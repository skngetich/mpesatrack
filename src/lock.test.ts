import { beforeEach, describe, expect, it } from 'vitest';
import { LOCKOUT_MS, MAX_ATTEMPTS, checkPin, clearPin, hasPin, isValidPin, lockedUntil, setPin } from './lock';

// Minimal in-memory localStorage for the node test environment.
const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
} as Storage;

describe('app lock', () => {
  beforeEach(() => store.clear());

  it('validates 4-digit PINs only', () => {
    expect(isValidPin('0420')).toBe(true);
    expect(isValidPin('123')).toBe(false);
    expect(isValidPin('12345')).toBe(false);
    expect(isValidPin('12a4')).toBe(false);
  });

  it('accepts anything when no PIN is set', async () => {
    expect(hasPin()).toBe(false);
    expect((await checkPin('0000')).ok).toBe(true);
  });

  it('stores a hash, not the PIN, and verifies it', async () => {
    await setPin('2580');
    expect(hasPin()).toBe(true);
    expect([...store.values()].join()).not.toContain('2580');
    expect((await checkPin('2580')).ok).toBe(true);
    expect(await checkPin('1111')).toEqual({ ok: false, attemptsLeft: MAX_ATTEMPTS - 1, lockedUntil: 0 });
  });

  it('locks out after too many wrong PINs, then allows retry', async () => {
    await setPin('2580');
    const now = 1_000_000;
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) await checkPin('0000', now);
    const r = await checkPin('0000', now);
    expect(r).toEqual({ ok: false, attemptsLeft: 0, lockedUntil: now + LOCKOUT_MS });
    // Even the right PIN is refused during the lockout.
    expect((await checkPin('2580', now + 1)).ok).toBe(false);
    expect(lockedUntil(now + 1)).toBe(now + LOCKOUT_MS);
    expect((await checkPin('2580', now + LOCKOUT_MS)).ok).toBe(true);
  });

  it('a correct PIN resets the failure count', async () => {
    await setPin('2580');
    await checkPin('0000');
    await checkPin('2580');
    expect(await checkPin('0000')).toMatchObject({ attemptsLeft: MAX_ATTEMPTS - 1 });
  });

  it('clearPin removes the lock', async () => {
    await setPin('2580');
    clearPin();
    expect(hasPin()).toBe(false);
  });
});

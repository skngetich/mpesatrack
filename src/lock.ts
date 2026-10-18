/**
 * App lock: an optional 4-digit PIN asked for on open and after the app has
 * been in the background for a while.
 *
 * This is a privacy screen, not encryption: the SQLite file in OPFS stays
 * readable to anyone with developer access to the device. The PIN itself is
 * never stored, only a salted PBKDF2 hash, kept in localStorage (not in the
 * database) so backups don't carry it and a restore can't change it.
 */

export const PIN_LENGTH = 4;
/** Re-lock after the app has been hidden this long. */
export const RELOCK_AFTER_MS = 60_000;
/** After this many wrong PINs in a row, make the user wait. */
export const MAX_ATTEMPTS = 5;
export const LOCKOUT_MS = 30_000;

const KEY = 'mpesatrack.pin';
const ITERATIONS = 100_000;

interface Stored {
  salt: string; // hex
  hash: string; // hex
  failures: number;
  /** Epoch ms until which entry is refused (after MAX_ATTEMPTS failures). */
  lockedUntil: number;
}

export type CheckResult = { ok: true } | { ok: false; attemptsLeft: number; lockedUntil: number };

const hex = (b: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

export async function hashPin(pin: string, saltHex: string): Promise<string> {
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  return hex(bits);
}

function read(): Stored | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

function write(s: Stored): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function hasPin(): boolean {
  return read() !== null;
}

export async function setPin(pin: string): Promise<void> {
  if (!isValidPin(pin)) throw new Error(`PIN must be ${PIN_LENGTH} digits.`);
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  write({ salt, hash: await hashPin(pin, salt), failures: 0, lockedUntil: 0 });
}

export function clearPin(): void {
  localStorage.removeItem(KEY);
}

/** Epoch ms until which PIN entry is blocked, or 0. */
export function lockedUntil(now = Date.now()): number {
  const s = read();
  return s && s.lockedUntil > now ? s.lockedUntil : 0;
}

/** Verify a PIN, counting failures and applying the lockout. No PIN set counts as correct. */
export async function checkPin(pin: string, now = Date.now()): Promise<CheckResult> {
  const s = read();
  if (!s) return { ok: true };
  if (s.lockedUntil > now) return { ok: false, attemptsLeft: 0, lockedUntil: s.lockedUntil };
  if ((await hashPin(pin, s.salt)) === s.hash) {
    write({ ...s, failures: 0, lockedUntil: 0 });
    return { ok: true };
  }
  const failures = s.failures + 1;
  if (failures >= MAX_ATTEMPTS) {
    write({ ...s, failures: 0, lockedUntil: now + LOCKOUT_MS });
    return { ok: false, attemptsLeft: 0, lockedUntil: now + LOCKOUT_MS };
  }
  write({ ...s, failures, lockedUntil: 0 });
  return { ok: false, attemptsLeft: MAX_ATTEMPTS - failures, lockedUntil: 0 };
}

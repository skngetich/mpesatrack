import { useEffect, useState } from 'preact/hooks';
import { db } from '../db/client';
import { PIN_LENGTH, checkPin, clearPin, lockedUntil } from '../lock';

interface Props {
  onUnlock: () => void;
  /** Called after "Forgot PIN" erased everything. */
  onWiped: () => void;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];

export function LockScreen({ onUnlock, onWiped }: Props) {
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const [until, setUntil] = useState(() => lockedUntil());
  const [now, setNow] = useState(Date.now());

  // Tick once a second while locked out so the countdown updates and entry re-enables.
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= until) {
        setUntil(0);
        setMsg('');
      }
    }, 1000);
    return () => clearInterval(t);
  }, [until]);

  const blocked = busy || until > now;

  async function submit(full: string) {
    setBusy(true);
    const r = await checkPin(full);
    setBusy(false);
    if (r.ok) return onUnlock();
    setPin('');
    setShake(true);
    setTimeout(() => setShake(false), 400);
    if (r.lockedUntil) {
      setUntil(r.lockedUntil);
      setNow(Date.now());
      setMsg('Too many wrong PINs.');
    } else {
      setMsg(`Wrong PIN. ${r.attemptsLeft} ${r.attemptsLeft === 1 ? 'try' : 'tries'} left.`);
    }
  }

  function press(k: string) {
    if (blocked) return;
    if (k === '⌫') return setPin((p) => p.slice(0, -1));
    if (!/\d/.test(k) || pin.length >= PIN_LENGTH) return;
    const next = pin + k;
    setPin(next);
    if (next.length === PIN_LENGTH) void submit(next);
  }

  // Physical keyboard support (desktop browsers).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('⌫');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function forgot() {
    if (!confirm('Forgot your PIN? The only way back in is to ERASE all data on this device (transactions, categories and rules). You can then re-import your statements or restore a backup. Erase everything?')) return;
    setBusy(true);
    try {
      await db.init();
      await db.wipeAll();
      clearPin();
      onWiped();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const secs = Math.ceil((until - now) / 1000);

  return (
    <main class="lock">
      <h1>MpesaTrack</h1>
      <p class="muted">Enter your PIN</p>
      <div class={`pin-dots${shake ? ' shake' : ''}`} aria-label={`${pin.length} of ${PIN_LENGTH} digits entered`}>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <i key={i} class={i < pin.length ? 'on' : ''} />
        ))}
      </div>
      <p class="lock-msg small warn" role="alert">
        {until > now ? `Too many wrong PINs. Try again in ${secs}s.` : msg}
      </p>
      <div class="keypad">
        {KEYS.map((k, i) =>
          k ? (
            <button key={i} disabled={blocked} aria-label={k === '⌫' ? 'Delete' : k} onClick={() => press(k)}>
              {k}
            </button>
          ) : (
            <span key={i} />
          ),
        )}
      </div>
      <button class="link small forgot" disabled={busy} onClick={() => void forgot()}>
        Forgot PIN?
      </button>
    </main>
  );
}

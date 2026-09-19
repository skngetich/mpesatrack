/** Display helpers. Amounts arrive as integer cents. */

export function kes(cents: number, opts: { sign?: boolean } = {}): string {
  const s = (Math.abs(cents) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = opts.sign ? (cents > 0 ? '+' : cents < 0 ? '-' : '') : cents < 0 ? '-' : '';
  return `${sign}${s}`;
}

/** "2024-03" -> "Mar 2024". */
export function monthLabel(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('en-KE', { month: 'short', year: 'numeric' });
}

/** "2024-03-15 14:22:10" -> "15 Mar, 14:22". */
export function shortDateTime(ts: string): string {
  const [d, t] = ts.split(' ');
  const [y, mo, day] = d.split('-').map(Number);
  const date = new Date(y, mo - 1, day).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
  return `${date}, ${t.slice(0, 5)}`;
}

/** Trigger a browser download of in-memory bytes. */
export function download(name: string, data: BlobPart | Uint8Array, type: string): void {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

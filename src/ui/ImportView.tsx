import { useState } from 'preact/hooks';
import { db } from '../db/client';
import { parseStatement } from '../parser/mpesa';
import { extractTextItems, PasswordError } from '../parser/pdf';
import type { TextItem } from '../parser/mpesa';

interface Report {
  file: string;
  added?: number;
  duplicates?: number;
  categorised?: number;
  warnings: string[];
  error?: string;
  /** Raw extracted text, offered when nothing could be parsed so the layout can be diagnosed. */
  debug?: string;
}

/** First few lines of extracted text, grouped roughly by row, for troubleshooting. */
function debugDump(items: TextItem[]): string {
  return items
    .slice(0, 150)
    .map((i) => `p${i.page} x=${Math.round(i.x)} y=${Math.round(i.y)} w=${Math.round(i.width)}  ${i.str}`)
    .join('\n');
}

export function ImportView({ onImported }: { onImported: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState('');
  const [reports, setReports] = useState<Report[]>([]);
  const [needPassword, setNeedPassword] = useState(false);

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    setReports([]);
    setNeedPassword(false);
    const out: Report[] = [];
    for (const file of Array.from(files)) {
      setBusy(`Reading ${file.name}…`);
      try {
        const buf = await file.arrayBuffer();
        const items = await extractTextItems(buf, password || undefined, (p, n) =>
          setBusy(`Reading ${file.name} (page ${p}/${n})…`),
        );
        const parsed = parseStatement(items);
        if (parsed.transactions.length === 0) {
          out.push({ file: file.name, warnings: parsed.warnings, debug: debugDump(items) });
          continue;
        }
        setBusy(`Saving ${parsed.transactions.length} transactions…`);
        const res = await db.importTransactions(parsed.transactions);
        out.push({ file: file.name, ...res, warnings: parsed.warnings });
      } catch (err) {
        if (err instanceof PasswordError) {
          setNeedPassword(true);
          out.push({ file: file.name, warnings: [], error: err.wrong ? 'Wrong password. Try again.' : 'This statement is password protected. Enter the password above and select the file again.' });
        } else {
          out.push({ file: file.name, warnings: [], error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    setBusy('');
    setReports(out);
    onImported();
  }

  return (
    <section class="stack">
      <h2>Import statement</h2>
      <p class="muted">
        Pick your M-PESA statement PDF. It is read and saved on this device only; nothing is uploaded.
        Importing the same period twice is safe, duplicates are skipped by receipt number.
      </p>

      <label class="field">
        <span>PDF password {needPassword && <b class="warn">(required)</b>}</span>
        <input
          type="password"
          autocomplete="off"
          placeholder="Usually your national ID number"
          value={password}
          onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
        />
      </label>

      <label class="btn primary file-btn">
        {busy || 'Choose PDF statement(s)'}
        <input
          type="file"
          accept="application/pdf,.pdf"
          multiple
          disabled={!!busy}
          onChange={(e) => {
            const input = e.target as HTMLInputElement;
            void handleFiles(input.files).finally(() => (input.value = ''));
          }}
        />
      </label>

      {reports.map((r) => (
        <div class={`card ${r.error ? 'err' : ''}`} key={r.file}>
          <b>{r.file}</b>
          {r.error && <p>{r.error}</p>}
          {r.added !== undefined && (
            <p>
              Added <b>{r.added}</b> transactions ({r.categorised} auto-categorised), skipped {r.duplicates} already
              imported.
            </p>
          )}
          {r.warnings.map((w) => (
            <p class="warn" key={w}>
              {w}
            </p>
          ))}
          {r.debug && (
            <details>
              <summary>Show extracted text (for troubleshooting)</summary>
              <pre>{r.debug}</pre>
            </details>
          )}
        </div>
      ))}
    </section>
  );
}

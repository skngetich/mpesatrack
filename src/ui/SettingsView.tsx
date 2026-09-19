import { useEffect, useState } from 'preact/hooks';
import { db } from '../db/client';
import type { Category, DbInfo, RuleRow } from '../db/types';
import { download } from './format';

interface Props {
  info: DbInfo;
  categories: Category[];
  version: number;
  onChanged: () => void;
}

export function SettingsView({ info, categories, version, onChanged }: Props) {
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [msg, setMsg] = useState('');

  const [catName, setCatName] = useState('');
  const [catColor, setCatColor] = useState('#1a73e8');

  const [kw, setKw] = useState('');
  const [dir, setDir] = useState<'any' | 'in' | 'out'>('out');
  const [ruleCat, setRuleCat] = useState('');

  useEffect(() => {
    void db.listRules().then(setRules);
  }, [version]);

  /** Run an action, report failures inline, refresh everything. */
  async function act(fn: () => Promise<string | void>) {
    try {
      setMsg((await fn()) || '');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
    onChanged();
  }

  return (
    <section class="stack">
      {msg && <p class="note">{msg}</p>}
      {!info.persistent && (
        <p class="note warn">
          Persistent storage is unavailable in this browser, so data will be lost when the app closes. Use Chrome
          (Android) or Safari 16.4+ (iOS), and make a backup below.
        </p>
      )}

      <h2>Rules</h2>
      <p class="muted small">
        A rule puts any transaction whose details contain the keyword into a category. The longest matching keyword
        wins. Manually categorised transactions are never changed by rules.
      </p>
      <form
        class="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          if (!kw.trim() || !ruleCat) return;
          void act(async () => {
            const r = await db.addRule(kw, dir, Number(ruleCat));
            setKw('');
            return `Rule saved; ${r.changed} transactions updated.`;
          });
        }}
      >
        <input placeholder="keyword e.g. naivas" value={kw} onInput={(e) => setKw((e.target as HTMLInputElement).value)} />
        <select value={dir} onChange={(e) => setDir((e.target as HTMLSelectElement).value as typeof dir)}>
          <option value="out">money out</option>
          <option value="in">money in</option>
          <option value="any">either</option>
        </select>
        <select value={ruleCat} onChange={(e) => setRuleCat((e.target as HTMLSelectElement).value)}>
          <option value="">category…</option>
          {categories.map((c) => (
            <option value={c.id} key={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button class="btn primary">Add rule</button>
      </form>
      <ul class="plain">
        {rules.map((r) => (
          <li key={r.id}>
            <span>
              “{r.keyword}” <span class="muted small">({r.direction})</span> → {r.categoryName}
            </span>
            <button class="link" aria-label={`Delete rule ${r.keyword}`} onClick={() => void act(async () => { await db.deleteRule(r.id); })}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      <button class="btn" onClick={() => void act(async () => `Re-applied rules; ${(await db.applyRules()).changed} changed.`)}>
        Re-apply rules to all transactions
      </button>

      <h2>Categories</h2>
      <form
        class="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await db.addCategory(catName, catColor);
            setCatName('');
          });
        }}
      >
        <input placeholder="New category" value={catName} onInput={(e) => setCatName((e.target as HTMLInputElement).value)} />
        <input type="color" value={catColor} onInput={(e) => setCatColor((e.target as HTMLInputElement).value)} aria-label="Colour" />
        <button class="btn primary">Add</button>
      </form>
      <ul class="plain">
        {categories.map((c) => (
          <li key={c.id}>
            <span>
              <i class="dot" style={{ background: c.color }} /> {c.name}
            </span>
            <button
              class="link"
              aria-label={`Delete category ${c.name}`}
              onClick={() =>
                confirm(`Delete "${c.name}"? Its transactions become uncategorised and its rules are removed.`) &&
                void act(async () => { await db.deleteCategory(c.id); })
              }
            >
              ✕
            </button>
          </li>
        ))}
      </ul>

      <h2>Your data</h2>
      <p class="muted small">
        {info.transactionCount} transactions stored {info.persistent ? 'on this device' : 'in memory only'}. Backups are
        standard SQLite files.
      </p>
      <div class="row wrap">
        <button
          class="btn"
          onClick={() =>
            void act(async () => {
              const bytes = await db.exportDb();
              download(`mpesatrack-${new Date().toISOString().slice(0, 10)}.sqlite3`, bytes, 'application/vnd.sqlite3');
              return 'Backup downloaded.';
            })
          }
        >
          Download backup
        </button>
        <label class="btn">
          Restore backup
          <input
            type="file"
            hidden
            accept=".sqlite3,.sqlite,.db"
            onChange={(e) => {
              const input = e.target as HTMLInputElement;
              const file = input.files?.[0];
              if (!file || !confirm('Restoring replaces ALL current data with the backup. Continue?')) return;
              void act(async () => {
                await db.importDb(new Uint8Array(await file.arrayBuffer()));
                return 'Backup restored.';
              }).finally(() => (input.value = ''));
            }}
          />
        </label>
        <button
          class="btn danger"
          onClick={() =>
            confirm('Delete ALL imported transactions? Categories and rules are kept.') &&
            void act(async () => {
              await db.clearTransactions();
              return 'All transactions deleted.';
            })
          }
        >
          Delete all transactions
        </button>
      </div>
    </section>
  );
}

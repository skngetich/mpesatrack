import { useEffect, useState } from 'preact/hooks';
import { db } from '../db/client';
import type { Category, DbInfo, TxnRow } from '../db/types';
import { kes, monthLabel, shortDateTime } from './format';

const PAGE = 200;

interface Props {
  info: DbInfo;
  categories: Category[];
  version: number;
  onChanged: () => void;
}

export function TransactionsView({ info, categories, version, onChanged }: Props) {
  const [month, setMonth] = useState('');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [rows, setRows] = useState<TxnRow[]>([]);
  const [open, setOpen] = useState<TxnRow | null>(null);

  // Reload when a filter changes or data changed elsewhere (`version`).
  useEffect(() => {
    let stale = false;
    const t = setTimeout(async () => {
      const r = await db.listTransactions({
        month: month || undefined,
        search: search || undefined,
        category: category === '' ? undefined : category === 'none' ? 'none' : Number(category),
        limit,
      });
      if (!stale) setRows(r);
    }, search ? 150 : 0); // debounce only while typing in the search box
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [month, category, search, limit, version]);

  if (info.transactionCount === 0) {
    return <p class="empty">No transactions yet. Import a statement on the Import tab.</p>;
  }

  return (
    <section class="stack">
      <div class="filters">
        <select value={month} onChange={(e) => setMonth((e.target as HTMLSelectElement).value)}>
          <option value="">All months</option>
          {info.months.map((m) => (
            <option value={m} key={m}>
              {monthLabel(m)}
            </option>
          ))}
        </select>
        <select value={category} onChange={(e) => setCategory((e.target as HTMLSelectElement).value)}>
          <option value="">All categories</option>
          <option value="none">Uncategorised ({info.uncategorised})</option>
          {categories.map((c) => (
            <option value={c.id} key={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="Search name, details, receipt"
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
        />
      </div>

      <ul class="txns">
        {rows.map((t) => (
          <li key={t.id} onClick={() => setOpen(t)}>
            <div class="txn-main">
              <div class="txn-title">{t.counterparty || t.details}</div>
              <div class="muted small">
                {shortDateTime(t.completedAt)} · {t.type}
              </div>
              <span class="chip" style={{ '--c': t.categoryColor ?? '#9aa0a6' }}>
                {t.categoryName ?? 'Uncategorised'}
                {t.categorySource === 'manual' ? ' ✎' : ''}
              </span>
            </div>
            <div class={`amt ${t.paidIn > 0 ? 'in' : 'out'}`}>
              {t.paidIn > 0 ? kes(t.paidIn, { sign: true }) : kes(-t.withdrawn)}
            </div>
          </li>
        ))}
      </ul>
      {rows.length === limit && (
        <button class="btn" onClick={() => setLimit(limit + PAGE)}>
          Load more
        </button>
      )}

      {open && (
        <CategorySheet
          txn={open}
          categories={categories}
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

/** Bottom sheet: choose a category for one transaction, optionally teaching a rule. */
function CategorySheet({
  txn,
  categories,
  onClose,
  onSaved,
}: {
  txn: TxnRow;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [makeRule, setMakeRule] = useState(true);
  const [keyword, setKeyword] = useState(txn.counterparty || txn.details);
  const direction = txn.paidIn > 0 && txn.withdrawn === 0 ? 'in' : 'out';

  async function pick(c: Category | null) {
    await db.setCategory(txn.id, c ? c.id : null); // the tapped row is now a manual choice
    // Teach the app: future and existing look-alike rows follow this choice.
    if (c && makeRule && keyword.trim()) await db.addRule(keyword, direction, c.id);
    onSaved();
  }

  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div class="sheet" onClick={(e) => e.stopPropagation()}>
        <h3>{txn.counterparty || txn.details}</h3>
        <p class="muted small">
          {txn.details}
          <br />
          {txn.receipt} · {shortDateTime(txn.completedAt)} ·{' '}
          <b>{txn.paidIn > 0 ? kes(txn.paidIn, { sign: true }) : kes(-txn.withdrawn)}</b>
        </p>

        <label class="check">
          <input type="checkbox" checked={makeRule} onChange={(e) => setMakeRule((e.target as HTMLInputElement).checked)} />
          Also categorise similar transactions (rule)
        </label>
        {makeRule && (
          <input
            class="full"
            value={keyword}
            onInput={(e) => setKeyword((e.target as HTMLInputElement).value)}
            aria-label="Text that identifies similar transactions"
          />
        )}

        <div class="chips">
          {categories.map((c) => (
            <button
              class={`chip pick ${txn.categoryId === c.id ? 'on' : ''}`}
              style={{ '--c': c.color }}
              key={c.id}
              onClick={() => void pick(c)}
            >
              {c.name}
            </button>
          ))}
        </div>
        <div class="row">
          <button class="btn" onClick={() => void pick(null)}>
            Clear category
          </button>
          <button class="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

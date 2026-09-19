import { useEffect, useState } from 'preact/hooks';
import { db } from '../db/client';
import type { CategoryTotal, DbInfo, Summary } from '../db/types';
import { kes, monthLabel } from './format';

function Bars({ items, empty }: { items: CategoryTotal[]; empty: string }) {
  if (!items.length) return <p class="muted">{empty}</p>;
  const max = Math.max(...items.map((i) => i.total));
  return (
    <ul class="bars">
      {items.map((i) => (
        <li key={i.categoryId ?? 'none'}>
          <div class="bar-head">
            <span>
              <i class="dot" style={{ background: i.color }} /> {i.name} <span class="muted small">×{i.count}</span>
            </span>
            <b>{kes(i.total)}</b>
          </div>
          <div class="bar">
            <div style={{ width: `${(i.total / max) * 100}%`, background: i.color }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function SummaryView({ info, version }: { info: DbInfo; version: number }) {
  const [month, setMonth] = useState(info.months[0] ?? '');
  const [s, setS] = useState<Summary | null>(null);

  useEffect(() => {
    void db.summary(month || null).then(setS);
  }, [month, version]);

  if (info.transactionCount === 0) return <p class="empty">Import a statement to see your spending summary.</p>;
  if (!s) return null;

  const net = s.totalIn - s.totalOut;
  const maxMonth = Math.max(1, ...s.monthly.map((m) => Math.max(m.totalIn, m.totalOut)));

  return (
    <section class="stack">
      <select value={month} onChange={(e) => setMonth((e.target as HTMLSelectElement).value)}>
        <option value="">All time</option>
        {info.months.map((m) => (
          <option value={m} key={m}>
            {monthLabel(m)}
          </option>
        ))}
      </select>

      <div class="cards">
        <div class="card">
          <span class="muted small">Money in</span>
          <b class="in">{kes(s.totalIn)}</b>
        </div>
        <div class="card">
          <span class="muted small">Money out</span>
          <b class="out">{kes(s.totalOut)}</b>
        </div>
        <div class="card">
          <span class="muted small">Net</span>
          <b class={net >= 0 ? 'in' : 'out'}>{kes(net, { sign: true })}</b>
        </div>
      </div>

      {info.uncategorised > 0 && (
        <p class="note">
          {info.uncategorised} {info.uncategorised === 1 ? 'transaction is' : 'transactions are'} uncategorised. Tap {info.uncategorised === 1 ? 'it' : 'them'} in the Transactions tab to teach the app.
        </p>
      )}

      <h3>Spending by category</h3>
      <Bars items={s.spending} empty="No spending in this period." />

      <h3>Income by category</h3>
      <Bars items={s.income} empty="No income in this period." />

      <h3>Top payees</h3>
      {s.topCounterparties.length === 0 && <p class="muted">Nothing yet.</p>}
      <ul class="plain">
        {s.topCounterparties.map((c) => (
          <li key={c.name}>
            <span>
              {c.name} <span class="muted small">×{c.count}</span>
            </span>
            <b>{kes(c.total)}</b>
          </li>
        ))}
      </ul>

      <h3>By month</h3>
      <ul class="months">
        {s.monthly.map((m) => (
          <li key={m.month}>
            <span class="small">{monthLabel(m.month)}</span>
            <div class="mbars">
              <div class="bar-in" style={{ width: `${(m.totalIn / maxMonth) * 100}%` }} title={`In ${kes(m.totalIn)}`} />
              <div class="bar-out" style={{ width: `${(m.totalOut / maxMonth) * 100}%` }} title={`Out ${kes(m.totalOut)}`} />
            </div>
            <span class="small muted">{kes(m.totalOut)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

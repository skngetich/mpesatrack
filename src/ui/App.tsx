import { useCallback, useEffect, useState } from 'preact/hooks';
import { db } from '../db/client';
import type { Category, DbInfo } from '../db/types';
import { RELOCK_AFTER_MS, hasPin } from '../lock';
import { ImportView } from './ImportView';
import { LockScreen } from './LockScreen';
import { SettingsView } from './SettingsView';
import { SummaryView } from './SummaryView';
import { TransactionsView } from './TransactionsView';

type Tab = 'summary' | 'txns' | 'import' | 'settings';

const TABS: Array<[Tab, string, string]> = [
  ['summary', 'Summary', '▤'],
  ['txns', 'Transactions', '☰'],
  ['import', 'Import', '⇪'],
  ['settings', 'Settings', '⚙'],
];

export function App() {
  const [tab, setTab] = useState<Tab | null>(null);
  const [info, setInfo] = useState<DbInfo | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState('');
  /** Bumped after any write so views re-query. */
  const [version, setVersion] = useState(0);
  const [locked, setLocked] = useState(hasPin);

  const refresh = useCallback(async () => {
    const [i, c] = await Promise.all([db.info(), db.listCategories()]);
    setInfo(i);
    setCategories(c);
    setVersion((v) => v + 1);
    return i;
  }, []);

  useEffect(() => {
    db.init()
      .then(refresh)
      .then((i) => setTab((t) => t ?? (i.transactionCount ? 'summary' : 'import')))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [refresh]);

  // Re-lock when the app comes back after being in the background for a while.
  useEffect(() => {
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt >= RELOCK_AFTER_MS && hasPin()) setLocked(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Checked before anything else so no data is ever rendered behind the lock.
  if (locked) {
    return (
      <LockScreen
        onUnlock={() => setLocked(false)}
        onWiped={() => {
          setLocked(false);
          setTab('import');
          void refresh();
        }}
      />
    );
  }

  if (error) {
    return (
      <main class="page">
        <h1>MpesaTrack</h1>
        <p class="note warn">Could not start the local database: {error}</p>
      </main>
    );
  }
  if (!info || !tab) return <main class="page"><p class="muted">Opening database…</p></main>;

  return (
    <>
      <main class="page">
        <h1>MpesaTrack</h1>
        {tab === 'summary' && <SummaryView info={info} version={version} />}
        {tab === 'txns' && <TransactionsView info={info} categories={categories} version={version} onChanged={() => void refresh()} />}
        {tab === 'import' && <ImportView onImported={() => void refresh()} />}
        {tab === 'settings' && <SettingsView info={info} categories={categories} version={version} onChanged={() => void refresh()} />}
      </main>
      <nav class="tabs">
        {TABS.map(([id, label, icon]) => (
          <button key={id} class={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            <span aria-hidden="true">{icon}</span>
            {label}
          </button>
        ))}
      </nav>
    </>
  );
}

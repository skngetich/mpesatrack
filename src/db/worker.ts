/**
 * SQLite database worker.
 *
 * Runs SQLite (compiled to WebAssembly by @sqlite.org/sqlite-wasm) inside a Web
 * Worker and persists the database file to the browser's Origin Private File
 * System (OPFS) using the "opfs-sahpool" VFS. That VFS was chosen because it
 * does NOT need cross-origin-isolation headers (COOP/COEP), so the app can be
 * hosted on any static host, GitHub Pages included.
 *
 * The main thread talks to this worker through ./client.ts: it posts
 * { id, method, args } and receives { id, result } or { id, error }.
 * Every public method is listed in `methods` at the bottom of this file.
 */
import sqlite3InitModule, { type Database, type Sqlite3Static, type SAHPoolUtil } from '@sqlite.org/sqlite-wasm';
import { DEFAULT_CATEGORIES, DEFAULT_RULES, matchRule, type Direction, type Rule } from '../categorize';
import type { ParsedTransaction } from '../parser/mpesa';
import type {
  Category,
  CategoryTotal,
  DbInfo,
  ImportResult,
  RuleRow,
  Summary,
  TxnFilter,
  TxnRow,
} from './types';

const DB_PATH = '/mpesatrack.sqlite3';
const SCHEMA_VERSION = 1;

let sqlite3: Sqlite3Static;
let db: Database;
let pool: SAHPoolUtil | null = null;
let persistent = false;

type Bind = Array<string | number | null>;
type Row = Record<string, string | number | null>;

const all = (sql: string, bind: Bind = []): Row[] =>
  db.exec({ sql, bind, rowMode: 'object', returnValue: 'resultRows' }) as Row[];
const run = (sql: string, bind: Bind = []): void => void db.exec({ sql, bind });
const one = (sql: string, bind: Bind = []): Row | undefined => all(sql, bind)[0];

// ------------------------------------------------------------------- setup

async function init(): Promise<DbInfo> {
  if (db) return info();
  sqlite3 = await sqlite3InitModule();
  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'mpesatrack', clearOnInit: false });
    db = new pool.OpfsSAHPoolDb(DB_PATH);
    persistent = true;
  } catch (err) {
    // OPFS unavailable (very old browser, some private modes). Keep working in
    // memory so the app is usable, and tell the UI so it can warn the user.
    console.warn('OPFS unavailable, using in-memory database:', err);
    db = new sqlite3.oo1.DB(':memory:', 'c');
    persistent = false;
  }
  migrate();
  return info();
}

/** Schema migrations keyed on PRAGMA user_version. Add new steps at the end. */
function migrate(): void {
  run('PRAGMA foreign_keys = ON');
  const version = Number(one('PRAGMA user_version')?.user_version ?? 0);
  if (version < 1) {
    db.transaction(() => {
      run(`CREATE TABLE categories (
        id    INTEGER PRIMARY KEY,
        name  TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL
      )`);
      run(`CREATE TABLE transactions (
        id              INTEGER PRIMARY KEY,
        receipt         TEXT NOT NULL UNIQUE,   -- M-PESA receipt no.; makes re-imports idempotent
        completed_at    TEXT NOT NULL,          -- 'YYYY-MM-DD HH:mm:ss' local time
        details         TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT '',
        is_completed    INTEGER NOT NULL DEFAULT 1,
        paid_in         INTEGER NOT NULL DEFAULT 0,  -- cents
        withdrawn       INTEGER NOT NULL DEFAULT 0,  -- cents
        balance         INTEGER,                     -- cents
        type            TEXT NOT NULL DEFAULT 'other',
        counterparty    TEXT NOT NULL DEFAULT '',
        category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        category_source TEXT CHECK (category_source IN ('rule','manual')),
        imported_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      run('CREATE INDEX idx_txn_time ON transactions(completed_at)');
      run('CREATE INDEX idx_txn_cat  ON transactions(category_id)');
      run(`CREATE TABLE rules (
        id          INTEGER PRIMARY KEY,
        keyword     TEXT NOT NULL,
        direction   TEXT NOT NULL DEFAULT 'any' CHECK (direction IN ('any','in','out')),
        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        UNIQUE (keyword, direction)
      )`);
      seedDefaults();
      run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }
}

function seedDefaults(): void {
  for (const c of DEFAULT_CATEGORIES) run('INSERT INTO categories (name, color) VALUES (?, ?)', [c.name, c.color]);
  for (const [keyword, cat, direction] of DEFAULT_RULES) {
    run('INSERT OR IGNORE INTO rules (keyword, direction, category_id) SELECT ?, ?, id FROM categories WHERE name = ?', [
      keyword,
      direction,
      cat,
    ]);
  }
}

function info(): DbInfo {
  const c = one('SELECT COUNT(*) AS n, SUM(category_id IS NULL) AS u FROM transactions');
  const months = all("SELECT DISTINCT substr(completed_at, 1, 7) AS m FROM transactions ORDER BY m DESC").map((r) => String(r.m));
  return { persistent, transactionCount: Number(c?.n ?? 0), uncategorised: Number(c?.u ?? 0), months };
}

// ------------------------------------------------------------ transactions

function loadRules(): Rule[] {
  return all('SELECT id, keyword, direction, category_id FROM rules').map((r) => ({
    id: Number(r.id),
    keyword: String(r.keyword),
    direction: r.direction as Direction,
    categoryId: Number(r.category_id),
  }));
}

/**
 * Insert parsed transactions. Rows whose receipt already exists are skipped, so
 * importing overlapping statements (e.g. Jan-Jun then Apr-Sep) never duplicates.
 */
function importTransactions(txns: ParsedTransaction[]): ImportResult {
  const rules = loadRules();
  let added = 0;
  let categorised = 0;
  db.transaction(() => {
    const stmt = db.prepare(`INSERT OR IGNORE INTO transactions
      (receipt, completed_at, details, status, is_completed, paid_in, withdrawn, balance, type, counterparty, category_id, category_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    try {
      for (const t of txns) {
        const categoryId = matchRule(rules, t);
        const completed = t.status === '' || /complete/i.test(t.status) ? 1 : 0;
        stmt.bind([
          t.receipt, t.completedAt, t.details, t.status, completed, t.paidIn, t.withdrawn, t.balance,
          t.type, t.counterparty, categoryId, categoryId === null ? null : 'rule',
        ]);
        stmt.step();
        stmt.reset(true);
        if (db.changes() > 0) {
          added++;
          if (categoryId !== null) categorised++;
        }
      }
    } finally {
      stmt.finalize();
    }
  });
  return { added, duplicates: txns.length - added, categorised };
}

const TXN_SELECT = `SELECT t.id, t.receipt, t.completed_at, t.details, t.status, t.paid_in, t.withdrawn, t.balance,
    t.type, t.counterparty, t.category_id, t.category_source, c.name AS category_name, c.color AS category_color
  FROM transactions t LEFT JOIN categories c ON c.id = t.category_id`;

function toTxn(r: Row): TxnRow {
  return {
    id: Number(r.id),
    receipt: String(r.receipt),
    completedAt: String(r.completed_at),
    details: String(r.details),
    status: String(r.status),
    paidIn: Number(r.paid_in),
    withdrawn: Number(r.withdrawn),
    balance: r.balance === null ? null : Number(r.balance),
    type: String(r.type),
    counterparty: String(r.counterparty),
    categoryId: r.category_id === null ? null : Number(r.category_id),
    categorySource: r.category_source as TxnRow['categorySource'],
    categoryName: r.category_name === null ? null : String(r.category_name),
    categoryColor: r.category_color === null ? null : String(r.category_color),
  };
}

function listTransactions(f: TxnFilter = {}): TxnRow[] {
  const where: string[] = [];
  const bind: Bind = [];
  if (f.month) {
    where.push('substr(t.completed_at, 1, 7) = ?');
    bind.push(f.month);
  }
  if (f.search?.trim()) {
    where.push('(t.details LIKE ? OR t.counterparty LIKE ? OR t.receipt LIKE ?)');
    const q = `%${f.search.trim()}%`;
    bind.push(q, q, q);
  }
  if (f.category === 'none') where.push('t.category_id IS NULL');
  else if (typeof f.category === 'number') {
    where.push('t.category_id = ?');
    bind.push(f.category);
  }
  const sql = `${TXN_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.completed_at DESC, t.id DESC LIMIT ? OFFSET ?`;
  return all(sql, [...bind, f.limit ?? 200, f.offset ?? 0]).map(toTxn);
}

/** Manual assignment; pass null to clear. Manual choices are never overwritten by rules. */
function setCategory(txnId: number, categoryId: number | null): void {
  run('UPDATE transactions SET category_id = ?, category_source = ? WHERE id = ?', [
    categoryId,
    categoryId === null ? null : 'manual',
    txnId,
  ]);
}

/** Re-run all rules over every transaction that is not manually categorised. */
function applyRules(): { changed: number } {
  const rules = loadRules();
  let changed = 0;
  db.transaction(() => {
    const rows = all(
      "SELECT id, details, paid_in, withdrawn, category_id FROM transactions WHERE category_source IS NOT 'manual'",
    );
    for (const r of rows) {
      const next = matchRule(rules, { details: String(r.details), paidIn: Number(r.paid_in), withdrawn: Number(r.withdrawn) });
      const prev = r.category_id === null ? null : Number(r.category_id);
      if (next === prev) continue;
      run('UPDATE transactions SET category_id = ?, category_source = ? WHERE id = ?', [next, next === null ? null : 'rule', Number(r.id)]);
      changed++;
    }
  });
  return { changed };
}

// --------------------------------------------------------------- categories

function listCategories(): Category[] {
  return all('SELECT id, name, color FROM categories ORDER BY name').map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    color: String(r.color),
  }));
}

function addCategory(name: string, color: string): number {
  const n = name.trim();
  if (!n) throw new Error('Category name is required');
  run('INSERT INTO categories (name, color) VALUES (?, ?)', [n, color]);
  return Number(one('SELECT last_insert_rowid() AS id')?.id);
}

/** Deleting a category un-categorises its transactions and removes its rules. */
function deleteCategory(id: number): void {
  run('DELETE FROM categories WHERE id = ?', [id]);
}

// -------------------------------------------------------------------- rules

function listRules(): RuleRow[] {
  return all(
    `SELECT r.id, r.keyword, r.direction, r.category_id, c.name AS category_name
     FROM rules r JOIN categories c ON c.id = r.category_id ORDER BY c.name, r.keyword`,
  ).map((r) => ({
    id: Number(r.id),
    keyword: String(r.keyword),
    direction: r.direction as RuleRow['direction'],
    categoryId: Number(r.category_id),
    categoryName: String(r.category_name),
  }));
}

/** Add (or repoint) a rule, then apply rules. Returns how many transactions changed. */
function addRule(keyword: string, direction: Direction, categoryId: number): { changed: number } {
  const k = keyword.trim().toLowerCase();
  if (!k) throw new Error('Keyword is required');
  run(
    `INSERT INTO rules (keyword, direction, category_id) VALUES (?, ?, ?)
     ON CONFLICT (keyword, direction) DO UPDATE SET category_id = excluded.category_id`,
    [k, direction, categoryId],
  );
  return applyRules();
}

function deleteRule(id: number): { changed: number } {
  run('DELETE FROM rules WHERE id = ?', [id]);
  return applyRules();
}

// ------------------------------------------------------------------ summary

/** Only completed transactions count towards totals. `month` null = all time. */
function summary(month: string | null): Summary {
  const where = `is_completed = 1 ${month ? "AND substr(completed_at, 1, 7) = ?" : ''}`;
  const b: Bind = month ? [month] : [];

  const totals = one(`SELECT COALESCE(SUM(paid_in),0) AS i, COALESCE(SUM(withdrawn),0) AS o FROM transactions WHERE ${where}`, b);

  const byCategory = (col: 'withdrawn' | 'paid_in'): CategoryTotal[] =>
    all(
      `SELECT t.category_id AS id, COALESCE(c.name, 'Uncategorised') AS name, COALESCE(c.color, '#9aa0a6') AS color,
              SUM(t.${col}) AS total, COUNT(*) AS n
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.${col} > 0 AND ${where.replace(/\b(is_completed|completed_at)\b/g, 't.$1')}
       GROUP BY t.category_id ORDER BY total DESC`,
      b,
    ).map((r) => ({
      categoryId: r.id === null ? null : Number(r.id),
      name: String(r.name),
      color: String(r.color),
      total: Number(r.total),
      count: Number(r.n),
    }));

  const top = all(
    `SELECT counterparty AS name, SUM(withdrawn) AS total, COUNT(*) AS n FROM transactions
     WHERE ${where} AND withdrawn > 0 AND counterparty <> '' AND type <> 'fee'
     GROUP BY lower(counterparty) ORDER BY total DESC LIMIT 8`,
    b,
  ).map((r) => ({ name: String(r.name), total: Number(r.total), count: Number(r.n) }));

  const monthly = all(
    `SELECT substr(completed_at, 1, 7) AS m, SUM(paid_in) AS i, SUM(withdrawn) AS o
     FROM transactions WHERE is_completed = 1 GROUP BY m ORDER BY m`,
  ).map((r) => ({ month: String(r.m), totalIn: Number(r.i), totalOut: Number(r.o) }));

  return {
    totalIn: Number(totals?.i ?? 0),
    totalOut: Number(totals?.o ?? 0),
    spending: byCategory('withdrawn'),
    income: byCategory('paid_in'),
    topCounterparties: top,
    monthly,
  };
}

// ------------------------------------------------------------ backup / wipe

/** The raw SQLite file, for backup. Opens in any SQLite tool too. */
function exportDb(): Uint8Array {
  return sqlite3.capi.sqlite3_js_db_export(db.pointer as number);
}

/** Replace the whole database with an exported file. Requires persistent storage. */
async function importDb(bytes: Uint8Array): Promise<DbInfo> {
  if (!pool) throw new Error('Restoring a backup needs persistent (OPFS) storage, which is unavailable here.');
  // Reject anything that is not a SQLite file before we throw the current data away.
  const magic = new TextDecoder().decode(bytes.slice(0, 15));
  if (magic !== 'SQLite format 3') throw new Error('That file is not a SQLite database.');
  db.close();
  await pool.importDb(DB_PATH, bytes);
  db = new pool.OpfsSAHPoolDb(DB_PATH);
  migrate();
  return info();
}

/** Delete every transaction (categories and rules are kept). */
function clearTransactions(): DbInfo {
  run('DELETE FROM transactions');
  return info();
}

// ----------------------------------------------------------------- dispatch

const methods = {
  init,
  info,
  importTransactions,
  listTransactions,
  setCategory,
  applyRules,
  listCategories,
  addCategory,
  deleteCategory,
  listRules,
  addRule,
  deleteRule,
  summary,
  exportDb,
  importDb,
  clearTransactions,
};
export type DbMethods = typeof methods;

self.onmessage = async (e: MessageEvent<{ id: number; method: keyof DbMethods; args: unknown[] }>) => {
  const { id, method, args } = e.data;
  try {
    // Calls are serialised by the worker's single thread; init() must run first.
    const fn = methods[method] as (...a: unknown[]) => unknown;
    const result = await fn(...args);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};

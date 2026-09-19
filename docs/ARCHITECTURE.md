# Architecture

## Big picture

```
 statement.pdf ──► pdf.ts (pdf.js) ──► TextItem[] ──► mpesa.ts ──► ParsedTransaction[]
   (+ password)      decrypt + extract    x/y/width     pure parser        │
                                                                          ▼
   UI (Preact) ◄──── db/client.ts ◄──── postMessage ────► db/worker.ts ── SQLite (WASM)
                     typed promises                        │                 │
                                                           └─ categorize.ts  └─ OPFS file /mpesatrack.sqlite3
```

Everything is client-side. The UI thread never touches SQLite; it talks to a dedicated worker.
PDF parsing runs on the UI thread but pdf.js does the heavy lifting in its own worker.

## Modules

| Module | Responsibility | Pure? |
| --- | --- | --- |
| `parser/pdf.ts` | Open the PDF (with password), return every text fragment with its position. Maps pdf.js password errors to `PasswordError`. | no (pdf.js) |
| `parser/mpesa.ts` | Rebuild the transaction table from fragments; classify type; extract counterparty; amounts to cents; reconcile balances. | yes |
| `categorize.ts` | Default categories/rules; `matchRule()` picks the category for one transaction. | yes |
| `db/worker.ts` | Schema/migrations, import, queries, rules, summary, backup/restore. Only place that runs SQL. | no |
| `db/client.ts` | `db.method(...)` proxy: posts `{id, method, args}`, resolves on `{id, result}` / rejects on `{id, error}`. Typed from `DbMethods`. | no |
| `ui/*` | Screens. Views re-query when `version` (bumped after every write) changes. | no |

Pure modules have unit tests (`npm test`) with no browser needed.

## Data model (SQLite, schema version 2)

Stored in `PRAGMA user_version`; migrations are additive steps in `migrate()`.

```
categories(id PK, name UNIQUE, color)

transactions(
  id PK,
  receipt,                   -- M-PESA receipt no. NOT unique alone: a payment and its fee share one
  completed_at TEXT,         -- 'YYYY-MM-DD HH:mm:ss' local time; sorts and groups (substr 1..7 = month)
  details, status, is_completed,
  paid_in INTEGER, withdrawn INTEGER, balance INTEGER,   -- integer CENTS
  type TEXT,                 -- send|received|paybill|till|airtime|withdraw|deposit|fee|fuliza|savings|reversal|other
  counterparty TEXT,
  category_id -> categories ON DELETE SET NULL,
  category_source TEXT,      -- 'rule' | 'manual' | NULL
  imported_at)

UNIQUE INDEX ux_txn_key ON transactions(receipt, paid_in, withdrawn, COALESCE(balance, -1))   -- dedupe key

rules(id PK, keyword, direction 'any'|'in'|'out', category_id -> categories ON DELETE CASCADE,
      UNIQUE(keyword, direction))
```

### Decisions

- **Money as integer cents.** Floating point drifts (0.1 + 0.2); summing thousands of rows must be exact. The UI formats on display.
- **Dedupe key = receipt + amounts + balance (not the receipt alone).** In a real statement a payment and its transaction
  fee are separate rows that share one receipt number and timestamp (930 rows had only 541 distinct receipts). A
  `UNIQUE(receipt)` constraint (schema v1) silently dropped the fee rows. The key `(receipt, paid_in, withdrawn, balance)`
  keeps both rows while still making re-imports of overlapping statements a no-op (`INSERT OR IGNORE`). `COALESCE(balance, -1)`
  is there because SQLite treats NULLs as distinct inside a unique index. Migration v1 to v2 rebuilds the table and keeps all rows.
- **`opfs-sahpool` VFS.** SQLite-on-OPFS has two VFSes. The default (`opfs`) needs `SharedArrayBuffer`, which needs COOP/COEP headers that static hosts such as GitHub Pages cannot send. `opfs-sahpool` needs no special headers and is fast, at the cost of one exclusive connection (fine: a single worker owns the DB).
- **In-memory fallback.** If OPFS is missing, the worker uses `:memory:` and `DbInfo.persistent` is false; Settings shows a warning.
- **Local time strings, no timezone.** Statements print local (EAT) times; storing them verbatim avoids timezone shifts in monthly grouping.
- **Only completed rows in totals.** `is_completed = 1` (status empty or contains "complete").
- **Fuliza is borrowing, not income or spending.** Rows of `type = 'fuliza'` (the overdraft draw and its repayment) are left out
  of money in/out, category breakdowns, top payees and the monthly chart, and are reported on their own (`Summary.fuliza`).
  Payments merely funded by Fuliza are ordinary `send`/`till` rows and count as spending.

## Worker protocol

Request `{ id, method, args }`, response `{ id, result }` or `{ id, error }`. The methods are the keys of the `methods`
object at the bottom of `db/worker.ts`; add a function there and it appears, typed, on `db` in the client.
`init()` must be called first (the app does it on startup).

## Categorisation

`matchRule(rules, txn)`:

1. Direction of the transaction is `in` (paid in only), `out` (withdrawn), else `any`.
2. A rule applies if its direction is `any` or equals that direction, and `details` contains its keyword (case-insensitive).
3. Among applicable rules the longest keyword wins (most specific); ties go to the oldest rule.

When rules run:

- **On import**, for each new transaction.
- **After adding/deleting a rule** or pressing *Re-apply rules*: `applyRules()` revisits every transaction whose
  `category_source` is not `manual`. Rows can therefore move (or become uncategorised) when rules change.
- **Manual choice** (`setCategory`) sets `category_source = 'manual'`; rules never touch these rows. *Clear category* resets the row to unset and lets rules take over again on the next apply.

Seed data (categories, keyword rules) lives in `categorize.ts`; it is inserted once when the database is created.

## PWA and offline

`vite-plugin-pwa` (Workbox `generateSW`) precaches the app shell, JS, CSS, icons, the SQLite `.wasm` and the pdf.js worker
(about 3 MB). `registerType: 'autoUpdate'`: a new deployment installs in the background and takes over on the next launch.
`base: './'` keeps URLs relative so any sub-path works. The web manifest sets `display: standalone` and provides a maskable icon.
`navigator.storage.persist()` is requested at startup to reduce the chance of the browser evicting the database.

## Backup and restore

- Export: `sqlite3_js_db_export` returns the database file bytes; the UI downloads it as `mpesatrack-YYYY-MM-DD.sqlite3`.
- Restore: the file's magic header is checked, the DB is closed, `pool.importDb()` overwrites the OPFS file, the DB is reopened and migrated (so older backups upgrade).

## Testing

- `npm test`: Vitest for `parser/mpesa.ts` and `categorize.ts`.
- The parser tests build a synthetic page (header, rows, wrapped lines, footer, second page) so layout heuristics are exercised
  without a real PDF.
- End-to-end manual checklist used during development: import an encrypted PDF (no password, wrong password, right password),
  re-import (all duplicates), categorise by hand with a rule, reload (data persists), backup then wipe then restore, and
  reload with the server stopped (offline).

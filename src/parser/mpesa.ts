/**
 * M-PESA statement parser (pure, no I/O).
 *
 * Input:  positioned text fragments extracted from the statement PDF
 *         (see ./pdf.ts, which produces them with pdf.js).
 * Output: normalised transactions ready to be stored in SQLite.
 *
 * WHY POSITIONS? A PDF has no "table" object, only glyph runs placed at (x, y).
 * mpesa2csv solves this with Tabula (table detection). Here we do the same job
 * ourselves in three steps, which is what makes the parser fully offline and
 * testable:
 *   1. Group fragments into visual rows by their y coordinate.
 *   2. Find the header row ("Receipt No", "Completion Time", "Details", ...)
 *      and use the header positions to define column boundaries.
 *   3. Rebuild each transaction: a row whose first cell looks like a receipt
 *      number starts a transaction; rows without a receipt are continuation
 *      lines (long "Details" text wraps onto extra lines) and are appended.
 *
 * See docs/PARSER.md for the statement layout and the heuristics in detail.
 */

/** One text fragment from the PDF, in PDF user-space units (y grows upward). */
export interface TextItem {
  str: string;
  x: number;
  y: number;
  /** Rendered width of the fragment; used for right-aligned amount columns. */
  width: number;
  page: number;
}

export type TxnType =
  | 'send' // Customer Transfer to a person
  | 'received' // money in from a person / business
  | 'paybill'
  | 'till' // Merchant payment / buy goods
  | 'airtime'
  | 'withdraw' // cash out at agent / ATM
  | 'deposit' // cash in at agent
  | 'fee' // any transaction charge
  | 'fuliza'
  | 'savings' // M-Shwari, KCB M-PESA, lock savings, ...
  | 'reversal'
  | 'other';

export interface ParsedTransaction {
  receipt: string;
  /** Local time, "YYYY-MM-DD HH:mm:ss" (sortable as plain text). */
  completedAt: string;
  details: string;
  status: string;
  /** Money in, in cents (KES * 100). Integers avoid float rounding drift. */
  paidIn: number;
  /** Money out, in cents. Always positive. */
  withdrawn: number;
  /** Running balance in cents, or null when the column was empty. */
  balance: number | null;
  type: TxnType;
  /** Best-effort name of the other party ('' when there is none, e.g. airtime). */
  counterparty: string;
}

export interface ParseResult {
  transactions: ParsedTransaction[];
  warnings: string[];
  /** False when no table header was found on any page (wrong PDF or new layout). */
  headerFound: boolean;
}

// ---------------------------------------------------------------- constants

/** Receipt numbers are 10 upper-case alphanumerics, e.g. "SGH1A2B3C4". */
const RECEIPT_RE = /^[A-Z0-9]{10}$/;
const AMOUNT_RE = /^-?\(?[\d,]+\.\d{2}\)?$/;
/** Items whose y differ by less than this belong to the same visual row. */
const ROW_TOLERANCE = 3;
/** Header labels can wrap onto a second line; look this far below the first. */
const HEADER_BAND = 14;
/** Slack (in PDF units) when comparing an item's x to a column's start. */
const COL_TOLERANCE = 4;

type ColKey = 'receipt' | 'time' | 'details' | 'status' | 'paidIn' | 'withdrawn' | 'balance';

/** Header keyword -> column. Unanchored: a fragment may contain several headers. */
const HEADER_MATCHERS: Array<[ColKey, RegExp]> = [
  ['receipt', /receipt/i],
  ['time', /completion/i],
  ['details', /details/i],
  ['status', /(?:transaction\s+)?status/i],
  ['paidIn', /paid/i],
  ['withdrawn', /withdraw/i],
  ['balance', /balance/i],
];

interface Column {
  key: ColKey;
  x: number; // header start
  x2: number; // header end
}

interface Row {
  y: number;
  items: TextItem[]; // sorted by x
}

// ------------------------------------------------------------------- public

export function parseStatement(items: TextItem[]): ParseResult {
  const warnings: string[] = [];
  const transactions: ParsedTransaction[] = [];
  let headerFound = false;

  const pages = [...new Set(items.map((i) => i.page))].sort((a, b) => a - b);
  let columns: Column[] | null = null; // carried over when a page lacks a header
  let current: RawTxn | null = null;

  for (const page of pages) {
    const rows = groupRows(items.filter((i) => i.page === page));
    let dataStart = 0;

    const headerIdx = rows.findIndex(isHeaderRow);
    if (headerIdx >= 0) {
      const found = readColumns(rows, headerIdx);
      if (found) {
        columns = found.columns;
        dataStart = found.nextRow;
        headerFound = true;
      }
    } else if (columns) {
      dataStart = 0; // continuation page without repeated header
    } else {
      continue; // cover page / summary before the first table
    }
    if (!columns) continue;

    for (const row of rows.slice(dataStart)) {
      if (isHeaderRow(row)) continue; // repeated header mid-page
      const cells = assignCells(row, columns);
      const receipt = cells.receipt.trim();

      if (RECEIPT_RE.test(receipt)) {
        if (current) transactions.push(finish(current, warnings));
        current = {
          receipt,
          time: cells.time,
          details: cells.details,
          status: cells.status,
          paidIn: cells.paidIn,
          withdrawn: cells.withdrawn,
          balance: cells.balance,
        };
      } else if (current && isContinuation(cells)) {
        // A wrapped cell: glue the text to whatever the transaction has so far.
        current.time = joinText(current.time, cells.time);
        current.details = joinText(current.details, cells.details);
        current.status = joinText(current.status, cells.status);
      } else if (receipt || cells.paidIn || cells.withdrawn || cells.balance) {
        // Footer, disclaimer or summary block: the table has ended.
        if (current) transactions.push(finish(current, warnings));
        current = null;
      }
    }
  }
  if (current) transactions.push(finish(current, warnings));

  const valid = transactions.filter((t) => t !== SKIP);
  const result = valid as ParsedTransaction[];

  if (!headerFound) {
    warnings.push(
      'Could not find the transaction table header (Receipt No / Details / Balance). ' +
        'Is this an M-PESA full statement PDF?',
    );
  } else if (result.length === 0) {
    warnings.push('Found the table header but no transaction rows.');
  } else {
    const bad = balanceMismatches(result);
    if (bad > 0) {
      warnings.push(
        `${bad} of ${result.length} rows do not reconcile with the running balance. ` +
          'Amounts may be in the wrong column; check the Transactions tab.',
      );
    }
  }
  return { transactions: result, warnings, headerFound };
}

/** Classify a Details string into a coarse transaction type. Exported for tests. */
export function classify(details: string, paidIn: number): TxnType {
  const d = details.toLowerCase();
  if (/\b(charge|fee)\b/.test(d)) return 'fee';
  if (/fuliza|overdraft/.test(d)) return 'fuliza';
  if (/reversal/.test(d)) return 'reversal';
  if (/airtime|bundle purchase|data bundle/.test(d)) return 'airtime';
  if (/m-?shwari|kcb m-?pesa|lock savings|ziidi|mali\b/.test(d)) return 'savings';
  if (/pay ?bill/.test(d)) return 'paybill';
  if (/merchant payment|buy goods|small business/.test(d)) return 'till';
  if (/withdraw/.test(d)) return 'withdraw';
  if (/\bdeposit\b/.test(d)) return 'deposit';
  if (/customer transfer/.test(d)) return 'send';
  if (/funds received|business payment from|promotion|salary|received/.test(d) || paidIn > 0) {
    return 'received';
  }
  return 'other';
}

/**
 * Pull a readable counterparty name out of Details, e.g.
 *   "Customer Transfer to - 2547*****123 JOHN DOE"      -> "JOHN DOE"
 *   "Pay Bill to 247247 - Equity Bulk Account Acc. 123" -> "Equity Bulk Account"
 *   "Merchant Payment to 5123456 - KFC WESTLANDS"       -> "KFC WESTLANDS"
 * Returns '' when nothing sensible can be extracted (airtime, fees, ...).
 */
export function extractCounterparty(details: string): string {
  const flat = details.replace(/\s+/g, ' ').trim();
  const m = flat.match(/\b(?:to|from)\b\s*-?\s*(.*)$/i);
  if (!m) return '';
  let rest = m[1];
  rest = rest.replace(/^small business to\b\s*-?\s*/i, ''); // "Customer Payment to Small Business to - ..."
  rest = rest.replace(/\s+Acc\.\s*\S.*$|\s+Acc\s+No\b.*$/i, ''); // paybill account reference ("Acc. 123")
  const stripped = rest.replace(/^[\d*\s]+(?:-\s*)?/, ''); // leading phone / till / paybill number
  return (stripped || rest).trim();
}

/** "1,234.50" -> 123450. Handles "-", "(...)" and empty strings. */
export function parseAmount(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  const cleaned = t.replace(/[(),\s-]/g, '');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? Math.round(Math.abs(n) * 100) : 0;
}

/** Accepts "2024-03-15 14:22:10" and "15/03/2024 14:22:10"; returns ISO-like text or null. */
export function parseDateTime(text: string): string | null {
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]} ${iso[4].padStart(2, '0')}:${iso[5]}:${iso[6]}`;
  const dmy = text.match(/(\d{2})[/-](\d{2})[/-](\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]} ${dmy[4].padStart(2, '0')}:${dmy[5]}:${dmy[6]}`;
  return null;
}

// ---------------------------------------------------------------- internals

interface Cells {
  receipt: string;
  time: string;
  details: string;
  status: string;
  paidIn: number;
  withdrawn: number;
  balance: number | null;
}

interface RawTxn {
  receipt: string;
  time: string;
  details: string;
  status: string;
  paidIn: number;
  withdrawn: number;
  balance: number | null;
}

/** Sentinel for rows that had a receipt but an unreadable date. */
const SKIP = Symbol('skip') as unknown as ParsedTransaction;

function finish(raw: RawTxn, warnings: string[]): ParsedTransaction {
  const completedAt = parseDateTime(raw.time);
  if (!completedAt) {
    warnings.push(`Skipped ${raw.receipt}: unreadable completion time "${raw.time.trim()}".`);
    return SKIP;
  }
  const details = raw.details.replace(/\s+/g, ' ').trim();
  return {
    receipt: raw.receipt,
    completedAt,
    details,
    status: raw.status.replace(/\s+/g, ' ').trim(),
    paidIn: raw.paidIn,
    withdrawn: raw.withdrawn,
    balance: raw.balance,
    type: classify(details, raw.paidIn),
    counterparty: extractCounterparty(details),
  };
}

/** Group fragments into rows (top to bottom), each sorted left to right. */
function groupRows(items: TextItem[]): Row[] {
  const sorted = items.filter((i) => i.str.trim() !== '').sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Row[] = [];
  for (const it of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - it.y) <= ROW_TOLERANCE) last.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  return rows;
}

const rowText = (r: Row) => r.items.map((i) => i.str).join(' ').toLowerCase();

function isHeaderRow(r: Row): boolean {
  const t = rowText(r);
  // "Receipt" alone can appear in prose; requiring "details" or "balance" too avoids that.
  return t.includes('receipt') && (t.includes('details') || t.includes('balance') || t.includes('completion'));
}

/**
 * Locate each column from the header. Header labels may wrap ("Paid" / "in"),
 * so rows within HEADER_BAND below the first header row are scanned as well.
 * Returns the columns and the index of the first data row.
 */
function readColumns(rows: Row[], headerIdx: number): { columns: Column[]; nextRow: number } | null {
  const band: Row[] = [rows[headerIdx]];
  let next = headerIdx + 1;
  while (next < rows.length && rows[headerIdx].y - rows[next].y <= HEADER_BAND && !RECEIPT_RE.test(firstText(rows[next]))) {
    band.push(rows[next]);
    next++;
  }

  // pdf.js sometimes fuses neighbouring header cells into one fragment (e.g.
  // "Transaction Status Paid in"). So look for each keyword *inside* a fragment
  // and estimate where it starts from its character offset (proportional).
  const found = new Map<ColKey, Column>();
  for (const row of band) {
    for (const it of row.items) {
      const len = Math.max(it.str.length, 1);
      for (const [key, re] of HEADER_MATCHERS) {
        const m = re.exec(it.str);
        if (!m) continue;
        const x = it.x + (it.width * m.index) / len;
        const x2 = it.x + (it.width * (m.index + m[0].length)) / len;
        const prev = found.get(key);
        if (!prev || x < prev.x) found.set(key, { key, x, x2 });
      }
    }
  }
  const cols = [...found.values()].sort((a, b) => a.x - b.x);

  const required: ColKey[] = ['receipt', 'details', 'paidIn', 'withdrawn', 'balance'];
  if (required.some((k) => !found.has(k))) return null;
  return { columns: cols, nextRow: next };
}

const firstText = (r: Row) => (r.items[0]?.str ?? '').trim();

/**
 * Put each fragment of a row into a column.
 *  - Amount-looking fragments right of the "Paid in" header go to the numeric
 *    column they overlap most (amounts are usually right-aligned, so their
 *    start x may sit left of the header's start).
 *  - Everything else goes to the last text column that starts at or before it.
 */
function assignCells(row: Row, columns: Column[]): Cells {
  const text: Record<'receipt' | 'time' | 'details' | 'status', TextItem[]> = {
    receipt: [], time: [], details: [], status: [],
  };
  const num: Record<'paidIn' | 'withdrawn' | 'balance', string[]> = { paidIn: [], withdrawn: [], balance: [] };

  const numericCols = columns.filter((c) => c.key === 'paidIn' || c.key === 'withdrawn' || c.key === 'balance');
  const textCols = columns.filter((c) => c.key !== 'paidIn' && c.key !== 'withdrawn' && c.key !== 'balance');
  const numericStart = Math.min(...numericCols.map((c) => c.x));

  for (const it of row.items) {
    const s = it.str.trim();
    if (AMOUNT_RE.test(s) && it.x + it.width > numericStart - COL_TOLERANCE) {
      num[nearestColumn(it, numericCols).key as 'paidIn' | 'withdrawn' | 'balance'].push(s);
      continue;
    }
    let target = textCols[0];
    for (const c of textCols) if (c.x <= it.x + COL_TOLERANCE) target = c;
    text[target.key as keyof typeof text].push(it);
  }

  const amount = (v: string[]) => (v.length ? parseAmount(v.join('')) : 0);
  return {
    receipt: joinItems(text.receipt),
    time: joinItems(text.time),
    details: joinItems(text.details),
    status: joinItems(text.status),
    paidIn: amount(num.paidIn),
    withdrawn: amount(num.withdrawn),
    balance: num.balance.length ? parseAmount(num.balance.join('')) : null,
  };
}

/** Column whose header span overlaps the item most; falls back to nearest centre. */
function nearestColumn(it: TextItem, cols: Column[]): Column {
  let best = cols[0];
  let bestOverlap = -Infinity;
  for (const c of cols) {
    const overlap = Math.min(it.x + it.width, c.x2) - Math.max(it.x, c.x);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = c;
    }
  }
  if (bestOverlap > 0) return best;
  const centre = it.x + it.width / 2;
  return cols.reduce((a, c) => (Math.abs((c.x + c.x2) / 2 - centre) < Math.abs((a.x + a.x2) / 2 - centre) ? c : a));
}

/** Join fragments of one cell, inserting a space only where there is a visible gap. */
function joinItems(items: TextItem[]): string {
  let out = '';
  let prevEnd = 0;
  for (const it of items) {
    if (out && !out.endsWith(' ') && !it.str.startsWith(' ') && it.x - prevEnd > 1.5) out += ' ';
    out += it.str;
    prevEnd = it.x + it.width;
  }
  return out;
}

const joinText = (a: string, b: string) => (b.trim() ? `${a} ${b}` : a);

/**
 * A continuation line only ever carries wrapped text. If it has amounts or a
 * fragment in the receipt column it is something else (footer / next section).
 */
function isContinuation(c: Cells): boolean {
  if (c.receipt.trim() || c.paidIn || c.withdrawn || c.balance !== null) return false;
  return Boolean(c.time.trim() || c.details.trim() || c.status.trim());
}

/**
 * Sanity check used to warn about column mix-ups: each balance should equal the
 * previous balance +/- the row's amounts. Statements are chronological in one
 * direction; try both and count the better one. Fuliza and failed transactions
 * can legitimately break a few links, so this only ever produces a warning.
 */
function balanceMismatches(txns: ParsedTransaction[]): number {
  const rows = txns.filter((t) => t.balance !== null);
  if (rows.length < 2) return 0;
  const count = (list: ParsedTransaction[]) => {
    let bad = 0;
    for (let i = 1; i < list.length; i++) {
      const expected = (list[i - 1].balance as number) + list[i].paidIn - list[i].withdrawn;
      if (Math.abs(expected - (list[i].balance as number)) > 1) bad++;
    }
    return bad;
  };
  return Math.min(count(rows), count([...rows].reverse()));
}

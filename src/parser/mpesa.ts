/**
 * M-PESA statement parser (pure, no I/O).
 *
 * Input:  positioned text fragments extracted from the statement PDF
 *         (see ./pdf.ts, which produces them with pdf.js).
 * Output: normalised transactions ready to be stored in SQLite.
 *
 * WHY POSITIONS? A PDF has no "table" object, only glyph runs placed at (x, y).
 * mpesa2csv solves this with Tabula (table detection). Here we do the same job
 * ourselves, which is what makes the parser fully offline and testable:
 *   1. Group fragments into visual rows by their y coordinate.
 *   2. Find the header row ("Receipt No", "Completion Time", "Details", ...).
 *      The header gives the column ORDER and a rough position, but NOT exact
 *      alignment: in real statements the header labels are centred over their
 *      columns while the data is left- or right-aligned, so header x is only a
 *      hint.
 *   3. Classify each fragment by its CONTENT (receipt no., timestamp, status
 *      word, amount) and learn where the three amount columns really are by
 *      clustering the right edges of the numbers in the data rows.
 *   4. Rebuild each transaction: a row starting with a receipt number begins a
 *      transaction; following rows without one are wrapped "Details" lines.
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
  | 'fuliza' // overdraft draw or repayment (borrowing, not income or spending)
  | 'savings' // M-Shwari, KCB M-PESA, lock savings, ...
  | 'reversal'
  | 'other';

export interface ParsedTransaction {
  /**
   * M-PESA receipt number. NOT unique on its own: a payment and its transaction
   * fee are separate rows that share one receipt number and timestamp.
   */
  receipt: string;
  /** Local time, "YYYY-MM-DD HH:mm:ss" (sortable as plain text). */
  completedAt: string;
  details: string;
  status: string;
  /** Money in, in cents (KES * 100). Integers avoid float rounding drift. */
  paidIn: number;
  /** Money out, in cents. Always positive (the PDF prints it as a negative). */
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
  /**
   * Cross-check of our sums against the statement's own "TOTAL" row:
   * 'match' (exact to the cent), 'mismatch', or 'absent' (no summary found).
   * 'match' is strong evidence that every row and amount was read correctly.
   */
  totalsCheck: 'match' | 'mismatch' | 'absent';
  /** Rows whose balance does not follow from the previous balance (see balanceMismatches). */
  balanceGaps: number;
}

// ---------------------------------------------------------------- constants

/** Receipt numbers are 10 upper-case alphanumerics, e.g. "SGH1A2B3C4". */
const RECEIPT_RE = /^[A-Z0-9]{10}$/;
/** "1,234.50", "-22.00", "(22.00)". */
const AMOUNT_RE = /^-?\(?[\d,]+\.\d{2}\)?$/;
/** A completion time as one fragment ("2026-03-15 14:22:10") or split into date / time parts. */
const TIME_RE =
  /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$|^\d{1,2}:\d{2}(?::\d{2})?$/;
const STATUS_RE = /^(?:completed|failed|pending|cancelled|canceled|reversed|success(?:ful)?)$/i;
/** Items whose y differ by less than this belong to the same visual row. */
const ROW_TOLERANCE = 3;
/** Header labels can wrap onto a second line; look this far below the first. */
const HEADER_BAND = 14;
/** Right edges of amounts in one column differ by less than this. */
const CLUSTER_GAP = 6;
/** An amount must end this close to a learned column edge to count as that column. */
const AMOUNT_SNAP = 12;
/** Slack when deciding whether a wrapped line starts where Details text starts. */
const DETAILS_TOLERANCE = 6;

type ColKey = 'receipt' | 'time' | 'details' | 'status' | 'paidIn' | 'withdrawn' | 'balance';
type NumKey = 'paidIn' | 'withdrawn' | 'balance';

/** Header keyword -> column. Unanchored: a fragment may contain several headers. */
const HEADER_MATCHERS: Array<[ColKey, RegExp]> = [
  ['receipt', /receipt/i],
  ['time', /completion/i],
  ['details', /details/i],
  ['status', /(?:transaction\s+)?status/i],
  ['paidIn', /paid\s*in/i],
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

interface PageRows {
  rows: Row[];
  /** Index of the first row after the header (0 on pages without a repeated header). */
  dataStart: number;
}

/** Everything read from one row, before we know whether it starts a transaction. */
interface Cells {
  receipt: string;
  time: string;
  details: string;
  status: string;
  paidIn: number;
  withdrawn: number;
  balance: number | null;
  /** How many amount fragments were recognised (0.00 counts, unlike a zero sum). */
  amounts: number;
  /** Left edge of the row's Details text, Infinity when it has none. */
  detailsX: number;
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

// ------------------------------------------------------------------- public

export function parseStatement(items: TextItem[]): ParseResult {
  const warnings: string[] = [];

  // ---- pass 1: rows per page, and the header (column order + rough positions)
  const pages: PageRows[] = [];
  let columns: Column[] | null = null; // first header found; reused on pages without one
  const pageNumbers = [...new Set(items.map((i) => i.page))].sort((a, b) => a - b);
  for (const page of pageNumbers) {
    const rows = groupRows(items.filter((i) => i.page === page));
    const headerIdx = rows.findIndex(isHeaderRow);
    if (headerIdx >= 0) {
      const found = readColumns(rows, headerIdx);
      if (found) {
        columns ??= found.columns;
        pages.push({ rows, dataStart: found.nextRow });
      }
    } else if (columns) {
      pages.push({ rows, dataStart: 0 }); // continuation page without a repeated header
    }
    // else: cover page / summary before the first table
  }

  const headerFound = columns !== null;
  if (!columns) {
    warnings.push(
      'Could not find the transaction table header (Receipt No / Details / Balance). ' +
        'Is this an M-PESA full statement PDF?',
    );
    return { transactions: [], warnings, headerFound, totalsCheck: 'absent', balanceGaps: 0 };
  }

  // ---- learn the layout from the data rows themselves
  const timeCol = columns.find((c) => c.key === 'time') ?? columns.find((c) => c.key === 'details');
  /** The receipt is the leftmost cell; anything at/after the time column is not a receipt. */
  const receiptLimitX = timeCol ? timeCol.x : Infinity;
  const dataRows = pages.flatMap((p) => p.rows.slice(p.dataStart)).filter((r) => !isHeaderRow(r));
  const receiptRows = dataRows.filter((r) => startsTransaction(r, receiptLimitX));
  const amountColumns = learnAmountColumns(receiptRows, columns);
  const detailsX = learnDetailsX(receiptRows, columns);

  // ---- pass 2: rebuild transactions
  const rawList: RawTxn[] = [];
  let current: RawTxn | null = null;
  const flush = () => {
    if (current) rawList.push(current);
    current = null;
  };

  for (const { rows, dataStart } of pages) {
    for (const row of rows.slice(dataStart)) {
      if (isHeaderRow(row)) continue; // repeated header mid-page
      const cells = readRow(row, amountColumns, startsTransaction(row, receiptLimitX));

      if (cells.receipt) {
        flush();
        current = {
          receipt: cells.receipt,
          time: cells.time,
          details: cells.details,
          status: cells.status,
          paidIn: cells.paidIn,
          withdrawn: cells.withdrawn,
          balance: cells.balance,
        };
      } else if (current && isContinuation(cells, detailsX)) {
        // A wrapped cell: glue the text to whatever the transaction has so far.
        current.time = joinText(current.time, cells.time);
        current.details = joinText(current.details, cells.details);
        current.status = joinText(current.status, cells.status);
      } else if (cells.amounts > 0 || cells.details || cells.time || cells.status) {
        // Footer, disclaimer or summary block: the table has ended.
        flush();
      }
    }
  }
  flush();

  const transactions: ParsedTransaction[] = [];
  for (const raw of rawList) {
    const t = finish(raw, warnings);
    if (t) transactions.push(t);
  }

  if (transactions.length === 0) {
    warnings.push('Found the table header but no transaction rows.');
    return { transactions, warnings, headerFound, totalsCheck: 'absent', balanceGaps: 0 };
  }

  // Integrity checks. The statement prints its own totals; if our sums equal
  // them to the cent, every row and amount was read correctly.
  const summary = readSummaryTotals(pages, columns);
  let totalsCheck: ParseResult['totalsCheck'] = 'absent';
  if (summary) {
    const paidIn = transactions.reduce((s, t) => s + t.paidIn, 0);
    const paidOut = transactions.reduce((s, t) => s + t.withdrawn, 0);
    totalsCheck = paidIn === summary.paidIn && paidOut === summary.paidOut ? 'match' : 'mismatch';
    if (totalsCheck === 'mismatch') {
      warnings.push(
        `Parsed totals (in ${(paidIn / 100).toFixed(2)}, out ${(paidOut / 100).toFixed(2)}) differ from the ` +
          `statement summary (in ${(summary.paidIn / 100).toFixed(2)}, out ${(summary.paidOut / 100).toFixed(2)}). ` +
          'Some rows may have been missed or read from the wrong column.',
      );
    }
  }

  // The balance chain is a weaker check (statements can contain unlisted
  // adjustments), so a few gaps are only worth a warning when the totals did
  // not already confirm the parse.
  const balanceGaps = balanceMismatches(transactions);
  if (balanceGaps > 0 && (totalsCheck !== 'match' || balanceGaps > transactions.length * 0.02)) {
    warnings.push(
      `${balanceGaps} of ${transactions.length} rows do not reconcile with the running balance. ` +
        'Amounts may be in the wrong column; check the Transactions tab.',
    );
  }
  return { transactions, warnings, headerFound, totalsCheck, balanceGaps };
}

/**
 * The statement's SUMMARY block ends with a row "TOTAL: <paid in> <paid out>"
 * above the transaction table. Returns those two amounts in cents, if present.
 */
function readSummaryTotals(pages: PageRows[], columns: Column[]): { paidIn: number; paidOut: number } | null {
  void columns;
  for (const { rows, dataStart } of pages) {
    // Only look above the table: everything before the header row on the first page
    // that has one. (dataStart is 0 on continuation pages, which have no summary.)
    if (dataStart === 0) continue;
    for (const row of rows.slice(0, dataStart)) {
      if (!/^total:?$/i.test(firstText(row))) continue;
      const amounts = row.items.map((i) => i.str.trim()).filter((s) => AMOUNT_RE.test(s));
      if (amounts.length >= 2) return { paidIn: parseAmount(amounts[0]), paidOut: parseAmount(amounts[1]) };
    }
    return null;
  }
  return null;
}

/** Classify a Details string into a coarse transaction type. Exported for tests. */
export function classify(details: string, paidIn: number): TxnType {
  const d = details.toLowerCase();
  if (/\b(charge|fee)\b/.test(d)) return 'fee';
  // Fuliza is M-PESA's overdraft, i.e. borrowed money. Only the borrowing itself
  // ("OverDraft of Credit Party" = money drawn) and its repayment ("OD Loan
  // Repayment") are 'fuliza'. A payment merely FUNDED by Fuliza ("Customer
  // Transfer Fuliza MPesa to ...") is an ordinary payment: it falls through to
  // send / till / paybill below so you still see what the money was spent on.
  if (/overdraft|\bod loan\b|fuliza\s+(?:loan\s+)?repay|repayment of fuliza/.test(d)) return 'fuliza';
  if (/reversal/.test(d)) return 'reversal';
  if (/airtime|recharge|bundle purchase|data bundle/.test(d)) return 'airtime';
  if (/m-?shwari|kcb m-?pesa|lock savings|ziidi|mali\b/.test(d)) return 'savings';
  if (/pay ?bill|card pay/.test(d)) return 'paybill';
  if (/merchant payment|buy goods|small business/.test(d)) return 'till';
  if (/withdraw/.test(d)) return 'withdraw';
  if (/\bdeposit\b/.test(d)) return 'deposit';
  if (/customer transfer|customer send money/.test(d)) return 'send';
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

function finish(raw: RawTxn, warnings: string[]): ParsedTransaction | null {
  const completedAt = parseDateTime(raw.time);
  if (!completedAt) {
    warnings.push(`Skipped ${raw.receipt}: unreadable completion time "${raw.time.trim()}".`);
    return null;
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

const firstText = (r: Row) => (r.items[0]?.str ?? '').trim();

/** A row starts a transaction when its leftmost fragment is a receipt number in the receipt column. */
function startsTransaction(r: Row, receiptLimitX: number): boolean {
  const first = r.items[0];
  return !!first && RECEIPT_RE.test(first.str.trim()) && first.x < receiptLimitX;
}

/**
 * Locate each column from the header. Header labels may wrap ("Paid" / "in"),
 * so rows within HEADER_BAND below the first header row are scanned as well.
 * Returns the columns and the index of the first data row.
 */
function readColumns(rows: Row[], headerIdx: number): { columns: Column[]; nextRow: number } | null {
  const band: Row[] = [rows[headerIdx]];
  let next = headerIdx + 1;
  while (
    next < rows.length &&
    rows[headerIdx].y - rows[next].y <= HEADER_BAND &&
    !RECEIPT_RE.test(firstText(rows[next]))
  ) {
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

/** Right edges of numbers in one column are (almost) identical; merge close values. */
function clusterEdges(edges: number[]): number[] {
  const sorted = [...edges].sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const e of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && e - last[last.length - 1] <= CLUSTER_GAP) last.push(e);
    else clusters.push([e]);
  }
  return clusters.map((c) => c.reduce((s, v) => s + v, 0) / c.length);
}

/**
 * Work out where the Paid in / Withdrawn / Balance numbers really sit.
 *
 * Amounts are right-aligned, so the right edges of one column's numbers line
 * up. We cluster those edges over all transaction rows and take the three
 * rightmost clusters as [Paid in, Withdrawn, Balance] (Balance is always the
 * rightmost). If a column is never used (e.g. a statement with no money in),
 * fewer clusters exist: Balance is still the rightmost, and any other cluster
 * is matched to the nearer of the remaining headers after shifting the header
 * centres by the offset observed on the Balance column (data is right-aligned
 * a fixed distance from where the centred header sits).
 */
function learnAmountColumns(receiptRows: Row[], columns: Column[]): Record<NumKey, number | undefined> {
  const edges: number[] = [];
  for (const r of receiptRows) {
    for (const it of r.items) if (AMOUNT_RE.test(it.str.trim())) edges.push(it.x + it.width);
  }
  const map: Record<NumKey, number | undefined> = { paidIn: undefined, withdrawn: undefined, balance: undefined };
  const clusters = clusterEdges(edges).slice(-3);
  if (clusters.length === 0) return map;

  const centre = (k: NumKey) => {
    const c = columns.find((col) => col.key === k);
    return c ? (c.x + c.x2) / 2 : 0;
  };
  // Paid in and Withdrawn ordered as they appear in the header.
  const others = (['paidIn', 'withdrawn'] as NumKey[]).sort((a, b) => centre(a) - centre(b));

  map.balance = clusters[clusters.length - 1];
  const rest = clusters.slice(0, -1);
  if (rest.length === 2) {
    map[others[0]] = rest[0];
    map[others[1]] = rest[1];
  } else if (rest.length === 1) {
    const offset = map.balance - centre('balance');
    const nearest = others.reduce((a, b) =>
      Math.abs(rest[0] - (centre(a) + offset)) <= Math.abs(rest[0] - (centre(b) + offset)) ? a : b,
    );
    map[nearest] = rest[0];
  }
  return map;
}

/** Median left edge of the Details text in transaction rows (falls back to the header). */
function learnDetailsX(receiptRows: Row[], columns: Column[]): number {
  const xs: number[] = [];
  for (const r of receiptRows) {
    const frags = r.items.slice(1).filter((it) => {
      const s = it.str.trim();
      return !TIME_RE.test(s) && !STATUS_RE.test(s) && !AMOUNT_RE.test(s);
    });
    if (frags.length) xs.push(frags[0].x);
  }
  if (xs.length === 0) return columns.find((c) => c.key === 'details')?.x ?? 0;
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)];
}

/**
 * Read one row by content. `isStart` says whether the leftmost fragment is the
 * receipt number of a new transaction.
 */
function readRow(row: Row, amountColumns: Record<NumKey, number | undefined>, isStart: boolean): Cells {
  const cells: Cells = {
    receipt: '', time: '', details: '', status: '',
    paidIn: 0, withdrawn: 0, balance: null, amounts: 0, detailsX: Infinity,
  };
  const detailsParts: TextItem[] = [];
  const timeParts: string[] = [];

  row.items.forEach((it, idx) => {
    const s = it.str.trim();
    if (idx === 0 && isStart) {
      cells.receipt = s;
    } else if (TIME_RE.test(s)) {
      timeParts.push(s);
    } else if (STATUS_RE.test(s)) {
      cells.status = joinText(cells.status, s);
    } else if (AMOUNT_RE.test(s)) {
      const key = snapAmount(it, amountColumns);
      if (key) {
        cells.amounts++;
        const cents = parseAmount(s);
        if (key === 'balance') cells.balance = cents;
        else cells[key] = cents;
      } else {
        detailsParts.push(it); // a number-looking word inside the Details text
      }
    } else {
      detailsParts.push(it);
    }
  });

  cells.time = timeParts.join(' ');
  cells.details = joinItems(detailsParts);
  if (detailsParts.length) cells.detailsX = detailsParts[0].x;
  return cells;
}

/** Which amount column a fragment belongs to, judged by its right edge; undefined if none is close. */
function snapAmount(it: TextItem, cols: Record<NumKey, number | undefined>): NumKey | undefined {
  const edge = it.x + it.width;
  let best: NumKey | undefined;
  let bestDist = AMOUNT_SNAP;
  for (const k of ['paidIn', 'withdrawn', 'balance'] as NumKey[]) {
    const c = cols[k];
    if (c === undefined) continue;
    const d = Math.abs(edge - c);
    if (d <= bestDist) {
      bestDist = d;
      best = k;
    }
  }
  return best;
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

const joinText = (a: string, b: string) => (b.trim() ? (a ? `${a} ${b}` : b) : a);

/**
 * A continuation line only ever carries wrapped Details (or a wrapped time). If
 * it has amounts, or its text starts left of where Details text starts (a
 * footer such as "Page 3 of 25" at the left margin), it is something else.
 */
function isContinuation(c: Cells, detailsX: number): boolean {
  if (c.amounts > 0 || c.receipt) return false;
  if (!c.time && !c.details && !c.status) return false;
  if (c.details && c.detailsX < detailsX - DETAILS_TOLERANCE) return false;
  return true;
}

/**
 * Sanity check used to warn about column mix-ups: each balance should equal
 * the previous balance plus the row's movement. Rows sharing a timestamp (a
 * payment and its fee, all in the same second) have no reliable order inside
 * the statement, so we compare whole same-second GROUPS: the group's net
 * movement must carry some balance of the previous group to some balance of
 * this group. Returns the number of rows in groups that fail. Fuliza and
 * failed transactions can legitimately break a few links, so this only ever
 * produces a warning.
 */
function balanceMismatches(txns: ParsedTransaction[]): number {
  let rows = txns.filter((t) => t.balance !== null);
  if (rows.length < 2) return 0;
  // Statements list newest first (or oldest first); put them oldest first.
  if (rows[0].completedAt > rows[rows.length - 1].completedAt) rows = [...rows].reverse();

  const groups: ParsedTransaction[][] = [];
  for (const t of rows) {
    const last = groups[groups.length - 1];
    if (last && last[0].completedAt === t.completedAt) last.push(t);
    else groups.push([t]);
  }

  let bad = 0;
  for (let i = 1; i < groups.length; i++) {
    const before = groups[i - 1].map((t) => t.balance as number);
    const after = groups[i].map((t) => t.balance as number);
    const delta = groups[i].reduce((s, t) => s + t.paidIn - t.withdrawn, 0);
    const ok = before.some((p) => after.includes(p + delta));
    if (!ok) bad += groups[i].length;
  }
  return bad;
}

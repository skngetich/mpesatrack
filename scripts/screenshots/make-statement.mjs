/**
 * Builds a FAKE M-PESA statement PDF from ./fixture.mjs, laid out like the real
 * thing (column geometry taken from src/parser/mpesa.real-layout.test.ts):
 * centred header labels over left/right-aligned data, newest rows first, a
 * payment and its fee sharing one receipt number, wrapped Details lines, a
 * SUMMARY block with a TOTAL row, and a repeated header on every page.
 *
 * Usage: node scripts/screenshots/make-statement.mjs [out.pdf]
 * The file is unencrypted (pdf-lib cannot encrypt); the password flow is
 * covered by unit tests instead.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { CUSTOMER, EVENTS, OPENING_BALANCE } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = resolve(HERE, '.out', 'demo-statement.pdf');

// ------------------------------------------------------------------ geometry
const PAGE = { w: 595, h: 842 };
const SIZE = 6.5; // font size of table text
const X = { receipt: 38, time: 108, details: 177, status: 282 };
const RIGHT = { paidIn: 417, withdrawn: 487, balance: 557 };
const DETAILS_MAX_W = 98;
const LINE = 8; // wrapped line pitch
const ROW_GAP = 9; // space between transactions
const BOTTOM = 70; // last row must stay above this
const HEADERS = [
  ['Receipt No.', 51],
  ['Completion Time', 111],
  ['Details', 216],
  ['Transaction Status', 282],
  ['Paid In', 373],
  ['Withdrawn', 436],
  ['Balance', 510],
];

// ------------------------------------------------------------------- helpers
/** Deterministic PRNG so receipts are stable between runs. */
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260911);
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
const receipt = (month) => (month === '09' ? 'TI' : 'TJ') + Array.from({ length: 8 }, () => ALNUM[Math.floor(rand() * ALNUM.length)]).join('');

const money = (kes) => kes.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Oldest-first list of statement rows with running balances (in cents to avoid drift). */
function buildRows() {
  const rows = [];
  let bal = Math.round(OPENING_BALANCE * 100);
  for (const [date, time, e] of EVENTS) {
    const completedAt = `2026-${date} ${time}`;
    const r = receipt(date.slice(0, 2));
    const push = (details, inKes, outKes) => {
      bal += Math.round((inKes ?? 0) * 100) - Math.round((outKes ?? 0) * 100);
      if (bal < 0) throw new Error(`Balance went negative at ${completedAt} (${details}); fix the fixture.`);
      rows.push({ receipt: r, completedAt, details, paidIn: inKes, withdrawn: outKes, balance: bal / 100 });
    };
    push(e.details, e.in, e.out);
    if (e.fee) push(e.feeDetails, undefined, e.fee);
  }
  return rows;
}

function wrap(font, text, maxW) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, SIZE) > maxW) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

// ---------------------------------------------------------------------- main
export async function makeStatement(out = DEFAULT_OUT) {
  const rows = buildRows();
  const totalIn = rows.reduce((s, r) => s + (r.paidIn ?? 0), 0);
  const totalOut = rows.reduce((s, r) => s + (r.withdrawn ?? 0), 0);

  const pdf = await PDFDocument.create();
  pdf.setTitle('M-PESA Statement (demo)');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const grey = rgb(0.35, 0.35, 0.35);

  let page;
  const text = (s, x, y, f = font, size = SIZE, color) => page.drawText(s, { x, y, size, font: f, color });
  const right = (s, edge, y) => text(s, edge - font.widthOfTextAtSize(s, SIZE), y);
  const header = (y) => {
    for (const [label, x] of HEADERS) text(label, x, y, bold);
    page.drawLine({ start: { x: 36, y: y - 4 }, end: { x: 560, y: y - 4 }, thickness: 0.5, color: grey });
  };
  const pages = [];
  const newPage = () => {
    page = pdf.addPage([PAGE.w, PAGE.h]);
    pages.push(page);
  };

  // ---- page 1: title, customer, SUMMARY with TOTAL
  newPage();
  text('M-PESA STATEMENT', 38, 800, bold, 14);
  text('DEMO DATA - NOT A REAL STATEMENT', 360, 803, bold, 8, rgb(0.75, 0.1, 0.1));
  text(`Customer Name: ${CUSTOMER.name}`, 38, 780, font, 8);
  text(`Mobile Number: ${CUSTOMER.phone}`, 38, 768, font, 8);
  text(`Statement Period: ${CUSTOMER.period}`, 38, 756, font, 8);
  text(`Opening Balance: ${money(OPENING_BALANCE)}`, 38, 744, font, 8);

  text('SUMMARY', 38, 716, bold, 8);
  text('TRANSACTION TYPE', 38, 702, bold); text('PAID IN', 389, 702, bold); text('PAID OUT', 490, 702, bold);
  let y = 688;
  const kinds = [
    ['SEND MONEY:', (r) => /^Customer Transfer/.test(r.details)],
    ['PAY BILL:', (r) => /^Pay Bill/.test(r.details)],
    ['MERCHANT PAYMENT:', (r) => /^Merchant Payment/.test(r.details)],
    ['AGENT WITHDRAWAL:', (r) => /^Customer Withdrawal/.test(r.details)],
  ];
  for (const [label, test] of kinds) {
    const sel = rows.filter(test);
    text(label, 38, y);
    right(money(sel.reduce((s, r) => s + (r.paidIn ?? 0), 0)), 415, y);
    right(money(sel.reduce((s, r) => s + (r.withdrawn ?? 0), 0)), 520, y);
    y -= 12;
  }
  text('TOTAL:', 38, y, bold);
  right(money(totalIn), 415, y);
  right(money(totalOut), 520, y);

  text('DETAILED STATEMENT', 38, y - 30, bold, 8);
  y -= 50;
  header(y);
  y -= 16;

  // ---- table, newest first
  for (const r of [...rows].reverse()) {
    const lines = wrap(font, r.details, DETAILS_MAX_W);
    const height = (lines.length - 1) * LINE;
    if (y - height < BOTTOM) {
      newPage();
      y = 790;
      header(y);
      y -= 16;
    }
    text(r.receipt, X.receipt, y);
    text(r.completedAt, X.time, y);
    text(lines[0], X.details, y);
    text('Completed', X.status, y);
    if (r.paidIn) right(money(r.paidIn), RIGHT.paidIn, y);
    if (r.withdrawn) right(`-${money(r.withdrawn)}`, RIGHT.withdrawn, y);
    right(money(r.balance), RIGHT.balance, y);
    for (let i = 1; i < lines.length; i++) text(lines[i], X.details, y - i * LINE);
    y -= height + LINE + ROW_GAP;
  }

  pages.forEach((p, i) => {
    page = p;
    text(`Page ${i + 1} of ${pages.length}`, 38, 40, font, 7, grey);
    text('Disclaimer: demo statement generated for MpesaTrack screenshots. All data is fictional.', X.details, 30, font, 6, grey);
  });

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, await pdf.save());
  return { out, rows: rows.length, pages: pages.length, totalIn, totalOut };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const res = await makeStatement(process.argv[2] ? resolve(process.argv[2]) : undefined);
  console.log(`Wrote ${res.out}: ${res.rows} rows on ${res.pages} page(s), in ${money(res.totalIn)}, out ${money(res.totalOut)}`);
}

import { describe, expect, it } from 'vitest';
import {
  classify,
  extractCounterparty,
  parseAmount,
  parseDateTime,
  parseStatement,
  type TextItem,
} from './mpesa';

// ---- a tiny statement "renderer" that mimics the real column layout ---------

// Header start x per column. Amount columns are right-aligned to x2.
const COL = { receipt: 30, time: 100, details: 190, status: 380, paidIn: 440, withdrawn: 500, balance: 560 };
const RIGHT = { paidIn: 490, withdrawn: 550, balance: 610 };

let page = 1;
const item = (str: string, x: number, y: number, width = str.length * 4): TextItem => ({ str, x, y, width, page });

function header(y: number): TextItem[] {
  return [
    item('Receipt No.', COL.receipt, y),
    item('Completion Time', COL.time, y),
    item('Details', COL.details, y),
    item('Transaction Status', COL.status, y),
    item('Paid in', COL.paidIn, y, 40),
    item('Withdrawn', COL.withdrawn, y, 45),
    item('Balance', COL.balance, y, 40),
  ];
}

function row(
  y: number,
  r: { receipt: string; time: string; details: string; status?: string; paidIn?: string; withdrawn?: string; balance: string },
): TextItem[] {
  const out = [
    item(r.receipt, COL.receipt, y),
    item(r.time, COL.time, y),
    item(r.details, COL.details, y),
    item(r.status ?? 'Completed', COL.status, y),
    item(r.balance, RIGHT.balance - r.balance.length * 4, y),
  ];
  if (r.paidIn) out.push(item(r.paidIn, RIGHT.paidIn - r.paidIn.length * 4, y));
  if (r.withdrawn) out.push(item(r.withdrawn, RIGHT.withdrawn - r.withdrawn.length * 4, y));
  return out;
}

function samplePage(): TextItem[] {
  page = 1;
  return [
    item('MPESA FULL STATEMENT', 30, 800), // cover text above the table must be ignored
    ...header(700),
    ...row(680, { receipt: 'SGH1A2B3C4', time: '2024-03-15 14:22:10', details: 'Customer Transfer to - 2547*****123 JOHN DOE', withdrawn: '1,000.00', balance: '4,000.00' }),
    ...row(665, { receipt: 'SGH1A2B3C5', time: '2024-03-15 14:22:10', details: 'Customer Transfer Fee', withdrawn: '22.00', balance: '3,978.00' }),
    ...row(650, { receipt: 'SGH1A2B3C6', time: '2024-03-16 09:01:00', details: 'Merchant Payment to 5123456 - KFC', withdrawn: '850.00', balance: '3,128.00' }),
    // long details wrap onto a second line with no receipt
    ...row(635, { receipt: 'SGH1A2B3C7', time: '2024-03-17 10:00:00', details: 'Pay Bill to 247247 - Equity Bulk Account', withdrawn: '500.00', balance: '2,628.00' }),
    item('Acc. 0123456789', COL.details, 625),
    ...row(610, { receipt: 'SGH1A2B3C8', time: '2024-03-18 08:30:00', details: 'Funds received from - 2547*****999 JANE ROE', paidIn: '10,000.00', balance: '12,628.00' }),
    item('Page 1 of 1', COL.receipt, 40), // footer must not be glued onto the last transaction
    item('Disclaimer: this statement is system generated', COL.details, 30),
  ];
}

describe('parseStatement', () => {
  it('rebuilds transactions with correct columns and amounts', () => {
    const { transactions, headerFound, warnings } = parseStatement(samplePage());
    expect(headerFound).toBe(true);
    expect(warnings).toEqual([]);
    expect(transactions).toHaveLength(5);

    const [send, fee, till, bill, income] = transactions;
    expect(send).toMatchObject({ receipt: 'SGH1A2B3C4', completedAt: '2024-03-15 14:22:10', withdrawn: 100000, paidIn: 0, balance: 400000, type: 'send', counterparty: 'JOHN DOE' });
    expect(fee).toMatchObject({ withdrawn: 2200, type: 'fee' });
    expect(till).toMatchObject({ type: 'till', counterparty: 'KFC' });
    expect(bill).toMatchObject({ type: 'paybill', counterparty: 'Equity Bulk Account' });
    expect(income).toMatchObject({ paidIn: 1000000, withdrawn: 0, type: 'received', counterparty: 'JANE ROE' });
  });

  it('appends wrapped continuation lines to Details but ignores footers', () => {
    const { transactions } = parseStatement(samplePage());
    expect(transactions[3].details).toBe('Pay Bill to 247247 - Equity Bulk Account Acc. 0123456789');
    expect(transactions[4].details).not.toMatch(/Page|Disclaimer/);
  });

  it('reuses the header columns on later pages that have none', () => {
    const p1 = samplePage();
    const p2 = row(700, { receipt: 'SGH1A2B3D1', time: '2024-03-19 12:00:00', details: 'Airtime Purchase', withdrawn: '100.00', balance: '12,528.00' }).map((i) => ({ ...i, page: 2 }));
    const { transactions } = parseStatement([...p1, ...p2]);
    expect(transactions).toHaveLength(6);
    expect(transactions[5]).toMatchObject({ receipt: 'SGH1A2B3D1', type: 'airtime', withdrawn: 10000 });
  });

  it('warns when the balance chain does not reconcile', () => {
    const items = [
      ...header(700),
      ...row(680, { receipt: 'AAAAAAAAA1', time: '2024-01-01 10:00:00', details: 'Customer Transfer to - 2547*****1 A', withdrawn: '100.00', balance: '900.00' }),
      ...row(665, { receipt: 'AAAAAAAAA2', time: '2024-01-01 11:00:00', details: 'Customer Transfer to - 2547*****1 B', withdrawn: '100.00', balance: '500.00' }),
    ];
    expect(parseStatement(items).warnings.join(' ')).toMatch(/reconcile/);
  });

  it('copes with pdf.js fusing neighbouring header cells into one fragment', () => {
    // Real-world regression: "Transaction Status" and "Paid in" arrived as ONE
    // item, so the Paid-in column used to go missing and parsing failed.
    const fused = header(700).filter((i) => i.str !== 'Transaction Status' && i.str !== 'Paid in');
    fused.push(item('Transaction Status Paid in', COL.status, 700, 110));
    const { transactions, headerFound } = parseStatement([
      ...fused,
      ...row(680, { receipt: 'SGH1A2B3C4', time: '2024-03-15 14:22:10', details: 'Funds received from - 2547*****123 JANE ROE', paidIn: '10,000.00', balance: '10,000.00' }),
    ]);
    expect(headerFound).toBe(true);
    expect(transactions[0]).toMatchObject({ paidIn: 1000000, withdrawn: 0, status: 'Completed' });
  });

  it('reports a missing header instead of throwing', () => {
    const r = parseStatement([item('hello world', 10, 10)]);
    expect(r.headerFound).toBe(false);
    expect(r.transactions).toEqual([]);
    expect(r.warnings[0]).toMatch(/header/);
  });
});

describe('helpers', () => {
  it('parses amounts to cents', () => {
    expect(parseAmount('1,234.50')).toBe(123450);
    expect(parseAmount('-22.00')).toBe(2200);
    expect(parseAmount('')).toBe(0);
  });

  it('parses both date formats', () => {
    expect(parseDateTime('2024-03-15 14:22:10')).toBe('2024-03-15 14:22:10');
    expect(parseDateTime('15/03/2024 9:05:01')).toBe('2024-03-15 09:05:01');
    expect(parseDateTime('nonsense')).toBeNull();
  });

  it('classifies details', () => {
    expect(classify('Pay Bill Charge', 0)).toBe('fee');
    expect(classify('OverDraft of Credit Party', 0)).toBe('fuliza');
    expect(classify('Withdraw Cash at Agent', 0)).toBe('withdraw');
    expect(classify('Something odd', 500)).toBe('received');
  });

  it('extracts counterparties', () => {
    expect(extractCounterparty('Customer Payment to Small Business to - 2547*****111 MAMA MBOGA')).toBe('MAMA MBOGA');
    expect(extractCounterparty('Airtime Purchase')).toBe('');
  });
});

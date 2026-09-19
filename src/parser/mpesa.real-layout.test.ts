/**
 * Regression tests modelled on the geometry measured from a REAL M-PESA statement
 * (all numbers below are invented; only the layout is real):
 *
 *  - header labels are CENTRED over their columns, but data is left-aligned
 *    (Details text starts LEFT of the "Details" label) or right-aligned (amounts);
 *  - money out is printed as a negative number ("-1,000.00");
 *  - a payment and its transaction fee are separate rows sharing ONE receipt no.;
 *  - Fuliza (overdraft) shows up as "OverDraft of Credit Party" paid-in rows;
 *  - a SUMMARY block above the table ends with a TOTAL row we can check against;
 *  - rows are newest first.
 */
import { describe, expect, it } from 'vitest';
import { classify, parseStatement, type TextItem } from './mpesa';

const p = 1;
const item = (str: string, x: number, y: number, width: number): TextItem => ({ str, x, y, width, page: p });
const w = (s: string) => s.length * 4; // rough text width

// Column geometry from the real statement.
const HDR = { receipt: [51, 40], time: [111, 60], details: [216, 24], status: [282, 66], paidIn: [373, 24], withdrawn: [436, 38], balance: [510, 28] } as const;
const X = { receipt: 38, time: 108, details: 177, status: 282 };
const RIGHT = { paidIn: 417, withdrawn: 487, balance: 557 };

function header(y: number): TextItem[] {
  return [
    item('Receipt No.', HDR.receipt[0], y, HDR.receipt[1]),
    item('Completion Time', HDR.time[0], y, HDR.time[1]),
    item('Details', HDR.details[0], y, HDR.details[1]),
    item('Transaction Status', HDR.status[0], y, HDR.status[1]),
    item('Paid In', HDR.paidIn[0], y, HDR.paidIn[1]),
    item('Withdrawn', HDR.withdrawn[0], y, HDR.withdrawn[1]),
    item('Balance', HDR.balance[0], y, HDR.balance[1]),
  ];
}

const amount = (col: keyof typeof RIGHT, y: number, text: string) => item(text, RIGHT[col] - w(text), y, w(text));

function row(y: number, r: { receipt: string; time: string; details: string; in?: string; out?: string; bal: string }): TextItem[] {
  const out = [
    item(r.receipt, X.receipt, y, 37),
    item(r.time, X.time, y, 64),
    item(r.details, X.details, y, w(r.details)),
    item('Completed', X.status, y, 33),
    amount('balance', y, r.bal),
  ];
  if (r.in) out.push(amount('paidIn', y, r.in));
  if (r.out) out.push(amount('withdrawn', y, r.out)); // e.g. "-1,000.00"
  return out;
}

/** Summary block above the table, newest-first rows, and a footer. */
function statement(total: { in: string; out: string } = { in: '500.00', out: '1,322.00' }): TextItem[] {
  return [
    item('SUMMARY', 38, 660, 40),
    item('TRANSACTION TYPE', 38, 645, 80), item('PAID IN', 389, 645, 26), item('PAID OUT', 490, 645, 34),
    item('SEND MONEY:', 38, 630, 60), item('0.00', 400, 630, 20), item('300.00', 500, 630, 30),
    item('TOTAL:', 38, 615, 30), item(total.in, 380, 615, w(total.in)), item(total.out, 480, 615, w(total.out)),
    item('DETAILED STATEMENT', 38, 560, 90),
    ...header(508),
    // 11:00:00 group (payment and its fee share receipt DDDDDDDDD4); the wrapped 2nd line follows the payment
    ...row(498, { receipt: 'DDDDDDDDD4', time: '2026-09-19 11:00:00', details: 'Customer Transfer of Funds Charge', out: '-22.00', bal: '9,178.00' }),
    ...row(482, { receipt: 'DDDDDDDDD4', time: '2026-09-19 11:00:00', details: 'Customer Transfer to -', out: '-1,000.00', bal: '9,200.00' }),
    item('2547***123 JOHN DOE', X.details, 476, 80),
    // 10:00:00 group: a payment funded by Fuliza, and the Fuliza draw itself
    ...row(460, { receipt: 'CCCCCCCCC3', time: '2026-09-19 10:00:00', details: 'Customer Transfer Fuliza MPesa to -', out: '-300.00', bal: '10,200.00' }),
    // a wrapped line whose first word looks like a receipt number (10 capital letters)
    item('MUTHOMIWAN KAMAU', X.details, 454, 80),
    ...row(438, { receipt: 'BBBBBBBBB2', time: '2026-09-19 10:00:00', details: 'OverDraft of Credit Party', in: '500.00', bal: '10,500.00' }),
    item('Page 1 of 1', 38, 40, 40), // footer at the left margin
    item('Disclaimer text', X.details, 30, 60),
  ];
}

describe('real statement layout', () => {
  it('reads every row, even though headers are centred and data is not', () => {
    const r = parseStatement(statement());
    expect(r.headerFound).toBe(true);
    expect(r.transactions).toHaveLength(4);
    expect(r.transactions.map((t) => t.receipt)).toEqual(['DDDDDDDDD4', 'DDDDDDDDD4', 'CCCCCCCCC3', 'BBBBBBBBB2']);
  });

  it('puts Details text (which starts left of its header) in Details, not in the time column', () => {
    const [fee, pay] = parseStatement(statement()).transactions;
    expect(fee.details).toBe('Customer Transfer of Funds Charge');
    expect(pay.details).toBe('Customer Transfer to - 2547***123 JOHN DOE'); // wrapped line joined
    expect(pay.counterparty).toBe('JOHN DOE');
    expect(pay.completedAt).toBe('2026-09-19 11:00:00');
  });

  it('assigns right-aligned amounts to the right columns and stores money out as positive', () => {
    const [fee, pay, , draw] = parseStatement(statement()).transactions;
    expect(fee).toMatchObject({ withdrawn: 2200, paidIn: 0, balance: 917800 });
    expect(pay).toMatchObject({ withdrawn: 100000, paidIn: 0, balance: 920000 });
    expect(draw).toMatchObject({ paidIn: 50000, withdrawn: 0, balance: 1050000 });
  });

  it('keeps a payment and its fee as two rows with the same receipt', () => {
    const [fee, pay] = parseStatement(statement()).transactions;
    expect(fee.receipt).toBe(pay.receipt);
    expect(fee.type).toBe('fee');
    expect(pay.type).toBe('send');
  });

  it('does not mistake a capitalised name on a wrapped line for a receipt number', () => {
    const r = parseStatement(statement());
    expect(r.transactions).toHaveLength(4);
    expect(r.transactions[2].details).toContain('MUTHOMIWAN KAMAU');
  });

  it('does not glue the left-margin footer onto the last transaction', () => {
    const last = parseStatement(statement()).transactions[3];
    expect(last.details).toBe('OverDraft of Credit Party');
  });

  it("confirms the statement's own TOTAL row against the parsed sums", () => {
    const r = parseStatement(statement());
    expect(r.totalsCheck).toBe('match');
    expect(r.warnings).toEqual([]);
    expect(r.balanceGaps).toBe(0); // same-second rows are compared as groups
  });

  it('warns when the sums differ from the TOTAL row', () => {
    const r = parseStatement(statement({ in: '500.00', out: '9,999.00' }));
    expect(r.totalsCheck).toBe('mismatch');
    expect(r.warnings.join(' ')).toMatch(/differ from the statement summary/);
  });
});

describe('Fuliza is an overdraft', () => {
  it('classifies the draw and the repayment as fuliza (borrowing)', () => {
    expect(classify('OverDraft of Credit Party', 50000)).toBe('fuliza');
    expect(classify('OD Loan Repayment to 1234 - Fuliza', 0)).toBe('fuliza');
  });

  it('keeps payments merely funded by Fuliza as ordinary payments', () => {
    expect(classify('Customer Transfer Fuliza MPesa to - 2547***123 JANE', 0)).toBe('send');
    expect(classify('Merchant Payment Fuliza M-Pesa Online to 123 - KFC', 0)).toBe('till');
  });

  it('recognises the other phrases seen on real statements', () => {
    expect(classify('Card Pay Bill Online to 888 - X', 0)).toBe('paybill');
    expect(classify('Card Pay Utility with OD', 0)).toBe('paybill');
    expect(classify('Recharge for Customer to 2547***1', 0)).toBe('airtime');
    expect(classify('Customer Send Money to Micro finance', 0)).toBe('send');
    expect(classify('Receive International Transfer from X', 1000)).toBe('received');
  });
});

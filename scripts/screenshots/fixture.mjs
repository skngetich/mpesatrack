/**
 * Demo statement for the README / first-run screenshots. EVERYTHING here is
 * invented: names, phone numbers, till/paybill numbers, accounts and amounts.
 * Only the wording of the Details column follows real M-PESA statements, so
 * the real parser and categoriser treat it like the genuine article.
 *
 * Each entry is one M-PESA action, oldest first. `fee` adds a second row that
 * shares the receipt number and timestamp, exactly like a real statement.
 * Amounts are in KES.
 */

export const OPENING_BALANCE = 17_510;

export const CUSTOMER = { name: 'DEMO CUSTOMER', phone: '2547*****000', period: '01 Sep 2026 - 31 Oct 2026' };

const naivas = (amt) => ({ details: 'Merchant Payment to 5123456 - NAIVAS SUPERMARKET KILIMANI', out: amt });
const carrefour = (amt) => ({ details: 'Merchant Payment to 7100200 - CARREFOUR JUNCTION MALL', out: amt });
const uber = (amt) => ({ details: 'Merchant Payment to 8800123 - UBER BV NAIROBI', out: amt });
const bolt = (amt) => ({ details: 'Merchant Payment to 8811456 - BOLT OPERATIONS', out: amt });
const java = (amt) => ({ details: 'Merchant Payment to 6612345 - JAVA HOUSE VALLEY ARCADE', out: amt });
const airtime = (amt) => ({ details: 'Airtime Purchase', out: amt });
const bundle = (amt) => ({ details: 'Customer Bundle Purchase', out: amt });
const kplc = (amt) => ({ details: 'Pay Bill to 888880 - KPLC PREPAID Acc. 54100023456', out: amt, fee: 0 });
const send = (amt, who, fee) => ({ details: `Customer Transfer to - ${who}`, out: amt, fee, feeDetails: 'Customer Transfer of Funds Charge' });

/** [date "MM-DD", time "HH:MM:SS", entry] */
export const EVENTS = [
  // ---------------------------------------------------------------- September
  ['09-01', '08:12:41', airtime(100)],
  ['09-01', '19:03:10', naivas(2_340)],
  ['09-02', '07:48:22', uber(420)],
  ['09-03', '13:15:09', java(680)],
  ['09-04', '18:40:55', send(1_500, '2547*****821 JANE WANJIKU DOE', 23)],
  ['09-05', '09:30:00', kplc(1_000)],
  ['09-06', '11:20:36', carrefour(4_215)],
  ['09-07', '16:05:12', bundle(250)],
  ['09-08', '12:47:03', { details: 'Customer Withdrawal At Agent Till 123456 - SUNRISE AGENCIES NGONG RD', out: 2_000, fee: 29, feeDetails: 'Withdrawal Charge' }],
  ['09-10', '08:02:44', bolt(380)],
  ['09-12', '20:11:30', naivas(1_870)],
  ['09-14', '10:00:15', { details: 'Pay Bill to 4041 - NETFLIX.COM Acc. DEMO', out: 1_100, fee: 0 }],
  ['09-15', '17:25:48', send(800, '2547*****317 BRIAN OTIENO MOCK', 13)],
  ['09-17', '13:33:21', java(540)],
  // Fuliza: balance runs low, an overdraft tops up a payment
  ['09-19', '14:02:07', { details: 'OverDraft of Credit Party', in: 1_200 }],
  ['09-19', '14:02:07', { details: 'Merchant Payment Fuliza M-Pesa to 9011223 - GOODLIFE PHARMACY YAYA', out: 1_450 }],
  ['09-21', '09:14:59', { details: 'Funds received from - 2547*****456 PETER KAMAU SAMPLE', in: 600 }],
  ['09-23', '18:52:16', uber(560)],
  // payday
  ['09-28', '09:00:02', { details: 'Business Payment from 600100 - ACME LTD', in: 85_000 }],
  ['09-28', '09:00:40', { details: 'OD Loan Repayment to 232323 - M-PESA Overdraw', out: 1_212 }],
  ['09-28', '12:30:18', { details: 'Pay Bill to 522533 - HILLVIEW HOMES Acc. RENT B4', out: 28_000, fee: 108, feeDetails: 'Pay Bill Charge' }],
  ['09-29', '10:05:44', { details: 'M-Shwari Deposit', out: 10_000 }],
  ['09-29', '19:41:27', carrefour(6_980)],
  ['09-30', '08:16:33', send(3_000, '2547*****821 JANE WANJIKU DOE', 52)],
  // ---------------------------------------------------------------- October
  ['10-01', '07:55:10', bundle(1_000)],
  ['10-02', '12:11:49', { details: 'Funds received from - 2547*****456 PETER KAMAU SAMPLE', in: 2_500 }],
  ['10-03', '19:20:05', naivas(3_125)],
  ['10-04', '08:44:12', bolt(450)],
  ['10-05', '09:30:00', kplc(1_500)],
  ['10-06', '13:02:57', java(720)],
  ['10-08', '17:48:31', { details: 'Pay Bill to 400200 - ZUKU FIBER Acc. 4421188', out: 3_299, fee: 0 }],
  ['10-10', '11:26:04', { details: 'Merchant Payment to 7788990 - QUICKMART LAVINGTON', out: 2_640 }],
  ['10-12', '15:17:38', send(1_200, '2547*****317 BRIAN OTIENO MOCK', 23)],
  ['10-13', '08:30:21', uber(390)],
  ['10-15', '20:05:59', { details: 'Merchant Payment to 3355771 - KFC SARIT CENTRE', out: 1_150 }],
  ['10-17', '10:42:13', airtime(200)],
  ['10-18', '12:58:40', carrefour(5_430)],
  ['10-20', '16:33:02', { details: 'Customer Withdrawal At Agent Till 654321 - MWANGAZA SHOP KILELESHWA', out: 3_000, fee: 52, feeDetails: 'Withdrawal Charge' }],
  ['10-22', '09:09:09', { details: 'Pay Bill to 200999 - NAIROBI WATER Acc. 1100223', out: 850, fee: 0 }],
  ['10-23', '18:18:44', naivas(2_210)],
  ['10-25', '07:40:26', bolt(510)],
  ['10-26', '14:12:51', { details: 'Merchant Payment to 4455667 - SHELL WAIYAKI WAY', out: 3_500 }],
  ['10-28', '09:00:03', { details: 'Business Payment from 600100 - ACME LTD', in: 85_000 }],
  ['10-28', '12:35:47', { details: 'Pay Bill to 522533 - HILLVIEW HOMES Acc. RENT B4', out: 28_000, fee: 108, feeDetails: 'Pay Bill Charge' }],
  ['10-29', '10:01:30', { details: 'M-Shwari Deposit', out: 10_000 }],
  ['10-29', '17:55:08', send(5_000, '2547*****990 MAMA GRACE NJERI', 87)],
  ['10-30', '19:44:16', carrefour(7_260)],
  ['10-31', '13:21:35', java(610)],
];

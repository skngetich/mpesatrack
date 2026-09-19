# Statement parser

Source: `src/parser/mpesa.ts` (parsing) and `src/parser/pdf.ts` (text extraction).

Verified against a **real M-PESA full statement** (25 pages, 930 transactions): all rows read, and the parsed
totals equal the statement's own summary to the cent. Synthetic regression tests in `mpesa.test.ts` and
`mpesa.real-layout.test.ts` encode the layout facts below (with invented data).

## The problem

A PDF has no table. It only says "draw this string at (x, y)". To recover the M-PESA ledger we rebuild rows and columns
from positions. mpesa2csv uses Tabula for this; here we do it directly, which keeps it small, offline and testable.

## What a real statement looks like

Page 1 starts with account details and a **SUMMARY** block (paid in / paid out per transaction type) that ends with a
`TOTAL:` row. Then the **DETAILED STATEMENT** table, whose header repeats on every page:

| Receipt No. | Completion Time | Details | Transaction Status | Paid In | Withdrawn | Balance |
| --- | --- | --- | --- | --- | --- | --- |
| `ABC1D2E3F4` | `2026-03-15 14:22:10` | `Customer Transfer to - 2547***123 JOHN DOE` | `Completed` | | `-1,000.00` | `9,200.00` |

Facts about the real layout that shaped the parser (each has a regression test):

1. **Header labels are centred over their columns, data is not.** Details text is left-aligned and starts to the *left* of
   the "Details" label; amounts are right-aligned and can start left of their label. So header x is only a hint.
2. **Money out is printed negative** (`-1,000.00`); we store it as a positive `withdrawn`.
3. **A payment and its transaction fee are separate rows that share one receipt number and timestamp.** In the sample
   statement 930 rows had only 541 distinct receipt numbers. Receipt is therefore *not* a unique key (see the dedupe key
   in [ARCHITECTURE.md](ARCHITECTURE.md)).
4. **Rows are newest first**, and rows within the same second have no reliable order.
5. **Long Details wrap** onto extra lines (the phone number and name are commonly on a second line) that have no receipt.
6. pdf.js sometimes **fuses neighbouring header cells** into one fragment (`Transaction Status Paid In`).
7. Fuliza (M-PESA's overdraft) appears as `OverDraft of Credit Party` (money drawn) and `OD Loan Repayment`; payments
   *funded* by Fuliza read `Customer Transfer Fuliza MPesa to ...` or `Merchant Payment Fuliza M-Pesa Online to ...`.

## Algorithm

1. **Extract** (`pdf.ts`): pdf.js returns text fragments with (x, y, width). Whitespace-only fragments are dropped later.
2. **Group into rows** (`groupRows`): sort by y descending, merge fragments whose y differ by at most `ROW_TOLERANCE`.
3. **Find the header** (`isHeaderRow`, `readColumns`): the row containing "receipt" and one of "details"/"balance"/"completion",
   plus wrapped label rows within `HEADER_BAND`. Keywords are searched *inside* each fragment and positioned by character
   offset, which handles fused header cells. The header supplies column **order** and rough centres.
4. **Classify fragments by content, not position** (`readRow`):
   - first fragment matching `^[A-Z0-9]{10}$` *and* left of the time column = **receipt** (the position guard stops a
     10-letter capitalised name on a wrapped line being taken for a receipt);
   - date/time pattern = **completion time**; `Completed`/`Failed`/... = **status**;
   - amount pattern (`1,234.50`, `-22.00`) = an amount, assigned to a column by step 5;
   - everything else = **Details**.
5. **Learn the three amount columns from the data** (`learnAmountColumns`): amounts are right-aligned, so the right edges
   of one column's numbers coincide. Cluster all right edges (`CLUSTER_GAP`); the three rightmost clusters are
   Paid In / Withdrawn / Balance. If a column is never used, Balance is still the rightmost and the other cluster is
   matched to the nearer header after shifting header centres by the offset seen on the Balance column.
6. **Rebuild transactions**: a row starting with a receipt begins a transaction. A following row with no receipt, no amounts
   and text starting where Details text starts (`learnDetailsX`, median of the real data) is a wrapped **continuation** and is
   appended. Anything else (footer, "Page 3 of 25" at the left margin, disclaimer) **ends the table**.
7. **Normalise** (`finish`): amounts to integer cents (`parseAmount`), time to `YYYY-MM-DD HH:mm:ss` (`parseDateTime`,
   also accepts `DD/MM/YYYY`), whitespace collapsed. A row with an unreadable time is skipped with a warning.
8. **Classify** into `type` and extract the **counterparty**.

## Integrity checks

| Check | Result field | Meaning |
| --- | --- | --- |
| **Totals vs the statement's `TOTAL:` row** (`readSummaryTotals`) | `totalsCheck` = `match` / `mismatch` / `absent` | Sums of paid in and paid out equal the printed totals *to the cent*. `match` proves nothing was missed or misread. The app shows a green tick; `mismatch` is a warning. |
| **Balance chain** (`balanceMismatches`) | `balanceGaps` | Compares whole **same-second groups**: the group's net movement must carry some balance of the previous group to some balance of this one. Same-second rows cannot be checked one by one because their order in the PDF is arbitrary. |

A few balance gaps are normal (the real sample statement had exactly one, while its totals matched to the cent), so gaps only become a warning when the totals did not match or more than 2% of rows are affected.

### Type classification (first match wins)

| Details contains | type |
| --- | --- |
| `charge` / `fee` | fee |
| `overdraft`, `OD loan`, `Fuliza repay...` | fuliza (borrowing: draw or repayment) |
| `reversal` | reversal |
| `airtime`, `recharge`, `bundle purchase`, `data bundle` | airtime |
| `m-shwari`, `kcb m-pesa`, `lock savings`, `ziidi` | savings |
| `pay bill`, `card pay` | paybill |
| `merchant payment`, `buy goods`, `small business` | till |
| `withdraw` | withdraw |
| `deposit` | deposit |
| `customer transfer`, `customer send money` | send |
| `funds received`, `business payment from`, `salary`, `received`, or any paid-in | received |
| otherwise | other |

A payment *funded by* Fuliza is deliberately **not** `fuliza`: it is a normal send/till payment, so the spending is
attributed to what was bought. Only the draw and the repayment are borrowing.

### Counterparty extraction

Take the text after the first `to` / `from`, drop a leading `Small Business to`, drop the paybill account reference
(`Acc. ...`), then strip leading phone/till/paybill digits:

- `Customer Transfer to - 2547*****123 JOHN DOE` gives `JOHN DOE`
- `Pay Bill to 247247 - Equity Bulk Account Acc. 123` gives `Equity Bulk Account`
- `Merchant Payment to 5123456 - KFC` gives `KFC`
- `Airtime Purchase` gives `''` (no counterparty)

The counterparty is a convenience for display, "top payees" and pre-filling rule keywords. Rules match on the full Details
text, so a poor extraction never blocks categorisation.

## When a statement does not parse

If an import finds 0 rows, or warns about totals:

1. On the **Import** screen open **"Show extracted text"**. Each line is `page x y width text` for a raw fragment. Check that:
   - the header words appear (`Receipt No.`, `Details`, `Paid In`, `Withdrawn`, `Balance`);
   - amounts appear as separate fragments;
   - receipt numbers are 10 characters (upper-case letters and digits) at the left margin.
2. Compare with the constants at the top of `mpesa.ts`:
   - Rows merging or splitting: `ROW_TOLERANCE`.
   - Wrapped header not detected: `HEADER_BAND`.
   - Amounts landing in the wrong column: `CLUSTER_GAP`, `AMOUNT_SNAP`.
   - Wrapped lines treated as footers (or vice versa): `DETAILS_TOLERANCE`.
   - Renamed heading: `HEADER_MATCHERS`. Different receipt format: `RECEIPT_RE`. New date format: `TIME_RE` / `parseDateTime`.
3. Reproduce it as a unit test: build the fragments with the helpers in `mpesa.real-layout.test.ts` and make it pass.

**Privacy when sharing a dump:** the extracted text contains names, phone numbers and amounts. Redact it first (for example
replace letters with `a`/`A` and digits with `9`, which keeps the layout but hides the data).

## Known gaps

- Adjacent *data* cells fused by pdf.js into one fragment are not split (only header cells are). Not observed.
- Image-only (scanned) PDFs have no text layer; there is no OCR.
- Only the KES full-statement layout has been seen; other layouts (e.g. business statements) may need new matchers.
- Statement rows that contain a *wrapped line before the receipt row* (none seen) would be dropped as a footer.

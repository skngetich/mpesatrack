# Statement parser

Source: `src/parser/mpesa.ts` (parsing) and `src/parser/pdf.ts` (text extraction).

## The problem

A PDF has no table. It only says "draw this string at (x, y)". To recover the M-PESA ledger we rebuild rows and columns
from positions. mpesa2csv uses Tabula for this; here we do it directly, which keeps it small, offline and testable.

## Statement layout the parser expects

One header row (repeated on each page), then one row per transaction:

| Receipt No. | Completion Time | Details | Transaction Status | Paid in | Withdrawn | Balance |
| --- | --- | --- | --- | --- | --- | --- |
| `SGH1A2B3C4` | `2024-03-15 14:22:10` | `Customer Transfer to - 2547*****123 JOHN DOE` | `Completed` | | `1,000.00` | `4,000.00` |

Long **Details** wrap onto extra lines that have no receipt number. Cover text (name, period, summary) appears before the
first header; footers/disclaimers appear after the last row.

## Algorithm

1. **Extract** (`pdf.ts`): pdf.js returns text items with a transform (x, y) and width. Whitespace-only items are dropped later.
2. **Group into rows** (`groupRows`): sort by y descending, then merge items whose y differ by at most `ROW_TOLERANCE` (3 units). Sort each row by x.
3. **Find the header** (`isHeaderRow`, `readColumns`): a row containing "receipt" and one of "details"/"balance"/"completion". Rows up to `HEADER_BAND` (14 units) below are scanned too, because labels sometimes wrap. Each column's start x comes from where its keyword occurs.
   - pdf.js can **fuse neighbouring header cells** into one item ("Transaction Status Paid in"). So keywords are searched *inside* each item and positioned proportionally by character offset. There is a regression test for this (it was found while testing with a generated PDF).
   - Required columns: receipt, details, paid in, withdrawn, balance. Time and status are optional.
   - Pages without a repeated header reuse the previous page's columns.
4. **Assign fragments to columns** (`assignCells`):
   - Amount-looking fragments (`1,234.50`) at or right of the "Paid in" header go to the numeric column whose header span they **overlap most**. Amounts are right-aligned, so their start x can be left of the header's start; overlap handles that.
   - Everything else goes to the last text column whose start is `<=` the fragment's x (with `COL_TOLERANCE` slack).
5. **Rebuild transactions**:
   - A row whose receipt cell matches `^[A-Z0-9]{10}$` **starts** a transaction.
   - A row with no receipt and no amounts, but text in time/details/status, is a **continuation**: appended to the current transaction.
   - Any other non-empty row (footer, "Page 1 of 3", disclaimer) **ends the table**, so footers never leak into the last transaction.
6. **Normalise** (`finish`): amounts to integer cents (`parseAmount`), time to `YYYY-MM-DD HH:mm:ss` (`parseDateTime`, accepts `DD/MM/YYYY` too), whitespace collapsed. A row with an unreadable time is skipped with a warning.
7. **Classify** (`classify`) into `type` and extract the **counterparty** (`extractCounterparty`).
8. **Reconcile** (`balanceMismatches`): each balance should equal the previous balance plus paid-in minus withdrawn (tried in both row orders). Mismatches produce a *warning*, not an error, because Fuliza and failed transactions can legitimately break a few links; a large count usually means amounts landed in the wrong column.

### Type classification (first match wins)

| Details contains | type |
| --- | --- |
| `charge` / `fee` | fee |
| `fuliza`, `overdraft` | fuliza |
| `reversal` | reversal |
| `airtime`, `bundle purchase`, `data bundle` | airtime |
| `m-shwari`, `kcb m-pesa`, `lock savings`, `ziidi` | savings |
| `pay bill` | paybill |
| `merchant payment`, `buy goods`, `small business` | till |
| `withdraw` | withdraw |
| `deposit` | deposit |
| `customer transfer` | send |
| `funds received`, `business payment from`, `salary`, or any paid-in | received |
| otherwise | other |

### Counterparty extraction

Take the text after the first `to` / `from`, drop a leading `Small Business to`, drop the paybill account reference (`Acc. ...`),
then strip leading phone/till/paybill digits:

- `Customer Transfer to - 2547*****123 JOHN DOE` gives `JOHN DOE`
- `Pay Bill to 247247 - Equity Bulk Account Acc. 123` gives `Equity Bulk Account`
- `Merchant Payment to 5123456 - KFC` gives `KFC`
- `Airtime Purchase` gives `''` (no counterparty)

The counterparty is a convenience for display, the "top payees" list and pre-filling rule keywords. Categorisation rules match
on the full Details text, so a poor extraction never blocks categorisation.

## When a real statement does not parse

The parser was written from the known statement layout and tested with a synthetic statement; it has not yet seen every
real-world variant. If an import finds 0 rows, or warns about balances:

1. On the **Import** screen open **"Show extracted text"**. Each line is `page x y width text` for a raw fragment. Check that:
   - the header words appear (`Receipt No.`, `Details`, `Paid in`, `Withdrawn`, `Balance`) and roughly where their x values sit;
   - amounts appear as separate fragments, right of the header x values;
   - receipt numbers are 10 characters (upper-case letters and digits).
2. Compare with the constants at the top of `mpesa.ts`:
   - Rows merging or splitting: adjust `ROW_TOLERANCE`.
   - Wrapped header not detected: adjust `HEADER_BAND`.
   - Text in the wrong column: adjust `COL_TOLERANCE`, or the matcher regexes in `HEADER_MATCHERS` if Safaricom renamed a heading.
   - Different receipt format: `RECEIPT_RE`.
   - New date format: `parseDateTime`.
3. Reproduce it as a unit test: build the fragments in `mpesa.test.ts` (the helpers `header()` and `row()` show how) and make it pass.

**Privacy when sharing a dump:** the extracted text contains names, phone numbers and amounts. Redact it before sending it to anyone.

## Known gaps

- Adjacent *data* cells fused by pdf.js into one fragment are not split (only header cells are). This has not been observed, but a very tight layout could cause it.
- Image-only (scanned) PDFs have no text layer; there is no OCR.
- Multi-currency statements are not handled (KES assumed).

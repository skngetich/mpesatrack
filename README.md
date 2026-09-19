# MpesaTrack

Import your M-PESA statement PDF, categorise every transaction, and see where your money goes.
An installable **Progressive Web App** (PWA): everything runs on your phone, the data is stored in a
**local SQLite database**, and **nothing is ever uploaded**.

The idea is borrowed from [mpesa2csv](https://github.com/DavidAmunga/mpesa2csv) (unlock the statement PDF,
extract the ledger table). mpesa2csv is a desktop app built on Tabula; MpesaTrack does the same job in the
browser with [pdf.js](https://mozilla.github.io/pdf.js/) and goes one step further by categorising the
result for expense tracking.

## Features

- **Import statement PDFs**, including the password-protected ones Safaricom sends (password is usually your national ID number). Decryption happens on the device.
- **Safe re-imports**: transactions are keyed by M-PESA receipt number, so overlapping statements never create duplicates.
- **Automatic categorisation** from keyword rules (Naivas, KPLC, Uber, airtime, Fuliza, ... ship as defaults) with the longest keyword winning.
- **Teach it once**: tap a transaction, pick a category, tick "also categorise similar" and every matching transaction, past and future, follows.
- **Summary**: money in/out/net, spending and income by category, top payees, month by month.
- **Your data stays yours**: SQLite file on the device (OPFS), one-tap **backup/restore** as a standard `.sqlite3` file you can open in any SQLite tool.
- **Works offline** after the first load, installs to the home screen, light and dark themes.

## Quick start (development)

Requires Node 20+.

```bash
npm install
npm run dev        # http://localhost:5173  (service worker is off in dev)
npm test           # parser + categorisation unit tests
npm run build      # type-check + production build into dist/
npm run preview    # serve dist/ (this is the real PWA, with service worker)
```

## Getting it onto your phone

A PWA needs **HTTPS** to install and to use local storage (`http://192.168.x.x` does **not** qualify;
`http://localhost` does). Publish the contents of `dist/` on any static host, then open the URL on the phone:

| Host | How |
| --- | --- |
| **Firebase Hosting (used for this project)** | `npm run deploy`. See [Deploying to Firebase](#deploying-to-firebase). |
| GitHub Pages | push `dist/` to a `gh-pages` branch or use a Pages action. All asset URLs are relative (`base: './'`), so a sub-path like `/mpesatrack/` works. |
| Netlify / Cloudflare Pages / Vercel | build command `npm run build`, output directory `dist`. |
| Quick test from your PC | `npm run preview` plus a tunnel that gives HTTPS (e.g. `cloudflared tunnel --url http://localhost:4173`). |

Only the app code is hosted; your statements and data never leave the phone.

### Deploying to Firebase

Live at **https://mpesatrack.web.app**, a dedicated Hosting site (`mpesatrack`) inside the Firebase project
`skngetich-portfolio`, next to (and independent of) the portfolio's default site.

```bash
npm run deploy     # = npm run build && firebase deploy --only hosting
```

- `firebase.json` pins `"site": "mpesatrack"`, and `.firebaserc` sets the default project, so a deploy from this folder cannot overwrite the portfolio site.
- Caching rules in `firebase.json`: `index.html` (and `/`), `sw.js` and the manifest are `no-cache` so a new release is picked up immediately; everything in `/assets/` has a content hash in its file name and is cached for a year (`immutable`). If `index.html` were cached, a phone could keep a stale page pointing at asset files that no longer exist after a deploy.
- Users get updates automatically: the service worker (`autoUpdate`) installs the new version in the background and it takes over the next time the app is opened.
- First-time setup on a new machine: `npx firebase login`. To host somewhere else, create a site with `firebase hosting:sites:create <name>` and change `"site"` in `firebase.json`.
- The site is public, but it contains only the app code. No statements or transactions are ever sent to it.

- **Android (Chrome):** open the URL, menu, *Install app* (or *Add to Home screen*).
- **iPhone (Safari 16.4+):** Share, *Add to Home Screen*.

Then: **Import** tab, choose the PDF, enter the password if asked, done.

## Using the app

1. **Import**: pick one or more statement PDFs. You get a report of rows added, duplicates skipped, and any warnings.
2. **Transactions**: filter by month, category or free-text search. Tap a row to categorise it.
   - Leave *"Also categorise similar transactions"* ticked to save a rule from the payee name (edit the keyword if it is too narrow or too broad).
   - A category you set by hand (marked with a pencil) is never overwritten by rules.
3. **Summary**: choose a month or all time.
4. **Settings**: add or remove rules and categories, re-apply rules, download or restore a backup, delete all transactions.

### How categorisation decides

A rule is `keyword + direction (in/out/any) -> category`. A transaction matches when its Details text contains the keyword
(case-insensitive) and its direction fits. If several rules match, the **longest keyword wins**, then the oldest rule.
Manual choices always beat rules. Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#categorisation).

## Privacy

- The PDF, its password and all transactions are processed **in the browser** and stored in the browser's private file system (OPFS). There is no server component and no analytics.
- The only network traffic is loading the app itself; after the first visit the service worker serves it from cache.
- Real statements are personal financial data. `.gitignore` excludes `*.pdf` and `samples/`; keep it that way.

## Project layout

```
src/
  parser/
    pdf.ts          pdf.js wrapper: PDF (+password) -> positioned text fragments
    mpesa.ts        pure parser: fragments -> transactions (rows, columns, wrapped lines, types)
    mpesa.test.ts   unit tests using a synthetic statement layout
  categorize.ts     default categories/rules and the rule-matching function (pure)
  db/
    worker.ts       SQLite (WASM) in a Web Worker: schema, queries, import, backup
    client.ts       typed promise API over the worker (db.listTransactions(...))
    types.ts        shared row/summary types
  ui/               Preact screens: Import, Transactions, Summary, Settings
  main.tsx          entry point, service worker registration
docs/
  ARCHITECTURE.md   data flow, schema, worker protocol, PWA/offline, design decisions
  PARSER.md         statement layout and the parsing heuristics; how to adapt to a layout change
scripts/make-icons.mjs   renders public/icon.svg to the PNG icons
```

## Tech stack

Preact + TypeScript + Vite, `vite-plugin-pwa` (Workbox), `pdfjs-dist`, `@sqlite.org/sqlite-wasm` (OPFS `opfs-sahpool` VFS), Vitest.

## Known limitations

- **The parser has only been verified against a synthetic statement** that mimics the M-PESA column layout (including wrapped Details lines, right-aligned amounts, repeated headers and merged header cells), not against a real statement PDF. Safaricom occasionally changes its layout. If your import reports 0 rows or a balance-reconciliation warning, see [docs/PARSER.md](docs/PARSER.md#when-a-real-statement-does-not-parse) (the Import screen has a "show extracted text" panel for exactly this).
- **Scanned/image-only PDFs** contain no text and cannot be read (no OCR).
- Data is per browser profile and per device. There is no sync; use backup/restore to move it. If the browser lacks OPFS the app runs in memory and warns you (make a backup).
- Tested in Chromium. iOS Safari 16.4+ should work (OPFS in workers) but has not been tried on a device.
- Only completed transactions are counted in summaries; failed/reversed rows are stored but excluded.
- Currency is assumed to be KES.

## Ideas for later

CSV export, per-category budgets, split transactions, date-range picker, recurring-payment detection, importing the CSV that mpesa2csv produces.

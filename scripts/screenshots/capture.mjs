/**
 * Regenerates the hero + README screenshots:
 *   1. builds the fake statement PDF (./make-statement.mjs, invented data only),
 *   2. builds the app and serves it with `vite preview`,
 *   3. imports the PDF through the REAL import flow in a fresh Chromium profile,
 *   4. captures Import (green totals tick), Summary and Transactions at phone size.
 *
 * Output: docs/screenshots/*.png (README) and src/ui/hero/*.webp (in-app hero).
 * Both are committed; run this by hand after UI changes: `npm run screenshots`.
 * First time only: `npx playwright install chromium`.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { build, preview } from 'vite';
import { makeStatement } from './make-statement.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PNG_DIR = resolve(ROOT, 'docs', 'screenshots');
const WEBP_DIR = resolve(ROOT, 'src', 'ui', 'hero');
const PORT = 4174;
/** Keep the precache small: each WebP must stay under this. */
const MAX_WEBP_BYTES = 80 * 1024;
/** Payees the default rules don't know, taught through the UI before capturing. */
const TEACH = [
  ['HILLVIEW HOMES', 'Rent & housing'],
  ['MAMA GRACE NJERI', 'Family & friends'],
  ['JANE WANJIKU DOE', 'Family & friends'],
  ['BRIAN OTIENO MOCK', 'Family & friends'],
  ['PETER KAMAU SAMPLE', 'Family & friends'],
];

const statement = await makeStatement();
console.log(`Statement: ${statement.rows} rows, ${statement.pages} pages`);

await build({ root: ROOT, logLevel: 'warn' });
const server = await preview({ root: ROOT, preview: { port: PORT, strictPort: true }, logLevel: 'warn' });

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'light',
    serviceWorkers: 'block', // capture exactly this build, never a cached one
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`http://localhost:${PORT}/`);

  // Fresh profile -> empty database -> app opens on Import with the hero.
  await page.locator('input[type=file]').setInputFiles(statement.out);
  await page.getByText('Totals match').waitFor({ timeout: 30_000 });
  await page.evaluate(() => window.scrollTo(0, 0));

  await mkdir(PNG_DIR, { recursive: true });
  await mkdir(WEBP_DIR, { recursive: true });
  await shoot(page, 'import');

  // "Teach it once": payees without a default rule get a category through the
  // real category sheet (with its rule), exactly as a user would do it.
  await openTab(page, 'Transactions');
  const search = page.getByPlaceholder('Search name, details, receipt');
  for (const [payee, category] of TEACH) {
    await search.fill(payee);
    await page.locator('ul.txns li', { hasText: payee }).first().click();
    await page.locator('.sheet button.chip', { hasText: category }).click();
    await page.locator('.sheet').waitFor({ state: 'detached' });
  }
  await search.fill('');
  await search.blur();
  await page.waitForTimeout(400);
  await shoot(page, 'transactions');

  await openTab(page, 'Summary');
  await shoot(page, 'summary');
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}

async function openTab(page, label) {
  await page.locator('nav.tabs button', { hasText: label }).click();
  await page.waitForTimeout(600); // let the query render
}

async function shoot(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const png = await page.screenshot();
  await sharp(png).png({ compressionLevel: 9, palette: true, quality: 90 }).toFile(resolve(PNG_DIR, `${name}.png`));
  const info = await sharp(png).webp({ quality: 72, effort: 6 }).toFile(resolve(WEBP_DIR, `${name}.webp`));
  console.log(`${name}: webp ${(info.size / 1024).toFixed(1)} KB`);
  if (info.size > MAX_WEBP_BYTES) throw new Error(`${name}.webp is over the ${MAX_WEBP_BYTES / 1024} KB budget`);
}

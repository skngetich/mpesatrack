// Renders public/icon.svg into the PNG sizes required by the web manifest.
// Run with `npm run icons` after editing the SVG. The maskable variant gets
// extra padding so Android's adaptive-icon crop never clips the glyph.
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';

const svg = await readFile(new URL('../public/icon.svg', import.meta.url));
const out = (n) => new URL(`../public/${n}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

await sharp(svg).resize(192, 192).png().toFile(out('icon-192.png'));
await sharp(svg).resize(512, 512).png().toFile(out('icon-512.png'));
await sharp(svg)
  .resize(360, 360)
  .extend({ top: 76, bottom: 76, left: 76, right: 76, background: '#0b8f3c' })
  .png()
  .toFile(out('icon-512-maskable.png'));
console.log('icons written');

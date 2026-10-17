#!/usr/bin/env node
// D3 step 1b: bring every downloaded image under 300 KB. Images wider than 1200 px are
// resized to 1200 px; PNGs are re-encoded with a palette, JPEGs at quality 82. The
// result is kept only when it is smaller. media.json is updated with the new size.
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..', '..', 'site');
const MEDIA = join(HERE, 'media.json');
const MAX_BYTES = 300 * 1024;
const MAX_WIDTH = 1200;

const media = JSON.parse(await readFile(MEDIA, 'utf8'));
let changed = 0;
for (const m of Object.values(media)) {
  if (m.status !== 'ok' || !m.target.startsWith('/img/') || m.bytes <= MAX_BYTES) continue;
  const file = join(SITE, m.target);
  const input = await readFile(file);
  const fmt = m.target.split('.').pop();
  let best = input;
  for (const width of [MAX_WIDTH, 1000, 800]) {
    let pipe = sharp(input).resize({ width, withoutEnlargement: true });
    if (fmt === 'png') pipe = pipe.png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 });
    else if (fmt === 'jpg') pipe = pipe.jpeg({ quality: 82, mozjpeg: true });
    else if (fmt === 'webp') pipe = pipe.webp({ quality: 82 });
    else break;
    const out = await pipe.toBuffer();
    if (out.length < best.length) best = out;
    if (best.length <= MAX_BYTES) break;
  }
  let target = m.target;
  if (best.length > MAX_BYTES) {
    // Still too big: WebP keeps transparency and GIF animation at a fraction of the size.
    for (const quality of [80, 70, 60]) {
      const out = await sharp(input, { animated: fmt === 'gif' }).resize({ width: MAX_WIDTH, withoutEnlargement: true }).webp({ quality, effort: 6 }).toBuffer();
      if (out.length < best.length) { best = out; target = m.target.replace(/\.\w+$/, '.webp'); }
      if (best.length <= MAX_BYTES) break;
    }
  }
  if (best === input) { console.log(`unchanged ${m.target} (${Math.round(m.bytes / 1024)} KB)`); continue; }
  if (target !== m.target) { await unlink(file); m.target = target; }
  await writeFile(join(SITE, target), best);
  const meta = await sharp(best, { animated: true }).metadata();
  meta.height = meta.pageHeight || meta.height;
  console.log(`${m.target}: ${Math.round(m.bytes / 1024)} KB -> ${Math.round(best.length / 1024)} KB, ${m.width}px -> ${meta.width}px`);
  Object.assign(m, { bytes: best.length, width: meta.width, height: meta.height, resized: true });
  if (best.length <= MAX_BYTES) delete m.note; else m.note = 'over 300 KB after resizing';
  changed++;
}
await writeFile(MEDIA, JSON.stringify(media, null, 1) + '\n');
console.log(`shrink: ${changed} images re-encoded`);

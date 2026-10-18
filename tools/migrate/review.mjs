#!/usr/bin/env node
// D4 step 1: compare every converted post with its raw original and give it a confidence mark.
//   high    every word of the original is present, nothing lost, language and tags known
//   medium  small gaps (a lost image, an inferred tag set, a plain-text code block)
//   low     words of the original are missing, or a code block is empty
// Writes tools/migrate/review.json and prints a summary. The review agent works the low and
// medium posts and records its verdicts in review.json under "agent".
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'node-html-parser';
import { isBadge } from './media.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PARSE = { comment: false, blockTextElements: { script: true, noscript: true, style: true } };
const OUT = join(HERE, 'review.json');

const words = (s) => (s.normalize('NFKC').replace(/ /g, ' ').toLowerCase().match(/[\p{L}\p{N}_#+]+/gu) || []);

// Line numbers ("12:") are stripped on purpose, so bare short numbers are not counted.
function bag(list) {
  const m = new Map();
  for (const w of list) if (!/^\d{1,3}$/.test(w)) m.set(w, (m.get(w) || 0) + 1);
  return m;
}

async function main() {
  const manifest = JSON.parse(await readFile(join(HERE, 'raw', 'manifest.json'), 'utf8'));
  let previous = {};
  try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch {}
  const result = {};
  const counts = { high: 0, medium: 0, low: 0 };

  for (const [path, entry] of Object.entries(manifest)) {
    if (!path.startsWith('/post/')) continue;
    const raw = parse(await readFile(join(HERE, entry.file), 'utf8'), PARSE).querySelector('.post-body');
    for (const el of raw.querySelectorAll('script, style, span.lnum')) el.remove();
    for (const img of raw.querySelectorAll('img')) if (isBadge(img.getAttribute('src') || '')) img.remove();
    const out = parse(await readFile(join(ROOT, 'site', ...path.split('/').filter(Boolean), 'index.html'), 'utf8'), PARSE);
    const body = out.querySelector('.post-body');
    const lostImages = body.querySelectorAll('em.lost').length;
    for (const n of body.querySelectorAll('em.lost')) n.remove();

    const before = bag(words(raw.text));
    const after = bag(words(body.text));
    const missing = [];
    let total = 0, lost = 0;
    for (const [w, n] of before) {
      total += n;
      const d = n - (after.get(w) || 0);
      if (d > 0) { lost += d; missing.push(w); }
    }
    const added = [...after].filter(([w, n]) => n > (before.get(w) || 0)).map(([w]) => w);

    const codes = body.querySelectorAll('pre code');
    const empty = codes.filter((c) => !c.text.trim()).length;
    const plain = codes.filter((c) => c.getAttribute('class') === 'language-plaintext').length;
    const ld = JSON.parse(out.querySelector('script[type="application/ld+json"]').text);
    const rawTags = parse(await readFile(join(HERE, entry.file), 'utf8'), PARSE).querySelectorAll('.post-tags a').length;

    const reasons = [];
    if (lost > 0) reasons.push(`${lost} of ${total} words missing (${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''})`);
    if (empty) reasons.push(`${empty} empty code block(s)`);
    if (lostImages) reasons.push(`${lostImages} image(s) lost`);
    if (plain) reasons.push(`${plain} code block(s) without language`);
    if (!rawTags) reasons.push('tags inferred');
    const level = lost > 2 || empty ? 'low' : reasons.length ? 'medium' : 'high';
    counts[level]++;
    result[path] = {
      title: ld.headline, level, reasons, wordsBefore: total, wordsMissing: lost, wordsAdded: added.length,
      ...(previous[path]?.agent ? { agent: previous[path].agent } : {}),
    };
  }
  await writeFile(OUT, JSON.stringify(result, null, 1) + '\n');
  console.log(`review: high ${counts.high}, medium ${counts.medium}, low ${counts.low}`);
  for (const [p, r] of Object.entries(result)) if (r.level === 'low') console.log(`  LOW ${p}\n      ${r.reasons.join('; ')}`);
}

main().catch((e) => { console.error('review failed: ' + e.stack); process.exit(1); });

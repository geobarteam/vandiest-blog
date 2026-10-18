#!/usr/bin/env node
// Checks a deployed copy of the blog:
//   node tools/linkcheck.mjs https://kind-pebble-064b5f003.4.azurestaticapps.net
// - every legacy post URL (tools/legacy-urls.txt) answers 200 with a trailing slash and
//   redirects to it without one
// - the old feed and contact URLs redirect; a wrong path answers 404 with the custom page
// - every internal page, link and image reachable from the home page answers 200
// Exits 1 when anything is broken.
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'node-html-parser';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = (process.argv[2] || '').replace(/\/$/, '');
if (!/^https?:\/\//.test(base)) { console.error('usage: node tools/linkcheck.mjs <base URL>'); process.exit(2); }
const CONCURRENCY = 6;

const broken = [];
let checked = 0;

async function head(path, { follow = false } = {}) {
  checked++;
  try {
    const res = await fetch(base + encodeURI(path).replace(/%25([0-9A-F]{2})/gi, '%$1'), { redirect: follow ? 'follow' : 'manual' });
    return { status: res.status, location: res.headers.get('location'), type: res.headers.get('content-type') || '', res };
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

async function pool(items, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (queue.length) await fn(queue.shift()); }));
}

const legacy = (await readFile(join(ROOT, 'tools', 'legacy-urls.txt'), 'utf8')).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/post/'));

// 1. Legacy URLs.
await pool(legacy, async (p) => {
  const a = await head(p + '/');
  if (a.status !== 200) broken.push(`${a.status} ${p}/ <- legacy URL`);
  const b = await head(p);
  if (b.status !== 301 && b.status !== 308) broken.push(`${b.status} ${p} <- legacy URL without slash should redirect`);
});

// 2. Redirects and 404.
for (const [from, to] of [['/syndication.axd', '/rss.xml'], ['/syndication.axd?format=atom', '/rss.xml'], ['/contact.aspx', '/contact/']]) {
  const r = await head(from);
  if (r.status !== 301 || !(r.location || '').endsWith(to)) broken.push(`${r.status} ${from} <- should 301 to ${to}, got ${r.location || 'no location'}`);
}
const nf = await head('/this/page/does/not/exist');
const nfBody = nf.res ? await nf.res.text() : '';
if (nf.status !== 404 || !/Game over/.test(nfBody)) broken.push(`${nf.status} /this/page/does/not/exist <- should be the custom 404`);

// 3. Crawl internal pages from the home page.
const pages = new Set(['/']);
const assets = new Map(); // path -> first page that referenced it
const queue = ['/'];
while (queue.length) {
  const batch = queue.splice(0, CONCURRENCY);
  await Promise.all(batch.map(async (page) => {
    const r = await head(page, { follow: true });
    if (r.status !== 200) { broken.push(`${r.status} ${page} <- ${assets.get(page) || 'crawl'}`); return; }
    if (!r.type.includes('text/html')) return;
    const root = parse(await r.res.text());
    for (const el of root.querySelectorAll('a[href], img[src], link[href], script[src]')) {
      const raw = el.getAttribute('href') ?? el.getAttribute('src');
      if (!raw || !raw.startsWith('/') || raw.startsWith('//')) continue;
      const path = raw.split('#')[0];
      if (!path) continue;
      const isPage = el.tagName === 'A' && (path.endsWith('/') || !/\.[a-z0-9]+$/i.test(path));
      if (isPage) { if (!pages.has(path)) { pages.add(path); assets.set(path, page); queue.push(path); } }
      else if (!assets.has(path)) assets.set(path, page);
    }
  }));
}
const files = [...assets.keys()].filter((p) => !pages.has(p));
await pool(files, async (p) => {
  const r = await head(p, { follow: true });
  if (r.status !== 200) broken.push(`${r.status} ${p} <- ${assets.get(p)}`);
});

broken.sort();
for (const b of broken) console.log(b);
console.log(`links: ${checked} checked (${pages.size} pages, ${files.length} files, ${legacy.length} legacy URLs), ${broken.length} broken`);
process.exit(broken.length ? 1 : 0);

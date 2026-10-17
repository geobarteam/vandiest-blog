#!/usr/bin/env node
// D2 fallback extractor: saves every post and static page of the old BlogEngine site
// as raw HTML under tools/migrate/raw/, named after its URL path, plus a manifest.
// No login needed. Polite by design:
//   - HTTP only (the old site serves the wrong certificate on HTTPS)
//   - one request at a time with a 300 ms pause (well under three requests a second)
//   - only the URLs in sitemap.axd; never the /?tag= or /category/ listing pages
// Re-running skips pages already saved; pass --force to fetch everything again.
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'http://vandiest.biz';
const PAUSE_MS = 300;
const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, 'raw');
const FORCE = process.argv.includes('--force');
const UA = 'vandiest-blog-migration/1.0 (+https://github.com/geobarteam/vandiest-blog)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function get(url) {
  if (!url.startsWith('http://')) throw new Error(`refusing non-HTTP URL ${url}`);
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'manual' });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, location: res.headers.get('location'), body };
}

// Local file for a URL path: /post/2010/07/29/Slug -> raw/post/2010/07/29/Slug.html
function rawPath(pathname) {
  const clean = decodeURIComponent(pathname).replace(/^\/+|\/+$/g, '');
  if (!clean || clean.includes('..')) throw new Error(`unexpected path ${pathname}`);
  return join(RAW, ...clean.split('/')) + '.html';
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function main() {
  const sm = await get(`${ORIGIN}/sitemap.axd`);
  if (sm.status !== 200) throw new Error(`sitemap.axd answered ${sm.status}`);
  await mkdir(RAW, { recursive: true });
  await writeFile(join(RAW, 'sitemap.xml'), sm.body);

  const urls = [...sm.body.toString('utf8').matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1].trim().replace(/^https:/, 'http:'))
    .filter((u) => {
      const p = new URL(u).pathname;
      return (p.startsWith('/post/') || p.startsWith('/page/')) && !/[?&](tag|category)=/.test(u) && !p.startsWith('/category/');
    });
  const posts = urls.filter((u) => new URL(u).pathname.startsWith('/post/')).length;
  console.log(`sitemap: ${urls.length} URLs to save (${posts} posts, ${urls.length - posts} pages)`);

  const manifestFile = join(RAW, 'manifest.json');
  let manifest = {};
  try { manifest = JSON.parse(await readFile(manifestFile, 'utf8')); } catch {}

  let fetched = 0, skipped = 0;
  const failures = [];
  for (const url of urls) {
    const path = new URL(url).pathname;
    const file = rawPath(path);
    if (!FORCE && (await exists(file)) && manifest[path]?.status === 200) { skipped++; continue; }
    let r;
    try { r = await get(url); } catch (e) { failures.push(`${path}: ${e.message}`); continue; }
    if (r.status !== 200) {
      failures.push(`${path}: HTTP ${r.status}${r.location ? ' -> ' + r.location : ''}`);
    } else {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, r.body);
      fetched++;
    }
    manifest[path] = {
      url,
      status: r.status,
      bytes: r.body.length,
      sha256: r.status === 200 ? sha256(r.body) : null,
      file: file.slice(HERE.length + 1).split('\\').join('/'),
    };
    process.stdout.write(`\r${fetched + skipped + failures.length}/${urls.length}`);
    await sleep(PAUSE_MS);
  }

  const sorted = Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]]));
  await writeFile(manifestFile, JSON.stringify(sorted, null, 1) + '\n');
  console.log(`\nfetched ${fetched}, already present ${skipped}, failed ${failures.length}`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error('scrape failed: ' + e.message); process.exit(1); });

#!/usr/bin/env node
// D3 step 1: download every image and attachment the raw posts reference, into
// site/img/yyyy/ and site/files/, and record the outcome in tools/migrate/media.json:
//   { "<original src or href>": { target, status, via, width, height, bytes, note } }
// convert.mjs reads that file to rewrite src/href and fill width/height.
//
// Sources, in order: the original URL (HTTP for vandiest.biz, since its HTTPS certificate
// is wrong), then the Wayback Machine's closest capture. Images already served from
// web.archive.org are fetched in their raw (id_) form so nothing depends on a third party.
// Badges ("kick it", LinkedIn "view my profile") are not content and are skipped.
// Re-running reuses what is already downloaded; --force fetches everything again.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'node-html-parser';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SITE = join(ROOT, 'site');
const OUT = join(HERE, 'media.json');
const FORCE = process.argv.includes('--force');
const RETRY = process.argv.includes('--retry-missing');
const UA = 'vandiest-blog-migration/1.0 (+https://github.com/geobarteam/vandiest-blog)';
const PARSE = { blockTextElements: { script: true, noscript: true, style: true } };
const OWN_HOSTS = /^(www\.|geoffrey\.)?vandiest\.biz$/i;
const MAX_BYTES = 300 * 1024;

export const isBadge = (src) =>
  /dotnetkicks\.com|KickItImageGenerator|linkedin\.com\/img\/webpromo/i.test(decodeURIComponent(src || ''));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastCall = {};
async function polite(host) {
  const gap = /archive\.org$/.test(host) ? 1200 : 300;
  const wait = (lastCall[host] || 0) + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall[host] = Date.now();
}

// Absolute URL for a src/href found in a post, or null when it cannot be fetched.
export function absolute(src) {
  if (!src) return null;
  let s = src.trim();
  if (/^https?%3A/i.test(s)) s = decodeURIComponent(s);
  if (s.startsWith('/admin/app/editor/')) s = decodeURIComponent(s.slice('/admin/app/editor/'.length));
  if (s.startsWith('//')) s = 'http:' + s;
  if (s.startsWith('/')) s = 'http://vandiest.biz' + s;
  if (!/^https?:\/\//i.test(s)) return null;
  const u = new URL(s);
  if (OWN_HOSTS.test(u.hostname)) { u.protocol = 'http:'; u.hostname = 'vandiest.biz'; }
  return u.toString();
}

// Is this href a link to an image or attachment we should host ourselves?
export function isMediaHref(href) {
  const a = absolute(href);
  if (!a) return false;
  const u = new URL(a);
  if (u.hostname === 'vandiest.biz') return /^\/(image|file)\.axd$/i.test(u.pathname);
  return /\.(png|jpe?g|gif|webp)$/i.test(u.pathname) && !isBadge(a);
}

function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 0, 4) === '%PDF') return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';
  return null;
}

export function dimensions(buf, type) {
  try {
    if (type === 'png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (type === 'gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (type === 'webp' && buf.toString('ascii', 12, 16) === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (type === 'jpg') {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
    }
  } catch {}
  return null;
}

async function fetchBytes(url) {
  const host = new URL(url).hostname;
  await polite(host);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: ctrl.signal });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    const type = sniff(buf);
    if (!type) return { error: `not an image or file (${res.headers.get('content-type')})` };
    return { buf, type };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message) };
  } finally {
    clearTimeout(t);
  }
}

// Raw (id_) form of a Wayback URL: the original bytes without the archive's toolbar.
function rawWayback(url) {
  return url.replace(/^https?:\/\/web\.archive\.org\/web\/(\d+)(?:[a-z_]+)?\//, 'https://web.archive.org/web/$1id_/');
}

// The archive's capture index (CDX). Retries because the archive is often briefly offline.
async function cdx(query) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await polite('archive.org');
    try {
      const res = await fetch(`https://web.archive.org/cdx/search/cdx?${query}&output=json`, { headers: { 'user-agent': UA } });
      const txt = await res.text();
      if (res.ok && txt.trim().startsWith('[')) return JSON.parse(txt).slice(1);
      if (res.ok && !txt.trim()) return [];
    } catch {}
    await sleep(5000 * (attempt + 1));
  }
  return null;
}

// BlogEngine served one picture under several hosts and spellings; index every image
// capture of the three old hosts once, keyed by the decoded, lowercased picture path.
const pictureKey = (s) => {
  try { return decodeURIComponent(decodeURIComponent((s.split('picture=')[1] || '').replace(/\+/g, ' '))).replace(/^\//, '').toLowerCase(); } catch { return ''; }
};
let ownIndex = null;
async function ownCaptures() {
  if (ownIndex) return ownIndex;
  ownIndex = new Map();
  for (const host of ['geoffrey.vandiest.biz', 'vandiest.biz', 'www.vandiest.biz']) {
    const rows = await cdx(`url=${host}/image.axd&matchType=prefix&fl=original,timestamp,mimetype&filter=statuscode:200&filter=mimetype:image.*&collapse=urlkey&limit=2000`);
    for (const [original, ts] of rows || []) {
      const k = pictureKey(original);
      if (k && !ownIndex.has(k)) ownIndex.set(k, `https://web.archive.org/web/${ts}id_/${original}`);
    }
  }
  return ownIndex;
}

async function wayback(url) {
  let candidate = null;
  if (/\/image\.axd/i.test(url)) candidate = (await ownCaptures()).get(pictureKey(url)) || null;
  if (!candidate) {
    const rows = await cdx(`url=${encodeURIComponent(url)}&fl=timestamp,original&filter=statuscode:200&limit=1`);
    if (rows === null) return { error: 'Wayback index unreachable' };
    if (rows.length) candidate = `https://web.archive.org/web/${rows[0][0]}id_/${rows[0][1]}`;
  }
  if (!candidate) return { error: 'no Wayback capture' };
  const r = await fetchBytes(candidate);
  return r.error ? { error: 'Wayback capture unusable: ' + r.error } : { ...r, archived: candidate };
}

async function download(src) {
  const url = absolute(src);
  if (!url) return { error: 'not a fetchable URL' };
  if (/web\.archive\.org\/web\//.test(url)) {
    const r = await fetchBytes(rawWayback(url));
    if (!r.error) return { ...r, via: 'web.archive.org (already archived)' };
    // That exact capture is gone; look for any capture of the original URL inside it.
    const inner = url.replace(/^https?:\/\/web\.archive\.org\/web\/[^/]+\//, '');
    const wb = await wayback(inner);
    return wb.error ? { error: `${r.error}; ${wb.error}` } : { ...wb, via: 'wayback' };
  }
  const direct = await fetchBytes(url);
  if (!direct.error) return { ...direct, via: 'original' };
  const wb = await wayback(url);
  if (!wb.error) return { ...wb, via: 'wayback' };
  return { error: `${direct.error}; ${wb.error}` };
}

const slugPart = (slug) => slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/, '');

function attachmentName(url) {
  const u = new URL(url);
  const f = u.searchParams.get('file') || u.pathname.split('/').pop();
  return decodeURIComponent(f).split(/[\\/]/).pop().replace(/[^A-Za-z0-9._-]+/g, '-');
}

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function main() {
  const manifest = JSON.parse(await readFile(join(HERE, 'raw', 'manifest.json'), 'utf8'));
  let media = {};
  try { media = JSON.parse(await readFile(OUT, 'utf8')); } catch {}

  // Collect references in document order, per post.
  const refs = [];
  for (const [path, entry] of Object.entries(manifest)) {
    if (!path.startsWith('/post/')) continue;
    const [, , yyyy, , , slug] = path.split('/');
    const root = parse(await readFile(join(HERE, entry.file), 'utf8'), PARSE);
    const body = root.querySelector('.post-body');
    for (const el of body.querySelectorAll('img, a[href]')) {
      const isImg = el.tagName === 'IMG';
      const src = isImg ? el.getAttribute('src') : el.getAttribute('href');
      if (!src || isBadge(src)) continue;
      if (!isImg && !isMediaHref(src)) continue;
      refs.push({ path, yyyy, slug, src, kind: isImg ? 'img' : 'link' });
    }
  }

  const counters = {};
  let done = 0;
  for (const r of refs) {
    done++;
    const prev = media[r.src];
    if (prev && !FORCE && prev.status === 'ok' && (await exists(join(SITE, prev.target)))) continue;
    if (prev && !FORCE && prev.status !== 'ok' && !RETRY) continue;
    const url = absolute(r.src);
    const isFile = url && /\/file\.axd$/i.test(new URL(url).pathname);
    const got = await download(r.src);
    process.stdout.write(`\r${done}/${refs.length} ${got.error ? 'miss' : 'ok  '} ${r.src.slice(0, 70).padEnd(70)}`);
    if (got.error) {
      media[r.src] = { status: 'missing', post: r.path, kind: r.kind, note: got.error };
      continue;
    }
    let target;
    if (isFile) target = `files/${attachmentName(url)}`;
    else {
      const key = `${r.yyyy}/${slugPart(r.slug)}`;
      counters[key] = (counters[key] || Object.values(media).filter((m) => m.target?.startsWith(`img/${key}-`)).length) + 1;
      target = `img/${key}-${String(counters[key]).padStart(2, '0')}.${got.type}`;
    }
    await mkdir(dirname(join(SITE, target)), { recursive: true });
    await writeFile(join(SITE, target), got.buf);
    const dim = dimensions(got.buf, got.type) || {};
    media[r.src] = {
      status: 'ok', target: '/' + target, post: r.path, kind: r.kind, via: got.via, ...(got.archived ? { archived: got.archived } : {}),
      bytes: got.buf.length, ...dim, ...(got.buf.length > MAX_BYTES ? { note: 'over 300 KB' } : {}),
    };
  }

  const sorted = Object.fromEntries(Object.keys(media).sort().map((k) => [k, media[k]]));
  await writeFile(OUT, JSON.stringify(sorted, null, 1) + '\n');
  const all = Object.values(media);
  const by = (f) => all.filter(f).length;
  console.log(`\nmedia: ${all.length} distinct references; ok ${by((m) => m.status === 'ok')} (original ${by((m) => m.via === 'original')}, wayback ${by((m) => m.via?.startsWith?.('https://web.archive.org') || m.via === 'wayback')}, already archived ${by((m) => m.via === 'web.archive.org (already archived)')}); missing ${by((m) => m.status === 'missing')}; over 300 KB ${by((m) => m.note === 'over 300 KB')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error('\nmedia failed: ' + e.stack); process.exit(1); });
}

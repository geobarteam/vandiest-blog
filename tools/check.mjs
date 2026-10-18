#!/usr/bin/env node
// Validates posts against the conventions in AGENTS.md, and every page's internal links.
//   node tools/check.mjs                 whole site
//   node tools/check.mjs <file> [...]    only those files (used by the edit hook)
// Exits 1 on any error. Warnings (e.g. TODO markers) never fail the run.
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'node-html-parser';
import { walk, urlPath } from './build.mjs';
import { SITE } from './layout.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_DIR = join(ROOT, 'site');
const MAX_IMAGE = 300 * 1024;
const POST_RE = /^post\/(\d{4})\/(\d{2})\/(\d{2})\/([^/]+)\/index\.html$/;
const NEW_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Slugs of the old blog keep their exact spelling (Azure Static Web Apps paths are case-sensitive).
const LEGACY_FILE = join(ROOT, 'tools', 'legacy-urls.txt');
const LEGACY = new Set(existsSync(LEGACY_FILE)
  ? readFileSync(LEGACY_FILE, 'utf8').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((l) => l.startsWith('/post/'))
  : []);
const LANG_RE = /^language-(csharp|cs|bash|shell|powershell|xml|markup|html|json|javascript|js|typescript|sql|yaml|css|plaintext|none)$/;

const errors = [];
const warnings = [];
const err = (f, m) => errors.push(`${f}: ${m}`);
const warn = (f, m) => warnings.push(`${f}: ${m}`);

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

// Map a root-relative URL to the file SWA would serve for it.
async function resolveUrl(u) {
  const clean = decodeURIComponent(u.split('#')[0].split('?')[0]);
  if (clean === '' ) return true;
  const p = join(SITE_DIR, clean);
  if (!p.startsWith(SITE_DIR)) return false;
  if (clean.endsWith('/')) return exists(join(p, 'index.html'));
  return (await exists(p)) && !(await stat(p)).isDirectory() || exists(join(p, 'index.html'));
}

async function checkLinks(rel, root) {
  for (const el of root.querySelectorAll('[href], [src]')) {
    const attr = el.getAttribute('href') ?? el.getAttribute('src');
    if (!attr || el.tagName === 'LINK' && el.getAttribute('rel') === 'canonical') continue;
    if (el.tagName === 'META') continue;
    if (/^https?:\/\/(www\.)?vandiest\.biz(\/|$)/i.test(attr) && !['LINK'].includes(el.tagName)) {
      err(rel, `absolute link to own host, make it root-relative: ${attr}`);
      continue;
    }
    if (attr.startsWith('/') && !attr.startsWith('//')) {
      if (!(await resolveUrl(attr))) err(rel, `broken internal link: ${attr}`);
    }
  }
}

async function checkPost(rel, html, root) {
  const m = rel.split(sep).join('/').match(POST_RE);
  if (!m) return err(rel, 'post path must be post/yyyy/mm/dd/slug/index.html');
  const [, y, mo, d, slug] = m;
  if (!NEW_SLUG_RE.test(slug) && !LEGACY.has(`/post/${y}/${mo}/${d}/${slug}`)) return err(rel, 'slug must be lowercase ASCII with hyphens (only the legacy URLs in tools/legacy-urls.txt are exempt)');
  const iso = `${y}-${mo}-${d}`;
  const canonical = `${SITE.url}/post/${y}/${mo}/${d}/${slug}/`;

  if (!/^<!doctype html>/i.test(html.trimStart())) err(rel, 'missing <!doctype html>');
  if (!root.querySelector('html')?.getAttribute('lang')) err(rel, 'missing <html lang>');
  const title = root.querySelector('title')?.text.trim();
  if (!title || title.includes('{{')) err(rel, 'missing or unfilled <title>');
  const desc = root.querySelector('meta[name="description"]')?.getAttribute('content');
  if (!desc || desc.includes('{{')) err(rel, 'missing or unfilled meta description');
  else if (desc.length > 200) warn(rel, `description is ${desc.length} characters; aim for about 150`);
  const can = root.querySelector('link[rel="canonical"]')?.getAttribute('href');
  if (can !== canonical) err(rel, `canonical must be ${canonical}, found ${can}`);
  for (const p of ['og:title', 'og:description', 'og:url', 'og:type']) {
    if (!root.querySelector(`meta[property="${p}"]`)?.getAttribute('content')) err(rel, `missing ${p}`);
  }
  if (root.querySelector('meta[property="og:url"]')?.getAttribute('content') !== canonical) err(rel, 'og:url must equal the canonical URL');

  const lds = root.querySelectorAll('script[type="application/ld+json"]');
  if (lds.length !== 1) err(rel, `expected exactly one JSON-LD block, found ${lds.length}`);
  else {
    let ld;
    try { ld = JSON.parse(lds[0].text); } catch (e) { err(rel, `JSON-LD does not parse: ${e.message}`); }
    if (ld) {
      if (ld['@type'] !== 'BlogPosting') err(rel, 'JSON-LD @type must be BlogPosting');
      for (const k of ['headline', 'datePublished', 'dateModified', 'description']) {
        if (!ld[k] || String(ld[k]).includes('{{')) err(rel, `JSON-LD ${k} missing or unfilled`);
      }
      if (ld.datePublished && String(ld.datePublished).slice(0, 10) !== iso) err(rel, `JSON-LD datePublished ${ld.datePublished} does not match the path date ${iso}`);
      if (ld.dateModified && String(ld.dateModified).slice(0, 10) < iso) err(rel, 'dateModified is before datePublished');
      const kw = Array.isArray(ld.keywords) ? ld.keywords : String(ld.keywords || '').split(',').filter(Boolean);
      if (kw.length === 0) err(rel, 'JSON-LD keywords must hold at least one tag');
      if (ld.headline && title && !title.startsWith(ld.headline.replace(/&amp;/g, '&'))) warn(rel, '<title> does not start with the JSON-LD headline');
    }
  }

  const article = root.querySelector('main article');
  if (!article) return err(rel, 'missing <main> <article>');
  if (!article.querySelector('h1')) err(rel, 'missing <h1> in the article');
  const time = article.querySelector('time[datetime]');
  if (!time) err(rel, 'missing <time datetime> in the article');
  else if (time.getAttribute('datetime').slice(0, 10) !== iso) err(rel, `<time datetime> must be ${iso}`);
  const body = article.querySelector('div.post-body');
  if (!body) return err(rel, 'missing <div class="post-body">');
  if (body.querySelector('h1')) err(rel, 'headings inside the body start at <h2>');
  if (body.querySelector('[style]')) err(rel, 'inline style attribute inside the body');
  if (body.querySelector('script')) err(rel, '<script> inside the body');

  for (const pre of body.querySelectorAll('pre')) {
    const kids = pre.childNodes.filter((n) => n.nodeType === 1 || n.text.trim());
    const code = kids.length === 1 && kids[0].tagName === 'CODE' ? kids[0] : null;
    if (!code) { err(rel, 'every <pre> must hold exactly one <code>'); continue; }
    const lang = (code.getAttribute('class') || '').split(/\s+/).find((c) => c.startsWith('language-'));
    if (!lang) err(rel, '<pre><code> without a language-* class');
    else if (!LANG_RE.test(lang)) warn(rel, `unusual code language class ${lang}`);
    if (code.childNodes.some((n) => n.nodeType === 1)) err(rel, `unescaped markup inside a ${lang || ''} code block: ${code.toString().slice(0, 80)}`);
  }

  for (const img of body.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (!src.startsWith('/img/')) err(rel, `image must live under /img/: ${src}`);
    if (img.getAttribute('alt') === undefined) err(rel, `image without alt: ${src}`);
    if (!img.getAttribute('width') || !img.getAttribute('height')) err(rel, `image without width/height: ${src}`);
    if (img.getAttribute('loading') !== 'lazy') err(rel, `image without loading="lazy": ${src}`);
    if (src.startsWith('/img/')) {
      const p = join(SITE_DIR, decodeURIComponent(src));
      if (await exists(p)) {
        const size = (await stat(p)).size;
        if (size > MAX_IMAGE) err(rel, `image ${src} is ${Math.round(size / 1024)} KB, limit 300 KB`);
      }
    }
  }
}

async function checkFile(file) {
  const rel = relative(SITE_DIR, file);
  const html = await readFile(file, 'utf8');
  const root = parse(html, { comment: true, blockTextElements: { script: true, noscript: true, style: true } });
  if (/\bTODO\b/.test(html)) warn(rel, 'contains TODO');
  for (const r of ['header', 'footer']) {
    if (!html.includes(`<!-- site:${r} -->`)) err(rel, `missing <!-- site:${r} --> region`);
  }
  if (!root.querySelector('main')) err(rel, 'missing <main>');
  if (rel.split(sep)[0] === 'post') await checkPost(rel, html, root);
  await checkLinks(rel, root);
}

async function main() {
  const args = process.argv.slice(2);
  const files = args.length
    ? args.map((a) => resolve(a)).filter((f) => f.startsWith(SITE_DIR) && f.endsWith('.html'))
    : await walk(SITE_DIR);
  for (const f of files) await checkFile(f);

  if (!args.length) {
    const paths = new Set(files.map(urlPath));
    if (!paths.has('/404.html') && !(await exists(join(SITE_DIR, '404.html')))) err('site', 'missing 404.html');
    for (const f of ['rss.xml', 'sitemap.xml', 'robots.txt', 'staticwebapp.config.json']) {
      if (!(await exists(join(SITE_DIR, f)))) err('site', `missing ${f}`);
    }
  }

  for (const w of warnings) console.log('warn  ' + w.split(sep).join('/'));
  for (const e of errors) console.log('error ' + e.split(sep).join('/'));
  console.log(`check: ${files.length} files, ${errors.length} errors, ${warnings.length} warnings`);
  process.exit(errors.length ? 1 : 0);
}

main().catch((e) => { console.error('check failed: ' + e.message); process.exit(1); });

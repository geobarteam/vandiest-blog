#!/usr/bin/env node
// Regenerates everything derived from the posts: home, archive, rss.xml, sitemap.xml,
// search.json; refreshes the shared header, footer and sidebar in every page and in
// templates/post.html; rewrites each post's tag chips from its JSON-LD keywords.
// Output is deterministic: running it twice changes nothing.
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'node-html-parser';
import { SITE, header, footer, sidebar, head, esc, labelDate } from './layout.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_DIR = join(ROOT, 'site');
const TEMPLATE = join(ROOT, 'templates', 'post.html');
const HOME_COUNT = 10;
const FEED_COUNT = 20;
const GENERATED = new Set(['index.html', join('archive', 'index.html')]);

export async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

export const urlPath = (file) => {
  const rel = relative(SITE_DIR, file).split(sep).join('/');
  return '/' + rel.replace(/index\.html$/, '');
};

export function readPost(file, html) {
  const root = parse(html, { comment: false, blockTextElements: { script: true, noscript: true, style: true } });
  const ld = root.querySelector('script[type="application/ld+json"]');
  if (!ld) throw new Error(`${file}: no JSON-LD block`);
  let meta;
  try { meta = JSON.parse(ld.text); } catch (e) { throw new Error(`${file}: JSON-LD does not parse: ${e.message}`); }
  const body = root.querySelector('.post-body');
  const keywords = Array.isArray(meta.keywords)
    ? meta.keywords
    : String(meta.keywords || '').split(',').map((s) => s.trim()).filter(Boolean);
  const text = body ? body.text : '';
  return {
    file,
    path: urlPath(file),
    title: meta.headline,
    date: String(meta.datePublished).slice(0, 10),
    modified: String(meta.dateModified || meta.datePublished).slice(0, 10),
    description: meta.description || '',
    keywords,
    bodyHtml: body ? body.innerHTML.trim() : '',
    minutes: Math.max(1, Math.round(text.split(/\s+/).filter(Boolean).length / 220)),
  };
}

function replaceRegion(html, name, content) {
  const re = new RegExp(`<!-- site:${name} -->[\\s\\S]*?<!-- /site:${name} -->`);
  return re.test(html) ? html.replace(re, content) : html;
}

function refreshChrome(html, active, year) {
  let out = replaceRegion(html, 'header', header(active));
  out = replaceRegion(out, 'footer', footer(year));
  out = replaceRegion(out, 'sidebar', sidebar());
  return out;
}

function chipsHtml(keywords) {
  const items = keywords.map((k, i) => `<li><span class="chip${i ? ' chip--quiet' : ''}">${esc(k)}</span></li>`);
  return `<ul class="chips">${items.join('')}</ul>`;
}

async function writeIfChanged(file, content) {
  let old = null;
  try { old = await readFile(file, 'utf8'); } catch {}
  if (old === content) return false;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  return true;
}

function page({ title, description, path, active, year, main }) {
  return `<!doctype html>
<html lang="${SITE.language}">
<head>
  ${head({ title, description, path })}
</head>
<body>
${header(active)}
  <main id="main">
${main}
  </main>
${footer(year)}
</body>
</html>
`;
}

function card(p) {
  return `<li><a class="card" href="${p.path}">
          <span class="card__meta"><span class="chip">${esc(p.keywords[0] || 'Post')}</span><span class="card__date">${labelDate(p.date)}</span></span>
          <h3 class="card__title">${esc(p.title)}</h3>
          ${p.description ? `<p class="card__excerpt">${esc(p.description)}</p>` : ''}
          <span class="card__cta">Read &middot; ${p.minutes} min</span>
        </a></li>`;
}

function homePage(posts, year) {
  const latest = posts.slice(0, HOME_COUNT);
  const main = `    <section class="hero" aria-labelledby="hero-title">
      <img class="hero__scene" src="/img/site/hero_px.png" alt="" width="192" height="96" fetchpriority="high">
      <div class="hero__text">
        <p class="hero__eyebrow label">&gt; About software development_</p>
        <h1 id="hero-title">Build it right. Ship it faster.</h1>
        <p class="hero__lead">Notes on architecture, .NET, Azure, testing and AI-assisted development, written since ${SITE.firstYear}.</p>
        <div class="btn-row">
          ${latest[0] ? `<a class="btn btn--primary" href="${latest[0].path}">Read the latest post</a>` : ''}
          <a class="btn" href="/archive/">Browse the archive</a>
        </div>
      </div>
    </section>
    <section class="section wrap" aria-labelledby="latest-title">
      <div class="section__head">
        <h2 class="section__title" id="latest-title">Latest posts</h2>
        <span class="label">${posts.length} post${posts.length === 1 ? "" : "s"}</span>
      </div>
      <ul class="cards">
        ${latest.map(card).join('\n        ')}
      </ul>
    </section>`;
  return page({ title: `${SITE.name}: software development blog`, description: SITE.description, path: '/', active: 'home', year, main });
}

function archivePage(posts, year) {
  const byYear = new Map();
  for (const p of posts) {
    const y = p.date.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(p);
  }
  const sections = [...byYear].map(([y, list]) => `      <section class="archive-year" aria-labelledby="y${y}">
        <h2 id="y${y}">${y}</h2>
        <ul class="archive-list">
          ${list.map((p) => `<li><time class="label-s" datetime="${p.date}">${labelDate(p.date)}</time><a href="${p.path}">${esc(p.title)}</a></li>`).join('\n          ')}
        </ul>
      </section>`).join('\n');
  const main = `    <div class="wrap page page--wide">
      <h1>Archive</h1>
      <p>Every post since ${SITE.firstYear}, newest first. ${posts.length} in total.</p>
${sections}
    </div>`;
  return page({ title: `Archive | ${SITE.name}`, description: `All ${posts.length} posts by ${SITE.name}, by year.`, path: '/archive/', active: 'archive', year, main });
}

const absolutize = (html) => html.replace(/(href|src)="\/(?!\/)/g, `$1="${SITE.url}/`);
const rfc822 = (iso) => new Date(iso + 'T08:00:00Z').toUTCString();
const cdata = (s) => `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

function rss(posts) {
  const items = posts.slice(0, FEED_COUNT).map((p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${SITE.url}${p.path}</link>
      <guid isPermaLink="true">${SITE.url}${p.path}</guid>
      <pubDate>${rfc822(p.date)}</pubDate>
${p.keywords.map((k) => `      <category>${esc(k)}</category>`).join('\n')}
      <description>${cdata(absolutize(p.bodyHtml))}</description>
    </item>`).join('\n');
  const last = posts[0] ? rfc822(posts[0].modified > posts[0].date ? posts[0].modified : posts[0].date) : rfc822('2026-01-01');
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(SITE.name)}</title>
    <link>${SITE.url}/</link>
    <description>${esc(SITE.description)}</description>
    <language>${SITE.language}</language>
    <lastBuildDate>${last}</lastBuildDate>
    <atom:link href="${SITE.url}/rss.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
}

function sitemap(paths, posts) {
  const mod = new Map(posts.map((p) => [p.path, p.modified]));
  const urls = paths.map((p) => `  <url><loc>${SITE.url}${p}</loc>${mod.has(p) ? `<lastmod>${mod.get(p)}</lastmod>` : ''}</url>`);
  return `<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
}

export async function build({ quiet = false } = {}) {
  const files = (await walk(SITE_DIR)).sort();
  const posts = [];
  const changed = [];
  const isPost = (f) => relative(SITE_DIR, f).split(sep)[0] === 'post';

  for (const f of files) if (isPost(f)) posts.push(readPost(f, await readFile(f, 'utf8')));
  posts.sort((a, b) => (b.date + b.path).localeCompare(a.date + a.path));
  const year = Math.max(new Date().getFullYear(), ...posts.map((p) => +p.date.slice(0, 4)));

  for (const f of files) {
    const rel = relative(SITE_DIR, f);
    if (GENERATED.has(rel)) continue;
    let html = await readFile(f, 'utf8');
    const active = rel.startsWith('contact' + sep) ? 'contact' : null;
    html = refreshChrome(html, active, year);
    if (isPost(f)) {
      const p = posts.find((x) => x.file === f);
      html = html.replace(/<ul class="chips">[\s\S]*?<\/ul>/, chipsHtml(p.keywords));
    }
    if (await writeIfChanged(f, html)) changed.push(rel);
  }

  const tpl = refreshChrome(await readFile(TEMPLATE, 'utf8'), null, year);
  if (await writeIfChanged(TEMPLATE, tpl)) changed.push('templates/post.html');

  const out = {
    'index.html': homePage(posts, year),
    [join('archive', 'index.html')]: archivePage(posts, year),
    'rss.xml': rss(posts),
    'search.json': JSON.stringify(posts.map((p) => ({ title: p.title, url: p.path, date: p.date, description: p.description, tags: p.keywords })), null, 1) + '\n',
  };
  const pagePaths = [...new Set([...files.map((f) => relative(SITE_DIR, f)), ...Object.keys(out)])]
    .filter((r) => r.endsWith('index.html'))
    .map((r) => urlPath(join(SITE_DIR, r)))
    .sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
  out['sitemap.xml'] = sitemap(pagePaths, posts);

  for (const [rel, content] of Object.entries(out)) {
    if (await writeIfChanged(join(SITE_DIR, rel), content)) changed.push(rel);
  }
  if (!quiet) {
    console.log(`build: ${posts.length} posts, ${pagePaths.length} pages in sitemap, ${changed.length} files changed`);
    for (const c of changed) console.log('  ' + c.split(sep).join('/'));
  }
  return { posts, changed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  build().catch((e) => { console.error('build failed: ' + e.message); process.exit(1); });
}

// Shared chrome for every page. build.mjs stamps these into the marked regions
// (<!-- site:header --> ... <!-- /site:header --> and the same for footer and sidebar)
// of every HTML file under site/ and of templates/post.html.

export const SITE = {
  url: 'https://vandiest.biz',
  name: 'Geoffrey Vandiest',
  author: 'Geoffrey Vandiest',
  description:
    'Geoffrey Vandiest on software development: architecture, .NET, Azure, testing and AI-assisted development.',
  language: 'en',
  firstYear: 2008,
};

const NAV = [
  { key: 'home', label: 'Home', href: '/' },
  { key: 'archive', label: 'Archive', href: '/archive/' },
  { key: 'contact', label: 'Contact', href: '/contact/' },
];

export function header(active = null) {
  const links = NAV.map((n) => {
    const on = n.key === active;
    return `<li><a class="nav__link${on ? ' nav__link--active' : ''}" href="${n.href}"${on ? ' aria-current="page"' : ''}>${n.label}</a></li>`;
  }).join('\n        ');
  return `<!-- site:header -->
  <a class="skip" href="#main">Skip to content</a>
  <header class="nav">
    <a class="nav__brand" href="/"><img class="pixel" src="/img/site/avatar_px.png" alt="" width="32" height="32">${SITE.name}</a>
    <nav aria-label="Main">
      <ul class="nav__links">
        ${links}
        <li><a class="nav__link nav__link--cta" href="/rss.xml">RSS</a></li>
      </ul>
    </nav>
  </header>
  <!-- /site:header -->`;
}

export function footer(year = new Date().getFullYear()) {
  return `<!-- site:footer -->
  <footer class="footer">
    <p class="footer__brand">${SITE.name}</p>
    <ul class="footer__links">
      <li><a href="/archive/">Archive</a></li>
      <li><a href="/rss.xml">RSS</a></li>
      <li><a href="/contact/">Contact</a></li>
    </ul>
    <p class="footer__copy">&copy; ${SITE.firstYear}&ndash;${year} ${SITE.author}</p>
  </footer>
  <!-- /site:footer -->`;
}

export function sidebar() {
  return `<!-- site:sidebar -->
    <aside class="sidebar" aria-label="About this blog">
      <div class="box box--sky">
        <p class="label">About</p>
        <p><img class="pixel avatar" src="/img/site/avatar_px.png" alt="" width="40" height="40">${SITE.description}</p>
      </div>
      <div class="box">
        <p class="label">Subscribe</p>
        <p>New posts arrive in the feed the minute they are published.</p>
        <a class="btn btn--sun btn--label" href="/rss.xml">RSS feed</a>
      </div>
      <div class="box">
        <p class="label">More</p>
        <p><a href="/archive/">Every post since ${SITE.firstYear}, by year</a></p>
      </div>
    </aside>
    <!-- /site:sidebar -->`;
}

// <head> for pages the build script writes in full (home, archive).
export function head({ title, description, path, type = 'website' }) {
  const url = SITE.url + path;
  return `<meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${url}">
  <meta property="og:type" content="${type}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${url}">
  <meta property="og:site_name" content="${SITE.name}">
  <meta name="theme-color" content="#1e3a6e">
  <link rel="preload" href="/fonts/pixelify-sans.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/fonts/nunito-sans.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/css/site.css">
  <link rel="icon" href="/img/site/avatar_px.png" type="image/png">
  <link rel="alternate" type="application/rss+xml" title="${SITE.name}" href="/rss.xml">`;
}

export function esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// "2026-04-18" -> "18 APR 2026" (the label-s date style of the design system)
export function labelDate(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
}

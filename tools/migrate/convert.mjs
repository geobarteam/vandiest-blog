#!/usr/bin/env node
// D3 step 2: turn each raw BlogEngine page into site/post/yyyy/mm/dd/<original slug>/index.html
// following AGENTS.md. Run media.mjs first: this script reads tools/migrate/media.json for
// image targets and sizes. Writes tools/migrate/report.md and tools/legacy-urls.txt.
// Deterministic: the same raw input gives the same output.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'node-html-parser';
import { esc, labelDate } from '../layout.mjs';
import { absolute, isBadge, isMediaHref } from './media.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SITE = join(ROOT, 'site');
const PARSE = { comment: false, blockTextElements: { script: true, noscript: true, style: true } };
const SITE_URL = 'https://vandiest.biz';
const OWN_HOSTS = /^(www\.|geoffrey\.)?vandiest\.biz$/i;

// ---------- Tags ----------
// Spelling fixes for the tags the old posts carry.
const TAG_FIX = {
  'unit testing': 'Unit testing', 'unit test': 'Unit testing', 'test': 'Testing', 'integration test': 'Integration testing',
  'prism': 'Prism', 'puzzle': 'Puzzle', 'iterator': 'Iterator', 'javascript': 'JavaScript', 'dependancy injection': 'Dependency injection',
  'ioc': 'IoC', 'ipad': 'iPad', 'iphone': 'iPhone', 'msmq': 'MSMQ', 'html5': 'HTML5', 'http': 'HTTP', 'ie': 'Internet Explorer',
  'mvc': 'ASP.NET MVC', 'mvc3': 'ASP.NET MVC', 'wcf4': 'WCF', 'tfs': 'TFS', 'alm': 'ALM', 'c#2': 'C#', 'windows forms': 'Windows Forms',
  'caching': 'Caching', 'design': 'Design', 'testability': 'Testability', 'config': 'Configuration', 'debug': 'Debugging',
  'code': null, 'questions': null, 'region': null, 'views': null, 'command': null, 'container': null, 'developer': null,
  'architect': 'Architecture', 'interview': 'Career', 'software factory': 'Software factory', 'local storage': 'Local storage',
  'sharing assemblies': 'Sharing assemblies', 'kata': 'Kata',
};
// Vocabulary for posts without tags, and for the leading tag shown on cards.
// [tag, pattern, weight]; the title counts five times the body.
const VOCAB = [
  ['AI development', /\b(ai|llm|copilot|claude|ai agents?|spec-driven|vibe coding)\b/gi],
  ['Unit testing', /unit[- ]?test|\btdd\b|test-driven|\bnunit\b|\bmstest\b|\bxunit\b|\bmocks?\b|bowling game/gi],
  ['Testing', /\btest(s|ing)?\b|test pyramid/gi],
  ['Architecture', /architect|onion|anti-pattern|coupling|\bdomain\b|reference application/gi],
  ['Design patterns', /design patterns?|\bkata\b|decorator|abstract factory/gi],
  ['Agile', /\bagile\b|\bscrum\b|prince2|continuous delivery|quality|feature[- ]teams?|dream team/gi],
  ['Single-page apps', /single[- ]page app|\bspas?\b/gi],
  ['Puzzle', /\bpuzzles?\b/gi],
  ['Office', /\boutlook\b|ms office|microsoft office/gi],
  ['Azure', /\bazure\b/gi],
  ['ASP.NET', /asp\.?net|\bmvc\b|umbraco|webforms/gi],
  ['WCF', /\bwcf\b|\bmsmq\b|web ?services?|\bsoap\b|contract[- ]first/gi],
  ['WPF', /\bwpf\b|\bmvvm\b|\bprism\b|silverlight/gi],
  ['Angular', /angular/gi],
  ['React', /\breact\b/gi],
  ['TypeScript', /typescript|\bgulp\b/gi],
  ['JavaScript', /javascript|node\.?js|\bnpm\b|johnny-five/gi],
  ['PowerShell', /powershell/gi],
  ['Visual Studio', /visual studio|textmate/gi],
  ['Git', /\bgit\b/gi],
  ['DevOps', /devops|continuous (integration|delivery)|resource manager|infrastructure|build server|\bdeploy/gi],
  ['Coding for kids', /\bscratch\b|\bkodu\b|\bkids\b|children/gi],
  ['Arduino', /arduino|robot/gi],
  ['SharePoint', /sharepoint/gi],
  ['Logging', /log4net|\blogging\b/gi],
  ['Career', /interview|certification|role of a software architect/gi],
  ['.NET', /\.net\b|\bc#|entity framework|\bclr\b/gi],
];
const VOCAB_NAMES = new Set(VOCAB.map(([t]) => t));

function scoreTags(title, text) {
  return VOCAB.map(([tag, re]) => {
    const t = (title.match(re) || []).length;
    const b = Math.min((text.match(re) || []).length, 20);
    return { tag, score: t * 5 + b, inTitle: t > 0 };
  }).filter((s) => s.score >= 3 || s.inTitle).sort((a, b) => b.score - a.score);
}

function chooseTags(original, title, text) {
  const fixed = [];
  for (const t of original) {
    const k = t.trim().toLowerCase();
    const v = k in TAG_FIX ? TAG_FIX[k] : t.trim();
    if (v && !fixed.some((f) => f.toLowerCase() === v.toLowerCase())) fixed.push(v);
  }
  const scored = scoreTags(title, text);
  const inferred = [];
  const lead = scored[0]?.tag;
  if (lead && !fixed.some((f) => f.toLowerCase() === lead.toLowerCase())) inferred.push(lead);
  if (fixed.length === 0) {
    for (const s of scored.slice(1, 3)) if (!inferred.includes(s.tag)) inferred.push(s.tag);
  }
  if (fixed.length === 0 && inferred.length === 0) inferred.push('Software development');
  const tags = [...inferred.slice(0, 1), ...fixed, ...inferred.slice(1)].slice(0, 5);
  return { tags, inferred };
}

// ---------- Code ----------
const BRUSH = { js: 'javascript', jscript: 'javascript', javascript: 'javascript', ps: 'powershell', powershell: 'powershell', html: 'html', xml: 'xml', xhtml: 'html', csharp: 'csharp', 'c#': 'csharp', cs: 'csharp', sql: 'sql', bash: 'bash', shell: 'bash', css: 'css', plain: 'plaintext', text: 'plaintext' };
const GH = { cs: 'csharp', csharp: 'csharp', js: 'javascript', ts: 'typescript', json: 'json', shell: 'bash', powershell: 'powershell', yaml: 'yaml', xml: 'xml', html: 'html', css: 'css', sql: 'sql', md: 'plaintext', text: 'plaintext' };

function hintFrom(el) {
  for (let n = el; n && n.tagName; n = n.parentNode) {
    const cls = n.getAttribute?.('class') || '';
    let m = cls.match(/brush:\s*([\w#]+)/i);
    if (m && BRUSH[m[1].toLowerCase()]) return BRUSH[m[1].toLowerCase()];
    m = cls.match(/highlight-(?:source|text)-([\w]+)/i);
    if (m && GH[m[1].toLowerCase()]) return GH[m[1].toLowerCase()];
    m = cls.match(/\blang(?:uage)?-([\w#]+)/i);
    if (m && BRUSH[m[1].toLowerCase()]) return BRUSH[m[1].toLowerCase()];
  }
  return null;
}

export function guessLanguage(code) {
  const s = code.trim();
  if (/^<\?xml|^<(configuration|project|package|xs:|wsdl|soap|s:|bindings|services|system\.|add |endpoint|behaviors?)\b/i.test(s)) return 'xml';
  if (/^<(!doctype|html|div|span|p|ul|li|script|head|body|form|input|button|table|a|img|asp:|%@|ng-|app-|router)\b/i.test(s) || (/^</.test(s) && /<\/\w+>\s*$/.test(s))) {
    return /<\w+:\w+|xmlns|<\/?(add|binding|endpoint|setting)\b/i.test(s) ? 'xml' : 'html';
  }
  if (/^[\[{]\s*("|\n\s*")/.test(s) && /[}\]]\s*$/.test(s)) return 'json';
  if (/^\s*(Get|Set|New|Import|Install|Add|Remove|Invoke|Write)-\w+|\$PSVersionTable|\$host\.version|Set-ExecutionPolicy/im.test(s)) return 'powershell';
  if (/\bSELECT\b[\s\S]+\bFROM\b|\bINSERT\s+INTO\b|\bCREATE\s+TABLE\b/i.test(s)) return 'sql';
  if (/^\s*(import .+ from ['"]|export (default )?(class|function|const)|@(Component|NgModule|Injectable)\()|:\s*(string|number|boolean)\b|\binterface \w+\s*\{/m.test(s)) return 'typescript';
  if (/\b(namespace|using System|public (sealed |static |abstract |partial )*(class|interface|void|override)|private (readonly )?\w+[<\w>]* _?\w+;|\[(Test|TestMethod|Fact|TestFixture|SetUp)\])/.test(s)) return 'csharp';
  if (/\bfunction\s*\w*\s*\(|\bvar \w+ = (function|\{|\[|require|new)|=>\s*\{|console\.log|require\(['"]|\$\(['"]|document\.|module\.exports/.test(s)) return 'javascript';
  if (/^\s*(\$ |> )?(npm|ng|git|dotnet|cd|mkdir|node|yo|gulp|bower|tsc|npx|choco|apt-get|sudo)\b/m.test(s) && s.split('\n').length < 15) return 'bash';
  if (/^<%@|^<(meta|link)\b/.test(s)) return 'html';
  if (/^(public|private|protected|internal)\s+(static\s+|override\s+|virtual\s+|async\s+)*[\w<>,\s]+\(/.test(s)) return 'csharp';
  if (/\b(public|private|protected|internal|static|void|var|new|return|class|using|typeof|override)\b[\s\S]*[;{}]/.test(s)) return 'csharp';
  // Short fragments from a .NET blog: statements, braces, comments, attributes.
  if (/^[{}]$|;\s*$|^\/\/|^\[\w+(\(.*\))?\]$|\w+\.\w+\s*=\s*[\w.]+/m.test(s) && !/^\s*(SELECT|<)/i.test(s)) return 'csharp';
  return 'plaintext';
}

// Text of one <pre> line or block: <br> becomes a newline, line-number spans go.
function preText(pre) {
  for (const ln of pre.querySelectorAll('span.lnum')) ln.remove();
  for (const br of pre.querySelectorAll('br')) br.replaceWith('\n');
  return pre.text.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
}

function tidyCode(rawLines) {
  const out = rawLines.join('\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  // Drop indentation shared by every non-empty line.
  const indent = (l) => l.match(/^ */)[0].length;
  const filled = out.filter((l) => l.trim());
  const cut = filled.length ? Math.min(...filled.map(indent)) : 0;
  let lines = out.map((l) => l.slice(cut));
  // A selection copied from mid-line: the first line has no indent, the rest keep theirs,
  // and the closing brace sits at the rest's indent. Shift the rest back.
  const rest = lines.slice(1).filter((l) => l.trim());
  if (lines.length > 2 && indent(lines[0]) === 0 && rest.length) {
    const k = Math.min(...rest.map(indent));
    const last = rest[rest.length - 1];
    if (k > 0 && /^\s*}\s*;?$/.test(last) && indent(last) === k) lines = [lines[0], ...lines.slice(1).map((l) => l.slice(Math.min(k, indent(l))))];
  }
  return lines.join('\n');
}

const nonSpace = (s) => s.replace(/\s+/g, '');
const isElement = (n) => n && n.nodeType === 1;
// node-html-parser text nodes have no usable nextSibling, so walk the parent's child list.
const siblingsAfter = (n) => { const kids = n.parentNode.childNodes; return kids.slice(kids.indexOf(n) + 1); };
const onlyWhitespaceBetween = (a, b) => {
  for (const n of siblingsAfter(a)) {
    if (n === b) return true;
    if (isElement(n) || n.text.replace(/\u00a0/g, ' ').trim()) return false;
  }
  return false;
};
const nextElement = (n) => siblingsAfter(n).find(isElement) || null;

// Line numbers typed as plain text ("  1: public class ...") when every line has one.
function stripLineNumbers(text) {
  const lines = text.split('\n');
  const filled = lines.filter((l) => l.trim());
  if (filled.length < 2 || !filled.every((l) => /^\s*\d+:(\s|$)/.test(l))) return text;
  return lines.map((l) => l.replace(/^\s*\d+:\s?/, '')).join('\n');
}

const isCodeDiv = (n) => n && n.tagName === 'DIV' && (/\bcsharpcode\b/.test(n.getAttribute('class') || '') || /codeSnippet/i.test(n.getAttribute('id') || ''));

function convertCode(body, stats) {
  // A <pre> that wraps paragraphs is damaged markup, not code: keep its content, drop the <pre>.
  for (let again = true; again;) {
    again = false;
    for (const pre of body.querySelectorAll('pre')) {
      if (pre.querySelector('p, h1, h2, h3, h4, ul, ol, table, blockquote, img')) { unwrap(pre); again = true; break; }
    }
  }

  const groups = [];
  const seen = new Set();
  for (const pre of body.querySelectorAll('pre')) {
    if (seen.has(pre)) continue;
    let anc = pre.parentNode; let insidePre = false;
    while (anc && anc !== body) { if (anc.tagName === 'PRE') { insidePre = true; break; } anc = anc.parentNode; }
    if (insidePre) continue;

    const parent = pre.parentNode;
    const hint = hintFrom(pre);
    let pres;
    if (pre.querySelector('pre')) {
      // A <pre> holding one <pre> per line (Live Writer variant): the leaves are the lines.
      const leaves = pre.querySelectorAll('pre').filter((p) => !p.querySelector('pre'));
      leaves.forEach((p) => seen.add(p));
      groups.push({ anchor: pre, remove: [], texts: leaves.map(preText), hint });
      seen.add(pre);
      continue;
    }
    if (isCodeDiv(parent)) {
      // CopySourceAsHtml / "Paste from Visual Studio": one <pre> per line inside a div.
      // Some posts put every line in its own div: join a run of sibling code divs.
      const containers = [parent];
      for (let next = nextElement(parent); next && isCodeDiv(next) && onlyWhitespaceBetween(containers[containers.length - 1], next); next = nextElement(next)) containers.push(next);
      pres = containers.flatMap((c) => c.childNodes.filter((n) => n.tagName === 'PRE'));
    } else {
      // Standalone <pre>: merge a run of consecutive single-line siblings (styled lines).
      const run = [pre];
      for (let next = nextElement(pre); next && next.tagName === 'PRE' && onlyWhitespaceBetween(run[run.length - 1], next) && !next.querySelector('pre'); next = nextElement(next)) run.push(next);
      const styled = run.every((p) => p.getAttribute('style'));
      const trimBlank = (t) => t.replace(/^(?:[ \t]*\n)+/, '').replace(/\n[ \t]*$/, '').replace(/\n+$/, '');
      const texts = run.map(preText);
      const singleLines = run.length > 1 && (styled || texts.every((t) => !trimBlank(t).includes('\n')));
      pres = singleLines ? run : [pre];
      if (singleLines) { pres.forEach((p) => seen.add(p)); groups.push({ anchor: pre, remove: run.slice(1), texts: texts.map(trimBlank), hint }); continue; }
    }
    pres.forEach((p) => seen.add(p));
    groups.push({ anchor: pres[0], remove: pres.slice(1), texts: pres.map(preText), hint });
  }

  for (const g of groups) {
    const text = stripLineNumbers(g.texts.join('\n'));
    const before = nonSpace(text);
    const code = tidyCode([text]);
    for (const r of g.remove) r.remove();
    if (!code.trim()) { g.anchor.remove(); stats.empty = (stats.empty || 0) + 1; continue; }
    const lang = g.hint || guessLanguage(code);
    g.anchor.replaceWith('<pre><code class="language-' + lang + '">' + esc(code).replace(/&quot;/g, '"') + '</code></pre>');
    stats.blocks++;
    stats.lines += g.texts.length;
    stats.langs[lang] = (stats.langs[lang] || 0) + 1;
    if (nonSpace(code) !== before) stats.altered++;
  }
}

// ---------- Body ----------
const KEEP_ATTRS = {
  A: ['href', 'title'], IMG: ['src', 'alt', 'title', 'width', 'height', 'loading', 'class'], TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan', 'scope'],
  OL: ['start', 'type'], IFRAME: ['src', 'width', 'height', 'title', 'allow', 'allowfullscreen', 'loading'], BLOCKQUOTE: ['cite'],
  CODE: ['class'], PRE: [], ASIDE: ['class'], EM: ['class'], TIME: ['datetime'],
};
const UNWRAP = new Set(['FONT', 'SPAN', 'CENTER', 'O:P', 'U', 'BIG', 'NOBR', 'ARTICLE', 'SECTION']);
const DROP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'OBJECT', 'EMBED', 'PARAM', 'FORM', 'INPUT', 'BUTTON', 'svg', 'SVG', 'META', 'LINK']);

function unwrap(el) {
  el.replaceWith(...el.childNodes);
}

function legacyIndex(manifest) {
  const byLower = new Map();
  for (const p of Object.keys(manifest)) if (p.startsWith('/post/')) byLower.set(p.toLowerCase(), p);
  const bySlug = new Map();
  for (const p of byLower.values()) bySlug.set(p.split('/').pop().toLowerCase(), p);
  return { byLower, bySlug };
}

// Root-relative URL for a link to the old site, or null to drop the link but keep its text.
function ownLink(href, legacy) {
  let u;
  try { u = new URL(href, 'http://vandiest.biz/post/x/y/z/a'); } catch { return null; }
  if (!OWN_HOSTS.test(u.hostname)) return undefined; // not ours
  let p = decodeURIComponent(u.pathname).replace(/\.aspx$/i, '').replace(/\/$/, '');
  if (p === '' || p === '/default') return '/';
  if (/^\/(\?tag=|tag\/|category\/|archive|search|page\/gentsbbq|author\/|contact)/i.test(p + u.search) && !p.startsWith('/post/')) {
    return /contact/i.test(p) ? '/contact/' : null;
  }
  const direct = legacy.byLower.get(p.toLowerCase());
  if (direct) return direct + '/' + (u.hash || '');
  const slug = p.split('/').pop().toLowerCase();
  if (legacy.bySlug.has(slug)) return legacy.bySlug.get(slug) + '/' + (u.hash || '');
  return null;
}

function cleanBody(body, ctx) {
  const { media, legacy, stats, notes } = ctx;
  for (const el of body.querySelectorAll('*')) if (DROP.has(el.tagName)) el.remove();

  // Badges and share buttons.
  for (const img of body.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (!src.trim() || isBadge(src)) {
      const a = img.parentNode;
      if (a?.tagName === 'A' && a.childNodes.filter((n) => isElement(n) || n.text.trim()).length === 1) a.remove(); else img.remove();
      stats.badges++;
    }
  }
  for (const a of body.querySelectorAll('a')) {
    if (isBadge(a.getAttribute('href') || '') && !a.text.trim()) a.remove();
  }

  convertCode(body, stats.code);

  // Images.
  let n = 0;
  for (const img of body.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    const m = media[src];
    if (m?.status === 'ok' && m.target.startsWith('/img/')) {
      img.setAttribute('src', m.target);
      if (m.width && m.height) { img.setAttribute('width', String(m.width)); img.setAttribute('height', String(m.height)); }
      img.setAttribute('loading', 'lazy');
      if (!img.getAttribute('alt')) img.setAttribute('alt', '');
      if (m.width && m.width <= 400 && /\.(png|gif)$/.test(m.target) && m.width / (m.height || 1) > 1.5 && m.bytes < 4096) {
        // tiny pixel images: leave as is
      }
      stats.images.ok++;
      if (!ctx.firstImage) ctx.firstImage = m.target;
      n++;
    } else {
      const note = `<em class="lost">[Image no longer available${img.getAttribute('alt') ? ': ' + esc(img.getAttribute('alt')) : ''}]</em>`;
      const a = img.parentNode;
      if (a?.tagName === 'A' && a.childNodes.filter((x) => isElement(x) || x.text.trim()).length === 1) a.replaceWith(note); else img.replaceWith(note);
      stats.images.missing++;
      notes.push(`image lost: ${src}${m?.note ? ' (' + m.note + ')' : ''}`);
    }
  }

  // Links.
  for (const a of body.querySelectorAll('a')) {
    const href = (a.getAttribute('href') || '').trim();
    if (!href || href === '#' || /#comment/i.test(href) || /^javascript:/i.test(href)) { if (!a.getAttribute('name')) unwrap(a); else unwrap(a); continue; }
    if (isMediaHref(href)) {
      const m = media[href];
      if (m?.status === 'ok') { a.setAttribute('href', m.target); continue; }
      unwrap(a); notes.push(`media link lost: ${href}`); continue;
    }
    if (/^\$|^file:|localhost|^http$|^https?:\/?$/i.test(href)) { unwrap(a); stats.links.dropped++; continue; }
    const abs = /^https?:\/\//i.test(href) || href.startsWith('/') || href.startsWith('../') ? href : null;
    if (!abs) { if (!/^(mailto:|#)/i.test(href)) { unwrap(a); stats.links.dropped++; } continue; }
    const own = ownLink(href, legacy);
    if (own === undefined) { stats.links.external++; continue; }
    if (own === null) { unwrap(a); stats.links.dropped++; notes.push(`internal link dropped: ${href}`); continue; }
    a.setAttribute('href', own);
    stats.links.internal++;
  }

  // Strip attributes, unwrap presentational wrappers.
  for (const el of body.querySelectorAll('*')) {
    if (UNWRAP.has(el.tagName)) continue;
    const keep = KEEP_ATTRS[el.tagName] || [];
    for (const name of Object.keys(el.attributes)) if (!keep.includes(name.toLowerCase())) el.removeAttribute(name);
    if (el.tagName === 'CODE' && !(el.getAttribute('class') || '').startsWith('language-')) el.removeAttribute('class');
    if (el.tagName === 'IMG' && el.getAttribute('class') !== 'pixel') el.removeAttribute('class');
    if (el.tagName === 'EM' && el.getAttribute('class') !== 'lost') el.removeAttribute('class');
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const el of body.querySelectorAll('*')) if (UNWRAP.has(el.tagName)) { unwrap(el); changed = true; break; }
  }
  for (const h of body.querySelectorAll('h1')) { h.tagName = 'H2'; h.rawTagName = 'h2'; }

  // Empty paragraphs and divs left behind by Live Writer.
  for (const el of body.querySelectorAll('p, div')) {
    if (!el.text.replace(/\u00a0|&nbsp;/g, '').trim() && !el.querySelector('img, iframe, pre, em.lost, table, hr')) el.remove();
  }
}

function description(body) {
  for (const el of body.querySelectorAll('p, div, li')) {
    if (el.querySelector('p, div')) continue;
    const t = el.text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    if (t.length < 60 || /^\[Image/.test(t)) continue;
    if (t.length <= 160) return t;
    const cut = t.slice(0, 160);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    if (end >= 80) return cut.slice(0, end + 1);
    return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:\s-]+$/, '') + '…';
  }
  const t = body.text.replace(/\s+/g, ' ').trim();
  return t.length <= 160 ? t : t.slice(0, t.lastIndexOf(' ', 157)) + '…';
}

function tidyHtml(html) {
  // Set code blocks aside so their whitespace is never touched.
  const blocks = [];
  const shelved = html.replace(/\r\n?/g, '\n').replace(/<pre>[\s\S]*?<\/pre>/g, (m) => `\u0000${blocks.push(m) - 1}\u0000`);
  return shelved
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .split('\n')
    .map((l) => (l.trim() ? '          ' + l.replace(/^\s+/, '') : ''))
    .join('\n')
    .replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[+i]);
}

// ---------- Page ----------
function fillTemplate(tpl, p) {
  const [yyyy, mm, dd] = p.date.split('-');
  const MON = labelDate(p.date).split(' ')[1];
  const ld = {
    '@context': 'https://schema.org', '@type': 'BlogPosting', headline: p.title, datePublished: p.date, dateModified: p.date,
    description: p.description, keywords: p.tags, ...(p.image ? { image: SITE_URL + p.image } : {}),
    author: { '@type': 'Person', name: 'Geoffrey Vandiest' },
  };
  const ldText = JSON.stringify(ld, null, 2).replace(/</g, '\\u003c').split('\n').map((l) => '  ' + l).join('\n');
  return tpl
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, () => `<script type="application/ld+json">\n${ldText}\n  </script>`)
    .replace(/https:\/\/vandiest\.biz\/post\/\{\{yyyy\}\}\/\{\{mm\}\}\/\{\{dd\}\}\/\{\{slug\}\}\//g, () => `${SITE_URL}${p.path}/`)
    .replace(/<div class="post-body">[\s\S]*?<\/div>\n      <\/article>/, () => `<div class="post-body">\n${p.body}\n        </div>\n      </article>`)
    .replace(/\{\{title\}\}/g, () => esc(p.title))
    .replace(/\{\{description\}\}/g, () => esc(p.description))
    .replace(/\{\{yyyy\}\}/g, yyyy).replace(/\{\{mm\}\}/g, mm).replace(/\{\{dd\}\}/g, dd).replace(/\{\{MON\}\}/g, MON);
}

async function main() {
  const manifest = JSON.parse(await readFile(join(HERE, 'raw', 'manifest.json'), 'utf8'));
  const media = JSON.parse(await readFile(join(HERE, 'media.json'), 'utf8'));
  const tpl = await readFile(join(ROOT, 'templates', 'post.html'), 'utf8');
  const legacy = legacyIndex(manifest);
  const rows = [];
  const totals = { posts: 0, blocks: 0, lines: 0, altered: 0, plaintext: 0, imgOk: 0, imgMissing: 0, badges: 0, inferred: 0, external: 0, dropped: 0 };
  const langTotals = {};

  for (const [path, entry] of Object.entries(manifest)) {
    if (!path.startsWith('/post/')) continue;
    const [, , yyyy, mm, dd] = path.split('/');
    const root = parse(await readFile(join(HERE, entry.file), 'utf8'), PARSE);
    const title = root.querySelector('.post-title').text.replace(/\s+/g, ' ').trim();
    const originalTags = root.querySelectorAll('.post-tags a').map((a) => a.text.trim()).filter(Boolean);
    const body = root.querySelector('.post-body');
    const stats = { code: { blocks: 0, lines: 0, altered: 0, langs: {} }, images: { ok: 0, missing: 0 }, links: { internal: 0, external: 0, dropped: 0 }, badges: 0 };
    const notes = [];
    const ctx = { media, legacy, stats, notes, firstImage: null };
    cleanBody(body, ctx);
    const text = body.text.replace(/\s+/g, ' ');
    const { tags, inferred } = chooseTags(originalTags, title, text);
    const desc = description(body);
    const html = tidyHtml(body.innerHTML);
    const page = fillTemplate(tpl, { path, title, date: `${yyyy}-${mm}-${dd}`, description: desc, tags, image: ctx.firstImage, body: html });
    const out = join(SITE, ...path.split('/').filter(Boolean), 'index.html');
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, page);

    const c = stats.code;
    const plain = c.langs.plaintext || 0;
    for (const [k, v] of Object.entries(c.langs)) langTotals[k] = (langTotals[k] || 0) + v;
    Object.assign(totals, {
      posts: totals.posts + 1, blocks: totals.blocks + c.blocks, lines: totals.lines + c.lines, altered: totals.altered + c.altered,
      plaintext: totals.plaintext + plain, imgOk: totals.imgOk + stats.images.ok, imgMissing: totals.imgMissing + stats.images.missing,
      badges: totals.badges + stats.badges, inferred: totals.inferred + (inferred.length ? 1 : 0),
      external: totals.external + stats.links.external, dropped: totals.dropped + stats.links.dropped,
    });
    const flags = [];
    if (plain) flags.push(`${plain} code block(s) without a known language`);
    if (c.altered) flags.push(`${c.altered} code block(s) changed text`);
    if (stats.images.missing) flags.push(`${stats.images.missing} image(s) lost`);
    if (originalTags.length === 0) flags.push('all tags inferred');
    rows.push({ path, title, date: `${yyyy}-${mm}-${dd}`, tags, inferred, c, stats, notes, flags });
  }

  rows.sort((a, b) => (b.date + b.path).localeCompare(a.date + a.path));
  await writeFile(join(ROOT, 'tools', 'legacy-urls.txt'),
    '# Every post URL of the old BlogEngine site. These paths must answer 200 forever.\n# check.mjs accepts their mixed-case slugs; new posts use lowercase slugs.\n' +
    rows.map((r) => r.path).sort().join('\n') + '\n');

  const mediaAll = Object.values(media);
  const lines = [
    '# Migration report', '',
    'Generated by `node tools/migrate/convert.mjs`. Inferred tags are marked with an asterisk. The review pass (D4) adds a confidence mark per post.', '',
    '## Totals', '',
    '| Measure | Count |', '| --- | --- |',
    `| Posts converted | ${totals.posts} |`,
    `| Code blocks written (from ${totals.lines} raw \`<pre>\` lines or blocks) | ${totals.blocks} |`,
    `| Code blocks whose text changed beyond whitespace | ${totals.altered} |`,
    `| Code blocks without a known language (\`language-plaintext\`) | ${totals.plaintext} |`,
    `| Code languages | ${Object.entries(langTotals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')} |`,
    `| Images placed | ${totals.imgOk} |`,
    `| Images lost (one-line note left in the post) | ${totals.imgMissing} |`,
    `| Badges removed (kick it, LinkedIn) | ${totals.badges} |`,
    `| Posts with at least one inferred tag | ${totals.inferred} |`,
    `| Off-site links kept | ${totals.external} |`,
    `| Links dropped, text kept | ${totals.dropped} |`,
    `| Media downloads: original / Wayback / already archived / missing | ${mediaAll.filter((m) => m.via === 'original').length} / ${mediaAll.filter((m) => m.via === 'wayback').length} / ${mediaAll.filter((m) => m.via === 'web.archive.org (already archived)').length} / ${mediaAll.filter((m) => m.status === 'missing').length} |`,
    '',
    '## Posts', '',
    '| Date | Post | Tags | Code | Images | Flags |', '| --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.date} | [${r.title.replace(/\|/g, '\\|')}](../../site${r.path.replace(/\(/g, '%28').replace(/\)/g, '%29')}/index.html) | ${r.tags.map((t) => (r.inferred.includes(t) ? t + '*' : t)).join(', ')} | ${r.c.blocks} | ${r.stats.images.ok} ok${r.stats.images.missing ? `, ${r.stats.images.missing} lost` : ''} | ${r.flags.join('; ') || '—'} |`),
    '',
    '## Notes per post', '',
    ...rows.filter((r) => r.notes.length).flatMap((r) => [`### ${r.title}`, '', `\`${r.path}\``, '', ...r.notes.map((n) => `- ${n}`), '']),
  ];
  await writeFile(join(HERE, 'report.md'), lines.join('\n') + '\n');
  console.log(`convert: ${totals.posts} posts, ${totals.blocks} code blocks (${totals.plaintext} plaintext, ${totals.altered} altered), images ${totals.imgOk} ok / ${totals.imgMissing} lost, ${totals.inferred} posts with inferred tags`);
}

main().catch((e) => { console.error('convert failed: ' + e.stack); process.exit(1); });

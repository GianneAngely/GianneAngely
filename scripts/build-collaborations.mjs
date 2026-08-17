// Regenerates the Collaborations cards, COLLABORATIONS.md, and the grid inside
// README.md from live GitHub data.
//
//   node scripts/build-collaborations.mjs
//
// Needs a token in COLLAB_TOKEN (or GH_TOKEN) that can read the repositories I
// collaborate on, including private ones. The default Actions GITHUB_TOKEN is
// scoped to this repo only and will not see them.
//
// Font handling: the woff2 is lifted out of assets/hero.svg so the cards match
// the rest of the profile. If pyftsubset is on PATH the font is trimmed to the
// glyphs actually drawn; otherwise the full face is embedded and the SVGs are
// simply larger.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'assets');
const CFG = JSON.parse(readFileSync(join(ROOT, 'scripts', 'collab.config.json'), 'utf8'));

const TOKEN = process.env.COLLAB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('No token. Set COLLAB_TOKEN (a PAT that can read your collaborations).');
  process.exit(1);
}

const API = 'https://api.github.com';
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'collab-card-builder',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function gh(path) {
  const res = await fetch(`${API}${path}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
  return res.json();
}
async function ghSafe(path) {
  try { return await gh(path); } catch { return null; }
}

// ---------------------------------------------------------------- 1. discover
const ME = (await gh('/user')).login;
console.log(`building collaborations for @${ME}`);

const repos = [];
for (const affiliation of ['owner', 'collaborator', 'organization_member']) {
  for (let page = 1; page <= 5; page++) {
    const batch = await ghSafe(`/user/repos?affiliation=${affiliation}&per_page=100&page=${page}`);
    if (!batch || batch.length === 0) break;
    repos.push(...batch);
  }
}
const unique = [...new Map(repos.map((r) => [r.full_name, r])).values()];
console.log(`  ${unique.length} repositories visible`);

const isBot = (u) =>
  u.type === 'Bot' ||
  /\[bot\]$/i.test(u.login) ||
  CFG.rules.botLogins.some((b) => b.toLowerCase() === u.login.toLowerCase());

const candidates = [];
for (const repo of unique) {
  if (repo.fork || repo.archived) continue;
  if (CFG.alwaysExclude[repo.full_name]) continue;

  const contributors = await ghSafe(`/repos/${repo.full_name}/contributors?per_page=50`);
  const humans = (contributors || []).filter((c) => !isBot(c));
  const mine = humans.find((c) => c.login.toLowerCase() === ME.toLowerCase())?.contributions ?? 0;
  const others = humans.filter((c) => c.login.toLowerCase() !== ME.toLowerCase());
  const bestOther = others.reduce((max, c) => Math.max(max, c.contributions), 0);

  const forced = Boolean(CFG.alwaysInclude[repo.full_name]);
  const qualifies =
    mine >= CFG.rules.minMyCommits &&
    bestOther >= CFG.rules.minTheirCommits &&
    others.length > 0;

  if (!forced && !qualifies) continue;

  candidates.push({
    full: repo.full_name,
    short: repo.owner.login.toLowerCase() === ME.toLowerCase() ? repo.name : repo.full_name,
    href: repo.html_url,
    isPrivate: repo.private,
    lang: repo.language || 'Code',
    stars: repo.stargazers_count || 0,
    desc: CFG.overrides[repo.full_name]?.desc || repo.description || 'No description yet.',
    mine,
    forced,
  });
}

// Repos the token cannot see. Try live data first so a broader token upgrades
// these automatically; fall back to whatever the config states.
for (const entry of CFG.manualRepos?.entries ?? []) {
  if (CFG.alwaysExclude[entry.full]) continue;
  if (candidates.some((c) => c.full === entry.full)) continue;

  const live = await ghSafe(`/repos/${entry.full}`);
  const [owner] = entry.full.split('/');
  candidates.push({
    full: entry.full,
    short: owner.toLowerCase() === ME.toLowerCase() ? entry.full.split('/')[1] : entry.full,
    href: live?.html_url ?? `https://github.com/${entry.full}`,
    isPrivate: live ? live.private : entry.isPrivate,
    lang: live?.language || entry.lang || 'Code',
    stars: live ? live.stargazers_count : (entry.stars ?? 0),
    desc: CFG.overrides[entry.full]?.desc || entry.desc || live?.description || 'No description yet.',
    mine: entry.myCommits ?? 0,
    forced: true,
    fromConfig: !live,
  });
  console.log(`    ${entry.full.padEnd(44)} ${live ? 'live data' : 'from config (token cannot see it)'}`);
}

const pinned = CFG.order.pinned || [];
candidates.sort((a, b) => {
  const pa = pinned.indexOf(a.full), pb = pinned.indexOf(b.full);
  if (pa !== -1 || pb !== -1) return (pa === -1 ? 1e9 : pa) - (pb === -1 ? 1e9 : pb);
  return b.mine - a.mine;
});

console.log(`  ${candidates.length} collaborations selected:`);
for (const c of candidates) {
  console.log(`    ${c.full.padEnd(44)} mine=${String(c.mine).padStart(3)}${c.forced ? '  (forced)' : ''}`);
}
if (candidates.length === 0) {
  console.error('Nothing selected — refusing to wipe the existing section.');
  process.exit(1);
}

// ---------------------------------------------------------------- 2. font
const hero = readFileSync(join(ASSETS, 'hero.svg'), 'utf8');
const heroFont = hero.match(/src:\s*url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/);
if (!heroFont) throw new Error('could not find the embedded woff2 inside assets/hero.svg');

const HEADER_TEXT = 'Collaborations';
const allText =
  HEADER_TEXT +
  candidates.map((c) => c.short + c.desc + c.lang + String(c.stars)).join('') +
  'PrivatePublic0123456789…';

let fontB64 = heroFont[1];
try {
  const tmp = mkdtempish();
  const full = join(tmp, 'full.woff2');
  const out = join(tmp, 'sub.woff2');
  writeFileSync(full, Buffer.from(heroFont[1], 'base64'));
  const codes = [...new Set(allText.split(''))]
    .map((ch) => 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))
    .join(',');
  execFileSync('pyftsubset', [full, `--unicodes=${codes}`, '--layout-features=*', '--flavor=woff2', `--output-file=${out}`], { stdio: 'pipe' });
  fontB64 = readFileSync(out).toString('base64');
  console.log(`  font subset to ${(Buffer.from(fontB64, 'base64').length / 1024).toFixed(1)} KB`);
} catch {
  console.log(`  pyftsubset unavailable, embedding the full ${(Buffer.from(fontB64, 'base64').length / 1024).toFixed(1)} KB face`);
}

function mkdtempish() {
  const d = join(tmpdir(), `collab-${process.pid}`);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

// ---------------------------------------------------------------- 3. render
const C = { bg: '#0D1117', border: '#30363D', link: '#4493F8', muted: '#9198A1' };
const F = 'PJS,-apple-system,Segoe UI,Helvetica,Arial,sans-serif';
const FONT_CSS = `<style>@font-face { font-family: 'PJS'; font-style: normal; font-weight: 100 900; src: url(data:font/woff2;base64,${fontB64}) format('woff2'); }</style>`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const REPO_ICON = 'M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z';
const LOCK_ICON = 'M4 4a4 4 0 0 1 8 0v2h.25c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25v-5.5C2 6.784 2.784 6 3.75 6H4Zm8.25 3.5h-8.5a.25.25 0 0 0-.25.25v5.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25ZM10.5 6V4a2.5 2.5 0 1 0-5 0v2Z';
const STAR_ICON = 'M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Zm0 2.445L6.615 5.5a.75.75 0 0 1-.564.41l-3.097.45 2.24 2.184a.75.75 0 0 1 .216.664l-.528 3.084 2.769-1.456a.75.75 0 0 1 .698 0l2.77 1.456-.53-3.084a.75.75 0 0 1 .216-.664l2.24-2.183-3.096-.45a.75.75 0 0 1-.564-.41L8 2.694Z';

// Advance widths for Plus Jakarta Sans, sampled per character at 1px and scaled.
// Deliberately slightly generous so the pill never lands on top of the name.
const WIDTH = { narrow: 0.30, wide: 0.88, space: 0.27, upper: 0.66, digit: 0.58, other: 0.545 };
function textWidth(s, size, bold = false) {
  let u = 0;
  for (const ch of s) {
    if ('iljtIfr.,:;\'"|!()[]{}/\\-…'.includes(ch)) u += WIDTH.narrow;
    else if ('mwMW@'.includes(ch)) u += WIDTH.wide;
    else if (ch === ' ') u += WIDTH.space;
    else if (/[0-9]/.test(ch)) u += WIDTH.digit;
    else if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) u += WIDTH.upper;
    else u += WIDTH.other;
  }
  return u * size * (bold ? 1.06 : 1);
}

const W = 420, H = 128, P = 16, NAME_SIZE = 14.5, DESC_SIZE = 12;
const NAME_X = P + 22, CONTENT_R = W - P;

function wrapText(text, size, maxPx, maxLines = 2) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const word of words) {
    const test = cur ? `${cur} ${word}` : word;
    if (textWidth(test, size) <= maxPx) { cur = test; continue; }
    if (cur) lines.push(cur);
    cur = word;
    if (lines.length >= maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  const joined = lines.join(' ');
  if (joined.length < text.length - 1 && lines.length === maxLines) {
    let last = lines[maxLines - 1];
    while (textWidth(`${last}…`, size) > maxPx && last.length > 4) last = last.slice(0, -1);
    lines[maxLines - 1] = last.replace(/[\s,.;:-]+$/, '') + '…';
  }
  return lines;
}

function cardSvg(c) {
  const label = c.isPrivate ? 'Private' : 'Public';
  const pillW = Math.round(textWidth(label, 10.5) + 16);
  let name = c.short;
  let nameW = textWidth(name, NAME_SIZE, true);
  const budget = CONTENT_R - NAME_X - 8 - pillW;
  if (nameW > budget) {
    while (textWidth(`${name}…`, NAME_SIZE, true) > budget && name.length > 8) name = name.slice(0, -1);
    name += '…';
    nameW = textWidth(name, NAME_SIZE, true);
  }
  const pillX = Math.round(NAME_X + nameW + 8);

  const lines = wrapText(c.desc, DESC_SIZE, W - P * 2);
  const descY = lines.length === 1 ? [62] : [56, 74];
  const langColor = CFG.languageColors[c.lang] || CFG.languageColors._default;
  const starX = Math.round(P + 13 + textWidth(c.lang, 11.5) + 16);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(c.short)}, ${label}. ${esc(c.desc)} ${esc(c.lang)}${c.stars ? `, ${c.stars} stars` : ''}.">
  ${FONT_CSS}
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="6" fill="${C.bg}" stroke="${C.border}"/>
  <g transform="translate(${P}, 15)" fill="${C.muted}"><path d="${c.isPrivate ? LOCK_ICON : REPO_ICON}"/></g>
  <text x="${NAME_X}" y="27" font-family="${F}" font-size="${NAME_SIZE}" font-weight="600" fill="${C.link}">${esc(name)}</text>
  <rect x="${pillX}" y="14" width="${pillW}" height="18" rx="9" fill="none" stroke="${C.border}"/>
  <text x="${pillX + pillW / 2}" y="26.5" text-anchor="middle" font-family="${F}" font-size="10.5" font-weight="500" fill="${C.muted}">${label}</text>
${lines.map((l, i) => `  <text x="${P}" y="${descY[i]}" font-family="${F}" font-size="${DESC_SIZE}" font-weight="400" fill="${C.muted}">${esc(l)}</text>`).join('\n')}
  <circle cx="${P + 5}" cy="${H - 26}" r="5.5" fill="${langColor}"/>
  <text x="${P + 13}" y="${H - 22}" font-family="${F}" font-size="11.5" font-weight="400" fill="${C.muted}">${esc(c.lang)}</text>
${c.stars ? `  <g transform="translate(${starX}, ${H - 34})" fill="${C.muted}"><path d="${STAR_ICON}"/></g>
  <text x="${starX + 20}" y="${H - 22}" font-family="${F}" font-size="11.5" font-weight="400" fill="${C.muted}">${c.stars}</text>` : ''}
</svg>
`;
}

const slug = (full) => 'collab-' + full.split('/').pop().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

for (const c of candidates) {
  c.file = `${slug(c.full)}.svg`;
  writeFileSync(join(ASSETS, c.file), cardSvg(c), 'utf8');
}

const HW = 860;
writeFileSync(join(ASSETS, 'collab-header.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="${HW}" height="34" viewBox="0 0 ${HW} 34" role="img" aria-label="Collaborations. View all.">
  ${FONT_CSS}
  <text x="2" y="22" font-family="${F}" font-size="16" font-weight="600" fill="#E6EDF3">${HEADER_TEXT}</text>
  <text x="${HW - 22}" y="22" text-anchor="end" font-family="${F}" font-size="12.5" font-weight="500" fill="${C.link}">View all</text>
  <path d="M${HW - 16} 12 l5 4 -5 4" stroke="${C.link}" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`, 'utf8');

// Drop cards for projects that no longer qualify, so assets/ does not silently
// accumulate stale files as the list changes.
const keep = new Set(['collab-header.svg', ...candidates.map((c) => c.file)]);
for (const name of readdirSync(ASSETS)) {
  if (name.startsWith('collab-') && name.endsWith('.svg') && !keep.has(name)) {
    unlinkSync(join(ASSETS, name));
    console.log(`  removed stale ${name}`);
  }
}

// ---------------------------------------------------------------- 4. markup
const cell = (c) => `<td width="50%"><a href="${c.href}"><img src="./assets/${c.file}" width="100%" alt="${esc(c.short)}, ${c.isPrivate ? 'Private' : 'Public'}. ${esc(c.desc)}"/></a></td>`;
function grid(list) {
  const rows = [];
  for (let i = 0; i < list.length; i += 2) {
    rows.push(`<tr>\n${cell(list[i])}\n${list[i + 1] ? cell(list[i + 1]) : '<td width="50%"></td>'}\n</tr>`);
  }
  return `<table>\n${rows.join('\n')}\n</table>`;
}

writeFileSync(join(ROOT, 'COLLABORATIONS.md'), `# Collaborations

Most of my team work does not show up on my GitHub profile, because it either lives in someone else's repository or sits in a private one. This is the full list.

${grid(candidates)}
`, 'utf8');

const START = '<!-- collab:start -->';
const END = '<!-- collab:end -->';
const readmePath = join(ROOT, 'README.md');
let readme = readFileSync(readmePath, 'utf8');
const block = `${START}

<a href="./COLLABORATIONS.md"><img src="./assets/collab-header.svg" width="100%" alt="Collaborations. View all."/></a>

${grid(candidates.slice(0, CFG.gridSize))}

${END}`;

if (readme.includes(START) && readme.includes(END)) {
  readme = readme.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block);
} else {
  throw new Error(`README.md is missing the ${START} / ${END} markers`);
}
writeFileSync(readmePath, readme, 'utf8');

console.log(`\nwrote ${candidates.length} cards, COLLABORATIONS.md, and the README grid (top ${CFG.gridSize})`);

// Regenerates the Games cards and the games block inside README.md from the
// public itch.io feed, so the newest games show up on their own.
//
//   node scripts/build-games.mjs
//
// No token needed: the feed is public. Needs ffmpeg on PATH to take the first
// frame of each cover (itch covers are often GIFs). The font is lifted out of
// assets/hero.svg so the cards match the rest of the profile.
//
// If the feed cannot be read or has fewer games than expected, the script exits
// non-zero and leaves the existing cards alone.

import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'assets');
const CFG = JSON.parse(readFileSync(join(ROOT, 'scripts', 'games.config.json'), 'utf8'));

// ---------------------------------------------------------------- 1. feed
const res = await fetch(CFG.feed, { headers: { 'User-Agent': 'games-card-builder' } });
if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${CFG.feed}`);
const xml = await res.text();

const tag = (item, name) => {
  const m = item.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`));
  return m ? m[1].trim() : '';
};
const decode = (s) =>
  s.replace(/&#0*39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const games = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
  .map(([, item]) => {
    const link = tag(item, 'link');
    const slug = (link.match(/^https:\/\/gianneangely\.itch\.io\/([a-z0-9-]+)\/?$/) || [])[1];
    const blurb = decode(tag(item, 'description').replace(/<[^>]*>/g, '')).split(/(?<=[.!?])\s/)[0];
    return { slug, link, title: decode(tag(item, 'plainTitle')), cover: tag(item, 'imageurl'), blurb };
  })
  .filter((g) => g.slug && g.title && g.cover && !CFG.exclude.includes(g.slug))
  .slice(0, CFG.count);

if (games.length < CFG.count) {
  console.error(`Only ${games.length} games in the feed — refusing to touch the existing cards.`);
  process.exit(1);
}
console.log('games:', games.map((g) => g.slug).join(', '));

// ---------------------------------------------------------------- 2. font
const hero = readFileSync(join(ASSETS, 'hero.svg'), 'utf8');
const heroFont = hero.match(/src:\s*url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/);
if (!heroFont) throw new Error('could not find the embedded woff2 inside assets/hero.svg');
const FONT_CSS = `<style>@font-face { font-family: 'PJS'; font-style: normal; font-weight: 100 900; src: url(data:font/woff2;base64,${heroFont[1]}) format('woff2'); }</style>`;

// ---------------------------------------------------------------- 3. cards
const ITCH_LOGO = 'M31.99 1.365C21.287 7.72.2 31.945 0 38.298v10.516C0 62.144 12.46 73.86 23.773 73.86c13.584 0 24.902-11.258 24.903-24.62 0 13.362 10.93 24.62 24.515 24.62 13.586 0 24.165-11.258 24.165-24.62 0 13.362 11.622 24.62 25.207 24.62h.246c13.586 0 25.208-11.258 25.208-24.62 0 13.362 10.58 24.62 24.164 24.62 13.585 0 24.515-11.258 24.515-24.62 0 13.362 11.32 24.62 24.903 24.62 11.313 0 23.773-11.714 23.773-25.046V38.298c-.2-6.354-21.287-30.58-31.988-36.933C180.118.197 157.056-.005 122.685 0c-34.37.003-81.228.54-90.697 1.365zm65.194 66.217a28.025 28.025 0 0 1-4.78 6.155c-5.128 5.014-12.157 8.122-19.906 8.122a28.482 28.482 0 0 1-19.948-8.126c-1.858-1.82-3.27-3.766-4.563-6.032l-.006.004c-1.292 2.27-3.092 4.215-4.954 6.037a28.5 28.5 0 0 1-19.948 8.12c-.934 0-1.906-.258-2.692-.528-1.092 11.372-1.553 22.24-1.716 30.164l-.002.045c-.02 4.024-.04 7.333-.06 11.93.21 23.86-2.363 77.334 10.52 90.473 19.964 4.655 56.7 6.775 93.555 6.788h.006c36.854-.013 73.59-2.133 93.554-6.788 12.883-13.14 10.31-66.614 10.52-90.474-.022-4.596-.04-7.905-.06-11.93l-.003-.045c-.162-7.926-.623-18.793-1.715-30.165-.786.27-1.757.528-2.692.528a28.5 28.5 0 0 1-19.948-8.12c-1.862-1.822-3.662-3.766-4.955-6.037l-.006-.004c-1.294 2.266-2.705 4.213-4.563 6.032a28.48 28.48 0 0 1-19.947 8.125c-7.748 0-14.778-3.11-19.906-8.123a28.025 28.025 0 0 1-4.78-6.155 27.99 27.99 0 0 1-4.736 6.155 28.49 28.49 0 0 1-19.95 8.124c-.27 0-.54-.012-.81-.02h-.007c-.27.008-.54.02-.813.02a28.49 28.49 0 0 1-19.95-8.123 27.992 27.992 0 0 1-4.736-6.155zm-20.486 26.49l-.002.01h.015c8.113.017 15.32 0 24.25 9.746 7.028-.737 14.372-1.105 21.722-1.094h.006c7.35-.01 14.694.357 21.723 1.094 8.93-9.747 16.137-9.73 24.25-9.746h.014l-.002-.01c3.833 0 19.166 0 29.85 30.007L210 165.244c8.504 30.624-2.723 31.373-16.727 31.4-20.768-.773-32.267-15.855-32.267-30.935-11.496 1.884-24.907 2.826-38.318 2.827h-.006c-13.412 0-26.823-.943-38.318-2.827 0 15.08-11.5 30.162-32.267 30.935-14.004-.027-25.23-.775-16.726-31.4L46.85 124.08c10.684-30.007 26.017-30.007 29.85-30.007zm45.985 23.582v.006c-.02.02-21.863 20.08-25.79 27.215l14.304-.573v12.474c0 .584 5.74.346 11.486.08h.006c5.744.266 11.485.504 11.485-.08v-12.474l14.304.573c-3.928-7.135-25.79-27.215-25.79-27.215v-.006l-.003.002z';
const F = `font-family="'PJS',-apple-system,BlinkMacSystemFont,'Segoe UI',Ubuntu,Helvetica,Arial,sans-serif"`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

const tmp = mkdtempSync(join(tmpdir(), 'games-'));
for (const g of games) {
  const gif = join(tmp, `${g.slug}.src`);
  const jpg = join(tmp, `${g.slug}.jpg`);
  const img = await fetch(g.cover);
  if (!img.ok) throw new Error(`${img.status} on cover of ${g.slug}`);
  writeFileSync(gif, Buffer.from(await img.arrayBuffer()));
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', gif, '-frames:v', '1', '-vf', 'scale=630:500', '-q:v', '3', jpg]);
  g.b64 = readFileSync(jpg).toString('base64');
  g.line = clip(CFG.lines[g.slug] || g.blurb.replace(/\.$/, ''), 36);
}

for (const f of readdirSync(ASSETS)) if (/^game-.+\.svg$/.test(f)) unlinkSync(join(ASSETS, f));

for (const g of games) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="290" height="322" viewBox="-5 0 290 322" role="img" aria-label="${esc(g.title)}: ${esc(g.line)}. Play free on itch.io.">
  <defs>
  <linearGradient id="g-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0A1930"/><stop offset="54%" stop-color="#10254D"/><stop offset="100%" stop-color="#0A1930"/></linearGradient>
  <clipPath id="g-clip"><rect x="12" y="12" width="256" height="203" rx="12"/></clipPath>
  </defs>
  ${FONT_CSS}
  <rect width="280" height="322" rx="20" fill="url(#g-bg)"/>
  <image x="12" y="12" width="256" height="203" preserveAspectRatio="xMidYMid slice" clip-path="url(#g-clip)" href="data:image/jpeg;base64,${g.b64}"/>
  <rect x="12" y="12" width="256" height="203" rx="12" fill="none" stroke="#FFD60A" stroke-opacity="0.35"/>
  <text x="18" y="244" ${F} font-size="18" font-weight="800" fill="#EDF3FF">${esc(clip(g.title, 24))}</text>
  <text x="18" y="264" ${F} font-size="12.5" font-weight="500" fill="#9DB2D9">${esc(g.line)}</text>
  <rect x="18" y="279" width="140" height="28" rx="14" fill="rgba(255,255,255,0.055)" stroke="#FFD60A" stroke-opacity="0.68"/>
  <g transform="translate(25,284)"><rect width="18" height="18" rx="4" fill="#FA5C5C"/><path transform="translate(2.6,3.4) scale(0.0523)" fill="#FFFFFF" d="${ITCH_LOGO}"/></g>
  <text x="50" y="297.5" ${F} font-size="12" font-weight="700" fill="#EDF3FF">Play on itch.io</text>
  <rect x="0.5" y="0.5" width="279" height="321" rx="19.5" fill="none" stroke="#FFD60A" stroke-opacity="0.55"/>
</svg>
`;
  writeFileSync(join(ASSETS, `game-${g.slug}.svg`), svg);
}

// ---------------------------------------------------------------- 4. README
// Cards sit on one line with no spaces between them: a space would push the
// third card onto a new row on narrow screens.
const cards = games
  .map((g) => `<a href="${g.link}"><img src="./assets/game-${g.slug}.svg" width="33.3%" alt="${esc(g.title)}: ${esc(g.line)}. Play free on itch.io."/></a>`)
  .join('');
const block = [
  '<!-- games:start -->',
  '',
  '<a href="https://gianneangely.itch.io"><img src="./assets/games-header.svg" width="100%" alt="Games. All on itch.io."/></a>',
  cards,
  '',
  '<!-- games:end -->',
].join('\n');

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const re = /<!-- games:start -->[\s\S]*?<!-- games:end -->/;
if (!re.test(readme)) throw new Error('README.md has no games:start/games:end markers');
writeFileSync(join(ROOT, 'README.md'), readme.replace(re, block));
console.log('done');

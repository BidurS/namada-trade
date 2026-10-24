/**
 * Builds the daily (or weekly) digest for one instant from the PRODUCTION database, read-only, and writes what the
 * Discord posts would carry, for the owner to look at before anything is wired to send. Nothing is posted and nothing
 * is written to the database: every statement goes through scripts/d1-readonly.ts, a D1Database over `wrangler d1
 * execute --remote --json --command` (the call scripts/lib.ts d1() makes) that refuses anything but SELECT, WITH and
 * EXPLAIN QUERY PLAN and inlines bound parameters only as numbers or quoted strings.
 *
 *   npx tsx scripts/preview-digest.ts                         # the daily digest for now
 *   npx tsx scripts/preview-digest.ts --kind weekly           # the weekly variant for now
 *   npx tsx scripts/preview-digest.ts --at 2026-10-23T08:00Z  # for another instant
 *
 * Writes only under scripts/out/digest/preview-<UTC date>/<kind>/ (git-ignored; checked with git check-ignore before
 * anything is written): payload-operator.json, payload-subscriber.json (a subscriber with an empty watchlist: no
 * wallet is read), the PNG files the posts attach, report.txt (each figure with its source and as-of time, every
 * not-read line and why, the statements run and their rows read), preview.html (a Discord-look page of the posts) and
 * its screenshots preview.png (desktop width) and preview-phone.png (the phone push card: title and first line).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readAndBuildDigest, type DigestBuild, type DigestPost } from '../worker/src/digest/build';
import { readOnlyD1, wranglerRunner } from './d1-readonly';
import { isNotRead } from '../worker/src/digest/types';
import type { Embed } from '../worker/src/digest/message';

// ------------------------------------------------------------------ arguments and the output folder

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const kind = (arg('kind') ?? 'daily') as 'daily' | 'weekly';
if (kind !== 'daily' && kind !== 'weekly') throw new Error('--kind is daily or weekly');
const atArg = arg('at');
const AT = atArg == null ? Date.now() : /^\d+$/.test(atArg) ? Number(atArg) : Date.parse(atArg);
if (!Number.isFinite(AT)) throw new Error(`--at ${atArg} is not a time`);
const iso = (ms: number) => new Date(ms).toISOString();
const OUT = join(ROOT, 'scripts', 'out', 'digest', `preview-${iso(AT).slice(0, 10)}`, kind);

// the output must be git-ignored before a byte is written: production's figures never reach the public repo
try {
  execFileSync('git', ['check-ignore', '-q', join(OUT, 'report.txt')], { cwd: ROOT, stdio: 'ignore' });
} catch {
  throw new Error(`${OUT} is not git-ignored; refusing to write production figures there`);
}

// ------------------------------------------------------------------ the read-only database

// every statement goes to production through wrangler, and only reads are sent (scripts/d1-readonly.ts)
const { db: shim, ran } = readOnlyD1(wranglerRunner(ROOT));

// ------------------------------------------------------------------ the build

const started = Date.now();
console.log(`digest preview: ${kind} for ${iso(AT)} from production (read-only)`);
const build: DigestBuild = await readAndBuildDigest(shim, AT, kind, { targets: { channels: 1, subscribers: 0 } });
// a subscriber with no watchlist: no wallet is read, the address is a placeholder that is never printed
const subscriber = build.subscriberPosts({ address: 'preview-subscriber', watchlistOn: false, watchlist: [] });
console.log(`built in ${((Date.now() - started) / 1000).toFixed(1)} s: ${ran.length} statements`);

mkdirSync(OUT, { recursive: true });
const posts = (ps: DigestPost[]) => ps.map((p) => ({
  payload: p.payload,
  files: p.files.map((f) => ({ name: f.name, type: f.type, bytes: f.bytes.length, sha256: createHash('sha256').update(f.bytes).digest('hex') })),
}));
writeFileSync(join(OUT, 'payload-operator.json'), JSON.stringify(posts(build.operatorPosts), null, 2));
writeFileSync(join(OUT, 'payload-subscriber.json'), JSON.stringify(posts(subscriber), null, 2));
const files = new Map<string, Uint8Array>();
for (const p of [...build.operatorPosts, ...subscriber]) for (const f of p.files) files.set(f.name, f.bytes);
for (const [name, bytes] of files) writeFileSync(join(OUT, name), bytes);

// ------------------------------------------------------------------ the report

const lines: string[] = [];
const notReads: string[] = [];
const timeKey = /(^|_)(at|ts)$|At$|Ts$|^from$|^to$|^now$|started|first_ts|last_ts/;
function walk(path: string, x: unknown, depth = 0): void {
  if (depth > 9) return;
  if (isNotRead(x)) {
    const line = `${path}: NOT READ — ${x.source}; last answered ${x.lastAt != null ? iso(x.lastAt) : 'never (or not known)'}; ${x.reason}`;
    lines.push(line);
    notReads.push(line);
    return;
  }
  if (Array.isArray(x)) {
    x.slice(0, 25).forEach((v, i) => walk(`${path}[${i}]`, v, depth + 1));
    if (x.length > 25) lines.push(`${path}: … ${x.length - 25} more`);
    if (!x.length) lines.push(`${path}: (none)`);
    return;
  }
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    if ('value' in o && o.stamp && typeof o.stamp === 'object') {
      const s = o.stamp as { source: string; at: number; height?: number | null; status: string; note?: string };
      lines.push(`${path}: source ${s.source}${s.height != null ? `, height ${s.height}` : ''}, as of ${iso(s.at)} (${s.status})${s.note ? `; ${s.note}` : ''}`);
      walk(`${path}`, o.value, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(o)) walk(path ? `${path}.${k}` : k, v, depth + 1);
    return;
  }
  const leaf = path.split('.').pop() ?? '';
  lines.push(`${path} = ${typeof x === 'number' && timeKey.test(leaf) && x > 1e12 ? `${x} (${iso(x)})` : JSON.stringify(x)}`);
}

// a line of the posts: a sentence, a line of a field, or one Sources entry
const sentences = (s: string) => s.split(/(?<=\.)\s+|\n| · /).filter(Boolean);
const shownNotRead = (ps: DigestPost[]) => ps.flatMap((p) => p.payload.embeds.flatMap((e: Embed) => [
  ...(e.description ? sentences(e.description).map((t) => `${e.title ?? '(embed)'}: ${t}`) : []),
  ...(e.fields ?? []).flatMap((f) => sentences(f.value).map((t) => `${f.name}: ${t}`)),
])).filter((t) => /not read —|: not read|not read since|no chart|not drawn|not computed|not on record|not current|left out for room|start is not on record|…$/.test(t));

const totalRead = ran.reduce((a, r) => a + (r.rowsRead ?? 0), 0);
lines.push(
  `NamadaTrade ${kind} digest preview for ${iso(AT)}, built ${iso(started)} from production (read-only; nothing posted)`,
  `claim key ${build.key}; label "${build.what}"; ${ran.length} statements, ${totalRead.toLocaleString('en-US')} rows read`,
  `posts: operator ${build.operatorPosts.length} (${build.operatorPosts.map((p) => `${p.payload.embeds.length} embeds, ${p.files.length} files`).join(' + ')}); subscriber without a watchlist ${subscriber.length}`,
  `subscribers: 0 counted (the dailyDigest preference is not deployed, so no wallet can have it on; no user row was read)`,
  '',
  '== Build notes',
  ...(build.notes.length ? build.notes : ['(none)']),
  '',
  '== Sources as the digest prints them (its marks)',
  ...build.body.marks.map((m) => `${m.n}. [${m.key}] ${m.text}${m.provider ? ` (${m.provider})` : ''}${m.tail ?? ''}`),
  '',
  '== The figures (figures.ts), each with its source and as-of time',
);
walk('', build.figures);
lines.push('', '== The operator lines (operator.ts)');
walk('', build.operator);
lines.push('', '== The charts');
if (isNotRead(build.charts)) { lines.push(`charts: NOT READ — ${build.charts.reason}`); notReads.push(`charts: ${build.charts.reason}`); }
else for (const c of build.charts.captions) lines.push(`${c.present ? `${c.file} (${files.get(c.file)?.length ?? 0} bytes)` : 'LEFT OUT'}: ${c.title} — ${c.caption}${c.notes.length ? ` | notes: ${c.notes.join(' ')}` : ''}`);
lines.push('', '== The attention section (attention.ts)');
if (isNotRead(build.attention)) lines.push(`attention: NOT READ — ${build.attention.reason}`);
else {
  const a = build.attention;
  walk('attention', { indexBehind: a.indexBehind, passTrustedAt: a.passTrustedAt, trades: a.trades, deck: a.deck, unusual: a.unusual, pictureBounded: a.pictureBounded, seriesReadings: isNotRead(a.series) ? a.series : a.series.length, pictureTrades: isNotRead(a.pictureTrades) ? a.pictureTrades : a.pictureTrades.length });
  lines.push(`picture: ${build.attentionPicture ? `${build.attentionPicture.width} × ${build.attentionPicture.height}, ${build.attentionPicture.png.length} bytes, ${build.attentionPicture.quotes} quotes, ${build.attentionPicture.trades} trades` : 'none'}`);
  lines.push(`placed: ${build.operatorPosts.length > 1 ? `a message of its own (level ${build.parts.attention?.aloneLevel})` : 'embed 2 of the digest message'}`);
}
lines.push('', '== Every not-read figure and why (from the readers)', ...(notReads.length ? notReads : ['(none)']));
lines.push('', '== Every not-read line as the operator\'s posts print it', ...shownNotRead(build.operatorPosts));
lines.push('', `== The statements run (${ran.length}; ${totalRead.toLocaleString('en-US')} rows read in all; ${ran.filter((r) => r.tries > 1).length} asked again after 7403)`);
ran.forEach((r, i) => lines.push(`${String(i + 1).padStart(3)}. ${r.error ? `FAILED (${r.error})` : `${r.rows} rows, ${r.rowsRead ?? '?'} read, ${r.ms} ms${r.tries > 1 ? `, ${r.tries} tries` : ''}`} — ${r.sql.length > 400 ? `${r.sql.slice(0, 400)} …` : r.sql}`));
writeFileSync(join(OUT, 'report.txt'), `${lines.join('\n')}\n`);

// ------------------------------------------------------------------ the Discord-look page and its screenshots

const forPage = (ps: DigestPost[]) => ps.map((p) => ({
  ...p.payload,
  // the page shows each attachment from the file beside it, where the embed names it
  embeds: p.payload.embeds.map((e) => (e.image ? { ...e, image: { url: e.image.url.replace(/^attachment:\/\//, '') } } : e)),
  alt: Object.fromEntries((p.payload.attachments ?? []).map((a) => [a.filename, a.description])),
}));
const data = { at: AT, kind, groups: [
  { name: 'A. The operator channel', posts: forPage(build.operatorPosts) },
  { name: 'B. A subscriber channel without a watchlist', posts: forPage(subscriber) },
] };

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Digest preview</title>
<style>
  /* Discord's dark theme as plain CSS (scratchpad discord-ux renderer.html and compare.html): the message row with the
     avatar, name, APP badge and time; embeds of at most 432 px with the colour bar, title, description, the field grid
     (inline fields in rows of up to three), the image, embeds that share the first one's url drawn as its 2 × 2
     gallery, the footer with the timestamp. Times are UTC. */
  :root { color-scheme: dark; }
  body { margin: 0; padding: 24px; background: #313338; color: #dbdee1; font-family: "gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 16px; line-height: 1.375; }
  h2 { font-size: 13px; font-weight: 500; color: #949ba4; margin: 32px 0 4px; letter-spacing: .02em; font-family: ui-monospace, Menlo, monospace; }
  .msg { position: relative; width: 640px; padding: 2px 16px 10px 72px; background: #313338; box-sizing: border-box; }
  .msg + .msg { margin-top: 12px; }
  .avatar { position: absolute; left: 16px; top: 4px; width: 40px; height: 40px; border-radius: 50%; background: #000; color: #ffff00; border: 2px solid #ffff00; box-sizing: border-box; display: grid; place-items: center; font-weight: 800; font-size: 15px; font-family: "Noto Sans", Arial, sans-serif; }
  .head { display: flex; align-items: baseline; gap: 6px; min-height: 22px; }
  .name { color: #f2f3f5; font-weight: 500; }
  .app { display: inline-flex; align-items: center; height: 15px; padding: 0 4px; border-radius: 3px; background: #5865f2; color: #fff; font-size: 10px; font-weight: 600; letter-spacing: .02em; position: relative; top: -1px; }
  .app::before { content: "✓"; font-size: 9px; margin-right: 2px; }
  .when { color: #949ba4; font-size: 12px; font-weight: 500; }
  .embed { margin-top: 2px; width: 432px; box-sizing: border-box; background: #2b2d31; border-left: 4px solid var(--bar, #202225); border-radius: 4px; padding: 8px 16px 16px 12px; }
  .embed + .embed { margin-top: 8px; }
  .e-title { margin-top: 8px; font-size: 16px; font-weight: 600; color: #f2f3f5; overflow-wrap: anywhere; }
  .e-desc { margin-top: 8px; font-size: 14px; line-height: 18px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .e-fields { display: grid; grid-template-columns: repeat(12, 1fr); gap: 8px; margin-top: 8px; min-width: 0; }
  .f { min-width: 0; font-size: 14px; line-height: 18px; }
  .f-name { font-weight: 600; color: #f2f3f5; margin-bottom: 2px; }
  .f-value { white-space: pre-wrap; overflow-wrap: anywhere; }
  .e-img { margin-top: 16px; display: block; max-width: 400px; border-radius: 4px; }
  .gallery { margin-top: 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 4px; max-width: 400px; }
  .gallery img { width: 100%; border-radius: 4px; display: block; }
  .e-foot { display: flex; align-items: center; margin-top: 8px; font-size: 12px; line-height: 16px; font-weight: 500; color: #949ba4; }
  .e-foot .dot { margin: 0 4px; }
  a { color: #00a8fc; text-decoration: none; }
  code { background: #1e1f22; border-radius: 4px; padding: 0 2px; font-family: Consolas, "Andale Mono", Menlo, monospace; font-size: 85%; }
  .ts { background: rgba(78,80,88,.48); border-radius: 3px; padding: 0 2px; }
  /* what a phone shows on the lock screen for the digest: the sender, the title, the first text cut after three lines */
  .phone { width: 390px; padding: 24px 5px; background: #1c1c1e; box-sizing: border-box; }
  .push { width: 380px; box-sizing: border-box; padding: 10px 14px 12px; border-radius: 22px; background: rgba(250,250,250,.94); color: #111; font-family: -apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 15px; line-height: 20px; display: grid; grid-template-columns: 38px 1fr; column-gap: 10px; }
  .push .ico { width: 38px; height: 38px; border-radius: 9px; background: #5865f2; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 7px; letter-spacing: .02em; }
  .push .top { display: flex; justify-content: space-between; font-size: 13px; color: #6e6e73; margin-bottom: 1px; }
  .push .t { font-weight: 600; }
  .push .b { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; color: #1d1d1f; overflow-wrap: anywhere; }
</style>
</head>
<body>
<script>window.PREVIEW = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>
<script>
  const D = window.PREVIEW, NOW = D.at;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const MON = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const clock = (d) => { let h = d.getUTCHours(), m = String(d.getUTCMinutes()).padStart(2, '0'); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + ':' + m + ' ' + ap; };
  const tsF = (u) => { const d = new Date(u * 1000); return MON[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear() + ' ' + clock(d); };
  const when = (ms) => { const d = new Date(ms), t = new Date(NOW); const same = d.toISOString().slice(0, 10) === t.toISOString().slice(0, 10); return same ? 'Today at ' + clock(d) : d.toISOString().slice(5, 10).replace('-', '/') + '/' + d.getUTCFullYear() + ' ' + clock(d); };
  function md(text, links = true) {
    return String(text).split('\\n').map((raw) => {
      let line = esc(raw);
      line = line.replace(/\`([^\`]+)\`/g, (_, c) => '<code>' + c + '</code>');
      line = line.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      line = line.replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, (_, t, u) => (links ? '<a href="' + u + '">' + t + '</a>' : t));
      line = line.replace(/&lt;t:(\\d+):f&gt;/g, (_, u) => '<span class="ts">' + tsF(Number(u)) + '</span>');
      return line;
    }).join('\\n');
  }
  function fields(list) {
    if (!list || !list.length) return '';
    const rows = []; let run = [];
    for (const f of list) {
      if (f.inline && run.length < 3) { run.push(f); continue; }
      if (run.length) { rows.push(run); run = []; }
      if (f.inline) run.push(f); else rows.push([f]);
    }
    if (run.length) rows.push(run);
    let html = '<div class="e-fields">';
    for (const row of rows) {
      const span = 12 / row.length;
      row.forEach((f, i) => { html += '<div class="f" style="grid-column: ' + (i * span + 1) + ' / ' + ((i + 1) * span + 1) + '"><div class="f-name">' + md(f.name, false) + '</div><div class="f-value">' + md(f.value) + '</div></div>'; });
    }
    return html + '</div>';
  }
  function embed(e, gallery, alt) {
    const bar = e.color != null ? '#' + e.color.toString(16).padStart(6, '0') : '#202225';
    let html = '<div class="embed" style="--bar:' + bar + '">';
    if (e.title) html += '<div class="e-title">' + (e.url ? '<a href="' + esc(e.url) + '">' + esc(e.title) + '</a>' : esc(e.title)) + '</div>';
    if (e.description) html += '<div class="e-desc">' + md(e.description) + '</div>';
    html += fields(e.fields);
    const imgs = [e.image, ...gallery].filter(Boolean).map((i) => i.url);
    if (imgs.length > 1) html += '<div class="gallery">' + imgs.map((u) => '<img src="' + esc(u) + '" alt="' + esc(alt[u] || u) + '">').join('') + '</div>';
    else if (imgs.length) html += '<img class="e-img" src="' + esc(imgs[0]) + '" alt="' + esc(alt[imgs[0]] || imgs[0]) + '">';
    if (e.footer || e.timestamp) html += '<div class="e-foot">' + (e.footer ? esc(e.footer.text) : '') + (e.footer && e.timestamp ? '<span class="dot">•</span>' : '') + (e.timestamp ? when(Date.parse(e.timestamp)) : '') + '</div>';
    return html + '</div>';
  }
  function message(p) {
    // embeds after the first that carry only its url and an image are drawn as the first one's gallery, as Discord does
    const first = p.embeds[0];
    const inGallery = (e) => first.url && e.url === first.url && !e.title && !e.description && !e.fields;
    const gallery = p.embeds.slice(1).filter(inGallery).map((e) => e.image);
    const others = p.embeds.slice(1).filter((e) => !inGallery(e));
    return '<div class="msg"><div class="avatar" title="the site mark (icon-512.png)">NT</div><div class="head"><span class="name">' + esc(p.username) + '</span><span class="app">APP</span><span class="when">' + when(NOW) + '</span></div>' +
      embed(first, gallery, p.alt) + others.map((e) => embed(e, [], p.alt)).join('') + '</div>';
  }
  const pushText = (s) => String(s).split('\\n')[0].replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '$1').replace(/\`/g, '').replace(/&lt;t:\\d+:f&gt;|<t:\\d+:f>/g, (m) => tsF(Number(m.replace(/\\D/g, ''))));
  function push(p) {
    const e = p.embeds[0];
    return '<div class="phone" data-shot="push"><div class="push"><div class="ico">DISCORD</div><div><div class="top"><span>' + esc(p.username) + '</span><span>now</span></div><div class="t">' + esc(e.title) + '</div><div class="b">' + esc(pushText(e.description || '')) + '</div></div></div></div>';
  }
  let html = '<h2>' + esc(D.kind) + ' digest preview for ' + new Date(D.at).toISOString() + ' (production, read-only)</h2>';
  for (const g of D.groups) html += '<h2>' + esc(g.name) + '</h2>' + g.posts.map(message).join('');
  html += '<h2>C. The phone push card of the digest message</h2>' + push(D.groups[0].posts[0]);
  document.body.insertAdjacentHTML('beforeend', html);
</script>
</body>
</html>
`;
writeFileSync(join(OUT, 'preview.html'), page);

const { chromium } = await import('@playwright/test');
const browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ headless: true }));
try {
  const errors: string[] = [];
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark', timezoneId: 'UTC' });
  const p1 = await desk.newPage();
  p1.on('pageerror', (e) => errors.push(String(e)));
  await p1.goto(`file://${join(OUT, 'preview.html')}`, { waitUntil: 'load' });
  await p1.waitForTimeout(300);
  await p1.screenshot({ path: join(OUT, 'preview.png'), fullPage: true });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark', timezoneId: 'UTC' });
  const p2 = await phone.newPage();
  p2.on('pageerror', (e) => errors.push(String(e)));
  await p2.goto(`file://${join(OUT, 'preview.html')}`, { waitUntil: 'load' });
  await p2.waitForTimeout(300);
  await p2.locator('[data-shot="push"]').screenshot({ path: join(OUT, 'preview-phone.png') });
  if (errors.length) console.log(`page errors: ${errors.join('; ')}`);
} finally {
  await browser.close();
}
console.log(`wrote ${OUT}: payload-operator.json, payload-subscriber.json, ${[...files.keys()].join(', ')}, report.txt, preview.html, preview.png, preview-phone.png`);
console.log(`${ran.length} statements, ${totalRead.toLocaleString('en-US')} rows read, ${ran.filter((r) => r.error).length} failed; not read: ${notReads.length}`);

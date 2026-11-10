// Tells the IndexNow engines (Bing, Yandex, Seznam, Naver: indexnow.org) which pages to read again: every address
// of the live sitemap, sent with the site's public key (shared/site.ts SITE.verify.indexNow, served at /<key>.txt by
// worker/src/hosts.ts). IndexNow asks for the addresses that changed, so name them; --all sends the whole sitemap
// (the first time, or after a release that changed every page):
//   node scripts/indexnow.mjs /guides/how-to-stake-nam /bridges
//   node scripts/indexnow.mjs --all
// It sends only public addresses of this site and its public key; nothing else leaves the machine. It stops before
// sending when the key file is not live yet (the release that adds it has not been deployed).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const site = readFileSync(fileURLToPath(new URL('../shared/site.ts', import.meta.url)), 'utf8');
const key = /indexNow: '([0-9a-f]{32})'/.exec(site)?.[1];
const host = 'namada.trade';
if (!key) { console.error('No IndexNow key in shared/site.ts'); process.exit(1); }
const keyLocation = `https://${host}/${key}.txt`;
const live = await fetch(keyLocation).then(async (r) => r.ok && (await r.text()).trim() === key).catch(() => false);
if (!live) { console.error(`The key file is not live at ${keyLocation}: deploy first.`); process.exit(1); }
const xml = await (await fetch(`https://${host}/sitemap.xml`)).text();
const listed = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => u.startsWith(`https://${host}/`));
const args = process.argv.slice(2);
if (!args.length) { console.error('Name the paths that changed, or pass --all.'); process.exit(1); }
const asked = args.filter((a) => a !== '--all').map((p) => `https://${host}${p.startsWith('/') ? p : `/${p}`}`);
const unknown = asked.filter((u) => !listed.includes(u));
if (unknown.length) { console.error(`Not in the sitemap: ${unknown.join(', ')}`); process.exit(1); }
const urlList = args.includes('--all') ? listed : asked;
if (!urlList.length) { console.error('The sitemap lists no address.'); process.exit(1); }
const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host, key, keyLocation, urlList }),
});
// 200: taken; 202: taken, the key is being checked; 403: the key file was not found; 422: an address is not this host's
console.log(`IndexNow: ${urlList.length} addresses sent, answered ${res.status}${res.status === 200 || res.status === 202 ? ' (accepted)' : ''}`);
if (res.status !== 200 && res.status !== 202) process.exitCode = 1;

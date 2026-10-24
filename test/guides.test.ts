// The guides' rules (shared/guides.ts header): cited to Namada's own pages, no live figure typed, plain words,
// questions that end in a question mark, sources that are all used, links that land on real pages, and a server
// page and structured data that say the same as the screen. The facts themselves were checked against the sources
// by hand on each guide's `updated` day; this file keeps the shape honest between checks.
import { describe, it, expect } from 'vitest';
import { GUIDES } from '../shared/guides';
import { GUIDE_META, guidePath } from '../shared/guide-meta';
import { citations, guideParas, GUIDE_INDEPENDENCE, type Guide } from '../shared/guide-types';
import { ROUTES, GUIDE_ROUTES, routeByPath, SITE } from '../shared/routes';
import { BODY } from '../shared/copy';
import { guideHtml, jsonLd } from '../worker/src/seo';

/** The words the copy rules keep out of view (test/routes.test.ts and scripts/copy-lint.ts use the same list). */
const BANNED = [/\bSQS\b/i, /\bIBC\b/i, /\bDEX\b/i, /\bPoS\b/i, /\bMASP\b/i, /\bABCI\b/i, /\bRPC\b/i, /\bcron\b/i, /\bwebhooks?\b/i, /\bnpm\b/i, /\bD[1-7]\b/, /Loading…/];
/** Proper nouns a guide heading may capitalise after its first word. */
const PROPER = ['NAM', 'Namada', 'Osmosis', 'NamadaTrade', 'Namadillo', 'Keychain', 'Keplr', 'Ledger', 'Cosmos', 'Zcash', 'Sapling', 'CometBFT', 'Anoma', 'Foundation', 'Heliax', 'Inter-Blockchain', 'Communication', 'USDC', 'Ethereum', 'Solana'];
/** Hosts a guide may cite: Namada's own sites and repositories, and Osmosis's own docs and app. */
const NAMADA_HOSTS = ['docs.namada.net', 'specs.namada.net', 'namada.net', 'forum.namada.net'];
const OSMOSIS_HOSTS = ['docs.osmosis.zone', 'app.osmosis.zone'];
const isNamadaSource = (url: string) => { const u = new URL(url); return NAMADA_HOSTS.includes(u.hostname) || (u.hostname === 'github.com' && u.pathname.startsWith('/namada-net/')); };
/** A paragraph about this site itself needs no outside source. */
const aboutThisSite = (t: string) => /\bNamadaTrade\b|\bthis site\b/i.test(t);
/** Words that make a sentence a claim about how Namada works, which only Namada's own pages may support. */
const NAMADA_CLAIM = /Namadillo|Keychain|shield|stak|govern|validator|epoch|proposal|unbond|reward|slash|inflation|mint/i;

const all = Object.values(GUIDES) as Guide[];
const textOf = (g: Guide): [string, string][] => [
  ...g.lead.map((p, i): [string, string] => [`${g.slug}.lead[${i}]`, p.t]),
  ...g.sections.flatMap((s) => [[`${g.slug}.${s.id}.h2`, s.h2] as [string, string], ...s.paras.map((p, i): [string, string] => [`${g.slug}.${s.id}[${i}]`, p.t]), ...(s.see ?? []).map((x): [string, string] => [`${g.slug}.${s.id}.see`, x.label])]),
  ...g.faq.flatMap((q, i) => [[`${g.slug}.faq[${i}].q`, q.q] as [string, string], ...q.a.map((p, j): [string, string] => [`${g.slug}.faq[${i}].a[${j}]`, p.t])]),
  ...Object.entries(g.sources).map(([id, s]): [string, string] => [`${g.slug}.sources.${id}`, `${s.publisher}: ${s.title}`]),
];

describe('every guide exists once, with its route and its text', () => {
  it('one guide per entry of guide-meta, one route per guide, all indexable', () => {
    expect(Object.keys(GUIDES).sort()).toEqual(GUIDE_META.map((g) => g.slug).sort());
    expect(GUIDE_ROUTES.map((r) => r.path)).toEqual(GUIDE_META.map((g) => guidePath(g.slug)));
    for (const r of GUIDE_ROUTES) {
      expect(r.index).toBe(true);
      expect(r.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(GUIDES[r.guide!].slug).toBe(r.guide);
    }
    expect(routeByPath('/guides')?.index).toBe(true);
    expect(BODY.guides.paras.length).toBeGreaterThan(0);
  });

  it('each guide answers in its lead, then in at least three sections and three questions', () => {
    for (const g of all) {
      expect(g.lead.length, g.slug).toBeGreaterThan(0);
      expect(g.sections.length, g.slug).toBeGreaterThanOrEqual(3);
      expect(g.faq.length, g.slug).toBeGreaterThanOrEqual(3);
      for (const s of g.sections) {
        expect(s.h2, `${g.slug}: ${s.h2}`).toMatch(/\?$/);
        expect(s.paras.length, s.h2).toBeGreaterThan(0);
        expect(s.paras[0].t.length, `first paragraph of ${s.h2}`).toBeGreaterThan(40);
        expect(s.id, s.h2).toMatch(/^[a-z][a-z0-9-]*$/);
      }
      for (const q of g.faq) expect(q.q, `${g.slug}: ${q.q}`).toMatch(/\?$/);
      expect(new Set(g.sections.map((s) => s.id)).size, `${g.slug} section ids`).toBe(g.sections.length);
    }
    // no heading is asked twice across the site
    const heads = [...all.flatMap((g) => g.sections.map((s) => s.h2)), ...Object.values(BODY).flatMap((b) => (b.sections ?? []).map((s) => s.h2))];
    expect(new Set(heads).size).toBe(heads.length);
  });
});

describe('every claim has its source', () => {
  it('each paragraph cites at least one source it lists, except a sentence about this site', () => {
    for (const g of all) for (const p of guideParas(g)) {
      for (const id of p.src) expect(g.sources[id], `${g.slug}: unknown source ${id}`).toBeDefined();
      if (!p.src.length) expect(aboutThisSite(p.t), `${g.slug}: uncited "${p.t.slice(0, 80)}"`).toBe(true);
    }
  });

  it('a sentence on how Namada works cites one of Namada\'s own pages', () => {
    for (const g of all) for (const p of guideParas(g)) {
      if (!p.src.length || !NAMADA_CLAIM.test(p.t)) continue;
      expect(p.src.some((id) => isNamadaSource(g.sources[id].url)), `${g.slug}: "${p.t.slice(0, 80)}" cites no Namada page`).toBe(true);
    }
  });

  it('every listed source is cited, over https, from Namada\'s or Osmosis\'s own sites', () => {
    for (const g of all) {
      const cited = new Set(guideParas(g).flatMap((p) => p.src));
      for (const [id, s] of Object.entries(g.sources)) {
        expect(cited.has(id), `${g.slug}: ${id} is listed but never cited`).toBe(true);
        const u = new URL(s.url);
        expect(u.protocol, s.url).toBe('https:');
        expect(isNamadaSource(s.url) || OSMOSIS_HOSTS.includes(u.hostname), s.url).toBe(true);
        expect(s.publisher.startsWith('Osmosis'), `${s.url} publisher`).toBe(OSMOSIS_HOSTS.includes(u.hostname));
      }
      // numbered by first citation, 1 to n, each once
      const { list } = citations(g);
      expect(list.map((x) => x.n)).toEqual(list.map((_, i) => i + 1));
      expect(list.length).toBe(Object.keys(g.sources).length);
    }
  });
});

describe('no live figure, plain words, sentence case', () => {
  it('a digit appears only in a paragraph marked fixed (a past date, a launch amount), and that paragraph is cited', () => {
    for (const g of all) {
      for (const p of guideParas(g)) {
        if (/\d/.test(p.t)) {
          expect(p.fixed, `${g.slug}: "${p.t.slice(0, 80)}" types a figure`).toBe(true);
          expect(p.src.length).toBeGreaterThan(0);
        }
        expect(p.t, g.slug).not.toMatch(/[%$€]/);
      }
      for (const s of g.sections) expect(s.h2, s.h2).not.toMatch(/\d/);
      for (const q of g.faq) expect(q.q).not.toMatch(/\d/);
    }
  });

  it('no banned word in anything a guide shows', () => {
    for (const g of all) for (const [where, t] of textOf(g)) for (const re of BANNED) expect(t, `${where}: ${t}`).not.toMatch(re);
    for (const r of GUIDE_ROUTES) for (const t of [r.h1, r.title, r.description, r.label]) for (const re of BANNED) expect(t, r.path).not.toMatch(re);
    for (const re of BANNED) expect(GUIDE_INDEPENDENCE).not.toMatch(re);
  });

  it('headings and questions are sentence case', () => {
    const heads: [string, string][] = [
      ...all.flatMap((g) => [...g.sections.map((s): [string, string] => [g.slug, s.h2]), ...g.faq.map((q): [string, string] => [g.slug, q.q])]),
      ...GUIDE_ROUTES.flatMap((r): [string, string][] => [[r.path, r.h1], [r.path, r.title]]),
    ];
    for (const [where, s] of heads) {
      const words = s.replace(/[?:,.()]/g, ' ').split(/\s+/).filter(Boolean).slice(1);
      for (const w of words) if (/^[A-Z][a-z]/.test(w)) expect(PROPER, `${where}: "${w}" in "${s}"`).toContain(w.replace(/'s$/, ''));
    }
  });
});

describe('links, the server page and structured data', () => {
  it('every live-figures link and related link lands on a real indexable page', () => {
    for (const g of all) {
      const self = guidePath(g.slug);
      for (const s of g.sections) for (const x of s.see ?? []) expect(routeByPath(x.to)?.index, `${g.slug}: ${x.to}`).toBe(true);
      for (const p of g.related) {
        expect(routeByPath(p)?.index, `${g.slug}: related ${p}`).toBe(true);
        expect(p).not.toBe(self);
      }
      expect(new Set(g.related).size).toBe(g.related.length);
    }
  });

  it('the server page states the whole guide: H1, every paragraph with its citation numbers, the questions, the sources and the independence line', () => {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    for (const r of GUIDE_ROUTES) {
      const g = GUIDES[r.guide!];
      const html = guideHtml(r);
      const { list, num } = citations(g);
      expect(html.match(/<h1\b/g)?.length, r.path).toBe(1);
      expect(html).toContain(`>${esc(r.h1)}</h1>`);
      for (const p of guideParas(g)) {
        expect(html, `${r.path}: ${p.t.slice(0, 60)}`).toContain(esc(p.t));
        // the paragraph is followed by its numbers, in its own order
        const cites = p.src.map((id) => `<a href="#src-${num[id]}" style="[^"]*">\\[${num[id]}\\]</a>`).join('');
        expect(html, `${r.path}: citations of ${p.t.slice(0, 60)}`).toMatch(new RegExp(esc(p.t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + cites + '</p>'));
      }
      for (const s of g.sections) expect(html).toContain(`>${esc(s.h2)}</h2>`);
      for (const q of g.faq) expect(html).toContain(esc(q.q));
      for (const x of list) {
        expect(html).toContain(`<li id="src-${x.n}"`);
        expect(html).toContain(`href="${esc(x.source.url)}"`);
      }
      expect(html).toContain(esc(GUIDE_INDEPENDENCE));
      expect(html).toContain(esc(SITE.disclaimer));
      expect(html).toContain(`checked against its sources on ${r.updated}`);
      for (const m of html.matchAll(/style="([^"]*)"/g)) expect(m[1], r.path).toMatch(/;?[a-z0-9%)'-]$/i);
    }
  });

  it('each guide is an Article (its date, its sources), a FAQPage (its questions) and a crumb under the guides', () => {
    for (const r of GUIDE_ROUTES) {
      const g = GUIDES[r.guide!];
      const data = JSON.parse(jsonLd(r, null)!.replace(/^<script[^>]*>|<\/script>$/g, ''));
      const art = data.find((d: any) => d['@type'] === 'Article');
      expect(art.headline).toBe(r.h1);
      expect(art.dateModified).toBe(r.updated);
      expect(art.url).toBe(`${SITE.origin}${r.path}`);
      expect(art.citation.map((c: any) => c.url)).toEqual(citations(g).list.map((x) => x.source.url));
      const faq = data.find((d: any) => d['@type'] === 'FAQPage');
      expect(faq.mainEntity.map((q: any) => q.name)).toEqual(g.faq.map((q) => q.q));
      const crumbs = data.find((d: any) => d['@type'] === 'BreadcrumbList');
      expect(crumbs.itemListElement.map((c: any) => c.item)).toEqual([`${SITE.origin}/`, `${SITE.origin}/guides`, `${SITE.origin}${r.path}`]);
      expect(data.map((d: any) => d['@type'])).not.toContain('WebApplication');
    }
    // the guides' list links every guide
    const hub = guideHtml(routeByPath('/guides')!);
    for (const r of GUIDE_ROUTES) expect(hub).toContain(`href="${r.path}"`);
    expect(ROUTES.filter((r) => r.guide).length).toBe(GUIDE_META.length);
  });
});

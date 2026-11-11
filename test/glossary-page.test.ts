// The glossary page /glossary (public review of 2026-11-10): the glossary (shared/glossary.ts) was shown only as
// tap-open cards and as a list inside the search box, and the card's "More in the glossary" link never showed, since
// nothing set where it points. What is held here: the route and its words, the list as the Worker serves it before
// the app mounts (every entry, escaped, each with its id), the screen that draws the same list, where the page is
// linked from, and the card's link.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { glossaryListHtml, lastmodOf, llmsTxt, pageHtml, sitemapXml, statesFigures } from '../worker/src/seo';
import { pageMarkdown } from '../worker/src/agents';
import { BODY, GLOSSARY_ALSO } from '../shared/copy';
import { GLOSSARY } from '../shared/glossary';
import { GLOSSARY_TEXT_CHECKED, aliasOf, classifyPath, fullTitle, legacyHashTarget, routeById, routeByPath } from '../shared/routes';
import { glossaryLink } from '../web/src/ui/Term';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
/** As the Worker escapes text for the served page. */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

describe('the page /glossary', () => {
  const route = routeByPath('/glossary')!;

  it('is a route of its own, indexed, with the day its text was checked, and no tab', () => {
    expect(route).toMatchObject({ id: 'glossary', path: '/glossary', label: 'Glossary', index: true, h1: 'What do the words on this site mean?' });
    expect(routeById('glossary')).toBe(route);
    expect(route.tab).toBeUndefined();
    expect(route.key).toBeUndefined();
    expect(route.title.length).toBeLessThanOrEqual(46);
    expect(fullTitle(route).length).toBeLessThanOrEqual(60);
    expect(route.description.length).toBeLessThanOrEqual(155);
    expect(route.description.length).toBeGreaterThan(60);
    // the page states no live figure: it carries a day, as the guides and the platform pages do
    expect(route.updated).toBe(GLOSSARY_TEXT_CHECKED);
    expect(route.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(lastmodOf(route, null)).toBe(GLOSSARY_TEXT_CHECKED);
    expect(statesFigures(route)).toBe(false);
    expect(classifyPath('/glossary')).toEqual({ kind: 'route', route });
    expect(classifyPath('/Glossary/')).toEqual({ kind: 'redirect', to: '/glossary' });
  });

  it('its words: what the list is, and what the second line of an entry is', () => {
    // the copy rules (plain words, no figure typed) are held for every page's copy in test/routes.test.ts
    expect(BODY.glossary).toEqual({
      paras: [
        'Each word this site uses for staking, bridging, trading and its own figures is listed here with what it means, in plain words.',
        'The second line of each entry, after “In other words”, is the exact term for the same thing, most often the one that other sites and the chain\'s own documents use.',
      ],
      facts: [],
    });
    // the words the second paragraph names are the ones the page puts before each second line
    expect(GLOSSARY_ALSO).toBe('In other words:');
    expect(BODY.glossary.paras[1]).toContain(`“${GLOSSARY_ALSO.replace(/:$/, '')}”`);
  });

  it('every entry has an id that can be a fragment of the page, and is no old link', () => {
    expect(GLOSSARY.length).toBeGreaterThan(30);
    expect(new Set(GLOSSARY.map((g) => g.id)).size).toBe(GLOSSARY.length);
    for (const g of GLOSSARY) {
      expect(g.id, g.id).toMatch(/^[a-z][a-z0-9-]*$/);
      // /glossary#<id> on a first load is never read as an old hash route or as a renamed page
      expect(legacyHashTarget(`#${g.id}`), g.id).toBeNull();
      expect(aliasOf(g.id), g.id).toBeUndefined();
      // nor is it an id the shell or the page already uses
      expect(['root', 'main', 'ssr', 'seo-h1', 'seo-rel-h'], g.id).not.toContain(g.id);
    }
  });

  it('is served with every entry before the app mounts: the plain word with its id, the expert term, the sentence, in the file\'s order', () => {
    const html = pageHtml(route, null);
    expect(html).toContain('>What do the words on this site mean?</h1>');
    for (const p of BODY.glossary.paras) expect(html).toContain(esc(p));
    expect(html).toContain(glossaryListHtml());
    expect(html.match(/<dl\b/g)).toHaveLength(1);
    expect(html.match(/<dt\b/g)).toHaveLength(GLOSSARY.length);
    expect(html.match(/<dd\b/g)).toHaveLength(GLOSSARY.length * 2);
    let from = 0;
    for (const g of GLOSSARY) {
      // one element carries the entry's id: its plain word
      expect(html.split(`id="${g.id}"`).length - 1, g.id).toBe(1);
      const word = html.indexOf(`<dt id="${g.id}" style=`, from);
      expect(word, `${g.id} is out of order or missing`).toBeGreaterThanOrEqual(from);
      const entry = html.slice(word, html.indexOf('<dt ', word + 1) < 0 ? undefined : html.indexOf('<dt ', word + 1));
      expect(entry, g.id).toContain(`>${esc(g.plain)}</dt>`);
      expect(entry, g.id).toContain(`>${esc(GLOSSARY_ALSO)} ${esc(g.expert)}</dd>`);
      expect(entry, g.id).toContain(`>${esc(g.text)}</dd>`);
      from = word + 1;
    }
    // words only: no figure list, no script, and the list is not a table
    expect(html).not.toMatch(/<ul|<script|<table/);
    // every style attribute is whole
    for (const m of glossaryListHtml().matchAll(/style="([^"]*)"/g)) expect(m[1]).toMatch(/[a-z0-9]$/i);
  });

  it('escapes every part of an entry', () => {
    const html = glossaryListHtml([{ id: 'x"><script>', plain: '<b>Word</b>', expert: 'This & "that"', text: "It's <i>text</i>" }]);
    expect(html).toContain('<dt id="x&quot;&gt;&lt;script&gt;" style=');
    expect(html).toContain('>&lt;b&gt;Word&lt;/b&gt;</dt>');
    expect(html).toContain(`>${GLOSSARY_ALSO} This &amp; &quot;that&quot;</dd>`);
    expect(html).toContain('>It&#39;s &lt;i&gt;text&lt;/i&gt;</dd>');
    expect(html).not.toMatch(/<script|<b>|<i>/);
  });

  it('its Markdown carries the same list, and the sitemap and llms.txt carry the page', async () => {
    const md = pageMarkdown(route, null);
    expect(md.startsWith('# What do the words on this site mean?\n')).toBe(true);
    for (const p of BODY.glossary.paras) expect(md).toContain(p);
    for (const g of GLOSSARY) expect(md, g.id).toContain(`## ${g.plain}\n\n${GLOSSARY_ALSO} ${g.expert}\n\n${g.text}\n`);
    expect(await (await sitemapXml(null)).text()).toContain(`<loc>https://namada.trade/glossary</loc><lastmod>${GLOSSARY_TEXT_CHECKED}</lastmod>`);
    expect(await llmsTxt().text()).toContain(`- [Glossary](https://namada.trade/glossary): ${route.description}`);
  });

  it('the screen draws the list from the glossary itself, with each entry\'s id, and asks the server for nothing', () => {
    const screen = read('web/src/screens/seo/Glossary.tsx');
    expect(screen).toContain("import { GLOSSARY } from '../../lib/glossary';");
    expect(read('web/src/lib/glossary.ts')).toContain("export * from '../../../shared/glossary';");
    expect(screen).toContain("import { BODY, GLOSSARY_ALSO } from '../../../../shared/copy';");
    expect(screen).toContain('<dl className="seo-gloss">');
    expect(screen).toContain('{GLOSSARY.map((g) => (');
    expect(screen).toContain('<dt id={g.id} className="seo-gloss__w">{g.plain}</dt>');
    expect(screen).toContain('<dd className="seo-gloss__x">{GLOSSARY_ALSO} {g.expert}</dd>');
    expect(screen).toContain('<dd className="seo-gloss__t">{g.text}</dd>');
    // the heading and both paragraphs of its copy
    expect(screen).toContain("h1={route?.h1 ?? ''} sub={copy.paras[0]}");
    expect(screen).toContain('{copy.paras.slice(1).map((p, i) => <p key={i} className="seo-hero__more">{p}</p>)}');
    // no request of its own
    expect(screen).not.toMatch(/\bfetch[A-Z]\w*\(|\buseLoad\b|\buseOv\b|\buseOverview\b/);
    // a link from another page lands on its entry: the page goes there itself, and only to an entry
    expect(screen).toContain('const at = entryOf(hash);');
    expect(screen).toContain("requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }))");
    expect(screen).toContain('return GLOSSARY.some((g) => g.id === id) ? id : null;');
    // its styles are in the content pages' stylesheet, the entry clear of the header when landed on
    const css = read('web/src/styles/screens/seo.css');
    for (const cls of ['.seo-gloss ', '.seo-gloss__i ', '.seo-gloss__w ', '.seo-gloss__x ', '.seo-gloss__t ']) expect(css, cls).toContain(`${cls}{`);
    expect(css).toMatch(/\.seo-gloss__w \{[^}]*scroll-margin-top: calc\(var\(--header-h\) \+ var\(--s-4\)\);/);
  });

  it('is linked from the footer after Questions, from the served pages\' navigation and from the search box, and is one of the app\'s screens', () => {
    const ids = /const LINK_IDS: RouteId\[\] = \[([^\]]+)\]/.exec(read('web/src/app/Footer.tsx'))![1].split(',').map((x) => x.trim().replace(/'/g, ''));
    expect(ids.indexOf('glossary')).toBe(ids.indexOf('faq') + 1);
    expect(pageHtml(routeByPath('/')!, null)).toContain('<a href="/glossary"');
    expect(pageHtml(routeByPath('/trade')!, null)).toContain('>Glossary</a>');
    expect(read('web/src/screens/seo/index.tsx')).toContain("export { Glossary } from './Glossary';");
    expect(read('web/src/app/App.tsx')).toContain('glossary: () => seo().then((m) => ({ default: m.Glossary })),');
    expect(read('web/e2e/platform.spec.ts')).toContain("routeByPath('/glossary')!");
    // the search box: its Glossary list stays a list of words (not options), with a link to the page under it
    const palette = read('web/src/app/Palette.tsx');
    expect(palette).toContain('<dl className="pal__gloss">');
    expect(palette).toContain('<Link to="/glossary" className="pal__more" onClick={(e) => { if (!isModifiedClick(e)) close(); }}>');
    expect(palette).toContain('Every word on one page');
    expect(read('web/src/styles/components/shell.css')).toMatch(/\.pal__more \{[^}]*min-height: 44px;/);
  });

  it('a glossary card\'s "More in the glossary" is set, lands on the card\'s own entry and keeps a rewound time', () => {
    // the shell says where the glossary is, with the current ?at= in the address
    expect(read('web/src/app/App.tsx')).toContain("const value = useMemo(() => ({ now: at, navigate: (href: string) => navigate(href), glossaryHref: hrefFor('/glossary') }), [at]);");
    expect(read('web/src/app/router.ts')).toContain('export function hrefFor(to: string, keepAt = true): string {');
    // a card that shows an entry adds the entry's id; one that shows none goes to the page
    expect(glossaryLink('/glossary', 'staked')).toBe('/glossary#staked');
    expect(glossaryLink('/glossary?at=1788116700000', 'shielded-set')).toBe('/glossary?at=1788116700000#shielded-set');
    expect(glossaryLink('/glossary')).toBe('/glossary');
    expect(glossaryLink('/glossary?at=1788116700000')).toBe('/glossary?at=1788116700000');
    for (const g of GLOSSARY) expect(glossaryLink('/glossary', g.id)).toBe(`/glossary#${g.id}`);
    const term = read('web/src/ui/Term.tsx');
    expect(term).toContain('const more = cfg.glossaryHref ? glossaryLink(cfg.glossaryHref, c.id) : null;');
    // followed as the kit's other links are: a plain click through the shell's navigator, which keeps ?at=
    expect(term).toContain('<a className="link" href={more} onClick={linkClick(cfg, more, hide)}>');
    expect(term).toContain('<GlossPop popRef={popRef} popId={popId} c={{ id: g.id, plain: g.plain, expert: g.expert, text: g.text }} />');
    const tag = read('web/src/ui/Tag.tsx');
    expect(tag).toContain('c={{ id: g?.id, plain: k.word, expert: k.expert, text: g?.text }}');
    expect(tag).toContain('c={{ id: g.id, plain: g.plain, expert: g.expert, text: g.text }}');
    // the card's link is a full-height target; a card opened from inside a sheet stands outside that sheet, where a
    // link could not be followed, so it shows none there
    const sheetCss = read('web/src/styles/components/sheet.css');
    expect(sheetCss).toContain('.pop .link { min-height: 44px; }');
    expect(sheetCss).toContain('html:has(.sheet[open], .pal[open]) .pop .link { display: none; }');
  });

  it('the rendered copy gate leaves out the page\'s list, and nothing else of the page', () => {
    // web/e2e/gates.spec.ts reads every route's rendered text for the words the pages may not use; an entry's second
    // line is the expert term on purpose, so the list (and only the list) is left out there, as the cards are
    expect(read('web/e2e/gates.spec.ts')).toContain("const ALLOW = 'details.how, #developers, .pop, dl.seo-gloss, script, style, noscript, template';");
  });
});

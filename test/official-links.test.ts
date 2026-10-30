// The site's own links and what it never does (plan Stage 1, identity basics, 2026-10-29): a clone or an account that
// borrows the name meets one sentence in the footer of every route (SITE.neverAsks) beside a link to the questions
// page's last answer, "Which links are NamadaTrade's own?", which names this site, the X account, the Telegram bot
// and the repository from SITE, so a handle changes in one place. The server-rendered page and the FAQPage markup
// carry the answer as the page shows it. The questions page draws one question per section of its copy: before this
// change it drew seven of eight (the order-book answer, added with the depth module, shifted the names, so its words
// sat under "What does this site not do?" and the last answer was never drawn).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BODY, SITE } from '../shared/copy';
import { routeById } from '../shared/routes';
import { jsonLd, pageHtml } from '../worker/src/seo';

const ROOT = join(__dirname, '..');
const FAQ_VIEW = readFileSync(join(ROOT, 'web', 'src', 'screens', 'seo', 'Faq.tsx'), 'utf8');
const FOOTER = readFileSync(join(ROOT, 'web', 'src', 'app', 'Footer.tsx'), 'utf8');
const sections = BODY.faq.sections!;
const official = sections[sections.length - 1];
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

describe('the official links', () => {
  it('the last question names this site, the X account, the Telegram bot and the repository, in that order, from SITE', () => {
    expect(official.h2).toBe('Which links are NamadaTrade\'s own?');
    const names = ['namada.trade', '@namadatrade', '@NamadaTrade_bot', 'github.com/BidurS/namada-trade'];
    // read from SITE, never typed twice: each is what the view links (Faq.tsx OFFICIAL)
    expect(names).toEqual([new URL(SITE.origin).host, `@${new URL(SITE.x).pathname.slice(1)}`, `@${SITE.telegram.bot}`, SITE.repo.replace(/^https:\/\//, '')]);
    let at = -1;
    for (const n of names) {
      const next = official.paras[0].indexOf(n, at + 1);
      expect(next, n).toBeGreaterThan(at);
      at = next;
    }
    expect(official.paras[0]).toContain('is not this site');
    // no Discord server is named: the code names none (Discord alerts go to channels readers connect themselves)
    expect(official.paras.join(' ')).not.toMatch(/discord/i);
  });

  it('what the site never does: the footer\'s sentence opens the answer\'s second paragraph, and the sign-in is the one signature', () => {
    expect(SITE.neverAsks).toBe('NamadaTrade never sends a direct message first, never asks for a seed phrase and has no support staff.');
    expect(official.paras[1].startsWith(SITE.neverAsks)).toBe(true);
    expect(official.paras[1]).toContain('The only signature it asks for is Sign in, on namada.trade itself');
    expect(official.paras[1]).toContain('costs nothing and moves nothing');
  });

  it('the footer carries the sentence and links to the answer by its id', () => {
    expect(FOOTER).toContain('<p>{SITE.neverAsks} <Link to="/faq#q-official">Official links</Link></p>');
    expect(FAQ_VIEW).toContain('<Q id="q-official" h2={qOfficial.h2}');
  });

  it('the questions page draws every section of its copy once, in order, under its own name', () => {
    const names = /const \[([^\]]+)\] = copy\.sections!;/.exec(FAQ_VIEW)![1].split(',').map((x) => x.trim());
    expect(names).toHaveLength(sections.length);
    // each name is drawn once as a question, in the copy's order, and its id is the page's anchor
    const drawn = [...FAQ_VIEW.matchAll(/<Q id="(q-[a-z]+)" h2=\{(q[A-Za-z]+)\.h2\}/g)].map((m) => ({ id: m[1], name: m[2] }));
    expect(drawn.map((d) => d.name)).toEqual(names);
    expect(new Set(drawn.map((d) => d.id)).size).toBe(drawn.length);
    // the two answers that were drawn under the wrong question before
    expect(sections[names.indexOf('qBook')].h2).toBe('Is this the order book?');
    expect(sections[names.indexOf('qNot')].h2).toBe('What does this site not do?');
    expect(sections[names.indexOf('qWho')].h2).toBe('Is NamadaTrade run by the Namada team?');
    expect(sections[names.indexOf('qOfficial')]).toBe(official);
  });

  it('the server-rendered page and the FAQPage markup carry the answer as the page shows it', () => {
    const html = pageHtml(routeById('faq'), null);
    expect(html).toContain(`>${esc(official.h2)}</h2>`);
    for (const p of official.paras) expect(html).toContain(esc(p));
    const ld = jsonLd(routeById('faq'), null)!;
    const data = JSON.parse(ld.replace(/^<script[^>]*>|<\/script>$/g, ''));
    const q = data.find((d: any) => d['@type'] === 'FAQPage').mainEntity.find((e: any) => e.name === official.h2);
    expect(q.acceptedAnswer.text).toBe(official.paras.join(' '));
  });
});

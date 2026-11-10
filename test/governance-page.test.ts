// The votes page /governance (docs/design/platform-plan.md, release C): a page with an address for the proposals the
// Supply tab already shows. It adds no route to the API and no reading: the screen reads GET /api/pressure
// (`proposals`, `decided`, `proposalsProv`) and the overview's public funding figure. What is held here: the route
// and the words people type for it, where it is linked from, its words, and what the Worker serves before the app mounts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { pageHtml } from '../worker/src/seo';
import { BODY } from '../shared/copy';
import { ROUTE_ALIASES, classifyPath, routeById, routeByPath } from '../shared/routes';
import { BANNED } from '../scripts/copy-lint';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('the page /governance', () => {
  const route = routeByPath('/governance')!;

  it('is a route of its own, reached by the words people type, and no tab', () => {
    expect(route).toMatchObject({ id: 'governance', label: 'Votes', index: true, h1: 'What is Namada voting on, and what did it decide?' });
    expect(routeById('governance')).toBe(route);
    expect(route.tab).toBeUndefined();
    expect(route.key).toBeUndefined();
    for (const from of ['votes', 'vote', 'proposals', 'gov']) {
      expect(ROUTE_ALIASES[from]).toBe('/governance');
      expect(classifyPath(`/${from}`)).toEqual({ kind: 'redirect', to: '/governance' });
    }
    expect(classifyPath('/Governance/')).toEqual({ kind: 'redirect', to: '/governance' });
  });

  it('is linked from the footer after Validators, from the Supply tab\'s votes and from the served pages\' navigation', () => {
    const ids = /const LINK_IDS: RouteId\[\] = \[([^\]]+)\]/.exec(read('web/src/app/Footer.tsx'))![1].split(',').map((x) => x.trim().replace(/'/g, ''));
    expect(ids.indexOf('governance')).toBe(ids.indexOf('validators') + 1);
    expect(read('web/src/screens/supply/Votes.tsx')).toContain('<Link to="/governance" className="link votes__all">Every vote on its own page</Link>');
    expect(read('web/src/app/App.tsx')).toContain('governance: () => seo().then((m) => ({ default: m.Governance })),');
    expect(read('web/e2e/platform.spec.ts')).toContain("routeByPath('/governance')!");
    expect(pageHtml(routeByPath('/')!, null)).toContain('<a href="/governance"');
  });

  it('shows the Supply tab\'s own row for a proposal, not a second one', () => {
    const screen = read('web/src/screens/seo/Governance.tsx');
    expect(screen).toContain("import { VoteRow } from '../supply/Votes';");
    expect(read('web/src/screens/supply/Votes.tsx')).toContain('export function VoteRow(');
    // one reading in two places: the screen asks for nothing of its own
    expect(screen).not.toMatch(/\bfetch[A-Z]\w*\(/);
    // an empty list under a stamp that says it was not read is never "no vote is open"
    expect(screen).toContain("const read = !!d && votesP?.status !== 'missing';");
    expect(screen).toContain('{read && !open.length ? <Say>No vote is open.</Say> : null}');
  });

  it('its words: plain, no figure typed, and the two questions it answers', () => {
    const copy = BODY.governance;
    expect(copy.paras).toHaveLength(2);
    expect(copy.facts).toEqual([]);
    expect((copy.sections ?? []).map((s) => s.h2)).toEqual(['What can a vote change?', 'How much NAM is held for public funding?']);
    const all = [...copy.paras, ...(copy.sections ?? []).flatMap((s) => s.paras)];
    for (const p of all) {
      expect(p).not.toMatch(/\d/);
      expect(p.includes('—')).toBe(false);
      for (const b of BANNED) expect(b.re.test(p), `"${b.word}" in: ${p}`).toBe(false);
    }
    // whose text a title and a link are is said once
    expect(all.filter((p) => p.includes('its author\'s own text'))).toHaveLength(1);
  });

  it('is served with its heading and every sentence before the app mounts, and states no figure there', () => {
    const html = pageHtml(route, null);
    expect(html).toContain('>What is Namada voting on, and what did it decide?</h1>');
    for (const p of [...BODY.governance.paras, ...BODY.governance.sections!.flatMap((s) => s.paras)]) expect(html).toContain(p.replace(/'/g, '&#39;'));
    for (const s of BODY.governance.sections!) expect(html).toContain(`>${s.h2}</h2>`);
    expect(html).not.toMatch(/<ul/);
  });
});

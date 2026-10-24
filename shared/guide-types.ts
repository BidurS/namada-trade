// The shape of a guide (shared/guides.ts) and the numbering of its citations, shared by the server-rendered page
// (worker/src/seo.ts) and the guide screen (web/src/screens/seo/Guide.tsx) so both number sources the same way.
import type { GuideSlug } from './guide-meta';

/** Who published a source. Every claim about Namada cites Namada's own docs, specs, site, blog or forum posts. */
export type Publisher = 'Namada docs' | 'Namada specs' | 'namada.net' | 'Namada blog' | 'Namada forum' | 'Namada on GitHub' | 'Osmosis docs' | 'Osmosis app';

export interface Source {
  publisher: Publisher;
  /** The page's own title, with an abbreviation spelled out (the copy rules keep IBC, MASP and PoS out of view). */
  title: string;
  url: string;
}

/** One paragraph and the sources that say what it says. */
export interface GPara {
  t: string;
  /** Source ids (keys of Guide.sources). Empty only for a sentence about this site itself. */
  src: string[];
  /**
   * The paragraph states a figure that cannot change: a past date, the amount at launch, a rule written into the
   * protocol's code. A figure that can change (a rate, a balance, a setting governance can vote on) is never typed;
   * the section links the page that shows it now (GSection.see).
   */
  fixed?: boolean;
}

export interface GSection {
  /** Anchor id of the H2. */
  id: string;
  /** An H2 written as the question it answers; the first paragraph answers it. */
  h2: string;
  paras: GPara[];
  /** This site's pages that show the live figures the section talks about (path and link words). */
  see?: { to: string; label: string }[];
}

export interface GFaq {
  q: string;
  a: GPara[];
}

export interface Guide {
  slug: GuideSlug;
  /** The day the guide was first published (YYYY-MM-DD); its last check is GuideMeta.updated. */
  published: string;
  /** Lead paragraphs under the H1; the first answers the H1. */
  lead: GPara[];
  sections: GSection[];
  faq: GFaq[];
  /** Paths of related guides and pages, in order. */
  related: string[];
  sources: Record<string, Source>;
}

/** Every paragraph of a guide in reading order: lead, sections, questions. */
export const guideParas = (g: Guide): GPara[] => [...g.lead, ...g.sections.flatMap((s) => s.paras), ...g.faq.flatMap((q) => q.a)];

/** The guide's sources numbered by first citation (1, 2, 3 …), and the number of each source id. */
export function citations(g: Guide): { list: { n: number; id: string; source: Source }[]; num: Record<string, number> } {
  const num: Record<string, number> = {};
  const list: { n: number; id: string; source: Source }[] = [];
  for (const p of guideParas(g)) for (const id of p.src) {
    if (num[id] != null || !g.sources[id]) continue;
    num[id] = list.length + 1;
    list.push({ n: num[id], id, source: g.sources[id] });
  }
  return { list, num };
}

/** The independence line every guide ends with (true: the disclaimer in shared/site.ts says the same). */
export const GUIDE_INDEPENDENCE = 'NamadaTrade is an independent site. It is not run by or affiliated with the Anoma Foundation, Heliax or any other team that builds Namada, and this guide is not advice. Each paragraph about Namada links the Namada pages it comes from.';

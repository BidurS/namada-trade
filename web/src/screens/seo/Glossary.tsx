// /glossary: "What do the words on this site mean?" Every entry of the glossary (shared/glossary.ts: the rows a
// tap-open card and the search box's Glossary list show) on one page, in the file's order, as one definition list:
// the plain word, then the term other sites and the chain's own documents use (after GLOSSARY_ALSO), then the
// sentence. The server-rendered page states the same list (worker/src/seo.ts glossaryListHtml).
//
// An entry's plain word carries the entry's id, so /glossary#staked lands on it. A card's "More in the glossary"
// comes here from another page, and the shell opens a new page at its top, so the page goes to its own entry (as
// the questions page does for /faq#q-official) and marks it.
//
// The page states no figure of its own and asks the server for nothing. A few entries hold a figure or an expert
// term in their own text on purpose (shared/glossary.ts is the copy lint's allowlisted file): they are printed as
// the file has them.
import { useEffect } from 'react';
import type { ScreenProps } from '../../app/index';
import { useLocation } from '../../app/index';
import { BODY, GLOSSARY_ALSO } from '../../../../shared/copy';
import { GLOSSARY } from '../../lib/glossary';
import { Band, Hero, Related } from './parts';

const copy = BODY.glossary;

/** The entry a URL fragment names ("#staked" is "staked"); null for no fragment or one that names no entry. */
function entryOf(hash: string): string | null {
  let id = '';
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
  return GLOSSARY.some((g) => g.id === id) ? id : null;
}

export function Glossary({ route }: ScreenProps) {
  const { hash } = useLocation();
  const at = entryOf(hash);

  useEffect(() => {
    const el = at ? document.getElementById(at) : null;
    if (!el) return;
    const raf = requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(raf);
  }, [at]);

  return (
    <article className="seo seo--glossary">
      <Hero eyebrow={<p className="eyebrow seo-eyebrow">Glossary</p>} h1={route?.h1 ?? ''} sub={copy.paras[0]}>
        {copy.paras.slice(1).map((p, i) => <p key={i} className="seo-hero__more">{p}</p>)}
      </Hero>
      <Band label="Every word">
        <dl className="seo-gloss">
          {GLOSSARY.map((g) => (
            <div key={g.id} className={at === g.id ? 'seo-gloss__i is-at' : 'seo-gloss__i'}>
              <dt id={g.id} className="seo-gloss__w">{g.plain}</dt>
              <dd className="seo-gloss__x">{GLOSSARY_ALSO} {g.expert}</dd>
              <dd className="seo-gloss__t">{g.text}</dd>
            </div>
          ))}
        </dl>
        <Related paths={['/faq', '/guides', '/learn/how-nam-trading-works', '/methodology', '/status']} />
      </Band>
    </article>
  );
}

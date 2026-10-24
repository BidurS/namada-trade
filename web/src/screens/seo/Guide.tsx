// /guides/<slug>: one guide (shared/guides.ts), the same text the server renders into #root (worker/src/seo.ts
// guideHtml). The yellow band states the question and answers it; black bands carry the sections (each H2 a
// question answered in its first sentence, every paragraph followed by its numbered sources, and links to the
// pages that show the live figures), the questions (open <details>), the numbered sources and the line saying
// this site is independent. No figure is typed: a guide links the page that shows it.
import type { ScreenProps } from '../../app/index';
import { GUIDES } from '../../../../shared/guides';
import { citations, GUIDE_INDEPENDENCE, type GPara } from '../../../../shared/guide-types';
import { Icon } from '../../ui';
import { Band, GoLink, Hero, Related } from './parts';
import { NotFound } from './NotFound';

/** A paragraph's numbered source links (same-page anchors, so the browser scrolls to the list). */
function Cites({ p, num }: { p: GPara; num: Record<string, number> }) {
  return (
    <>
      {p.src.filter((id) => num[id] != null).map((id) => (
        <a key={id} href={`#src-${num[id]}`} className="seo-cite" aria-label={`Source ${num[id]}`}>
          [{num[id]}]
        </a>
      ))}
    </>
  );
}

/** A paragraph and its sources; the first of a section is set as the answer. */
function P({ p, num, lead }: { p: GPara; num: Record<string, number>; lead?: boolean }) {
  return (
    <p className={lead ? 'seo-answer' : 'seo-p seo-p--guide'}>
      {p.t}
      <Cites p={p} num={num} />
    </p>
  );
}

export function Guide({ route }: ScreenProps) {
  const g = route?.guide ? GUIDES[route.guide] : undefined;
  if (!route || !g) return <NotFound view="notfound" route={null} />;
  const { list, num } = citations(g);
  const [first, ...rest] = g.lead;
  return (
    <article className="seo seo--guide">
      <Hero
        eyebrow={<p className="eyebrow seo-eyebrow">Guide · checked against its sources on {route.updated}</p>}
        h1={route.h1}
        sub={<>{first.t}<Cites p={first} num={num} /></>}
      >
        {rest.length ? <div className="seo-guide__lead">{rest.map((p, i) => <P key={i} p={p} num={num} />)}</div> : null}
      </Hero>

      <Band label="The guide">
        {g.sections.map((s) => (
          <section key={s.id} className="seo-sec" aria-labelledby={s.id}>
            <h2 id={s.id} className="h2 seo-sec__h">{s.h2}</h2>
            <div className="seo-sec__b">
              {s.paras.map((p, i) => <P key={i} p={p} num={num} lead={i === 0} />)}
              {s.see?.map((x) => <GoLink key={x.to} to={x.to}>{x.label}</GoLink>)}
            </div>
          </section>
        ))}
      </Band>

      <Band label="Questions" className="seo-band--faq">
        <div className="seo-qs">
          <h2 id="questions" className="h2 seo-guide__qh">Questions</h2>
          {g.faq.map((q, i) => (
            // keyed by guide: the one guide screen stays mounted between guides, so a question closed in one
            // guide must not arrive closed in the next
            <details key={`${g.slug}:${i}`} className="seo-q" open>
              <summary className="seo-q__s">
                <h3 className="seo-q__h">{q.q}</h3>
                <Icon name="chev" className="ico seo-q__i" />
              </summary>
              <div className="seo-q__b">
                {q.a.map((p, j) => <P key={j} p={p} num={num} lead={j === 0} />)}
              </div>
            </details>
          ))}
        </div>
        <Related paths={g.related} />
      </Band>

      <Band label="Sources">
        <section className="seo-src" aria-labelledby="sources">
          <h2 id="sources" className="h2">Sources</h2>
          <ol className="seo-src__l">
            {list.map((x) => (
              <li key={x.id} id={`src-${x.n}`} className="seo-src__i">
                <span className="seo-src__n" aria-hidden="true">{x.n}</span>
                <a href={x.source.url} target="_blank" rel="noopener noreferrer" className="link">
                  <span className="seo-src__p">{x.source.publisher}:</span> {x.source.title}
                </a>
              </li>
            ))}
          </ol>
          <p className="seo-p seo-guide__ind">{GUIDE_INDEPENDENCE}</p>
        </section>
      </Band>
    </article>
  );
}

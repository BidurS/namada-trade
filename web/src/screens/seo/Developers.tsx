// /developers ("API"): "How do I read these figures from my own code?" (docs/design/platform-plan.md, release A).
// Band: the question and its first answer, with the day the text was last checked against the code. Evidence: the
// five questions of the page's copy (shared/copy.ts BODY: the stamp, the limits, a past moment, the document a
// program reads, what a key is for), then the reference itself: every documented route under its group, drawn from
// shared/api-catalog.ts, the list /openapi.json and the server-rendered page are made from too. A route is one
// fold: its path and what it answers are always visible; its parameters and the fields of its answer open with it.
// No figure is typed here: the limits are shared/api-limits.ts (held equal to the Worker's own by a test), and a
// parameter's bounds and its value when left out are the catalog's.
import type { ScreenProps } from '../../app/index';
import { BODY } from '../../../../shared/copy';
import { API_CATALOG, API_GROUPS, type ApiEndpoint, type ApiParam, type ApiParamType } from '../../../../shared/api-catalog';
import { API_LIMITS } from '../../../../shared/api-limits';
import { Icon } from '../../ui/Icon';
import { fmtCount } from '../../lib/format';
import { Band, GoLink, Hero, QSection, Related } from './parts';

const copy = BODY.developers;

/** The kind of value a parameter takes, as a word. */
const KIND: Record<ApiParamType, string> = {
  text: 'text',
  whole: 'whole number',
  number: 'number',
  time: 'time in unix milliseconds',
  day: 'day, as year-month-day',
  when: 'time in unix milliseconds, or a UTC day as year-month-day',
  choice: 'one of',
  address: 'address',
};

/** A parameter's kind with its allowed values or bounds: "one of: buy, sell", "whole number, 1 to 100". */
function kindOf(p: ApiParam): string {
  if (p.type === 'choice') return `${KIND.choice}: ${(p.values ?? []).join(', ')}`;
  const lo = p.min != null ? fmtCount(p.min) : null, hi = p.max != null ? fmtCount(p.max) : null;
  const span = lo && hi ? `, ${lo} to ${hi}` : lo ? `, ${lo} or more` : hi ? `, up to ${hi}` : '';
  return `${KIND[p.type]}${span}`;
}

/**
 * The catalog's words with each name it writes between backticks (a field, a parameter, a fixed value) set as code,
 * so a name reads as a name and never as a word of the sentence.
 */
function Words({ text }: { text: string }) {
  const parts = text.split('`');
  if (parts.length < 3) return <>{text}</>;
  return <>{parts.map((t, i) => (i % 2 ? <code key={i} className="mono api-code">{t}</code> : t))}</>;
}

/** A route's place on the page: /api/depth/quote → r-api-depth-quote. */
export const anchorOf = (e: Pick<ApiEndpoint, 'path'>): string => `r${e.path.replace(/[^a-z]+/gi, '-').replace(/-$/, '')}`;

/**
 * A route a reader can open as it stands: no parameter it refuses to go without, an answer a browser shows, and an
 * answer the site already holds (a live quote asks the Osmosis router each time, so the page does not link it).
 */
const openable = (e: ApiEndpoint): boolean => !e.pathParam && !e.csv && e.path !== '/api/quote' && !e.params.some((p) => p.required);

function Param({ p, inPath }: { p: ApiParam; inPath?: boolean }) {
  return (
    <div className="api-row">
      <dt>
        <code className="mono api-name">{p.name}</code>
        <span className="api-kind">{kindOf(p)}{inPath ? ', in the path' : p.required ? ', required' : ''}</span>
      </dt>
      <dd><Words text={p.what} />{p.fallback != null ? <> Left out: <code className="mono api-code">{p.fallback}</code>.</> : null}</dd>
    </div>
  );
}

function Endpoint({ e }: { e: ApiEndpoint }) {
  const params = [...(e.pathParam ? [{ p: e.pathParam, inPath: true }] : []), ...e.params.map((p) => ({ p, inPath: false }))];
  const fields = Object.entries(e.fields);
  return (
    <details className="api-ep" id={anchorOf(e)}>
      <summary className="api-ep__s">
        <span className="api-ep__t">
          <code className="mono api-ep__path">GET {e.path}</code>
          <span className="api-ep__what"><Words text={e.what} /></span>
        </span>
        <Icon name="chev" className="ico api-ep__i" />
      </summary>
      <div className="api-ep__b">
        {params.length ? (
          <>
            <h4 className="api-h">Parameters</h4>
            <dl className="api-rows">{params.map((x) => <Param key={x.p.name} p={x.p} inPath={x.inPath} />)}</dl>
          </>
        ) : (
          <p className="seo-p">It reads no parameter.</p>
        )}
        {e.csv ? (
          <p className="seo-p">The answer is a file of comma-separated values, one row per line, with its column names in the first line; with the format asked as json, the same rows inside one object.</p>
        ) : fields.length ? (
          <>
            <h4 className="api-h">Fields of the answer</h4>
            <dl className="api-rows">
              {fields.map(([name, what]) => (
                <div key={name} className="api-row">
                  <dt><code className="mono api-name">{name}</code></dt>
                  <dd><Words text={what} /></dd>
                </div>
              ))}
            </dl>
          </>
        ) : null}
        {e.notFound ? <p className="seo-p">Answered as not found: <Words text={e.notFound} /></p> : null}
        {openable(e) ? (
          <a className="link api-open" href={e.path} target="_blank" rel="nofollow noreferrer" data-native="">
            <span>Open this answer as it is now</span>
            <Icon name="arrow" className="ico ico--inline" />
          </a>
        ) : null}
      </div>
    </details>
  );
}

export function Developers({ route }: ScreenProps) {
  const [qStamp, qLimits, qPast, qDoc, qKey] = copy.sections!;
  return (
    <article className="seo seo--plain seo--developers">
      <Hero
        eyebrow={<p className="eyebrow seo-eyebrow">API{route?.updated ? <> · text checked against the code on {route.updated}</> : null}</p>}
        h1={route?.h1 ?? ''}
        sub={copy.paras[0]}
      />

      <Band label="How the answers work">
        <p className="seo-p seo-plain__lead">{copy.paras[1]}</p>
        <QSection id="dev-stamp" h2={qStamp.h2} paras={qStamp.paras} />
        <QSection id="dev-limits" h2={qLimits.h2} paras={qLimits.paras}>
          <dl className="api-rows api-limits" aria-label="The limits, by kind of request">
            {API_LIMITS.map((l) => (
              <div key={l.binding} className="api-row">
                <dt>
                  <span className="api-limit">{fmtCount(l.limit)} in {fmtCount(l.seconds)} seconds</span>
                  <span className="api-kind">for each address</span>
                </dt>
                <dd>{l.what}.</dd>
              </div>
            ))}
          </dl>
        </QSection>
        <QSection id="dev-past" h2={qPast.h2} paras={qPast.paras} />
        <QSection id="dev-doc" h2={qDoc.h2} paras={qDoc.paras}>
          <a className="link api-open" href="/openapi.json" target="_blank" rel="noreferrer" data-native="">
            <span>The OpenAPI document</span>
            <Icon name="arrow" className="ico ico--inline" />
          </a>
        </QSection>
        <QSection id="dev-key" h2={qKey.h2} paras={qKey.paras}>
          <GoLink to="/settings">Settings, where a key is made</GoLink>
        </QSection>
      </Band>

      <Band label="The documented routes" className="seo-band--api">
        {API_GROUPS.map((g) => {
          const eps = API_CATALOG.filter((e) => e.group === g.id);
          if (!eps.length) return null;
          return (
            <section key={g.id} className="seo-sec" aria-labelledby={`api-g-${g.id}`}>
              <h2 id={`api-g-${g.id}`} className="h2 seo-sec__h">{g.title}</h2>
              <div className="seo-sec__b">
                <p className="seo-answer">{g.lead}</p>
                <div className="api-eps">{eps.map((e) => <Endpoint key={e.path} e={e} />)}</div>
              </div>
            </section>
          );
        })}
        <Related paths={['/status', '/methodology', '/terms', '/privacy', '/faq']} />
      </Band>
    </article>
  );
}

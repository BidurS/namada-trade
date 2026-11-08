// What happened on Namada (the Shielded page, 2026-11-07): the public incidents timeline of web/src/generated/events.ts
// INCIDENTS (scripts/incidents.ts, reviewed by hand), newest last, each row with its day, its plain words, the pages of
// this site it concerns and the sources a reader can open. From 1024 px only, an open list under its heading; under
// 1024 px nothing is rendered (a phone's screen gains no line for it, as the chart markers are drawn from 1024 px
// only). A row still running carries "Ongoing". Nothing is rendered at all while shared/copy.ts TIMELINE_SHOWN is
// false (the owner's call of 2026-11-08).
import { INCIDENTS, type Incident } from '../../generated/events';
import { TIMELINE_SHOWN, TIMELINE_WORDS } from '../../../../shared/copy';
import { routeByPath } from '../../../../shared/routes';
import { Link } from '../../app/index';
import { Icon, Tag, useMinWidth } from '../../ui';
import { incidentDays } from './timeline-words';

function Row({ r }: { r: Incident }) {
  const pages = r.pages.map((p) => ({ to: p, label: routeByPath(p)?.label ?? null })).filter((p) => p.label);
  return (
    <li className="shd-tl__row" id={`tl-${r.id}`}>
      <p className="shd-tl__when" data-num="">
        <span>{incidentDays(r)}</span>
        {r.ongoing ? <Tag cat={TIMELINE_WORDS.ongoing} look="ref" /> : null}
      </p>
      <h3 className="shd-tl__title">{r.title}</h3>
      <p className="shd-tl__text">{r.text}</p>
      <p className="shd-tl__src">
        {r.sources.map((s) =>
          s.url ? (
            <a key={s.label} href={s.url} target="_blank" rel="noreferrer noopener">
              {s.label}
              <Icon name="external" className="ico ico--inline" />
            </a>
          ) : (
            <span key={s.label}>{s.label}</span>
          ),
        )}
        {pages.length ? (
          <span className="shd-tl__pages">
            {TIMELINE_WORDS.pagesLead}{' '}
            {pages.map((p, i) => (
              <span key={p.to}>
                {i ? ', ' : ''}
                <Link to={p.to}>{p.label}</Link>
              </span>
            ))}
          </span>
        ) : null}
      </p>
    </li>
  );
}

export function Timeline() {
  const wide = useMinWidth(1024);
  if (!TIMELINE_SHOWN || !wide) return null;
  return (
    <section className="ipg-sec shd-tl" aria-labelledby="shd-tl-h" id="timeline">
      <div className="ipg-sec__head">
        <h2 id="shd-tl-h" className="h2">{TIMELINE_WORDS.heading}</h2>
        <p className="lead ipg-lead">{TIMELINE_WORDS.lead}</p>
      </div>
      <ol className="shd-tl__list">
        {INCIDENTS.map((r) => <Row key={r.id} r={r} />)}
      </ol>
    </section>
  );
}

// /governance: "What is Namada voting on, and what did it decide?" (docs/design/platform-plan.md, release C).
// Band: how many votes are open (hero, ProvChip). Evidence: the proposals in voting or waiting to start and the
// latest decided ones, each as the Supply tab's own row (title, kind, status, the votes in NAM, the author's
// discussion link by its host, a summary only when one is shown), then what a vote can change and the NAM held for
// public funding.
//
// The proposals are the ones GET /api/pressure already serves to the Supply tab (`proposals`, `decided`,
// `proposalsProv`): one reading, two places. A proposal's title and link are its author's text: the row prints the
// title as text and keeps a link only when it is http(s) (supply/Votes.tsx VoteRow). The public funding figure is the
// overview's (`supply.pgf`), with the supply stamp.
import type { ScreenProps } from '../../app/index';
import { BODY } from '../../../../shared/copy';
import { HeroNumber, ProvChip, ProvScope, SourceLine, type Stamp } from '../../ui';
import { fmtCount, fmtNamRule } from '../../lib/format';
import { VoteRow } from '../supply/Votes';
import { Band, Dateline, Fig, FigList, GoLink, Hero, QSection, Related, Say, noAnswer, useOv, usePressure } from './parts';

const copy = BODY.governance;
const INDEXER = 'indexer.namada.net';

export function Governance({ route }: ScreenProps) {
  const pr = usePressure();
  const { o, loading: supplyLoading } = useOv();
  const d = pr.data;
  const loading = pr.loading;
  const [qChange, qFunding] = copy.sections!;

  const open = d?.proposals ?? [];
  const decided = d?.decided ?? [];
  // The votes' stamp is the indexer's reading as the server dates it; an answer that carries no stamp is said to be
  // of an unknown time, and no answer at all is said as that.
  const votesP: Stamp | null = d
    ? d.proposalsProv ?? { source: INDEXER, at: null, status: 'stale', note: 'Read from the Namada indexer; this server does not say when.' }
    : loading ? null : noAnswer(INDEXER);
  // a list that was not read holds no count: an empty list under a missing stamp is not "no vote is open"
  const read = !!d && votesP?.status !== 'missing';
  const supplyP: Stamp | null = o ? o.supply.prov : null;
  const source = votesP ? <SourceLine items={[{ label: 'Proposals and their votes', p: votesP }]} label="Where the votes come from" /> : null;

  return (
    <article className="seo seo--governance">
      <Hero
        eyebrow={<Dateline label="Votes" />}
        h1={route?.h1 ?? ''}
        sub={copy.paras[0]}
        fig={
          <HeroNumber
            size="48"
            label="Votes open"
            chip={loading ? <span className="skel__b skel__chip" aria-hidden="true" /> : <ProvChip p={votesP} label="Proposals in voting or waiting to start" />}
            value={<Fig loading={loading} h={48} w="2ch" v={read ? open.length : null} prov={votesP} fmt={fmtCount} />}
            sub={read && open.length === 1 ? 'proposal is in voting or waiting to start.' : 'proposals are in voting or waiting to start.'}
          />
        }
      >
        <p className="seo-hero__more">{copy.paras[1]}</p>
      </Hero>

      <Band label="The votes">
        <ProvScope as="section" className="seo-sec" aria-labelledby="gov-open">
          <h2 id="gov-open" className="h2 seo-sec__h">Votes in progress</h2>
          <div className="seo-sec__b">
            {!loading && !d ? <Say>The proposals did not load.</Say> : null}
            {d && !read ? <Say>{votesP?.note ?? 'The proposals could not be read.'}</Say> : null}
            {read && !open.length ? <Say>No vote is open.</Say> : null}
            {open.length ? <ul className="votes">{open.map((p) => <VoteRow key={p.id} p={p} />)}</ul> : null}
            {source}
          </div>
        </ProvScope>

        {decided.length ? (
          <ProvScope as="section" className="seo-sec" aria-labelledby="gov-decided">
            <h2 id="gov-decided" className="h2 seo-sec__h">Recently decided</h2>
            <div className="seo-sec__b">
              <ul className="votes">{decided.map((p) => <VoteRow key={p.id} p={p} />)}</ul>
              {source}
            </div>
          </ProvScope>
        ) : null}

        <QSection id="gov-change" h2={qChange.h2} paras={qChange.paras}>
          <GoLink to="/supply">The open votes beside the NAM waiting to unlock</GoLink>
        </QSection>

        <QSection id="gov-funding" h2={qFunding.h2} paras={qFunding.paras}>
          <FigList
            label="NAM held for public funding"
            loading={supplyLoading}
            rows={[{ label: 'In the public funding account', value: <Fig loading={supplyLoading} h={26} v={o?.supply.pgf} prov={supplyP} fmt={fmtNamRule} unit="NAM" />, p: supplyP }]}
          />
        </QSection>

        <Related paths={['/supply', '/validators', '/staking', '/status']} />
      </Band>
    </article>
  );
}

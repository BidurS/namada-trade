// Votes in progress (decision D3): governance proposals in voting or waiting to start. A vote
// can change supply or spending, so it is an unlock event too. Below them, the latest decided proposals, behind a
// closed disclosure (phones and desktop alike). Each proposal shows its plain summary when one passed the checks
// (shared/proposal-summary.ts), named as written by a Claude model from the proposal's own text. Rendered only when
// there is a proposal to show. On a phone the section adds no line: with no vote open it is not shown, and with votes
// open the closed "Recently decided" line takes the place of the lead sentence (supply.css).
import type { GovernanceProposal, Pressure } from '../../../../shared/types';
import { Link } from '../../app/index';
import { Icon, ProvScope, SourceLine } from '../../ui';
import { fmtNamRule, fmtPctRule, fmtUtcLong } from '../../lib/format';
import { safeHttpUrl } from '../../../../shared/flow-rules';
import { proposalStatusWords, proposalTypeWords } from '../../../../shared/flow-words';

// the status and type in the words the governance alert uses too (shared/flow-words.ts): an executed rejection reads
// "Rejected", never "Executedrejected"
const plainStatus = proposalStatusWords;
const plainType = proposalTypeWords;

export function Votes({ data }: { data: Pressure }) {
  const decided = data.decided ?? [];
  if (!data.proposals.length && !decided.length) return null;
  return (
    <ProvScope as="section" className={`ipg-sec ipg-col--full votes-sec${data.proposals.length ? '' : ' votes-sec--past'}`} aria-labelledby="vote-h" data-decision="D3">
      <div className="ipg-sec__head">
        <h2 id="vote-h" className="h2">{data.proposals.length ? 'Votes in progress' : 'Votes'}</h2>
        {data.proposals.length ? <p className="lead ipg-lead">Proposals that can change how much NAM exists or where public funds go.</p> : null}
      </div>
      {data.proposals.length ? (
        <ul className="votes">
          {data.proposals.map((p) => <VoteRow key={p.id} p={p} />)}
        </ul>
      ) : (
        <p className="vote__n votes__none">No vote is open.</p>
      )}
      {decided.length ? (
        <details className="votes__past">
          <summary>Recently decided ({decided.length})</summary>
          <ul className="votes">
            {decided.map((p) => <VoteRow key={p.id} p={p} />)}
          </ul>
        </details>
      ) : null}
      <Link to="/governance" className="link votes__all">Every vote on its own page</Link>
      <SourceLine items={[{ label: 'Proposals and their votes', p: data.proposalsProv ?? { source: 'indexer.namada.net', at: null, status: 'stale', note: 'Read from the Namada indexer; this server does not say when.' } }]} label="Where the votes come from" />
    </ProvScope>
  );
}

export function VoteRow({ p }: { p: GovernanceProposal }) {
  const total = p.yayNam + p.nayNam + p.abstainNam;
  const pc = (n: number) => (total > 0 ? (n / total) * 100 : null);
  // the link is the proposal's own text (on-chain): only http(s), and the host is said, since anyone can write it
  const href = safeHttpUrl(p.discussionsUrl);
  const host = href ? new URL(href).host : null;
  return (
    <li className="vote">
      <div className="vote__top">
        <p className="vote__t"><span className="mono">#{p.id}</span> {p.title}</p>
        {href ? (
          <a className="xrec" href={href} target="_blank" rel="noreferrer noopener nofollow" aria-label={`Discussion (${host}) of proposal ${p.id}, opens in a new tab`}>
            <span>Discussion ({host})</span>
            <Icon name="external" className="ico ico--inline" />
          </a>
        ) : null}
      </div>
      <p className="vote__s">{plainType(p.type)} · {plainStatus(p.status)}</p>
      {p.summary ? <Summary s={p.summary} /> : null}
      {total > 0 ? (
        <>
          <div className="vote__bar" aria-hidden="true">
            <i className="vote__yes" style={{ flexGrow: p.yayNam }} />
            <i className="vote__no" style={{ flexGrow: p.nayNam }} />
            <i className="vote__abs" style={{ flexGrow: p.abstainNam }} />
          </div>
          <p className="vote__n">
            Yes <span data-num="">{fmtNamRule(p.yayNam)}</span> NAM ({fmtPctRule(pc(p.yayNam), 1)}) · No <span data-num="">{fmtNamRule(p.nayNam)}</span> NAM ({fmtPctRule(pc(p.nayNam), 1)}) · Abstain <span data-num="">{fmtNamRule(p.abstainNam)}</span> NAM
          </p>
        </>
      ) : (
        <p className="vote__n">No votes cast yet.</p>
      )}
    </li>
  );
}

/** A proposal's plain summary and who wrote it: a Claude model, from the proposal's own text, on a date. */
function Summary({ s }: { s: NonNullable<GovernanceProposal['summary']> }) {
  return (
    <div className="vote__sum">
      <p>{s.text}</p>
      <p className="vote__by">Summary written by {s.model}, an AI model, from the proposal's own text on {fmtUtcLong(s.at)}. The proposal's text is the source.</p>
    </div>
  );
}

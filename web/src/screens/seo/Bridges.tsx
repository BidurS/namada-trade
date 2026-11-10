// /bridges: "Which chains hold NAM, and how much?" (docs/design/platform-plan.md, release B). Band: the NAM in
// Namada's bridge account and the NAM the chains read hold between them (one SourceLine). Evidence: one row per
// channel the chain has opened, with the chain it leads to, both ids of the channel and the NAM that chain holds
// through it, each figure with its own stamp (a chain that is not read has a dash and its reason, never a zero);
// then what the account holds beyond the chains read, with the transfers known to be stuck. Current only: the
// channels and the holdings were not recorded over time, and the page says so under Rewind.
import type { ScreenProps } from '../../app/index';
import { useReplay } from '../../app/index';
import type { BridgeChannelRow } from '../../../../shared/types';
import { BODY } from '../../../../shared/copy';
import { derive, type Stamp } from '../../ui';
import { fetchBridges } from '../../api';
import { fmtNamRule } from '../../lib/format';
import { Band, Dateline, Facts, Fig, FigList, GoLink, Hero, QSection, Related, Say, missing, noAnswer, useLoad, type FigRow } from './parts';

const copy = BODY.bridges;
const NOT_RECORDED = 'The channels and what each chain holds were not recorded over time.';

/** A channel's name on the page: the chain it leads to as this site names it, else the channel. The chain's own id is a node's word and is not printed as a name. */
const chainName = (r: BridgeChannelRow): string => r.chain ?? `The chain of ${r.channel}`;

export function Bridges({ route }: ScreenProps) {
  const { rewound } = useReplay();
  const b = useLoad(rewound ? 'bridges:rewound' : 'bridges', () => fetchBridges(), { enabled: !rewound, everyMs: 120_000 });
  const d = b.data;
  const loading = b.loading;
  const [qWhy, qUnread, qFresh] = copy.sections!;

  // one stamp stands in for every figure the page cannot show: while rewound, or when the answer did not arrive
  const off: Stamp | null = rewound ? missing('Namada node', NOT_RECORDED) : !d && !loading ? noAnswer('Namada node') : null;
  // each figure carries its own reading's time: the account's, the oldest of the chains' behind their sum, the
  // oldest reading of a stuck transfer's status; what is in the account beyond both is as old as its oldest part
  const accountP: Stamp | null = off ?? (d ? d.account.prov : null);
  const heldP: Stamp | null = off ?? (d ? { ...d.held.prov, plain: 'Each chain’s own node', derivedFrom: 'the NAM each chain read holds, added up' } : null);
  const stuckP: Stamp | null = off ?? (d ? d.stuck.prov : null);
  const beyondP: Stamp | null = off ?? (d && accountP && heldP && stuckP
    ? d.beyondNam != null
      ? derive([accountP, heldP, stuckP], 'the bridge account, less the NAM the chains read hold and less the NAM in transfers known to be stuck')
      : missing('this site', 'Not stated: the bridge account, the stuck transfers or a chain that can be read has no current figure, and the rest is never made with a part missing.', 'This site')
    : null);

  // The list's source line sums up the readings behind the figures shown. A row with no figure says why beside its
  // dash, so it is left out of that line while any row has a figure: one chain that cannot be read must not make the
  // line say the whole list has no data. With no figure at all, every row counts and the line says so.
  const anyFigure = (d?.channels ?? []).some((r) => r.held.value != null);
  const rows: FigRow[] = (d?.channels ?? []).map((r) => ({
    // the channel is part of the label, so two channels to one chain are two rows with two names
    label: `NAM on ${chainName(r)}, ${r.channel}`,
    labelNode: chainName(r),
    // a row without a figure says why beside its dash (the figure's own stamp carries the reason)
    note: `${r.channel} to ${r.counterpartyChannel}${r.open ? '' : ', not open'}`,
    value: <Fig loading={loading} h={26} v={r.held.value} prov={r.held.prov} fmt={fmtNamRule} unit="NAM" />,
    p: r.held.value != null || !anyFigure ? r.held.prov : undefined,
  }));

  return (
    <article className="seo seo--bridges">
      <Hero eyebrow={<Dateline label="Bridges" />} h1={route?.h1 ?? ''} sub={copy.paras[0]}>
        <Facts
          className="seo-facts"
          sourceLabel="Figures on this page"
          items={[
            { n: <Fig loading={loading} v={d?.account.value} prov={accountP} fmt={fmtNamRule} unit="NAM" showAge={false} />, label: 'in Namada’s bridge account, for every channel', scope: accountP ? { label: 'NAM in the bridge account', p: accountP } : undefined },
            { n: <Fig loading={loading} v={d?.held.value} prov={heldP} fmt={fmtNamRule} unit="NAM" showAge={false} />, label: 'held by the chains this site reads', scope: heldP ? { label: 'NAM held by the chains read', p: heldP } : undefined },
          ]}
        />
      </Hero>

      <Band label="Every channel">
        <section className="seo-sec" aria-labelledby="br-channels">
          <h2 id="br-channels" className="h2 seo-sec__h">Every channel, and what its chain holds</h2>
          <div className="seo-sec__b">
            <p className="seo-answer">{copy.paras[1]}</p>
            {rewound ? <Say>{NOT_RECORDED}</Say> : null}
            {!rewound && !loading && !d ? <Say>The channel list did not load.</Say> : null}
            {!rewound && d && !d.channels.length ? <Say>{d.prov.note ?? 'The channel list has not been read yet.'}</Say> : null}
            {rows.length ? <FigList label="NAM each chain holds" loading={loading} rows={rows} /> : null}
          </div>
        </section>

        <QSection id="br-why" h2={qWhy.h2} paras={qWhy.paras}>
          {!rewound && d ? (
            <FigList
              label="The bridge account and what accounts for it"
              loading={loading}
              rows={[
                { label: 'In the bridge account', value: <Fig loading={loading} h={26} v={d.account.value} prov={accountP} fmt={fmtNamRule} unit="NAM" />, p: accountP },
                { label: 'Held by the chains read', value: <Fig loading={loading} h={26} v={d.held.value} prov={heldP} fmt={fmtNamRule} unit="NAM" />, p: heldP },
                { label: 'In transfers known to be stuck', value: <Fig loading={loading} h={26} v={d.stuck.value} prov={stuckP} fmt={fmtNamRule} unit="NAM" />, p: stuckP },
                { label: 'In the account beyond both', value: <Fig loading={loading} h={26} v={d.beyondNam} prov={beyondP} fmt={fmtNamRule} unit="NAM" />, p: beyondP },
              ]}
            />
          ) : null}
          <GoLink to="/status">The cross-check that compares them</GoLink>
        </QSection>

        <QSection id="br-unread" h2={qUnread.h2} paras={qUnread.paras} />
        <QSection id="br-fresh" h2={qFresh.h2} paras={qFresh.paras} />

        <Related paths={['/supply', '/osmosis', '/shielded', '/status', '/methodology']} />
      </Band>
    </article>
  );
}

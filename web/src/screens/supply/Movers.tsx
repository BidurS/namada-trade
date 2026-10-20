// Who is moving the price (decision D4): the addresses with the largest net buying or selling
// on Osmosis in the window, bot trades left out. The signed net figure carries the buy or sell
// hue (system.md 9.3) and always its sign; rows on phones, a five-column table from 560 px.
import type { MoverEntry, Pressure } from '../../../../shared/types';
import { EmptyState, Num, ProvScope, SourceLine, Term, useUiNow } from '../../ui';
import { fmtAgo, fmtAddr, fmtCount, fmtNamSigned } from '../../lib/format';
import { AddrName, YouTag, useShowAll } from '../../ui';
import { isOld, lastWindow, oldRowsSentence } from './parts';

const FIRST = 8;
const hue = (n: number) => (n > 0 ? 'is-buy' : n < 0 ? 'is-sell' : '');
const times = (n: number, one: string, many: string) => `${fmtCount(n)} ${n === 1 ? one : many}`;

export function Movers({ data, isMine }: { data: Pressure; isMine: (a: string | null | undefined) => boolean }) {
  const now = useUiNow();
  // Osmosis trades only: the Osmosis flow index's stamp when the server stamps each chain
  const cov = data.coverageByChain?.osmosis ?? data.coverage;
  const [rows, more] = useShowAll(data.movers, FIRST);
  const old = isOld(cov);
  const w = data.windowDays === 1 ? '24 h' : `${data.windowDays} days`;

  return (
    <ProvScope as="section" className="ipg-sec ipg-col--5" aria-labelledby="mv-h" data-decision="D4">
      <div className="ipg-sec__head">
        <h2 id="mv-h" className="h2">Who is moving the price</h2>
        <p className="lead ipg-lead">The addresses that bought or sold the most NAM on Osmosis in {lastWindow(data.windowDays)}, net of their own trades. <Term id="bot-trade">Bot trades</Term> are left out.</p>
      </div>

      {data.movers.length === 0 ? (
        <EmptyState title={`No trades on Osmosis in ${lastWindow(data.windowDays)}, bots left out.`}>
          Every address that bought or sold NAM in the window would be listed here with its net amount.
        </EmptyState>
      ) : (
        <div className={`xlist${old ? ' is-old' : ''}`}>
          {old ? (
            <p className="scope__old">
              <i className="dot" data-status="old" aria-hidden="true" />
              <span>{oldRowsSentence(cov, now)}</span>
            </p>
          ) : null}
          <div className="mvr" role="table" aria-label={`Net buyers and sellers of NAM on Osmosis, ${lastWindow(data.windowDays)}`}>
            <div className="mvr__head" role="row">
              <span role="columnheader">Address</span>
              <span role="columnheader" className="r">Net, {w}</span>
              <span role="columnheader" className="r">Net, 24 h</span>
              <span role="columnheader" className="r">Buys and sells</span>
              <span role="columnheader" className="r">Last trade</span>
            </div>
            {rows.map((m) => (
              <MoverRow key={m.address} m={m} now={now} mine={isMine(m.address)} showDay={data.windowDays !== 1} />
            ))}
          </div>
          {more}
        </div>
      )}
      <SourceLine items={[{ label: 'Net buying and selling per address', p: cov }]} label="Where the trading figures come from" />
    </ProvScope>
  );
}

function MoverRow({ m, now, mine, showDay }: { m: MoverEntry; now: number; mine: boolean; showDay: boolean }) {
  const name = m.labelPlain ?? null;
  const counts = `${times(m.buys, 'buy', 'buys')}, ${times(m.sells, 'sell', 'sells')}`;
  return (
    <div className="mvr__row" role="row">
      <span className="mvr__id" role="cell">
        <span className="mvr__name"><AddrName address={m.address} label={name} source={m.labelSource} author={m.labelAuthor} /></span>
        {name || mine ? (
          <span className="mvr__sub">
            {name ? <span className="mono">{fmtAddr(m.address)}</span> : null}
            {mine ? <YouTag /> : null}
          </span>
        ) : null}
      </span>
      <span className={`mvr__net ${hue(m.netNam7d)}`} role="cell"><Num v={m.netNam7d} fmt={fmtNamSigned} unit="NAM" /></span>
      <span className="mvr__cap" role="cell">
        {showDay ? <>24 h: <span className={hue(m.netNam24h)}><Num v={m.netNam24h} fmt={fmtNamSigned} /></span> · </> : null}
        {counts} · {fmtAgo(m.lastTs, now)}
      </span>
      <span className={`mvr__c mvr__c--day ${hue(m.netNam24h)}`} role="cell"><Num v={m.netNam24h} fmt={fmtNamSigned} /></span>
      <span className="mvr__c mvr__c--n" role="cell">{counts}</span>
      <span className="mvr__c mvr__c--last" role="cell">{fmtAgo(m.lastTs, now)}</span>
    </div>
  );
}

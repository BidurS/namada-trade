// Responses from a worker deployed before the 2026-10-17 build (W1, W2, W3, W5 and the plain notes)
// are brought to the current shape here, in one place, so the screens read one API and never carry
// their own copies of server rules. Each step is a no-op against a current server:
//
// - plainNotes(): the old worker wrote operator notes into stamps under Rewind ("replay",
//   "replay as of <ISO>", "replay: executed-swap price (SQS mid not recorded then)") and the quote
//   service's busy text told people what to do. The current worker writes the plain words below.
// - withHolder(): `label_plain`, `category_plain` (shared/labels.ts) and `status`, `statusNote`
//   (shared/holder-status.ts) when the server did not send them.
// - withFlow(), withPressure(): plain labels on flow and pressure rows (shared/labels.ts).
// - serverIgnoredFlowFilter() / filterFlows(): the W1 rules (?minNam, ?arb=false, ?pairs=one,
//   worker/src/flows-query.ts) applied to a page when the server ignored them.
//
// Nothing here invents a figure (N2): it renames, re-words or filters what the server sent.
import type { AddressReport, Flow, Holder, Overview, OnDeckEntry, MoverEntry, Pressure, UnlockEntry } from '../../../shared/types';
import { category_plain, label_plain } from '../../../shared/labels';
import { holderStatus } from '../../../shared/holder-status';

// ---------------------------------------------------------------- notes

/** One stamp note in plain words (see the header). Notes already plain pass through unchanged. */
export function plainNote(note: string | undefined, missing: boolean): { note: string | undefined; missing: boolean } {
  if (!note) return { note, missing };
  let n = note.replace(/\s*Try again in a few seconds\.?/i, '').trim();
  if (/^replay\b/i.test(n)) {
    if (/executed-swap price/i.test(n)) return { note: 'The quoted price was not recorded at that time, so this is the price real trades paid.', missing };
    return missing ? { note: 'Not recorded at that time.', missing: true } : { note: undefined, missing };
  }
  if (/^pool depth was not recorded before 2026-10-16$/i.test(n)) n = 'Pool depth was not recorded before 16 Oct 2026.';
  else if (/^no flows indexed$/i.test(n)) n = 'No moves are indexed yet.';
  else if (/^not yet verified on chain$/i.test(n)) n = 'Estimated from staking history; not read from the chain yet.';
  else if (/^live read failed\b/i.test(n)) n = 'The live read from the chain failed, so this is the last stored reading.';
  else if (/https?:|\bHTTP \d|\b(Type)?Error\b|\b(RPC|SQS|ABCI)\b/.test(n)) n = 'The live reading failed, so this is the last stored one.';
  else {
    const m = /^last Osmosis flow (.+), last Namada flow (.+)$/i.exec(n);
    if (m) n = `Last Osmosis move ${m[1].replace(/ d ago$/, ' days ago')}, last Namada move ${m[2].replace(/ d ago$/, ' days ago')}.`;
  }
  return { note: n || undefined, missing };
}

const isStamp = (o: Record<string, unknown>) => typeof o.source === 'string' && typeof o.status === 'string' && 'at' in o;

/** Every stamp in a response with its note in plain words (a deep copy only where something changed). */
export function plainNotes<T>(x: T): T {
  if (Array.isArray(x)) {
    let changed = false;
    const out = x.map((v) => {
      const w = plainNotes(v);
      if (w !== v) changed = true;
      return w;
    });
    return (changed ? out : x) as T;
  }
  if (!x || typeof x !== 'object') return x;
  const o = x as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object') {
      const w = plainNotes(v);
      if (w !== v) (out ??= { ...o })[k] = w;
    } else if (k === 'error' && typeof v === 'string' && /Try again in a few seconds/i.test(v)) {
      (out ??= { ...o })[k] = plainNote(v, false).note ?? '';
    }
  }
  if (isStamp(o) && typeof o.note === 'string') {
    const missing = o.status === 'missing' || o.at == null;
    const r = plainNote(o.note, missing);
    if (r.note !== o.note) {
      out ??= { ...o };
      if (r.note) out.note = r.note;
      else delete out.note;
      if (r.missing && /^replay\b/i.test(o.note as string)) {
        out.status = 'missing';
        out.at = null;
      }
    }
  }
  return (out ?? o) as T;
}

// ---------------------------------------------------------------- overview

/** The old worker sent holder counts as `|| 0`, so 0 meant "not known": it is null now (no real count is 0). */
export function withOverview(o: Overview): Overview {
  if (o.dex.holders !== 0 && o.namada.holders !== 0) return o;
  return {
    ...o,
    dex: { ...o.dex, holders: o.dex.holders === 0 ? null : o.dex.holders },
    namada: { ...o.namada, holders: o.namada.holders === 0 ? null : o.namada.holders },
  };
}

// ---------------------------------------------------------------- labels and status

export function withHolder(h: Holder, now = Date.now()): Holder {
  const needLabel = h.label_plain === undefined || h.category_plain === undefined;
  const needStatus = h.status === undefined;
  if (!needLabel && !needStatus) return h;
  const out: Holder = { ...h };
  if (h.label_plain === undefined) out.label_plain = label_plain(h.label ?? null, h.address, h.label_source);
  if (h.category_plain === undefined) out.category_plain = category_plain(h.category ?? null, h.label ?? null);
  if (needStatus) {
    const st = holderStatus(
      {
        chain: h.chain,
        verifiedAt: h.verifiedAt ?? null,
        hasLiquidRow: h.updatedAt != null || h.verifiedAt != null || h.balance > 0,
        bondedRead: h.chain === 'namada' ? h.bonded ?? null : null,
        bondedVerifiedAt: h.bondedVerifiedAt ?? null,
        bondedEstimated: h.bondedEstimated ?? null,
      },
      now,
    );
    out.status = st.status;
    out.statusNote = st.statusNote;
    // The old worker sends 0 for both changes whatever happened (owner decision 13): unknown, never a zero.
    out.change24h = null;
    out.change7d = null;
  }
  return out;
}

export function withFlow(f: Flow): Flow {
  if (f.fromLabelPlain !== undefined && f.toLabelPlain !== undefined) return f;
  return {
    ...f,
    fromLabelPlain: f.fromLabelPlain !== undefined ? f.fromLabelPlain : label_plain(f.fromLabel ?? null, f.from),
    toLabelPlain: f.toLabelPlain !== undefined ? f.toLabelPlain : label_plain(f.toLabel ?? null, f.to),
  };
}

export function withPressure(p: Pressure): Pressure {
  const deck = (e: OnDeckEntry): OnDeckEntry =>
    e.labelPlain !== undefined && e.linkedLabelPlain !== undefined
      ? e
      : { ...e, labelPlain: e.labelPlain ?? label_plain(e.label, e.address), linkedLabelPlain: e.linkedLabelPlain ?? (e.linkedNamada ? label_plain(e.linkedLabel, e.linkedNamada) : null) };
  const unlock = (u: UnlockEntry): UnlockEntry => (u.labelPlain !== undefined ? u : { ...u, labelPlain: label_plain(u.label, u.address) });
  const mover = (m: MoverEntry): MoverEntry => (m.labelPlain !== undefined ? m : { ...m, labelPlain: label_plain(m.label, m.address) });
  return { ...p, onDeck: p.onDeck.map(deck), unlocks: p.unlocks.map(unlock), movers: p.movers.map(mover) };
}

export function withAddressReport(r: AddressReport): AddressReport {
  const label = r.label && r.label.label_plain === undefined
    ? { ...r.label, label_plain: label_plain(r.label.label, r.address, r.label.label_source), category_plain: category_plain(r.label.category, r.label.label) }
    : r.label;
  return {
    ...r,
    label,
    flows: r.flows.map(withFlow),
    counterparties: r.counterparties.map((c) => (c.label_plain !== undefined ? c : { ...c, label_plain: label_plain(c.label, c.address) })),
  };
}

// ---------------------------------------------------------------- the W1 flow filter

export { applyFlowRules as filterFlows, serverIgnoredFlowFilter, type FlowRules } from './flows';

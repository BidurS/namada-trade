// Plain-language names for address labels and categories (owner decision 6, W3).
//
// Labels come from the genesis file ("Genesis: af_backers, public_allocations_completed"), from the
// protocol ("Namada PoS (bonded + unbonding)"), from pool discovery and from users. The raw label stays
// in the API as `label` (it is what the source says); `label_plain` and `category_plain` are what the
// site shows. The wording of the genesis names is the owner's to review.
//
// Shared by the worker (which sends `label_plain` / `category_plain`) and the web app (which fills
// them in for a server that predates W3, web/src/lib/compat.ts), so there is one table.
import { NAMADA, OSMOSIS_TRANSFER_MODULE } from './config';

/** Genesis allocation names with an agreed plain wording. Keys are the raw names, underscores or spaces. */
const GENESIS_PLAIN: Record<string, string> = {
  af_backers: 'Early backers',
  public_allocations_completed: 'Public sale allocation',
};

/** Protocol accounts: their raw labels carry expert words (PoS, IBC, MASP), so they get a name by address. */
const PROTOCOL_PLAIN: Record<string, string> = {
  [NAMADA.internal.pos]: 'Staking account (staked and unstaking NAM)',
  [NAMADA.internal.ibc]: 'Bridge account (NAM held for Osmosis)',
  [NAMADA.internal.masp]: 'Shielded pool',
  [NAMADA.internal.pgf]: 'Public funding account',
  [NAMADA.internal.governance]: 'Governance account',
  [OSMOSIS_TRANSFER_MODULE]: 'Osmosis bridge account',
};

/** Categories named by owner decision 6, then protocol categories whose raw names are expert words. */
const CATEGORY_PLAIN: Record<string, string> = {
  genesis: 'Genesis',
  foundation: 'Foundation',
  validator: 'Validator',
  exchange: 'Exchange',
  bridge: 'Bridge',
  pgf: 'Public funding',
  // not in the decision: the raw words are PoS, MASP, IBC, CEX or code names
  pos: 'Staking account',
  masp: 'Shielded pool',
  ibc: 'Bridge account',
  module: 'Protocol account',
  cex: 'Exchange',
};

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '_');

/** "a", "a and b", "a, b and c" */
function joinPlain(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The label as the site shows it.
 * - `Genesis: af_backers` → "Early backers (genesis)"; `Genesis: public_allocations_completed` → "Public sale allocation (genesis)".
 * - Several known allocations → "Early backers and public sale allocation (genesis)".
 * - Any other `Genesis: x_y` → "Genesis: X y" (underscores as spaces, first letter capital).
 * - Protocol accounts are named by address; any other label is returned as it is.
 * - A tag a signed-in wallet wrote (`source` 'user') is returned as typed: it never gets the genesis wording,
 *   so "Genesis: …" typed by a user does not read like the curated genesis names.
 */
export function label_plain(label: string | null | undefined, address?: string | null, source?: string | null): string | null {
  if (address && PROTOCOL_PLAIN[address]) return PROTOCOL_PLAIN[address];
  if (!label) return null;
  if (source === 'user') return label.trim();
  const m = /^\s*genesis\s*:\s*(.+)$/i.exec(label);
  if (!m) return label.trim();
  const raw = m[1].split(',').map((p) => p.trim()).filter(Boolean);
  const known = raw.map((p) => GENESIS_PLAIN[key(p)] ?? null);
  if (known.every((k): k is string => k != null)) {
    return `${cap(joinPlain(known.map((k, i) => (i === 0 ? k : k.charAt(0).toLowerCase() + k.slice(1)))))} (genesis)`;
  }
  const words = raw.map((p, i) => {
    const k = GENESIS_PLAIN[key(p)];
    if (k) return i === 0 ? k : k.charAt(0).toLowerCase() + k.slice(1);
    return p.replace(/_/g, ' ').replace(/\s+/g, ' ');
  });
  return `Genesis: ${cap(joinPlain(words))}`;
}

/**
 * Labels whose genesis category is the wrong word for them: Heliax is the company that builds Namada, not a
 * foundation. No tag is shown for these (system.md 8: a tag shows only when it adds information) until the owner
 * picks a word (system.md 11 lists it for the owner pass).
 */
const CATEGORY_HIDDEN: { label: RegExp; category: string }[] = [{ label: /^\s*heliax\s*$/i, category: 'foundation' }];

/**
 * The category as the site shows it: the decision's names, else the word with its first letter capitalised.
 * Pass the raw `label` so a category that does not fit its label (CATEGORY_HIDDEN) shows no tag (null).
 */
export function category_plain(category: string | null | undefined, label?: string | null): string | null {
  if (!category) return null;
  const c = category.trim().toLowerCase();
  if (label && CATEGORY_HIDDEN.some((h) => h.category === c && h.label.test(label))) return null;
  return CATEGORY_PLAIN[c] ?? cap(c.replace(/_/g, ' '));
}

/**
 * For a tag a signed-in wallet wrote (`source` 'user'): the start of that wallet's address ("tnam1qxyz…"), which
 * the API sends as `label_author` / `…LabelAuthor`. null for every curated label.
 */
export function labelAuthorShort(source: string | null | undefined, author: string | null | undefined): string | null {
  return source === 'user' && author ? `${author.slice(0, 12)}…` : null;
}

/**
 * The words that go with a user tag wherever it is shown ("Tag by tnam1qxyz…"), so it never reads like a curated
 * name (genesis, foundation, exchange). null for curated labels and for no label.
 */
export function tagByline(source: string | null | undefined, authorShort: string | null | undefined): string | null {
  if (source !== 'user') return null;
  return authorShort ? `Tag by ${authorShort}` : 'Tag by a signed-in wallet';
}

/**
 * Raw label fragments to search for when someone types a plain name, so "early backers" finds
 * `Genesis: af_backers` and "early core" finds `early_core_contributors`.
 */
export function labelSearchTerms(q: string): string[] {
  const t = q.trim().toLowerCase();
  if (!t) return [];
  const out = new Set<string>([t, t.replace(/\s+/g, '_')]);
  for (const [raw, plain] of Object.entries(GENESIS_PLAIN)) if (plain.toLowerCase().includes(t) || t.includes(plain.toLowerCase())) out.add(raw);
  return [...out];
}

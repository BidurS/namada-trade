// The client a per-address limit counts: every limiter (http.ts limitBy: HEAVY, SEARCH, REPLAY and WS) and the live
// hub's admission (ws-admit.ts) read the connecting address through this, never the header as sent.
//
// An IPv4 address is one client. An IPv6 address is counted by its /64: a subscriber line is handed a /64 at the
// least (often a /56 or a /48) and a machine may take any address in it, so keyed on the whole IPv6 address one
// machine counted as 2^64 clients (own audit 2026-10-29, Low 1). The hub also caps a /48 (MAX_SOCKETS_PER_V6_48),
// the widest block one site is usually handed. An IPv4 address written as IPv6 (::ffff:192.0.2.1) is the IPv4 one.
//
// Written in one spelling whatever the header's: lower case, no leading zeros, `::` read out, so two spellings of
// one /64 are one key. Nothing here is stored: the key lives in the limiter's window and the hub's memory only.

/** The client of one request. */
export interface Client {
  /** What a limit counts: the IPv4 address ("192.0.2.1"), or the IPv6 /64 ("2001:db8:1:2::/64"). */
  key: string;
  /** IPv6 only: the /48 the /64 is in ("2001:db8:1::/48"), for the hub's wider cap; null for IPv4. */
  wide: string | null;
  v6: boolean;
}

/** No address on the request (a local run, a direct call to the origin): one bucket for all of them, never none. */
export const UNKNOWN_CLIENT: Client = { key: 'unknown', wide: null, v6: false };

/** The four bytes of a dotted IPv4 address, or null. */
function v4Bytes(s: string): number[] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;
  const b = s.split('.').map(Number);
  return b.every((x) => x <= 255) ? b : null;
}

/** The eight 16-bit groups of an IPv6 address (`::` read out, an IPv4 tail as its two groups), or null. */
export function v6Groups(s: string): number[] | null {
  let t = s.toLowerCase();
  let tail: number[] = [];
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(t);
  if (dotted) {
    const b = v4Bytes(dotted[2]);
    if (!b) return null;
    tail = [(b[0] << 8) | b[1], (b[2] << 8) | b[3]];
    // "::ffff:192.0.2.1" leaves "::ffff", "::192.0.2.1" leaves "::"
    t = dotted[1].endsWith('::') ? dotted[1] : dotted[1].slice(0, -1);
  }
  const halves = t.split('::');
  if (halves.length > 2) return null;
  const groups = (x: string) => (x === '' ? [] : x.split(':'));
  const hi = groups(halves[0]);
  const lo = halves.length === 2 ? groups(halves[1]) : [];
  if (![...hi, ...lo].every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const n = hi.length + lo.length + tail.length;
  // without `::` every group is written; with it at least one is left out
  if (halves.length === 1 ? n !== 8 : n > 7) return null;
  const hex = (g: string) => parseInt(g, 16);
  return [...hi.map(hex), ...(halves.length === 2 ? Array<number>(8 - n).fill(0) : []), ...lo.map(hex), ...tail];
}

const prefix = (g: number[], n: number) => `${g.slice(0, n).map((x) => x.toString(16)).join(':')}::/${n * 16}`;

/** The client of a connecting address (cf-connecting-ip): an IPv4 address whole, an IPv6 address by its /64. */
export function clientOf(ip: string | null | undefined): Client {
  const s = (ip ?? '').trim();
  if (!s) return UNKNOWN_CLIENT;
  const b = v4Bytes(s);
  if (b) return { key: b.join('.'), wide: null, v6: false };
  const g = s.includes(':') ? v6Groups(s) : null;
  if (g) {
    // ::ffff:0:0/96, an IPv4 address written as IPv6: the IPv4 address
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return { key: [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.'), wide: null, v6: false };
    return { key: prefix(g, 4), wide: prefix(g, 3), v6: true };
  }
  // Not an address (Cloudflare always sends one): its own bucket, as sent, bounded in length.
  return { key: s.toLowerCase().slice(0, 64), wide: null, v6: false };
}

/** The key a per-address limit counts (Client.key). */
export const clientKey = (ip: string | null | undefined): string => clientOf(ip).key;

/** The client of a request, from the address Cloudflare connects it from. */
export const clientOfRequest = (request: Request): Client => clientOf(request.headers.get('cf-connecting-ip'));

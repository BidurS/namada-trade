// Wallet login by signed message (no transaction, no fee), sessions, and desktop→phone pairing.
//
// Namada Keychain: ed25519 `signArbitrary` over sha256(message). The public key must match the key the
// chain has for that address: we check the indexer's revealed key first and, independently, derive the
// implicit address from the key (sha256(borsh pk)[0..20] behind a 0x00 discriminant, bech32m "tnam").
// Keplr (Osmosis): ADR-36 `signArbitrary`; secp256k1 over sha256 of the amino sign doc; address =
// bech32("osmo", ripemd160(sha256(pubkey))).
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bech32, bech32m, base64, hex } from '@scure/base';
import { kvGetJson, kvSet } from './db';
import { fetchJson } from './util';
import type { Chain, SessionInfo } from '../../shared/types';

const INDEXER = 'https://indexer.namada.net/api/v1';
const NONCE_TTL = 5 * 60000;
const SESSION_TTL = 30 * 86400000;
const API_KEY_TTL = 365 * 86400000;
const PAIR_TTL = 10 * 60000;

export interface Session {
  token: string;
  address: string;
  chain: Chain;
  /** tnam1 linked to an osmo1 login via observed IBC packets (display only) */
  linked: string | null;
  via: 'namada' | 'keplr' | 'pair' | 'api';
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number | null;
}

const rand = (n: number) => hex.encode(crypto.getRandomValues(new Uint8Array(n)));

export function loginMessage(address: string, nonce: string): string {
  return `NamadaTrade login\naddress: ${address}\nnonce: ${nonce}\n\nThis signature only proves you control this address. It is not a transaction and costs nothing.`;
}

export async function issueNonce(db: D1Database, address: string): Promise<{ nonce: string; message: string; expiresAt: number }> {
  const nonce = rand(16);
  const expiresAt = Date.now() + NONCE_TTL;
  await kvSet(db, `authnonce:${nonce}`, { address, expiresAt });
  return { nonce, message: loginMessage(address, nonce), expiresAt };
}

async function consumeNonce(db: D1Database, nonce: string, address: string): Promise<boolean> {
  const row = await kvGetJson<{ address: string; expiresAt: number }>(db, `authnonce:${nonce}`);
  await db.prepare('DELETE FROM kv WHERE key = ?').bind(`authnonce:${nonce}`).run().catch(() => {});
  return !!row && row.address === address && row.expiresAt > Date.now();
}

// ---------------------------------------------------------------- Namada

/** Implicit address for an ed25519 public key (33-byte borsh form: 0x00 tag + 32 bytes). */
export function namadaImplicitAddress(pkBorsh: Uint8Array): string {
  const pkh = sha256(pkBorsh).slice(0, 20);
  return bech32m.encode('tnam', bech32m.toWords(new Uint8Array([0, ...pkh])), 100);
}

function parseNamadaPubkey(input: string): Uint8Array {
  const s = input.trim();
  if (s.startsWith('tpknam1')) return bech32m.fromWords(bech32m.decode(s as `${string}1${string}`, 100).words);
  const b = hex.decode(s.replace(/^0x/, ''));
  if (b.length === 32) return new Uint8Array([0, ...b]);
  if (b.length === 33) return b;
  throw new Error('unrecognised Namada public key');
}

async function revealedKey(address: string): Promise<Uint8Array | null> {
  try {
    const r = await fetchJson<any>(`${INDEXER}/revealed-public-key/${address}`, { timeoutMs: 6000, retries: 1 });
    return r?.publicKey ? parseNamadaPubkey(r.publicKey) : null;
  } catch {
    return null;
  }
}

/** Returns an error string, or null when the signature is valid for the address. */
export async function verifyNamada(address: string, message: string, pubkeyIn: string, signatureIn: string): Promise<string | null> {
  let pk: Uint8Array;
  try { pk = parseNamadaPubkey(pubkeyIn); } catch (e) { return String(e); }
  if (pk[0] !== 0) return 'only ed25519 keys are supported';
  const key = pk.slice(1);

  // Key ↔ address binding: derivation (always) and the chain's revealed key (when the account has one).
  if (namadaImplicitAddress(pk) !== address) return 'public key does not belong to this address';
  const revealed = await revealedKey(address);
  if (revealed && hex.encode(revealed) !== hex.encode(pk)) return 'public key differs from the key revealed on chain';

  let sig: Uint8Array;
  try {
    sig = hex.decode(signatureIn.replace(/^0x/, ''));
    if (sig.length === 65 && sig[0] === 0) sig = sig.slice(1); // borsh common::Signature tag
  } catch { return 'bad signature encoding'; }
  if (sig.length !== 64) return 'bad signature length';

  const msg = new TextEncoder().encode(message);
  const ok = ed25519.verify(sig, sha256(msg), key) || ed25519.verify(sig, msg, key);
  return ok ? null : 'signature does not verify';
}

// ---------------------------------------------------------------- Keplr / ADR-36

function sortedJson(v: any): string {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export function adr36SignDoc(signer: string, data: Uint8Array): string {
  return sortedJson({
    chain_id: '', account_number: '0', sequence: '0', fee: { gas: '0', amount: [] }, memo: '',
    msgs: [{ type: 'sign/MsgSignData', value: { signer, data: base64.encode(data) } }],
  });
}

export function osmosisAddress(pubkey33: Uint8Array): string {
  return bech32.encode('osmo', bech32.toWords(ripemd160(sha256(pubkey33))));
}

export function verifyKeplr(address: string, message: string, pubkeyB64: string, signatureB64: string): string | null {
  let pub: Uint8Array, sig: Uint8Array;
  try { pub = base64.decode(pubkeyB64); sig = base64.decode(signatureB64); } catch { return 'bad encoding'; }
  if (pub.length !== 33) return 'expected a 33-byte compressed public key';
  if (sig.length !== 64) return 'expected a 64-byte signature';
  if (osmosisAddress(pub) !== address) return 'public key does not belong to this address';
  const digest = sha256(new TextEncoder().encode(adr36SignDoc(address, new TextEncoder().encode(message))));
  try {
    return secp256k1.verify(sig, digest, pub, { lowS: false, prehash: false }) ? null : 'signature does not verify';
  } catch (e) {
    return `verify failed: ${String(e).slice(0, 80)}`;
  }
}

// ---------------------------------------------------------------- sessions
//
// A session or API key is a random 32-byte bearer token. The database never holds the token itself: the row is
// `session:<sha256(token) hex>` and its value has no token field, so a copy of the database (an export, Time
// Travel, a backup) holds nothing that can be sent as a bearer token. The token is shown once, by createSession.
// Sessions are found by address with a query (no separate index that could drop entries), so revoking them all,
// listing devices and the cap see every live session.
//
// Rows written before tokens were hashed (`session:<token>`, the token also in the value) are not accepted: a copy
// of the database from before (an export, Time Travel, a backup) would otherwise still hold working tokens for up
// to a year. Migration 0005 deletes them at deploy and sweepAuth deletes any left; their owners sign in again.

/**
 * Live signed-in and paired devices an address may have; one more ends the oldest, but never the device that is
 * pairing the new one. API keys are counted apart (MAX_API_KEYS), so pairing devices never ends a script's key.
 */
export const MAX_SESSIONS = 50;
/** Live API keys an address may have; making one more is refused (revoke one first), never done by ending one. */
export const MAX_API_KEYS = 20;
/** A stored session row from before tokens were hashed: its value still holds the token. */
export const LEGACY_SESSION_SQL = `key LIKE 'session:%' AND json_extract(value, '$.token') IS NOT NULL`;

export const tokenHash = (token: string) => hex.encode(sha256(new TextEncoder().encode(token)));
const sessionKey = (token: string) => `session:${tokenHash(token)}`;
type Stored = Omit<Session, 'token'> & { token?: string };

/** The address's most-used counterpart across the bridge (osmo1 for a tnam1 login, tnam1 for an osmo1 login). */
async function linkedCounterpart(db: D1Database, address: string): Promise<string | null> {
  const r = address.startsWith('osmo1')
    ? await db.prepare('SELECT namada_addr a FROM address_links WHERE osmo_addr = ? ORDER BY volume_num DESC LIMIT 1').bind(address).first<{ a: string }>().catch(() => null)
    : await db.prepare('SELECT osmo_addr a FROM address_links WHERE namada_addr = ? ORDER BY volume_num DESC LIMIT 1').bind(address).first<{ a: string }>().catch(() => null);
  return r?.a ?? null;
}

/** Every stored session row of an address (hashed keys and rows written before hashing), newest first. */
async function sessionRows(db: D1Database, address: string): Promise<{ key: string; s: Stored }[]> {
  const r = await db.prepare(`SELECT key, value FROM kv WHERE key LIKE 'session:%' AND json_extract(value, '$.address') = ?`).bind(address).all<{ key: string; value: string }>().catch(() => ({ results: [] as { key: string; value: string }[] }));
  const out: { key: string; s: Stored }[] = [];
  for (const row of r.results || []) {
    try { out.push({ key: row.key, s: JSON.parse(row.value) as Stored }); } catch {}
  }
  return out.sort((a, b) => b.s.createdAt - a.s.createdAt);
}

/**
 * A new session (via namada, keplr or pair) or API key (via api). `keepHash`: the token hash of the device that is
 * pairing this one, which the cap never ends. Over MAX_SESSIONS the oldest other device sessions are ended (their
 * rows deleted, never left valid and unlisted); API keys are not touched by that cap. Over MAX_API_KEYS a new key
 * is refused instead.
 */
export async function createSession(db: D1Database, address: string, chain: Chain, via: Session['via'], keepHash?: string | null): Promise<Session | { error: string }> {
  const now = Date.now();
  const live = (await sessionRows(db, address)).filter((x) => x.s.expiresAt >= now && !x.s.token);
  if (via === 'api' && live.filter((x) => x.s.via === 'api').length >= MAX_API_KEYS) {
    return { error: `This address has ${MAX_API_KEYS} API keys. Revoke one under For developers first.` };
  }
  const s: Session = { token: rand(32), address, chain, linked: await linkedCounterpart(db, address), via, createdAt: now, expiresAt: now + (via === 'api' ? API_KEY_TTL : SESSION_TTL), lastUsedAt: null };
  const { token, ...stored } = s;
  await kvSet(db, sessionKey(token), stored);
  if (via !== 'api') {
    const keep = new Set([sessionKey(token), ...(keepHash ? [`session:${keepHash}`] : [])]);
    const devices = [{ key: sessionKey(token) }, ...live.filter((x) => x.s.via !== 'api')];
    const excess = devices.length - MAX_SESSIONS;
    // the oldest of the ones that may go (`live` is newest first)
    if (excess > 0) for (const old of devices.filter((x) => !keep.has(x.key)).slice(-excess)) await db.prepare('DELETE FROM kv WHERE key = ?').bind(old.key).run().catch(() => {});
  }
  return s;
}

/** createSession for a device sign-in or pairing, which the caps never refuse. */
async function newDeviceSession(db: D1Database, address: string, chain: Chain, via: 'namada' | 'keplr' | 'pair', keepHash?: string | null): Promise<Session> {
  const r = await createSession(db, address, chain, via, keepHash);
  if ('error' in r) throw new Error(r.error);
  return r;
}

/** Sessions of an address, newest first, without tokens (ids are a prefix of the token's hash, enough to revoke). */
export async function listSessions(db: D1Database, address: string, currentToken: string): Promise<SessionInfo[]> {
  const current = sessionKey(currentToken);
  const out: SessionInfo[] = [];
  for (const { key, s } of await sessionRows(db, address)) {
    if (s.expiresAt < Date.now()) continue;
    if (s.token) continue; // a row from before hashing: not accepted (it is deleted by the sweep)
    out.push({ id: key.slice('session:'.length, 'session:'.length + 8), via: s.via, createdAt: s.createdAt, expiresAt: s.expiresAt, lastUsedAt: s.lastUsedAt ?? null, current: key === current });
  }
  return out;
}

export async function revokeSession(db: D1Database, address: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f]{8,64}$/.test(id)) return false;
  const r = await db.prepare(`DELETE FROM kv WHERE key LIKE ? AND json_extract(value, '$.address') = ?`).bind(`session:${id}%`, address).run().catch(() => null);
  return Number(r?.meta?.changes ?? 0) > 0;
}

/** Every session and API key of the address, wherever it was created, plus the old per-address index row. */
export async function revokeAllSessions(db: D1Database, address: string) {
  await db.prepare(`DELETE FROM kv WHERE key LIKE 'session:%' AND json_extract(value, '$.address') = ?`).bind(address).run().catch(() => {});
  await db.prepare('DELETE FROM kv WHERE key = ?').bind(`sessions:${address}`).run().catch(() => {});
}

export async function login(db: D1Database, body: any): Promise<{ session?: Session; error?: string }> {
  const address = String(body.address || '').trim();
  const nonce = String(body.nonce || '');
  const chain: Chain | null = address.startsWith('tnam1') ? 'namada' : address.startsWith('osmo1') ? 'osmosis' : null;
  if (!chain) return { error: 'address must be tnam1… or osmo1…' };
  if (!(await consumeNonce(db, nonce, address))) return { error: 'This sign-in request expired or was already used.' };
  const message = loginMessage(address, nonce);
  const err = chain === 'namada'
    ? await verifyNamada(address, message, String(body.pubkey || ''), String(body.signature || ''))
    : verifyKeplr(address, message, String(body.pubkey || ''), String(body.signature || ''));
  if (err) return { error: err };
  return { session: await newDeviceSession(db, address, chain, chain === 'namada' ? 'namada' : 'keplr') };
}

export async function sessionFromRequest(db: D1Database, req: Request): Promise<Session | null> {
  const h = req.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const key = sessionKey(token);
  const stored = await kvGetJson<Stored>(db, key);
  // Only hashed rows are sessions: a row from before hashing (`session:<token>`) is refused and deleted, since a
  // copy of the database from before could hold its token (see above).
  if (!stored || stored.token) {
    await db.prepare('DELETE FROM kv WHERE key = ?').bind(`session:${token}`).run().catch(() => {});
    return null;
  }
  if (stored.expiresAt < Date.now()) return null;
  // Touch at most once per 10 minutes so the devices list can show "last used".
  if (!stored.lastUsedAt || Date.now() - stored.lastUsedAt > 600000) {
    stored.lastUsedAt = Date.now();
    kvSet(db, key, stored).catch(() => {});
  }
  return { ...stored, token } as Session;
}

export async function logout(db: D1Database, token: string) {
  await db.prepare('DELETE FROM kv WHERE key = ? OR key = ?').bind(sessionKey(token), `session:${token}`).run().catch(() => {});
}

// ---------------------------------------------------------------- pairing

export async function createPairCode(db: D1Database, s: Session): Promise<{ code: string; expiresAt: number }> {
  const code = rand(4).toUpperCase(); // 8 hex chars, 10-minute life, single use
  const expiresAt = Date.now() + PAIR_TTL;
  // `by`: the hash of the pairing device's token (never the token), so the cap cannot end that device.
  await kvSet(db, `pair:${code}`, { address: s.address, chain: s.chain, expiresAt, by: tokenHash(s.token) });
  return { code, expiresAt };
}

export async function claimPairCode(db: D1Database, codeIn: string): Promise<{ session?: Session; error?: string }> {
  const code = codeIn.trim().toUpperCase();
  if (!/^[0-9A-F]{8}$/.test(code)) return { error: 'code is 8 characters' };
  const row = await kvGetJson<{ address: string; chain: Chain; expiresAt: number; by?: string }>(db, `pair:${code}`);
  await db.prepare('DELETE FROM kv WHERE key = ?').bind(`pair:${code}`).run().catch(() => {});
  if (!row || row.expiresAt < Date.now()) return { error: 'code expired or already used' };
  return { session: await newDeviceSession(db, row.address, row.chain, 'pair', row.by ?? null) };
}

/**
 * Cron: drop expired nonces, sessions and pair codes, the per-address session index rows no longer used, and any
 * session row from before tokens were hashed (migration 0005 deletes them at deploy; this catches any left).
 */
export async function sweepAuth(db: D1Database) {
  await db.prepare(`DELETE FROM kv WHERE (key LIKE 'session:%' OR key LIKE 'authnonce:%' OR key LIKE 'pair:%') AND CAST(json_extract(value, '$.expiresAt') AS INTEGER) < ?`).bind(Date.now()).run().catch(() => {});
  await db.prepare(`DELETE FROM kv WHERE key LIKE 'sessions:%'`).run().catch(() => {});
  await db.prepare(`DELETE FROM kv WHERE ${LEGACY_SESSION_SQL}`).run().catch(() => {});
}

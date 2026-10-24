// Wallet login by signed message (no transaction, no fee), sessions, and desktop→phone pairing.
//
// Namada Keychain: ed25519 `signArbitrary` over sha256(message). The public key must match the key the
// chain has for that address: the implicit address is derived from the key (sha256(borsh pk)[0..20] behind a
// 0x00 discriminant, bech32m "tnam") and, once the signature verifies, the indexer's revealed key is compared too.
// Keplr (Osmosis): ADR-36 `signArbitrary`; secp256k1 over sha256 of the amino sign doc; address =
// bech32("osmo", ripemd160(sha256(pubkey))).
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bech32, bech32m, base64, hex } from '@scure/base';
import { kvGetJson, kvSet } from './db';
import { fetchJson } from './util';
import type { Chain, SessionInfo } from '../../shared/types';
import { loginMessage, NONCE_RE } from '../../shared/login';

export { loginMessage };

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

export async function issueNonce(db: D1Database, address: string): Promise<{ nonce: string; message: string; expiresAt: number }> {
  const nonce = rand(16);
  const expiresAt = Date.now() + NONCE_TTL;
  await kvSet(db, `authnonce:${nonce}`, { address, expiresAt });
  return { nonce, message: loginMessage(address, nonce), expiresAt };
}

/** One use: the row is read, then deleted, and only the caller whose delete removed it (one statement, atomic) goes on. */
async function consumeNonce(db: D1Database, nonce: string, address: string): Promise<boolean> {
  if (!NONCE_RE.test(nonce)) return false;
  const row = await kvGetJson<{ address: string; expiresAt: number }>(db, `authnonce:${nonce}`);
  if (!row) return false;
  const r = await db.prepare('DELETE FROM kv WHERE key = ?').bind(`authnonce:${nonce}`).run().catch(() => null);
  if (Number(r?.meta?.changes ?? 0) !== 1) return false;
  return row.address === address && row.expiresAt > Date.now();
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
    // One short attempt: a slow indexer holds a sign-in a few seconds, never longer (the check is a second opinion).
    const r = await fetchJson<any>(`${INDEXER}/revealed-public-key/${address}`, { timeoutMs: 3000, retries: 0 });
    return r?.publicKey ? parseNamadaPubkey(r.publicKey) : null;
  } catch {
    return null;
  }
}

/** The first byte of a `tnam1` address: 0 an implicit account (a key hash), 1 an established one, 2 and up internal; null when it is not an address. */
export function namadaAddressDiscriminant(address: string): number | null {
  try {
    const dec = bech32m.decode(address as `${string}1${string}`, 100);
    if (dec.prefix !== 'tnam') return null;
    const raw = bech32m.fromWords(dec.words);
    return raw.length === 21 ? raw[0] : null;
  } catch {
    return null;
  }
}

/** Returns an error string, or null when the signature is valid for the address. */
export async function verifyNamada(address: string, message: string, pubkeyIn: string, signatureIn: string): Promise<string | null> {
  let pk: Uint8Array;
  try { pk = parseNamadaPubkey(pubkeyIn); } catch { return 'unrecognised Namada public key'; }
  if (pk[0] !== 0) return 'only ed25519 keys are supported';
  const key = pk.slice(1);

  // Key ↔ address binding, then the signature. An implicit account (discriminant 0) is the hash of its key, so the
  // binding is local; an established account (1, "tnam1q8…") has no key in its address, so its binding is the key
  // it revealed on chain, read only for a proven signer: a request with a bad signature never costs an indexer call.
  const disc = namadaAddressDiscriminant(address);
  if (disc !== 0 && disc !== 1) return 'public key does not belong to this address';
  if (disc === 0 && namadaImplicitAddress(pk) !== address) return 'public key does not belong to this address';

  let sig: Uint8Array;
  try {
    sig = hex.decode(signatureIn.replace(/^0x/, ''));
    if (sig.length === 65 && sig[0] === 0) sig = sig.slice(1); // borsh common::Signature tag
  } catch { return 'bad signature encoding'; }
  if (sig.length !== 64) return 'bad signature length';

  const msg = new TextEncoder().encode(message);
  // Strict RFC 8032 (no ZIP-215 leniency): one canonical signature per message and key.
  const ok = ed25519.verify(sig, sha256(msg), key, { zip215: false }) || ed25519.verify(sig, msg, key, { zip215: false });
  if (!ok) return 'signature does not verify';

  const revealed = await revealedKey(address);
  if (disc === 1) {
    if (!revealed || hex.encode(revealed) !== hex.encode(pk)) return 'public key does not belong to this address';
  } else if (revealed && hex.encode(revealed) !== hex.encode(pk)) return 'public key differs from the key revealed on chain';
  return null;
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
/**
 * Every row whose key starts with `prefix:`, as a range the primary key answers (`LIKE 'prefix:%'` cannot use the
 * index under SQLite's case-insensitive LIKE and scans the whole table). ';' is the byte after ':'.
 */
export const keyPrefix = (prefix: string) => `(key >= '${prefix}:' AND key < '${prefix};')`;
/** A stored session row from before tokens were hashed: its value still holds the token. */
export const LEGACY_SESSION_SQL = `${keyPrefix('session')} AND json_extract(value, '$.token') IS NOT NULL`;
/**
 * The session and API-key rows of one address (bind: the address), on migration 0009's partial index: the rows of
 * that address only (at most MAX_SESSIONS + MAX_API_KEYS live, plus any expired since the last sweep), never every
 * session row on the site. The range terms are keyPrefix('session') as written, which the index's WHERE repeats.
 */
const SESSIONS_OF = `kv INDEXED BY kv_session_addr WHERE ${keyPrefix('session')} AND json_extract(value, '$.address') = ?`;

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
  // No catch: a failed read is an error (a 500), never "no rows", which would lift MAX_API_KEYS and the device cap.
  const r = await db.prepare(`SELECT key, value FROM ${SESSIONS_OF}`).bind(address).all<{ key: string; value: string }>();
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
 *
 * `parentHash`: the token hash of the session this one is made from (the device minting a key, the device whose
 * pair code is claimed). It is checked again after the write: a revoke that ran while this request was in flight
 * (logout, Revoke, Delete everything) has deleted the parent, so the new row is deleted too and nothing outlives
 * the revoke. A revoke that runs after the check deletes the new row with the rest of the address's rows.
 */
export async function createSession(db: D1Database, address: string, chain: Chain, via: Session['via'], keepHash?: string | null, parentHash?: string | null): Promise<Session | { error: string }> {
  const now = Date.now();
  const live = (await sessionRows(db, address)).filter((x) => x.s.expiresAt >= now && !x.s.token);
  if (via === 'api' && live.filter((x) => x.s.via === 'api').length >= MAX_API_KEYS) {
    return { error: `This address has ${MAX_API_KEYS} API keys. Revoke one under For developers first.` };
  }
  const s: Session = { token: rand(32), address, chain, linked: await linkedCounterpart(db, address), via, createdAt: now, expiresAt: now + (via === 'api' ? API_KEY_TTL : SESSION_TTL), lastUsedAt: null };
  const { token, ...stored } = s;
  await kvSet(db, sessionKey(token), stored);
  if (parentHash && !(await liveSession(db, parentHash, address))) {
    await db.prepare('DELETE FROM kv WHERE key = ?').bind(sessionKey(token)).run().catch(() => {});
    return { error: PARENT_ENDED };
  }
  if (via !== 'api') {
    const keep = new Set([sessionKey(token), ...(keepHash ? [`session:${keepHash}`] : [])]);
    const devices = [{ key: sessionKey(token) }, ...live.filter((x) => x.s.via !== 'api')];
    const excess = devices.length - MAX_SESSIONS;
    // the oldest of the ones that may go (`live` is newest first)
    if (excess > 0) for (const old of devices.filter((x) => !keep.has(x.key)).slice(-excess)) await db.prepare('DELETE FROM kv WHERE key = ?').bind(old.key).run().catch(() => {});
  }
  return s;
}

/** Why a key or a pairing is refused when the session it comes from was ended meanwhile. */
export const PARENT_ENDED = 'The device this came from was signed out. Sign in again.';

/** A signed-in device or paired session (never an API key) of `address`, by its token hash, still live. */
async function liveSession(db: D1Database, hash: string, address: string): Promise<boolean> {
  const p = await kvGetJson<Stored>(db, `session:${hash}`).catch(() => null);
  return !!p && !p.token && p.address === address && p.via !== 'api' && p.expiresAt >= Date.now();
}

/** createSession for a device sign-in, which the caps never refuse. */
async function newDeviceSession(db: D1Database, address: string, chain: Chain, via: 'namada' | 'keplr'): Promise<Session> {
  const r = await createSession(db, address, chain, via);
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

/**
 * End the sessions of `address` whose id (a prefix of the token hash) is `id`, and the pair codes they made.
 * `byApiKey`: the request came with an API key, which may end API keys only (never a signed-in or paired
 * device): otherwise a leaked key could end every session its owner signs in with, before the owner reaches
 * Revoke, and keep the owner out (the key is then ended from a device the key cannot touch).
 */
export async function revokeSession(db: D1Database, address: string, id: string, byApiKey = false): Promise<boolean | 'forbidden'> {
  if (!/^[0-9a-f]{8,64}$/.test(id)) return false;
  if (byApiKey) {
    const kinds = await db.prepare(`SELECT json_extract(value, '$.via') via FROM ${SESSIONS_OF} AND key LIKE ?`).bind(address, `session:${id}%`).all<{ via: string }>().catch(() => null);
    if (!kinds || (kinds.results || []).some((k) => k.via !== 'api')) return 'forbidden';
  }
  const r = await db.prepare(`DELETE FROM ${SESSIONS_OF} AND key LIKE ?`).bind(address, `session:${id}%`).run().catch(() => null);
  await db.prepare(`DELETE FROM kv WHERE ${keyPrefix('pair')} AND json_extract(value, '$.address') = ? AND json_extract(value, '$.by') LIKE ?`).bind(address, `${id}%`).run().catch(() => {});
  return Number(r?.meta?.changes ?? 0) > 0;
}

/** Every session, API key and pending pair code of the address, wherever it was made, plus the old per-address index row. */
export async function revokeAllSessions(db: D1Database, address: string) {
  // No catch on these two: DELETE /api/me answers success only once they are gone (a failure is a 500 to retry).
  await db.prepare(`DELETE FROM ${SESSIONS_OF}`).bind(address).run();
  await db.prepare(`DELETE FROM kv WHERE ${keyPrefix('pair')} AND json_extract(value, '$.address') = ?`).bind(address).run();
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
    // Deleted only when the row holds this very token. A hashed row has the same key shape (`session:` and 64 hex),
    // so a token hash read from a copy of the database, sent as a bearer, must not delete the live row it names.
    await db.prepare(`DELETE FROM kv WHERE key = ? AND json_extract(value, '$.token') = ?`).bind(`session:${token}`, token).run().catch(() => {});
    return null;
  }
  if (stored.expiresAt < Date.now()) return null;
  // Touch at most once per 10 minutes so the devices list can show "last used".
  if (!stored.lastUsedAt || Date.now() - stored.lastUsedAt > 600000) {
    stored.lastUsedAt = Date.now();
    touchSession(db, key, stored.lastUsedAt).catch(() => {});
  }
  return { ...stored, token } as Session;
}

/**
 * Set lastUsedAt on a session row that still exists. An update, never a write of the whole row read earlier: a
 * logout or revoke that deletes the row while this request runs must not have the row written back.
 */
export async function touchSession(db: D1Database, key: string, at: number) {
  await db.prepare(`UPDATE kv SET value = json_set(value, '$.lastUsedAt', ?), updated_at = ? WHERE key = ?`).bind(at, at, key).run();
}

export async function logout(db: D1Database, token: string) {
  // The row from before hashing goes only when it holds this token (see sessionFromRequest).
  await db.prepare(`DELETE FROM kv WHERE key = ? OR (key = ? AND json_extract(value, '$.token') = ?)`).bind(sessionKey(token), `session:${token}`, token).run().catch(() => {});
  await db.prepare(`DELETE FROM kv WHERE ${keyPrefix('pair')} AND json_extract(value, '$.by') = ?`).bind(tokenHash(token)).run().catch(() => {});
}

// ---------------------------------------------------------------- pairing
//
// A pair code is 8 hex characters (32 bits), so its row is `pair:<HMAC-SHA256 of the code>` under the SETTINGS_KEY
// secret, never the code: a plain hash in a copy of the database (an export, Time Travel, a console read) would be
// reversed by trying every code, and the code itself would be claimable by whoever reads the row in its 10 minutes.
// The secret is not in the database, so the row names no code. Without the secret no code is made or claimed.

/** The kv key of a pair code (uppercase, as made and as claimed). */
export function pairKey(secret: string, code: string): string {
  if (!secret) throw new Error('SETTINGS_KEY is not configured; run `wrangler secret put SETTINGS_KEY`');
  const enc = new TextEncoder();
  return `pair:${hex.encode(hmac(sha256, enc.encode(secret), enc.encode(`pair-code:${code}`)))}`;
}

export async function createPairCode(db: D1Database, s: Session, secret: string): Promise<{ code: string; expiresAt: number } | { error: string }> {
  // `by`: the hash of the pairing device's token (never the token), so the cap cannot end that device.
  const by = tokenHash(s.token);
  // A device shows one live code at a time: making a new one retires the ones it made before.
  await db.prepare(`DELETE FROM kv WHERE ${keyPrefix('pair')} AND json_extract(value, '$.by') = ?`).bind(by).run().catch(() => {});
  const expiresAt = Date.now() + PAIR_TTL;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = rand(4).toUpperCase(); // 8 hex chars, 10-minute life, single use
    // A plain insert, never a replace: a code another device is showing is not overwritten (a colliding draw is drawn again).
    const r = await db.prepare('INSERT OR IGNORE INTO kv (key,value,updated_at) VALUES (?,?,?)').bind(pairKey(secret, code), JSON.stringify({ address: s.address, chain: s.chain, expiresAt, by }), Date.now()).run().catch(() => null);
    if (Number(r?.meta?.changes ?? 0) === 1) return { code, expiresAt };
  }
  return { error: 'A code could not be made right now; try again.' };
}

export async function claimPairCode(db: D1Database, codeIn: string, secret: string): Promise<{ session?: Session; error?: string }> {
  const code = codeIn.trim().toUpperCase();
  if (!/^[0-9A-F]{8}$/.test(code)) return { error: 'code is 8 characters' };
  const key = pairKey(secret, code);
  const row = await kvGetJson<{ address: string; chain: Chain; expiresAt: number; by?: string }>(db, key);
  if (!row) return { error: 'code expired or already used' };
  // One use: only the claim whose delete removed the row goes on (two claims of one code cannot both pair).
  const r = await db.prepare('DELETE FROM kv WHERE key = ?').bind(key).run().catch(() => null);
  if (Number(r?.meta?.changes ?? 0) !== 1 || row.expiresAt < Date.now()) return { error: 'code expired or already used' };
  // A code lives only as long as the device that made it: once that device is signed out, revoked or the account
  // deleted, its codes pair nothing (they are deleted then too; this also catches a code made during the revoke).
  if (!row.by || !(await liveSession(db, row.by, row.address))) return { error: PARENT_ENDED };
  const s = await createSession(db, row.address, row.chain, 'pair', row.by, row.by);
  return 'error' in s ? { error: s.error } : { session: s };
}

/**
 * Cron: drop expired nonces, sessions and pair codes, the per-address session index rows no longer used, and any
 * session row from before tokens were hashed (migration 0005 deletes them at deploy; this catches any left), the
 * alert claims older than ALERT_CLAIM_KEEP_MS, and the test-post cooldowns older than WEBHOOK_TEST_KEEP_MS.
 */
/** Alert claim rows (sources/discord.ts) are kept this long; nothing alerts for a move older than a day (LATE_ALERT_MAX_AGE_MS). */
export const ALERT_CLAIM_KEEP_MS = 30 * 86400000;
/** A test-post cooldown row (`webhook_test:<address>`) matters for 30 s (api.ts WEBHOOK_TEST_COOLDOWN_MS); it is kept an hour. */
export const WEBHOOK_TEST_KEEP_MS = 3600000;
export async function sweepAuth(db: D1Database) {
  // Sessions and keys on migration 0009's expiry index (the expired rows only; the planner left alone prefers the key
  // range, every session row); nonces and pair codes live minutes, so their ranges stay small.
  const now = Date.now();
  await db.prepare(`DELETE FROM kv INDEXED BY kv_session_expiry WHERE ${keyPrefix('session')} AND CAST(json_extract(value, '$.expiresAt') AS INTEGER) < ?`).bind(now).run().catch(() => {});
  await db.prepare(`DELETE FROM kv WHERE (${keyPrefix('authnonce')} OR ${keyPrefix('pair')}) AND CAST(json_extract(value, '$.expiresAt') AS INTEGER) < ?`).bind(now).run().catch(() => {});
  await db.prepare(`DELETE FROM kv WHERE ${keyPrefix('sessions')}`).run().catch(() => {});
  await db.prepare(`DELETE FROM kv INDEXED BY kv_session_legacy WHERE ${LEGACY_SESSION_SQL}`).run().catch(() => {});
  // Plaintext alert settings from before sign-in existed (`webhook:user:<address>`): never read since 2026-10-21;
  // a row brought back by a restore of an old copy is deleted here.
  await db.prepare(`DELETE FROM kv WHERE ${keyPrefix('webhook:user')}`).run().catch(() => {});
  // Test-post cooldowns: one row per address that ever sent a test, which nothing deleted before.
  await db.prepare(`DELETE FROM kv WHERE ${keyPrefix('webhook_test')} AND updated_at < ?`).bind(now - WEBHOOK_TEST_KEEP_MS).run().catch(() => {});
  // Alert claims on migration 0011's claim-time index: the expired claims only. On the key range alone the delete read
  // every claim kept for 30 days on every tick (2,778 rows a run to delete none, 2026-10-22). A failure is logged, and
  // the claims it would have deleted are kept until the next tick deletes them (nothing else reads them).
  await db.prepare(`DELETE FROM kv INDEXED BY kv_alert_claim_time WHERE ${keyPrefix('alert')} AND updated_at < ?`).bind(now - ALERT_CLAIM_KEEP_MS).run()
    .catch((e) => console.error('sweep: old alert claims not deleted', e));
}

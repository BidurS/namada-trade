// The sign-in message, shared by the Worker (which issues it with a nonce and checks the signature over it) and the
// browser (which refuses to sign anything else): what a wallet is asked to sign holds the address and a one-time
// number, nothing more, and both sides enforce that.
export const NONCE_RE = /^[0-9a-f]{32}$/;
/** An address as sign-in accepts it: bech32 charset, bounded length (the Worker's chainOf is the same shape). */
export const LOGIN_ADDRESS_RE = /^(tnam1|osmo1)[02-9ac-hj-np-z]{38,80}$/;

export function loginMessage(address: string, nonce: string): string {
  return `NamadaTrade login\naddress: ${address}\nnonce: ${nonce}\n\nThis signature only proves you control this address. It is not a transaction and costs nothing.`;
}

/** Throws unless `message` is exactly the sign-in message for this address and nonce. */
export function assertLoginMessage(address: string, nonce: string, message: string): void {
  if (!LOGIN_ADDRESS_RE.test(address)) throw new Error('The sign-in message is not for a valid address; nothing was signed.');
  if (!NONCE_RE.test(nonce)) throw new Error('The sign-in message has no valid one-time number; nothing was signed.');
  if (message !== loginMessage(address, nonce)) throw new Error('The sign-in message is not the expected one; nothing was signed.');
}

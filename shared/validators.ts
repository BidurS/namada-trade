// The validators view: what the Worker (worker/src/validators.ts), the API reference (shared/api-catalog.ts), the
// served page (worker/src/seo.ts) and the screen (web/src/screens/seo/Validators.tsx) share. The bounds of the two
// routes, the plain words of a validator's state, how the chain's own text (a validator's name) is shown, and the
// sentences that state how the staked NAM is spread. Nothing here reads anything: imports are from nowhere.

/** The most rows of one day GET /api/validators answers with (about 250 validators have stake on a day). */
export const VALIDATORS_MAX = 500;
/** The most days GET /api/validators lists and GET /api/validators/history answers with. */
export const VALIDATOR_DAYS_MAX = 90;
/** The days GET /api/validators/history answers with when `days` is left out. */
export const VALIDATOR_HISTORY_DAYS = 30;
/** The rows the page shows before "Show all". */
export const VALIDATORS_SHOWN = 50;
/** The most characters of a validator's name the page prints. */
export const VALIDATOR_NAME_MAX = 40;

/** The source of the stakes: the first complete bond listing of a UTC day, read from a Namada node. */
export const VALIDATORS_SOURCE = 'Namada node (bond listing)';
/** The source of names, commission and state: the indexer's validator list, read once a day. */
export const VALIDATOR_NAMES_SOURCE = 'indexer.namada.net';

/**
 * A state as the API passes it on: the indexer's own word when it is one short word of letters (it writes
 * `consensus`, `inactive`, `jailed`, `belowCapacity`, `belowThreshold`, `unknown`; an underscore is taken too), else
 * null. The word is a node's text: anything else is not passed on.
 */
export const validatorStateOf = (raw: unknown): string | null => (typeof raw === 'string' && /^[A-Za-z][A-Za-z_]{0,31}$/.test(raw) ? raw : null);

/** What the page says when a state was not read, or is a word this table does not hold. */
export const STATE_NOT_RECORDED = 'Not recorded';
/**
 * A validator's state in plain words, by the indexer's word in lower case with nothing but its letters (so
 * `belowCapacity` and `below_capacity` are one entry). A word that is not here is shown as STATE_NOT_RECORDED, never
 * printed as it came; the indexer's own `unknown` is that too.
 */
export const VALIDATOR_STATE_WORDS: Readonly<Record<string, string>> = {
  consensus: 'In the active set',
  belowcapacity: 'Below the active set',
  belowthreshold: 'Under the minimum stake',
  inactive: 'Not active',
  jailed: 'Jailed',
};
export function validatorStateWords(state: string | null | undefined): string {
  if (typeof state !== 'string') return STATE_NOT_RECORDED;
  const key = state.toLowerCase().replace(/[^a-z]/g, '');
  return Object.prototype.hasOwnProperty.call(VALIDATOR_STATE_WORDS, key) ? VALIDATOR_STATE_WORDS[key] : STATE_NOT_RECORDED;
}

/** The key of a state word in VALIDATOR_STATE_WORDS: lower case, letters only. */
const stateKey = (state: string | null | undefined): string | null => (typeof state === 'string' ? state.toLowerCase().replace(/[^a-z]/g, '') : null);
/**
 * Is the validator in the active set, the validators that produce blocks (the indexer's `consensus`)? Only a state
 * that was read can say so: a validator with no state on record is in neither list.
 */
export const inActiveSet = (state: string | null | undefined): boolean => stateKey(state) === 'consensus';
/** Is it known to be outside the active set: a state this table holds that is not the active one? */
export const outsideActiveSet = (state: string | null | undefined): boolean => {
  const k = stateKey(state);
  return k != null && k !== 'consensus' && Object.prototype.hasOwnProperty.call(VALIDATOR_STATE_WORDS, k);
};

/** The page's choice of which validators to list (the `set` word in the address, so a list can be linked). */
export type ValidatorSet = 'all' | 'active' | 'not';
/** That choice from the address: anything but the two words is every validator. */
export const validatorSetOf = (raw: string | null | undefined): ValidatorSet => (raw === 'active' || raw === 'not' ? raw : 'all');

/**
 * How many of the day's validators are in the active set, how many are known to be outside it, how many have no
 * state on record, and the outside ones by their state in plain words, most first ("146 jailed", "76 not active").
 */
export function activeSetCounts(states: readonly (string | null | undefined)[]): { active: number; not: number; unrecorded: number; outside: { words: string; n: number }[] } {
  const by = new Map<string, number>();
  let active = 0, not = 0;
  for (const s of states) {
    if (inActiveSet(s)) active++;
    else if (outsideActiveSet(s)) { not++; const w = validatorStateWords(s); by.set(w, (by.get(w) ?? 0) + 1); }
  }
  const outside = [...by.entries()].map(([words, n]) => ({ words: words.toLowerCase(), n })).sort((a, b) => b.n - a.n || a.words.localeCompare(b.words));
  return { active, not, unrecorded: states.length - active - not, outside };
}

/** Characters that draw nothing or turn the text around: control characters, zero-width marks and direction marks. */
const UNSEEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g;
/**
 * A validator's name as the page prints it. The name is the chain's own text, typed by whoever runs the validator:
 * it is shown as text only, without the characters that draw nothing, on one line, and no longer than
 * VALIDATOR_NAME_MAX characters (the last one an ellipsis when it was cut). null when nothing is left to print: the
 * page then prints the address. It is never part of a URL, a class name or markup.
 */
export function validatorNameShown(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const clean = name.replace(UNSEEN, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const chars = [...clean];
  return chars.length > VALIDATOR_NAME_MAX ? `${chars.slice(0, VALIDATOR_NAME_MAX - 1).join('').trimEnd()}…` : clean;
}

/**
 * How the staked NAM is spread, as one sentence: the smallest number of validators, largest first, whose stake
 * together is more than the part named. A statement about the spread and nothing else. `count` is written by the
 * caller's own number format.
 */
export const spreadSentence = (n: number, count: string, part: 'a third' | 'two thirds'): string =>
  (n === 1 ? `The largest validator holds more than ${part} of the staked NAM` : `The ${count} largest validators hold more than ${part} of the staked NAM`);
/** The same, as the words after the number on the page ("7" then these words). */
export const spreadLabel = (n: number | null | undefined, part: 'a third' | 'two thirds'): string =>
  (n === 1 ? `largest validator holds more than ${part} of the staked NAM` : `largest validators hold more than ${part} of the staked NAM`);

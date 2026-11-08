// One short opening for the daily and weekly digest, written by a Claude model from figures the site has already
// computed. Shared by the Worker's call (worker/src/digest/opening.ts) and its tests.
//
// The model is given labelled facts and nothing else: no proposal text, no name, no address, nothing a person wrote,
// so nothing it reads can tell it what to do. It writes words around figures it copies. Every number in an opening
// must be one of the facts' values, and the opening must be short, plain and free of the words below; a second call
// reads it against the facts for what those checks cannot see (a figure beside the wrong label, a rise called a fall).
// An opening that fails is asked for once more with the reason; refused again, or on any failure, the digest goes out
// as it does without one. Nothing is written in its place.

import { NOT_SHOWN, SUMMARY_MODEL, SUMMARY_MODEL_NAME, VERIFY_SCHEMA, numbersIn } from './proposal-summary';

/** The model: the same as the proposal summaries'. */
export const OPENING_MODEL = SUMMARY_MODEL;

/** The longest opening shown. */
export const OPENING_MAX_SENTENCES = 2;
export const OPENING_MAX_WORDS = 40;
export const OPENING_MAX_CHARS = 320;

/** The words printed under an opening, in every channel that shows one. */
export const OPENING_MARK = `Written by ${SUMMARY_MODEL_NAME}, an AI model, from the figures below.`;

/** One thing the opening may say: a label in words (no digits in it) and a value as the digest prints it. */
export interface OpeningFact { label: string; value: string }

/** The system prompt. Stable text only (no dates, no figures). */
export const OPENING_SYSTEM = [
  'You write the opening of a daily or weekly digest about the NAM token for readers of namada.trade.',
  'Use only the labelled facts you are given. Write at most two plain sentences and at most 40 words, naming two or three of the facts in plain words.',
  'Describe the period and nothing else. Never predict, never say why something happened, and never compare figures in a way the facts do not state.',
  'Every number you write must be copied from a fact, digit for digit, with its commas and decimals. Never round, add, subtract or compute a percentage, and never write a number as a word.',
  'A change is written with its sign in the facts: say that it rose for a plus sign and fell for a minus sign.',
  'Refer to the period in words, as "the past day" or "the past week", and write no date or time.',
  'No opinion, no praise or criticism, no advice of any kind, no links, addresses or names of people, and no bold or other formatting.',
  'Never write MASP, PoS, IBC or RPC, even inside a name: write "shielded pool", "staking", "transfers between chains" and "node".',
  'If the facts give nothing to describe, return an empty opening.',
].join(' ');

/** The answer's shape (structured output): one string. */
export const OPENING_SCHEMA = {
  type: 'object',
  properties: { opening: { type: 'string' } },
  required: ['opening'],
  additionalProperties: false,
} as const;

/** The facts as the model reads them, one to a line. */
export const factsText = (facts: OpeningFact[]): string => facts.map((f) => `${f.label}: ${f.value}`).join('\n');

/** The user turn: the facts, and the reason when a first opening was refused. */
export function openingPrompt(facts: OpeningFact[], refused?: string): string {
  const base = `<facts>\n${factsText(facts)}\n</facts>`;
  return refused ? `${base}\n\nA first opening was refused: ${refused}. Write it again, shorter, keeping to every rule.` : base;
}

/** The second reading: whether the opening says only what the facts say. */
export const OPENING_READ_SYSTEM = [
  'You check the short opening of a digest against the labelled facts it was written from.',
  'Answer supported=false if the opening states anything the facts do not say, gives a figure to the wrong label, says a figure rose when its change is negative or fell when it is positive, says why something happened, predicts anything, or compares figures in a way the facts do not state. Different wording of the same meaning is fine.',
  'In problem, name the main issue in under 20 words, or leave it empty when supported is true.',
].join(' ');

/** The reading's answer has the same shape as the proposal summaries' reading. */
export const OPENING_READ_SCHEMA = VERIFY_SCHEMA;

export function openingReadPrompt(facts: OpeningFact[], opening: string): string {
  return `<facts>\n${factsText(facts)}\n</facts>\n\n<opening>\n${opening}\n</opening>`;
}

/** What an opening may not hold beyond the words the proposal summaries refuse. */
const OPENING_NOT_SHOWN: { why: string; re: RegExp }[] = [
  { why: 'a prediction or a cause', re: /\b(will|would|could|might|expect(s|ed)?|likely|forecast\w*|predict\w*|outlook|because|due to|driven by|as a result|thanks to|caused?|led to|amid|signals?|suggests?|indicates?)\b/i },
  { why: 'a number in words', re: /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|dozen|half|twice|double[ds]?|triple[ds]?|quarter)\b/i },
  { why: 'a number in words', re: /(?<!\d[\d,.]*\s?)\b(hundred|thousand|million|billion)\b/i },
  { why: 'a formatting mark', re: /[*~|#\\]/ },
];

const sentencesIn = (text: string): number => text.split(/[.!?]+(?:\s+|$)/).filter((s) => s.trim()).length;

/**
 * Whether an opening may be shown, and why not. Every number in it must be the value of a fact, compared by value:
 * "373,220" and "373,220.00" are one number, and a rounded or computed figure is none of the facts'. Only the values
 * are read, never the labels, and the labels hold no digits.
 */
export function checkOpening(opening: string, facts: OpeningFact[]): { ok: true; text: string } | { ok: false; reason: string } {
  const text = opening.replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, reason: 'the model returned no opening' };
  if (text.length > OPENING_MAX_CHARS) return { ok: false, reason: `longer than ${OPENING_MAX_CHARS} characters` };
  if (text.split(' ').length > OPENING_MAX_WORDS) return { ok: false, reason: `longer than ${OPENING_MAX_WORDS} words` };
  if (sentencesIn(text) > OPENING_MAX_SENTENCES) return { ok: false, reason: `more than ${OPENING_MAX_SENTENCES} sentences` };
  for (const w of [...NOT_SHOWN, ...OPENING_NOT_SHOWN]) {
    const m = w.re.exec(text);
    if (m) return { ok: false, reason: `${w.why} ("${m[0]}")` };
  }
  const have = new Set(numbersIn(facts.map((f) => f.value).join('\n')));
  for (const n of numbersIn(text)) {
    if (!have.has(n)) return { ok: false, reason: `the number ${n} is not among the figures` };
  }
  return { ok: true, text };
}

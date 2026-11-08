// The Ask chat's flag, limits, answer shape and every word it shows. Client-safe: no guide text is imported here
// (shared/ask.ts holds the prompt and the checks, and only the Worker loads it). The rules of shared/copy.ts apply: no figure
// typed, plain words first, describe and never advise.

/**
 * Whether the chat exists on the site: false hides every part of it and makes /api/ask answer unavailable. It is
 * reviewed with a real key first and turned on in a release of its own.
 */
export const ASK_SHOWN = false;

/** A question is at most this many characters. */
export const ASK_QUESTION_MAX = 300;
/** The character count appears from this many characters typed. */
export const ASK_COUNT_FROM = 260;
/** Earlier exchanges sent with a question at most (and the most the server reads). */
export const ASK_HISTORY_MAX = 3;
/** An answer longer than this is not shown. */
export const ASK_ANSWER_MAX_CHARS = 700;
export const ASK_ANSWER_MAX_WORDS = 120;
/** Follow-up questions offered under an answer at most. */
export const ASK_FOLLOW_UPS_MAX = 2;

export type AskStatus = 'answered' | 'refused' | 'not_covered' | 'failed' | 'resting' | 'invalid' | 'unavailable';

export interface AskPageLink { id: string; label: string; path: string }
/** The source and time of one figure an answer states. */
export interface AskStamp { label: string; source: string; at: number; old: boolean }
/** One earlier question, as the browser sends it back: held in its memory only. Never an earlier answer: the server could not tell a real one from one a caller wrote. */
export interface AskTurn { q: string }

export interface AskAnswer {
  status: AskStatus;
  /** The checked answer, or one fixed sentence. Plain text, paragraphs split by a blank line. */
  text: string;
  pages: AskPageLink[];
  stamps: AskStamp[];
  followUps: string[];
  /** On an answered reply: the model as a reader sees it named, and when it wrote the answer (ms). */
  model?: string;
  at?: number;
}

/** GET /api/ask: whether the chat is open, resting at a cap, or not there at all. */
export interface AskState { state: 'open' | 'resting' | 'unavailable'; text: string }

/** Questions the guides answer word for word (test/ask.test.ts holds each to a guide's heading or question). */
export const ASK_STARTERS = [
  'What is Namada, and what is NAM used for?',
  'How do you stake NAM, claim rewards and unstake?',
  'Can a viewing key spend my funds?',
  'Who decides the inflation rates?',
];

export const ASK_WORDS = {
  line: 'Ask this site about Namada',
  lineThread: 'Back to your questions',
  title: 'Ask this site',
  close: 'Close',
  label: 'Your question',
  placeholder: 'Ask about Namada or this site',
  send: 'Send question',
  emptyHead: 'What would you like to know?',
  emptyLead: 'Answers come only from this site’s guides and current figures, with links to the pages they used.',
  starters: 'Questions to start with',
  waiting: 'Reading the site’s pages',
  aiLabel: (model: string) => `Written by ${model}, an AI model, from this site’s pages`,
  pagesLabel: 'Pages used',
  stampsLabel: 'Where the figures come from',
  old: 'old',
  followUps: 'Ask next',
  copy: 'Copy answer',
  copied: 'Copied',
  retry: 'Try again',
  newAnswer: 'New answer below',
  /** One sentence for a topic this site leaves alone, decided without calling the model. */
  refused: 'This site leaves that alone: it does not predict prices, advise buying or selling, say who is behind a wallet or shielded funds, or describe how the network or this site could be misused.',
  notCovered: 'This site’s pages do not cover that.',
  failed: 'That could not be answered from this site’s pages just now.',
  invalid: 'That question could not be read; please write it again in a few plain words.',
  unavailable: 'The Ask chat is not available right now.',
  restingDay: 'The Ask chat is resting until tomorrow: it has had all the questions it can take today.',
  restingMonth: 'The Ask chat is resting until next month: it has used all it can this month.',
  restingAddress: 'The Ask chat has answered all the questions it takes from one connection today. It opens again tomorrow.',
  rate: 'That was a lot of questions at once; please wait a minute and try again.',
  offline: 'You seem to be offline; your question is still here to send again.',
  /** How many characters are left, or how many are too many. */
  count: (left: number) => (left >= 0 ? `${left} characters left` : `${-left} characters too long`),
} as const;

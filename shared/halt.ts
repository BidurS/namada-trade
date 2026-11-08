// The Namada network halt of 2 November 2026: the Namada team's public announcements, shown on every page, the site's
// alerts paused, and one notice that says so (owner, 2026-11-02). What the team said is repeated in our words: Adrian
// Brink's posts in the Namada Discord, 2 November 2026 (23:05 UTC) and 6 November 2026 (16:19 UTC; the bar and the
// notice follow that update, owner 2026-11-06). Nothing is guessed about the halt's cause.
//
// While HALT.on, every page shows the halt bar under the header (web/src/app/HaltBanner.tsx). The Worker's pause of
// the alerts is a switch of its own, ALERTS_PAUSED in wrangler.jsonc (sources/discord.ts sendsAlerts), so the tests'
// Workers still send; the one notice that says the alerts are paused is worker/src/halt-notice.ts. When the network is
// back, a release turns HALT.on off and removes ALERTS_PAUSED.
export const HALT = {
  on: true,
  /** Names this halt: the Worker's ALERTS_PAUSED holds it, and the notice is claimed once per place under it. */
  id: 'namada-halt-2026-11-02',
  title: 'Namada is halted',
  /** What the Namada team said, and who said it where. */
  said: 'The Namada team says it has found the cause of the 2 November halt, is working on a fix and hopes to be ready to restart the network in the week of 9 November.',
  source: 'Adrian Brink in the Namada Discord, 6 November 2026',
  /** What it means on this site. */
  here: 'No new Namada data arrives while the network is halted; Osmosis prices and trades keep updating. Alerts on Discord, X and Telegram are paused until the network is back.',
} as const;

/** The network status as /api/overview and the server-rendered pages state it: the halt while HALT.on, else null. */
export interface NetworkStatus { halted: true; id: string; title: string; said: string; source: string; here: string }
export const networkStatus = (): NetworkStatus | null =>
  HALT.on ? { halted: true, id: HALT.id, title: HALT.title, said: HALT.said, source: HALT.source, here: HALT.here } : null;

/**
 * Added to the source of the three figures the server-rendered pages read from Namada nodes (all NAM, staked, in the
 * shielded pool; seo.ts facts) while the network is halted, so a reader without JavaScript, who never sees the halt
 * bar, still learns why a Namada stamp is days old: "(Namada nodes, the chain's state at the halt, 2026-11-03 22:53
 * UTC)". A statement about the state, not about the read's time: the nodes served the halted state for a day after
 * the last block, and the cron stamped those readings with its own time.
 */
export const HALT_FACT_SOURCE = "the chain's state at the halt";

/**
 * The one notice posted on Discord, X and Telegram when the alerts pause (worker/src/halt-notice.ts): plain words, no
 * link and no mention, under X's 280 weighted characters (test/halt.test.ts). Each place is claimed under HALT.id,
 * whatever the words, so a place that already has it is never sent it again; a place reached later (a Telegram chat
 * linked after 3 November) is sent these words, so they name no week and hold on any day until the network is back.
 */
export const HALT_NOTICE = 'Namada is halted. The Namada team says it has found the cause of the 2 November halt and is working on a fix (Adrian Brink, Namada Discord, 6 November). NamadaTrade alerts are paused until the network is back.';

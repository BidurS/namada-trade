// The Namada network halt of 2 November 2026: the Namada team's public announcement, shown on every page, the site's
// alerts paused, and one notice that says so (owner, 2026-11-02). What the team said is repeated in our words: Adrian
// Brink's post in the announcements channel of the Namada Discord, 2 November 2026 (23:05 UTC). Nothing is guessed
// about the halt's cause.
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
  said: 'Namada’s validators halted the network to look into a potential bug in the circuits. The Namada team says more updates will come later this week.',
  source: 'Adrian Brink in the Namada Discord, 2 November 2026',
  /** What it means on this site. */
  here: 'No new Namada data arrives while the network is halted; Osmosis prices and trades keep updating. Alerts on Discord, X and Telegram are paused until the network is back.',
} as const;

/**
 * The one notice posted on Discord, X and Telegram when the alerts pause (worker/src/halt-notice.ts): plain words, no
 * link and no mention, under X's 280 weighted characters (test/halt.test.ts).
 */
export const HALT_NOTICE = 'Namada is halted. Namada’s validators halted the network to look into a potential bug in the circuits, and the team says more updates will come later this week (Adrian Brink, Namada Discord). NamadaTrade alerts are paused until the network is back.';

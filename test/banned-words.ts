// The words no alert, hit or Discord message may carry (docs/design/system.md 5.4): the copy lint's banned words, and
// three expert words a rule's own text once used ("unbond", "unshield", "arbitrage") and the "≥" sign. One list, which
// test/alerts.test.ts and test/discord-words.test.ts import.
export const BANNED = /\b(SQS|IBC|DEX|PoS|MASP|ABCI|RPC|cron|webhook|npm|D[1-7])\b|unbond|unshield|arbitrage|≥/i;

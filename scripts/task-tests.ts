/**
 * Phase 4: timed task tests. Generates six questions with answers computed from D1 and live pool
 * quotes, for running with traders on the old UI, the new UI, and the Osmosis app + an explorer.
 *
 *   node --experimental-strip-types scripts/task-tests.ts   -> docs/task-tests.md
 *
 * Answers are stamped with the time they were computed; re-run before each session.
 */
import { writeFileSync } from 'node:fs';
import { d1, iso } from './lib.ts';

const now = Date.now();
const D = 86400000;

const spot = d1<{ value: number; ts: number }>(`SELECT value, ts FROM metrics WHERE key='price.usd' ORDER BY ts DESC LIMIT 1`)[0];
const onDeck = d1<{ addr: string; nam: number; first_ts: number }>(`
  SELECT to_addr addr, SUM(amount_num) nam, MIN(ts) first_ts FROM flows WHERE chain='osmosis' AND kind='ibc_in' AND ts >= ${now - 7 * D}
  AND to_addr NOT IN ('osmo1yl6hdjhmkf37639730gffanpzndzdpmhxy9ep3') GROUP BY to_addr ORDER BY nam DESC LIMIT 40`);
// Only real address shapes reach the SQL text: a bridge receiver is text the sender chose (worker/src/parse/osmosis.ts).
const onDeckAddrs = onDeck.filter((o) => /^[a-z0-9]+$/.test(o.addr));
const sellsAfter = onDeckAddrs.length
  ? d1<{ addr: string; nam: number }>(`SELECT from_addr addr, SUM(amount_num) nam FROM flows WHERE chain='osmosis' AND kind='sell' AND from_addr IN (${onDeckAddrs.map((o) => `'${o.addr}'`).join(',')}) AND ts >= ${Math.min(...onDeckAddrs.map((o) => o.first_ts))} AND (meta IS NULL OR meta NOT LIKE '%"arb":true%') GROUP BY from_addr`)
  : [];
const topSeller = d1<{ addr: string; nam: number; n: number }>(`SELECT from_addr addr, SUM(amount_num) nam, COUNT(*) n FROM flows WHERE chain='osmosis' AND kind='sell' AND ts >= ${now - 7 * D} AND (meta IS NULL OR meta NOT LIKE '%"arb":true%') GROUP BY from_addr ORDER BY nam DESC LIMIT 1`)[0];
const biggestWithdraw = d1<{ to_addr: string; amount_num: number; ts: number }>(`SELECT to_addr, amount_num, ts FROM flows WHERE chain='namada' AND kind='withdraw' AND ts >= ${now - 30 * D} ORDER BY amount_num DESC LIMIT 1`)[0];
const masp = d1<{ value: number }>(`SELECT value FROM metrics WHERE key='supply.masp_shielded' ORDER BY ts DESC LIMIT 1`)[0];
const total = d1<{ value: number }>(`SELECT value FROM metrics WHERE key='supply.total' ORDER BY ts DESC LIMIT 1`)[0];
const unshield = d1<{ to_addr: string; amount_num: number; ts: number }>(`SELECT to_addr, amount_num, ts FROM flows WHERE chain='namada' AND kind='unshield' AND ts >= ${now - 30 * D} AND to_addr NOT LIKE 'tnam1%qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq%' ORDER BY amount_num DESC LIMIT 1`)[0];

async function quote(amount: number) {
  const r = await fetch(`https://sqs.osmosis.zone/router/quote?tokenIn=${amount * 1e6}ibc%2FC7110DEC66869DAE9BE9C3C60F4B5313B16A2204AE020C3B0527DD6B322386A3&tokenOutDenom=ibc%2F498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4`).then((x) => x.json()).catch(() => null);
  if (!r?.amount_out) return null;
  const out = Number(r.amount_out) / 1e6;
  return { out, eff: out / amount, impact: Math.abs(((out / amount) / spot.value - 1) * 100) };
}

const q25 = await quote(25000);
const onDeckRemaining = onDeck.map((o) => ({ ...o, remaining: o.nam - (sellsAfter.find((s) => s.addr === o.addr)?.nam ?? 0) })).sort((a, b) => b.remaining - a.remaining)[0];

const tasks = [
  { q: 'Sell 25,000 NAM for USDC right now. How much USDC do you get, and what is the price impact?', a: q25 ? `${q25.out.toFixed(2)} USDC at $${q25.eff.toFixed(6)} (impact ${q25.impact.toFixed(2)}% vs. SQS spot $${spot.value.toFixed(6)})` : 'router unavailable at generation time', how: 'Osmosis SQS router quote, impact vs. SQS mid' },
  { q: 'Which single address has the most NAM bridged to Osmosis in the last 7 days that it has not yet sold? How much?', a: onDeckRemaining ? `${onDeckRemaining.addr} · ${Math.round(onDeckRemaining.remaining).toLocaleString()} NAM remaining of ${Math.round(onDeckRemaining.nam).toLocaleString()} bridged` : 'no IBC inflows in the last 7d', how: 'flows: ibc_in by receiver minus sells after first arrival' },
  { q: 'Who sold the most NAM on Osmosis in the last 7 days (excluding arbitrage)? How much, in how many trades?', a: topSeller ? `${topSeller.addr} · ${Math.round(topSeller.nam).toLocaleString()} NAM in ${topSeller.n} sells` : 'no sells in 7d', how: 'flows: sells by from_addr, meta.arb excluded' },
  { q: 'What was the largest withdrawal from staking in the last 30 days, to which address, and when?', a: biggestWithdraw ? `${Math.round(biggestWithdraw.amount_num).toLocaleString()} NAM to ${biggestWithdraw.to_addr} at ${iso(biggestWithdraw.ts)} UTC` : 'none', how: 'flows: kind=withdraw from the PoS address' },
  { q: 'What share of all NAM is currently inside the shielded pool?', a: masp && total ? `${((masp.value / total.value) * 100).toFixed(2)}% (${Math.round(masp.value).toLocaleString()} of ${Math.round(total.value).toLocaleString()} NAM)` : 'unknown', how: 'MASP balance / minted supply, both via ABCI' },
  { q: 'What is the largest unshield to a user address in the last 30 days?', a: unshield ? `${Math.round(unshield.amount_num).toLocaleString()} NAM to ${unshield.to_addr} at ${iso(unshield.ts)} UTC` : 'none', how: 'flows: kind=unshield, module accounts excluded' },
];

let md = `# Timed task tests\n\nGenerated ${iso(now)} UTC. Answers computed from D1 and the Osmosis router at that time; re-run the script before a session so the answers are current.\n\n`;
md += `## Protocol\n\n1. One trader, one screen, a stopwatch. Three conditions, order randomised per trader: (A) old NamadaTrade UI (git tag \`ui-v1\`), (B) new UI, (C) app.osmosis.zone + namada.valopers.com / mintscan.\n2. Read the question aloud; start the clock; stop when the trader states an answer. Record time and whether the answer matches within tolerance (±2% for amounts, exact for addresses).\n3. Afterwards ask: "what did you look at first?" and "what would you have wanted to see?"\n\nScore = median time and accuracy per condition. The new UI has to win on both or the redesign has failed.\n\n`;
md += `## Questions and reference answers\n\n`;
tasks.forEach((t, i) => { md += `### ${i + 1}. ${t.q}\n\n- **Answer:** ${t.a}\n- **Derived from:** ${t.how}\n\n`; });
md += `## Record\n\n| trader | condition | q1 | q2 | q3 | q4 | q5 | q6 | notes |\n|---|---|---|---|---|---|---|---|---|\n|  |  |  |  |  |  |  |  |  |\n`;
writeFileSync('docs/task-tests.md', md);
console.log(md);

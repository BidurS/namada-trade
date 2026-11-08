// Prints the plain summaries the Worker would write for the latest governance proposals, and whether each passes the
// checks (shared/proposal-summary.ts). Writes nothing anywhere; each proposal is two to four short calls to the model (well under a cent).
//
// usage: ANTHROPIC_API_KEY=… npx tsx scripts/preview-summaries.ts [how many, default 5]
import { proposalSourceText } from '../shared/proposal-summary';
import { anthropicSummarizer, anthropicVerifier, readAllProposals, summarizeChecked } from '../worker/src/proposal-summaries';

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error('Set ANTHROPIC_API_KEY first (an API key from platform.claude.com, Settings, API keys).');
  process.exit(1);
}
const n = Math.max(1, Math.min(43, Number(process.argv[2] ?? 5) || 5));
const summarize = anthropicSummarizer(key);
const verify = anthropicVerifier(key);
const all = (await readAllProposals()).sort((a, b) => b.id - a.id).slice(0, n);
let inT = 0, outT = 0;
for (const p of all) {
  const source = proposalSourceText(p.content);
  try {
    const r = await summarizeChecked(summarize, verify, p.id, p.type, source);
    inT += r.inTokens; outT += r.outTokens;
    const c = r.check;
    console.log(`\n#${p.id} ${String(p.content.title ?? '').slice(0, 80)}`);
    console.log(c.ok ? `  SHOWN: ${c.text}` : `  NOT SHOWN (${c.reason}): ${r.summary}`);
  } catch (e) {
    console.log(`\n#${p.id}: the call failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log(`\n${all.length} proposals, ${inT} tokens in, ${outT} out: about $${((inT * 0.1 + outT * 0.5) / 1e6).toFixed(4)}`);

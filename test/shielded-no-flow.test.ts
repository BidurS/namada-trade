// The Shielded tab's share of the week's moves that stayed in. The server answers null when no NAM moved in or out
// in the seven days: there is nothing to take a share of. That is a reading with its own reason, and the page says
// it as that. "This server does not send this figure yet" is kept for an answer that does not carry the field at
// all (an older server), which is a different fact.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../web/src/screens/shielded/index.tsx', import.meta.url), 'utf8');

describe('the share that stayed shielded, when nothing moved', () => {
  it('says that nothing moved, in the week asked about', () => {
    expect(src).toContain("const NO_FLOW_NOW = 'No NAM moved in or out of the shielded set in the last 7 days, so there is no share to state.';");
    expect(src).toContain("const NO_FLOW_THEN = 'No NAM moved in or out of the shielded set in those 7 days, so there is no share to state.';");
  });

  it('only when the server sent null and both sides of the week are zero; a field not sent stays "not sent"', () => {
    expect(src).toContain('const noFlow = data.shields7d === 0 && data.unshields7d === 0;');
    expect(src).toContain(': stayed === null && noFlow');
    expect(src).toContain("? { ...cov, status: 'missing', note: rewound ? NO_FLOW_THEN : NO_FLOW_NOW }");
    expect(src).toContain(": notSent(cov, 'this figure', rewound);");
  });
});

/**
 * The statements of a .sql file as SQLite reads them, for scripts/d1-apply.ts. A statement ends at a `;` outside a
 * quoted string ('…'), a quoted name ("…", `…`, […]) and a comment. Comments outside quotes are dropped (a `--`
 * comment runs to the next \n, as in SQLite, and a block comment becomes one space), and every quoted string is kept
 * byte for byte, whatever line breaks or comment markers it holds. A file whose quote or block comment never closes,
 * or that creates a trigger (its body holds `;`), is refused rather than sent in pieces. So is a file that holds a NUL
 * (U+0000) anywhere: SQLite ends its input at a NUL, so it would read a string that holds one as never closing, and
 * a command line cannot carry one.
 */
export function sqlStatements(text: string): string[] {
  const nul = text.indexOf('\u0000');
  if (nul >= 0) {
    const line = text.slice(0, nul).split('\n').length;
    throw new Error(`a NUL (U+0000) at offset ${nul} (line ${line}): SQLite would end the text there`);
  }
  const out: string[] = [];
  let parts: string[] = [];
  let from = 0;
  const push = (end: number) => {
    parts.push(text.slice(from, end));
    const s = parts.join('').trim();
    parts = [];
    if (!s) return;
    if (/^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(s)) {
      throw new Error(`statement ${out.length + 1} creates a trigger: apply it with \`wrangler d1 migrations apply\``);
    }
    out.push(s);
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      for (;;) {
        const k = text.indexOf(close, j);
        if (k < 0) throw new Error(`statement ${out.length + 1}: a ${c} quote opened at offset ${i} never closes`);
        if (close !== ']' && text[k + 1] === close) { j = k + 2; continue; }
        j = k + 1;
        break;
      }
      i = j;
    } else if (c === '-' && text[i + 1] === '-') {
      parts.push(text.slice(from, i));
      const k = text.indexOf('\n', i + 2);
      i = from = k < 0 ? text.length : k;
    } else if (c === '/' && text[i + 1] === '*') {
      parts.push(text.slice(from, i), ' ');
      const k = text.indexOf('*/', i + 2);
      if (k < 0) throw new Error(`statement ${out.length + 1}: a block comment opened at offset ${i} never closes`);
      i = from = k + 2;
    } else if (c === ';') {
      push(i);
      i = from = i + 1;
    } else {
      i++;
    }
  }
  push(text.length);
  return out;
}

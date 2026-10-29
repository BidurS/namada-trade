// Gate G5, copy lint over source: every visible string in web/src/**/*.tsx (JSX text, string and
// template literals) is checked for the banned words of system.md 5.4:
//   SQS, IBC, DEX, PoS, MASP, ABCI, RPC, cron, webhook, npm, bare D1 to D7, "Loading…".
// Allowed places (the allowlist): lib/glossary.ts (not a .tsx file), anything inside a
// <details className="how …"> ("How it is computed"), the Settings "For developers" panel
// (function DevelopersPanel), and values that are not visible text: imports, object keys, the
// `source` field of a stamp (shown in plain words, raw only under "How it is computed"),
// className / data-* / href / id / key / role and other non-text attributes, and strings used only
// as regex or comparison operands.
//
// The rendered-text half of the gate runs in Playwright (web/e2e/gates.spec.ts, BANNED below).
//
// The same run also checks N2 (no figure typed into JSX); see numLintFile below.
//
// usage: node --experimental-strip-types scripts/copy-lint.ts   (exit 1 on any finding)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'web', 'src');

/** The banned words. Acronyms are matched case-sensitively as words; cron, webhook, npm in any case. */
export const BANNED: { word: string; re: RegExp }[] = [
  { word: 'SQS', re: /\bSQS\b/ },
  { word: 'IBC', re: /\bIBC\b/ },
  { word: 'DEX', re: /\bDEX\b/ },
  { word: 'PoS', re: /\bPoS\b/ },
  { word: 'MASP', re: /\bMASP\b/ },
  { word: 'ABCI', re: /\bABCI\b/ },
  { word: 'RPC', re: /\bRPC\b/ },
  { word: 'cron', re: /\bcron\b/i },
  { word: 'webhook', re: /\bwebhooks?\b/i },
  { word: 'npm', re: /\bnpm\b/i },
  { word: 'D1 to D7', re: /\bD[1-7]\b/ },
  { word: 'Loading…', re: /\bLoading(…|\.\.\.)/i },
];

/** JSX attributes whose values are read by people (or screen readers). Everything else is not text. */
const TEXT_ATTRS = new Set(['aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'title', 'placeholder', 'alt', 'label', 'lead', 'text', 'sub', 'hint', 'note', 'caption', 'name', 'sourceLabel', 'oldSentence', 'show', 'children', 'tag']);
/** Object keys whose string values are not visible text. */
const NON_TEXT_KEYS = new Set(['source', 'className', 'key', 'id', 'kind', 'href', 'to', 'path', 'value', 'icon', 'name', 'type', 'variant', 'tone', 'size', 'mode', 'side', 'status', 'chain', 'ruleId', 'by', 'look', 'cat', 'tab', 'view', 'role', 'method', 'contentType']);

function files(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const attrName = (a: ts.JsxAttribute) => (ts.isIdentifier(a.name) ? a.name.text : a.name.getText());

/** Inside an allowlisted subtree: <details className="how…">, or the DevelopersPanel function. */
function allowlisted(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p)) && p.name && ts.isIdentifier(p.name) && p.name.text === 'DevelopersPanel') return true;
    if (ts.isJsxElement(p)) {
      const open = p.openingElement;
      const tag = open.tagName.getText();
      if (tag === 'details') {
        const cls = open.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && attrName(a) === 'className');
        const v = cls?.initializer && ts.isStringLiteral(cls.initializer) ? cls.initializer.text : '';
        if (/\bhow\b/.test(v)) return true;
      }
    }
  }
  return false;
}

/** Is this literal visible text (as opposed to a key, a class name, an import, an operand)? */
function isText(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isImportTypeNode(p) || ts.isExternalModuleReference(p)) return false;
  if (ts.isLiteralTypeNode(p)) return false;
  if (ts.isPropertyAssignment(p) && p.name === node) return false;
  if (ts.isPropertyAssignment(p) && p.initializer === node) {
    const k = p.name.getText().replace(/['"]/g, '');
    if (NON_TEXT_KEYS.has(k)) return false;
  }
  if (ts.isElementAccessExpression(p)) return false;
  if (ts.isCaseClause(p)) return false;
  if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return false;
  if (ts.isCallExpression(p)) {
    const callee = p.expression.getText();
    if (/(^|\.)(includes|startsWith|endsWith|test|match|replace|split|querySelector|querySelectorAll|getElementById|setAttribute|getAttribute|addEventListener|removeEventListener|matchMedia|getItem|setItem|removeItem|get|set|has|delete|fetch|import|require|toLocaleString|padStart|join)$/.test(callee)) return false;
    if (/^(get|meJson|authFetch|useLoad|useFetch|lazy|createContext|Symbol)$/.test(callee)) return false;
  }
  if (ts.isJsxAttribute(p)) return TEXT_ATTRS.has(attrName(p));
  if (ts.isJsxExpression(p) && p.parent && ts.isJsxAttribute(p.parent)) return TEXT_ATTRS.has(attrName(p.parent));
  return true;
}

export interface Finding { file: string; line: number; word: string; text: string }

export function lintFile(file: string): Finding[] {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Finding[] = [];
  const check = (node: ts.Node, text: string) => {
    if (!text.trim() || allowlisted(node) || !isText(node)) return;
    for (const b of BANNED) {
      if (b.re.test(text)) {
        out.push({ file: relative(ROOT, file), line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, word: b.word, text: text.trim().slice(0, 80) });
      }
    }
  };
  const walk = (node: ts.Node) => {
    if (ts.isJsxText(node)) check(node, node.text);
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node, node.text);
    else if (ts.isTemplateExpression(node)) {
      check(node, [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' '));
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The same banned words in the Discord alerts' text (docs/design/system.md 5.4: an alert is copy too): every string
// and template literal inside the message builders of worker/src/sources/discord.ts and in shared/flow-words.ts,
// but import paths, property names, case labels, comparison operands and the patterns of string methods. The
// rendered half is test/discord-words.test.ts, over the cards built from real rows.
// ---------------------------------------------------------------------------------------------
/** The files whose literals are Discord message text, each with the functions and constants that build it (null: the whole file). */
export const MESSAGE_SOURCES: { file: string; names: Set<string> | null }[] = [
  { file: 'shared/flow-words.ts', names: null },
  {
    file: 'worker/src/sources/discord.ts',
    names: new Set(['sideWords', 'crossingSide', 'PROTOCOL_WORDS', 'coinWords', 'settleField', 'worthWords', 'runClauses', 'moveCard', 'forumCard', 'govCard', 'settingsFields', 'CARD_WORDS', 'testBody', 'noticeBody', 'COLOUR', 'SENDER', 'FILES_REFUSED_NOTE']),
  },
  // the Telegram bot's own messages (the alerts themselves are the cards above)
  { file: 'worker/src/sources/telegram.ts', names: new Set(['connectedMessage', 'testMessages', 'cardMessage', 'settingsButton']) },
  { file: 'worker/src/telegram-bot.ts', names: new Set(['WORDS', 'settingsButton', 'status']) },
  { file: 'worker/src/sources/x.ts', names: new Set(['recapText', 'cardText']) },
];

/** Is this literal inside one of `names` (a function declaration or a top-level constant)? */
function insideNamed(node: ts.Node, names: Set<string> | null): boolean {
  if (!names) return true;
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p)) && p.name && ts.isIdentifier(p.name) && names.has(p.name.text)) return true;
  }
  return false;
}

/** Is this literal message text (not an import, a key, a case label, an operand or a pattern)? */
function isMessageText(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p)) return false;
  if (ts.isPropertyAssignment(p) && p.name === node) return false;
  if (ts.isComputedPropertyName(p) || ts.isElementAccessExpression(p) || ts.isCaseClause(p)) return false;
  if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return false;
  if (ts.isCallExpression(p) && /(^|\.)(includes|startsWith|endsWith|test|match|replace|split|padStart|join|toLocaleString|prepare|get|has)$/.test(p.expression.getText())) return false;
  return true;
}

export function lintMessageFile(file: string, names: Set<string> | null): Finding[] {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Finding[] = [];
  const check = (node: ts.Node, text: string) => {
    if (!text.trim() || !insideNamed(node, names) || !isMessageText(node)) return;
    for (const b of BANNED) {
      if (b.re.test(text)) out.push({ file: relative(ROOT, file), line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, word: b.word, text: text.trim().slice(0, 80) });
    }
  };
  const walk = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node, node.text);
    else if (ts.isTemplateExpression(node)) check(node, [node.head.text, ...node.templateSpans.map((x) => x.literal.text)].join(' '));
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Gate G10 N2, the source half: no figure is typed into JSX. A digit in JSX text (or in a string
// rendered as a JSX child) is a finding unless it is part of a definition the copy states: a time
// window ("24 h", "last 30 days", "48 h after unlocking", "30-day"), the top-ten definition the
// holders request uses, the 1% and 3% safe-size definitions, the watchlist limit the server sets,
// or a structural label (step numbers, the supply bar's 0 to 100% scale). Figures come from API
// fields, derive() or the dated static block (web/src/generated, not .tsx). ui/Demo.tsx is the
// dev-only /__ui page and is not shipped.
// ---------------------------------------------------------------------------------------------
const DEFINITIONS: RegExp[] = [
  /\b\d+(-day\b|\s?(h|hours?|days?|min)\b)/g,
  /\b(top|The) 10\b/g,
  /\b[13]% or less\b/g,
  /\bup to 100\b/g,
];
/** Parents whose bare number is a label, not a figure: step numbers and the bar's scale. */
const STRUCTURAL = /\b(step__i|seo-step__i|supply__scale)\b/;
const NUM_EXEMPT_FILES = new Set(['web/src/ui/Demo.tsx']);

export interface NumFinding { file: string; line: number; text: string }

function classOf(el: ts.JsxElement | undefined): string {
  if (!el) return '';
  const a = el.openingElement.attributes.properties.find((x): x is ts.JsxAttribute => ts.isJsxAttribute(x) && attrName(x) === 'className');
  return a?.initializer && ts.isStringLiteral(a.initializer) ? a.initializer.text : '';
}

export function numLintFile(file: string): NumFinding[] {
  if (NUM_EXEMPT_FILES.has(relative(ROOT, file))) return [];
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: NumFinding[] = [];
  const check = (node: ts.Node, text: string) => {
    if (!/\d/.test(text)) return;
    let rest = text;
    for (const re of DEFINITIONS) rest = rest.replace(re, '');
    if (!/\d/.test(rest)) return;
    let el: ts.Node | undefined = node.parent;
    while (el && !ts.isJsxElement(el)) el = el.parent;
    for (let p: ts.Node | undefined = el; p; p = p.parent) if (ts.isJsxElement(p) && STRUCTURAL.test(classOf(p))) return;
    out.push({ file: relative(ROOT, file), line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: text.trim().slice(0, 80) });
  };
  const walk = (node: ts.Node) => {
    if (ts.isJsxText(node)) check(node, node.text);
    else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      const e = node.expression;
      if (ts.isNumericLiteral(e)) check(node, e.text);
      else if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) check(node, e.text);
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const list = files(SRC);
  const all = list.flatMap(lintFile);
  for (const f of all) console.log(`${f.file}:${f.line}  ${f.word}  "${f.text}"`);
  console.log(JSON.stringify({ gate: 'G5 copy lint (source)', files: list.length, findings: all.length }));
  const msgs = MESSAGE_SOURCES.flatMap((m) => lintMessageFile(join(ROOT, m.file), m.names));
  for (const f of msgs) console.log(`${f.file}:${f.line}  ${f.word}  "${f.text}"`);
  console.log(JSON.stringify({ gate: 'G5 copy lint (Discord messages)', files: MESSAGE_SOURCES.length, findings: msgs.length }));
  const nums = list.flatMap(numLintFile);
  for (const f of nums) console.log(`${f.file}:${f.line}  typed number  "${f.text}"`);
  console.log(JSON.stringify({ gate: 'G10 N2 numeric literals in JSX (source)', files: list.length, findings: nums.length }));
  process.exit(all.length || msgs.length || nums.length ? 1 : 0);
}

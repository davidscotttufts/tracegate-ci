// Footprint keys: a stable name for every function in a TypeScript file.
//
// A test's footprint names the functions it EXECUTED by key, and a change is
// mapped to the keys whose text it touched. The keys:
//   - a function is keyed by its chain of named ancestors (`Service/start`);
//     an anonymous callback by its callee and first string argument
//     (`router.get(/x)`), so one route handler is one key and editing it does
//     not invalidate every test that ran the code which registered it;
//   - type-only imports, interfaces and type aliases are `<import>`: erased by
//     the transform, never an input;
//   - a value import or re-export is `<import:SPEC>`, always an input: it can
//     pull a module graph into load, reorder vi.mock resolution, or rebind a
//     name an executed function uses without touching that function's text;
//   - a top-level `const X = <literal|object|array|arrow|new Set(...)>` is
//     `<const:X>`: an input only for tests whose code names X;
//   - any other top-level statement is `<top>`: an input to every test that
//     loaded the file.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { TOOL_DIR, ctx } from './config.mjs';

// TypeScript is loaded LAZILY: only parsing needs it, so `status`, `mode`,
// `triage` and `sync` work in a checkout with no install at all. The target
// repository's own TypeScript is preferred (a lane's, then the root's), then
// this package's.
//
// Only TypeScript 5 and 6 carry the JS compiler API (`createSourceFile`).
// TypeScript 7 is the native compiler, and its package exports no parser, so
// a repository on 7 installs 6 beside it under TS_ALIAS for Tracegate alone;
// the alias wins over `typescript` wherever both resolve.
export const TS_ALIAS = 'tracegate-typescript';
export const TS_FIX = `npm i -D ${TS_ALIAS}@npm:typescript@6`;
const usable = (m) => typeof m?.createSourceFile === 'function';
/** The TypeScript the predictor would parse with from `base`: {ts, name, version} or {why}. */
export function findTypescript(base) {
  const req = createRequire(path.join(base, 'package.json'));
  let unusable = null;
  for (const name of [TS_ALIAS, 'typescript']) {
    let m;
    try { m = req(name); } catch { continue; }
    const version = m?.version ?? (m?.default?.version) ?? '?';
    if (usable(m)) return { ts: m, name, version };
    unusable ??= `${name} ${version} has no JS parser API (TypeScript 7 is the native compiler; Tracegate parses with 5 or 6): ${TS_FIX}`;
  }
  return { why: unusable ?? `no TypeScript install found (install \`typescript\` 5 or 6, or ${TS_FIX})` };
}
let _ts = null;
const tsLib = () => {
  if (_ts) return _ts;
  let bases = [];
  try { const c = ctx(); bases = [...Object.values(c.lanes).map((l) => path.join(c.root, l.dir)), c.root]; } catch { /* no repo */ }
  let first = null;
  for (const base of [...bases, TOOL_DIR]) {
    const f = findTypescript(base);
    if (f.ts) return (_ts = f.ts);
    if (!first || f.why.includes('parser API')) first = f.why; // an unusable install says more than a missing one
  }
  throw new Error(`tracegate: ${first}`);
};
export const ts = new Proxy({}, { get: (_t, k) => tsLib()[k] });

function nameOf(n, sf) {
  if (n.name && ts.isIdentifier(n.name)) return n.name.text;
  if (n.name) return n.name.getText(sf);
  if (ts.isConstructorDeclaration(n)) return 'constructor';
  const p = n.parent;
  if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p))) return p.name.getText(sf);
  if (p && ts.isCallExpression(p)) {
    const callee = p.expression.getText(sf).replace(/\s+/g, '').slice(-40);
    const lit = p.arguments.find((a) => ts.isStringLiteralLike(a));
    return `${callee}(${lit ? lit.text : '?'})`;
  }
  return '?';
}
const isFn = (n) => ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n);
let _pure = null;
const pureKinds = () => _pure ??= new Set([ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.ObjectLiteralExpression,
  ts.SyntaxKind.ArrayLiteralExpression, ts.SyntaxKind.AsExpression, ts.SyntaxKind.SatisfiesExpression,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateExpression, ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.BinaryExpression, ts.SyntaxKind.PrefixUnaryExpression,
  ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.FunctionExpression]);

// A built-in collection made from plain data (`new Set([...])`, `new Map()`) has
// no side effect when the module loads; a test can only see it through code that
// names it. So it follows the constant rule, not the top-level one. Treated as
// `<top>`, one edit to a module-level lookup set invalidated most of a large
// lane in practice, and so did adding an empty `new Map()` cache. Only the GLOBAL
// constructor counts: a file that binds its own `Set`/`Map` keeps `<top>`.
const PURE_CTORS = new Set(['Set', 'Map', 'WeakSet', 'WeakMap']);
function isPureInit(init, sf) {
  if (pureKinds().has(init.kind)) return true;
  if (!ts.isNewExpression(init) || !ts.isIdentifier(init.expression) || !PURE_CTORS.has(init.expression.text)) return false;
  const args = init.arguments ?? [];
  if (args.length > 1 || (args.length === 1 && !pureKinds().has(args[0].kind))) return false;
  return !localBindings(sf).has(init.expression.text);
}
const _bindings = new WeakMap();
function localBindings(sf) {
  let b = _bindings.get(sf);
  if (b) return b;
  b = new Set();
  const visit = (n) => {
    if ((ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isParameter(n) ||
      ts.isImportSpecifier(n) || ts.isImportClause(n) || ts.isNamespaceImport(n) || ts.isImportEqualsDeclaration(n)) &&
      n.name && ts.isIdentifier(n.name)) b.add(n.name.text);
    n.forEachChild(visit);
  };
  visit(sf);
  _bindings.set(sf, b);
  return b;
}

const _model = new Map();
/** Parse once per (file, content): spans of functions, const names, line classes. */
export function model(src, file) {
  const ck = file + '\0' + crypto.createHash('sha1').update(src).digest('hex');
  const hit = _model.get(ck);
  if (hit) return hit;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  // Every character gets ONE owner: the innermost function containing it, or the
  // class of the top-level statement it belongs to. A changed line then names
  // EVERY owner it touches. Attributing a line to its innermost function alone
  // is unsound: in `items.map((x) => x + 1)` the edit may be to `items`, which
  // belongs to the enclosing function, not to the callback (self-test witness).
  const names = ['<blank>']; const id = (k) => { let i = names.indexOf(k); if (i < 0) { i = names.length; names.push(k); } return i; };
  const owner = new Int32Array(src.length); // 0 = <blank>
  const consts = new Map();
  for (const st of sf.statements) {
    const erased = (ts.isImportDeclaration(st) && st.importClause) || (ts.isExportDeclaration(st) && st.moduleSpecifier) ||
      ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st);
    let cls = '<top>';
    if (erased) {
      const typeOnly = !st.moduleSpecifier || (ts.isImportDeclaration(st) ? st.importClause.isTypeOnly : st.isTypeOnly);
      cls = typeOnly ? '<import>' : `<import:${st.moduleSpecifier.text}>`;
    }
    else if (ts.isVariableStatement(st)) {
      const d = st.declarationList.declarations;
      if (d.length === 1 && ts.isIdentifier(d[0].name) && d[0].initializer && isPureInit(d[0].initializer, sf)) {
        consts.set(d[0].name.text, d[0].initializer.getText(sf));
        cls = `<const:${d[0].name.text}>`;
      }
    }
    owner.fill(id(cls), st.getStart(sf), st.getEnd());
  }
  const spans = [];
  // Iterative pre-order walk (outer before inner, so inner functions overwrite):
  // some generated files nest deeply enough to overflow a recursive walk.
  const stack = [[sf, []]];
  while (stack.length) {
    const [n, chain] = stack.pop();
    let c = chain;
    if (isFn(n)) {
      c = [...chain, nameOf(n, sf)];
      const key = c.join('/');
      spans.push({ s: line(n.getStart(sf)), e: line(n.getEnd()), key });
      owner.fill(id(key), n.getStart(sf), n.getEnd());
    }
    const kids = []; n.forEachChild((k) => { kids.push(k); });
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], c]);
  }
  const lines = src.split('\n');
  const lineStart = [0]; for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lineStart.push(i + 1);
  /** Owners of line l, optionally only of its columns [c0, c1). */
  const keysAt = (l, c0 = 0, c1 = Infinity) => {
    const ls = lineStart[l - 1]; if (ls === undefined) return ['<blank>'];
    const le = l < lineStart.length ? lineStart[l] : src.length;
    const a = Math.min(le, ls + c0), b = Math.min(le, ls + c1);
    const text = lines[l - 1] ?? '';
    if (/^\s*(\/\/.*|\/?\*.*|\*\/)?\s*$/.test(text)) return ['<blank>'];
    const out = new Set();
    for (let i = a; i < b; i++) { const ch = src.charCodeAt(i); if (ch !== 32 && ch !== 9 && ch !== 10 && ch !== 13) out.add(names[owner[i]]); }
    return out.size ? [...out] : ['<blank>'];
  };
  /** Functions whose declaration STARTS on line l (what a V8 start offset maps to). */
  const fnsStartingAt = (l) => {
    const at = spans.filter((sp) => sp.s === l).map((sp) => sp.key);
    if (at.length) return at;
    let best = null;
    for (const sp of spans) if (l >= sp.s && l <= sp.e && (!best || (sp.s >= best.s && sp.e <= best.e))) best = sp;
    return best ? [best.key] : [];
  };
  const spanOf = (key) => spans.find((sp) => sp.key === key);
  const jsonImports = [...src.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+\.json)['"]/g)].map((m) => m[1]);
  const m = { keysAt, fnsStartingAt, spanOf, consts, lines, jsonImports };
  _model.set(ck, m);
  return m;
}

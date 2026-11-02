//
// fuse.js - lozza specific 64 bit hash fusion for lozza2c.
//
// lozza keeps its 64 bit zobrist hashes as pairs of int32 (loHash/hiHash,
// loObjPieces/hiObjPieces ...) because JS has no 64 bit ints.
// The C build fuses each pair into one uint64: paired declarations, adjacent
// lo/hi statements, and lo/hi equality tests joined by && or || become a
// single 64 bit operation. The low int32 is the low word, so tt indexes
// (loHash & ttMask) and every key bit are unchanged and the search is
// identical. The JS is untouched.
//
// The tt keeps its key as two adjacent words of one Int32Array:
//   tt[i] = loHash; tt[i+1] = hiHash;            ->  ttStore64(i, hash);
//   tt[i] !== loHash || tt[i+1] !== hiHash       ->  ttLoad64(i) != hash
// ttLoad64/ttStore64 are two-word helpers emitted by lozza2c.js.
//

'use strict';

const PAIRS = [
  ['loHash',      'hiHash',      'hash'],
  ['loTurn',      'hiTurn',      'hashTurn'],
  ['loObjPieces', 'hiObjPieces', 'hashObjPieces'],
  ['loRights',    'hiRights',    'hashRights'],
  ['loEP',        'hiEP',        'hashEP'],
  ['repLoHash',   'repHiHash',   'repHash'],
];

// arrays that hold a lo/hi pair in adjacent words, [i] and [i + 1]

const WORD_ARRAYS = new Set(['tt']);

const LO2HI = new Map(PAIRS.map(p => [p[0], p[1]]));
const LO2F  = new Map(PAIRS.map(p => [p[0], p[2]]));
const HI    = new Set(PAIRS.map(p => p[1]));
const FUSED = new Set(PAIRS.map(p => p[2]));

// lo names that are globals or node fields: a pair must mention one of these

const LO_GLOBAL = new Set(PAIRS.map(p => p[0]));

// the two random draws of a pair become one 64 bit draw

LO2F.set('twisterRand', 'twisterRand64');

function stripped (n) {
  return JSON.stringify(n, (k, v) => (k === 'start' || k === 'end' || k === 'loc' || k === 'raw') ? undefined : v);
}

function renamed (n, map) {
  if (Array.isArray(n)) return n.map(x => renamed(x, map));
  if (!n || typeof n !== 'object') return n;
  const o = {};
  for (const k of Object.keys(n)) o[k] = renamed(n[k], map);
  if (o.type === 'Identifier' && map.has(o.name)) o.name = map.get(o.name);
  return o;
}

function mentions (n, names) {
  if (Array.isArray(n)) return n.some(x => mentions(x, names));
  if (!n || typeof n !== 'object') return false;
  if (n.type === 'Identifier' && names.has(n.name)) return true;
  for (const k of Object.keys(n))
    if (k !== 'loc' && mentions(n[k], names)) return true;
  return false;
}

function isPair (a, b) {
  return mentions(a, LO_GLOBAL) && stripped(renamed(a, LO2HI)) === stripped(b);
}

const EQ = new Set(['===', '==']);
const NE = new Set(['!==', '!=']);

// tt[E] <op> loHash  and  tt[E + 1] <op> hiHash  (op is = for statements, or an
// equality test); returns the fused node or null

function wordAccess (n) {
  return n.type === 'MemberExpression' && n.computed && n.object.type === 'Identifier' && WORD_ARRAYS.has(n.object.name);
}

function wordPair (a, b) {
  if (a.type === 'ExpressionStatement') {
    if (b.type !== 'ExpressionStatement') return null;
    const w = wordPair(a.expression, b.expression);
    return w ? {type: 'ExpressionStatement', expression: w, loc: a.loc, start: a.start, end: a.end} : null;
  }
  if (!(a.type === 'AssignmentExpression' && a.operator === '=') && !(a.type === 'BinaryExpression' && (EQ.has(a.operator) || NE.has(a.operator)))) return null;
  if (b.type !== a.type || b.operator !== a.operator) return null;
  if (!wordAccess(a.left) || !wordAccess(b.left) || a.left.object.name !== b.left.object.name) return null;
  if (a.right.type !== 'Identifier' || b.right.type !== 'Identifier' || LO2HI.get(a.right.name) !== b.right.name) return null;
  const bi = b.left.property;  // must be  <a index> + 1
  if (bi.type !== 'BinaryExpression' || bi.operator !== '+' || bi.right.type !== 'Literal' || bi.right.value !== 1) return null;
  if (stripped(bi.left) !== stripped(a.left.property)) return null;
  const idx = a.left.property;
  const key = {type: 'Identifier', name: LO2F.get(a.right.name)};
  const call = (name, args) => ({type: 'CallExpression', callee: {type: 'Identifier', name}, arguments: args, optional: false, loc: a.loc, start: a.start, end: a.end});
  if (a.type === 'AssignmentExpression')
    return call('ttStore64', [idx, key]);
  return {type: 'BinaryExpression', operator: a.operator, left: call('ttLoad64', [idx]), right: key, loc: a.loc, start: a.start, end: a.end};
}

function isEqPair (op, a, b) {
  // lo === x && hi === y  |  lo !== x || hi !== y
  if (a.type !== 'BinaryExpression') return false;
  if (op === '&&' && !EQ.has(a.operator)) return false;
  if (op === '||' && !NE.has(a.operator)) return false;
  return isPair(a, b);
}

function wordEqPair (op, a, b) {
  if (a.type !== 'BinaryExpression') return null;
  if (op === '&&' && !EQ.has(a.operator)) return null;
  if (op === '||' && !NE.has(a.operator)) return null;
  return wordPair(a, b);
}

function fuseList (stmts) {
  const out = [];
  for (let i = 0; i < stmts.length; i++) {
    const a = stmts[i], b = stmts[i + 1];
    if (b && a.type === b.type && (a.type === 'ExpressionStatement' || a.type === 'VariableDeclaration') && isPair(a, b)) {
      out.push(renamed(a, LO2F));
      i++;
      continue;
    }
    const w = b && wordPair(a, b);
    if (w) {
      out.push(w);
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function flatten (n, op, out) {
  if (n.type === 'LogicalExpression' && n.operator === op) { flatten(n.left, op, out); flatten(n.right, op, out); }
  else out.push(n);
}

function fuseLogical (n) {
  const ops = [];
  flatten(n, n.operator, ops);
  const res = [];
  for (let i = 0; i < ops.length; i++) {
    const w = i + 1 < ops.length && wordEqPair(n.operator, ops[i], ops[i + 1]);
    if (i + 1 < ops.length && isEqPair(n.operator, ops[i], ops[i + 1])) { res.push(renamed(ops[i], LO2F)); i++; }
    else if (w) { res.push(w); i++; }
    else res.push(ops[i]);
  }
  if (res.length === ops.length) return n;
  let e = res[0];
  for (let i = 1; i < res.length; i++)
    e = {type: 'LogicalExpression', operator: n.operator, left: e, right: res[i], loc: n.loc, start: n.start, end: n.end};
  return e;
}

function fuseNode (n) {
  if (Array.isArray(n)) return n.map(fuseNode);
  if (!n || typeof n !== 'object') return n;
  if (Array.isArray(n.body)) n.body = fuseList(n.body);
  if (Array.isArray(n.consequent)) n.consequent = fuseList(n.consequent);
  for (const k of Object.keys(n))
    if (k !== 'loc') n[k] = fuseNode(n[k]);
  if (n.type === 'LogicalExpression') return fuseLogical(n);
  return n;
}

// remaining single lo references (loHash & ttMask) read the low word of the fused value

function renameLo (n) {
  if (Array.isArray(n)) { n.forEach(renameLo); return; }
  if (!n || typeof n !== 'object') return;
  if (n.type === 'Identifier' && LO_GLOBAL.has(n.name)) n.name = LO2F.get(n.name);
  for (const k of Object.keys(n))
    if (k !== 'loc') renameLo(n[k]);
}

function fuse (ast) {
  fuseNode(ast);
  renameLo(ast);
  return ast;
}

const HI_GLOBAL = new Set(PAIRS.map(p => p[1]));

module.exports = {fuse, HI: HI_GLOBAL, FUSED, PAIRS};

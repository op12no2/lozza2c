//
// lozza2c - converts lozza.js to C.
//
// This is not a general JS to C compiler. It handles the typed-array / int32
// subset that lozza is written in, plus the small string subset used by the
// uci layer (fens, moves, tokens, info lines). Anything else is an error.
//
// node lozza2c.js <lozza.js> <out.c> [--folds f1,f2] [--exclude n1,n2] [--extra g1,g2]
//
// Types are inferred by a fixpoint over the whole program. Everything numeric
// is int32 unless it is widened by what gets assigned to it (uint32 from >>>,
// int64 when int32 and uint32 meet, double from / and Math.*) or by a clue
// comment on the declaration line (// @i64 etc). Function parameters that are
// strings or string arrays take a clue on the function line:
//
//   function position (bd, turn, rights, ep, moves) {  // @types bd:str moves:strarr
//
// Host specific code is kept under  if (nodeHost) / if (shellHost)  which the
// converter treats as false, and in the host functions listed in HOST below,
// which the C runtime provides.
//

'use strict';

const fs    = require('fs');
const acorn = require('acorn');

//{{{  config

const args = process.argv.slice(2);

if (args.length < 2) {
  console.error('usage: lozza2c.js <lozza.js> <out.c> [--folds a,b] [--exclude a,b] [--extra a,b]');
  process.exit(1);
}

const SRC = args[0];
const OUT = args[1];

function opt (name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i+1].split(',').filter(x => x) : def;
}

const FOLDS   = opt('--folds',   ['constants','utils','prng','net','board','nodes','tt','moves','evaluate','search','uci','datagen']);
const EXCLUDE = new Set(opt('--exclude', []));
const EXTRA   = new Set(opt('--extra',   []));

// functions provided by the host runtime, with their C signatures

const HOST = {
  now:         {ret: 'i32',  params: []},
  hostExit:    {ret: 'void', params: []},
  yieldToHost: {ret: 'void', params: []},
  getWeights:  {ret: 'str',  params: []},
  netLoad:     {ret: 'void', params: []},
  lozzaRandom: {ret: 'f64',  params: []},
  dgOpenBook:  {ret: 'i32',  params: ['str']},         // datagen file access
  dgBookLine:  {ret: 'str',  params: []},
  dgOpenOut:   {ret: 'str',  params: ['str', 'str']},
  dgWrite:     {ret: 'void', params: ['str']},
  dgFlush:     {ret: 'void', params: []},
  dgClose:     {ret: 'void', params: []},
};

const NOOP = new Set(['seal']);

// identifiers that are false in the C build; if (x) {...} is dropped

const HOST_FALSE = new Set(['nodeHost', 'shellHost']);

//}}}
//{{{  types

const T = {
  i32:     {k: 'i32'},
  u32:     {k: 'u32'},
  u64:     {k: 'u64'},
  i64:     {k: 'i64'},
  f64:     {k: 'f64'},
  str:     {k: 'str'},
  chr:     {k: 'chr'},
  void:    {k: 'void'},
  node:    {k: 'node'},
  strarr:  {k: 'strarr'},
  nodearr: {k: 'nodearr'},
  unknown: {k: 'unknown'},
};

const ELEM_C = {i8: 'int8_t', u8: 'uint8_t', i16: 'int16_t', u16: 'uint16_t', i32: 'int32_t', u32: 'uint32_t', u64: 'uint64_t', f64: 'double'};

const TYPED_ARRAYS = {Int8Array: 'i8', Uint8Array: 'u8', Int16Array: 'i16', Uint16Array: 'u16', Int32Array: 'i32', Uint32Array: 'u32', Float64Array: 'f64'};

const C_RESERVED = new Set(('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while ' +
  'FILE EOF NULL stdin stdout stderr errno abs labs exit free malloc calloc realloc index rindex time clock rand srand random remove rename log exp pow sqrt floor ceil round trunc fmin fmax fabs fmod min max main read write open close assert bool true false memcpy memset memmove strlen strcmp strcpy strcat printf puts putchar getchar scanf sscanf').split(' '));

function cname (n) { return C_RESERVED.has(n) ? n + '_' : n; }

function ptr (elem)          { return {k: 'ptr', elem}; }
function arr (elem, len)     { return {k: 'arr', elem, len}; }
function fnt (name)          { return {k: 'func', name}; }
function tuple (name, flds)  { return {k: 'tuple', name, fields: flds}; }

function elemRead (e) {
  return (e === 'u32') ? T.u32 : (e === 'u64') ? T.u64 : (e === 'f64') ? T.f64 : T.i32;
}

function isNum (t) { return t.k === 'i32' || t.k === 'u32' || t.k === 'i64' || t.k === 'u64' || t.k === 'f64' || t.k === 'chr'; }
function isInt (t) { return t.k === 'i32' || t.k === 'u32' || t.k === 'i64' || t.k === 'u64' || t.k === 'chr'; }
function isStrish (t) { return t.k === 'str' || t.k === 'chr'; }

function sameType (a, b) {
  if (a === b) return true;
  if (!a || !b || a.k !== b.k) return false;
  if (a.k === 'ptr') return a.elem === b.elem;
  if (a.k === 'arr') return a.len === b.len && sameType(a.elem, b.elem);
  if (a.k === 'func') return a.name === b.name;
  if (a.k === 'tuple' || a.k === 'tuplearr') return a.name === b.name;
  return true;
}

function join (a, b) {
  if (!a || a.k === 'unknown') return b;
  if (!b || b.k === 'unknown') return a;
  if (sameType(a, b)) return a;
  if (isNum(a) && isNum(b)) {
    if (a.k === 'u64' || b.k === 'u64') return T.u64;   // fused hashes absorb
    if (a.k === 'f64' || b.k === 'f64') return T.f64;
    if (a.k === 'chr') return join(T.i32, b);
    if (b.k === 'chr') return join(a, T.i32);
    if (a.k === 'i64' || b.k === 'i64') return T.i64;
    if (a.k !== b.k) return T.i64;  // i32 + u32
    return a;
  }
  if (a.k === 'func' && b.k === 'func') return a;
  throw new Error('cannot join types ' + tstr(a) + ' and ' + tstr(b));
}

function tstr (t) {
  if (!t) return '?';
  if (t.k === 'ptr') return t.elem + '*';
  if (t.k === 'arr') return tstr(t.elem) + '[' + t.len + ']';
  if (t.k === 'func') return 'func:' + t.name;
  if (t.k === 'tuple' || t.k === 'tuplearr') return t.k + ':' + t.name;
  return t.k;
}

function ctype (t) {
  switch (t.k) {
    case 'i32':      return 'int32_t';
    case 'u32':      return 'uint32_t';
    case 'u64':      return 'uint64_t';
    case 'i64':      return 'int64_t';
    case 'f64':      return 'double';
    case 'str':      return 'const char*';
    case 'chr':      return 'char';
    case 'void':     return 'void';
    case 'node':     return 'node_t*';
    case 'strarr':   return 'strarr_t*';
    case 'ptr':      return ELEM_C[t.elem] + '*';
    case 'arr':      return ctype(t.elem) + '*';   // decayed
    case 'func':     return 'lz_fn_' + t.name;
    case 'tuple':    return 'lz_tuple_' + t.name;
    case 'unknown':  return 'LZ_UNKNOWN';
  }
  throw new Error('no C type for ' + tstr(t));
}

//}}}
//{{{  parse

const source = fs.readFileSync(SRC, 'utf8');
const comments = [];

const ast = acorn.parse(source, {ecmaVersion: 2022, sourceType: 'script', locations: true, onComment: comments});

// lozza specific: fuse the int32 hash pairs into uint64 (see fuse.js)

const {fuse, HI: FUSE_HI, FUSED} = require('./fuse.js');
fuse(ast);

// main fold line ranges

const foldRanges = [];
{
  const lines = source.split('\n');
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\/\/\{\{\{\s*(.*?)\s*$/);
    if (m) { stack.push({name: m[1], start: i+1}); continue; }
    if (/^\s*\/\/\}\}\}/.test(lines[i])) {
      const f = stack.pop();
      if (stack.length === 0) foldRanges.push({name: f.name, start: f.start, end: i+1});
    }
  }
}

function foldOf (line) {
  for (const f of foldRanges)
    if (line >= f.start && line <= f.end) return f.name;
  return null;
}

// clues

const clueByLine  = new Map();
const typesByLine = new Map();

for (const c of comments) {
  const m = c.value.match(/@(i32|i64|u32|f64)\b/);
  if (m) clueByLine.set(c.loc.start.line, T[m[1]]);
  const t = c.value.match(/@types\s+(.*)/);
  if (t) {
    const map = {};
    for (const pair of t[1].trim().split(/\s+/)) {
      const [n, ty] = pair.split(':');
      if (!T[ty]) throw new Error('bad @types clue ' + pair + ' at line ' + c.loc.start.line);
      map[n] = T[ty];
    }
    typesByLine.set(c.loc.start.line, map);
  }
}

//}}}
//{{{  collect top level

const globals = new Map();
const funcs   = new Map();

for (const st of ast.body) {

  if (st.type === 'FunctionDeclaration') {
    const name = st.id.name;
    const fold = foldOf(st.loc.start.line);
    const included = (FOLDS.includes(fold) || EXTRA.has(name)) && !EXCLUDE.has(name) && !HOST[name] && !NOOP.has(name);
    const clues = typesByLine.get(st.loc.start.line) || {};
    funcs.set(name, {node: st, name, included, params: st.params.map(p => ({name: p.name, type: clues[p.name] || T.unknown})), ret: T.unknown, hasReturnValue: false});
    continue;
  }

  if (st.type === 'VariableDeclaration') {
    for (const d of st.declarations) {
      const name = d.id.name;
      const fold = foldOf(st.loc.start.line);
      const included = (FOLDS.includes(fold) || EXTRA.has(name)) && !EXCLUDE.has(name) && !HOST_FALSE.has(name);
      globals.set(name, {name, decl: st.kind, init: d.init, included, type: T.unknown, clue: clueByLine.get(st.loc.start.line), line: st.loc.start.line, reassigned: false});
    }
    continue;
  }

  // anything else at top level (initOnce(), the argv loop) is host startup
}

for (const name of Object.keys(HOST))
  funcs.set(name, {name, host: true, included: false, ret: T[HOST[name].ret], params: HOST[name].params.map(p => ({type: T[p]})), hasReturnValue: HOST[name].ret !== 'void'});

funcs.set('twisterRand64', {name: 'twisterRand64', host: true, included: false, ret: T.u64, params: [], hasReturnValue: true});

// the tt key: words i and i+1 of the int32 tt array as one uint64 (see fuse.js)

funcs.set('ttLoad64',  {name: 'ttLoad64',  host: true, included: false, ret: T.u64,  params: [{type: T.i32}], hasReturnValue: true});
funcs.set('ttStore64', {name: 'ttStore64', host: true, included: false, ret: T.void, params: [{type: T.i32}, {type: T.u64}], hasReturnValue: false});

//}}}
//{{{  constant evaluation

const constVals = new Map();

function evalConst (e) {
  switch (e.type) {
    case 'Literal':
      if (typeof e.value === 'number') return e.value;
      return undefined;
    case 'Identifier':
      return constVals.has(e.name) ? constVals.get(e.name) : undefined;
    case 'UnaryExpression': {
      const v = evalConst(e.argument);
      if (v === undefined) return undefined;
      switch (e.operator) { case '-': return -v; case '+': return +v; case '~': return ~v; case '!': return +!v; }
      return undefined;
    }
    case 'BinaryExpression': {
      const a = evalConst(e.left), b = evalConst(e.right);
      if (a === undefined || b === undefined) return undefined;
      switch (e.operator) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; case '%': return a % b;
        case '|': return a | b; case '&': return a & b; case '^': return a ^ b;
        case '<<': return a << b; case '>>': return a >> b; case '>>>': return a >>> b;
      }
      return undefined;
    }
    case 'ParenthesizedExpression': return evalConst(e.expression);
  }
  return undefined;
}

function numType (v) {
  if (Number.isInteger(v)) {
    if (v >= -2147483648 && v <= 2147483647) return T.i32;
    if (v >= 0 && v <= 4294967295) return T.u32;
    if (Math.abs(v) < 2 ** 53) return T.i64;
  }
  return T.f64;
}

function numLit (v, t) {
  if (t.k === 'f64') {
    let s = String(v);
    if (!/[.eE]/.test(s)) s += '.0';
    return '(' + s + ')';
  }
  if (t.k === 'u32') return '((uint32_t)' + v + 'u)';
  if (t.k === 'i64') return '((int64_t)' + v + 'LL)';
  if (v === -2147483648) return '((int32_t)-2147483647-1)';
  return '((int32_t)' + v + ')';
}

function cstr (s) {
  let o = '"';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (ch === '\\') o += '\\\\';
    else if (ch === '"') o += '\\"';
    else if (ch === '\n') o += '\\n';
    else if (ch === '\r') o += '\\r';
    else if (ch === '\t') o += '\\t';
    else if (c < 32 || c > 126) o += '\\x' + c.toString(16).padStart(2, '0') + '""';
    else o += ch;
  }
  return o + '"';
}

function clit (ch) {
  if (ch === "'") return "'\\''";
  if (ch === '\\') return "'\\\\'";
  if (ch === '\n') return "'\\n'";
  if (ch === '\r') return "'\\r'";
  if (ch === '\t') return "'\\t'";
  return "'" + ch + "'";
}

//}}}
//{{{  classify globals

function isNewTyped (e) {
  return e && e.type === 'NewExpression' && e.callee.type === 'Identifier' && TYPED_ARRAYS[e.callee.name];
}

function unwrapSeal (e) {
  if (e && e.type === 'CallExpression' && e.callee.type === 'MemberExpression' && e.callee.object.name === 'Object' && (e.callee.property.name === 'seal' || e.callee.property.name === 'freeze'))
    return e.arguments[0];
  return e;
}

function litType (e) {
  if (e.type === 'Literal' && typeof e.value === 'string') return T.str;
  if (e.type === 'Literal' && typeof e.value === 'number') return numType(e.value);
  const v = evalConst(e);
  return v === undefined ? null : numType(v);
}

for (const [name, g] of globals) {

  if (!g.included) continue;

  const init = unwrapSeal(g.init);
  g.init = init;

  if (!init) { g.kind = 'scalar'; continue; }

  // numeric constant

  const cv = evalConst(init);
  if (cv !== undefined && g.decl === 'const') {
    g.kind = 'const';
    g.constVal = cv;
    g.type = g.clue || numType(cv);
    constVals.set(name, cv);
    continue;
  }

  // typed arrays

  if (isNewTyped(init)) {
    const elem = FUSED.has(name) ? 'u64' : TYPED_ARRAYS[init.callee.name];
    const a0 = init.arguments[0];
    if (a0 && a0.type === 'ArrayExpression') {
      g.kind = 'tarray';
      g.elem = elem;
      g.len  = a0.elements.length;
      g.values = a0.elements.map(x => { const v = evalConst(x); if (v === undefined) throw new Error('non constant array initialiser for ' + name); return v; });
      g.type = ptr(elem);
      continue;
    }
    const len = evalConst(a0);
    if (len !== undefined) {
      g.kind = 'tarray';
      g.elem = elem;
      g.len  = len;
      g.type = ptr(elem);
      continue;
    }
    g.kind = 'dynarray';
    g.elem = elem;
    g.lenSrc = a0;
    g.type = ptr(elem);
    continue;
  }

  // Array(N) -> array of node structs

  if (init.type === 'CallExpression' && init.callee.type === 'Identifier' && init.callee.name === 'Array') {
    g.kind = 'nodearr';
    g.len  = evalConst(init.arguments[0]);
    g.type = T.nodearr;
    continue;
  }

  // Array.from({length: N}, () => new XArray(M)) -> 2D array

  if (init.type === 'CallExpression' && init.callee.type === 'MemberExpression' && init.callee.object.name === 'Array' && init.callee.property.name === 'from') {
    const n = evalConst(init.arguments[0].properties[0].value);
    const inner = init.arguments[1].body;
    if (!isNewTyped(inner)) throw new Error('unsupported Array.from for ' + name);
    g.kind = 'array2d';
    g.elem = TYPED_ARRAYS[inner.callee.name];
    g.len  = n;
    g.len2 = evalConst(inner.arguments[0]);
    g.type = arr(ptr(g.elem), n);
    continue;
  }

  if (init.type === 'ArrayExpression') {
    const els = init.elements;

    // [] -> string queue

    if (els.length === 0) {
      g.kind = 'strq';
      g.type = T.strarr;
      continue;
    }

    // strings

    if (els.every(e => e.type === 'Literal' && typeof e.value === 'string')) {
      g.kind = 'strarray';
      g.values = els.map(e => e.value);
      g.len = els.length;
      g.type = arr(T.str, els.length);
      continue;
    }

    // typed arrays by name

    if (els.every(e => e.type === 'Identifier')) {
      g.kind = 'ptrarray';
      g.values = els.map(e => e.name);
      g.len = els.length;
      const et = globals.get(els[0].name).type;
      g.type = arr(et, els.length);
      g.elemC = ctype(et);
      continue;
    }

    if (els.every(e => e.type === 'ArrayExpression' && e.elements.every(x => x.type === 'Identifier'))) {
      g.kind = 'ptrarray2';
      g.values = els.map(e => e.elements.map(x => x.name));
      g.len = els.length;
      g.len2 = els[0].elements.length;
      const et = globals.get(els[0].elements[0].name).type;
      g.type = arr(arr(et, g.len2), g.len);
      g.elemC = ctype(et);
      continue;
    }

    // table of tuples: [[str|num, ...], ...] with the same shape on every row

    if (els.every(e => e.type === 'ArrayExpression' && e.elements.every(x => litType(x)))) {
      const n = els[0].elements.length;
      const fields = [];
      for (let k = 0; k < n; k++) {
        let t = null;
        for (const row of els) {
          if (row.elements.length !== n) throw new Error('ragged tuple table ' + name);
          t = join(t, litType(row.elements[k]));
        }
        fields.push(t);
      }
      g.kind = 'tuplearr';
      g.len = els.length;
      g.fields = fields;
      g.values = els.map(row => row.elements.map((x, k) => fields[k].k === 'str' ? cstr(x.value) : numLit(evalConst(x), fields[k])));
      g.type = {k: 'tuplearr', name, len: g.len, fields};
      continue;
    }

    throw new Error('unsupported array literal for ' + name);
  }

  // object literal used as a lookup table

  if (init.type === 'ObjectExpression') {
    const props = init.properties;
    if (props.every(p => typeof p.key.value === 'string' && p.key.value.length === 1)) {
      g.kind = 'chartable';
      g.values = props.map(p => [p.key.value, evalConst(p.value)]);
      g.type = ptr('i32');
      continue;
    }
    if (props.every(p => typeof p.key.value === 'number' && typeof p.value.value === 'string')) {
      g.kind = 'numtable';
      g.values = props.map(p => [p.key.value, p.value.value]);
      g.len = Math.max(...props.map(p => p.key.value)) + 1;
      g.type = arr(T.str, g.len);
      continue;
    }
    throw new Error('unsupported object literal for ' + name);
  }

  // function reference

  if (init.type === 'Identifier' && funcs.has(init.name)) {
    g.kind = 'funcptr';
    g.type = fnt(init.name);
    g.initName = init.name;
    continue;
  }

  if (init.type === 'Literal' && init.value === null) {
    g.kind = 'scalar';
    g.type = T.node;
    continue;
  }

  g.kind = 'scalar';
  if (FUSED.has(name)) g.type = T.u64;
  else if (g.clue) g.type = g.clue;
  else {
    const t = litType(init);
    if (t) g.type = t;
  }
}

//}}}
//{{{  node struct

let nodeFields = null;
const nodeFieldType = new Map();

{
  const f = funcs.get('nodeStruct');
  if (f) {
    f.included = false;
    nodeFields = [];
    for (const st of f.node.body.body) {
      const e = st.expression;
      const name = e.left.property.name;
      const init = e.right;
      let fld;
      if (isNewTyped(init)) fld = {name, kind: 'tarray', elem: TYPED_ARRAYS[init.callee.name], len: evalConst(init.arguments[0]), type: ptr(TYPED_ARRAYS[init.callee.name])};
      else if (init.type === 'Literal' && init.value === null) fld = {name, kind: 'scalar', type: T.node};
      else fld = {name, kind: 'scalar', type: FUSED.has(name) ? T.u64 : numType(evalConst(init)), init: evalConst(init)};
      nodeFields.push(fld);
      nodeFieldType.set(name, fld);
    }
  }
}

//}}}
//{{{  inference helpers

let changed   = false;
let finalPass = false;

function widenGlobal (name, t) {
  const g = globals.get(name);
  if (g.kind !== 'scalar') return;
  const j = join(g.type, t);
  if (!sameType(j, g.type)) { g.type = j; changed = true; }
}

function widenField (name, t) {
  const f = nodeFieldType.get(name);
  if (!f || f.kind !== 'scalar') return;
  const j = join(f.type, t);
  if (!sameType(j, f.type)) { f.type = j; changed = true; }
}

function widenParam (fname, i, t) {
  const f = funcs.get(fname);
  if (!f || f.host || !f.params[i]) return;
  const j = join(f.params[i].type, t);
  if (!sameType(j, f.params[i].type)) { f.params[i].type = j; changed = true; }
}

function widenReturn (fname, t) {
  const f = funcs.get(fname);
  const j = join(f.ret, t);
  if (!sameType(j, f.ret)) { f.ret = j; changed = true; }
}

function widenLocal (v, t) {
  const j = join(v.type, t);
  if (!sameType(j, v.type)) { v.type = j; changed = true; }
}

function widenExpr (o, t) {
  if (o.local) widenLocal(o.local, t);
  else if (o.global) widenGlobal(o.global.name, t);
}

function lookupVar (scope, name) {
  for (let s = scope; s; s = s.parent)
    if (s.vars.has(name)) return s.vars.get(name);
  return null;
}

function err (n, msg) {
  const where = n && n.loc ? ' at line ' + n.loc.start.line : '';
  throw new Error(msg + where);
}

function unknownOrErr (n, msg) {
  if (!finalPass) return {c: 'LZ_UNKNOWN', t: T.unknown};
  err(n, msg);
}

function conv (code, from, to) {
  if (sameType(from, to)) return code;
  if (from.k === 'unknown' || to.k === 'unknown') return code;
  if (to.k === 'i32') {
    if (from.k === 'f64') return 'lz_toint32(' + code + ')';
    if (from.k === 'u64') return '((int32_t)(uint32_t)(' + code + '))';
    if (from.k === 'u32' || from.k === 'i64' || from.k === 'chr') return '((int32_t)(' + code + '))';
  }
  if (to.k === 'u64' && isNum(from) && from.k !== 'f64') return '((uint64_t)(' + code + '))';
  if (to.k === 'u32' && isNum(from)) return '((uint32_t)(' + code + '))';
  if (to.k === 'i64' && isNum(from)) return '((int64_t)(' + code + '))';
  if (to.k === 'f64' && isNum(from)) return '((double)(' + code + '))';
  if (to.k === 'chr' && isNum(from)) return '((char)(' + code + '))';
  if (to.k === 'str' && from.k === 'chr') return 'lz_chrs(' + code + ')';
  if (to.k === 'ptr' && from.k === 'arr') return code;
  if (to.k === 'ptr' && from.k === 'ptr' && to.elem === from.elem) return code;
  if (to.k === from.k && (to.k === 'node' || to.k === 'func' || to.k === 'str' || to.k === 'strarr')) return code;
  throw new Error('cannot convert ' + tstr(from) + ' to ' + tstr(to) + ' in ' + code);
}

function toStr (code, t) {
  switch (t.k) {
    case 'unknown': return code;
    case 'str': return code;
    case 'chr': return 'lz_chrs(' + code + ')';
    case 'i32': return 'lz_i64s((int64_t)(' + code + '))';
    case 'u32': return 'lz_i64s((int64_t)(' + code + '))';
    case 'i64': return 'lz_i64s(' + code + ')';
    case 'f64': return 'lz_f64s(' + code + ')';
  }
  throw new Error('cannot stringify ' + tstr(t));
}

function i32 (r) { return r.t.k === 'unknown' ? r.c : conv(r.c, r.t, T.i32); }

// truthiness of a value used as a condition

function condC (r) {
  if (r.t.k === 'str') return '(!lz_strEmpty(' + r.c + '))';
  if (r.t.k === 'node') return '(' + r.c + ' != NULL)';
  return r.c;
}

//}}}
//{{{  expressions

function gen (e, scope, cond) {

  switch (e.type) {

    case 'ParenthesizedExpression':
      return gen(e.expression, scope, cond);

    case 'Literal': {
      if (typeof e.value === 'number') {
        const t = numType(e.value);
        return {c: numLit(e.value, t), t};
      }
      if (typeof e.value === 'string') return {c: cstr(e.value), t: T.str, lit: e.value};
      if (e.value === null) return {c: 'NULL', t: T.node};
      if (typeof e.value === 'boolean') return {c: e.value ? '1' : '0', t: T.i32};
      err(e, 'unsupported literal');
    }

    case 'Identifier': {
      if (HOST_FALSE.has(e.name)) return {c: '0', t: T.i32};
      if (FUSE_HI.has(e.name)) err(e, 'unfused hash pair reference ' + e.name + ' (see fuse.js)');
      const v = lookupVar(scope, e.name);
      if (v) return {c: cname(e.name), t: v.type, lv: true, local: v};
      if (globals.has(e.name) && globals.get(e.name).included) {
        const g = globals.get(e.name);
        if (g.kind === 'const') return {c: numLit(g.constVal, g.type), t: g.type};
        return {c: cname(e.name), t: g.type, lv: g.kind === 'scalar' || g.kind === 'funcptr', global: g};
      }
      if (funcs.has(e.name)) return {c: cname(e.name), t: fnt(e.name)};
      if (globals.has(e.name)) err(e, 'reference to excluded global ' + e.name);
      err(e, 'unknown identifier ' + e.name);
    }

    case 'AwaitExpression':
      return gen(e.argument, scope, cond);

    case 'SequenceExpression': {
      const parts = e.expressions.map(x => gen(x, scope, false));
      return {c: '(' + parts.map(p => p.c).join(', ') + ')', t: parts[parts.length-1].t};
    }

    case 'ArrayExpression':
      if (e.elements.length === 0) return {c: 'lz_strarr_empty()', t: T.strarr};
      err(e, 'array literals are only supported at top level');

    case 'UnaryExpression': {
      const a = gen(e.argument, scope, e.operator === '!');
      switch (e.operator) {
        case '-':
          if (a.t.k === 'unknown') return {c: '(-(' + a.c + '))', t: T.unknown};
          if (a.t.k === 'u32' || a.t.k === 'chr') return {c: '(-(int64_t)(' + a.c + '))', t: T.i64};
          return {c: '(-(' + a.c + '))', t: a.t};
        case '+': return {c: conv(a.c, a.t, T.f64), t: T.f64};
        case '!': return {c: '(!' + condC(a) + ')', t: T.i32};
        case '~': return {c: '(~' + i32(a) + ')', t: T.i32};
      }
      err(e, 'unsupported unary ' + e.operator);
    }

    case 'UpdateExpression': {
      const a = gen(e.argument, scope, false);
      return {c: e.prefix ? '(' + e.operator + a.c + ')' : '(' + a.c + e.operator + ')', t: a.t};
    }

    case 'BinaryExpression':
      return genBinary(e, scope);

    case 'LogicalExpression': {
      const l = gen(e.left, scope, cond);
      const r = gen(e.right, scope, cond);
      if (cond || (l.t.k === 'i32' && r.t.k === 'i32' && isBoolish(e.left) && isBoolish(e.right)))
        return {c: '(' + condC(l) + ' ' + e.operator + ' ' + condC(r) + ')', t: T.i32};
      if (l.t.k === 'str' || r.t.k === 'str') err(e, 'value of || or && on strings is not supported, use a ternary');
      const t = join(l.t, r.t);
      const lc = conv(l.c, l.t, t), rc = conv(r.c, r.t, t);
      if (e.operator === '||')
        return {c: '({ ' + ctype(t) + ' _t = ' + lc + '; _t ? _t : ' + rc + '; })', t};
      return {c: '({ ' + ctype(t) + ' _t = ' + lc + '; _t ? ' + rc + ' : _t; })', t};
    }

    case 'ConditionalExpression': {
      const c = gen(e.test, scope, true);
      const a = gen(e.consequent, scope, cond);
      const b = gen(e.alternate, scope, cond);
      const t = join(a.t, b.t);
      return {c: '(' + condC(c) + ' ? ' + conv(a.c, a.t, t) + ' : ' + conv(b.c, b.t, t) + ')', t};
    }

    case 'AssignmentExpression':
      return genAssign(e, scope);

    case 'MemberExpression':
      return genMember(e, scope);

    case 'CallExpression':
      return genCall(e, scope);

    case 'ArrowFunctionExpression':
      err(e, 'arrow functions are not supported');
  }

  err(e, 'unsupported expression ' + e.type);
}

function isBoolish (e) {
  if (e.type === 'ParenthesizedExpression') return isBoolish(e.expression);
  if (e.type === 'BinaryExpression') return ['===','!==','==','!=','<','>','<=','>='].includes(e.operator);
  if (e.type === 'UnaryExpression') return e.operator === '!';
  if (e.type === 'LogicalExpression') return isBoolish(e.left) && isBoolish(e.right);
  return false;
}

function unparen (e) { return e.type === 'ParenthesizedExpression' ? unparen(e.expression) : e; }

function isIntDivOr0 (e) {
  return e.type === 'BinaryExpression' && e.operator === '|' && e.right.type === 'Literal' && e.right.value === 0 &&
         unparen(e.left).type === 'BinaryExpression' && unparen(e.left).operator === '/';
}

function genBinary (e, scope) {

  const op = e.operator;

  if (isIntDivOr0(e)) {
    const d = unparen(e.left);
    const a = gen(d.left, scope, false), b = gen(d.right, scope, false);
    if (isInt(a.t) && isInt(b.t))
      return {c: 'lz_idiv((int64_t)(' + a.c + '), (int64_t)(' + b.c + '))', t: T.i32};
    return {c: 'lz_fdiv((double)(' + a.c + '), (double)(' + b.c + '))', t: T.i32};
  }

  const a = gen(e.left, scope, false);
  const b = gen(e.right, scope, false);

  switch (op) {

    case '|': case '&': case '^':
      if (a.t.k === 'u64' && b.t.k === 'u64') return {c: '(' + a.c + ' ' + op + ' ' + b.c + ')', t: T.u64};
      if ((a.t.k === 'u64' || b.t.k === 'u64') && op !== '&') return {c: '(' + conv(a.c, a.t, T.u64) + ' ' + op + ' ' + conv(b.c, b.t, T.u64) + ')', t: T.u64};
      return {c: '(' + i32(a) + ' ' + op + ' ' + i32(b) + ')', t: T.i32};

    case '<<':
      return {c: '((int32_t)((uint32_t)' + i32(a) + ' << ' + shiftCount(b) + '))', t: T.i32};

    case '>>':
      return {c: '(' + i32(a) + ' >> ' + shiftCount(b) + ')', t: T.i32};

    case '>>>':
      return {c: '((uint32_t)' + i32(a) + ' >> ' + shiftCount(b) + ')', t: T.u32};

    case '+':
      if (isStrish(a.t) || isStrish(b.t))
        return {c: 'lz_cat(' + toStr(a.c, a.t) + ', ' + toStr(b.c, b.t) + ')', t: T.str};
      // fall through
    case '-': case '*': {
      const t = arith(a.t, b.t);
      return {c: '(' + conv(a.c, a.t, t) + ' ' + op + ' ' + conv(b.c, b.t, t) + ')', t};
    }

    case '/':
      return {c: '(' + conv(a.c, a.t, T.f64) + ' / ' + conv(b.c, b.t, T.f64) + ')', t: T.f64};

    case '%': {
      if (a.t.k === 'f64' || b.t.k === 'f64')
        return {c: 'fmod(' + conv(a.c, a.t, T.f64) + ', ' + conv(b.c, b.t, T.f64) + ')', t: T.f64};
      const t = arith(a.t, b.t);
      return {c: '(' + conv(a.c, a.t, t) + ' % ' + conv(b.c, b.t, t) + ')', t};
    }

    case '===': case '==': case '!==': case '!=': case '<': case '>': case '<=': case '>=': {
      const cop = (op === '===') ? '==' : (op === '!==') ? '!=' : op;
      if (a.t.k === 'str' && b.t.k === 'str') {
        const eq = 'lz_streq(' + a.c + ', ' + b.c + ')';
        return {c: cop === '==' ? eq : '(!' + eq + ')', t: T.i32};
      }
      if (a.t.k === 'chr' && b.t.k === 'str' && b.lit !== undefined && b.lit.length === 1)
        return {c: '(' + a.c + ' ' + cop + ' ' + clit(b.lit) + ')', t: T.i32};
      if (b.t.k === 'chr' && a.t.k === 'str' && a.lit !== undefined && a.lit.length === 1)
        return {c: '(' + clit(a.lit) + ' ' + cop + ' ' + b.c + ')', t: T.i32};
      if (a.t.k === 'str' || b.t.k === 'str') {
        if (a.t.k === 'unknown' || b.t.k === 'unknown') {
          widenExpr(a.t.k === 'unknown' ? a : b, T.str);
          return {c: 'lz_streq(' + a.c + ', ' + b.c + ')', t: T.i32};
        }
        err(e, 'cannot compare ' + tstr(a.t) + ' with ' + tstr(b.t));
      }
      if (a.t.k === 'node' || b.t.k === 'node')
        return {c: '(' + a.c + ' ' + cop + ' ' + b.c + ')', t: T.i32};
      const t = cmpType(a.t, b.t);
      return {c: '(' + conv(a.c, a.t, t) + ' ' + cop + ' ' + conv(b.c, b.t, t) + ')', t: T.i32};
    }
  }

  err(e, 'unsupported binary operator ' + op);
}

function shiftCount (b) {
  if (b.t.k === 'i32' && /^\(\(int32_t\)\d+\)$/.test(b.c)) return b.c;
  return '(' + i32(b) + ' & 31)';
}

function arith (a, b) {
  if (a.k === 'unknown') return b.k === 'unknown' ? T.i32 : b;
  if (b.k === 'unknown') return a;
  if (a.k === 'f64' || b.k === 'f64') return T.f64;
  if (a.k === 'i32' && b.k === 'i32') return T.i32;
  if (a.k === 'chr' && b.k === 'i32') return T.i32;
  if (a.k === 'i32' && b.k === 'chr') return T.i32;
  return T.i64;
}

function cmpType (a, b) {
  if (a.k === 'unknown') return b.k === 'unknown' ? T.i32 : b;
  if (b.k === 'unknown') return a;
  if (a.k === 'f64' || b.k === 'f64') return T.f64;
  if (sameType(a, b)) return a;
  if (isInt(a) && isInt(b)) return T.i64;
  throw new Error('cannot compare ' + tstr(a) + ' with ' + tstr(b));
}

//}}}
//{{{  members

function genMember (e, scope) {

  const o = gen(e.object, scope, false);

  if (o.t.k === 'unknown') {
    if (!e.computed && nodeFieldType.has(e.property.name)) { widenExpr(o, T.node); o.t = T.node; }
    else return unknownOrErr(e, 'cannot infer the type of ' + o.c + ' (add a @types clue)');
  }

  if (e.computed) {
    const i = gen(e.property, scope, false);
    let idx;
    if (i.t.k === 'chr') idx = '(unsigned char)(' + i.c + ')';
    else idx = (isInt(i.t) || i.t.k === 'unknown') ? i.c : conv(i.c, i.t, T.i32);
    switch (o.t.k) {
      case 'ptr':      return {c: o.c + '[' + idx + ']', t: elemRead(o.t.elem), lv: true, elem: o.t.elem};
      case 'arr':      return {c: o.c + '[' + idx + ']', t: o.t.elem, lv: true, row2d: (o.global && o.global.kind === 'array2d') ? o.global.len2 : undefined};
      case 'nodearr':  return {c: '(&' + o.c + '[' + idx + '])', t: T.node};
      case 'str':      return {c: o.c + '[' + idx + ']', t: T.chr};
      case 'strarr':   return {c: o.c + '->s[' + idx + ']', t: T.str};
      case 'tuplearr': return {c: o.c + '[' + idx + ']', t: tuple(o.t.name, o.t.fields)};
      case 'tuple': {
        const k = evalConst(e.property);
        if (k === undefined) err(e, 'tuple index must be a constant');
        return {c: o.c + '.f' + k, t: o.t.fields[k]};
      }
    }
    err(e, 'cannot index ' + tstr(o.t));
  }

  const p = e.property.name;

  if (p === 'length') {
    switch (o.t.k) {
      case 'str':      return {c: '((int32_t)strlen(' + o.c + '))', t: T.i32};
      case 'strarr':   return {c: o.c + '->n', t: T.i32};
      case 'nodearr':  return {c: numLit(o.global.len, T.i32), t: T.i32};
      case 'tuplearr': return {c: numLit(o.t.len, T.i32), t: T.i32};
      case 'arr':      return {c: numLit(o.t.len, T.i32), t: T.i32};
      case 'ptr': {
        if (o.global && o.global.kind === 'tarray')   return {c: numLit(o.global.len, T.i32), t: T.i32};
        if (o.global && o.global.kind === 'dynarray') return {c: cname(o.global.name) + '__len', t: T.i32};
        if (o.local && o.local.len !== undefined)     return {c: numLit(o.local.len, T.i32), t: T.i32};
      }
    }
    err(e, 'cannot take length of ' + tstr(o.t));
  }

  if (o.t.k === 'node') {
    const f = nodeFieldType.get(p);
    if (!f) err(e, 'unknown node field ' + p);
    return {c: o.c + '->' + p, t: f.type, lv: f.kind === 'scalar', field: f};
  }

  err(e, 'unsupported member .' + p + ' on ' + tstr(o.t));
}

function arrayLen (o, e) {
  if (o.global && o.global.kind === 'tarray')   return numLit(o.global.len, T.i32);
  if (o.global && o.global.kind === 'dynarray') return cname(o.global.name) + '__len';
  if (o.local && o.local.len !== undefined)     return numLit(o.local.len, T.i32);
  if (o.field && o.field.kind === 'tarray')     return numLit(o.field.len, T.i32);
  if (o.row2d)                                  return numLit(o.row2d, T.i32);
  err(e, 'array length unknown for ' + o.c);
}

//}}}
//{{{  calls

const STR_METHODS = new Set(['split', 'trim', 'toLowerCase', 'toUpperCase', 'replace', 'charAt', 'charCodeAt', 'padStart']);

function regexSrc (e) {
  return (e.type === 'Literal' && e.regex) ? e.regex.pattern + '/' + e.regex.flags : null;
}

function genCall (e, scope) {

  const callee = e.callee;

  // Math.* and String.*

  if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && (callee.object.name === 'Math' || callee.object.name === 'String')) {
    const m = callee.property.name;
    const as = e.arguments.map(x => gen(x, scope, false));
    if (callee.object.name === 'String') {
      if (m === 'fromCharCode') return {c: 'lz_chrs((char)' + i32(as[0]) + ')', t: T.str};
      err(e, 'unsupported String.' + m);
    }
    switch (m) {
      case 'imul':  return {c: 'lz_imul(' + i32(as[0]) + ', ' + i32(as[1]) + ')', t: T.i32};
      case 'abs':
        if (as[0].t.k === 'i32' || as[0].t.k === 'unknown') return {c: 'lz_abs32(' + as[0].c + ')', t: T.i32};
        if (isInt(as[0].t))      return {c: 'lz_abs64(' + conv(as[0].c, as[0].t, T.i64) + ')', t: T.i64};
        return {c: 'fabs(' + as[0].c + ')', t: T.f64};
      case 'max': case 'min': {
        const t = join(as[0].t, as[1].t);
        const a = conv(as[0].c, as[0].t, t), b = conv(as[1].c, as[1].t, t);
        if (t.k === 'f64') return {c: 'f' + m + '(' + a + ', ' + b + ')', t};
        if (t.k === 'i32' || t.k === 'unknown') return {c: 'lz_' + m + '32(' + a + ', ' + b + ')', t: T.i32};
        return {c: 'lz_' + m + '64(' + conv(a, t, T.i64) + ', ' + conv(b, t, T.i64) + ')', t: T.i64};
      }
      case 'floor': case 'ceil': case 'round': case 'trunc': case 'sqrt': case 'log2':
        return {c: m + '(' + conv(as[0].c, as[0].t, T.f64) + ')', t: T.f64};
      case 'sign':   return {c: 'lz_sign(' + conv(as[0].c, as[0].t, T.f64) + ')', t: T.f64};
      case 'random': return {c: 'lozzaRandom()', t: T.f64};
    }
    err(e, 'unsupported Math.' + m);
  }

  // methods

  if (callee.type === 'MemberExpression' && !callee.computed) {

    const m = callee.property.name;
    const o = gen(callee.object, scope, false);

    if (o.t.k === 'unknown') {
      if (STR_METHODS.has(m)) { widenExpr(o, T.str); o.t = T.str; }
      else if (m === 'push' || m === 'shift' || m === 'splice') { widenExpr(o, T.strarr); o.t = T.strarr; }
      else if (m === 'toString') { widenExpr(o, T.i32); o.t = T.i32; }
      else return unknownOrErr(e, 'cannot infer the type of ' + o.c + ' (add a @types clue)');
    }

    const as = (m === 'set' || m === 'replace') ? [] : e.arguments.map(x => gen(x, scope, false));

    if (o.t.k === 'str') {
      switch (m) {
        case 'charAt':      return {c: o.c + '[' + i32(as[0]) + ']', t: T.chr};
        case 'charCodeAt':  return {c: '((int32_t)(unsigned char)' + o.c + '[' + i32(as[0]) + '])', t: T.i32};
        case 'trim':        return {c: 'lz_trim(' + o.c + ')', t: T.str};
        case 'toLowerCase': return {c: 'lz_lower(' + o.c + ')', t: T.str};
        case 'toUpperCase': return {c: 'lz_upper(' + o.c + ')', t: T.str};
        case 'padStart':    return {c: 'lz_padStart(' + o.c + ', ' + i32(as[0]) + ', ' + clit(as[1].lit) + ')', t: T.str};
        case 'replace': {
          const r = regexSrc(e.arguments[0]);
          const to = gen(e.arguments[1], scope, false).lit;
          if (r === '(\\r\\n|\\n|\\r)/gm' && to === '') return {c: 'lz_stripNewlines(' + o.c + ')', t: T.str};
          if (r === '\\s+/g' && to === ' ')             return {c: 'lz_collapseWs(' + o.c + ')', t: T.str};
          err(e, 'unsupported replace() pattern');
        }
        case 'split': {
          if (as[0].lit === undefined || as[0].lit.length !== 1) err(e, 'split() needs a one character literal separator');
          // as a declaration initialiser the caller handles ownership; otherwise use a scratch array
          return {c: 'lz_strarr_split(lz_strarr_scratch(), ' + o.c + ', ' + clit(as[0].lit) + ')', t: T.strarr, split: {src: o.c, sep: clit(as[0].lit)}};
        }
      }
      err(e, 'unsupported string method ' + m);
    }

    if (isNum(o.t) && m === 'toString') return {c: toStr(o.c, o.t), t: T.str};

    if ((o.t.k === 'arr' && o.t.elem.k === 'str') && m === 'indexOf')
      return {c: 'lz_indexOfStr(' + o.c + ', ' + o.t.len + ', ' + as[0].c + ')', t: T.i32};

    if (o.t.k === 'strarr') {
      switch (m) {
        case 'push':   return {c: 'lz_strarr_push(' + o.c + ', ' + conv(as[0].c, as[0].t, T.str) + ')', t: T.void, stmt: true};
        case 'shift':  return {c: 'lz_strarr_shift(' + o.c + ')', t: T.str};
        case 'splice':
          if (as.length !== 2 || as[1].c !== '((int32_t)1)') err(e, 'only splice(i, 1) is supported');
          return {c: 'lz_strarr_splice(' + o.c + ', ' + i32(as[0]) + ')', t: T.void, stmt: true};
      }
      err(e, 'unsupported string array method ' + m);
    }

    if (o.t.k === 'ptr' && m === 'fill') {
      const len = arrayLen(o, e);
      return {c: 'lz_fill_' + o.t.elem + '(' + o.c + ', ' + len + ', ' + conv(as[0].c, as[0].t, elemRead(o.t.elem)) + ')', t: T.void, stmt: true};
    }

    if (o.t.k === 'ptr' && m === 'set') {
      const srcE = unparen(e.arguments[0]);
      const offR = e.arguments[1] ? gen(e.arguments[1], scope, false) : null;
      const off  = offR ? conv(offR.c, offR.t, T.i64) : '0';
      if (srcE.type === 'CallExpression' && srcE.callee.type === 'MemberExpression' && srcE.callee.property.name === 'subarray') {
        const src = gen(srcE.callee.object, scope, false);
        const sa  = gen(srcE.arguments[0], scope, false);
        const sb  = gen(srcE.arguments[1], scope, false);
        if (src.t.elem !== o.t.elem) err(e, 'set() element type mismatch');
        return {c: 'memmove(' + o.c + ' + ' + off + ', ' + src.c + ' + ' + conv(sa.c, sa.t, T.i64) + ', (size_t)(' + conv(sb.c, sb.t, T.i64) + ' - ' + conv(sa.c, sa.t, T.i64) + ') * sizeof(' + ELEM_C[o.t.elem] + '))', t: T.void, stmt: true};
      }
      const src = gen(e.arguments[0], scope, false);
      if (src.t.k !== 'ptr' || src.t.elem !== o.t.elem) err(e, 'set() element type mismatch');
      const len = arrayLen(src, e);
      return {c: 'memcpy(' + o.c + ' + ' + off + ', ' + src.c + ', (size_t)(' + len + ') * sizeof(' + ELEM_C[o.t.elem] + '))', t: T.void, stmt: true};
    }

    err(e, 'unsupported method ' + m + ' on ' + tstr(o.t));
  }

  if (callee.type !== 'Identifier') err(e, 'unsupported call');

  const name = callee.name;

  // uciSend(...) -> typed sequence

  if (name === 'uciSend') {
    const as = e.arguments.map(x => gen(x, scope, false));
    let c = '{ uciSend_begin();';
    for (const a of as) {
      if (a.t.k === 'str') c += ' uciSend_s(' + a.c + ');';
      else if (a.t.k === 'f64') c += ' uciSend_d(' + a.c + ');';
      else if (a.t.k === 'chr') c += ' uciSend_s(lz_chrs(' + a.c + '));';
      else if (a.t.k === 'unknown') c += ' uciSend_s(' + a.c + ');';
      else c += ' uciSend_i(' + conv(a.c, a.t, T.i64) + ');';
    }
    c += ' uciSend_end(); }';
    return {c, t: T.void, stmt: true, block: true};
  }

  if (name === 'parseInt') {
    const a = gen(e.arguments[0], scope, false);
    if (a.t.k === 'unknown') widenExpr(a, T.str);
    return {c: 'lz_parseInt(' + toStr(a.c, a.t.k === 'unknown' ? T.str : a.t) + ')', t: T.i32};
  }

  if (NOOP.has(name)) {
    e.arguments.forEach(x => gen(x, scope, false));
    return {c: '((void)0)', t: T.void, stmt: true};
  }

  // function pointer variable

  const v = lookupVar(scope, name) || globals.get(name);
  if (v && v.type && v.type.k === 'func') {
    const f = funcs.get(v.type.name);
    return {c: cname(name) + '()', t: f.ret};
  }

  const f = funcs.get(name);
  if (!f) err(e, 'unknown function ' + name);
  if (!f.included && !f.host) err(e, 'call to excluded function ' + name);

  const as = e.arguments.map(x => gen(x, scope, false));
  const cargs = [];
  const np = f.host ? f.params.length : f.node.params.length;
  for (let i = 0; i < np; i++) {
    const pt = f.params[i] ? f.params[i].type : T.unknown;
    if (i >= as.length) { cargs.push(pt.k === 'str' ? '""' : '0'); continue; }   // missing argument
    if (!f.host) widenParam(name, i, as[i].t);
    cargs.push(pt.k === 'unknown' ? as[i].c : conv(as[i].c, as[i].t, pt));
  }
  return {c: cname(name) + '(' + cargs.join(', ') + ')', t: f.ret, voidCall: !f.hasReturnValue};
}

//}}}
//{{{  assignment

function genAssign (e, scope) {

  const op = e.operator;
  const lhsE = e.left;

  // dynamic typed array (re)allocation:  tt = new Int32Array(n)

  if (op === '=' && isNewTyped(e.right) && lhsE.type === 'Identifier' && globals.has(lhsE.name) && globals.get(lhsE.name).kind === 'dynarray') {
    const g = globals.get(lhsE.name);
    const n = gen(e.right.arguments[0], scope, false);
    return {c: 'lz_realloc_' + g.elem + '(&' + cname(g.name) + ', &' + cname(g.name) + '__len, ' + conv(n.c, n.t, T.i64) + ')', t: T.void, stmt: true};
  }

  // nodes[i] = new nodeStruct()

  if (op === '=' && e.right.type === 'NewExpression' && e.right.callee.name === 'nodeStruct') {
    const l = gen(lhsE, scope, false);
    return {c: 'nodeStruct_init(' + l.c + ')', t: T.void, stmt: true};
  }

  const l = gen(lhsE, scope, false);
  const r = gen(e.right, scope, false);

  if (!l.lv) err(e, 'not assignable: ' + l.c);

  if (lhsE.type === 'Identifier') {
    const v = lookupVar(scope, lhsE.name);
    if (v) widenLocal(v, valueType(op, l.t, r.t));
    else if (globals.has(lhsE.name)) { globals.get(lhsE.name).reassigned = true; widenGlobal(lhsE.name, valueType(op, l.t, r.t)); }
  }
  else if (lhsE.type === 'MemberExpression' && !lhsE.computed && l.field) {
    widenField(lhsE.property.name, valueType(op, l.t, r.t));
  }

  const target = l.elem ? {k: 'elem', elem: l.elem} : l.t;

  if (op === '=')
    return {c: '(' + l.c + ' = ' + storeConv(r.c, r.t, target) + ')', t: l.t};

  const bop = op.slice(0, -1);

  if (bop === '+' && (isStrish(l.t) || isStrish(r.t)))
    return {c: '(' + l.c + ' = lz_cat(' + toStr(l.c, l.t) + ', ' + toStr(r.c, r.t) + '))', t: T.str};

  if (['|','&','^'].includes(bop)) {
    if (l.t.k === 'u64') return {c: '(' + l.c + ' ' + op + ' ' + conv(r.c, r.t, T.u64) + ')', t: l.t};
    return {c: '(' + l.c + ' ' + op + ' ' + i32(r) + ')', t: l.t};
  }

  if (bop === '<<')
    return {c: '(' + l.c + ' = ' + '((int32_t)((uint32_t)' + i32(l) + ' << ' + shiftCount(r) + ')))', t: l.t};

  if (bop === '>>')
    return {c: '(' + l.c + ' = (' + i32(l) + ' >> ' + shiftCount(r) + '))', t: l.t};

  if (bop === '>>>')
    return {c: '(' + l.c + ' = ((uint32_t)' + i32(l) + ' >> ' + shiftCount(r) + '))', t: l.t};

  if (bop === '/')
    return {c: '(' + l.c + ' = ' + storeConv('(' + conv(l.c, l.t, T.f64) + ' / ' + conv(r.c, r.t, T.f64) + ')', T.f64, target) + ')', t: l.t};

  const t = arith(l.t, r.t);
  const expr = '(' + conv(l.c, l.t, t) + ' ' + bop + ' ' + conv(r.c, r.t, t) + ')';
  return {c: '(' + l.c + ' = ' + storeConv(expr, t, target) + ')', t: l.t};
}

function valueType (op, lt, rt) {
  if (op === '=') return rt;
  const bop = op.slice(0, -1);
  if (['|','&','^','<<','>>'].includes(bop)) return T.i32;
  if (bop === '>>>') return T.u32;
  if (bop === '/') return T.f64;
  if (bop === '+' && (isStrish(lt) || isStrish(rt))) return T.str;
  return arith(lt, rt);
}

function storeConv (code, from, to) {
  if (from.k === 'unknown') return code;
  if (to.k === 'elem') {
    const ct = ELEM_C[to.elem];
    if (to.elem === 'f64') return conv(code, from, T.f64);
    if (from.k === 'f64') return '((' + ct + ')(int64_t)(' + code + '))';
    if (from.k === 'chr') return code;
    if (!isInt(from)) throw new Error('cannot store ' + tstr(from) + ' into ' + to.elem + ' array');
    if (to.elem === from.k) return code;
    return '((' + ct + ')(' + code + '))';
  }
  return conv(code, from, to);
}

//}}}
//{{{  statements

let indent = '';

function ind (f) {
  const saved = indent;
  indent += '  ';
  const r = f();
  indent = saved;
  return r;
}

function newScope (parent, kind) {
  return {vars: new Map(), parent, fn: parent.fn, kind: kind || 'block', owned: []};
}

function declareLocal (scope, name, d, clue) {
  // local types persist across inference passes, keyed by the declaration position
  const f = scope.fn;
  if (!f.localTypes) f.localTypes = new Map();
  let v = f.localTypes.get(d.start);
  if (!v) { v = {type: clue || T.unknown, decl: true}; f.localTypes.set(d.start, v); }
  scope.vars.set(name, v);
  return v;
}

// frees for owned string arrays when leaving scopes

function freesFrom (scope, stopKinds) {
  const out = [];
  for (let s = scope; s; s = s.parent) {
    for (const n of s.owned) out.push('lz_strarr_free(' + n + ');');
    if (stopKinds.includes(s.kind)) break;
  }
  return out;
}

function hostFalseTest (e) {
  // if (nodeHost) -> 'false', if (!nodeHost) -> 'true', else null
  e = unparen(e);
  if (e.type === 'Identifier' && HOST_FALSE.has(e.name)) return 'false';
  if (e.type === 'UnaryExpression' && e.operator === '!' && unparen(e.argument).type === 'Identifier' && HOST_FALSE.has(unparen(e.argument).name)) return 'true';
  return null;
}

function genStmt (s, scope, out) {

  switch (s.type) {

    case 'EmptyStatement':
      return;

    case 'BlockStatement': {
      const inner = newScope(scope);
      out.push(indent + '{');
      ind(() => {
        for (const st of s.body) genStmt(st, inner, out);
        for (const f of freesFrom(inner, ['block'])) out.push(indent + f);
      });
      out.push(indent + '}');
      return;
    }

    case 'ExpressionStatement': {
      const r = gen(s.expression, scope, false);
      out.push(indent + r.c + (r.block ? '' : ';'));
      return;
    }

    case 'VariableDeclaration': {
      for (const d of s.declarations) {
        const name = d.id.name;
        const clue = clueByLine.get(s.loc.start.line);

        if (s.kind === 'var') {
          const v = lookupVar(scope, name);
          if (d.init) {
            const r = gen(d.init, scope, false);
            widenLocal(v, r.t);
            out.push(indent + cname(name) + ' = ' + conv(r.c, r.t, v.type) + ';');
          }
          continue;
        }

        // local typed array

        if (d.init && isNewTyped(d.init)) {
          const elem = TYPED_ARRAYS[d.init.callee.name];
          const len = evalConst(d.init.arguments[0]);
          if (len === undefined) err(s, 'local typed array needs a constant size');
          declareLocal(scope, name, d, ptr(elem)).len = len;
          out.push(indent + ELEM_C[elem] + ' ' + cname(name) + '[' + len + '] = {0};');
          continue;
        }

        // owned string arrays:  const x = []  |  const x = s.split(c)

        if (d.init && d.init.type === 'ArrayExpression' && d.init.elements.length === 0) {
          declareLocal(scope, name, d, T.strarr);
          out.push(indent + 'strarr_t ' + cname(name) + '_s; strarr_t* ' + cname(name) + ' = &' + cname(name) + '_s; lz_strarr_init(' + cname(name) + ');');
          scope.owned.push(cname(name));
          continue;
        }

        const v = declareLocal(scope, name, d, clue);

        if (d.init) {
          const r = gen(d.init, scope, false);
          if (r.split) {
            widenLocal(v, T.strarr);
            out.push(indent + 'strarr_t ' + cname(name) + '_s; strarr_t* ' + cname(name) + ' = &' + cname(name) + '_s; lz_strarr_init(' + cname(name) + '); lz_strarr_split(' + cname(name) + ', ' + r.split.src + ', ' + r.split.sep + ');');
            scope.owned.push(cname(name));
            continue;
          }
          if (!clue) widenLocal(v, r.t);
          const t = v.type.k === 'unknown' ? r.t : v.type;
          out.push(indent + ctype(t) + ' ' + cname(name) + ' = ' + conv(r.c, r.t, t) + ';');
        }
        else {
          const t = v.type.k === 'unknown' ? T.i32 : v.type;
          out.push(indent + ctype(t) + ' ' + cname(name) + ' = 0;');
        }
      }
      return;
    }

    case 'ReturnStatement': {
      const fn = scope.fn;
      const frees = freesFrom(scope, ['function']);
      if (s.argument) {
        const r = gen(s.argument, scope, false);
        if (r.voidCall) {
          out.push(indent + r.c + ';');
          for (const f of frees) out.push(indent + f);
          out.push(indent + 'return;');
          return;
        }
        widenReturn(fn.name, r.t);
        fn.hasReturnValue = true;
        const t = fn.ret.k === 'unknown' ? r.t : fn.ret;
        if (frees.length) {
          out.push(indent + '{ ' + ctype(t) + ' _r = ' + conv(r.c, r.t, t) + ';');
          for (const f of frees) out.push(indent + '  ' + f);
          out.push(indent + '  return _r; }');
        }
        else
          out.push(indent + 'return ' + conv(r.c, r.t, t) + ';');
      }
      else {
        for (const f of frees) out.push(indent + f);
        out.push(indent + 'return;');
      }
      return;
    }

    case 'IfStatement': {
      const hf = hostFalseTest(s.test);
      if (hf === 'false') { if (s.alternate) genStmt(s.alternate, scope, out); return; }
      if (hf === 'true')  { genStmt(s.consequent, scope, out); return; }
      const c = gen(s.test, scope, true);
      out.push(indent + 'if (' + condC(c) + ')');
      genSub(s.consequent, scope, out);
      if (s.alternate) {
        out.push(indent + 'else');
        genSub(s.alternate, scope, out);
      }
      return;
    }

    case 'WhileStatement': {
      const inner = newScope(scope, 'loop');
      const c = gen(s.test, inner, true);
      out.push(indent + 'while (' + condC(c) + ')');
      genSub(s.body, inner, out);
      return;
    }

    case 'DoWhileStatement': {
      const inner = newScope(scope, 'loop');
      out.push(indent + 'do');
      genSub(s.body, inner, out);
      const c = gen(s.test, inner, true);
      out.push(indent + 'while (' + condC(c) + ');');
      return;
    }

    case 'ForStatement': {
      const inner = newScope(scope, 'loop');
      let init = '';
      if (s.init) {
        if (s.init.type === 'VariableDeclaration') {
          if (s.init.kind === 'var') {
            init = s.init.declarations.map(d => { const v = lookupVar(scope, d.id.name); const r = gen(d.init, scope, false); widenLocal(v, r.t); return cname(d.id.name) + ' = ' + conv(r.c, r.t, v.type); }).join(', ');
          }
          else {
            const parts = [];
            let t0 = null;
            for (const d of s.init.declarations) {
              const v = declareLocal(inner, d.id.name, d, null);
              const r = gen(d.init, inner, false);
              widenLocal(v, r.t);
              const t = v.type.k === 'unknown' ? r.t : v.type;
              if (!t0) t0 = t;
              parts.push(cname(d.id.name) + ' = ' + conv(r.c, r.t, t));
            }
            init = ctype(t0) + ' ' + parts.join(', ');
          }
        }
        else init = gen(s.init, inner, false).c;
      }
      const test = s.test ? condC(gen(s.test, inner, true)) : '';
      const upd  = s.update ? gen(s.update, inner, false).c : '';
      out.push(indent + 'for (' + init + '; ' + test + '; ' + upd + ')');
      genSub(s.body, inner, out);
      return;
    }

    case 'BreakStatement':
      for (const f of freesFrom(scope, ['loop', 'switch'])) out.push(indent + f);
      out.push(indent + 'break;');
      return;

    case 'ContinueStatement':
      for (const f of freesFrom(scope, ['loop'])) out.push(indent + f);
      out.push(indent + 'continue;');
      return;

    case 'SwitchStatement': {
      const d = gen(s.discriminant, scope, false);
      const sw = newScope(scope, 'switch');

      if (d.t.k === 'str') {
        // string switch -> if chain inside do { } while (0) so break works
        out.push(indent + 'do {');
        ind(() => {
          out.push(indent + 'const char* _sw = ' + d.c + ';');
          let tests = [];
          let first = true;
          for (const c of s.cases) {
            if (c.test) {
              const t = gen(c.test, scope, false);
              if (t.t.k !== 'str') err(c, 'string switch needs string cases');
              tests.push('lz_streq(_sw, ' + t.c + ')');
            }
            if (c.consequent.length === 0) continue;   // grouped labels
            const last = c.consequent[c.consequent.length - 1];
            if (last.type !== 'BreakStatement' && last.type !== 'ReturnStatement' && !(last.type === 'BlockStatement' && last.body.length && ['BreakStatement', 'ReturnStatement'].includes(last.body[last.body.length-1].type)))
              err(c, 'fall through in a string switch is not supported');
            const head = c.test === null && tests.length === 0 ? 'else' : (first ? 'if' : 'else if');
            if (head === 'else') out.push(indent + 'else {');
            else out.push(indent + head + ' (' + tests.join(' || ') + ') {');
            first = false;
            tests = [];
            const inner = newScope(sw);
            ind(() => { for (const st of c.consequent) genStmt(st, inner, out); });
            out.push(indent + '}');
          }
        });
        out.push(indent + '} while (0);');
        return;
      }

      out.push(indent + 'switch (' + (d.t.k === 'chr' ? d.c : conv(d.c, d.t, T.i32)) + ') {');
      ind(() => {
        for (const c of s.cases) {
          if (c.test) {
            const t = gen(c.test, scope, false);
            if (d.t.k === 'chr') out.push(indent + 'case ' + clit(t.lit) + ':');
            else out.push(indent + 'case ' + t.c + ':');
          }
          else out.push(indent + 'default:');
          const inner = newScope(sw);
          ind(() => { for (const st of c.consequent) genStmt(st, inner, out); });
        }
      });
      out.push(indent + '}');
      return;
    }

    case 'FunctionDeclaration':
      err(s, 'nested functions are not supported');
  }

  err(s, 'unsupported statement ' + s.type);
}

function genSub (s, scope, out) {
  // always braced: a single statement may expand to several C lines (frees + break etc)
  if (s.type === 'BlockStatement') { genStmt(s, scope, out); return; }
  const inner = newScope(scope);
  out.push(indent + '{');
  ind(() => { genStmt(s, inner, out); for (const f of freesFrom(inner, ['block'])) out.push(indent + f); });
  out.push(indent + '}');
}

//}}}
//{{{  functions

function collectVars (node, names) {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'VariableDeclaration' && node.kind === 'var')
    for (const d of node.declarations) names.add(d.id.name);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach(x => collectVars(x, names));
    else if (v && typeof v.type === 'string') collectVars(v, names);
  }
}

function genFunction (f) {

  const scope = {vars: new Map(), parent: null, fn: f, kind: 'function', owned: []};

  for (const p of f.params) {
    p.param = true;
    scope.vars.set(p.name, p);
  }

  const hoisted = new Set();
  collectVars(f.node.body, hoisted);
  for (const name of hoisted) {
    if (!f.hoistTypes) f.hoistTypes = new Map();
    if (!f.hoistTypes.has(name)) f.hoistTypes.set(name, {type: T.unknown, hoisted: true});
    scope.vars.set(name, f.hoistTypes.get(name));
  }

  const body = [];
  const saved = indent;
  indent = '  ';
  for (const st of f.node.body.body) genStmt(st, scope, body);
  for (const fr of freesFrom(scope, ['function'])) body.push(indent + fr);
  indent = saved;

  const ret = f.hasReturnValue ? (f.ret.k === 'unknown' ? T.i32 : f.ret) : T.void;
  const params = f.params.map(p => ctype(p.type.k === 'unknown' ? T.i32 : p.type) + ' ' + cname(p.name)).join(', ') || 'void';

  const out = [];
  out.push(ctype(ret) + ' ' + cname(f.name) + '(' + params + ') {');
  for (const name of hoisted) {
    const v = f.hoistTypes.get(name);
    const t = v.type.k === 'unknown' ? T.i32 : v.type;
    out.push('  ' + ctype(t) + ' ' + cname(name) + ' = ' + (t.k === 'ptr' || t.k === 'node' || t.k === 'str' || t.k === 'strarr' ? 'NULL' : '0') + ';');
  }
  out.push(...body);
  if (ret.k !== 'void') out.push('  return 0;');
  out.push('}');

  f.code = out.join('\n');
  f.proto = ctype(ret) + ' ' + cname(f.name) + '(' + params + ');';
}

function genAll () {
  for (const [name, f] of funcs)
    if (f.included) {
      try { genFunction(f); }
      catch (e) { throw new Error('in function ' + name + ': ' + e.message); }
    }
}

for (let iter = 0; iter < 30; iter++) {
  changed = false;
  genAll();
  if (!changed) break;
  if (iter === 29) throw new Error('type inference did not converge');
}

finalPass = true;
genAll();

for (const [name, f] of funcs)
  if (f.included && f.code.includes('LZ_UNKNOWN')) {
    const line = f.code.split('\n').find(l => l.includes('LZ_UNKNOWN'));
    throw new Error('type of something in ' + name + ' could not be inferred: ' + line.trim());
  }

//}}}
//{{{  emit

const out = [];

out.push('// generated by lozza2c from ' + SRC + ' - do not edit');
out.push('');
out.push('#include <stdint.h>');
out.push('#include <string.h>');
out.push('#include <stdlib.h>');
out.push('#include <stdio.h>');
out.push('#include <math.h>');
out.push('');
out.push(fs.readFileSync(__dirname + '/lozza_rt.h', 'utf8'));
out.push('');

if (nodeFields) {
  out.push('typedef struct node_s node_t;');
  out.push('struct node_s {');
  for (const f of nodeFields) {
    if (f.kind === 'tarray') out.push('  ' + ELEM_C[f.elem] + ' ' + f.name + '[' + f.len + '];');
    else out.push('  ' + ctype(f.type) + ' ' + f.name + ';');
  }
  out.push('};');
  out.push('');
}

// tuple tables

for (const [jsname, g] of globals)
  if (g.included && g.kind === 'tuplearr')
    out.push('typedef struct { ' + g.fields.map((t, k) => ctype(t) + ' f' + k + ';').join(' ') + ' } lz_tuple_' + jsname + ';');
out.push('');

out.push('// host functions');
for (const name of Object.keys(HOST)) {
  const h = HOST[name];
  out.push(ctype(T[h.ret]) + ' ' + name + '(' + (h.params.map(p => ctype(T[p])).join(', ') || 'void') + ');');
}
out.push('void uciSend_begin(void); void uciSend_s(const char*); void uciSend_i(int64_t); void uciSend_d(double); void uciSend_end(void);');
out.push('uint64_t twisterRand64(void);');
if (globals.has('tt')) out.push('static inline uint64_t ttLoad64(int32_t i); static inline void ttStore64(int32_t i, uint64_t v);');
out.push('');

out.push('// engine functions');
for (const [name, f] of funcs)
  if (f.included) out.push(f.proto);
out.push('');

for (const [name, g] of globals)
  if (g.included && g.kind === 'funcptr') {
    const f = funcs.get(g.initName);
    const ret = f.hasReturnValue ? ctype(f.ret) : 'void';
    out.push('typedef ' + ret + ' (*lz_fn_' + g.initName + ')(void);');
  }
out.push('');

const initGlobals = [];
const topScope = {vars: new Map(), parent: null, fn: null, kind: 'function', owned: []};

for (const [jsname, g] of globals) {
  if (!g.included) continue;
  const name = cname(jsname);
  switch (g.kind) {
    case 'const':
      if (!['INT32_MAX', 'INT32_MIN', 'UINT32_MAX'].includes(name))
        out.push('#define ' + name + ' ' + numLit(g.constVal, g.type));
      break;
    case 'tarray':
      if (g.values) out.push('static ' + ELEM_C[g.elem] + ' ' + name + '[' + g.len + '] = {' + g.values.join(', ') + '};');
      else out.push('static ' + ELEM_C[g.elem] + ' ' + name + '[' + g.len + '];');
      break;
    case 'dynarray':
      out.push('static ' + ELEM_C[g.elem] + '* ' + name + ' = NULL; static int32_t ' + name + '__len = 0;');
      initGlobals.push('  lz_realloc_' + g.elem + '(&' + name + ', &' + name + '__len, ' + gen(g.lenSrc, topScope, false).c + ');');
      break;
    case 'nodearr':
      out.push('static node_t ' + name + '[' + g.len + '];');
      break;
    case 'array2d':
      out.push('static ' + ELEM_C[g.elem] + ' ' + name + '[' + g.len + '][' + g.len2 + '];');
      break;
    case 'strarray':
      out.push('static const char* ' + name + '[' + g.len + '] = {' + g.values.map(cstr).join(', ') + '};');
      break;
    case 'strq':
      out.push('static strarr_t ' + name + '_s; static strarr_t* ' + name + ' = &' + name + '_s;');
      break;
    case 'ptrarray':
      out.push('static ' + g.elemC + ' ' + name + '[' + g.len + '] = {' + g.values.map(cname).join(', ') + '};');
      break;
    case 'ptrarray2':
      out.push('static ' + g.elemC + ' ' + name + '[' + g.len + '][' + g.len2 + '] = {' + g.values.map(r => '{' + r.map(cname).join(', ') + '}').join(', ') + '};');
      break;
    case 'tuplearr':
      out.push('static lz_tuple_' + jsname + ' ' + name + '[' + g.len + '] = {' + g.values.map(r => '{' + r.join(', ') + '}').join(', ') + '};');
      break;
    case 'chartable':
      out.push('static int32_t ' + name + '[128] = {' + g.values.map(([k, v]) => '[' + clit(k) + '] = ' + v).join(', ') + '};');
      break;
    case 'numtable':
      out.push('static const char* ' + name + '[' + g.len + '] = {' + g.values.map(([k, v]) => '[' + k + '] = ' + cstr(v)).join(', ') + '};');
      break;
    case 'funcptr':
      out.push('static lz_fn_' + g.initName + ' ' + name + ' = ' + cname(g.initName) + ';');
      break;
    case 'scalar': {
      let t = g.type;
      let init = '0';
      if (g.init) {
        if (g.init.type === 'Literal' && g.init.value === null) { init = 'NULL'; if (t.k === 'unknown') t = T.node; }
        else {
          const r = gen(g.init, topScope, false);
          if (t.k === 'unknown') t = r.t;
          init = conv(r.c, r.t, t);
        }
      }
      if (t.k === 'unknown') t = T.i32;
      out.push('static ' + ctype(t) + ' ' + name + ' = ' + init + ';');
      break;
    }
    default:
      throw new Error('unhandled global kind ' + g.kind + ' for ' + name);
  }
}
out.push('');

if (nodeFields) {
  out.push('void nodeStruct_init(node_t* n) {');
  out.push('  memset(n, 0, sizeof(node_t));');
  for (const f of nodeFields)
    if (f.kind === 'scalar' && f.init) out.push('  n->' + f.name + ' = ' + f.init + ';');
  out.push('}');
  out.push('');
}

out.push('void lz_initGlobals(void) {');
out.push(...initGlobals);
out.push('}');
out.push('');

for (const [name, f] of funcs)
  if (f.included) { out.push(f.code); out.push(''); }

// a fused pair of random draws: the lo draw is the low word

out.push('uint64_t twisterRand64(void) { uint64_t lo = twisterRand(); uint64_t hi = twisterRand(); return lo | (hi << 32); }');
out.push('');

// the tt key as one uint64 in words i and i+1 of tt (see fuse.js); clang merges the two
// word accesses into one 64 bit mov (an 8 byte memcpy did the same but that build was
// blocked by Windows application control, see test.sh notes)

if (globals.has('tt')) {
  out.push('static inline uint64_t ttLoad64(int32_t i) { return (uint64_t)(uint32_t)tt[i] | ((uint64_t)(uint32_t)tt[i+1] << 32); }');
  out.push('static inline void ttStore64(int32_t i, uint64_t v) { tt[i] = (int32_t)(uint32_t)v; tt[i+1] = (int32_t)(uint32_t)(v >> 32); }');
  out.push('');
}

fs.writeFileSync(OUT, out.join('\n'));

let nf = 0, ng = 0;
for (const f of funcs.values()) if (f.included) nf++;
for (const g of globals.values()) if (g.included) ng++;
console.log('lozza2c: wrote ' + OUT + ' (' + nf + ' functions, ' + ng + ' globals)');

//}}}

# lozza2c

Builds native Linux and Windows binaries of the [Lozza](https://github.com/op12no2/lozza)
chess engine from its JavaScript source. `lozza.js` is parsed with [acorn](https://github.com/acornjs/acorn), converted to C
and compiled with clang. The result plays identically to `node lozza.js`: same bench node
count, same search output, same datagen, just faster.

This is not a general JavaScript to C tool. It converts the subset of JavaScript that
Lozza is written in (int32 arithmetic, typed arrays, plain functions, strings only at
the UCI edge) and nothing more. If a construct in lozza.js is awkward to convert, the
JavaScript is rewritten in a simpler way rather than the transpiler extended; for example the TT.

## Files

| file | purpose |
|---|---|
| `lozza2c.js` | the transpiler: lozza.js in, `lozza_core.c` out |
| `fuse.js` | AST pass that fuses Lozza's lo/hi int32 hash pairs into one uint64 |
| `lozza_rt.h` | runtime helpers included by the generated C: strings, typed arrays, clock |
| `runtime_uci.c` | the host program: stdin/stdout UCI loop, clock, exit, net weights, random, datagen files |
| `embed_weights.js` | turns a weights `.bin` into `weights_blob.h` for a release build |
| `build.sh` | transpile and build `lozza` (Linux) and `lozza.exe` (Windows) |
| `test.sh` | checks the binaries against `node lozza.js` |

`lozza_core.c` is generated, but a snapshot retained for interest. 
It is refreshed now and then, not on every change; its first line
names the lozza commit it was generated from. 
The other generated files (`weights_blob.h`, `lozza`, `lozza.exe`) are ignored by git.

## Requirements

- node (any recent version) and `npm ci` once for acorn, which `build.sh` does for you
- clang and lld
- for the Windows cross build, the Windows SDK and CRT headers as unpacked by
  [cargo-xwin](https://github.com/rust-cross/cargo-xwin) in `~/.cache/cargo-xwin/xwin`

## Usage

The lozza repo is expected next to this one as `../lozza`. Point elsewhere with `LOZZA`.

```
./build.sh                      # dev build from ../lozza/lozza.js, reads the weights file named in it
./build.sh weights.bin          # release build with the weights embedded
./build.sh weights.bin x.js     # release build from another source file
./test.sh                       # compare ./lozza and ./lozza.exe with node ../lozza/lozza.js
LOZZA=/path/lozza.js ./test.sh  # compare against another source
```

The lozza repo's `bin/release.sh` calls `../lozza2c/build.sh` with the release weights and the
release source, copies the binaries into `releases/<version>/`, and benches the dev source, the
release source and both binaries, which must all report the same node count.

## How it works

- Functions and globals are taken from the main folds of lozza.js (`//{{{ name` ... `//}}}`):
  constants, utils, prng, net, board, nodes, tt, moves, evaluate, search, uci and datagen.
  Folds are also how a global is attributed to its owner, so a missing fold close makes
  everything after it disappear from the build.
- Host functions are the ones node provides in lozza.js (file access, console output, the
  weights buffer) and are excluded from the conversion with `--exclude`; `runtime_uci.c`
  implements the same names in C. `BUILD` is passed with `--extra` so the version string is kept.
- Types are inferred from use. `|0` style int32 arithmetic becomes `int32_t`, typed arrays
  become fixed C arrays, `Math.imul` becomes a multiply, `set(subarray())` becomes memmove
  and `fill` becomes memset. A function that nothing calls yet with string parameters needs a
  `// @types a:str b:strarr` clue after its signature, since there is no call to infer from.
- Lozza keeps its 64 bit zobrist hashes as lo/hi int32 pairs because JavaScript has no 64 bit
  integers. `fuse.js` recognises the pairs (`loHash`/`hiHash`, `loObjPieces`/`hiObjPieces`,
  `loRights`/`hiRights`, `loEP`/`hiEP`, `loTurn`/`hiTurn`, `repLoHash`/`repHiHash`) when the
  lo and hi statements are adjacent and turns them into single uint64 operations. The tt keeps
  its key in two adjacent words of one `Int32Array`; `tt[i] = loHash; tt[i+1] = hiHash` and
  the matching comparisons become `ttStore64`/`ttLoad64` helpers.
- Strings pass through fixed buffers (`LZ_BUF`, `LZ_STRARR_CAP` in `lozza_rt.h`), sized for a
  position command with thousands of plies. The Windows clock is QueryPerformanceCounter
  because GetTickCount64 only ticks every 15.6 ms.

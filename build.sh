#!/bin/bash
#
# build.sh [weights.bin] [source.js]
#
# Converts lozza.js (default ../lozza/lozza.js, or $LOZZA) to C and builds linux and windows
# binaries here. With a weights file the net is embedded (release), otherwise
# the binaries read the file named in lozza.js (dev).
#

set -e
cd "$(dirname "$0")"

CFLAGS="-O3 -march=x86-64-v3 -fwrapv -Wall -Wno-parentheses-equality -Wno-unused-variable -Wno-unused-but-set-variable -Wno-unused-function"

SRC=${2:-${LOZZA:-../lozza/lozza.js}}

# acorn (the JS parser) is pinned in package-lock.json; install it on a fresh clone
if [ ! -d node_modules/acorn ]; then
  echo "installing acorn"
  npm ci --silent --no-audit --no-fund
fi

node lozza2c.js "$SRC" lozza_core.c --exclude getWeightsBuffer,boardCheck,uciSend,initUci,yieldChannel,yieldResolve,fs --extra BUILD

if [ -n "$1" ]; then
  node embed_weights.js "$1" weights_blob.h
  CFLAGS="$CFLAGS -DLOZZA_WEIGHTS_H=\"weights_blob.h\""
fi

clang $CFLAGS -o lozza runtime_uci.c -lm

X=~/.cache/cargo-xwin/xwin

# -w: the windows sdk headers are noisy under clang and none of it is ours

clang --target=x86_64-pc-windows-msvc -fuse-ld=lld $CFLAGS -w \
  -I$X/crt/include -I$X/sdk/include/ucrt -I$X/sdk/include/um -I$X/sdk/include/shared \
  -L$X/crt/lib/x86_64 -L$X/sdk/lib/um/x86_64 -L$X/sdk/lib/ucrt/x86_64 \
  runtime_uci.c -o lozza.exe

ls -l lozza lozza.exe

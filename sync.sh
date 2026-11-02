#!/bin/bash
#
# sync.sh - refresh the committed copy of the generated C
#
# Rebuilds from ../lozza/lozza.js (or $LOZZA), runs test.sh, and if lozza_core.c
# changed commits and pushes it with the lozza commit it came from in the message.
# Refuses if lozza.js has uncommitted changes, so the stamp always names a real commit.
#

set -e
cd "$(dirname "$0")"

SRC=${LOZZA:-../lozza/lozza.js}

if ! git -C "$(dirname "$SRC")" diff --quiet -- "$(basename "$SRC")"; then
  echo "$SRC has uncommitted changes: commit it first so lozza_core.c can name the commit"
  exit 1
fi

./build.sh
./test.sh

if git diff --quiet -- lozza_core.c; then
  echo "lozza_core.c unchanged, nothing to commit"
  exit 0
fi

lz=$(head -1 lozza_core.c | sed -n 's/.*lozza commit \([^ ]*\).*/\1/p')

git commit -q -m "regenerate lozza_core.c for lozza $lz" -- lozza_core.c
git push -q
echo "committed and pushed lozza_core.c for lozza $lz"

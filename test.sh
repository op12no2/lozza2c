#!/bin/bash
#
# test.sh - checks the C build against node lozza.js
#

cd "$(dirname "$0")"
L=${LOZZA:-../lozza/lozza.js}
BOOK=$(dirname "$L")/books/noob_4moves.epd
fail=0
same () { if [ "$1" = "$2" ]; then echo "ok   $3"; else echo "FAIL $3"; diff <(echo "$1") <(echo "$2") | head -6; fail=1; fi; }
strip () { sed 's/ time [0-9]* nps [0-9]*//' | grep -v '^info tt'; }

A=$(./lozza uci q | grep -c 'id name Lozza'); same "$A" "1" "uci id"
A=$(./lozza qb q | grep -o 'nodes [0-9]*'); B=$(node $L qb q 2>&1 | tr '\r' '\n' | grep -o 'nodes [0-9]*' | tail -1); same "$A" "$B" "bench nodes"
A=$(printf 'uci\nisready\nposition startpos moves e2e4 e7e5\ngo depth 8\n' | ./lozza | grep -E '^(uciok|readyok|bestmove)' | wc -l); same "$A" "3" "pipe uci/isready/go"
A=$(printf 'position startpos\ngo depth 6\n' | ./lozza | grep -c '^bestmove'); same "$A" "1" "eof without quit"
A=$( (echo "go infinite"; sleep 1; echo stop; echo quit) | timeout 10 ./lozza | grep -c '^bestmove'); same "$A" "1" "stop during go infinite"
A=$( (echo "go movetime 1500"; sleep 0.3; echo isready; sleep 2; echo quit) | timeout 10 ./lozza | grep -E '^(readyok|bestmove)' | cut -d' ' -f1 | tr '\n' ' '); same "$A" "readyok bestmove " "isready during search"
s=$(date +%s%N); ./lozza "position startpos" "go movetime 500" q > /dev/null; e=$(date +%s%N); ms=$(( (e-s)/1000000 )); [ $ms -ge 450 ] && [ $ms -le 900 ] && echo "ok   movetime ($ms ms)" || { echo "FAIL movetime ($ms ms)"; fail=1; }
F="r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"
A=$(./lozza "position fen $F moves e1g1 a6e2" b q | tail -1); B=$(node $L "position fen $F moves e1g1 a6e2" b q | tail -1); same "$A" "$B" "position moves + board"
# a move list longer than 1024 chars (the old string buffer size dropped the last move)
LP="position startpos moves$(for i in $(seq 60); do printf " g1f3 g8f6 f3g1 f6g8"; done) e2e4"
A=$(./lozza "$LP" b q | tail -1); B=$(node $L "$LP" b q | tail -1); same "$A" "$B" "long position (${#LP} chars)"
A=$(./lozza "position startpos" "go depth 10" q | grep -E '^(info depth|bestmove)' | strip); B=$(node $L "position startpos" "go depth 10" q | grep -E '^(info depth|bestmove)' | strip); same "$A" "$B" "info lines depth 10"
A=$(./lozza "setoption name MultiPV value 3" "position fen $F" "go depth 6" q | grep -E 'multipv|bestmove' | strip); B=$(node $L "setoption name MultiPV value 3" "position fen $F" "go depth 6" q | grep -E 'multipv|bestmove' | strip); same "$A" "$B" "multipv"
A=$(./lozza et q | grep -v '^info tt'); B=$(node $L et q | grep -v '^info tt'); same "$A" "$B" "eval tests"
A=$(./lozza "position fen $F" "perft depth 3" q | grep -o 'nodes [0-9]*'); same "$A" "nodes 97862" "perft"
A=$(./lozza "setoption name Hash value 64" "position startpos" "go depth 8" q | grep -c bestmove); same "$A" "1" "hash resize"
A=$(./lozza n q | grep -c 'i_size'); same "$A" "1" "net cmd"
A=$(./lozza "position startpos" m q | grep -c '^[a-h][1-8][a-h][1-8]'); same "$A" "20" "moves cmd"
A=$(./lozza "pt n 12" q | tail -1 | grep -o 'errors [0-9]*'); same "$A" "errors 0" "perft tests (12)"
# datagen: a few games to a temp dir; every line must be fen | score | result and two instances must differ
D=$(mktemp -d); ./lozza "datagen games 3 nodes 300 randply 2 dir $D book $BOOK" q > /dev/null; ./lozza "datagen games 3 nodes 300 randply 2 dir $D book $BOOK" q > /dev/null
A=$(ls $D/dg_*.txt | wc -l); same "$A" "2" "datagen files"
A=$(cat $D/dg_*.txt | grep -Evc '^([pnbrqkPNBRQK1-8]+/){7}[pnbrqkPNBRQK1-8]+ [wb] (-|[KQkq]+) (-|[a-h][36]) 0 1 \| -?[0-9]+ \| (1\.0|0\.5|0\.0)$'); B=$(cat $D/dg_*.txt | wc -l); [ "$A" = "0" ] && [ "$B" -gt 0 ] && echo "ok   datagen lines ($B)" || { echo "FAIL datagen lines ($A bad of $B)"; fail=1; }
A=$(for f in $D/dg_*.txt; do head -1 $f; done | sort -u | wc -l); same "$A" "2" "datagen instances differ"
rm -rf $D
if [ -f lozza.exe ]; then
  A2=$(./lozza.exe qb q | tr -d '\r' | grep -o 'nodes [0-9]*'); B2=$(./lozza qb q | grep -o 'nodes [0-9]*'); same "$A2" "$B2" "windows bench nodes"
  A=$( (echo "go infinite"; sleep 1; echo stop; echo quit) | timeout 20 ./lozza.exe | tr -d '\r' | grep -c '^bestmove'); same "$A" "1" "windows stop during search"
  A=$(printf 'position startpos moves e2e4\r\ngo depth 5\r\n' | ./lozza.exe | tr -d '\r' | grep -c '^bestmove'); same "$A" "1" "windows crlf input"
fi
exit $fail

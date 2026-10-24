#!/usr/bin/env bash
# End-to-end: Tracegate on examples/sample-repo, in a throwaway copy.
#
#   1. copy the sample to a temp dir, install it, commit it (a footprint names a commit)
#   2. run the whole lane recorded, in shadow; footprints are ingested
#   3. edit multiply() and commit → select under enforce → ONLY multiply.test.ts;
#      run that selection recorded (ingested again)
#   (each scenario below is one change on top of that recorded commit)
#   4. edit whisper(), which no test runs → nothing selected
#   5. edit add() → add.test.ts and report.test.ts (formatTotal calls add)
#   6. edit data/rates.json, which one test reads → ONLY rates.test.ts
# Every selection is ASSERTED; the script exits non-zero on a mismatch.
# Low priority on purpose: nice 19, two vitest workers. KEEP=1 keeps the work dir.
set -euo pipefail
TG="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tracegate-e2e.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)" # the tool reports realpaths
[ "${KEEP:-}" = 1 ] || trap 'rm -rf "$WORK"' EXIT
echo "== work dir: $WORK"
rsync -a --exclude node_modules --exclude package-lock.json "$TG/examples/sample-repo/" "$WORK/"
cd "$WORK"
npm pkg set "devDependencies.tracegate-ci=file:$TG"
# --install-links copies the package in as a registry install would.
# --legacy-peer-deps: npm 10 crashes resolving vite's optional devtools peers (vitest@*).
nice -n 19 npm install --install-links --legacy-peer-deps --no-audit --no-fund --loglevel=error
commit() { git add -A && git -c user.email=e2e@example.invalid -c user.name=e2e -c commit.gpgsign=false commit -qm "$1"; }
git init -q
commit base
export TRACEGATE_HOST=e2e
TGX="nice -n 19 npx --no-install tracegate"
n=0
# expect_selection <label> <expected test files…> — select under enforce, audit 0, and compare.
expect_selection() {
  local label="$1"; shift; n=$((n + 1))
  $TGX select --run "$WORK/.sel$n" --mode enforce --audit 0 > "$WORK/.sel$n.log"
  sed 's/^/   /' "$WORK/.sel$n.log"
  local got want
  got="$(sed "s|^$WORK/||" "$WORK/.sel$n/selected.txt" | sort | tr '\n' ' ')"
  want="$(printf '%s\n' "$@" | sed '/^$/d' | sort | tr '\n' ' ')"
  if [ "$got" = "$want" ]; then echo "   ✓ $label → [ $got]"; else echo "   ✗ $label → got [ $got], want [ $want]"; exit 1; fi
}

echo; echo "== 1. the whole lane, recorded, in shadow"
$TGX run --mode shadow -- --maxWorkers=2

echo; echo "== 2. edit multiply(), commit, select"
sed -i.bak 's/return round(a \* b);/return round(a * b * 1);/' src/math.ts && rm src/math.ts.bak
commit 'edit multiply'
expect_selection 'an edit to multiply()' test/multiply.test.ts
echo "-- run that selection, recorded"
$TGX run --mode enforce --audit 0 -- --maxWorkers=2
# Every later scenario starts from this recorded commit, so each is one change.
REC="$(git rev-parse HEAD)"

echo; echo "== 3. edit whisper() (no test runs it), commit, select"
git checkout -q --detach "$REC"
sed -i.bak "s/return s.toLowerCase() + '...';/return s.toLowerCase() + '…';/" src/strings.ts && rm src/strings.ts.bak
commit 'edit whisper'
expect_selection 'an edit to whisper()' ''

echo; echo "== 4. edit add(), commit, select"
git checkout -q --detach "$REC"
sed -i.bak 's/return round(a + b);/return round(b + a);/' src/math.ts && rm src/math.ts.bak
commit 'edit add'
expect_selection 'an edit to add()' test/add.test.ts test/report.test.ts

echo; echo "== 5. edit data/rates.json (read by one test), commit, select"
git checkout -q --detach "$REC"
echo '{ "standard": 0.2, "reduced": 0.06 }' > data/rates.json
commit 'edit rates'
expect_selection 'an edit to a data file' test/rates.test.ts

echo; echo "== status"
$TGX status
echo; echo "== e2e: all selections as expected"

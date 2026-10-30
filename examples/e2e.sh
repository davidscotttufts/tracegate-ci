#!/usr/bin/env bash
# End-to-end: Tracegate on examples/sample-repo, in a throwaway copy.
# SAMPLE=sample-repo-jest runs the same scenarios on the Jest copy of it.
#
#   0. tracegate doctor --canary on it
#   1. copy the sample to a temp dir, install it, commit it (a footprint names a commit)
#   2. run the whole lane recorded, in shadow; footprints are ingested
#   3. edit multiply() and commit → select under enforce → ONLY multiply.test.ts;
#      run that selection recorded (ingested again)
#   (each scenario below is one change on top of that recorded commit)
#   4. edit whisper(), which no test runs → nothing selected
#   5. edit add() → add.test.ts and report.test.ts (formatTotal calls add)
#   6. edit data/rates.json, which one test reads → ONLY rates.test.ts
#   7. the add() edit left uncommitted → the same two files; the run records no
#      full run and no attestation evidence
# Every selection is ASSERTED; the script exits non-zero on a mismatch.
# Low priority on purpose: nice 19, two vitest workers. KEEP=1 keeps the work dir.
set -euo pipefail
TG="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tracegate-e2e.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)" # the tool reports realpaths
[ "${KEEP:-}" = 1 ] || trap 'rm -rf "$WORK"' EXIT
echo "== work dir: $WORK"
SAMPLE="${SAMPLE:-sample-repo}"
rsync -a --exclude node_modules --exclude package-lock.json "$TG/examples/$SAMPLE/" "$WORK/"
cd "$WORK"
RUNNER="$(node -p "Object.values(require('./tracegate.config.json').lanes)[0].runner || 'vitest'")"
npm pkg set "devDependencies.tracegate-ci=file:$TG"
# VITEST_VERSION=<v>: run against another Vitest (examples/vitest-matrix.sh).
[ -n "${VITEST_VERSION:-}" ] && npm pkg set "devDependencies.vitest=$VITEST_VERSION"
# TYPESCRIPT_VERSION=7 TS_ALIAS_VERSION=6: a repository on TypeScript 7, with 6
# installed beside it under the alias Tracegate looks for (src/model.mjs).
[ -n "${TYPESCRIPT_VERSION:-}" ] && npm pkg set "devDependencies.typescript=$TYPESCRIPT_VERSION"
[ -n "${TS_ALIAS_VERSION:-}" ] && npm pkg set "devDependencies.tracegate-typescript=npm:typescript@$TS_ALIAS_VERSION"
# Vitest 5 takes vite as a peer, which --legacy-peer-deps below does not install.
[ -n "${VITE_VERSION:-}" ] && npm pkg set "devDependencies.vite=$VITE_VERSION"
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

if [ "$RUNNER" != jest ]; then
  echo; echo "== 0. doctor: the setup is ready and the recorder's seam maps"
  $TGX doctor --canary | tee "$WORK/.doctor.log"
fi
if [ -n "${TS_ALIAS_VERSION:-}" ]; then
  echo "   typescript $(node -p "require('typescript/package.json').version"), tracegate-typescript $(node -p "require('tracegate-typescript/package.json').version")"
  if grep -q '(as tracegate-typescript)' "$WORK/.doctor.log"; then echo "   ✓ the predictor parses with the alias"; else echo "   ✗ the alias was not used"; exit 1; fi
fi

echo; echo "== 1. the whole lane, recorded, in shadow"
$TGX run --mode shadow -- --maxWorkers=2 | tee "$WORK/.run1.log"
echo "   $RUNNER $(node -p "require('$RUNNER/package.json').version")"
# STRICT_SEAM=1: every loaded module must be mapped (the recorder's seam held).
if [ "${STRICT_SEAM:-}" = 1 ]; then
  share="$(sed -n 's/.*unmapped modules \([0-9.]*\)%.*/\1/p' "$WORK/.run1.log" | tail -1)"
  [ -n "$share" ] || { echo "   ✗ no ingest line in the run output"; exit 1; }
  if [ "$share" = "0.0" ]; then echo "   ✓ seam mapped: unmapped modules 0.0%"; else echo "   ✗ seam moved: unmapped modules $share%"; exit 1; fi
fi

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

echo; echo "== savings and the report card, from the two recorded runs"
$TGX savings
$TGX savings --json > "$WORK/.savings.json"
$TGX report-card --json --out "$WORK/.card.json" > /dev/null
node -e '
  const [s] = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const c = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8")).lanes[0];
  const ok = s.runs === 2 && s.timedRuns === 2 && s.reusableFiles === 4 && s.misses === 0
    && c.observations.runs === 2 && c.observations.enforce === 1 && c.misses.missed === 0;
  console.log(`   ${ok ? "✓" : "✗"} savings: ${s.reusableFiles} of ${s.files} file runs reusable over ${s.runs} runs; card: ${c.observations.runs} runs, ${c.misses.missed} misses`);
  process.exit(ok ? 0 : 1);' "$WORK/.savings.json" "$WORK/.card.json"

echo; echo "== 6. uncommitted changes: selected against the working tree, never evidence about HEAD"
git checkout -q --detach "$REC"
sed -i.bak 's/return round(a + b);/return round(b + a);/' src/math.ts && rm src/math.ts.bak
expect_selection 'an UNCOMMITTED edit to add()' test/add.test.ts test/report.test.ts
LEDGER="$(git rev-parse --git-common-dir)/tracegate"
lines() { cat "$LEDGER/$1" 2>/dev/null | wc -l | tr -d ' '; }
full0="$(lines full-e2e.tsv)"; green0="$(lines green-e2e.tsv)"
$TGX run --mode shadow -- --maxWorkers=2 > "$WORK/.run6.log"
grep -E '^tracegate' "$WORK/.run6.log" | sed 's/^/   /'
if grep -q 'not recorded as a full run' "$WORK/.run6.log" && [ "$(lines full-e2e.tsv)" = "$full0" ] && [ "$(lines green-e2e.tsv)" = "$green0" ]; then
  echo "   ✓ no full-run row and no attestation evidence from a dirty tree"
else echo "   ✗ a dirty tree was recorded (full $full0 → $(lines full-e2e.tsv), green $green0 → $(lines green-e2e.tsv))"; exit 1; fi
git checkout -q -- src/math.ts
echo; echo "== e2e: all selections as expected"

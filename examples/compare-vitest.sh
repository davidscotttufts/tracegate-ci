#!/usr/bin/env bash
# Tracegate vs Vitest `experimental.recordDependencies`, on the same commits.
#
# A throwaway copy of examples/sample-repo plus examples/compare-fixtures (a test
# that runs a script as a child process). At the base commit both tools record:
# Vitest writes dependencies.json, Tracegate writes footprints. Each scenario is
# then ONE commit on top of the base, and for each we print:
#   tracegate   `tracegate select --mode enforce --audit 0`
#   vitest      `vitest list --changed HEAD~1 --filesOnly --experimental.recordDependencies`
#   fails       the files that FAIL on a full run at that commit: the ones a
#               selection must not leave out
# Every selection is ASSERTED, so a change in either tool shows up here.
#   OUT=docs/compare/vitest-record-dependencies.md  also write the table there.
# VITEST_VERSION (default 5.0.5) and VITE_VERSION (8) pick the Vitest under test.
set -euo pipefail
TG="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tracegate-compare.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-}" = 1 ] || trap 'rm -rf "$WORK"' EXIT
VITEST_VERSION="${VITEST_VERSION:-5.0.5}"; VITE_VERSION="${VITE_VERSION:-8}"
OUT_ABS=""; [ -n "${OUT:-}" ] && OUT_ABS="$(cd "$(dirname "$OUT")" 2>/dev/null && pwd)/$(basename "$OUT")"
echo "== work dir: $WORK"
rsync -a --exclude node_modules --exclude package-lock.json "$TG/examples/sample-repo/" "$WORK/"
rsync -a "$TG/examples/compare-fixtures/" "$WORK/"
cd "$WORK"
npm pkg set "devDependencies.tracegate-ci=file:$TG" "devDependencies.vitest=$VITEST_VERSION" "devDependencies.vite=$VITE_VERSION"
nice -n 19 npm install --install-links --legacy-peer-deps --no-audit --no-fund --loglevel=error
commit() { git add -A && git -c user.email=cmp@example.invalid -c user.name=cmp -c commit.gpgsign=false commit -qm "$1"; }
git init -q
commit base
BASE="$(git rev-parse HEAD)"
export TRACEGATE_HOST=compare
TGX="nice -n 19 npx --no-install tracegate"
VT="nice -n 19 npx --no-install vitest"
V="$(node -p "require('vitest/package.json').version")"

echo; echo "== record at the base: Vitest's dependencies.json, then Tracegate's footprints"
$VT run --experimental.recordDependencies --maxWorkers=2 > /dev/null
$TGX run --mode shadow -- --maxWorkers=2 > /dev/null

ROWS=""; n=0; bad=0
list() { sed '/^$/d' | sort | tr '\n' ' ' | sed 's/ $//'; }
# scenario <label> <what the edit is> <want tracegate> <want vitest> — the edit is
# applied by the caller first; it is committed here.
scenario() {
  local label="$1" what="$2" want_tg="$3" want_vt="$4"; n=$((n + 1))
  commit "$label"
  $TGX select --run "$WORK/.sel$n" --mode enforce --audit 0 > /dev/null
  local tg vt fails
  tg="$(sed "s|^$WORK/||" "$WORK/.sel$n/selected.txt" | list)"
  vt="$($VT list --changed HEAD~1 --filesOnly --experimental.recordDependencies 2>/dev/null | grep '\.test\.' | list || true)"
  $VT run --reporter=json --outputFile="$WORK/.full$n.json" --maxWorkers=2 > /dev/null 2>&1 || true
  fails="$(node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const r of j.testResults) if (r.status === "failed") console.log(require("path").relative(process.argv[2], r.name));
  ' "$WORK/.full$n.json" "$WORK" | list)"
  local missed_tg="" missed_vt="" f
  for f in $fails; do
    case " $tg " in *" $f "*) ;; *) missed_tg="$missed_tg $f" ;; esac
    case " $vt " in *" $f "*) ;; *) missed_vt="$missed_vt $f" ;; esac
  done
  echo; echo "== $n. $label"
  echo "   tracegate: [ $tg ]${missed_tg:+  MISSED:$missed_tg}"
  echo "   vitest:    [ $vt ]${missed_vt:+  MISSED:$missed_vt}"
  echo "   fails:     [ $fails ]"
  [ "$tg" = "$want_tg" ] || { echo "   ✗ tracegate selection changed: want [ $want_tg ]"; bad=$((bad + 1)); }
  [ "$vt" = "$want_vt" ] || { echo "   ✗ vitest selection changed: want [ $want_vt ]"; bad=$((bad + 1)); }
  cell() { local s="$1" m="$2" c; c="$(echo "$s" | wc -w | tr -d ' ')"; echo "$c${m:+ — **misses${m}**}"; }
  ROWS="$ROWS| $label | $what | $(cell "$tg" "$missed_tg") | $(cell "$vt" "$missed_vt") | ${fails:-none} |
"
  git checkout -q --detach "$BASE"
}

# 1. A function in a shared module: Tracegate keys on the function, Vitest on the module.
sed -i.bak 's/return round(a \* b);/return round(a * b + 1);/' src/math.ts && rm src/math.ts.bak
scenario 'edit multiply() in src/math.ts' 'breaks multiply()' \
  'test/multiply.test.ts' 'test/add.test.ts test/multiply.test.ts test/rates.test.ts test/report.test.ts'
# 2. A function no test executes, in a module three tests load.
sed -i.bak "s/return s.toLowerCase() + '...';/return s.toLowerCase() + '…';/" src/strings.ts && rm src/strings.ts.bak
scenario 'edit whisper() in src/strings.ts' 'no test runs it' \
  '' 'test/rates.test.ts test/report.test.ts test/strings.test.ts'
# 3. A data file read with fs at call time: not a module, so not in Vitest's record.
echo '{ "standard": 0.25, "reduced": 0.05 }' > data/rates.json
scenario 'edit data/rates.json' 'a value a test asserts' \
  'test/rates.test.ts' ''
# 4. A script a test runs as a child process: neither tool records the child.
sed -i.bak "s/console.log('hello');/console.log('hullo');/" scripts/greet.mjs && rm scripts/greet.mjs.bak
scenario 'edit scripts/greet.mjs' 'run by a test as a child process' \
  '' ''
# 5. A lockfile change: a patch bump of a package the test process loads.
node -e '
  const fs = require("fs"); const l = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  const p = l.packages["node_modules/chai"]; p.version = p.version.replace(/\d+$/, (x) => String(Number(x) + 1));
  fs.writeFileSync("package-lock.json", JSON.stringify(l, null, 2) + "\n");'
scenario 'bump chai in package-lock.json' 'a patch release, nothing installed' \
  "$(git ls-files 'test/*.test.ts' | list)" ''

TABLE="| Scenario | Change | Tracegate selects | Vitest selects | Fails on a full run |
|---|---|---|---|---|
$ROWS"
echo; echo "== table (vitest $V)"; echo "$TABLE"
if [ -n "$OUT_ABS" ]; then
  mkdir -p "$(dirname "$OUT_ABS")"
  {
    echo "<!-- Generated by examples/compare-vitest.sh; do not edit by hand. -->"
    echo "# Tracegate vs Vitest \`recordDependencies\`"
    echo
    echo "Generated $(date -u +%Y-%m-%d) by \`OUT=docs/compare/vitest-record-dependencies.md bash examples/compare-vitest.sh\`, against Vitest $V. The repository is \`examples/sample-repo\` plus \`examples/compare-fixtures\`: $(git ls-files 'test/*.test.ts' | wc -l | tr -d ' ') test files. Both tools record at the same base commit, and each scenario is one commit on top of it."
    echo
    echo "- **Tracegate:** \`tracegate select --mode enforce --audit 0\`, so no audit sample is added."
    echo "- **Vitest:** \`vitest list --changed HEAD~1 --filesOnly --experimental.recordDependencies\`."
    echo "- **Fails on a full run:** the files a selection must include."
    echo
    echo "$TABLE"
    cat "$TG/docs/compare/notes.md"
  } > "$OUT_ABS"
  echo "== written to $OUT_ABS"
fi
[ "$bad" = 0 ] || { echo "== compare: $bad selection(s) changed"; exit 1; }
echo "== compare: all selections as expected"

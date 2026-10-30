#!/usr/bin/env bash
# The recorder hooks a Vitest internal (src/recorder.mjs, "HOW COVERAGE IS MAPPED").
# Run the end-to-end once per supported Vitest version and fail if any version
# leaves modules unmapped: unmapped is safe (it runs) but it means the seam moved.
#   VITEST_VERSIONS="4.1.11 5" bash examples/vitest-matrix.sh
# Keep this list in step with peerDependencies.vitest in package.json.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VERSIONS="${VITEST_VERSIONS:-4.1.11 4 5}"
for v in $VERSIONS; do
  echo "==== vitest $v"
  vite=""
  case "$v" in 5*) vite=8 ;; esac # Vitest 5 takes vite as a peer
  VITEST_VERSION="$v" VITE_VERSION="$vite" STRICT_SEAM=1 bash "$HERE/e2e.sh"
done
echo "==== vitest matrix: the seam is mapped on: $VERSIONS"

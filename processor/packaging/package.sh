#!/bin/sh
# Build a pinned Node layout: npm ci from lockfile, compile, omit test sources from dist tree.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"
node -e 'const v=process.versions.node.split(".").map(Number); if(v[0]<22||(v[0]===22&&v[1]<12)) process.exit(1)'
npm ci
npm run build
echo '{"status":"packed","node":"'"$(node -v)"'","dir":"'"$ROOT"'"}'

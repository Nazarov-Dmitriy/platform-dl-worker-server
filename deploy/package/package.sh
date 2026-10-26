#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
REVISION=$(git rev-parse --short=12 HEAD)
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then REVISION="$REVISION-dirty"; fi
IMAGE=${DISPATCHER_IMAGE:-worker-dispatcher:$REVISION}
OUT=${1:-$ROOT/deploy/releases}
mkdir -p "$OUT"
OUT=$(CDPATH='' cd -- "$OUT" && pwd)
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT HUP INT TERM
docker build --platform linux/amd64 --target test -t "worker-dispatcher-tests:$REVISION" .
docker build --platform linux/amd64 -t "$IMAGE" .
cp worker deploy/package/manage.py deploy/package/compose.yaml deploy/package/fingerprint.py deploy/package/README.md "$STAGE/"
docker image save -o "$STAGE/image.tar" "$IMAGE"
gzip "$STAGE/image.tar"
mv "$STAGE/image.tar.gz" "$STAGE/dispatcher-image.tar.gz"
printf 'DISPATCHER_IMAGE=%s\nDISPATCHER_IMAGE_FINGERPRINT=%s\n' "$IMAGE" "$(python3 deploy/package/fingerprint.py "$IMAGE")" > "$STAGE/release.env"
chmod 755 "$STAGE/worker"
(cd "$STAGE" && sha256sum worker manage.py compose.yaml fingerprint.py README.md release.env dispatcher-image.tar.gz > SHA256SUMS)
ARCHIVE="$OUT/worker-server-linux-amd64-$REVISION.tgz"
tar -czf "$ARCHIVE" -C "$STAGE" .
printf 'Ready package: %s\n' "$ARCHIVE"

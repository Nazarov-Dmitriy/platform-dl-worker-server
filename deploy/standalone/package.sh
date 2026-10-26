#!/bin/sh
# Run on a machine with Docker; the VPS receives ready images, not Go source.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
REVISION=$(git rev-parse --short=12 HEAD)
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then REVISION="$REVISION-dirty"; fi
IMAGE=${DISPATCHER_IMAGE:-worker-dispatcher:$REVISION}
OUT=${1:-$ROOT/bin/releases}
mkdir -p "$OUT"
OUT=$(CDPATH='' cd -- "$OUT" && pwd)
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT HUP INT TERM

docker build --platform linux/amd64 --target test -t "worker-dispatcher-tests:$REVISION" .
docker build --platform linux/amd64 -t "$IMAGE" .
docker pull --platform linux/amd64 nginx:1.28.0-alpine
cp deploy/standalone/compose.yaml deploy/standalone/nginx.conf \
   deploy/standalone/install.sh deploy/standalone/setup.py deploy/standalone/fingerprint.py \
   deploy/standalone/export.sh deploy/standalone/export.py \
   deploy/standalone/README.md "$STAGE/"
# Save both images. No registry login or build is needed on the destination VPS.
docker image save -o "$STAGE/images.tar" "$IMAGE" nginx:1.28.0-alpine
gzip "$STAGE/images.tar"
mv "$STAGE/images.tar.gz" "$STAGE/dispatcher-image.tar.gz"
printf 'DISPATCHER_IMAGE=%s\nDISPATCHER_IMAGE_FINGERPRINT=%s\nTLS_IMAGE_FINGERPRINT=%s\n' \
  "$IMAGE" "$(python3 deploy/standalone/fingerprint.py "$IMAGE")" \
  "$(python3 deploy/standalone/fingerprint.py nginx:1.28.0-alpine)" > "$STAGE/release.env"
chmod 755 "$STAGE/install.sh" "$STAGE/export.sh"
(cd "$STAGE" && sha256sum compose.yaml nginx.conf install.sh setup.py fingerprint.py export.sh export.py README.md dispatcher-image.tar.gz release.env > SHA256SUMS)
ARCHIVE="$OUT/worker-server-linux-amd64-$REVISION.tgz"
tar -czf "$ARCHIVE" -C "$STAGE" .
printf 'Release bundle: %s\n' "$ARCHIVE"

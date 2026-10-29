#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
REVISION=$(git rev-parse --short=12 HEAD)
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then REVISION="$REVISION-dirty"; fi
VERSION=${WORKER_RELEASE_VERSION:-worker-v0.0.0}
if [ "$VERSION" != worker-v0.0.0 ]; then
  python3 -c 'import re,sys;assert re.fullmatch(r"worker-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)",sys.argv[1]), "Invalid release version"' "$VERSION"
  REVISION=$VERSION
fi
IMAGE=${DISPATCHER_IMAGE:-worker-dispatcher:$REVISION}
OUT=${1:-$ROOT/releases/linux/server}
mkdir -p "$OUT"
OUT=$(CDPATH='' cd -- "$OUT" && pwd)
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT HUP INT TERM
docker build --platform linux/amd64 --target test -t "worker-dispatcher-tests:$REVISION" .
docker build --platform linux/amd64 -t "$IMAGE" .
cp worker deploy/package/manage.py deploy/package/compose.yaml deploy/package/fingerprint.py deploy/package/update.py deploy/package/README.md "$STAGE/"
docker image save -o "$STAGE/image.tar" "$IMAGE"
gzip "$STAGE/image.tar"
mv "$STAGE/image.tar.gz" "$STAGE/dispatcher-image.tar.gz"
printf 'DISPATCHER_IMAGE=%s\nDISPATCHER_IMAGE_FINGERPRINT=%s\n' "$IMAGE" "$(python3 deploy/package/fingerprint.py "$IMAGE")" > "$STAGE/release.env"
printf '%s\n' "$VERSION" > "$STAGE/VERSION"
chmod 755 "$STAGE/worker"
(cd "$STAGE" && sha256sum worker manage.py compose.yaml fingerprint.py update.py README.md release.env VERSION dispatcher-image.tar.gz > SHA256SUMS)
ARCHIVE="$OUT/worker-server-linux-amd64-$REVISION.tgz"
tar -czf "$ARCHIVE" -C "$STAGE" .
if [ "$VERSION" != worker-v0.0.0 ]; then
  python3 - "$ARCHIVE" "$VERSION" "$OUT/worker-update.json" <<'PY'
import hashlib,json,sys
from pathlib import Path
path=Path(sys.argv[1])
with path.open("rb") as stream: checksum=hashlib.file_digest(stream,"sha256").hexdigest()
Path(sys.argv[3]).write_text(json.dumps({"protocol":1,"version":sys.argv[2],"asset":path.name,"sha256":checksum})+"\n")
PY
fi
printf 'Ready package: %s\n' "$ARCHIVE"

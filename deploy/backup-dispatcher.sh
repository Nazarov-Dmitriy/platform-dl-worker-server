#!/bin/sh
# Host copy of process-taken SQLite snapshots. Do not copy a live dispatcher.db.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"
KEEP=${KEEP:-7}
LOCAL=${LOCAL:-$ROOT/data/backups}
mkdir -p "$LOCAL"
docker compose exec -T dispatcher wget -q -O /dev/null http://127.0.0.1:8090/readyz
CID=$(docker compose ps -q dispatcher)
VOL=$(docker inspect -f '{{ range .Mounts }}{{ if eq .Destination "/data" }}{{ .Name }}{{ end }}{{ end }}' "$CID")
docker run --rm -v "${VOL}:/data:ro" -v "${LOCAL}:/out" alpine:3.23 \
  sh -c 'mkdir -p /out; cp -a /data/backups/. /out/ 2>/dev/null || true'
python3 - "$LOCAL" "$KEEP" <<'PY'
import os, sys
d, keep = sys.argv[1], int(sys.argv[2])
names = sorted(n for n in os.listdir(d) if n.startswith("dispatcher-") and n.endswith(".db"))
for n in names[:-keep] if keep < len(names) else []:
    os.remove(os.path.join(d, n))
PY
if [ -n "${DISPATCHER_BACKUP_S3_URI:-}" ]; then
  aws s3 sync "$LOCAL" "$DISPATCHER_BACKUP_S3_URI" --exclude '*' --include 'dispatcher-*.db'
fi
ls -1 "$LOCAL"

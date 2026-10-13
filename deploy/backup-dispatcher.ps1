# Copy retained SQLite snapshots from the compose volume. Do not copy a live dispatcher.db.
param(
  [int]$Keep = 7,
  [string]$Local = (Join-Path (Split-Path $PSScriptRoot -Parent) "data\backups")
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
New-Item -ItemType Directory -Force -Path $Local | Out-Null
docker compose exec -T dispatcher wget -q -O /dev/null http://127.0.0.1:8090/readyz
$cid = docker compose ps -q dispatcher
$vol = docker inspect -f '{{ range .Mounts }}{{ if eq .Destination "/data" }}{{ .Name }}{{ end }}{{ end }}' $cid
# On Docker Desktop the volume is inside the VM; copy via a helper container.
docker run --rm -v "${vol}:/data:ro" -v "${Local}:/out" alpine:3.23 sh -c "cp -a /data/backups/. /out/ 2>/dev/null || true"
Get-ChildItem $Local -Filter "dispatcher-*.db" | Sort-Object Name | Select-Object -SkipLast $Keep | Remove-Item -Force
if ($env:DISPATCHER_BACKUP_S3_URI) {
  aws s3 sync $Local $env:DISPATCHER_BACKUP_S3_URI --exclude "*" --include "dispatcher-*.db"
}
Get-ChildItem $Local -Filter "dispatcher-*.db" | Select-Object Name

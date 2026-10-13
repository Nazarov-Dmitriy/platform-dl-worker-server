param([switch]$Race)
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    go vet ./...
    if ($LASTEXITCODE -ne 0) { throw 'go vet failed' }
    if ($Race) { go test -race ./... } else { go test ./... }
    if ($LASTEXITCODE -ne 0) { throw 'go test failed' }
    python contracts/validate.py
    if ($LASTEXITCODE -ne 0) { throw 'contract validation failed' }
    git diff --check
    if ($LASTEXITCODE -ne 0) { throw 'diff check failed' }
} finally {
    Pop-Location
}

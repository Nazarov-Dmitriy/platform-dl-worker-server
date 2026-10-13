param([switch]$Race, [switch]$Processor)
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    go vet ./...
    if ($LASTEXITCODE -ne 0) { throw 'go vet failed' }
    if ($Race) { go test -race ./... } else { go test ./... }
    if ($LASTEXITCODE -ne 0) { throw 'go test failed' }
    python contracts/validate.py
    if ($LASTEXITCODE -ne 0) { throw 'contract validation failed' }
    if ($Processor) {
        go build -o bin/dispatcher.exe ./cmd/dispatcher
        if ($LASTEXITCODE -ne 0) { throw 'dispatcher build failed' }
        $previousDispatcherPath = $env:E2E_DISPATCHER
        $env:E2E_DISPATCHER = (Resolve-Path bin/dispatcher.exe).Path
        Push-Location processor
        try {
            npm test
            if ($LASTEXITCODE -ne 0) { throw 'processor tests failed' }
        } finally {
            Pop-Location
            $env:E2E_DISPATCHER = $previousDispatcherPath
        }
    }
    git diff --check
    if ($LASTEXITCODE -ne 0) { throw 'diff check failed' }
} finally {
    Pop-Location
}

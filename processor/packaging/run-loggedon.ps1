param([Parameter(Mandatory=$true)][string]$Node, [Parameter(Mandatory=$true)][string]$Root, [Parameter(Mandatory=$true)][string]$Config, [Parameter(Mandatory=$true)][string]$TokenFile)
$ErrorActionPreference = "Stop"
$line = Get-Content -LiteralPath $TokenFile | Where-Object { $_ -match '^PROCESSOR_TOKEN=' } | Select-Object -First 1
if (-not $line) { throw "PROCESSOR_TOKEN_FILE_INVALID" }
$env:PROCESSOR_TOKEN = $line.Substring(16).Trim()
if (-not $env:PROCESSOR_TOKEN) { throw "PROCESSOR_TOKEN_FILE_INVALID" }
Set-Location -LiteralPath $Root
& $Node (Join-Path $Root "dist\main.js") $Config
exit $LASTEXITCODE

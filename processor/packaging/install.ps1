# Install or remove a logon Scheduled Task for the processor. Token stays in a 600-mode file, not in config.json.
param(
  [string]$Config = (Join-Path (Split-Path $PSScriptRoot -Parent) "config.json"),
  [string]$TokenFile = (Join-Path (Split-Path $PSScriptRoot -Parent) "data\processor.token"),
  [switch]$Disable
)
$ErrorActionPreference = "Stop"
$Name = "TitunkiProcessor"
$Root = Split-Path $PSScriptRoot -Parent
if ($Disable) {
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output '{"status":"autostart-disabled"}'
  exit 0
}
$node = (Get-Command node).Source
if (-not (Test-Path $Config)) { throw "CONFIG_REQUIRED" }
if (-not (Test-Path $TokenFile)) { throw "PROCESSOR_TOKEN_FILE_REQUIRED" }
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$Root\dist\main.js`" `"$Config`"" -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$env = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Principal $env -Force | Out-Null
# Token is injected by a wrapper so it is not stored in the task XML.
$wrapper = Join-Path $Root "packaging\run-loggedon.cmd"
@"
@echo off
for /f "usebackq tokens=1,* delims==" %%A in ("$TokenFile") do if /I "%%A"=="PROCESSOR_TOKEN" set PROCESSOR_TOKEN=%%B
cd /d "$Root"
"$node" dist\main.js "$Config"
"@ | Set-Content -Encoding ascii $wrapper
$action = New-ScheduledTaskAction -Execute $wrapper -WorkingDirectory $Root
Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Principal $env -Force | Out-Null
Write-Output '{"status":"autostart-enabled","task":"TitunkiProcessor"}'

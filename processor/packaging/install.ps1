# Install or remove a logon Scheduled Task for the processor. Token stays in an owner-restricted file, not in config.json.
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
# Restrict the token to its owner and SYSTEM before enabling the task.
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner((New-Object System.Security.Principal.NTAccount($identity)))
foreach ($account in @($identity, 'NT AUTHORITY\SYSTEM')) {
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($account, 'FullControl', 'Allow')))
}
Set-Acl -LiteralPath $TokenFile -AclObject $acl
$wrapper = Join-Path $Root "packaging\run-loggedon.ps1"
$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$wrapper`" -Node `"$node`" -Root `"$Root`" -Config `"$Config`" -TokenFile `"$TokenFile`""
$shellExecutable = Join-Path $PSHOME "pwsh.exe"
if (-not (Test-Path -LiteralPath $shellExecutable)) { $shellExecutable = Join-Path $PSHOME "powershell.exe" }
$action = New-ScheduledTaskAction -Execute $shellExecutable -Argument $arguments -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive
Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Output '{"status":"autostart-enabled","task":"TitunkiProcessor"}'

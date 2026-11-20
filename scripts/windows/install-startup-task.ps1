<#
  Starts the tournament server automatically when the laptop boots, and restarts it if it ever stops.
  Run ONCE in an Administrator PowerShell, from anywhere:
      powershell -ExecutionPolicy Bypass -File scripts\windows\install-startup-task.ps1
  Options:
      -Port 3000
      -BackupMirrorDir E:\badminton-backups     second copy of every backup (USB stick)
      -AtLogon                                  start when YOU sign in (use if node is installed per-user)
  Remove it later with uninstall-startup-task.ps1.
#>
param(
  [int]$Port = 3000,
  [string]$MongoUri = 'mongodb://127.0.0.1:27017/badminton',
  [string]$BackupMirrorDir = '',
  [string]$TaskName = 'BadmintonTournamentServer',
  [switch]$AtLogon
)
$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Open PowerShell with "Run as administrator" and try again.' }

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$node = (Get-Command node -ErrorAction Stop).Source
$entry = Join-Path $repo 'apps\api\dist\server.js'
if (-not (Test-Path $entry)) { throw "The server is not built yet. Run 'npm run build' in $repo first." }
if (-not $AtLogon -and $node -like "$env:USERPROFILE*") {
  Write-Warning "Node is installed under your user profile ($node). The boot-time task runs as SYSTEM and may not find it. Re-run with -AtLogon, or install Node for all users."
}

$logs = Join-Path $repo 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

# A tiny launcher so the task needs no machine-wide environment variables.
$runner = Join-Path $logs 'run-server.cmd'
$lines = @(
  '@echo off',
  "cd /d `"$repo`"",
  "set PORT=$Port",
  "set MONGO_URI=$MongoUri"
)
if ($BackupMirrorDir) { $lines += "set BACKUP_MIRROR_DIR=$BackupMirrorDir" }
$lines += "`"$node`" `"$entry`" >> `"$logs\server.log`" 2>&1"
Set-Content -Path $runner -Value $lines -Encoding ASCII

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$runner`"" -WorkingDirectory $repo
if ($AtLogon) {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
} else {
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $trigger.Delay = 'PT30S'   # give the MongoDB service time to start first
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
}
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed the task '$TaskName' and started it."
Write-Host "  Log file:  $logs\server.log"
Write-Host "  Check it:  npm run doctor"
Write-Host "  Stop it:   Stop-ScheduledTask -TaskName $TaskName"

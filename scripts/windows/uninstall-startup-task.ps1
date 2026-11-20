<#
  Removes the start-at-boot task made by install-startup-task.ps1 (the program and data are untouched).
  Run in an Administrator PowerShell.
#>
param([string]$TaskName = 'BadmintonTournamentServer')
$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Open PowerShell with "Run as administrator" and try again.' }

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed the task '$TaskName'. If the server is still running, close its window or stop the node process."
} else {
  Write-Host "No task named '$TaskName' was found."
}

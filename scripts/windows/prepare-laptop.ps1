<#
  Stops the laptop from sleeping or doing anything clever in the middle of a tournament (while plugged in).
  Run in an Administrator PowerShell:
      powershell -ExecutionPolicy Bypass -File scripts\windows\prepare-laptop.ps1
  Changes (plugged-in only): never sleep, never hibernate, closing the lid does nothing, screen stays on 30 min.
  Undo any of them in Windows Settings > System > Power.
#>
$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Open PowerShell with "Run as administrator" and try again.' }

powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 30
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT
Write-Host 'Power settings updated for when the laptop is plugged in.'
Write-Host ''
Write-Host 'Do these by hand (Windows does not let a script do them safely):'
Write-Host '  1. Settings > Windows Update > Pause updates for 1 week (a restart in the middle of a match stops scoring).'
Write-Host '  2. Plug the laptop in, preferably connect it to the router with an Ethernet cable.'
Write-Host '  3. Close other programs. Then run:  npm run doctor'

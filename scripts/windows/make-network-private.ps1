<#
  Windows blocks incoming connections on networks it calls "Public". At the venue the router's
  network must be "Private" for phones to reach the laptop.
  List your connections:   powershell -ExecutionPolicy Bypass -File scripts\windows\make-network-private.ps1
  Switch one to Private:   ... -InterfaceAlias "Wi-Fi"     (or "Ethernet")
  Only do this for the event router, never for a cafe or hotel network.
#>
param([string]$InterfaceAlias = '')
$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Open PowerShell with "Run as administrator" and try again.' }

if (-not $InterfaceAlias) {
  Write-Host 'Connections on this laptop:'
  Get-NetConnectionProfile | Format-Table InterfaceAlias, Name, NetworkCategory -AutoSize
  Write-Host 'Run again with  -InterfaceAlias "<name>"  to make that connection Private.'
  return
}
Set-NetConnectionProfile -InterfaceAlias $InterfaceAlias -NetworkCategory Private
Write-Host "'$InterfaceAlias' is now a Private network."

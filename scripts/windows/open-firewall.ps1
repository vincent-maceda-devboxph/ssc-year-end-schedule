<#
  Lets phones on the venue Wi-Fi reach the server: opens ONE inbound TCP port on PRIVATE networks only.
  Run in an Administrator PowerShell:
      powershell -ExecutionPolicy Bypass -File scripts\windows\open-firewall.ps1 -Port 3000
  MongoDB is never opened: it stays on 127.0.0.1.
#>
param([int]$Port = 3000)
$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Open PowerShell with "Run as administrator" and try again.' }

$name = "Badminton Tournament (TCP $Port)"
if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) { Remove-NetFirewallRule -DisplayName $name }
New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
Write-Host "Firewall rule '$name' added (Private networks only)."

$public = Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' }
if ($public) {
  Write-Warning ("These connections are set to Public, so the rule will NOT apply to them: " + (($public | ForEach-Object { $_.InterfaceAlias }) -join ', '))
  Write-Warning 'Run scripts\windows\make-network-private.ps1 to switch the venue network to Private.'
}

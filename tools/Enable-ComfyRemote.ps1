<#
.SYNOPSIS
    Prepares ONE workstation to be driven by ComfyFleet.

.DESCRIPTION
    Run this once on each GPU machine, in an ELEVATED PowerShell window.
    It opens the ComfyUI port in Windows Firewall for the local subnet only, and
    prints the change you still have to make inside ComfyUI so the server listens
    on the network instead of 127.0.0.1.

.EXAMPLE
    .\Enable-ComfyRemote.ps1 -Port 8000
    .\Enable-ComfyRemote.ps1 -Port 8188 -RemoteSubnet 192.168.1.0/24
#>
[CmdletBinding()]
param(
    [int]$Port = 8000,
    [string]$RemoteSubnet = "LocalSubnet",
    [string]$RuleName = "ComfyUI (ComfyFleet)"
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Error "Run this in an elevated PowerShell (Run as administrator)."
}

$existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Updating existing firewall rule '$RuleName'..."
    $existing | Remove-NetFirewallRule
}

New-NetFirewallRule -DisplayName $RuleName `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
    -RemoteAddress $RemoteSubnet -Profile Private, Domain | Out-Null

Write-Host "Firewall: TCP $Port allowed inbound from $RemoteSubnet (Private + Domain profiles)." -ForegroundColor Green

$ips = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
    Select-Object -ExpandProperty IPAddress

Write-Host ""
Write-Host "This machine's addresses: $($ips -join ', ')"
Write-Host ""
Write-Host "STILL TO DO on this machine -------------------------------------" -ForegroundColor Yellow
Write-Host "ComfyUI Desktop:"
Write-Host "  Settings (gear) -> Server-Config -> set 'Listen'  to  0.0.0.0"
Write-Host "                                   -> check 'Port' is $Port"
Write-Host "  then restart ComfyUI Desktop."
Write-Host ""
Write-Host "Portable / manual install: launch with"
Write-Host "  python main.py --listen 0.0.0.0 --port $Port"
Write-Host ""
Write-Host "Verify from the console machine:"
foreach ($ip in $ips) {
    Write-Host "  curl http://$ip`:$Port/system_stats"
}
Write-Host "-----------------------------------------------------------------" -ForegroundColor Yellow

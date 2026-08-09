<#
.SYNOPSIS
    Mirrors models (and optionally custom_nodes) from a master LAN share onto this machine.

.DESCRIPTION
    ComfyFleet can push workflows, prompts, settings and small input assets over the API,
    but NOT multi-GB checkpoints or custom node code. Keep one master copy on a share and
    run this on each GPU machine (a Scheduled Task at logon works well).

    Robocopy /MIR makes the local folder identical to the source: files deleted on the
    master are deleted locally too. Use -WhatIf first if you are unsure.

.EXAMPLE
    .\Sync-Models.ps1 -Source \\FILESERVER\ComfyMaster -Target "C:\Users\me\Documents\ComfyUI"
    .\Sync-Models.ps1 -Source \\FILESERVER\ComfyMaster -Target "C:\ComfyUI" -IncludeCustomNodes
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Target,
    [switch]$IncludeCustomNodes,
    [int]$Threads = 16
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Source)) { Write-Error "Source not reachable: $Source" }

$folders = @("models")
if ($IncludeCustomNodes) { $folders += "custom_nodes" }

foreach ($folder in $folders) {
    $from = Join-Path $Source $folder
    $to = Join-Path $Target $folder
    if (-not (Test-Path $from)) {
        Write-Warning "skipping '$folder' - not present on the share"
        continue
    }
    if ($PSCmdlet.ShouldProcess($to, "robocopy /MIR from $from")) {
        Write-Host "Syncing $folder ..." -ForegroundColor Cyan
        robocopy $from $to /MIR /MT:$Threads /R:2 /W:5 /NFL /NDL /NP | Out-Null
        # robocopy: 0-7 are success codes, 8+ are real failures
        if ($LASTEXITCODE -ge 8) { Write-Error "robocopy failed for $folder (exit $LASTEXITCODE)" }
        Write-Host "  done" -ForegroundColor Green
    }
}

if ($IncludeCustomNodes) {
    Write-Host ""
    Write-Host "custom_nodes were copied, but their Python dependencies were NOT installed." -ForegroundColor Yellow
    Write-Host "Open ComfyUI on this machine once and let ComfyUI Manager install requirements,"
    Write-Host "or run pip install -r on each node's requirements.txt in ComfyUI's environment."
}

Write-Host ""
Write-Host "Now verify from the console machine:  cf check jobs\<your-job>.yaml"

<#
.SYNOPSIS
    Opens the normal Windows file/folder dialog and prints what was chosen.

.DESCRIPTION
    Called by ComfyFleet's web server so the browser can use Explorer's own picker
    instead of a web imitation. Prints one absolute path per line, or nothing when
    the dialog is cancelled. Must run with -STA for the dialogs to work.
#>
[CmdletBinding()]
param(
    [ValidateSet('file', 'files', 'folder')][string]$Kind = 'file',
    [string]$Filter = 'All files (*.*)|*.*',
    [string]$Initial = '',
    [string]$Title = 'Select'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null

# A hidden top-most form owns the dialog, so it comes up in front of the browser
# instead of behind it.
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.Size = New-Object System.Drawing.Size 1, 1
$owner.StartPosition = 'CenterScreen'
$owner.Show()
$owner.Activate()

try {
    if ($Kind -eq 'folder') {
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = $Title
        $dialog.ShowNewFolderButton = $true
        if ($Initial -and (Test-Path -LiteralPath $Initial)) { $dialog.SelectedPath = $Initial }
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
            Write-Output $dialog.SelectedPath
        }
    }
    else {
        $dialog = New-Object System.Windows.Forms.OpenFileDialog
        $dialog.Title = $Title
        $dialog.Filter = $Filter
        $dialog.Multiselect = ($Kind -eq 'files')
        $dialog.CheckFileExists = $true
        if ($Initial) {
            $start = if (Test-Path -LiteralPath $Initial -PathType Container) { $Initial } else { Split-Path -LiteralPath $Initial -Parent }
            if ($start -and (Test-Path -LiteralPath $start)) { $dialog.InitialDirectory = $start }
        }
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
            $dialog.FileNames | ForEach-Object { Write-Output $_ }
        }
    }
}
finally {
    $owner.Close()
    $owner.Dispose()
}

<#
    Opens the normal Windows file/folder dialog and prints what was chosen -
    one absolute path per line, or nothing when the dialog is cancelled.

    Settings arrive through environment variables rather than parameters:
    a filter like "ComfyUI workflow (*.json)|*.json" and a Windows path are
    awkward to pass through PowerShell's -File argument parsing, and getting
    it wrong makes the dialog silently fail to open.

        CF_PICK_KIND     file | files | folder      (default: file)
        CF_PICK_FILTER   OpenFileDialog filter string
        CF_PICK_INITIAL  folder, or a file whose folder is used
        CF_PICK_TITLE    dialog caption

    Must run with -STA for the dialogs to work.
#>

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null

$kind = if ($env:CF_PICK_KIND) { $env:CF_PICK_KIND } else { 'file' }
$filter = if ($env:CF_PICK_FILTER) { $env:CF_PICK_FILTER } else { 'All files (*.*)|*.*' }
$initial = $env:CF_PICK_INITIAL
$title = if ($env:CF_PICK_TITLE) { $env:CF_PICK_TITLE } else { 'Select' }

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
    if ($kind -eq 'folder') {
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = $title
        $dialog.ShowNewFolderButton = $true
        if ($initial -and (Test-Path -LiteralPath $initial)) { $dialog.SelectedPath = $initial }
        if ($env:CF_PICK_SELFTEST) { Write-Output "SELFTEST-OK $($dialog.SelectedPath)"; return }
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
            Write-Output $dialog.SelectedPath
        }
    }
    else {
        $dialog = New-Object System.Windows.Forms.OpenFileDialog
        $dialog.Title = $title
        $dialog.Filter = $filter
        $dialog.Multiselect = ($kind -eq 'files')
        $dialog.CheckFileExists = $true
        if ($initial) {
            # [IO.Path] rather than Split-Path: "Split-Path -LiteralPath X -Parent" is an
            # ambiguous parameter set in PowerShell 7 and throws, which stopped the dialog
            # from opening on every call that had a starting folder.
            $start = $initial
            if (Test-Path -LiteralPath $initial -PathType Leaf) {
                $start = [System.IO.Path]::GetDirectoryName($initial)
            }
            if ($start -and (Test-Path -LiteralPath $start)) { $dialog.InitialDirectory = $start }
        }
        # CF_PICK_SELFTEST exercises everything above - assemblies, the owner window, the
        # filter and the starting folder - without putting a modal dialog on screen, so the
        # test suite can catch a broken picker.
        if ($env:CF_PICK_SELFTEST) { Write-Output "SELFTEST-OK $($dialog.InitialDirectory)"; return }
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
            $dialog.FileNames | ForEach-Object { Write-Output $_ }
        }
    }
}
finally {
    $owner.Close()
    $owner.Dispose()
}

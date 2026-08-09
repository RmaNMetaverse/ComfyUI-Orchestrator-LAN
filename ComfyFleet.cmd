@echo off
rem Double-click this to open the ComfyFleet window.
setlocal
pushd "%~dp0"
where pythonw >nul 2>&1
if %ERRORLEVEL%==0 (
    start "ComfyFleet" pythonw -m comfyfleet.gui
) else (
    python -m comfyfleet.gui
)
popd

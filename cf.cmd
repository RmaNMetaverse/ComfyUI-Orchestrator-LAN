@echo off
rem ComfyFleet launcher - keeps relative paths (config/, jobs/) working from anywhere.
setlocal
pushd "%~dp0"
python -m comfyfleet %*
set EXITCODE=%ERRORLEVEL%
popd
exit /b %EXITCODE%

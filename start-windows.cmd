@echo off
rem ============================================================
rem  ComfyFleet - double-click to start and open in the browser
rem ============================================================
setlocal
title ComfyFleet

rem Work from the folder this file lives in, so it can be double-clicked
rem or launched from a shortcut anywhere.
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo   Node.js was not found.
    echo.
    echo   Install it from https://nodejs.org  ^(the LTS build is fine^),
    echo   then run this file again.
    echo.
    pause
    exit /b 1
)

echo.
echo   Starting ComfyFleet...
echo   The browser opens by itself. Close this window to stop the server.
echo.

rem --open makes the server open http://localhost:8787 once it is listening.
rem If ComfyFleet is already running, it just opens the tab instead of failing.
call npm start -- --open

rem Reached when the server stops, or straight away if it was already running.
echo.
if errorlevel 1 (
    echo   ComfyFleet stopped because of a problem - see the messages above.
) else (
    echo   You can close this window.
)
pause

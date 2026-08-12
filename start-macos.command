#!/bin/bash
# ============================================================
#  ComfyFleet - double-click to start and open in the browser
# ============================================================
# If macOS refuses to run it, allow it once with:
#     chmod +x "start-macos.command"

# Work from the folder this file lives in, so it can be double-clicked.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
    echo
    echo "  Node.js was not found."
    echo
    echo "  Install it from https://nodejs.org (the LTS build is fine),"
    echo "  or with Homebrew:  brew install node"
    echo
    read -r -p "  Press Return to close." _
    exit 1
fi

echo
echo "  Starting ComfyFleet..."
echo "  The browser opens by itself. Press Ctrl+C or close this window to stop the server."
echo

# --open makes the server open http://localhost:8787 once it is listening.
# If ComfyFleet is already running, it just opens the tab instead of failing.
npm start -- --open
status=$?   # capture straight away: anything else would overwrite it

echo
if [ "$status" -eq 0 ]; then
    echo "  You can close this window."
else
    echo "  ComfyFleet stopped because of a problem - see the messages above."
fi
read -r -p "  Press Return to close." _

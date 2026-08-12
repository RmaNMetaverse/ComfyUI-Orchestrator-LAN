#!/bin/bash
# ============================================================
#  ComfyFleet - start and open in the browser
# ============================================================
# Run it with:  ./start-linux.sh
# Make it executable once with:  chmod +x start-linux.sh
# Most desktops can also run it by double-clicking (choose "Run in Terminal").

# Work from the folder this file lives in.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
    echo
    echo "  Node.js was not found."
    echo
    echo "  Install it with your package manager, for example:"
    echo "      sudo apt install nodejs npm        # Debian / Ubuntu"
    echo "      sudo dnf install nodejs npm        # Fedora"
    echo "  or from https://nodejs.org (Node 20 or newer)."
    echo
    exit 1
fi

if ! command -v xdg-open >/dev/null 2>&1; then
    echo "  Note: xdg-open is missing, so the browser cannot be opened for you."
    echo "  Open http://localhost:8787 yourself once the server is up."
    echo
fi

echo
echo "  Starting ComfyFleet..."
echo "  The browser opens by itself. Press Ctrl+C to stop the server."
echo

# --open makes the server open http://localhost:8787 once it is listening.
# If ComfyFleet is already running, it just opens the tab instead of failing.
npm start -- --open

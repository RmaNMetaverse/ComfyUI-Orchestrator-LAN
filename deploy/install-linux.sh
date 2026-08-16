#!/bin/bash
# ============================================================================
#  Install ComfyFleet as an always-on service behind nginx.
#
#      sudo ./deploy/install-linux.sh
#
#  Run it from inside the ComfyFleet folder. It installs the systemd unit and
#  the nginx site, starts the service, and tells you where to point a browser.
# ============================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_USER="${SUDO_USER:-$USER}"
PORT="${COMFYFLEET_PORT:-8787}"

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this with sudo:  sudo $0" >&2
    exit 1
fi

echo "  ComfyFleet folder : $APP_DIR"
echo "  Service user      : $SERVICE_USER"
echo "  Node port         : $PORT (nginx will serve it on port 80)"
echo

# ---- prerequisites --------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is not installed. On Debian/Ubuntu:" >&2
    echo "    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -" >&2
    echo "    sudo apt install -y nodejs" >&2
    exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "Node $NODE_MAJOR is too old - ComfyFleet needs 20 or newer." >&2
    exit 1
fi
echo "  Node $(node -v) found."

# ---- folders the service writes to ----------------------------------------
mkdir -p "$APP_DIR/config" "$APP_DIR/workflows" "$APP_DIR/jobs" "$APP_DIR/uploads"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR"

# ---- systemd --------------------------------------------------------------
NODE_BIN="$(command -v node)"
sed -e "s|^User=.*|User=$SERVICE_USER|" \
    -e "s|^Group=.*|Group=$SERVICE_USER|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$APP_DIR|" \
    -e "s|^ExecStart=.*|ExecStart=$NODE_BIN bin/cf.js web --host 127.0.0.1 --port $PORT|" \
    -e "s|^ReadWritePaths=.*|ReadWritePaths=$APP_DIR|" \
    "$APP_DIR/deploy/comfyfleet.service" > /etc/systemd/system/comfyfleet.service

systemctl daemon-reload
systemctl enable comfyfleet >/dev/null
systemctl restart comfyfleet
echo "  systemd service installed and started."

# ---- nginx ----------------------------------------------------------------
if command -v nginx >/dev/null 2>&1; then
    sed "s|http://127.0.0.1:8787|http://127.0.0.1:$PORT|" \
        "$APP_DIR/deploy/nginx-comfyfleet.conf" > /etc/nginx/sites-available/comfyfleet
    ln -sf /etc/nginx/sites-available/comfyfleet /etc/nginx/sites-enabled/comfyfleet
    if [ -e /etc/nginx/sites-enabled/default ]; then
        echo "  Note: the default nginx site also answers on port 80."
        echo "        Remove it with:  sudo rm /etc/nginx/sites-enabled/default"
    fi
    if nginx -t >/dev/null 2>&1; then
        systemctl reload nginx
        echo "  nginx site installed and reloaded."
    else
        echo "  nginx config test failed - check it with: sudo nginx -t" >&2
    fi
else
    echo "  nginx is not installed, skipping the reverse proxy."
    echo "  ComfyFleet is still reachable on port $PORT if you bind it to 0.0.0.0."
fi

# ---- report ---------------------------------------------------------------
sleep 2
ADDRESS="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
if systemctl is-active --quiet comfyfleet; then
    echo "  ComfyFleet is running."
    echo "  Open  http://${ADDRESS:-<this-server>}/   from any machine on the network."
else
    echo "  The service did not start. See why with:  journalctl -u comfyfleet -n 40" >&2
    exit 1
fi
echo
echo "  Handy commands:"
echo "    sudo systemctl status comfyfleet"
echo "    sudo systemctl restart comfyfleet"
echo "    journalctl -u comfyfleet -f"

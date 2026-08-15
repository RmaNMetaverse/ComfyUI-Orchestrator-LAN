#!/bin/bash
# ============================================================================
#  Install ComfyFleet as an always-on service.
#
#      sudo ./deploy/install-linux.sh
#
#  Run it from inside the ComfyFleet folder.
#
#  It is deliberately careful with nginx: servers usually already host other
#  things. It never creates a server block, never edits or removes an existing
#  site, and never touches sites-enabled. It installs a snippet and tells you the
#  one line to add yourself.
# ============================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_USER="${SUDO_USER:-$USER}"
PORT="${COMFYFLEET_PORT:-8787}"
SNIPPET=/etc/nginx/snippets/comfyfleet.conf

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this with sudo:  sudo $0" >&2
    exit 1
fi

echo
echo "  ComfyFleet folder : $APP_DIR"
echo "  Service user      : $SERVICE_USER"
echo "  Listens on        : 127.0.0.1:$PORT  (nginx will reach it there)"
echo

# ---- Node --------------------------------------------------------------------
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

# ---- is the port free? -------------------------------------------------------
port_taken() {
    if command -v ss >/dev/null 2>&1; then ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
    elif command -v lsof >/dev/null 2>&1; then lsof -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1
    else return 1
    fi
}
if port_taken "$PORT" && ! systemctl is-active --quiet comfyfleet; then
    echo >&2
    echo "Port $PORT is already used by something else on this server." >&2
    echo "Pick another one, for example:" >&2
    echo "    sudo COMFYFLEET_PORT=8788 $0" >&2
    echo "(remember to change the port in $SNIPPET to match)" >&2
    exit 1
fi
echo "  Port $PORT is free."

# ---- folders the service writes to -------------------------------------------
mkdir -p "$APP_DIR/config" "$APP_DIR/workflows" "$APP_DIR/jobs" "$APP_DIR/uploads"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR"

# ---- systemd -----------------------------------------------------------------
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

# ---- nginx: only ever add a snippet ------------------------------------------
NGINX_READY=no
if command -v nginx >/dev/null 2>&1; then
    mkdir -p /etc/nginx/snippets
    sed "s|http://127.0.0.1:8787/|http://127.0.0.1:$PORT/|" \
        "$APP_DIR/deploy/nginx-comfyfleet.conf" > "$SNIPPET"
    echo "  nginx snippet written to $SNIPPET (nothing else was changed)."

    if grep -rqs "snippets/comfyfleet.conf" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null; then
        NGINX_READY=yes
        if nginx -t >/dev/null 2>&1; then
            systemctl reload nginx
            echo "  The include is already in place - nginx reloaded."
        else
            echo "  Careful: 'nginx -t' is failing. Fix it, then: sudo systemctl reload nginx" >&2
        fi
    fi
else
    echo "  nginx is not installed - skipping the snippet."
fi

# ---- report ------------------------------------------------------------------
sleep 2
ADDRESS="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
if ! systemctl is-active --quiet comfyfleet; then
    echo "  The service did not start. See why with:  journalctl -u comfyfleet -n 40" >&2
    exit 1
fi
echo "  ComfyFleet is running on 127.0.0.1:$PORT."

if [ "$NGINX_READY" = yes ]; then
    echo "  Open  http://${ADDRESS:-<this-server>}/comfyfleet/"
else
    cat <<EOF

  One step left. Add this line inside the existing server { ... } block in your
  nginx site (the same file that has your landing page and /fflf-extractor/):

      include /etc/nginx/snippets/comfyfleet.conf;

  then:

      sudo nginx -t && sudo systemctl reload nginx

  and open  http://${ADDRESS:-<this-server>}/comfyfleet/

  Nothing about your existing sites was modified.
EOF
fi

echo
echo "  Handy commands:"
echo "    sudo systemctl status comfyfleet"
echo "    sudo systemctl restart comfyfleet     # after git pull"
echo "    journalctl -u comfyfleet -f"

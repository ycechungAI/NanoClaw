#!/bin/bash
# start.sh — Build and start all NanoClaw services
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

echo "==> NanoClaw Startup"
echo ""

# Fix Docker credential helper if needed
echo "==> Checking Docker configuration..."
if grep -q '"credsStore": "desktop"' ~/.docker/config.json 2>/dev/null; then
    echo "    Fixing Docker credential helper..."
    echo '{"auths":{}}' > ~/.docker/config.json
    echo "    Done."
elif [ ! -f ~/.docker/config.json ]; then
    echo '{"auths":{}}' > ~/.docker/config.json
    echo "    Created Docker config."
else
    echo "    Docker config OK."
fi

# Check Docker is running
echo ""
echo "==> Checking Docker..."
if ! docker info &>/dev/null; then
    echo "    ERROR: Docker is not running. Start Docker Desktop first."
    exit 1
fi
echo "    Docker is running."

# Install dependencies
echo ""
echo "==> Installing dependencies..."
npm install --silent 2>&1 | tail -1 || npm install
echo "    Done."

# Build TypeScript
echo ""
echo "==> Building TypeScript..."
npm run build --silent 2>&1 | tail -3 || npm run build
echo "    Done."

# Build container image
echo ""
echo "==> Building agent container image..."
bash container/build.sh 2>&1 | tail -5
echo "    Done."

# Start launchd services
echo ""
echo "==> Starting NanoClaw launchd services..."

PLISTS=(
    "com.nanoclaw|$HOME/Library/LaunchAgents/com.nanoclaw.plist"
)

for entry in "${PLISTS[@]}"; do
    label="${entry%%|*}"
    plist="${entry##*|}"
    if [ ! -f "$plist" ]; then
        echo "    Warning: plist not found, skipping: $plist"
        continue
    fi
    if launchctl list "$label" &>/dev/null; then
        echo "    Already loaded: $label"
    else
        launchctl load "$plist" && echo "    Started: $label" || echo "    Warning: could not start $label"
    fi
done

echo ""
echo "==> Waiting for services to come up..."
sleep 2

echo ""
echo "==> Status:"
for entry in "${PLISTS[@]}"; do
    label="${entry%%|*}"
    if launchctl list "$label" &>/dev/null; then
        pid=$(launchctl list "$label" | awk -F' = ' '/"PID"/ {gsub(/;/,"",$2); print $2}')
        echo "    Running: $label (PID $pid)"
    else
        echo "    NOT running: $label"
    fi
done

echo ""
echo "==> Next steps:"
echo "    Logs:      tail -f $PROJECT_ROOT/logs/nanoclaw.log"
echo "    Dashboard: tail -f $PROJECT_ROOT/logs/dashboard.log"
echo "    To stop:   ./stop.sh"
echo ""
echo "    If WhatsApp auth is needed, run: claude /setup"

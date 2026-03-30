#!/bin/bash
# start.sh — Safely start all NanoClaw services
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PLISTS=(
  "com.nanoclaw|$HOME/Library/LaunchAgents/com.nanoclaw.plist"
  "com.nanoclaw.dashboard|$HOME/Library/LaunchAgents/com.nanoclaw.dashboard.plist"
)

echo "==> Checking Docker..."
if ! docker info &>/dev/null; then
  echo "    ERROR: Docker is not running. Start Docker Desktop first."
  exit 1
fi
echo "    Docker is running."

echo "==> Setting up WhatsApp Authentication..."
npm run auth
echo ""
echo "==> Starting NanoClaw launchd services..."

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

echo "==> Waiting for services to come up..."
sleep 2

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
echo "    Logs:      tail -f $PROJECT_ROOT/logs/nanoclaw.log"
echo "    Dashboard: tail -f $PROJECT_ROOT/logs/dashboard.log"
echo "    To stop:   ./stop.sh"

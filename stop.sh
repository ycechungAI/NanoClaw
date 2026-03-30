#!/bin/bash
# stop.sh — Safely stop all NanoClaw services and containers
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Stopping NanoClaw launchd services..."

PLISTS=(
  "com.nanoclaw|$HOME/Library/LaunchAgents/com.nanoclaw.plist"
  "com.nanoclaw.dashboard|$HOME/Library/LaunchAgents/com.nanoclaw.dashboard.plist"
)

for entry in "${PLISTS[@]}"; do
  label="${entry%%|*}"
  plist="${entry##*|}"
  if launchctl list "$label" &>/dev/null; then
    launchctl unload "$plist" && echo "    Unloaded: $label" || echo "    Warning: could not unload $label"
  else
    echo "    Not loaded: $label"
  fi
done

echo "==> Stopping running nanoclaw- containers..."
running=$(docker ps --filter "name=nanoclaw-" --format "{{.Names}}" 2>/dev/null || true)
if [ -n "$running" ]; then
  echo "$running" | xargs docker stop && echo "    Stopped containers: $(echo "$running" | tr '\n' ' ')"
else
  echo "    No nanoclaw containers running."
fi

echo "==> Done. All NanoClaw services stopped."
echo ""
echo "    To restart: launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist && launchctl load ~/Library/LaunchAgents/com.nanoclaw.dashboard.plist"
echo "    To rebuild:  ./rebuild.sh"

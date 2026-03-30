#!/bin/bash
# Full rebuild: fixes Docker config, prunes cache, rebuilds container, recompiles TypeScript, restarts service
set -e

# Fix Docker credential helper if needed
if grep -q '"credsStore": "desktop"' ~/.docker/config.json 2>/dev/null; then
    echo "==> Fixing Docker credential helper..."
    echo '{"auths":{}}' > ~/.docker/config.json
fi

echo "==> Pruning Docker build cache..."
docker builder prune -f

echo "==> Building container image..."
./container/build.sh

echo "==> Compiling TypeScript..."
npm run build

echo "==> Restarting NanoClaw service..."
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

echo "==> Done. Tailing logs (Ctrl+C to stop)..."
sleep 3
tail -f logs/nanoclaw.log

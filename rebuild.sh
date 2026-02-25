#!/bin/bash
# Full rebuild: clears Docker cache, rebuilds container image, recompiles TypeScript, restarts service
set -e

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

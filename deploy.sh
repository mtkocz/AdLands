#!/bin/bash
# AdLands VPS Deploy Script
# Usage: ./deploy.sh
set -e

echo "=== AdLands Deploy ==="

# Pull latest code (sponsors.json is gitignored — no conflicts)
echo "[1/3] Pulling latest code..."
git pull --ff-only

# Install dependencies if package.json changed
echo "[2/3] Checking dependencies..."
cd server
npm ci --production
cd ..

# Restart application
echo "[3/3] Restarting server..."
pm2 restart adlands || pm2 start server/index.js --name adlands

echo "=== Deploy complete ==="

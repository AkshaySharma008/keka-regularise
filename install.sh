#!/bin/bash
# One-time installer for keka-regularise (macOS).
# Usage: unzip, then run:  bash install.sh
set -e

INSTALL_DIR="$HOME/keka-regularise"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This tool only supports macOS."; exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org (or: brew install node), then run this again."
  exit 1
fi
if (( $(node -p 'process.versions.node.split(".")[0]') < 18 )); then
  echo "Node.js 18 or newer is needed (you have $(node -v)). Update it from https://nodejs.org, then run this again."
  exit 1
fi

# Background jobs can't read Desktop/Documents/Downloads on macOS, so the monthly run would fail from there.
case "$SRC_DIR/" in
  "$HOME/Desktop/"*|"$HOME/Documents/"*|"$HOME/Downloads/"*|"$HOME/Library/Mobile Documents/"*)
    echo "This folder is inside Desktop, Documents or Downloads, which macOS blocks for scheduled jobs."
    echo "Clone it into your home folder instead:"
    echo "  git clone https://github.com/AkshaySharma008/keka-regularise.git $INSTALL_DIR"
    exit 1;;
esac
cd "$SRC_DIR"

echo "Installing dependencies..."
npm ci --silent

if [[ ! -d "/Applications/Google Chrome.app" ]]; then
  echo "Google Chrome not found; downloading a browser for Playwright..."
  npx playwright install chromium
fi

node keka.js setup

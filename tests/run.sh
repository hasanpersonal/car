#!/bin/sh
# Bootstraps and runs the NEON DRIVE test harness.
# node_modules is never snapshotted, so this re-installs and re-links it.
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --silent
ln -sfn "$(pwd)/node_modules" ../node_modules
exec node verify.mjs

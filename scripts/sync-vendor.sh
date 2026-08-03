#!/usr/bin/env bash
# Refresh the vendored freeq SDK from a local checkout.
#
# @freeq/sdk and @freeq/bot-kit are not published to npm, and the repo previously
# depended on them by a relative path pointing outside itself. That made the project
# uninstallable for anyone who did not happen to have the freeq repo checked out at
# exactly the right place — which is to say, everyone. CI was red for the same reason.
#
# Vendoring the built dist (772KB) is the pragmatic fix. Run this when the SDK changes.
set -euo pipefail
SRC="${1:-$HOME/src/freeq}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for pkg in freeq-sdk-js freeq-bot-kit-js; do
  [ -d "$SRC/$pkg/dist" ] || { echo "no dist in $SRC/$pkg — run its build first"; exit 1; }
  rm -rf "$ROOT/vendor/$pkg"
  mkdir -p "$ROOT/vendor/$pkg"
  cp -R "$SRC/$pkg/dist" "$ROOT/vendor/$pkg/dist"
  cp "$SRC/$pkg/package.json" "$ROOT/vendor/$pkg/package.json"
  echo "vendored $pkg"
done
node -e "
const fs=require('fs'),p='$ROOT/vendor/freeq-bot-kit-js/package.json';
const d=JSON.parse(fs.readFileSync(p));d.dependencies['@freeq/sdk']='file:../freeq-sdk-js';
fs.writeFileSync(p,JSON.stringify(d,null,2)+'\n');"
echo "done — commit vendor/ and run pnpm install"

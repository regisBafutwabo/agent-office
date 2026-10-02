#!/bin/sh
# Builds a signed Mac release into dist/: the .dmg for new installs, plus the update bundle and latest.json
# that installed apps download to update themselves. Upload all three files to the GitHub release.
#
# Signing uses the updater key at ~/.tauri/agent-office.key, with its password in the Keychain
# (service "agent-office-updater"). Without that key, installed apps can't verify, so won't install, updates.
set -eu
cd "$(dirname "$0")/.."

version=$(node -p 'require("./desktop/src-tauri/tauri.conf.json").version')
repo=https://github.com/regisBafutwabo/agent-office
TAURI_SIGNING_PRIVATE_KEY=$(cat "${AGENT_OFFICE_SIGNING_KEY:-$HOME/.tauri/agent-office.key}")
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$(security find-generic-password -s agent-office-updater -a signing-key -w)
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD

(cd desktop && npm run build)

bundle=desktop/src-tauri/target/release/bundle
dmg="Agent-Office_${version}_aarch64.dmg"
archive="Agent-Office_${version}_aarch64.app.tar.gz"
rm -rf dist && mkdir dist
cp "$bundle/dmg/Agent Office_${version}_aarch64.dmg" "dist/$dmg"
cp "$bundle/macos/Agent Office.app.tar.gz" "dist/$archive"
VERSION=$version URL="$repo/releases/download/v$version/$archive" SIG="$bundle/macos/Agent Office.app.tar.gz.sig" node -e '
  const { readFileSync } = require("node:fs");
  const { VERSION, URL, SIG } = process.env;
  console.log(JSON.stringify({
    version: VERSION,
    notes: `See ${URL.split("/download/")[0]}/tag/v${VERSION}`,
    pub_date: new Date().toISOString(),
    platforms: { "darwin-aarch64": { signature: readFileSync(SIG, "utf8").trim(), url: URL } },
  }, null, 2));
' > dist/latest.json

echo "Built dist/:"; ls -1 dist
echo "SHA-256 of $dmg: $(shasum -a 256 "dist/$dmg" | cut -d' ' -f1)"

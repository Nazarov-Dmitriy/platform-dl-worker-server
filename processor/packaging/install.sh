#!/bin/sh
# User systemd unit (Linux) or LaunchAgent (macOS). Disable with --disable.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
CONFIG=${CONFIG:-$ROOT/config.json}
TOKEN_FILE=${TOKEN_FILE:-$ROOT/data/processor.token}
NODE=${NODE_BIN:-$(command -v node)}
DISABLE=0
for a in "$@"; do
  [ "$a" = "--disable" ] && DISABLE=1
done
if [ "$(uname -s)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.titunki.processor.plist"
  if [ "$DISABLE" = 1 ]; then
    launchctl disable "gui/$(id -u)/com.titunki.processor" 2>/dev/null || true
    rm -f "$PLIST"
    echo '{"status":"autostart-disabled"}'
    exit 0
  fi
  [ -f "$CONFIG" ] || { echo CONFIG_REQUIRED >&2; exit 1; }
  [ -f "$TOKEN_FILE" ] || { echo PROCESSOR_TOKEN_FILE_REQUIRED >&2; exit 1; }
  mkdir -p "$(dirname "$PLIST")"
  chmod 600 "$TOKEN_FILE"
  TOKEN=$(sed -n 's/^PROCESSOR_TOKEN=//p' "$TOKEN_FILE")
  [ -n "$TOKEN" ] || TOKEN=$(cat "$TOKEN_FILE")
  xml_escape() { printf '%s' "$1" | sed 's/\&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'; }
  ROOT_XML=$(xml_escape "$ROOT")
  NODE_XML=$(xml_escape "$NODE")
  CONFIG_XML=$(xml_escape "$CONFIG")
  TOKEN_XML=$(xml_escape "$TOKEN")
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.titunki.processor</string>
  <key>WorkingDirectory</key><string>$ROOT_XML</string>
  <key>ProgramArguments</key><array>
    <string>$NODE_XML</string><string>$ROOT_XML/dist/main.js</string><string>$CONFIG_XML</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PROCESSOR_TOKEN</key><string>$TOKEN_XML</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
  chmod 600 "$PLIST"
  launchctl enable "gui/$(id -u)/com.titunki.processor"
  if ! launchctl print "gui/$(id -u)/com.titunki.processor" >/dev/null 2>&1; then
    launchctl load "$PLIST"
  fi
  echo '{"status":"autostart-enabled","agent":"com.titunki.processor"}'
  exit 0
fi
UNIT="$HOME/.config/systemd/user/titunki-processor.service"
if [ "$DISABLE" = 1 ]; then
  systemctl --user disable titunki-processor.service 2>/dev/null || true
  rm -f "$UNIT"
  echo '{"status":"autostart-disabled"}'
  exit 0
fi
[ -f "$CONFIG" ] || { echo CONFIG_REQUIRED >&2; exit 1; }
[ -f "$TOKEN_FILE" ] || { echo PROCESSOR_TOKEN_FILE_REQUIRED >&2; exit 1; }
mkdir -p "$(dirname "$UNIT")" "$(dirname "$TOKEN_FILE")"
chmod 600 "$TOKEN_FILE"
unit_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/%/%%/g'; }
ROOT_UNIT=$(unit_escape "$ROOT")
NODE_UNIT=$(unit_escape "$NODE")
CONFIG_UNIT=$(unit_escape "$CONFIG")
TOKEN_UNIT=$(unit_escape "$TOKEN_FILE")
cat >"$UNIT" <<EOF
[Unit]
Description=Titunki processor
After=network-online.target
[Service]
WorkingDirectory="$ROOT_UNIT"
EnvironmentFile="$TOKEN_UNIT"
ExecStart="$NODE_UNIT" "$ROOT_UNIT/dist/main.js" "$CONFIG_UNIT"
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now titunki-processor.service
echo '{"status":"autostart-enabled","unit":"titunki-processor.service"}'

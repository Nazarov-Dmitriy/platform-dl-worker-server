#!/bin/sh
# User systemd unit (Linux) or LaunchAgent (macOS). Disable with --disable.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
CONFIG=${CONFIG:-$ROOT/config.json}
TOKEN_FILE=${TOKEN_FILE:-$ROOT/data/processor.token}
NODE=$(command -v node)
DISABLE=0
for a in "$@"; do
  [ "$a" = "--disable" ] && DISABLE=1
done
if [ "$(uname -s)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.titunki.processor.plist"
  if [ "$DISABLE" = 1 ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo '{"status":"autostart-disabled"}'
    exit 0
  fi
  [ -f "$CONFIG" ] || { echo CONFIG_REQUIRED >&2; exit 1; }
  [ -f "$TOKEN_FILE" ] || { echo PROCESSOR_TOKEN_FILE_REQUIRED >&2; exit 1; }
  TOKEN=$(sed -n 's/^PROCESSOR_TOKEN=//p' "$TOKEN_FILE")
  [ -n "$TOKEN" ] || TOKEN=$(cat "$TOKEN_FILE")
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.titunki.processor</string>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>$ROOT/dist/main.js</string><string>$CONFIG</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PROCESSOR_TOKEN</key><string>$TOKEN</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
  chmod 600 "$PLIST"
  launchctl load "$PLIST"
  echo '{"status":"autostart-enabled","agent":"com.titunki.processor"}'
  exit 0
fi
UNIT="$HOME/.config/systemd/user/titunki-processor.service"
if [ "$DISABLE" = 1 ]; then
  systemctl --user disable --now titunki-processor.service 2>/dev/null || true
  rm -f "$UNIT"
  echo '{"status":"autostart-disabled"}'
  exit 0
fi
[ -f "$CONFIG" ] || { echo CONFIG_REQUIRED >&2; exit 1; }
[ -f "$TOKEN_FILE" ] || { echo PROCESSOR_TOKEN_FILE_REQUIRED >&2; exit 1; }
mkdir -p "$(dirname "$UNIT")" "$(dirname "$TOKEN_FILE")"
chmod 600 "$TOKEN_FILE"
cat >"$UNIT" <<EOF
[Unit]
Description=Titunki processor
After=network-online.target
[Service]
WorkingDirectory=$ROOT
EnvironmentFile=$TOKEN_FILE
ExecStart=$NODE $ROOT/dist/main.js $CONFIG
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now titunki-processor.service
echo '{"status":"autostart-enabled","unit":"titunki-processor.service"}'

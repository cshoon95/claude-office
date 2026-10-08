#!/bin/bash
# 픽셀 오피스 데스크톱 창(.app) 빌드 → ~/Applications/Pixel Office.app
# 필요: Xcode Command Line Tools(swiftc). 아이콘은 claude-office 의 icon-512.png 를 쓴다.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${1:-$HOME/Applications/Pixel Office.app}"
CO_DIR="${CLAUDE_OFFICE_DIR:-$([ -d "$HOME/src/etc/claude-office" ] && echo "$HOME/src/etc/claude-office" || echo "$HOME/.claude-office/app")}"
ICON_SRC="$CO_DIR/frontend/public/icon-512.png"

rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -o "$APP/Contents/MacOS/PixelOffice" "$HERE/PixelOffice.swift"

if [ -f "$ICON_SRC" ]; then
  tmp="$(mktemp -d)"; set="$tmp/icon.iconset"; mkdir "$set"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ICON_SRC" --out "$set/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$ICON_SRC" --out "$set/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$set" -o "$APP/Contents/Resources/AppIcon.icns"; rm -rf "$tmp"
fi

cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Pixel Office</string>
  <key>CFBundleIdentifier</key><string>local.soohoon.pixel-office</string>
  <key>CFBundleExecutable</key><string>PixelOffice</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
EOF
codesign -s - --force "$APP" >/dev/null 2>&1 || true
echo "빌드 완료 → $APP"

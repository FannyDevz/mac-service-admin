#!/bin/zsh
# Pasang Service Admin agar mudah dibuka:
#   1. Server otomatis jalan saat login (LaunchAgent, dinyalakan ulang kalau berhenti)
#   2. "Service Admin.app" di /Applications: peluncur yang membuka dashboard di browser
#      (Spotlight, Launchpad, atau Dock)
#
# Pemakaian:  ./install.sh            (build + pasang + buka aplikasi)
#             ./install.sh --no-open  (tanpa membuka aplikasi di akhir)
set -euo pipefail

DIR="${0:A:h}"
APP_NAME="Service Admin"
APP_DIR="/Applications/$APP_NAME.app"
[[ -w /Applications ]] || APP_DIR="$HOME/Applications/$APP_NAME.app"
LABEL="local.service-admin"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/.service-admin/logs"
PYTHON="$(command -v python3)"
BUILD="$DIR/build"

say() { print -P "%F{blue}==>%f $1"; }

[[ -n "$PYTHON" ]] || { print "python3 tidak ditemukan"; exit 1; }
command -v swiftc >/dev/null || { print "swiftc tidak ditemukan. Jalankan: xcode-select --install"; exit 1; }

# ---------------------------------------------------------------- 1. build aplikasi
say "Build aplikasi peluncur (Swift)…"
rm -rf "$BUILD" && mkdir -p "$BUILD"
swiftc -O -o "$BUILD/ServiceAdmin" "$DIR/macapp/main.swift" -framework Cocoa

say "Membuat ikon…"
swift "$DIR/macapp/makeicon.swift" "$BUILD/icon.png" >/dev/null
ICONSET="$BUILD/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$BUILD/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$BUILD/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$BUILD/AppIcon.icns"

BUNDLE="$BUILD/$APP_NAME.app"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
mv "$BUILD/ServiceAdmin" "$BUNDLE/Contents/MacOS/ServiceAdmin"
cp "$BUILD/AppIcon.icns" "$BUNDLE/Contents/Resources/AppIcon.icns"
VERSION="$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo dev)"
cat > "$BUNDLE/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>local.service-admin.app</string>
  <key>CFBundleExecutable</key><string>ServiceAdmin</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>SAProjectDir</key><string>$DIR</string>
  <key>SAPython</key><string>$PYTHON</string>
</dict></plist>
EOF
codesign --force --deep --sign - "$BUNDLE" 2>/dev/null   # tanda tangan ad-hoc agar tidak dianggap rusak

say "Memasang aplikasi ke $APP_DIR…"
osascript -e "quit app \"$APP_NAME\"" 2>/dev/null || true   # tutup versi lama yang sedang terbuka
mkdir -p "${APP_DIR:h}"
rm -rf "$APP_DIR"
cp -R "$BUNDLE" "$APP_DIR"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP_DIR" 2>/dev/null || true

# ---------------------------------------------------------------- 2. server otomatis (LaunchAgent)
say "Memasang server otomatis saat login…"
mkdir -p "$LOGS" "${PLIST:h}"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PYTHON</string><string>$DIR/server.py</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOGS/server.log</string>
  <key>StandardErrorPath</key><string>$LOGS/server.err</string>
</dict></plist>
EOF

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
# server yang dijalankan manual di port 8765 dihentikan supaya LaunchAgent bisa memakai port itu
if pids=$(lsof -ti tcp:8765 -sTCP:LISTEN 2>/dev/null) && [[ -n "$pids" ]]; then
  say "Menghentikan server manual yang sedang jalan (PID $pids)…"
  kill $=pids 2>/dev/null || true
  sleep 1
fi
launchctl bootstrap "gui/$UID" "$PLIST"

for i in {1..40}; do
  curl -fs -o /dev/null "http://127.0.0.1:8765/api/jobs" && break
  sleep 0.25
done
if curl -fs -o /dev/null "http://127.0.0.1:8765/api/jobs"; then
  say "Server berjalan di http://127.0.0.1:8765"
else
  print -P "%F{yellow}Server belum merespons.%f Jika muncul dialog \"Python ingin mengakses folder Dokumen\", klik Izinkan"
  print   "  (atau System Settings → Privacy & Security → Files & Folders → Python → Documents)."
  print   "  Server lanjut sendiri setelah izin diberikan. Log: $LOGS/server.err"
fi

print -P "\n%F{green}✓ Selesai.%f Buka %B$APP_NAME%b dari Spotlight (⌘Space), Launchpad, atau Dock."
print   "  Uninstall: $DIR/uninstall.sh"
[[ "${1:-}" == "--no-open" ]] || open "$APP_DIR"   # membuka dashboard di browser

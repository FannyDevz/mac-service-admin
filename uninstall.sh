#!/bin/zsh
# Lepas Service Admin.app dan server otomatis. Data di ~/.service-admin (backup, state, shim) tidak dihapus.
set -uo pipefail
LABEL="local.service-admin"
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null && print "✓ Server otomatis dihentikan"
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
for app in "/Applications/Service Admin.app" "$HOME/Applications/Service Admin.app"; do
  [[ -d "$app" ]] && rm -rf "$app" && print "✓ $app dihapus"
done
print "Data tetap tersimpan di ~/.service-admin (hapus manual kalau tidak diperlukan)."
print "Jalankan manual kapan saja: python3 ${0:A:h}/server.py"

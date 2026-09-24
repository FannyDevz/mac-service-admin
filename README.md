# Mac Service Admin

Dashboard web lokal untuk mengelola service Homebrew (`brew services`): MySQL, PHP-FPM, Redis, PostgreSQL, Nginx, cloudflared, dll.

## Jalankan

```bash
python3 server.py            # http://127.0.0.1:8765
python3 server.py --port 9000
```

Tidak butuh `pip install`, cukup Python 3 bawaan.

## Fitur

| Tab | Isi |
|---|---|
| **Dashboard** | CPU (total & per core), RAM & memory pressure, suhu CPU/SSD/baterai, GPU, jaringan, disk I/O, baterai (kesehatan, cycle, daya), proses teratas. Riwayat 5 menit dengan hover. Tanpa sudo. |
| **Paket & Service** | Semua paket Homebrew (CLI & app) + brew services dalam satu halaman. Filter Service/Semua/CLI/App/Ada update, start/stop/restart, install dari katalog service populer, upgrade, uninstall. **Detail service**: info port/data/log, editor config + validasi (my.cnf, nginx, php-fpm, redis, cloudflared, …), simpan & restart. **cloudflared**: login, buat/hapus tunnel, route DNS, tambah aturan ingress, jalankan/stop tunnel manual |
| **PHP** | Pilih PHP default dari Homebrew **atau Herd**. Pilihan Herd juga menjalankan `herd use`. Install/update versi PHP Herd |
| **Node.js** | Versi nvm + Node Homebrew: jadikan default, install (termasuk daftar LTS), uninstall |
| **Herd** | **＋ Aplikasi Laravel baru** (pilih lokasi, nama, versi Laravel 13/12/11/10, PHP, starter kit React/Vue/Svelte/Livewire, auth, Pest/PHPUnit, database + buat DB & migrasi, npm/pnpm/bun, Git, HTTPS, buka di editor). Start/stop/restart Herd, daftar situs (HTTPS on/off, PHP per situs, unlink, buka folder), link folder baru, proxy ke port lokal, parked folder, log Nginx & PHP-FPM |
| **Docker** | **Ringkasan**: statistik live (CPU, RAM, jaringan, disk per container + grafik), pemakaian disk & prune. **Container**: start/stop/pause/hapus, detail (port, mount, network, env tersamar), log live, **console** di browser + terminal interaktif, **buat container** (docker run). **Compose**: up/pull/build/down, log, edit file + validasi, **pembuat compose** dari 16 template dengan cek bentrok port. **Image/Volume/Network**: pull, hapus, prune. **Remote host**: kelola Docker di server lain lewat SSH (docker context) |
| **Bahasa lain** | Menu otomatis muncul untuk bahasa yang terdeteksi. **Python**: pilih versi default (python.org/Homebrew/pyenv/uv/sistem), pipx, daftar paket, perbaikan sertifikat SSL python.org. **Go**: env, cache, `go install` tool, cek versi terbaru. **Rust**: toolchain, target, komponen, crate `cargo install`. **Java**: pilih JDK (JAVA_HOME). **Ruby**: pilih versi, daftar gem. Lainnya (Swift, Lua, Perl, Deno, Bun, .NET, Dart, Zig, Elixir, …): info versi & lokasi |
| **File konfigurasi** | Editor dengan validasi & backup: zsh/bash, `/etc/hosts` & `/etc/resolver/*` (password admin, flush DNS otomatis), `~/.ssh/config` + SSH key (salin/generate), `.gitconfig`, global gitignore, `php.ini` (Homebrew & Herd), `.tmux.conf`, `.vimrc`, `.editorconfig`, npm/composer/pip/cargo config, dan `.env` semua project |

Proses panjang (install, upgrade, dll) berjalan di background. Tombol **terminal** di header (samping tombol tema) menampilkan titik merah selama ada proses berjalan; klik untuk melihat daftar proses dan output-nya.

### Cara kerja pilih versi (PHP, Python, Go, Ruby, Java)

Service Admin membuat symlink di `~/.service-admin/bin` dan menambahkan satu blok di **paling bawah** `~/.zshrc`:

```zsh
# >>> mac-service-admin >>>
export PATH="$HOME/.service-admin/bin:$PATH"
[ -f "$HOME/.service-admin/env.zsh" ] && source "$HOME/.service-admin/env.zsh"
# <<< mac-service-admin <<<
```

Ganti versi = ganti symlink, jadi terminal yang sudah terbuka pun langsung ikut. Java memakai `JAVA_HOME` di `env.zsh` (berlaku di terminal baru). Backup `.zshrc` dibuat sebelum diubah
(`~/.service-admin/backups`). Tombol "Hapus override" mengembalikan ke PHP bawaan PATH.

## Keamanan

- Server hanya listen di `127.0.0.1`, jadi tidak bisa diakses dari jaringan
- Header `Host` harus `localhost` / `127.0.0.1` untuk mencegah DNS rebinding
- POST butuh header khusus, jadi website lain tidak bisa memicu aksi (CSRF)
- Semua input (nama service/paket/versi/container) divalidasi, dan perintah dijalankan tanpa shell
- Hanya file zsh di home yang boleh diedit

## Auto-start dashboard saat login (opsional)

Buat `~/Library/LaunchAgents/local.service-admin.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.service-admin</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/env</string><string>python3</string>
    <string>/Users/fanny/Documents/ Personal Project/mac-service-admin/server.py</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

Lalu: `launchctl load ~/Library/LaunchAgents/local.service-admin.plist`

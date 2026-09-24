# CLAUDE.md

Panduan untuk Claude saat bekerja di repo ini. Bahasa UI, komentar, dan pesan error: **Bahasa Indonesia**.

## Apa ini

**Mac Service Admin**: dashboard web lokal untuk mengelola dev environment macOS (Apple Silicon):
Homebrew (paket + `brew services`), Docker/OrbStack, Laravel Herd, versi bahasa (PHP, Node, Python, Go,
Rust, Java, Ruby, …), file konfigurasi (zsh, `/etc/hosts`, SSH, Git, php.ini, `.env`), dan statistik
sistem (CPU, RAM, suhu, GPU, baterai).

```bash
python3 server.py            # http://127.0.0.1:8765  (--port untuk ganti)
```

## Aturan utama

- **Stdlib saja, tanpa dependensi.** Backend Python murni (http.server, subprocess, ctypes); frontend
  vanilla JS/CSS tanpa build step, tanpa CDN (ikon disimpan lokal di `static/icons.js`).
- **Keamanan (jangan dilonggarkan):**
  - Server hanya bind `127.0.0.1`; header `Host` wajib `localhost`/`127.0.0.1` (anti DNS rebinding).
  - Semua POST wajib header `X-Requested-With: service-admin` (anti CSRF). `api()` di `app.js` sudah
    mengirimnya.
  - Perintah dijalankan sebagai **list argumen, tanpa shell**. Validasi setiap input (nama paket,
    versi, id container, hostname, port) dengan regex sebelum dipakai.
  - File hanya boleh dibaca/ditulis lewat **registry** (`files.py`, `svc.service_spec`, compose dari
    `docker compose ls`), jangan pernah path bebas dari browser.
  - Jangan kirim rahasia ke browser tanpa perlu: `herd sites --json` berisi isi `.env`, jadi field
    `env` dibuang di `herd_info()`. Env container disamarkan di UI (`SECRET_RE` di `dockerx.py`).
  - File milik root (`/etc/hosts`, `/etc/resolver/*`) ditulis lewat
    `osascript ... with administrator privileges` (dialog password macOS), bukan sudo.
- **Sebelum menimpa file user: validasi + backup.** Pola yang dipakai: validasi dulu (atau tulis →
  validasi → rollback kalau gagal), backup ke `~/.service-admin/backups/...`, simpan 20 versi.
- Aksi yang merusak (uninstall, hapus volume, prune, down) wajib `data-confirm` di tombolnya.

## Struktur

| File | Isi |
|---|---|
| `server.py` | HTTP handler + routing (`GET_ROUTES` / `POST_ROUTES` di bawah file), brew services/apps, PHP & Node (nvm), Herd (situs, proxy, New App Laravel), sidebar `nav_info` |
| `core.py` | Helper bersama: `run`/`output`, `ApiError`, state (`~/.service-admin/state.json`), **job** background (`start_job`, `start_steps` multi-langkah, `list_jobs`), backup & blok `.zshrc`, `set_shims`/`set_env`, `shell_probe` |
| `stats.py` | Statistik sistem tanpa sudo: CPU per core (Mach `host_processor_info`), suhu (IOKit HID via ctypes), GPU/baterai (`ioreg`), RAM (`vm_stat`), sampler background |
| `runtimes.py` | Deteksi bahasa (`LANGS`) + manajemen Python/Go/Rust/Java/Ruby |
| `svc.py` | Detail service (config file + validator per service), katalog & 100 rekomendasi paket, panel cloudflared |
| `files.py` | Editor file konfigurasi: registry `STATIC` + resolver, php.ini, `.env` project; validator per jenis |
| `dockerx.py` | Docker: overview, stats, disk, inspect, logs, exec console, `docker run`, compose (baca/validasi/simpan), context remote |
| `ptyterm.py` | Terminal sungguhan: sesi `zsh -l -i` di PTY (`pty.fork`), output long-poll (`/api/pty/read`, base64), input/resize/kill lewat POST |
| `static/index.html` | Shell: sidebar, header (tombol terminal + tema), dialog, panel kanan (tab Terminal / Proses) |
| `static/app.js` | Core UI: `api()`, `btn()`, `toast`, router hash, `handlers` (event delegation), panel (`panelOpen`/`panelView`), job runner (`runJob`), tema, PHP/Node/Herd |
| `static/terminal.js` | Tab Terminal: xterm.js per sesi, polling output, batching input, resize (FitAddon), reattach setelah refresh, `window.runInTerminal(cmd, cwd)` |
| `static/vendor/` | xterm.js + addon fit/web-links (MIT), disimpan lokal, jangan diganti CDN |
| `static/packages.js` | Halaman Paket & Service + detail service (`#service:<nama>`) + cloudflared |
| `static/docker.js` | Semua halaman Docker (`#docker:<sub>`) + pembuat compose + dialog buat container |
| `static/langs.js` | Halaman grup **Bahasa** (`#langs`, kartu 3 kolom + bahasa yang bisa di-install), halaman detail `#lang-<key>` (nav: `langs`), versi/status di sidebar (`applyNav`/`refreshNav`) |
| `static/config.js` | Halaman File konfigurasi (`#config:<id>`) |
| `static/dashboard.js` | Dashboard statistik + `lineChart()` (SVG, dipakai juga oleh docker.js) |
| `macapp/main.swift`, `install.sh` | Peluncur `Service Admin.app` (nyalakan server via LaunchAgent/fallback lalu buka browser) dan installer LaunchAgent `local.service-admin`. Server dari launchd butuh izin macOS *Files & Folders → Documents* untuk Python karena project ada di `~/Documents` |
| `static/icons.js` | Logo Simple Icons (CC0) + `logoSvg()` / `logoFor(formula)` |

## Pola kode

**Backend**
- Endpoint baru: tulis fungsi `(q)` untuk GET (dict query) atau `(body)` untuk POST (dict JSON), lalu
  daftarkan di `GET_ROUTES`/`POST_ROUTES`. Lempar `ApiError(pesan, HTTPStatus.X)` untuk error ke UI.
- Perintah lama (install, compose up, `laravel new`) → `start_job(label, cmd, kind)` atau
  `start_steps(label, [(judul, cmd|callable, opsi)], kind)`, kembalikan `{"job": id}`. Satu `kind`
  hanya boleh satu job berjalan.
- Tool di PATH user (rustup, pipx, nvm, …) bisa tidak ada di PATH server (misalnya saat jalan dari
  LaunchAgent). Resolve lewat `shell_probe` / `runtimes.tools()` (zsh interaktif) dan pakai path absolut.
- Pilih versi default: shim symlink di `~/.service-admin/bin` per bahasa (`set_shims(lang, {...})`)
  atau env di `~/.service-admin/env.zsh` (`set_env`, dipakai JAVA_HOME). Keduanya dimuat oleh satu
  blok di **paling bawah** `~/.zshrc` (`ensure_zshrc_block`).

**Frontend**
- Halaman = `tabs.<key> = { load(silent), interval?, nav?, title?, logo?, leave? }` (`nav` = item sidebar yang disorot, `title` = judul header bila berbeda); route `#key` atau `#key:param`
  (`this.param`). Alias lama: `#services`/`#apps` → `packages`, `#zsh` → `config`.
- Tombol: `btn(label, "aksi", {data}, "go|primary|danger")` + `handlers.aksi = async (dataset, el) => …`.
  `data-confirm` otomatis memunculkan konfirmasi.
- Proses panjang: `runJob(api("/api/…", body), onDone)`. Progres tampil di panel kanan, tab **Proses**
  (ikon terminal di header, titik merah saat berjalan). Tab **Terminal** adalah shell PTY sungguhan;
  program interaktif (claude, vim, tinker) harus lewat sini, bukan lewat job (job tidak punya TTY).
- Warna selalu lewat token CSS (`--bg`, `--card`, `--text`, `--series-1..4`, …). Tema: terang/gelap/
  sistem via `html[data-theme]`; token gelap didefinisikan di dua tempat (media query + `[data-theme="dark"]`).
- Selalu `esc()` untuk data dinamis di template string.

## Verifikasi

- Lint Python: `pipx run pyflakes *.py`. Cek syntax JS: `node --check static/*.js`.
- Tes backend: import modul langsung (`python3 -c "import dockerx; print(dockerx.overview({}))"`).
  Untuk fungsi yang menulis `~/.zshrc`/shim/state, **patch konstanta ke HOME sementara**
  (`core.HOME`, `core.DATA_DIR`, `core.SHIM_DIR`, …) supaya file asli user tidak berubah.
- Tes PTY: `import ptyterm`, `new_session` → `write(..."perintah\r")` → `read` (base64) → `kill`. Kalau
  menjalankan `claude` untuk tes, keluar dengan `\x03` lalu `kill` sesi.
- Tes UI: tidak ada Chrome; pakai Firefox headless
  `/Applications/Firefox.app/Contents/MacOS/firefox --headless --profile <dir> --no-remote --window-size=1300,1100 --screenshot out.png file://…`.
  Screenshot diambil saat event `load`, jadi buat halaman harness yang me-*stub* `window.fetch` dengan
  JSON hasil API asli dan jalankan aksi uji langsung di chain `initRuntimes().then(route).then(...)`
  (bukan `setTimeout`). Matikan transisi CSS kalau perlu (`#job{transition:none}`). Untuk konten yang
  dirender async (xterm.js), tahan event `load` dengan `<img>` dari server kecil yang sengaja lambat.
- Setelah mengubah `.py`, restart server (`kill $(lsof -ti tcp:8765)`, lalu jalankan lagi). File statis
  dikirim dengan `Cache-Control: no-cache`, jadi cukup refresh browser.

## Hal yang perlu diingat

- Shell user **zsh**: `$VAR` tidak di-word-split (pakai array `(${=VAR})`), dan `timeout` tidak ada.
- Jangan menjalankan aksi yang mengubah sistem user saat tes (brew install/uninstall, `herd use`,
  `nvm alias`, simpan `/etc/hosts`, dialog Finder/admin) tanpa diminta. Kalau perlu container/project
  uji, buat di scratchpad lalu bersihkan (`docker rm -f`, `compose down -v`, `rmi` image yang baru di-pull).
- Data persisten aplikasi: `~/.service-admin/` (`state.json`, `bin/`, `env.zsh`, `backups/`, `logs/`,
  `php-shims/`).
- Herd gratis tidak punya `services:*` (butuh Herd Pro). CLI Herd ada di
  `~/Library/Application Support/Herd/bin` (`herd`, `php84`, `composer`, `laravel`).

// Bahasa pemrograman: menu sidebar dibuat otomatis dari bahasa yang terdeteksi.
const LANG_ICON = `<svg viewBox="0 0 24 24"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg>`;
const fmtSize = (b) => (b == null ? "-" : fmtBytes(b));

// Tulis versi (dan titik status untuk Docker/Herd) di ujung kanan item sidebar.
function setNavVersion(a, version, running) {
  let v = a.querySelector(".nav-ver");
  if (!v) { v = document.createElement("span"); v.className = "nav-ver"; a.append(v); }
  const dot = running == null ? "" : `<i class="nav-dot ${running ? "on" : ""}" title="${running ? "berjalan" : "mati"}"></i>`;
  v.innerHTML = dot + esc(version || "");
}

let runtimeInfo = { langs: [], available: [] };
function applyNav(d) {
  runtimeInfo = d;
  const langs = document.querySelector('[data-nav="langs"]');
  if (langs) setNavVersion(langs, `${d.langs.length}`);
  const docker = document.querySelector('[data-nav="docker"]');
  if (docker) setNavVersion(docker, d.docker?.version || "–", d.docker ? d.docker.running : null);
  const herd = document.querySelector('[data-nav="herd"]');
  if (herd) setNavVersion(herd, d.herd?.version || "–", d.herd ? d.herd.running : null);
  if (current === tabs.langs && $("langGrid")) tabs.langs.render();
}

const langHref = (key) => (key === "php" || key === "node" ? `#${key}` : `#lang-${key}`);

async function initRuntimes() {
  // logo untuk item statis (Docker, Herd)
  document.querySelectorAll("[data-nav]").forEach((a) => {
    const logo = logoSvg(a.dataset.nav);
    if (logo) a.querySelector("svg").outerHTML = logo;
  });
  // halaman PHP & Node (app.js) dan halaman bahasa lain berada di bawah menu "Bahasa pemrograman"
  Object.assign(tabs.php, { nav: "langs", title: "PHP", logo: "php" });
  Object.assign(tabs.node, { nav: "langs", title: "Node.js", logo: "node" });
  let d = { langs: [], available: [] };
  try { d = await api("/api/runtimes"); } catch { /* halaman tetap tampil */ }
  d.langs.filter((l) => !l.builtin).forEach((l) => { tabs[`lang-${l.key}`] = makeLangTab(l.key); });
  applyNav(d);
}

// perbarui versi di sidebar & halaman bahasa (mis. setelah ganti default)
async function refreshNav(force) {
  try { applyNav(await api(`/api/runtimes${force ? "?refresh=1" : ""}`)); } catch { /* abaikan */ }
}

// ------------------------------------------------------------ halaman grup: semua bahasa
tabs.langs = {
  title: "Bahasa pemrograman",
  async load() {
    view.innerHTML = `<div id="langGrid"><div class="loading">Mendeteksi bahasa…</div></div>`;
    await refreshNav();
    this.render();
  },
  render() {
    const { langs, available = [] } = runtimeInfo;
    $("headline").textContent = `${langs.length} bahasa terinstall`;
    $("langGrid").innerHTML = `
      <div class="grid lang-grid">${langs.map((l) => `
        <a class="card lang-card" href="${langHref(l.key)}">
          <div class="row" style="flex-wrap:nowrap;gap:12px">
            ${logoSvg(l.key, "lang-logo") || `<span class="lang-logo pkg-fallback">${esc(l.name[0])}</span>`}
            <div style="min-width:0"><div class="lang-name">${esc(l.name)}</div>
              <div class="lang-ver">${esc(l.version || "?")}</div></div></div>
          <div class="row" style="gap:6px;margin:12px 0 6px">
            <span class="badge ${l.source === "Homebrew" ? "" : "blue"}">${esc(l.source)}</span>
            ${l.overridden ? `<span class="badge green" title="Versi default dipilih lewat Service Admin">default diatur</span>` : ""}
            ${l.managed || l.builtin ? "" : `<span class="badge">info</span>`}</div>
          <div class="muted small lang-path"><code>${esc(l.path.replace(/^\/Users\/[^/]+/, "~"))}</code></div>
          <div class="lang-foot">${l.managed || l.builtin ? "Kelola versi & paket →" : "Lihat detail →"}</div>
        </a>`).join("")}</div>
      ${available.length ? `<h2>Belum terinstall <span class="muted small">install lewat Homebrew</span></h2>
        <div class="grid lang-grid small">${available.map((a) => `<div class="card lang-card muted-card">
          <div class="row" style="flex-wrap:nowrap;gap:12px">${logoSvg(a.key, "lang-logo") || `<span class="lang-logo pkg-fallback">${esc(a.name[0])}</span>`}
            <div><div class="lang-name">${esc(a.name)}</div><div class="muted small"><code>${esc(a.formula)}</code>${a.type === "cask" ? " (app)" : ""}</div></div></div>
          <div class="lang-foot">${btn("Install", "langInstall", { formula: a.formula, type: a.type, name: a.name }, "go")}</div></div>`).join("")}</div>` : ""}`;
  },
};
handlers.langInstall = (d) => runJob(api("/api/apps/action", { name: d.formula, type: d.type, action: "install" }),
  () => refreshNav(true).then(() => { for (const l of runtimeInfo.langs) if (!l.builtin) tabs[`lang-${l.key}`] ??= makeLangTab(l.key); }));

function makeLangTab(key) {
  return {
    nav: "langs",
    async load() {
      let d;
      try { d = await api(`/api/lang?key=${key}`); } catch (e) { return failView(e); }
      $("pageTitle").innerHTML = `${logoSvg(key, "title-logo")}${esc(d.name)}`;
      $("headline").textContent = d.active.version ? `${d.name} aktif: ${d.active.version}` : "";
      const sel = d.selected;
      const selName = d.installs.find((i) => i.id === sel);
      const installs = d.installs.length ? `
        <h2 class="row">Versi terinstall <span class="spacer"></span>
          ${sel ? btn("Hapus override", "langAct", { key, action: "select", id: "default" }, "", `title="Kembali ke urutan PATH bawaan"`) : ""}</h2>
        <div class="list">${d.installs.map((i) => `<div class="card item">
          <div><div class="name">${esc(d.name)} ${esc(i.version || "?")} <span class="badge ${i.source === "Homebrew" ? "" : "blue"}">${esc(i.source)}</span>
            ${sel === i.id ? `<span class="badge green">default</span>` : ""}
            ${i.registered === false ? `<span class="badge amber" title="Belum di-symlink ke /Library/Java/JavaVirtualMachines. Tetap bisa dipakai lewat JAVA_HOME.">belum terdaftar di sistem</span>` : ""}</div>
            <div class="meta"><code>${esc(i.home || i.bin)}</code></div></div>
          <div class="actions">${d.selectable && sel !== i.id ? btn("Jadikan default", "langAct", { key, action: "select", id: i.id }, "primary") : ""}</div>
        </div>`).join("")}</div>` : "";
      view.innerHTML = `
        <p style="margin:0 0 12px"><a href="#langs">← Bahasa pemrograman</a></p>
        <div class="stat">
          <div class="card"><div>Terminal baru memakai</div><div>${esc(d.name)} ${esc(d.active.version || "tidak ditemukan")}</div>
            <div class="muted small"><code>${esc(d.active.path || "-")}</code> · ${esc(d.active.source || "")}</div></div>
          ${d.selectable ? `<div class="card"><div>Default dari Service Admin</div><div>${selName ? `${esc(selName.version)} <span class="muted small">${esc(selName.source)}</span>` : "Tidak diatur"}</div>
            <div class="muted small">${key === "java" ? "lewat JAVA_HOME di ~/.service-admin/env.zsh" : sel ? "via ~/.service-admin/bin" : "mengikuti urutan PATH di .zshrc"}</div></div>` : ""}
        </div>
        ${(LANG_RENDER[key]?.warn?.(d)) || ""}
        ${installs}
        ${d.selectable ? `<p class="muted small">${key === "java"
          ? "Default Java berlaku untuk terminal <b>baru</b> (atau jalankan <code>source ~/.zshrc</code>)."
          : "Ganti default langsung berlaku, termasuk di terminal yang sudah terbuka (jalankan <code>hash -r</code> kalau belum ikut)."}</p>` : ""}
        ${LANG_RENDER[key]?.body?.(d) || genericBody(d)}`;
      LANG_RENDER[key]?.bind?.(d);
    },
  };
}

function genericBody(d) {
  return `<h2>Info</h2><div class="card"><dl class="kv">
      <dt>Versi</dt><dd>${esc(d.active.version || "-")}</dd><dt>Lokasi</dt><dd><code>${esc(d.active.path)}</code></dd>
      <dt>Sumber</dt><dd>${esc(d.active.source)}</dd></dl></div>
    ${d.formula ? `<p class="row">Dipasang lewat Homebrew (<code>${esc(d.formula)}</code>).
      ${btn("Upgrade", "brewUpgrade", { name: d.formula })}</p>`
      : `<p class="muted small">Belum ada menu manajemen khusus untuk ${esc(d.name)}; halaman ini menampilkan info instalasinya.</p>`}`;
}

const tableOf = (head, rows) => rows.length
  ? `<div class="table-wrap"><table><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>${rows.join("")}</table></div>`
  : `<div class="empty">Kosong.</div>`;

function bindForm(id, fn) {
  const f = $(id);
  if (f) f.onsubmit = (e) => { e.preventDefault(); const v = new FormData(f).get("name").trim(); if (v) fn(v); };
}
const langJob = (key, action, name = "") => runJob(api("/api/lang/action", { key, action, name }), () => current.load());

const LANG_RENDER = {
  python: {
    warn: (d) => (d.cert_fix || []).map((v) => `<div class="warn row">⚠️ Python ${esc(v)} dari python.org belum memasang sertifikat SSL,
      jadi request HTTPS dari Python (pip, requests, urllib) bisa gagal dengan <code>CERTIFICATE_VERIFY_FAILED</code>.
      <span class="spacer"></span>${btn("Perbaiki sekarang", "langAct", { key: "python", action: "cert-fix", version: v, job: 1 }, "primary")}</div>`).join(""),
    body: (d) => `
      <h2 class="row">Aplikasi CLI (pipx) <span class="spacer"></span>
        ${d.pipx?.length ? btn("Upgrade semua", "langAct", { key: "python", action: "pipx-upgrade-all", job: 1 }) : ""}</h2>
      ${d.pipx == null ? `<div class="muted small">pipx tidak terinstall. Install lewat <a href="#packages">Paket &amp; Service</a> (cari <code>pipx</code>).</div>` : `
        ${tableOf(["Paket", "Versi", "Perintah", ""], d.pipx.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td><code>${esc(p.version)}</code></td>
          <td class="small">${p.apps.map((a) => `<code>${esc(a)}</code>`).join(" ")}</td>
          <td><div class="actions">${btn("Upgrade", "langAct", { key: "python", action: "pipx-upgrade", name: p.name, job: 1 })}
            ${btn("Uninstall", "langAct", { key: "python", action: "pipx-uninstall", name: p.name, job: 1, confirm: `Uninstall ${p.name}?` }, "danger")}</div></td></tr>`))}
        <form class="row" id="pipxInstall" style="margin-top:10px"><input type="text" name="name" placeholder="mis. httpie, black, poetry" style="flex:1;max-width:320px"><button class="go">pipx install</button></form>`}
      <h2 class="row">Paket pip (Python aktif) <span class="spacer"></span><input type="search" id="pipFilter" placeholder="Filter…"></h2>
      ${d.externally_managed ? `<p class="muted small">Python ini dikelola Homebrew (PEP 668): <code>pip install</code> global diblokir.
        Pakai <b>virtualenv</b> (<code>python3 -m venv .venv</code>) untuk project, atau <b>pipx</b> untuk aplikasi CLI.</p>` : ""}
      <div id="pipList">${d.packages ? "" : `<div class="muted small">Tidak bisa membaca daftar paket.</div>`}</div>
      ${d.tools?.length ? `<h2>Tool Python</h2><div class="card"><dl class="kv">${d.tools.map(([n, v, p]) => `<dt>${esc(n)}</dt><dd>${esc(v || "")} <span class="muted small"><code>${esc(p)}</code></span></dd>`).join("")}</dl></div>` : ""}`,
    bind(d) {
      bindForm("pipxInstall", (v) => langJob("python", "pipx-install", v));
      const draw = () => {
        if (!d.packages) return;
        const q = ($("pipFilter")?.value || "").toLowerCase();
        $("pipList").innerHTML = tableOf(["Paket", "Versi"], d.packages.filter((p) => p.name.toLowerCase().includes(q))
          .map((p) => `<tr><td>${esc(p.name)}</td><td><code>${esc(p.version)}</code></td></tr>`));
      };
      if ($("pipFilter")) $("pipFilter").oninput = draw;
      draw();
    },
  },

  go: {
    warn: (d) => d.latest && d.active.version && d.latest !== d.active.version
      ? `<div class="warn">⬆️ Go <b>${esc(d.latest)}</b> sudah rilis (kamu memakai ${esc(d.active.version)}).
          ${d.active.source === "Homebrew" ? `Upgrade lewat <a href="#packages">Paket &amp; Service</a> (<code>go</code>).`
            : `Download installer-nya di <a href="https://go.dev/dl/" target="_blank" rel="noopener">go.dev/dl</a>.`}</div>` : "",
    body: (d) => !d.env ? "" : `
      <div class="grid two" style="margin-top:14px">
        <div class="card"><h3>Environment</h3><dl class="kv">${Object.entries(d.env).map(([k, v]) =>
          `<dt>${k}</dt><dd><code>${esc(v || "-")}</code></dd>`).join("")}</dl></div>
        <div class="card"><h3>Cache</h3><dl class="kv">
            <dt>Module cache</dt><dd>${fmtSize(d.caches.modcache)}</dd><dt>Build cache</dt><dd>${fmtSize(d.caches.buildcache)}</dd></dl>
          <div class="row" style="margin-top:12px">
            ${btn("Bersihkan module cache", "langAct", { key: "go", action: "clean-modcache", job: 1, confirm: "Hapus semua module yang sudah di-download? Akan di-download ulang saat build." })}
            ${btn("Bersihkan build cache", "langAct", { key: "go", action: "clean-cache", job: 1 })}</div></div>
      </div>
      <h2>Tool terinstall <span class="muted small"><code>${esc(d.bindir)}</code></span></h2>
      ${d.tools.length ? `<div class="list">${d.tools.map((t) => `<div class="card item"><div class="name"><code>${esc(t)}</code></div>
        <div class="actions">${btn("Hapus", "langAct", { key: "go", action: "remove-tool", name: t, confirm: `Hapus ${t}?` }, "danger")}</div></div>`).join("")}</div>`
        : `<div class="muted small">Belum ada tool dari <code>go install</code>.</div>`}
      <form class="row" id="goInstall" style="margin-top:10px"><input type="text" name="name" placeholder="mis. golang.org/x/tools/gopls@latest" style="flex:1;max-width:420px"><button class="go">go install</button></form>`,
    bind: () => bindForm("goInstall", (v) => langJob("go", "install-tool", v)),
  },

  rust: {
    body: (d) => !d.rustup ? `<div class="warn">Rust tidak dipasang lewat rustup, jadi manajemen toolchain tidak tersedia.</div>` : `
      <div class="row" style="margin:14px 0">
        ${btn("rustup update", "langAct", { key: "rust", action: "update", job: 1 }, "primary")}
        ${btn("Cek update", "langAct", { key: "rust", action: "check", job: 1 })}
        <span class="muted small">rustup ${esc(d.rustup_version || "")}</span></div>
      <h2>Toolchain</h2>
      <div class="list">${d.toolchains.map((t) => `<div class="card item">
        <div class="name">${esc(t.name)} ${t.default ? `<span class="badge green">default</span>` : ""}${t.active ? `<span class="badge blue">aktif</span>` : ""}</div>
        <div class="actions">${t.default ? "" : btn("Jadikan default", "langAct", { key: "rust", action: "default", name: t.name }, "primary")
          + btn("Uninstall", "langAct", { key: "rust", action: "toolchain-uninstall", name: t.name, job: 1, confirm: `Uninstall toolchain ${t.name}?` }, "danger")}</div>
      </div>`).join("")}</div>
      <form class="row" id="rustTc" style="margin-top:10px"><input type="text" name="name" placeholder="stable, beta, nightly, 1.85" style="max-width:260px"><button class="go">Install toolchain</button></form>
      <div class="grid two" style="margin-top:14px">
        <div class="card"><h3>Target (${esc(d.active_toolchain)})</h3>
          ${d.targets.map((t) => `<div class="row issue" style="cursor:default"><code class="spacer">${esc(t)}</code>
            ${t.startsWith("aarch64-apple-darwin") ? "" : btn("Hapus", "langAct", { key: "rust", action: "target-remove", name: t, job: 1 }, "danger")}</div>`).join("")}
          <form class="row" id="rustTarget" style="margin-top:10px"><input type="text" name="name" placeholder="mis. wasm32-unknown-unknown" style="flex:1"><button>Tambah</button></form></div>
        <div class="card"><h3>Komponen</h3>
          <div class="row" style="gap:6px">${d.components.map((c) => `<span class="badge">${esc(c.replace(/-aarch64-apple-darwin$/, ""))}</span>`).join("")}</div>
          <form class="row" id="rustComp" style="margin-top:10px"><input type="text" name="name" placeholder="mis. rust-src, rust-analyzer" style="flex:1"><button>Tambah</button></form></div>
      </div>
      <h2>Crate terinstall (<code>cargo install</code>) <span class="muted small">registry cache ${fmtSize(d.registry_size)}</span></h2>
      ${tableOf(["Crate", "Versi", ""], (d.crates || []).map((c) => `<tr><td><b>${esc(c.name)}</b></td><td><code>${esc(c.version)}</code></td>
        <td><div class="actions">${btn("Update", "langAct", { key: "rust", action: "crate-install", name: c.name, job: 1 })}
          ${btn("Uninstall", "langAct", { key: "rust", action: "crate-uninstall", name: c.name, job: 1, confirm: `Uninstall ${c.name}?` }, "danger")}</div></td></tr>`))}
      <form class="row" id="rustCrate" style="margin-top:10px"><input type="text" name="name" placeholder="mis. cargo-watch, ripgrep" style="flex:1;max-width:320px"><button class="go">cargo install</button></form>`,
    bind() {
      bindForm("rustTc", (v) => langJob("rust", "toolchain-install", v));
      bindForm("rustTarget", (v) => langJob("rust", "target-add", v));
      bindForm("rustComp", (v) => langJob("rust", "component-add", v));
      bindForm("rustCrate", (v) => langJob("rust", "crate-install", v));
    },
  },

  java: {
    body: (d) => d.build_tools.length ? `<h2>Build tools</h2><div class="card"><dl class="kv">${d.build_tools.map(([n, v]) =>
      `<dt>${esc(n)}</dt><dd>${esc(v || "-")}</dd>`).join("")}</dl></div>` : "",
  },

  ruby: {
    warn: (d) => d.system_ruby ? `<div class="warn">ℹ️ Kamu memakai Ruby bawaan macOS (${esc(d.active.version)}). Versi ini lama dan
      <code>gem install</code> butuh sudo. Untuk development, install <code>ruby</code> lewat <a href="#packages">Paket &amp; Service</a> lalu jadikan default di sini.</div>` : "",
    body: (d) => `<h2 class="row">Gem terinstall <span class="spacer"></span><span class="muted small">${(d.gems || []).length} gem</span></h2>
      ${tableOf(["Gem", "Versi"], (d.gems || []).map((g) => `<tr><td>${esc(g.name)}</td><td class="small"><code>${esc(g.version)}</code></td></tr>`))}`,
  },
};

handlers.brewUpgrade = (d) => runJob(api("/api/apps/action", { name: d.name, type: "formula", action: "upgrade" }), () => current.load());
handlers.langAct = async (d) => {
  const body = { key: d.key, action: d.action, id: d.id, name: d.name, version: d.version };
  if (d.job) return runJob(api("/api/lang/action", body), () => current.load());
  const r = await api("/api/lang/action", body);
  toast(r.output || "Berhasil");
  await current.load();
  refreshNav();
};

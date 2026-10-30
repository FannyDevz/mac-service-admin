// Aplikasi Mac: daftar & cari, buka/tutup, update (Homebrew cask / App Store / macOS),
// detail aplikasi (#macapp:<path>) dengan izin privasi, dan ringkasan izin (#macapps:privacy).

const appIcon = (path, size = 32) =>
  `<img class="app-icon" loading="lazy" width="${size}" height="${size}" alt="" src="/api/macapps/icon?path=${encodeURIComponent(path)}">`;
const fmtUsed = (s) => {
  if (!s) return "belum pernah";
  const days = Math.floor((Date.now() - new Date(s.replace(" ", "T") + "Z")) / 86400000);
  return days <= 0 ? "hari ini" : days === 1 ? "kemarin" : days < 30 ? `${days} hari lalu` : days < 365 ? `${Math.floor(days / 30)} bulan lalu` : `${Math.floor(days / 365)} tahun lalu`;
};
const srcBadge = (s) => `<span class="badge ${s === "App Store" ? "blue" : s === "Homebrew" ? "amber" : ""}">${esc(s)}</span>`;
const PRIV_STATUS = { diizinkan: "green", ditolak: "bad", terbatas: "amber" };

tabs.macapps = {
  filter: "all", sort: "name", system: false, data: null,
  async load(silent) {
    const view2 = this.param === "privacy" ? "privacy" : "apps";
    if (!silent || !$("maBody")) {
      view.innerHTML = `
        <div class="row" style="margin-bottom:12px">
          <div class="seg">${[["apps", "Aplikasi"], ["privacy", "Izin privasi"]].map(([k, l]) =>
            `<a class="pill-link ${k === view2 ? "active" : ""}" href="#macapps${k === "privacy" ? ":privacy" : ""}">${l}</a>`).join("")}</div>
          <span class="spacer"></span>
          ${btn("Cek update macOS", "maAct", { action: "macos-updates", job: 1 })}
          <span id="maMas"></span>
        </div>
        <div id="maBody"><div class="loading">Membaca aplikasi…</div></div>`;
    }
    if (view2 === "privacy") return this.privacy();
    try { this.data = await api(`/api/macapps${this.system ? "?system=1" : ""}`); } catch (e) { return failView(e); }
    $("maMas").innerHTML = this.data.mas ? btn("Cek update App Store", "maAct", { action: "mas-outdated", job: 1 })
      : btn("Install mas (update App Store)", "maInstallMas", {}, "", `title="CLI App Store untuk cek & update aplikasi App Store"`);
    if (!$("maList")) {
      $("maBody").innerHTML = `
        <div class="row" style="margin-bottom:12px">
          <input type="search" id="maQ" placeholder="Cari aplikasi atau bundle id…" style="flex:1;min-width:220px">
          <div class="seg" id="maFilter"></div>
          <select id="maSort"><option value="name">Nama</option><option value="size">Ukuran</option><option value="used">Terakhir dibuka</option></select>
          <label class="chk"><input type="checkbox" id="maSys" ${this.system ? "checked" : ""}> aplikasi sistem</label>
        </div>
        <div class="list" id="maList"></div>`;
      $("maQ").oninput = () => this.render();
      $("maSort").value = this.sort;
      $("maSort").onchange = (e) => { this.sort = e.target.value; this.render(); };
      $("maSys").onchange = (e) => { this.system = e.target.checked; $("maList").innerHTML = `<div class="loading">Memuat…</div>`; this.load(); };
      $("maQ").focus();
    }
    this.render();
  },
  render() {
    const apps = this.data.apps, q = ($("maQ")?.value || "").toLowerCase();
    const counts = { all: apps.length, running: apps.filter((a) => a.running).length, outdated: apps.filter((a) => a.outdated).length,
      "App Store": apps.filter((a) => a.source === "App Store").length, Homebrew: apps.filter((a) => a.source === "Homebrew").length,
      Manual: apps.filter((a) => a.source === "Manual").length };
    const labels = { all: "Semua", running: "Berjalan", outdated: "Ada update", "App Store": "App Store", Homebrew: "Homebrew", Manual: "Manual" };
    $("maFilter").innerHTML = Object.entries(labels).map(([k, l]) =>
      btn(`${l} <span class="muted">${counts[k]}</span>`, "maFilter", { f: k }, this.filter === k ? "active" : "")).join("");
    const total = apps.reduce((s, a) => s + (a.size || 0), 0);
    $("headline").textContent = `${apps.length} aplikasi · ${fmtBytes(total)} · ${counts.running} berjalan`;
    const pick = { all: () => true, running: (a) => a.running, outdated: (a) => a.outdated }[this.filter] || ((a) => a.source === this.filter);
    const sorter = { name: (a, b) => a.name.localeCompare(b.name), size: (a, b) => (b.size || 0) - (a.size || 0),
      used: (a, b) => (b.last_used || "").localeCompare(a.last_used || "") }[this.sort];
    const list = apps.filter((a) => pick(a) && (!q || a.name.toLowerCase().includes(q) || (a.bundle_id || "").toLowerCase().includes(q))).sort(sorter);
    $("maList").innerHTML = list.map((a) => {
      const d = { path: a.path };
      return `<div class="card item app-row">
        <a class="row" style="flex-wrap:nowrap;gap:12px;min-width:0;color:inherit;text-decoration:none" href="#macapp:${encodeURIComponent(a.path)}">
          ${appIcon(a.path, 36)}
          <div style="min-width:0"><div class="name">${a.running ? `<span class="dot on" title="Sedang berjalan"></span>` : ""}${esc(a.name)}
              <span class="muted small">${esc(a.version || "")}</span>${srcBadge(a.source)}
              ${a.outdated ? `<span class="badge amber">update → ${esc(a.latest)}</span>` : ""}</div>
            <div class="meta"><span>${a.size ? fmtBytes(a.size) : "–"}</span><span>dibuka ${fmtUsed(a.last_used)}</span>
              <span class="muted"><code>${esc(a.bundle_id || "")}</code></span></div></div></a>
        <div class="actions">
          ${a.outdated && a.cask ? btn("Update", "maUpdate", { cask: a.cask, name: a.name }, "go") : ""}
          ${a.running ? btn("Tutup", "maAct", { ...d, action: "quit" }) : btn("Buka", "maAct", { ...d, action: "open" }, "primary")}
          ${btn("Finder", "maAct", { ...d, action: "reveal" })}
          <a class="btn-link" href="#macapp:${encodeURIComponent(a.path)}">Detail & izin →</a>
        </div></div>`;
    }).join("") || `<div class="empty">Tidak ada aplikasi yang cocok.</div>`;
  },

  // ---------------------------------------------------------- ringkasan izin privasi
  async privacy() {
    let d, apps;
    try { [d, apps] = await Promise.all([api("/api/macapps/privacy"), api("/api/macapps?system=1")]); } catch (e) { return failView(e); }
    $("maMas").innerHTML = "";
    const byId = Object.fromEntries(apps.apps.map((a) => [a.bundle_id, a]));
    $("headline").textContent = "Izin privasi (TCC)";
    const unread = Object.entries(d.tcc_readable).filter(([, v]) => !v).map(([k]) => k);
    $("maBody").innerHTML = `
      ${unread.length ? `<div class="warn">Sebagian izin tidak terbaca (database <b>${unread.join(", ")}</b>). Izin seperti Kamera, Mikrofon,
        Kontak, dan Automation tersimpan di database user yang butuh <b>Full Disk Access</b> untuk dibaca. Beri Full Disk Access ke
        <b>Python</b> (${btn("buka pengaturan", "maAct", { action: "open-settings", url: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles" })})
        kalau ingin melihat semuanya. Setiap izin tetap bisa diatur lewat tombol di bawah.</div>` : ""}
      <div class="grid privacy-panes">${d.panes.map((p) => `<button class="pane-btn" data-act="maAct" data-action="open-settings" data-url="${esc(p.settings)}">
        <b>${esc(p.name)}</b><span class="muted small">buka pengaturan ↗</span></button>`).join("")}</div>
      ${d.services.map((g) => `<div class="card" style="margin-top:14px">
        <h3>${esc(g.name)} <span class="muted small">${g.apps.length} aplikasi</span><span class="spacer"></span>
          ${btn("Atur di System Settings ↗", "maAct", { action: "open-settings", url: g.settings })}</h3>
        <div class="priv-apps">${g.apps.sort((a, b) => a.client.localeCompare(b.client)).map((x) => {
          const app = byId[x.client];
          return `<${app ? `a href="#macapp:${encodeURIComponent(app.path)}"` : "div"} class="priv-app">
            ${app ? appIcon(app.path, 22) : `<span class="app-icon ph"></span>`}
            <span class="spacer" title="${esc(x.client)}">${esc(app?.name || x.client.split("/").pop())}</span>
            <span class="badge ${PRIV_STATUS[x.status] || ""}">${esc(x.status)}</span></${app ? "a" : "div"}>`;
        }).join("")}</div></div>`).join("")}`;
  },
};
handlers.maFilter = (d) => { tabs.macapps.filter = d.f; tabs.macapps.render(); };
handlers.maAct = async (d) => {
  const body = { action: d.action, path: d.path, url: d.url, service: d.service };
  if (d.job) return runJob(api("/api/macapps/action", body));
  const r = await api("/api/macapps/action", body);
  const msg = { open: "Aplikasi dibuka", quit: r.ok ? "Aplikasi ditutup" : `Gagal menutup: ${r.output || ""}`, "force-quit": `Dihentikan paksa (${r.killed} proses)`,
    reveal: "Ditampilkan di Finder", unquarantine: "Karantina dihapus, aplikasi bisa dibuka", trash: "Dipindahkan ke Trash",
    "reset-permission": "Izin direset, aplikasi akan bertanya lagi saat dibutuhkan", "open-settings": "System Settings dibuka" }[d.action];
  if (msg) toast(msg, d.action === "quit" && !r.ok);
  if (d.action === "trash") location.hash = "#macapps";
  else setTimeout(() => current.load(current === tabs.macapps), d.action === "open" ? 1500 : 400);
};
handlers.maUpdate = (d) => runJob(api("/api/apps/action", { name: d.cask, type: "cask", action: "upgrade" }), () => current.load());
handlers.maInstallMas = () => runJob(api("/api/apps/action", { name: "mas", type: "formula", action: "install" }), () => current.load());

// ---------------------------------------------------------- detail aplikasi
const PRIV_URL = "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?";
// izin yang disimpan di database TCC sistem (bukan user)
const SYSTEM_PRIV = [["kTCCServiceAccessibility", "Aksesibilitas", "Privacy_Accessibility"],
  ["kTCCServiceScreenCapture", "Rekam layar & audio", "Privacy_ScreenCapture"],
  ["kTCCServiceSystemPolicyAllFiles", "Full Disk Access", "Privacy_AllFiles"],
  ["kTCCServiceListenEvent", "Input Monitoring", "Privacy_ListenEvent"]];
function privRow(a, d, p) {
  const scope = SYSTEM_PRIV.some(([k]) => k === p.key) ? "system" : "user";
  const status = p.status ? `<span class="badge ${PRIV_STATUS[p.status] || ""}">${esc(p.status)}</span>`
    : `<span class="badge">${a.tcc_readable[scope] ? "belum diminta" : "tidak terbaca"}</span>`;
  return `<div class="priv-row">
    <div><b>${esc(p.name)}</b> ${status}${p.requested ? `<span class="muted small"> · diminta aplikasi</span>` : ""}
      ${p.targets.length ? `<div class="muted small">ke: ${p.targets.map(esc).join(", ")}</div>` : ""}</div>
    <div class="actions">${btn("Atur ↗", "maAct", { action: "open-settings", url: p.settings })}
      ${a.bundle_id ? btn("Reset", "maAct", { ...d, action: "reset-permission", service: p.key, confirm: `Reset izin ${p.name} untuk ${a.name}?` }) : ""}</div>
  </div>`;
}

tabs.macapp = {
  nav: "macapps",
  async load() {
    let a;
    try { a = await api(`/api/macapps/detail?path=${encodeURIComponent(this.param)}`); } catch (e) { return failView(e); }
    const list = tabs.macapps.data?.apps || (await api("/api/macapps?system=1")).apps;
    const meta = list.find((x) => x.path === a.path) || {};
    $("pageTitle").innerHTML = `${appIcon(a.path, 24).replace('class="app-icon"', 'class="app-icon title-logo"')}${esc(a.name || meta.name)}`;
    $("headline").textContent = a.bundle_id || "";
    const d = { path: a.path };
    const readAny = a.tcc_readable.user || a.tcc_readable.system;
    view.innerHTML = `
      <p style="margin:0 0 12px"><a href="#macapps">← Aplikasi Mac</a></p>
      <div class="card item" style="margin-bottom:14px">
        <div class="row" style="flex-wrap:nowrap;gap:14px">${appIcon(a.path, 56)}
          <div><div class="name" style="font-size:16px">${meta.running ? `<span class="dot on"></span>` : ""}${esc(a.name || meta.name)}
              <span class="muted small">${esc(a.version || "")}${a.build && a.build !== a.version ? ` (${esc(a.build)})` : ""}</span>${srcBadge(meta.source || "")}
              ${meta.outdated ? `<span class="badge amber">update → ${esc(meta.latest)}</span>` : ""}</div>
            <div class="meta"><code>${esc(a.path)}</code></div></div></div>
        <div class="actions">
          ${meta.outdated && meta.cask ? btn("Update", "maUpdate", { cask: meta.cask, name: meta.name }, "go") : ""}
          ${meta.source === "App Store" ? btn("Update App Store", "maAct", { ...d, action: "mas-upgrade", job: 1 }) : ""}
          ${meta.running ? btn("Tutup", "maAct", { ...d, action: "quit" }) + btn("Paksa tutup", "maAct", { ...d, action: "force-quit", confirm: "Paksa tutup? Perubahan yang belum disimpan bisa hilang." }, "danger")
                         : btn("Buka", "maAct", { ...d, action: "open" }, "primary")}
          ${btn("Tampilkan di Finder", "maAct", { ...d, action: "reveal" })}
        </div></div>
      ${a.quarantined ? `<div class="warn row">⚠️ Aplikasi ini masih ditandai <b>karantina</b> oleh Gatekeeper (baru di-download). Kalau muncul pesan
        "rusak" atau "tidak bisa dibuka", hapus tanda karantina. Lakukan hanya untuk aplikasi yang kamu percaya.
        <span class="spacer"></span>${btn("Hapus karantina", "maAct", { ...d, action: "unquarantine", confirm: "Hapus tanda karantina? Pastikan aplikasi ini dari sumber tepercaya." })}</div>` : ""}
      <div class="grid two">
        <div class="card"><h3>Info</h3><dl class="kv">
          <dt>Bundle ID</dt><dd><code>${esc(a.bundle_id || "-")}</code></dd>
          <dt>Versi</dt><dd>${esc(a.version || "-")}</dd><dt>Sumber</dt><dd>${esc(meta.source || "-")}${meta.cask ? ` · <code>${esc(meta.cask)}</code>` : ""}</dd>
          <dt>Ukuran</dt><dd>${meta.size ? fmtBytes(meta.size) : "-"}</dd><dt>Terakhir dibuka</dt><dd>${fmtUsed(meta.last_used)}</dd>
          <dt>Arsitektur</dt><dd>${esc(a.arch || "-")}</dd><dt>Min. macOS</dt><dd>${esc(a.min_os || "-")}</dd>
          <dt>Ditandatangani</dt><dd>${esc(a.signed_by || "tidak ditandatangani")}</dd>
          ${a.sparkle ? `<dt>Update</dt><dd>otomatis dari aplikasi (Sparkle)</dd>` : ""}
          ${a.copyright ? `<dt>Hak cipta</dt><dd class="small">${esc(a.copyright)}</dd>` : ""}</dl></div>
        <div class="card"><h3>🔐 Izin privasi <span class="spacer"></span>
            ${a.bundle_id ? btn("Reset semua izin", "maAct", { ...d, action: "reset-permission", service: "All", confirm: `Reset semua izin ${a.name}? Aplikasi akan bertanya lagi saat membutuhkannya.` }) : ""}</h3>
          ${a.privacy.map((p) => privRow(a, d, p)).join("") || (readAny ? `<div class="muted small">Aplikasi ini tidak meminta izin privasi khusus.</div>` : "")}
          ${!a.tcc_readable.system ? `<div class="muted small" style="margin:10px 0 2px">Izin tingkat sistem:</div>
            ${SYSTEM_PRIV.filter(([k]) => !a.privacy.some((p) => p.key === k)).map(([key, name, anchor]) =>
              privRow(a, d, { key, name, status: null, requested: false, targets: [], settings: PRIV_URL + anchor })).join("")}` : ""}
          ${!readAny ? `<p class="muted small">Status izin tidak bisa dibaca karena macOS melindungi database izin. Untuk melihat statusnya, beri
            <b>Full Disk Access</b> ke <b>Python</b> (${btn("buka pengaturan", "maAct", { action: "open-settings", url: PRIV_URL + "Privacy_AllFiles" })}).
            Tombol <b>Atur ↗</b> dan <b>Reset</b> tetap berfungsi.</p>` : !a.tcc_readable.user ? `<p class="muted small">Status Kamera/Mikrofon/Kontak/Automation butuh Full Disk Access untuk dibaca.</p>` : ""}
          ${Object.keys(a.usage_texts).length ? `<details style="margin-top:8px"><summary class="muted small">Alasan yang ditulis aplikasi</summary>
            <dl class="kv small" style="margin-top:6px">${Object.entries(a.usage_texts).map(([k, v]) => `<dt>${esc(k)}</dt><dd style="text-align:left">${esc(v)}</dd>`).join("")}</dl></details>` : ""}
        </div>
      </div>
      <h2>Zona berbahaya</h2>
      <div class="card item"><div><b>Pindahkan ke Trash</b><div class="muted small">${meta.source === "Homebrew"
          ? `Aplikasi ini dipasang lewat Homebrew. Sebaiknya uninstall lewat Homebrew supaya catatannya ikut bersih.`
          : meta.source === "App Store" ? "Aplikasi App Store; bisa di-download lagi dari App Store." : "Bisa dikembalikan dari Trash selama belum dikosongkan."}</div></div>
        <div class="actions">${meta.cask ? btn("Uninstall (Homebrew)", "maBrewUninstall", { cask: meta.cask, name: meta.name, confirm: `Uninstall ${meta.name} lewat Homebrew?` }, "danger") : ""}
          ${meta.system ? "" : btn("Pindahkan ke Trash", "maAct", { ...d, action: "trash", confirm: `Pindahkan ${meta.name} ke Trash?` }, "danger")}</div></div>`;
  },
};
handlers.maBrewUninstall = (d) => runJob(api("/api/apps/action", { name: d.cask, type: "cask", action: "uninstall" }), () => { location.hash = "#macapps"; });

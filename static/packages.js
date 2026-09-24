// Paket & Service: gabungan paket Homebrew (CLI + app) dan brew services,
// plus halaman detail service (#service:<nama>) untuk config, info, dan cloudflared.

const pkgIcon = (name, type) => logoSvg(logoFor(name) || "", "pkg-logo") ||
  `<span class="pkg-logo pkg-fallback">${type === "cask" ? "▣" : "›_"}</span>`;

function svcDot(s) {
  if (!s) return "";
  return s.running ? "on" : s.status === "error" ? "bad" : s.status === "none" ? "" : "mid";
}

function svcActions(s, detail = true) {
  const d = { name: s.name };
  const main = s.running
    ? btn("Restart", "svc", { ...d, action: "restart" }) + btn("Stop", "svc", { ...d, action: "stop", confirm: `Stop ${s.name}?` }, "danger")
    : btn("Start", "svc", { ...d, action: "start" }, "go", `title="Start + auto-start saat login"`) +
      btn("Run", "svc", { ...d, action: "run" }, "", `title="Jalankan sekarang saja, tanpa auto-start"`) +
      (s.status === "error" || s.loaded ? btn("Stop", "svc", { ...d, action: "stop" }, "danger") : "");
  return main + btn("Log", "svcLog", d) +
    (detail ? `<a class="btn-link" href="#service:${encodeURIComponent(s.name)}">Detail & config →</a>` : "");
}

function svcStats(s) {
  if (s.running) {
    return `<span>PID <code>${s.pid}</code></span><span>CPU ${s.cpu ?? "-"}%</span><span>RAM ${s.mem_mb ?? "-"} MB</span><span>Uptime ${esc(s.uptime ?? "-")}</span>`;
  }
  return s.exit_code != null ? `<span>Exit code <code>${s.exit_code}</code></span>` : "";
}

tabs.packages = {
  interval: 5000,
  filter: "service",
  apps: null,
  services: [],
  async load(silent) {
    try {
      if (silent) {
        this.services = (await api("/api/services")).services;
      } else {
        this.skeleton();
        const [svcs, apps] = await Promise.all([api("/api/services"), api("/api/apps").catch(() => null)]);
        this.services = svcs.services;
        this.apps = apps?.apps || [];
        if (!this.catalog) api("/api/services/catalog").then((c) => { this.catalog = c.catalog; this.render(); }).catch(() => {});
      }
    } catch (e) { return silent || failView(e); }
    if ($("pkgList")) this.render();
  },
  skeleton() {
    view.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <form class="row" id="pkgSearch" style="flex:1;min-width:260px">
          <input type="search" id="pkgQ" placeholder="Cari paket terinstall, atau tekan Enter untuk cari di Homebrew…" style="flex:1">
          <button>Cari di Homebrew</button>
        </form>
        ${btn("Upgrade semua", "pkgUpgradeAll", { confirm: "Jalankan brew upgrade untuk semua paket?" })}
      </div>
      <div class="row" style="margin-bottom:14px"><div class="seg" id="pkgFilter"></div><span class="spacer"></span><span class="muted small" id="pkgNote"></span></div>
      <div id="pkgResults"></div>
      <div id="pkgList"><div class="loading">Membaca Homebrew…</div></div>`;
    $("pkgQ").oninput = () => this.render();
    $("pkgSearch").onsubmit = (e) => { e.preventDefault(); this.search(); };
  },
  rows() {
    const svcBy = Object.fromEntries(this.services.map((s) => [s.name, s]));
    const apps = (this.apps || []).map((a) => ({ ...a, svc: svcBy[a.name] }));
    // service yang formulanya tidak ada di daftar paket (jarang, mis. dari tap)
    for (const s of this.services) {
      if (!apps.some((a) => a.name === s.name)) apps.push({ name: s.name, type: "formula", desc: "", version: "", on_request: true, svc: s });
    }
    return apps;
  },
  render() {
    const all = this.rows(), q = ($("pkgQ")?.value || "").toLowerCase();
    const counts = {
      service: all.filter((a) => a.svc).length, all: all.filter((a) => a.on_request).length,
      cli: all.filter((a) => a.type === "formula" && a.on_request).length, app: all.filter((a) => a.type === "cask").length,
      outdated: all.filter((a) => a.outdated).length, recommend: 100,
    };
    const running = this.services.filter((s) => s.running).length;
    $("headline").textContent = `${running}/${this.services.length} service berjalan · ${counts.all} paket`;
    $("svcCount").innerHTML = `<i class="nav-dot ${running ? "on" : ""}"></i>${running}/${this.services.length}`;
    const labels = { service: "Service", all: "Semua", cli: "CLI", app: "App", outdated: "Ada update", recommend: "⭐ Rekomendasi" };
    $("pkgFilter").innerHTML = Object.entries(labels).map(([k, l]) =>
      btn(`${l} <span class="muted">${counts[k]}</span>`, "pkgFilter", { f: k }, this.filter === k ? "active" : "")).join("");
    const match = (a) => !q || a.name.toLowerCase().includes(q) || (a.desc || "").toLowerCase().includes(q);
    if (this.filter === "recommend") return this.renderRecommend(match);
    const pick = {
      service: (a) => a.svc, all: (a) => a.on_request, cli: (a) => a.type === "formula" && a.on_request,
      app: (a) => a.type === "cask", outdated: (a) => a.outdated,
    }[this.filter];
    const list = all.filter((a) => pick(a) && match(a)).sort((a, b) => (b.svc?.running ? 1 : 0) - (a.svc?.running ? 1 : 0) || a.name.localeCompare(b.name));
    $("pkgNote").textContent = this.apps === null ? "" : this.filter === "all" ? "dependency disembunyikan" : "";

    if (this.filter === "service") {
      const cards = list.map((a) => {
        const s = a.svc;
        return `<div class="card item">
          <div class="row" style="flex-wrap:nowrap;align-items:flex-start;gap:12px">${pkgIcon(a.name, a.type)}
            <div><div class="name"><span class="dot ${svcDot(s)}"></span>${esc(a.name)} <span class="badge">${esc(s.status)}</span>
              ${s.registered ? `<span class="badge blue" title="Otomatis jalan saat login">auto-start</span>` : ""}
              ${a.outdated ? `<span class="badge amber">update → ${esc(a.latest || "baru")}</span>` : ""}</div>
            <div class="meta">${a.desc ? `<span>${esc(a.desc)}</span>` : ""}${svcStats(s)}</div></div></div>
          <div class="actions">${svcActions(s)}</div></div>`;
      }).join("");
      const installed = new Set(all.map((a) => a.name));
      const cat = (this.catalog || []).filter((c) => !c.installed && !installed.has(c.formula.split("/").pop()) && match({ name: c.formula, desc: c.desc + c.name }));
      $("pkgList").innerHTML = `<div class="list">${cards || `<div class="empty">Tidak ada service.</div>`}</div>
        <h2>Install service baru</h2>
        ${this.catalog ? `<div class="grid cat-grid">${cat.map((c) => `<div class="card cat">
            <div class="row" style="flex-wrap:nowrap">${pkgIcon(c.formula, "formula")}<div><b>${esc(c.name)}</b>
              <div class="muted small">${esc(c.category)} · <code>${esc(c.formula.split("/").pop())}</code></div></div></div>
            <div class="muted small" style="margin:8px 0 10px;min-height:36px">${esc(c.desc)}</div>
            ${btn("Install", "svcInstall", { formula: c.formula }, "go")}</div>`).join("")}</div>`
          : `<div class="loading">Memuat katalog…</div>`}`;
      return;
    }
    $("pkgList").innerHTML = list.length ? `<div class="table-wrap"><table>
      <tr><th>Paket</th><th>Versi</th><th>Service</th><th></th></tr>
      ${list.map((a) => {
        const d = { name: a.name, type: a.type };
        return `<tr>
          <td><div class="row" style="flex-wrap:nowrap;gap:10px">${pkgIcon(a.name, a.type)}<div>
            <b>${esc(a.name)}</b> <span class="badge ${a.type === "cask" ? "blue" : ""}">${a.type === "cask" ? "app" : "cli"}</span>
            <div class="muted small">${esc(a.desc)}</div></div></div></td>
          <td class="small"><code>${esc(a.version)}</code>${a.outdated ? `<br><span class="badge amber">→ ${esc(a.latest || "baru")}</span>` : ""}</td>
          <td class="small">${a.svc ? `<a href="#service:${encodeURIComponent(a.name)}" class="row" style="gap:6px;text-decoration:none;color:inherit">
            <span class="dot ${svcDot(a.svc)}"></span>${esc(a.svc.status)}</a>` : `<span class="muted">–</span>`}</td>
          <td><div class="actions">
            ${a.outdated ? btn("Upgrade", "pkg", { ...d, action: "upgrade" }, "go") : ""}
            ${a.svc ? `<a class="btn-link" href="#service:${encodeURIComponent(a.name)}">Detail →</a>` : ""}
            ${btn("Uninstall", a.svc ? "svcUninstall" : "pkg", { ...d, action: "uninstall", confirm: `Uninstall ${a.name}?` }, "danger")}
          </div></td></tr>`;
      }).join("")}</table></div>` : `<div class="empty">${this.apps === null ? "Memuat…" : "Tidak ada yang cocok."}</div>`;
  },
  // 100 paket development yang direkomendasikan, dikelompokkan per kategori
  renderRecommend(match) {
    $("pkgNote").textContent = "";
    if (!this.recommend) {
      $("pkgList").innerHTML = `<div class="loading">Memuat rekomendasi…</div>`;
      api("/api/recommend").then((r) => { this.recommend = r.items; if (this.filter === "recommend") this.render(); })
        .catch((e) => { $("pkgList").innerHTML = `<div class="err">${esc(e.message)}</div>`; });
      return;
    }
    const cats = [...new Set(this.recommend.map((r) => r.category))];
    const cat = this.recCat || "Semua";
    const items = this.recommend.filter((r) => (cat === "Semua" || r.category === cat) && match(r) && (!this.recHide || !r.installed));
    const done = this.recommend.filter((r) => r.installed).length;
    const groups = {};
    items.forEach((r) => (groups[r.category] ??= []).push(r));
    $("pkgList").innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <div class="pills">${["Semua", ...cats].map((c) => btn(esc(c), "recCat", { c }, c === cat ? "active" : "")).join("")}</div>
        <span class="spacer"></span>
        <label class="chk"><input type="checkbox" id="recHide" ${this.recHide ? "checked" : ""}> sembunyikan yang sudah terinstall</label>
        <span class="muted small">${done}/100 terinstall</span>
      </div>
      ${Object.entries(groups).map(([g, list]) => `<h2>${esc(g)} <span class="muted small">${list.length}</span></h2>
        <div class="grid cat-grid">${list.map((r) => `<div class="card cat">
          <div class="row" style="flex-wrap:nowrap">${pkgIcon(r.name, r.type)}<div><b>${esc(r.name)}</b>
            <div class="muted small">${r.type === "cask" ? "aplikasi" : "cli / service"}</div></div></div>
          <div class="muted small" style="margin:8px 0 10px;min-height:36px">${esc(r.desc)}</div>
          ${r.installed ? `<span class="badge green" style="align-self:flex-start;margin-top:auto">✓ terinstall</span>`
            : btn("Install", "recInstall", { name: r.name, type: r.type }, "go")}</div>`).join("")}</div>`).join("")
      || `<div class="empty">Tidak ada yang cocok.</div>`}`;
    $("recHide").onchange = (e) => { this.recHide = e.target.checked; this.render(); };
  },
  async search() {
    const q = $("pkgQ").value.trim();
    if (!q) return;
    $("pkgResults").innerHTML = `<div class="loading">Mencari “${esc(q)}” di Homebrew…</div>`;
    try {
      const { results } = await api(`/api/apps/search?q=${encodeURIComponent(q)}`);
      $("pkgResults").innerHTML = `<div class="card" style="margin-bottom:16px"><h3>Hasil pencarian Homebrew <span class="spacer"></span>
          ${btn("Tutup", "pkgCloseSearch")}</h3>
        <div class="list">${results.map((r) => `<div class="item" style="padding:6px 0;border-bottom:1px solid var(--border)">
          <div class="name">${pkgIcon(r.name, r.type)}${esc(r.name)} <span class="badge ${r.type === "cask" ? "blue" : ""}">${r.type === "cask" ? "app" : "cli"}</span></div>
          <div class="actions">${r.installed ? `<span class="badge green">terinstall</span>` : btn("Install", "pkg", { name: r.name, type: r.type, action: "install" }, "go")}</div>
        </div>`).join("") || `<div class="muted small">Tidak ditemukan.</div>`}</div></div>`;
    } catch (e) { $("pkgResults").innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  },
};

const reloadPackages = () => { if (current === tabs.packages) tabs.packages.load(); else current?.load?.(); };
handlers.pkgFilter = (d) => { tabs.packages.filter = d.f; tabs.packages.render(); };
handlers.recCat = (d) => { tabs.packages.recCat = d.c; tabs.packages.render(); };
handlers.recInstall = (d) => runJob(api("/api/apps/action", { name: d.name, type: d.type, action: "install" }),
  () => { tabs.packages.recommend = null; reloadPackages(); });
handlers.pkgCloseSearch = () => { $("pkgResults").innerHTML = ""; };
handlers.pkg = (d) => runJob(api("/api/apps/action", { name: d.name, type: d.type, action: d.action }), reloadPackages);
handlers.pkgUpgradeAll = () => runJob(api("/api/apps/action", { action: "upgrade-all" }), reloadPackages);
handlers.svcInstall = (d) => runJob(api("/api/services/install", { formula: d.formula }), () => { tabs.packages.catalog = null; reloadPackages(); });
handlers.svcUninstall = (d) => runJob(api("/api/services/uninstall", { name: d.name }), () => {
  if (current === tabs.service) location.hash = "#packages"; else reloadPackages();
});
handlers.svc = async (d) => {
  const r = await api("/api/action", { name: d.name, action: d.action });
  toast(r.output || `${d.action} ${d.name} OK`);
  await current.load(current === tabs.packages);
};
handlers.svcLog = async (d) => {
  const r = await api(`/api/logs?name=${encodeURIComponent(d.name)}`);
  let txt = "";
  if (r.log != null) txt += `# ${r.log_path}\n${r.log || "(kosong)"}\n`;
  if (r.error_log != null) txt += `\n# ${r.error_log_path}\n${r.error_log || "(kosong)"}`;
  showLog(`Log — ${d.name}`, txt || "Service ini tidak mendefinisikan file log di plist-nya.");
};

// ------------------------------------------------------------ detail service
tabs.service = {
  nav: "packages",
  file: null,
  async load() {
    const name = this.param;
    let d, cf = null;
    try {
      d = await api(`/api/services/detail?name=${encodeURIComponent(name)}`);
      if (name === "cloudflared") cf = await api("/api/cloudflared").catch((e) => ({ error: e.message }));
    } catch (e) { return failView(e); }
    const s = d.service, f = d.formula;
    $("pageTitle").innerHTML = `${logoSvg(logoFor(name) || "", "title-logo")}${esc(name)}`;
    $("headline").textContent = f.version ? `versi ${f.version}` : "";
    if (!d.config_files.includes(this.file)) this.file = d.config_files[0] || null;
    const kv = [
      ["Status", `<span class="row" style="gap:6px;justify-content:flex-end"><span class="dot ${svcDot(s)}"></span>${esc(s.status)}</span>`],
      ["Auto-start saat login", s.registered ? "Ya" : "Tidak"],
      s.pid && ["PID", s.pid],
      d.ports.length && ["Port", d.ports.map((p) => `<a href="http://localhost:${p}" target="_blank" rel="noopener"><code>${p}</code></a>`).join(" ")],
      d.data_dir && ["Folder data", `<code>${esc(d.data_dir)}</code>`],
      s.log_path && ["Log", `<code>${esc(s.log_path)}</code>`],
      ["Perintah", `<code>${esc(s.command || "-")}</code>`],
      ["File service (plist)", `<code>${esc(s.file || "-")}</code>`],
    ].filter(Boolean);
    view.innerHTML = `
      <p style="margin:0 0 12px"><a href="#packages">← Paket &amp; Service</a></p>
      <div class="card item" style="margin-bottom:14px">
        <div class="row" style="flex-wrap:nowrap;gap:12px">${pkgIcon(name, "formula")}
          <div><div class="name"><span class="dot ${svcDot(s)}"></span>${esc(name)} <span class="badge">${esc(s.status)}</span></div>
          <div class="meta"><span>${esc(f.desc || "")}</span>${f.homepage ? `<a href="${esc(f.homepage)}" target="_blank" rel="noopener">${esc(f.homepage)}</a>` : ""}</div></div></div>
        <div class="actions">${svcActions(s, false)}
          ${btn("Uninstall", "svcUninstall", { name, confirm: `Stop & uninstall ${name}?${d.data_dir ? `\n\nFolder data ${d.data_dir} TIDAK ikut dihapus.` : ""}` }, "danger")}</div>
      </div>
      ${cf ? cfPanel(cf) : ""}
      <div class="grid two">
        <div class="card"><h3>Info</h3><dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl></div>
        <div class="card"><h3>Catatan dari Homebrew</h3>
          ${f.caveats ? `<pre style="padding:0;max-height:240px">${esc(f.caveats)}</pre>` : `<div class="muted small">Tidak ada catatan.</div>`}</div>
      </div>
      <h2 class="row">Konfigurasi <span class="spacer"></span><span class="muted small">backup otomatis di <code>${esc(d.backup_dir)}</code></span></h2>
      ${d.config_files.length ? `
        <div class="row" style="margin-bottom:10px">
          <div class="pills">${d.config_files.map((p) => btn(esc(p.split("/").slice(-2).join("/")), "cfgFile", { path: p }, p === this.file ? "active" : "", `title="${esc(p)}"`)).join("")}</div>
          <span class="spacer"></span>
          ${d.can_validate ? btn("Validasi", "cfgValidate") : ""}
          ${btn("Simpan", "cfgSave")}
          ${btn("Simpan & restart", "cfgSave", { restart: 1 }, "primary")}
        </div>
        <textarea class="editor" id="cfgEd" spellcheck="false" style="min-height:48vh"></textarea>
        <pre class="card" id="cfgOut" style="display:none;margin-top:10px"></pre>`
      : `<div class="empty">Service ini tidak punya file konfigurasi yang dikenali.</div>`}`;
    if (this.file) await this.loadFile();
  },
  async loadFile() {
    const r = await api(`/api/services/config?name=${encodeURIComponent(this.param)}&path=${encodeURIComponent(this.file)}`);
    const ed = $("cfgEd");
    ed.value = r.content;
    ed.onkeydown = (e) => {
      if (e.key === "Tab") { e.preventDefault(); ed.setRangeText("  ", ed.selectionStart, ed.selectionEnd, "end"); }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); handlers.cfgSave({}); }
    };
  },
};

function showCfgOut(text, ok = true) {
  const o = $("cfgOut");
  o.style.display = "block";
  o.style.color = ok ? "" : "var(--red)";
  o.textContent = text;
}
handlers.cfgFile = async (d, el) => {
  tabs.service.file = d.path;
  el.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === el));
  await tabs.service.loadFile();
};
handlers.cfgValidate = async () => {
  const r = await api("/api/services/validate", { name: tabs.service.param, path: tabs.service.file });
  showCfgOut((r.ok ? "✅ " : "❌ ") + r.output, r.ok);
};
handlers.cfgSave = async (d) => {
  const body = { name: tabs.service.param, path: tabs.service.file, content: $("cfgEd").value, restart: !!d.restart };
  let r;
  try {
    r = await api("/api/services/config", body);
  } catch (e) {
    showCfgOut(e.message, false);
    if (!e.message.includes("TIDAK valid") || !confirm(e.message + "\n\nTetap simpan walau tidak valid?")) return;
    r = await api("/api/services/config", { ...body, force: true });
  }
  showCfgOut(`✅ Disimpan. Backup: ${r.backup}\n${r.validation}${r.restart ? `\n\nRestart: ${r.restart}` : ""}`);
  toast(d.restart ? "Disimpan & service di-restart" : "Konfigurasi disimpan");
};

// ------------------------------------------------------------ cloudflared
function cfPanel(c) {
  if (c.error && !c.tunnels) return `<div class="warn">cloudflared: ${esc(c.error)}</div>`;
  const tunnels = (c.tunnels || []).map((t) => {
    const proc = c.processes.find((p) => p.pid === t.managed_pid) || c.processes.find((p) => p.command.includes(` ${t.name}`) || p.command.includes(t.id));
    return `<tr>
      <td><b>${esc(t.name)}</b> ${t.in_config ? `<span class="badge blue" title="Dipakai config.yml">config.yml</span>` : ""}
        <div class="muted small"><code>${esc(t.id)}</code></div></td>
      <td class="small">${t.has_credentials ? `<span class="badge green">kredensial ada</span>` : `<span class="badge amber" title="File ${esc(t.id)}.json tidak ada di ~/.cloudflared, tunnel ini tidak bisa dijalankan dari Mac ini">tanpa kredensial</span>`}</td>
      <td class="small">${proc ? `<span class="row" style="gap:6px"><span class="dot on"></span>jalan · PID ${proc.pid}</span>` : `<span class="muted">mati</span>`}
        <div class="muted small">${t.connections} koneksi edge</div></td>
      <td><div class="actions">
        ${proc ? btn("Stop", "cf", { action: "stop", name: t.name, pid: proc.pid }, "danger")
               : t.has_credentials ? btn("Jalankan", "cf", { action: "run", name: t.name }, "go") : ""}
        ${btn("Log", "cf", { action: "logs", name: t.name })}
        ${btn("Route DNS…", "cfRoute", { name: t.name })}
        ${btn("Hapus", "cf", { action: "delete", name: t.name, job: 1, confirm: `Hapus tunnel ${t.name} dari akun Cloudflare?` }, "danger")}
      </div></td></tr>`;
  }).join("");
  const cfgTunnel = (c.tunnels || []).find((t) => t.in_config)?.name || c.config_tunnel;
  const ingress = c.ingress.map((r) => `<tr><td>${r.hostname ? `<a href="https://${esc(r.hostname)}" target="_blank" rel="noopener">${esc(r.hostname)}</a>` : `<span class="muted">(lainnya)</span>`}</td>
      <td><code>${esc(r.service)}</code></td>
      <td><div class="actions">${r.hostname && cfgTunnel ? btn("Route DNS", "cf", { action: "route", name: cfgTunnel, hostname: r.hostname, job: 1 }) : ""}</div></td></tr>`).join("");
  return `
    <div class="card" style="margin-bottom:14px">
      <h3>☁️ Cloudflare Tunnel <span class="muted small">${esc(c.version || "")}</span><span class="spacer"></span>
        ${c.logged_in ? `<span class="badge green">sudah login</span>
          ${btn("Login ulang", "cf", { action: "login", relogin: 1, job: 1, confirm: "Login ulang? cert.pem lama akan di-backup, lalu browser terbuka untuk memilih akun/zone." })}`
        : btn("Login ke Cloudflare", "cf", { action: "login", job: 1 }, "primary")}</h3>
      ${c.logged_in ? "" : `<div class="warn">Belum login. Klik <b>Login ke Cloudflare</b>: browser akan terbuka untuk memilih domain, lalu <code>cert.pem</code> tersimpan di <code>~/.cloudflared</code>.</div>`}
      ${c.error ? `<div class="warn">${esc(c.error)}</div>` : ""}
      <h3 style="margin-top:6px">Tunnel</h3>
      ${tunnels ? `<div class="table-wrap"><table><tr><th>Nama</th><th>Kredensial</th><th>Status</th><th></th></tr>${tunnels}</table></div>` : `<div class="muted small">Belum ada tunnel.</div>`}
      <form class="row" id="cfCreate" style="margin-top:10px"><input type="text" name="name" placeholder="nama tunnel baru" style="max-width:240px"><button class="go">Buat tunnel</button>
        <span class="muted small">Tunnel yang dijalankan dari sini berjalan di background (bukan service launchd), jadi cocok untuk pemakaian manual.</span></form>
      <h3 style="margin-top:18px">Ingress <span class="muted small">${c.config_file ? `<code>${esc(c.config_file)}</code>` : "config.yml belum ada"}</span></h3>
      ${ingress ? `<div class="table-wrap"><table><tr><th>Hostname</th><th>Diteruskan ke</th><th></th></tr>${ingress}</table></div>` : ""}
      ${c.config_file ? `<form class="row" id="cfIngress" data-tunnel="${esc(cfgTunnel || "")}" style="margin-top:10px">
        <input type="text" name="hostname" placeholder="app.domainmu.com" style="flex:1;min-width:180px">
        <input type="text" name="service" placeholder="http://localhost:8000" style="flex:1;min-width:180px">
        <label class="chk"><input type="checkbox" name="route" checked> sekalian Route DNS</label>
        <button class="go">Tambah aturan</button></form>
        <p class="muted small">Aturan disisipkan sebelum aturan catch-all, divalidasi, dan dibatalkan otomatis kalau tidak valid. Restart tunnel agar aturan baru dipakai.</p>` : ""}
    </div>`;
}

const cfReload = () => tabs.service.load();
handlers.cf = async (d) => {
  const body = { action: d.action, name: d.name, pid: d.pid, hostname: d.hostname, relogin: !!d.relogin };
  if (d.job) return runJob(api("/api/cloudflared", body), cfReload);
  const r = await api("/api/cloudflared", body);
  if (d.action === "logs") return showLog(`cloudflared — ${d.name}`, r.log);
  toast(d.action === "run" ? `Tunnel ${d.name} dijalankan (PID ${r.pid})` : d.action === "stop" ? "Tunnel dihentikan" : "OK");
  setTimeout(cfReload, d.action === "run" ? 1500 : 300);
};
handlers.cfRoute = (d) => {
  const host = prompt(`Hostname yang diarahkan ke tunnel "${d.name}":`, "app.domainmu.com");
  if (host) return runJob(api("/api/cloudflared", { action: "route", name: d.name, hostname: host.trim() }), cfReload);
};
document.addEventListener("submit", async (e) => {
  if (e.target.id === "cfCreate") {
    e.preventDefault();
    const name = new FormData(e.target).get("name").trim();
    if (name) runJob(api("/api/cloudflared", { action: "create", name }), cfReload);
  }
  if (e.target.id === "cfIngress") {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      await api("/api/cloudflared", { action: "add-ingress", hostname: f.hostname.trim(), service: f.service.trim() });
      toast(`Aturan ${f.hostname} ditambahkan`);
      const tunnel = e.target.dataset.tunnel;
      if (f.route && tunnel) return runJob(api("/api/cloudflared", { action: "route", name: tunnel, hostname: f.hostname.trim() }), cfReload);
      cfReload();
    } catch (err) { toast(err.message, true); }
  }
});

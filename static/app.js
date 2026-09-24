// Service Admin — frontend. Semua tombol memakai data-act="..." (event delegation).
const $ = (id) => document.getElementById(id);
const view = $("view");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const attrs = (o) => Object.entries(o).map(([k, v]) => `data-${k}="${esc(v)}"`).join(" ");
const btn = (label, act, data = {}, cls = "", extra = "") =>
  `<button class="${cls}" data-act="${act}" ${attrs(data)} ${extra}>${label}</button>`;

async function api(path, body) {
  const opt = body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "service-admin" },
    body: JSON.stringify(body),
  };
  const r = await fetch(path, opt);
  const d = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

function toast(msg, bad = false) {
  const t = $("toast");
  t.textContent = msg; t.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(t._h); t._h = setTimeout(() => (t.className = "toast"), 4000);
}

function showLog(title, text) {
  $("logTitle").textContent = title;
  $("logBody").textContent = text;
  $("logDlg").showModal();
  $("logBody").scrollTop = $("logBody").scrollHeight;
}

// ------------------------------------------------------------ panel terminal & proses
// Panel kanan (ikon terminal di header / Ctrl+`) punya 2 tab:
//  - Terminal: shell zsh sungguhan (PTY + xterm.js, lihat terminal.js) — claude, vim, htop jalan normal.
//  - Proses: job background (brew install, laravel new, docker ...). Titik merah = ada yang berjalan.
const jobs = {};          // id -> { id, label, done, code, text, offset }
let jobShown = null;      // job yang ditampilkan di tab Proses

function panelView(v) {
  $("viewTerm").hidden = v !== "term";
  $("viewJobs").hidden = v !== "jobs";
  document.querySelectorAll("#panelTabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  if (v === "term") terminalShown?.();
}
function panelOpen(view) {
  $("job").classList.add("show");
  panelView(view || ($("viewJobs").hidden ? "term" : "jobs"));
}
const panelClose = () => $("job").classList.remove("show");
$("panelTabs").onclick = (e) => { const b = e.target.closest("[data-view]"); if (b) panelView(b.dataset.view); };
$("jobBtn").onclick = () => {
  if ($("job").classList.contains("show")) return panelClose();
  panelOpen(Object.values(jobs).some((j) => !j.done) ? "jobs" : "term");
};
$("jobClose").onclick = panelClose;
// Ctrl+` membuka/menutup panel (fase capture supaya tetap jalan saat fokus di xterm)
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "`") { e.preventDefault(); e.stopPropagation(); $("jobBtn").click(); }
}, true);

function jobIcon(j) { return j.done ? (j.code === 0 ? "✅" : "❌") : "⏳"; }
function renderJobs() {
  const list = Object.values(jobs).sort((a, b) => b.id - a.id);
  const running = list.some((j) => !j.done);
  $("jobDot").hidden = !running;
  $("jobDot2").hidden = !running;
  $("jobBtn").title = running ? "Ada proses berjalan — klik untuk melihat" : "Terminal & proses (Ctrl+`)";
  $("jobList").innerHTML = list.map((j) => `<button class="job-item ${j.id === jobShown ? "active" : ""}" data-job="${j.id}">
    ${jobIcon(j)} ${esc(j.label)}</button>`).join("") || `<div class="muted small" style="padding:10px 16px">Belum ada proses di sesi ini.</div>`;
  const j = jobs[jobShown];
  $("jobTitle").textContent = j ? `${jobIcon(j)} ${j.label}${j.done ? (j.code === 0 ? " — selesai" : ` — gagal (exit ${j.code})`) : " — berjalan…"}` : "Pilih proses di atas.";
  const out = $("jobOut");
  if (j && out.dataset.job !== String(j.id)) { out.dataset.job = j.id; out.textContent = j.text; out.scrollTop = out.scrollHeight; }
  if (!j) { out.dataset.job = ""; out.textContent = "Proses background (install, upgrade, compose, dll.) muncul di sini."; }
  $("jobStop").hidden = !j || j.done;
}
function openJobs(id) {
  if (id) jobShown = id;
  panelOpen("jobs");
  renderJobs();
}
$("jobList").onclick = (e) => { const b = e.target.closest("[data-job]"); if (b) { jobShown = +b.dataset.job; $("jobOut").dataset.job = ""; renderJobs(); } };
$("jobStop").onclick = async () => {
  if (jobShown) try { await api("/api/job/cancel", { id: jobShown }); } catch (err) { toast(err.message, true); }
};

async function followJob(id, onDone) {
  const j = jobs[id];
  for (;;) {
    let d;
    try { d = await api(`/api/job?id=${id}&offset=${j.offset}`); } catch (e) { toast(e.message, true); break; }
    j.label = d.label;
    if (d.lines.length) {
      j.text += d.lines.join("\n") + "\n";
      if (jobShown === id) { const out = $("jobOut"); const end = out.scrollTop + out.clientHeight >= out.scrollHeight - 30;
        out.textContent = j.text; if (end) out.scrollTop = out.scrollHeight; }
    }
    j.offset = d.offset;
    if (d.done) {
      Object.assign(j, { done: true, code: d.code });
      renderJobs();
      toast(d.code === 0 ? `✅ ${d.label} selesai` : `❌ ${d.label} gagal (exit ${d.code}) — buka ikon terminal → Proses`, d.code !== 0);
      break;
    }
    renderJobs();
    await new Promise((r) => setTimeout(r, 800));
  }
  onDone?.();
}

async function runJob(promise, onDone) {
  let id;
  try { id = +(await promise).job; } catch (e) { return toast(e.message, true); }
  jobs[id] = { id, label: "…", done: false, code: null, text: "", offset: 0 };
  jobShown = id;
  $("jobOut").dataset.job = "";
  renderJobs();
  toast("⏳ Proses dimulai — lihat progres di ikon terminal (kanan atas) → Proses");
  return followJob(id, onDone);
}

// setelah refresh halaman: ambil proses yang masih berjalan di server
api("/api/jobs").then(({ jobs: list }) => {
  for (const j of list.reverse()) {
    jobs[+j.id] = { id: +j.id, label: j.label, done: j.done, code: j.code, text: "", offset: 0 };
    followJob(+j.id);
  }
  if (list.length) jobShown = +list[list.length - 1].id;
  renderJobs();
}).catch(() => {});

// ------------------------------------------------------------ router
const tabs = {};
let current, refreshTimer;

let lastHash = location.hash;
async function route() {
  const leavingEditor = current === tabs.config && !location.hash.startsWith("#config");
  if (leavingEditor && location.hash !== lastHash && !tabs.config.leaveOk()) {
    history.replaceState(null, "", lastHash);
    return;
  }
  lastHash = location.hash;
  // pindah file di dalam halaman Konfigurasi: cukup buka file lain, tanpa render ulang halaman
  if (current === tabs.config && location.hash.startsWith("#config:") && $("cfgMain")) {
    const id = decodeURIComponent(location.hash.slice(8));
    if (tabs.config.leaveOk()) { tabs.config.dirty = false; tabs.config.open(id); }
    return;
  }
  if (leavingEditor) tabs.config.dirty = false;
  // hash: "#key" atau "#key:param" (mis. #service:mysql@9.7); alias lama tetap jalan
  const [rawKey, ...rest] = location.hash.slice(1).split(":");
  const key = ({ services: "packages", apps: "packages", zsh: "config" })[rawKey] || rawKey;
  const tab = tabs[key] || tabs.dashboard;
  tab.param = decodeURIComponent(rest.join(":"));
  const name = tab.nav || (tabs[key] ? key : "dashboard");
  current?.leave?.();
  current = tab;
  document.querySelectorAll("#tabs a").forEach((a) => {
    a.classList.toggle("active", a.hash === "#" + name);
    if (a.hash === "#" + name) {
      const logo = a.querySelector(".logo-i");
      const label = a.querySelector(".nav-name")?.textContent || a.firstChild.nextSibling?.textContent?.trim() || "";
      $("pageTitle").innerHTML = (logo ? logo.outerHTML.replace('class="logo-i', 'class="logo-i title-logo') : "") + esc(label);
    }
  });
  if (tab.title) $("pageTitle").innerHTML = (tab.logo ? logoSvg(tab.logo, "title-logo") : "") + esc(tab.title);
  $("headline").textContent = "";
  document.body.classList.remove("nav-open");
  clearInterval(refreshTimer);
  view.innerHTML = `<div class="loading">Memuat…</div>`;
  await tab.load();
  if (tab.interval) refreshTimer = setInterval(() => current === tab && !document.hidden && tab.load(true), tab.interval);
}
window.addEventListener("hashchange", route);

const handlers = {};
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || !handlers[el.dataset.act]) return;
  e.preventDefault();
  if (el.dataset.confirm && !confirm(el.dataset.confirm)) return;
  el.disabled = true;
  try { await handlers[el.dataset.act](el.dataset, el); }
  catch (err) { toast(err.message, true); }
  finally { el.disabled = false; }
});

const failView = (e) => (view.innerHTML = `<div class="err">Gagal memuat:\n${esc(e.message)}</div>`);

// ------------------------------------------------------------ PHP
tabs.php = {
  async load() {
    let d;
    try { d = await api("/api/php"); } catch (e) { return failView(e); }
    $("headline").textContent = `PHP aktif: ${d.shell.version || "-"}`;
    const sel = d.selected;
    const warn = sel && !d.shim_active
      ? `<div class="warn">⚠️ Pilihan kamu belum dipakai terminal. Terminal baru masih memakai <code>${esc(d.shell.path)}</code>.
         Kemungkinan ada baris PATH di bawah blok Service Admin di <code>~/.zshrc</code>. Pilih ulang versinya untuk memindahkan blok ke paling bawah.</div>` : "";
    const rows = d.versions.map((v) => `<div class="card item">
        <div>
          <div class="name">PHP ${esc(v.version)} <span class="badge ${v.source === "Herd" ? "blue" : ""}">${v.source}</span>
            ${sel === v.id ? `<span class="badge green">default</span>` : ""}</div>
          <div class="meta"><code>${esc(v.bin)}</code></div>
        </div>
        <div class="actions">${sel === v.id ? "" : btn("Jadikan default", "phpSel", { id: v.id }, "primary")}</div>
      </div>`).join("");
    const herd = d.herd.length ? `
      <h2>Versi PHP di Herd</h2>
      <div class="table-wrap"><table><tr><th>Versi</th><th>Status</th><th></th></tr>
      ${d.herd.map((h) => `<tr><td><b>${esc(h.version)}</b> ${h.global ? `<span class="badge blue">global Herd</span>` : ""}</td>
        <td>${h.installed ? `<span class="badge green">terinstall</span>` : `<span class="muted small">belum terinstall</span>`}
            ${h.update ? `<span class="badge amber">update tersedia</span>` : ""}</td>
        <td><div class="actions">
          ${!h.installed ? btn("Install", "herd", { action: "install", version: h.version }, "go") : ""}
          ${h.update ? btn("Update", "herd", { action: "update", version: h.version }) : ""}
        </div></td></tr>`).join("")}
      </table></div>` : "";
    view.innerHTML = `
      <p style="margin:0 0 12px"><a href="#langs">← Bahasa pemrograman</a></p>
      <div class="stat">
        <div class="card"><div>Terminal baru memakai</div><div>PHP ${esc(d.shell.version || "tidak ditemukan")}</div>
          <div class="muted small"><code>${esc(d.shell.path || "-")}</code></div></div>
        <div class="card"><div>Default dari Service Admin</div><div>${esc(sel ? d.versions.find((v) => v.id === sel)?.version ?? sel : "Tidak diatur")}</div>
          <div class="muted small">${sel ? "via ~/.service-admin/bin" : "mengikuti urutan PATH di .zshrc"}</div></div>
      </div>
      ${warn}
      <h2 class="row">Pilih PHP default <span class="spacer"></span>
        ${sel ? btn("Hapus override", "phpSel", { id: "default" }, "", `title="Kembali ke PHP menurut PATH .zshrc"`) : ""}</h2>
      <div class="list">${rows}</div>
      <p class="muted small">Memilih PHP dari <b>Herd</b> juga menjalankan <code>herd use</code>, jadi situs Herd ikut pindah versi.
        Memilih PHP <b>Homebrew</b> hanya mengubah CLI. Terminal yang sudah terbuka langsung ikut, tanpa <code>source</code>.
        Untuk install PHP Homebrew versi lain, cari <code>php@</code> di <a href="#packages">Paket &amp; Service</a>.</p>
      ${herd}`;
  },
};
handlers.phpSel = async (d) => {
  await api("/api/php/select", { id: d.id });
  toast(d.id === "default" ? "Override PHP dihapus" : "PHP default diganti");
  await tabs.php.load();
  refreshNav();
};
handlers.herd = (d) => runJob(api("/api/php/herd", { action: d.action, version: d.version }), () => tabs.php.load());

// ------------------------------------------------------------ Node.js
tabs.node = {
  async load() {
    let d;
    try { d = await api("/api/node"); } catch (e) { return failView(e); }
    $("headline").textContent = `Node aktif: ${d.shell.version || "-"}`;
    if (!d.nvm) {
      view.innerHTML = `<div class="warn">nvm tidak ditemukan. Install lewat <a href="#packages">Paket &amp; Service</a> (cari <code>nvm</code>).</div>`;
      return;
    }
    const broken = d.default_resolved === "N/A";
    const isDefault = (v) => d.default_alias === v || d.default_resolved === v;
    const row = (v, label, extra = "", removable = true) => `<div class="card item">
        <div><div class="name">${label} ${isDefault(v) ? `<span class="badge green">default</span>` : ""}
          ${d.shell.version === (v === "system" ? d.system : v) ? `<span class="badge blue">dipakai terminal</span>` : ""}</div>
          <div class="meta">${extra}</div></div>
        <div class="actions">
          ${isDefault(v) ? "" : btn("Jadikan default", "nodeDefault", { version: v }, "primary")}
          ${removable && !isDefault(v) ? btn("Uninstall", "nodeJob", { action: "uninstall", version: v, confirm: `Uninstall Node ${v}?` }, "danger") : ""}
        </div></div>`;
    view.innerHTML = `
      <p style="margin:0 0 12px"><a href="#langs">← Bahasa pemrograman</a></p>
      <div class="stat">
        <div class="card"><div>Terminal baru memakai</div><div>Node ${esc(d.shell.version || "tidak ditemukan")}</div>
          <div class="muted small"><code>${esc(d.shell.path || "-")}</code></div></div>
        <div class="card"><div>Default nvm</div><div>${esc(d.default_alias || "-")}</div>
          <div class="muted small">→ ${esc(d.default_resolved || "-")}</div></div>
      </div>
      ${broken ? `<div class="warn">⚠️ Alias default nvm <code>${esc(d.default_alias)}</code> menunjuk ke versi yang belum terinstall,
        jadi nvm diam-diam memakai Node dari Homebrew (${esc(d.system || "-")}). Pilih salah satu versi di bawah sebagai default,
        atau install LTS terbaru.</div>` : ""}
      <h2>Versi terinstall (nvm)</h2>
      <div class="list">
        ${d.installed.map((v) => row(v, `Node ${esc(v)}`, `<code>~/.nvm/versions/node/${esc(v)}</code>`)).join("")}
        ${d.system ? row("system", `Node ${esc(d.system)} <span class="badge">Homebrew</span>`, `<code>/opt/homebrew/bin/node</code>`, false) : ""}
      </div>
      <h2>Install versi baru</h2>
      <form class="row" id="nodeInstall">
        <input type="text" id="nodeVer" placeholder="mis. 22, 24.1.0, lts/*" style="width:200px">
        <button class="go">Install</button>
        <span class="spacer"></span>${btn("Tampilkan versi LTS", "nodeRemote")}
      </form>
      <div class="list" id="nodeRemote" style="margin-top:10px"></div>
      <p class="muted small">Default berlaku untuk terminal <b>baru</b>. Di terminal yang sudah terbuka, jalankan <code>nvm use default</code>.</p>`;
    $("nodeInstall").onsubmit = (e) => {
      e.preventDefault();
      const v = $("nodeVer").value.trim();
      if (v) handlers.nodeJob({ action: "install", version: v });
    };
  },
};
handlers.nodeDefault = async (d) => {
  await api("/api/node/action", { action: "default", version: d.version });
  toast(`Default Node → ${d.version}`);
  await tabs.node.load();
  refreshNav();
};
handlers.nodeJob = (d) => runJob(api("/api/node/action", { action: d.action, version: d.version }), () => tabs.node.load());
handlers.nodeRemote = async () => {
  $("nodeRemote").innerHTML = `<div class="loading">Mengambil daftar dari nodejs.org…</div>`;
  const { lts } = await api("/api/node/remote");
  $("nodeRemote").innerHTML = lts.slice(0, 6).map((r) => `<div class="card item">
      <div class="name">${esc(r.version)} <span class="badge">${esc(r.codename)}</span></div>
      <div class="actions">${btn("Install", "nodeJob", { action: "install", version: r.version }, "go")}</div>
    </div>`).join("");
};

// ------------------------------------------------------------ Herd
tabs.herd = {
  async load() {
    let d;
    try { d = await api("/api/herd"); } catch (e) { return failView(e); }
    if (!d.installed) { view.innerHTML = `<div class="warn">Laravel Herd tidak terinstall. Install lewat <a href="#packages">Paket &amp; Service</a> (cari <code>herd</code>).</div>`; return; }
    const p = d.processes, running = p.nginx && p.fpm.length;
    $("headline").textContent = `Herd ${d.version} · ${d.sites.length} situs`;
    const phpOpts = (site) => [`<option value="global" ${site.isolated ? "" : "selected"}>Global (${esc(d.global_php)})</option>`]
      .concat(d.php_installed.map((v) => `<option value="${esc(v)}" ${site.isolated && site.php === v ? "selected" : ""}>PHP ${esc(v)}</option>`)).join("");
    const proc = (on, label) => `<span class="row"><span class="dot ${on ? "on" : ""}"></span>${label}</span>`;
    const sites = d.sites.map((s) => `<tr>
        <td><b>${esc(s.name)}</b> ${s.linked ? `<span class="badge">link</span>` : `<span class="badge">parked</span>`}
          ${s.has_db ? `<span class="badge" title="Kredensial database ditemukan di .env">db</span>` : ""}
          <div class="muted small"><code>${esc(s.path)}</code></div></td>
        <td><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url.replace(/^https?:\/\//, ""))}</a>
          ${s.secured ? `<span class="badge green" title="HTTPS aktif">🔒 HTTPS</span>` : `<span class="badge">HTTP</span>`}</td>
        <td><select data-herd-php="${esc(s.name)}">${phpOpts(s)}</select></td>
        <td class="small muted">${esc(s.node || "-")}</td>
        <td><div class="actions">
          ${s.secured ? btn("Nonaktifkan HTTPS", "herdSite", { action: "unsecure", name: s.name })
                      : btn("Aktifkan HTTPS", "herdSite", { action: "secure", name: s.name }, "go")}
          ${btn("Folder", "herdQuick", { action: "folder", name: s.name })}
          ${s.linked ? btn("Unlink", "herdSite", { action: "unlink", name: s.name, confirm: `Unlink ${s.name}? Folder project TIDAK dihapus.` }, "danger") : ""}
        </div></td></tr>`).join("");
    const proxies = d.proxies.map((x) => `<tr><td><b>${esc(x.Site)}</b></td>
        <td><a href="${esc(x.URL)}" target="_blank" rel="noopener">${esc(x.URL)}</a></td><td><code>${esc(x.Host)}</code></td>
        <td><div class="actions">${btn("Hapus", "herdSite", { action: "unproxy", name: x.Site, confirm: `Hapus proxy ${x.Site}?` }, "danger")}</div></td></tr>`).join("");
    const paths = d.paths.map((pa) => `<div class="card item"><div><code>${esc(pa)}</code>
        <div class="muted small">Setiap subfolder otomatis jadi situs <code>nama-folder.${esc(d.tld)}</code></div></div>
        <div class="actions">${pa.includes("/config/valet/Sites") ? "" : btn("Forget", "herdSite", { action: "forget", path: pa, confirm: `Berhenti park ${pa}?` }, "danger")}</div></div>`).join("");
    view.innerHTML = `
      <div class="card item" style="margin-bottom:14px">
        <div><div class="name"><span class="dot ${running ? "on" : "bad"}"></span>Laravel Herd ${esc(d.version)}
            <span class="badge">${running ? "berjalan" : "mati"}</span></div>
          <div class="meta">${proc(p.app, "Aplikasi Herd")}${proc(p.nginx, "Nginx")}${proc(p.dnsmasq, "DNS (dnsmasq)")}
            ${proc(p.fpm.length, `PHP-FPM ${p.fpm.join(", ") || ""}`)}<span>TLD <code>.${esc(d.tld)}</code></span>
            <span>PHP global <b>${esc(d.global_php)}</b> · <a href="#php">ganti</a></span></div></div>
        <div class="actions">
          ${running ? btn("Restart", "herdSite", { action: "restart" }) + btn("Stop", "herdSite", { action: "stop", confirm: "Stop Herd? Semua situs .test akan mati." }, "danger")
                    : btn("Start", "herdSite", { action: "start" }, "go")}
          ${btn("＋ Aplikasi Laravel baru", "newApp", {}, "primary")}
          ${btn("Buka app Herd", "herdQuick", { action: "open-app" })}
          ${btn("Log Nginx", "herdLog", { file: "nginx-error.log" })}${btn("Log PHP-FPM", "herdLog", { file: "php-fpm.log" })}
        </div>
      </div>
      <h2>Situs</h2>
      ${sites ? `<div class="table-wrap"><table><tr><th>Situs</th><th>URL</th><th>PHP</th><th>Node</th><th></th></tr>${sites}</table></div>` : `<div class="empty">Belum ada situs.</div>`}
      <div class="grid two" style="margin-top:14px">
        <form class="card" id="herdLink">
          <h3>Tambah situs (link folder)</h3>
          <div class="list">
            <div class="row"><input type="text" name="path" id="herdPath" placeholder="Klik “Pilih folder…”" required style="flex:1">
              ${btn("📁 Pilih folder…", "herdPick", {}, "primary")}</div>
            <div class="row"><input type="text" name="name" id="herdName" placeholder="nama situs" style="flex:1">
              <span class="muted small">.${esc(d.tld)}</span>
              <select name="php" id="herdPhp"><option value="">PHP global (${esc(d.global_php)})</option>${d.php_installed.map((v) => `<option value="${esc(v)}">PHP ${esc(v)}</option>`).join("")}</select></div>
            <div class="muted small" id="herdPickInfo"></div>
            <div class="row"><label class="chk"><input type="checkbox" name="secure" checked> HTTPS</label><span class="spacer"></span><button class="go">Link</button></div>
          </div>
        </form>
        <form class="card" id="herdProxy">
          <h3>Proxy ke port lokal <span class="muted small">(Node, Vite, Docker, Reverb…)</span></h3>
          <div class="list">
            <div class="row"><input type="text" name="name" placeholder="nama, mis. myapp" required style="flex:1">
              <span class="muted small">.${esc(d.tld)}</span></div>
            <input type="text" name="host" placeholder="http://localhost:3000" required>
            <div class="row"><label class="chk"><input type="checkbox" name="secure" checked> HTTPS</label><span class="spacer"></span><button class="go">Buat proxy</button></div>
          </div>
        </form>
      </div>
      <h2 class="row">Project terdeteksi <span class="muted small">belum di-link ke Herd</span></h2>
      <div id="herdSuggest"><div class="loading">Memindai folder project…</div></div>
      <h2>Proxy</h2>
      ${proxies ? `<div class="table-wrap"><table><tr><th>Nama</th><th>URL</th><th>Target</th><th></th></tr>${proxies}</table></div>` : `<div class="empty">Belum ada proxy.</div>`}
      <h2 class="row">Parked folder <span class="spacer"></span></h2>
      <div class="list">${paths}</div>
      <form class="row" id="herdPark" style="margin-top:10px">
        <input type="text" name="path" placeholder="/Users/fanny/Documents/Codes" style="flex:1;min-width:240px"><button>Park folder</button>
      </form>
      <p class="muted small">Fitur <b>Services</b> Herd (MySQL, Redis, dll. di dalam Herd) butuh Herd Pro. Service database-mu dikelola lewat tab Services (Homebrew).</p>`;
    view.querySelectorAll("[data-herd-php]").forEach((sel) => (sel.onchange = () =>
      runJob(api("/api/herd/action", { action: "php", name: sel.dataset.herdPhp, php: sel.value }), () => tabs.herd.load())));
    const form = (id, action) => ($(id).onsubmit = (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      runJob(api("/api/herd/action", { action, ...f, secure: !!f.secure }), () => tabs.herd.load());
    });
    form("herdLink", "link"); form("herdProxy", "proxy"); form("herdPark", "park");
    this.herd = d;
    this.suggest();
  },
  // versi PHP Herd yang cocok dengan "require.php" di composer.json (mis. ^8.2)
  phpFor(constraint) {
    const m = /(\d+)\.(\d+)/.exec(constraint || "");
    if (!m) return "";
    const ok = (v) => { const [a, b] = v.split(".").map(Number); return a === +m[1] && b >= +m[2]; };
    if (ok(this.herd.global_php)) return "";  // global sudah cocok
    return this.herd.php_installed.filter(ok).sort()[0] || "";
  },
  fillForm(p) {
    $("herdPath").value = p.path;
    $("herdName").value = p.name;
    $("herdPhp").value = this.phpFor(p.php);
    $("herdPickInfo").innerHTML = [p.type && `Terdeteksi: <b>${esc(p.type)}</b>`, p.php && `butuh PHP <code>${esc(p.php)}</code>`]
      .filter(Boolean).join(" · ");
  },
  async suggest() {
    let r;
    try { r = await api("/api/herd/suggest"); } catch (e) { $("herdSuggest").innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    this.projects = r.projects;
    $("herdSuggest").innerHTML = r.projects.length ? `<div class="list">${r.projects.map((p, i) => {
      const php = this.phpFor(p.php);
      return `<div class="card item">
        <div><div class="name">${esc(p.name)}<span class="muted small">.${esc(this.herd.tld)}</span>
            <span class="badge blue">${esc(p.type)}</span>${p.php ? `<span class="badge">PHP ${esc(p.php)}</span>` : ""}</div>
          <div class="meta"><code>${esc(p.path)}</code></div></div>
        <div class="actions">${btn("Atur…", "herdFill", { i })}
          ${btn(`Link${php ? ` (PHP ${php})` : ""}`, "herdQuickLink", { i }, "go")}</div></div>`;
    }).join("")}</div>` : `<div class="empty">Semua project PHP di folder kode sudah dilayani Herd.</div>`;
  },
};
handlers.herdSite = (d) => runJob(api("/api/herd/action", { action: d.action, name: d.name || "", path: d.path || "" }), () => { tabs.herd.load(); refreshNav(); });
handlers.herdPick = async () => {
  const start = $("herdPath").value || tabs.herd.projects?.[0]?.path?.replace(/\/[^/]+$/, "") || "~/Documents";
  toast("Dialog Finder dibuka — pilih folder project…");
  const r = await api("/api/pick-folder", { prompt: "Pilih folder project untuk Herd", start });
  if (!r.cancelled) tabs.herd.fillForm(r);
};
handlers.herdFill = (d) => { tabs.herd.fillForm(tabs.herd.projects[d.i]); $("herdPath").scrollIntoView({ behavior: "smooth", block: "center" }); };
handlers.herdQuickLink = (d) => {
  const p = tabs.herd.projects[d.i];
  return runJob(api("/api/herd/action", { action: "link", path: p.path, name: p.name, php: tabs.herd.phpFor(p.php), secure: true }),
    () => { tabs.herd.load(); refreshNav(); });
};
// ---- form aplikasi Laravel baru
handlers.newApp = async () => {
  const o = await api("/api/herd/new-options");
  const f = $("newAppForm");
  const radios = (name, opts, val) => `<div class="choice">${opts.map(([v, l, hint]) => `<label class="choice-item">
      <input type="radio" name="${name}" value="${v}" ${v === val ? "checked" : ""}><span><b>${l}</b>${hint ? `<small>${hint}</small>` : ""}</span></label>`).join("")}</div>`;
  f.innerHTML = `
    <div class="field"><label>Nama project</label>
      <input name="name" required placeholder="toko-online" pattern="[a-z0-9][a-z0-9_\-]*" autocomplete="off">
      <small id="naPreview" class="muted"></small></div>
    <div class="field"><label>Lokasi</label>
      <div class="row"><input name="location" value="${esc(o.default_location)}" style="flex:1">${btn("📁 Pilih…", "newAppPick")}</div>
      <small class="muted">Folder di <code>~/Herd</code> otomatis dilayani Herd; lokasi lain akan di-link.</small></div>
    <div class="grid two">
      <div class="field"><label>Versi Laravel</label><select name="laravel">${o.laravel.map((l) =>
        `<option value="${l.major}" data-php="${l.php_min}">Laravel ${l.major}${l.latest ? " (terbaru)" : ""}</option>`).join("")}</select></div>
      <div class="field"><label>Versi PHP</label><select name="php"></select><small class="muted" id="naPhpHint"></small></div>
    </div>
    <div id="naKits">
      <div class="field"><label>Starter kit</label>${radios("starter", [["none", "Tanpa", "Laravel polos"], ["react", "React", "Inertia + TS"],
        ["vue", "Vue", "Inertia + TS"], ["svelte", "Svelte", "Inertia + TS"], ["livewire", "Livewire", "Blade + Flux"]], "none")}</div>
      <div class="field" id="naAuth" hidden><label>Autentikasi</label>${radios("auth", [["laravel", "Laravel", "login/register bawaan"],
        ["workos", "WorkOS", "SSO, passkeys"], ["none", "Tanpa auth", ""]], "laravel")}
        <div class="row" style="margin-top:6px"><label class="chk"><input type="checkbox" name="teams"> Dukungan teams</label>
          <label class="chk" id="naLwClass" hidden><input type="checkbox" name="livewire_class"> Livewire class components</label></div></div>
      <div class="grid two">
        <div class="field"><label>Testing</label>${radios("testing", [["pest", "Pest"], ["phpunit", "PHPUnit"]], "pest")}</div>
        <div class="field"><label>Frontend (npm install + build)</label><select name="js">
          <option value="npm">npm</option><option value="pnpm">pnpm</option><option value="bun">bun</option><option value="yarn">yarn</option><option value="none">Lewati</option></select></div>
      </div>
    </div>
    <p class="muted small" id="naOldNote" hidden>Versi lama dibuat lewat <code>composer create-project</code> (tanpa starter kit).</p>
    <div class="field"><label>Database</label>${radios("database", [["sqlite", "SQLite", "tanpa server"], ["mysql", "MySQL", o.mysql_running ? "service jalan ✓" : "service mati"],
        ["mariadb", "MariaDB", ""], ["pgsql", "PostgreSQL", o.postgres_running ? "service jalan ✓" : "service mati"]], "sqlite")}
      <div class="row" id="naDbOpts" hidden style="margin-top:6px"><label class="chk"><input type="checkbox" name="create_db" checked> Buat database otomatis</label>
        <label class="chk"><input type="checkbox" name="migrate" checked> Jalankan migrasi</label></div></div>
    <div class="field"><label>Lainnya</label><div class="row">
      <label class="chk"><input type="checkbox" name="secure" checked> HTTPS</label>
      <label class="chk"><input type="checkbox" name="git" checked> Git init</label>
      <label class="chk" id="naBoost"><input type="checkbox" name="boost"> Laravel Boost (AI)</label>
      <label class="chk"><input type="checkbox" name="open_browser" checked> Buka di browser</label></div></div>
    <div class="row"><label class="muted small">Buka di editor</label><select name="editor"><option value="">Tidak</option>
      ${o.editors.map((e) => `<option value="${e.id}" ${e.id === "vscode" ? "selected" : ""}>${esc(e.name)}</option>`).join("")}</select>
      <span class="spacer"></span><button class="go">Buat aplikasi</button></div>`;
  const q = (n) => f.elements[n];
  const sync = () => {
    const lv = q("laravel").selectedOptions[0], latest = lv.value === String(o.laravel[0].major), min = lv.dataset.php;
    const ok = (v) => v.localeCompare(min, undefined, { numeric: true }) >= 0;
    const prev = q("php").value;
    q("php").innerHTML = o.php_installed.map((v) => `<option value="${v}" ${ok(v) ? "" : "disabled"}>PHP ${v}${v === o.global_php ? " (global)" : ""}${ok(v) ? "" : " — terlalu lama"}</option>`).join("");
    const pick = [prev, o.global_php, ...o.php_installed].find((v) => v && ok(v) && o.php_installed.includes(v));
    if (pick) q("php").value = pick;
    $("naPhpHint").innerHTML = pick ? `Laravel ${lv.value} butuh PHP ≥ ${min}` : `<span style="color:var(--red)">Butuh PHP ≥ ${min}. Install lewat halaman PHP → Herd.</span>`;
    $("naKits").hidden = !latest; $("naOldNote").hidden = latest; $("naBoost").hidden = !latest;
    const kit = f.querySelector("[name=starter]:checked")?.value;
    $("naAuth").hidden = !latest || kit === "none";
    $("naLwClass").hidden = kit !== "livewire";
    $("naDbOpts").hidden = q("database").value === "sqlite";
    const name = q("name").value || "nama-project";
    $("naPreview").innerHTML = `→ <code>${esc(q("location").value.replace(/\/$/, ""))}/${esc(name)}</code> · ${q("secure").checked ? "https" : "http"}://${esc(name)}.${esc(o.tld)}`;
  };
  f.oninput = sync; f.onchange = sync;
  sync();
  f.onsubmit = (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(f));
    for (const k of ["teams", "livewire_class", "create_db", "migrate", "secure", "git", "boost", "open_browser"]) data[k] = !!data[k];
    $("newAppDlg").close();
    runJob(api("/api/herd/new", data), () => { if (current === tabs.herd) tabs.herd.load(); refreshNav(); });
  };
  $("newAppDlg").showModal();
  q("name").focus();
};
handlers.newAppPick = async () => {
  const f = $("newAppForm");
  const r = await api("/api/pick-folder", { prompt: "Pilih lokasi untuk project Laravel baru", start: f.elements.location.value });
  if (!r.cancelled) { f.elements.location.value = r.path; f.oninput(); }
};
handlers.herdQuick = async (d) => { await api("/api/herd/action", { action: d.action, name: d.name || "" }); };
handlers.herdLog = async (d) => { const r = await api(`/api/herd/logs?file=${d.file}`); showLog(`Herd — ${d.file}`, r.log || "(kosong)"); };

// ------------------------------------------------------------ tema
function applyTheme(mode) {
  if (mode === "light" || mode === "dark") document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  try { mode === "system" ? localStorage.removeItem("theme") : localStorage.setItem("theme", mode); } catch {}
  document.querySelectorAll("[data-theme-set]").forEach((b) => {
    b.classList.toggle("active", b.dataset.themeSet === mode);
    b.setAttribute("aria-checked", b.dataset.themeSet === mode);
  });
}
document.querySelectorAll("[data-theme-set]").forEach((b) => (b.onclick = () => applyTheme(b.dataset.themeSet)));
applyTheme(document.documentElement.dataset.theme || "system");

$("menuBtn").onclick = () => document.body.classList.toggle("nav-open");
$("scrim").onclick = () => document.body.classList.remove("nav-open");

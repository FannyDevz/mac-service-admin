// Pembersih ala CCleaner: #cleaner (cache, log, cache developer, Trash), #cleaner:large (file besar
// & isi Downloads), #cleaner:startup (LaunchAgents/Daemons + Login Items).

// kategori yang dicentang saat pertama kali; sisanya (Trash, Gradle, Xcode, …) harus dipilih sendiri
const CL_DEFAULT = ["caches", "logs", "browser", "brew", "npm", "yarn", "bun", "pip", "composer", "go", "cocoapods"];
const CL_GROUPS = { Sistem: "Sistem & aplikasi", Browser: "Browser", Developer: "Developer" };
const clAge = (t) => {
  const days = Math.floor((Date.now() / 1000 - t) / 86400);
  return days < 1 ? "hari ini" : days < 30 ? `${days} hari lalu` : days < 365 ? `${Math.floor(days / 30)} bulan lalu` : `${Math.floor(days / 365)} tahun lalu`;
};

tabs.cleaner = {
  sel: null, open: new Set(), lg: { scope: "home", min: 200, age: 0, picked: new Set() },
  async load() {
    const sub = ["large", "startup"].includes(this.param) ? this.param : "clean";
    view.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <div class="seg">${[["clean", "Pembersih"], ["large", "File besar"], ["startup", "Startup"]].map(([k, l]) =>
          `<a class="pill-link ${k === sub ? "active" : ""}" href="#cleaner${k === "clean" ? "" : ":" + k}">${l}</a>`).join("")}</div>
        <span class="spacer"></span><span id="clTools" class="row"></span>
      </div>
      <div id="clBody"><div class="loading">${sub === "clean" ? "Menghitung ukuran cache…" : "Memuat…"}</div></div>`;
    return this[sub]();
  },

  // ---------------------------------------------------------- pembersih
  async clean() {
    try { this.data = await api("/api/cleaner"); } catch (e) { return failView(e); }
    if (!this.sel) this.sel = new Set(this.data.cats.filter((c) => CL_DEFAULT.includes(c.id)).map((c) => c.id));
    $("clTools").innerHTML = btn("Scan ulang", "clRescan");
    this.renderClean();
  },
  renderClean() {
    const d = this.data, max = Math.max(...d.cats.map((c) => c.size || 0), 1);
    const chosen = d.cats.filter((c) => this.sel.has(c.id));
    const total = chosen.reduce((s, c) => s + (c.size || 0), 0);
    $("headline").textContent = `${fmtBytes(d.total)} bisa dibersihkan`;
    const groups = Object.keys(CL_GROUPS).map((g) => [g, d.cats.filter((c) => c.group === g)]).filter(([, cs]) => cs.length);
    $("clBody").innerHTML = `
      <div class="card item cl-summary">
        <div><div class="muted small">Dipilih untuk dibersihkan</div>
          <div class="cl-big">${fmtBytes(total)}</div>
          <div class="muted small">${chosen.length} kategori · total ditemukan ${fmtBytes(d.total)}</div></div>
        <div class="actions">${btn("Pilih semua", "clSelAll", { on: 1 })}${btn("Kosongkan pilihan", "clSelAll", {})}
          ${btn(`Bersihkan (${fmtBytes(total)})`, "clClean", {}, "go", chosen.length ? "" : "disabled")}</div>
      </div>
      ${d.running.length ? `<div class="warn">Browser sedang terbuka: <b>${d.running.map(esc).join(", ")}</b>. Tutup dulu supaya cache-nya bisa dibersihkan penuh.</div>` : ""}
      ${groups.map(([g, cs]) => `<h2>${CL_GROUPS[g]}</h2><div class="list">${cs.map((c) => this.catRow(c, max)).join("")}</div>`).join("")}
      ${d.docker ? `<div class="card item" style="margin-top:14px"><div><b>Docker</b><div class="muted small">Image, container, volume, dan build cache yang tidak terpakai dibersihkan dari halaman Docker.</div></div>
        <div class="actions"><a class="btn-link" href="#docker:disk">Buka Docker → Disk</a></div></div>` : ""}
      <p class="muted small">Yang dihapus hanya cache & file sementara yang dibuat ulang otomatis. Cookie, riwayat browser, login, dan dokumen tidak disentuh.
        Penghapusan cache bersifat permanen (tidak lewat Trash).</p>`;
  },
  catRow(c, max) {
    const open = this.open.has(c.id);
    const size = c.size == null ? `<span class="muted" title="Butuh Full Disk Access untuk membaca ukurannya">?</span>` : fmtBytes(c.size);
    return `<div class="card cl-cat">
      <div class="cl-head">
        <label class="cl-check"><input type="checkbox" data-cl-cat="${esc(c.id)}" ${this.sel.has(c.id) ? "checked" : ""}>
          <span><b>${esc(c.name)}</b><div class="muted small">${esc(c.desc)}</div></span></label>
        <div class="cl-size"><b>${size}</b><div class="meter"><div style="width:${((c.size || 0) / max) * 100}%"></div></div></div>
        ${c.items.length ? btn(open ? "Tutup" : "Rincian", "clToggle", { id: c.id }) : "<span></span>"}
      </div>
      ${!c.readable && c.id === "trash" ? `<div class="muted small" style="margin-top:6px">Ukuran Trash tidak terbaca tanpa Full Disk Access, tapi tetap bisa dikosongkan.</div>` : ""}
      ${open ? `<div class="cl-items">${c.items.map((i) => `<div class="cl-item ${i.skip ? "muted" : ""}">
          <span class="pname" title="${esc(i.path)}">${esc(i.name)}</span>
          <span class="small">${fmtBytes(i.size)}</span>
          ${i.skip ? `<span class="small" title="Cache milik macOS / sudah punya kategori sendiri">dilewati</span>`
            : c.method === "contents" ? btn("Hapus", "clItem", { id: c.id, item: i.path, confirm: `Hapus ${i.name} (${fmtBytes(i.size)})?` }, "danger small-btn") : "<span></span>"}
        </div>`).join("")}${c.count > c.items.length ? `<div class="muted small">… ${c.count - c.items.length} item kecil lainnya</div>` : ""}</div>` : ""}
    </div>`;
  },

  // ---------------------------------------------------------- file besar
  async large() {
    const L = this.lg;
    $("clTools").innerHTML = `
      <div class="seg">${[["home", "Home"], ["downloads", "Downloads"], ["all", "Home + Library"]].map(([k, l]) =>
        btn(l, "clScope", { scope: k }, L.scope === k ? "active" : "")).join("")}</div>
      ${L.scope === "downloads"
        ? `<select id="clAge"><option value="0">Semua umur</option><option value="30">> 30 hari</option><option value="90">> 90 hari</option><option value="180">> 180 hari</option><option value="365">> 1 tahun</option></select>`
        : `<select id="clMin"><option value="100">≥ 100 MB</option><option value="200">≥ 200 MB</option><option value="500">≥ 500 MB</option><option value="1024">≥ 1 GB</option></select>`}`;
    if ($("clAge")) { $("clAge").value = L.age; $("clAge").onchange = (e) => { L.age = +e.target.value; this.renderLarge(); }; }
    if ($("clMin")) { $("clMin").value = L.min; $("clMin").onchange = (e) => { L.min = +e.target.value; this.large(); }; }
    try { L.data = await api(`/api/cleaner/large?scope=${L.scope}&min=${L.min}`); } catch (e) { return failView(e); }
    L.picked.clear();
    this.renderLarge();
  },
  renderLarge() {
    const L = this.lg, now = L.data.now;
    const files = L.data.files.filter((f) => !L.age || now - f.mtime > L.age * 86400);
    const picked = files.filter((f) => L.picked.has(f.path));
    const pickedSize = picked.reduce((s, f) => s + f.size, 0);
    $("headline").textContent = `${files.length} item · ${fmtBytes(files.reduce((s, f) => s + f.size, 0))}`;
    $("clBody").innerHTML = `
      <div class="row" style="margin-bottom:10px">
        <label class="chk"><input type="checkbox" id="clAll" ${files.length && picked.length === files.length ? "checked" : ""}> pilih semua</label>
        <span class="spacer"></span>
        ${btn(`Pindahkan ke Trash (${picked.length} · ${fmtBytes(pickedSize)})`, "clTrash", { confirm: `Pindahkan ${picked.length} item (${fmtBytes(pickedSize)}) ke Trash?` }, "danger", picked.length ? "" : "disabled")}
      </div>
      <div class="list">${files.map((f) => `<div class="card item cl-file">
        <label class="cl-check"><input type="checkbox" data-cl-file="${esc(f.path)}" ${L.picked.has(f.path) ? "checked" : ""}>
          <span style="min-width:0"><span class="pname" title="${esc(f.path)}">${f.dir ? "📁 " : ""}${esc(f.name)}</span>
            <div class="meta"><b>${fmtBytes(f.size)}</b><span>diubah ${clAge(f.mtime)}</span></div></span></label>
        <div class="actions">${btn("Finder", "clReveal", { path: f.path })}</div></div>`).join("")
        || `<div class="empty">Tidak ada file yang cocok.</div>`}</div>
      <p class="muted small">Dipindahkan lewat Finder, jadi masih bisa dikembalikan dari Trash (Put Back). File di dalam aplikasi (.app) tidak ditampilkan.
        ${L.scope === "all" ? "Hati-hati dengan file di <code>~/Library</code>: biasanya data aplikasi (emulator, VM, database)." : ""}</p>`;
    $("clAll").onchange = (e) => { files.forEach((f) => (e.target.checked ? L.picked.add(f.path) : L.picked.delete(f.path))); this.renderLarge(); };
  },

  // ---------------------------------------------------------- startup
  async startup() {
    let d;
    try { d = await api("/api/cleaner/startup"); } catch (e) { return failView(e); }
    $("clTools").innerHTML = btn("Login Items di System Settings ↗", "clStartup", { action: "login-items" });
    const scopes = { user: ["User", "~/Library/LaunchAgents"], global: ["Global", "/Library/LaunchAgents"], daemon: ["Daemon", "/Library/LaunchDaemons (root)"] };
    $("headline").textContent = `${d.items.length} item startup`;
    $("clBody").innerHTML = `
      <p class="muted small" style="margin-top:0">Program yang dijalankan otomatis oleh <code>launchd</code> saat login atau boot. Service Homebrew diatur dari halaman
        <a href="#packages">Paket &amp; Service</a>; aplikasi yang terbuka saat login diatur di <b>Login Items</b>.</p>
      ${Object.entries(scopes).map(([k, [label, dir]]) => {
        const items = d.items.filter((i) => i.scope === k);
        return items.length ? `<h2>${label} <span class="muted small">${esc(dir)}</span></h2>
          <div class="table-wrap"><table><tr><th>Label</th><th>Program</th><th>Status</th><th></th></tr>
          ${items.map((i) => `<tr><td><b>${esc(i.label)}</b> ${i.brew ? `<span class="badge amber">Homebrew</span>` : ""}
              ${i.run_at_load ? `<span class="badge">saat login</span>` : ""}${i.keep_alive ? `<span class="badge">keep alive</span>` : ""}
              ${i.disabled ? `<span class="badge">disabled</span>` : ""}</td>
            <td class="small"><code>${esc(i.program || "-")}</code></td>
            <td class="small">${k === "daemon" ? `<span class="muted">-</span>` : i.pid ? `<span class="badge green">berjalan · PID ${i.pid}</span>`
              : i.loaded ? `<span class="badge blue">dimuat</span>` : `<span class="muted">tidak dimuat</span>`}</td>
            <td><div class="actions">${btn("Finder", "clStartup", { action: "reveal", path: i.path })}</div></td></tr>`).join("")}
          </table></div>` : "";
      }).join("")}`;
  },
};

handlers.clRescan = () => { tabs.cleaner.open.clear(); return tabs.cleaner.load(); };
handlers.clToggle = (d) => {
  const o = tabs.cleaner.open;
  o.has(d.id) ? o.delete(d.id) : o.add(d.id);
  tabs.cleaner.renderClean();
};
handlers.clSelAll = (d) => {
  const t = tabs.cleaner;
  t.sel = new Set(d.on ? t.data.cats.map((c) => c.id) : []);
  t.renderClean();
};
handlers.clClean = async () => {
  const t = tabs.cleaner, cats = t.data.cats.filter((c) => t.sel.has(c.id));
  const total = cats.reduce((s, c) => s + (c.size || 0), 0);
  if (!confirm(`Bersihkan ${cats.length} kategori (${fmtBytes(total)})?\n\n${cats.map((c) => "• " + c.name).join("\n")}\n\nCache dihapus permanen.`)) return;
  return runJob(api("/api/cleaner/clean", { ids: cats.map((c) => c.id) }), () => current === t && t.load());
};
handlers.clItem = (d) => runJob(api("/api/cleaner/clean", { ids: [d.id], item: d.item }), () => current === tabs.cleaner && tabs.cleaner.load());
handlers.clScope = (d) => { tabs.cleaner.lg.scope = d.scope; tabs.cleaner.lg.age = 0; tabs.cleaner.large(); };
handlers.clReveal = (d) => api("/api/cleaner/large", { action: "reveal", paths: [d.path] });
handlers.clTrash = async () => {
  const L = tabs.cleaner.lg;
  const r = await api("/api/cleaner/large", { action: "trash", paths: [...L.picked] });
  toast(`${r.count} item dipindahkan ke Trash`);
  tabs.cleaner.large();
};
handlers.clStartup = (d) => api("/api/cleaner/startup", { action: d.action, path: d.path });

// checkbox kategori & file (bukan tombol → tidak lewat data-act)
document.addEventListener("change", (e) => {
  const t = tabs.cleaner, cat = e.target.dataset?.clCat, file = e.target.dataset?.clFile;
  if (cat) { e.target.checked ? t.sel.add(cat) : t.sel.delete(cat); t.renderClean(); }
  if (file) { e.target.checked ? t.lg.picked.add(file) : t.lg.picked.delete(file); t.renderLarge(); }
});

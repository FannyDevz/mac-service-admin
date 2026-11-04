// Port (#ports): port TCP yang sedang listen, kegunaannya, project asalnya, dan tombol untuk mematikannya.

const PORT_GROUPS = [
  ["project", "Project & dev server", "Aman dihentikan: nyalakan lagi dari folder project-nya kalau perlu."],
  ["service", "Database & service", "Dipakai aplikasi lain. Pastikan tidak sedang dibutuhkan sebelum dihentikan."],
  ["app", "Aplikasi", "Port ikut tertutup kalau aplikasinya ditutup."],
  ["system", "Sistem macOS", "Dikelola macOS, jadi tidak ada tombol hentikan."],
];
// etime dari ps: [[hari-]jam:]menit:detik
const portAge = (e) => {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(e || "");
  if (!m) return "";
  const [d, h, min] = [+m[1] || 0, +m[2] || 0, +m[3]];
  return d ? `${d} hari` : h ? `${h} jam` : min ? `${min} menit` : "baru saja";
};
const portAlso = (r) => (r.others.length ? `\n\nProses ini juga memakai port ${r.others.join(", ")}, dan semuanya ikut tertutup.` : "");

function portAction(r) {
  const s = r.stop;
  if (!s) return "";
  if (s.type === "link") return `<a class="btn-link" href="${esc(s.href)}">${esc(s.label)}</a>`;
  if (s.type === "kill") return btn("Hentikan", "portStop", { port: r.port, pid: r.pid,
    confirm: `Hentikan ${r.title} di port ${r.port} (PID ${r.pid})?${portAlso(r)}` }, "danger");
  if (s.type === "brew") return btn("Stop service", "portBrew", { name: s.name,
    confirm: `Hentikan service ${s.name}?\n\nService ini juga tidak akan menyala otomatis saat login sampai di-start lagi. Aplikasi yang memakainya akan kehilangan koneksi.` }, "danger");
  if (s.type === "app") return btn("Tutup aplikasi", "portQuit", { path: s.path, name: s.name,
    confirm: `Tutup aplikasi ${s.name}? Pekerjaan yang belum disimpan bisa diminta konfirmasi oleh aplikasinya.` });
  return "";
}

function portRow(r) {
  const p = r.project;
  return `<tr>
    <td><b class="mono">${r.port}</b><div class="small">${r.public
      ? `<span class="badge amber" title="${esc(r.addrs.join(", "))}">jaringan</span>`
      : `<span class="badge" title="${esc(r.addrs.join(", "))}">lokal</span>`}</div></td>
    <td><b>${esc(r.title)}</b><div class="muted small">${esc(r.desc)}</div>
      ${r.hint ? `<div class="muted small">${esc(r.hint)}</div>` : ""}</td>
    <td class="port-src small">
      ${p ? `<div><b>${esc(p.name)}</b> ${p.missing ? `<span class="badge red">folder hilang</span>` : p.temp ? `<span class="badge amber">folder sementara</span>` : ""}</div>
        <div class="muted pname" title="${esc(p.path)}">${esc(p.path)}</div>` : ""}
      <div class="muted pname" title="${esc(r.command)}"><code>${esc(r.process)}</code> · PID ${r.pid}${r.pids.length > 1 ? ` +${r.pids.length - 1}` : ""}${r.etime ? ` · ${portAge(r.etime)}` : ""}</div>
    </td>
    <td><div class="actions">${r.web ? `<a class="btn-link" href="http://localhost:${r.port}" target="_blank" rel="noopener">Buka ↗</a>` : ""}${portAction(r)}</div></td>
  </tr>`;
}

tabs.ports = {
  interval: 10000, last: "",
  async load(silent) {
    if (!silent) { this.last = ""; view.innerHTML = `<div class="loading">Memeriksa port…</div>`; }
    let d;
    try { d = await api("/api/ports"); } catch (e) { return silent ? undefined : failView(e); }
    if (current !== this) return;
    const json = JSON.stringify(d.ports);
    if (json === this.last) return;  // tidak ada perubahan: jangan render ulang supaya tidak berkedip
    this.last = json;
    const dev = d.ports.filter((r) => r.group === "project").length;
    $("headline").textContent = `${d.ports.length} port terbuka${dev ? ` · ${dev} project` : ""}`;
    view.innerHTML = PORT_GROUPS.map(([key, label, note]) => {
      const rows = d.ports.filter((r) => r.group === key);
      return rows.length ? `<h2>${label} <span class="muted small">${note}</span></h2>
        <div class="table-wrap"><table class="port-table"><tr><th>Port</th><th>Dipakai untuk</th><th>Asal</th><th></th></tr>
        ${rows.map(portRow).join("")}</table></div>` : "";
    }).join("") + `<p class="muted small"><b>Lokal</b> hanya bisa diakses dari Mac ini; <b>jaringan</b> bisa dijangkau perangkat lain di jaringan yang sama.
      Port milik root tidak terbaca tanpa sudo, jadi tidak muncul di sini.</p>`
      || `<div class="empty">Tidak ada port yang terbuka.</div>`;
  },
};

handlers.portStop = async (d) => {
  const body = { action: "stop", port: +d.port, pid: +d.pid };
  let r = await api("/api/ports", body);
  if (!r.stopped && confirm(`Proses di port ${d.port} belum berhenti. Paksa berhenti (SIGKILL)?\n\nData yang belum disimpan proses ini bisa hilang.`)) {
    r = await api("/api/ports", { ...body, force: true });
  }
  toast(r.stopped ? `Port ${d.port} sudah ditutup` : `Port ${d.port} masih terbuka`, !r.stopped);
  return tabs.ports.load(true);
};
handlers.portBrew = async (d) => {
  await api("/api/action", { name: d.name, action: "stop" });
  toast(`Service ${d.name} dihentikan`);
  return tabs.ports.load(true);
};
handlers.portQuit = async (d) => {
  await api("/api/macapps/action", { action: "quit", path: d.path });
  toast(`Menutup ${d.name}…`);
  setTimeout(() => current === tabs.ports && tabs.ports.load(true), 1500);
};

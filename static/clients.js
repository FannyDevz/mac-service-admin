// Catatan client pembuatan web (#clients, #clients:<status>): kontak, web, tanggal, status, nilai proyek.

const CL_STATUS = { prospek: ["Prospek", ""], berjalan: ["Berjalan", "blue"], maintenance: ["Maintenance", "amber"], selesai: ["Selesai", "green"], batal: ["Batal", "red"] };
// nomor lokal 08xx -> 628xx untuk tautan WhatsApp
const clWa = (p) => { const n = p.replace(/\D/g, ""); return n.startsWith("0") ? "62" + n.slice(1) : n; };

tabs.clients = {
  q: "",
  async load() {
    const sub = CL_STATUS[this.param] ? this.param : "";
    let d;
    try { d = await api("/api/clients"); } catch (e) { return failView(e); }
    this.data = d;
    this.sub = sub;
    const all = d.clients, totals = Object.entries(d.totals);
    $("headline").textContent = all.length ? `${all.length} client` : "";
    view.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <div class="seg">${[["", "Semua"], ...Object.entries(CL_STATUS).map(([k, v]) => [k, v[0]])].map(([k, l]) =>
          `<a class="pill-link ${k === sub ? "active" : ""}" href="#clients${k ? ":" + k : ""}">${l}</a>`).join("")}</div>
        <span class="spacer"></span><input type="search" id="clientQ" placeholder="Cari nama, web, nomor…" value="${esc(this.q)}">
        ${btn("＋ Client", "clientEdit", {}, "go")}
      </div>
      <div class="grid kpis">
        <div class="card kpi"><div class="label">Total client</div><div class="value">${all.length}</div></div>
        <div class="card kpi"><div class="label">Berjalan</div><div class="value">${all.filter((c) => c.status === "berjalan").length}</div></div>
        <div class="card kpi"><div class="label">Maintenance</div><div class="value">${all.filter((c) => c.status === "maintenance").length}</div></div>
        <div class="card kpi"><div class="label">Total nilai proyek</div><div class="value money">${totals.map(([c, v]) => recMoney(v, c)).join("<br>") || "-"}</div></div>
      </div>
      <div id="clientList"></div>
      <p class="muted small">Disimpan tanpa enkripsi di <code>~/.service-admin/clients.json</code>. Nilai proyek yang dibatalkan tidak dihitung.</p>`;
    $("clientQ").oninput = (e) => { this.q = e.target.value; this.renderList(); };
    this.renderList();
  },
  renderList() {
    const q = this.q.trim().toLowerCase();
    const items = this.data.clients
      .filter((c) => (!this.sub || c.status === this.sub)
        && (!q || [c.name, c.company, c.project, c.web, c.phone, c.email, c.notes].join(" ").toLowerCase().includes(q)))
      .sort((a, b) => (b.start || "").localeCompare(a.start || "") || a.name.localeCompare(b.name));
    $("clientList").innerHTML = `<div class="table-wrap"><table><tr><th>Client</th><th>Kontak</th><th>Web</th><th>Waktu</th><th>Nilai</th><th></th></tr>
      ${items.map((c) => `<tr><td><b>${esc(c.name)}</b> <span class="badge ${CL_STATUS[c.status][1]}">${CL_STATUS[c.status][0]}</span>
            ${c.company ? `<div class="muted small">${esc(c.company)}</div>` : ""}
            ${c.notes ? `<div class="muted small rec-note">${esc(c.notes)}</div>` : ""}</td>
          <td class="small">${c.phone ? `${esc(c.phone)} <a href="https://wa.me/${esc(clWa(c.phone))}" target="_blank" rel="noopener">WhatsApp ↗</a>` : "-"}
            ${c.email ? `<div><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>` : ""}</td>
          <td class="small">${c.project ? `<div>${esc(c.project)}</div>` : ""}
            ${c.web ? `<a href="${esc(c.web)}" target="_blank" rel="noopener">${esc(c.web.replace(/^https?:\/\//, ""))} ↗</a>` : c.project ? "" : "-"}</td>
          <td class="small">${recDate(c.start)}<div class="muted">sampai ${recDate(c.end)}</div></td>
          <td class="small">${c.price == null ? "-" : recMoney(c.price, c.currency)}</td>
          <td><div class="actions">${btn("Edit", "clientEdit", { id: c.id })}
            ${btn("Hapus", "clientDel", { id: c.id, confirm: `Hapus catatan client ${c.name}?` }, "danger")}</div></td></tr>`).join("")
        || `<tr><td colspan="6" class="empty">${this.data.clients.length ? "Tidak ada yang cocok." : "Belum ada client."}</td></tr>`}
    </table></div>`;
  },
};

handlers.clientDel = async (d) => { await api("/api/clients", { action: "delete", id: d.id }); await tabs.clients.load(); };
handlers.clientEdit = (d) => {
  const c = tabs.clients.data.clients.find((x) => x.id === d.id) || { status: "berjalan", currency: "IDR" };
  monDialog(d.id ? `Edit ${c.name}` : "Tambah client", `
    <div class="grid two"><div class="field"><label>Nama client</label><input name="name" required value="${esc(c.name || "")}" placeholder="Budi Santoso"></div>
      <div class="field"><label>Perusahaan (opsional)</label><input name="company" value="${esc(c.company || "")}"></div></div>
    <div class="grid two"><div class="field"><label>Nomor HP</label><input name="phone" value="${esc(c.phone || "")}" placeholder="081234567890"></div>
      <div class="field"><label>Email</label><input name="email" value="${esc(c.email || "")}" placeholder="budi@example.com"></div></div>
    <div class="grid two"><div class="field"><label>Web / proyek</label><input name="project" value="${esc(c.project || "")}" placeholder="Company profile, toko online, …"></div>
      <div class="field"><label>Alamat web</label><input name="web" value="${esc(c.web || "")}" placeholder="example.com"></div></div>
    <div class="grid two"><div class="field"><label>Tanggal mulai</label><input name="start" type="date" value="${esc(c.start || "")}"></div>
      <div class="field"><label>Tanggal selesai</label><input name="end" type="date" value="${esc(c.end || "")}"></div></div>
    <div class="grid two"><div class="grid two"><div class="field"><label>Nilai proyek</label><input name="price" type="number" min="0" step="any" value="${esc(c.price ?? "")}"></div>
        <div class="field"><label>Mata uang</label><select name="currency">${["IDR", "USD"].map((x) => `<option ${x === c.currency ? "selected" : ""}>${x}</option>`).join("")}</select></div></div>
      <div class="field"><label>Status</label><select name="status">${Object.entries(CL_STATUS).map(([k, v]) => `<option value="${k}" ${k === c.status ? "selected" : ""}>${v[0]}</option>`).join("")}</select></div></div>
    <div class="field"><label>Catatan</label><textarea name="notes" rows="3">${esc(c.notes || "")}</textarea></div>`,
    async (v) => { await api("/api/clients", { action: "save", id: d.id || "", ...v }); if (current === tabs.clients) await tabs.clients.load(); });
};

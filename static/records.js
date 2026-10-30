// Catatan domain, server & langganan (#records, #records:<kind>): lokasi, harga, tanggal, reminder.

const REC_CYCLES = { 1: "Bulanan", 3: "3 bulan", 6: "6 bulan", 12: "Tahunan", 24: "2 tahun", 36: "3 tahun", 0: "Sekali bayar" };
const REC_KINDS = { domain: "Domain", server: "Server", subscription: "Subscription" };
const recMoney = (v, cur) => new Intl.NumberFormat("id-ID", { style: "currency", currency: cur, maximumFractionDigits: cur === "IDR" ? 0 : 2 }).format(v);
const recDate = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" }) : "-");
const recDue = (r) => {
  const n = r.days_left;
  if (n == null) return `<span class="muted small">tidak dicatat</span>`;
  const text = n < 0 ? `lewat ${-n} hari` : n === 0 ? "hari ini" : `${n} hari lagi`;
  return `${recDate(r.expires)} <span class="badge ${n <= 7 ? "red" : n <= 30 ? "amber" : ""}">${text}</span>`;
};

tabs.records = {
  async load() {
    const sub = REC_KINDS[this.param] ? this.param : "";
    let d;
    try { d = await api("/api/records"); } catch (e) { return failView(e); }
    this.data = d;
    const all = d.records, due = all.filter((r) => r.days_left != null && r.days_left <= d.due_days);
    const items = all.filter((r) => !sub || r.kind === sub)
      .sort((a, b) => (a.days_left ?? Infinity) - (b.days_left ?? Infinity) || a.name.localeCompare(b.name));
    const yearly = Object.entries(d.yearly);
    $("headline").textContent = due.length ? `${due.length} jatuh tempo dalam ${d.due_days} hari` : "";
    view.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <div class="seg">${[["", "Semua"], ...Object.entries(REC_KINDS)].map(([k, l]) =>
          `<a class="pill-link ${k === sub ? "active" : ""}" href="#records${k ? ":" + k : ""}">${l}</a>`).join("")}</div>
        <span class="spacer"></span>${btn("＋ Domain", "recEdit", { kind: "domain" }, "go")}${btn("＋ Server", "recEdit", { kind: "server" }, "go")}${btn("＋ Subscription", "recEdit", { kind: "subscription" }, "go")}
      </div>
      <div class="grid kpis five">
        ${Object.entries(REC_KINDS).map(([k, l]) => `<div class="card kpi"><div class="label">${l}</div><div class="value">${all.filter((r) => r.kind === k).length}</div></div>`).join("")}
        <div class="card kpi"><div class="label">Jatuh tempo ≤ ${d.due_days} hari</div><div class="value">${due.length}</div></div>
        <div class="card kpi"><div class="label">Perkiraan biaya per tahun</div>
          <div class="value money">${yearly.map(([c, v]) => recMoney(v, c)).join("<br>") || "-"}</div></div>
      </div>
      <div class="table-wrap"><table><tr><th>Nama</th><th>Ditaruh di</th><th>Harga</th><th>Register</th><th>Jatuh tempo</th><th></th></tr>
        ${items.map((r) => `<tr><td><b>${esc(r.name)}</b> <span class="badge">${REC_KINDS[r.kind]}</span>
              ${r.auto_renew ? `<span class="badge blue">auto-renew</span>` : ""}
              ${r.address ? `<div class="muted small">${esc(r.address)}</div>` : ""}
              ${r.notes ? `<div class="muted small rec-note">${esc(r.notes)}</div>` : ""}</td>
            <td class="small">${esc(r.provider || "-")}${r.account ? `<div class="muted">${esc(r.account)}</div>` : ""}</td>
            <td class="small">${r.price == null ? "-" : `${recMoney(r.price, r.currency)}<div class="muted">${REC_CYCLES[r.cycle] || ""}</div>`}</td>
            <td class="small">${recDate(r.registered)}</td>
            <td class="small">${recDue(r)}</td>
            <td><div class="actions">
              ${r.expires && r.cycle ? btn(r.kind === "subscription" ? "Sudah dibayar" : "Sudah diperpanjang", "recAct", { action: "renew", id: r.id, confirm: `Majukan jatuh tempo ${r.name} sebanyak 1 siklus (${REC_CYCLES[r.cycle]})?` }) : ""}
              ${btn("Edit", "recEdit", { id: r.id })}
              ${btn("Hapus", "recAct", { action: "delete", id: r.id, confirm: `Hapus catatan ${r.name}?` }, "danger")}</div></td></tr>`).join("")
          || `<tr><td colspan="6" class="empty">Belum ada catatan.</td></tr>`}
      </table></div>
      <p class="muted small">Reminder dikirim sebagai notifikasi macOS 30, 14, 7, 3, dan 1 hari sebelum jatuh tempo, pada harinya, dan setelah lewat.
        Disimpan tanpa enkripsi di <code>~/.service-admin/records.json</code>, jadi jangan menaruh password di sini.</p>`;
  },
};

handlers.recAct = async (d) => {
  await api("/api/records", { action: d.action, id: d.id });
  await tabs.records.load();
  monPoll();
};
handlers.recEdit = (d) => {
  const r = tabs.records.data.records.find((x) => x.id === d.id) || { kind: d.kind, currency: "IDR", cycle: d.kind === "subscription" ? 1 : 12 };
  // label & contoh isian per jenis: [nama, contoh, lokasi, contoh, alamat, contoh, tanggal]
  const L = {
    domain: ["Nama domain", "example.com", "Ditaruh di (registrar)", "Niagahoster, Cloudflare, …", "Nameserver / DNS", "ns1.example.net", "Jatuh tempo / perpanjang"],
    server: ["Nama server", "VPS Jakarta 1", "Ditaruh di (provider)", "DigitalOcean, Biznet, …", "IP / lokasi / spesifikasi", "203.0.113.10, Jakarta, 4 GB", "Jatuh tempo / perpanjang"],
    subscription: ["Nama layanan", "AWS, Supabase, …", "Penyedia / dipakai untuk", "Amazon, project toko online, …", "Plan / paket", "Pro, pay-as-you-go, …", "Tagihan berikutnya"],
  }[r.kind];
  monDialog(d.id ? `Edit ${r.name}` : `Tambah ${REC_KINDS[r.kind].toLowerCase()}`, `
    <input type="hidden" name="kind" value="${esc(r.kind)}">
    <div class="grid two"><div class="field"><label>${L[0]}</label><input name="name" required value="${esc(r.name || "")}" placeholder="${L[1]}"></div>
      <div class="field"><label>${L[2]}</label><input name="provider" value="${esc(r.provider || "")}" placeholder="${L[3]}"></div></div>
    <div class="grid two"><div class="field"><label>Akun (email/username)</label><input name="account" value="${esc(r.account || "")}" placeholder="Tanpa password"></div>
      <div class="field"><label>${L[4]}</label><input name="address" value="${esc(r.address || "")}" placeholder="${L[5]}"></div></div>
    <div class="grid two"><div class="grid two"><div class="field"><label>Harga</label><input name="price" type="number" min="0" step="any" value="${esc(r.price ?? "")}"></div>
        <div class="field"><label>Mata uang</label><select name="currency">${["IDR", "USD"].map((c) => `<option ${c === r.currency ? "selected" : ""}>${c}</option>`).join("")}</select></div></div>
      <div class="field"><label>Siklus tagihan</label><select name="cycle">${[1, 3, 6, 12, 24, 36, 0].map((c) => `<option value="${c}" ${c === r.cycle ? "selected" : ""}>${REC_CYCLES[c]}</option>`).join("")}</select></div></div>
    <div class="grid two"><div class="field"><label>Tanggal register</label><input name="registered" type="date" value="${esc(r.registered || "")}"></div>
      <div class="field"><label>${L[6]}</label><input name="expires" type="date" value="${esc(r.expires || "")}"></div></div>
    <label class="chk"><input type="checkbox" name="auto_renew" ${r.auto_renew ? "checked" : ""}> Auto-renew aktif</label>
    <div class="field"><label>Catatan</label><textarea name="notes" rows="3">${esc(r.notes || "")}</textarea></div>`,
    async (v) => {
      await api("/api/records", { action: "save", id: d.id || "", ...v, auto_renew: !!v.auto_renew });
      if (current === tabs.records) await tabs.records.load();
      monPoll();
    });
};

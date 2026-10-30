// Uptime (#monitor): web (HTTP) & server (TCP/ping), riwayat, kejadian. Juga form dialog bersama
// (monDialog) dan polling lencana sidebar + toast kejadian baru di semua halaman.

const MON_KINDS = { http: "Web (HTTP/HTTPS)", tcp: "Server (port TCP)", ping: "Server (ping)" };
const MON_INTERVALS = { 10: "10 detik", 15: "15 detik", 30: "30 detik", 60: "1 menit", 120: "2 menit", 300: "5 menit", 600: "10 menit", 900: "15 menit",
  1800: "30 menit", 3600: "1 jam", 7200: "2 jam", 21600: "6 jam", 43200: "12 jam", 86400: "24 jam" };
const monAgo = (t) => {
  const s = Math.max(0, Date.now() / 1000 - t);
  return s < 60 ? `${Math.round(s)} detik lalu` : s < 3600 ? `${Math.floor(s / 60)} menit lalu`
    : s < 86400 ? `${Math.floor(s / 3600)} jam lalu` : `${Math.floor(s / 86400)} hari lalu`;
};
const monAddr = (t) => (t.kind === "http" ? t.url : t.kind === "tcp" ? `${t.host}:${t.port}` : t.host);
const monPct = (v) => (v == null ? "-" : `${v}%`);

// dialog form: pesan error tampil di dalam dialog karena toast tertutup oleh modal
function monDialog(title, html, onSubmit) {
  const f = $("monForm");
  $("monDlgTitle").textContent = title;
  f.innerHTML = `${html}<div class="err" id="monFormErr" hidden style="padding:0"></div>
    <div class="row"><span class="spacer"></span><button class="go">Simpan</button></div>`;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const b = f.querySelector("button.go");
    b.disabled = true;
    try { await onSubmit(Object.fromEntries(new FormData(f))); $("monDlg").close(); }
    catch (err) { $("monFormErr").hidden = false; $("monFormErr").textContent = err.message; }
    finally { b.disabled = false; }
  };
  $("monDlg").showModal();
  return f;
}

tabs.monitor = {
  interval: 10000,
  async load(silent) {
    let d;
    try { d = await api("/api/monitor"); } catch (e) { return silent ? null : failView(e); }
    this.data = d;
    const on = d.targets.filter((t) => t.enabled !== false);
    const up = on.filter((t) => t.status === "up").length, down = on.filter((t) => t.status === "down").length;
    const rows = on.map((t) => t.uptime["24h"]).filter((v) => v != null);
    const avg = rows.length ? (rows.reduce((a, b) => a + b, 0) / rows.length).toFixed(2) : null;
    $("headline").textContent = d.targets.length ? (down ? `${down} down` : `${up} dari ${on.length} up`) : "";
    view.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <span class="spacer"></span>${btn("Tes notifikasi", "monNotifyTest")}${btn("＋ Tambah monitor", "monEdit", {}, "go")}
      </div>
      ${d.online ? "" : `<div class="warn">Mac sedang tidak terhubung internet. Hasil gagal tidak dihitung sampai koneksi kembali.</div>`}
      ${d.running ? "" : `<div class="warn">Pengecekan background belum jalan. Restart server untuk mengaktifkannya.</div>`}
      <div class="grid kpis">
        ${[["Dipantau", on.length, ""], ["Up", up, ""], ["Down", down, ""], ["Uptime rata-rata 24 jam", avg ?? "-", avg ? "%" : ""]]
          .map(([l, v, u]) => `<div class="card kpi"><div class="label">${l}</div><div class="value">${v}<small>${u}</small></div></div>`).join("")}
      </div>
      <div class="list">${d.targets.map((t) => this.row(t)).join("") || `<div class="empty">Belum ada monitor. Tambahkan web atau server untuk mulai memantau.</div>`}</div>
      <h2>Kejadian</h2>
      <div class="table-wrap"><table><tr><th>Waktu</th><th>Kejadian</th><th>Detail</th></tr>
        ${d.events.map((e) => `<tr><td class="small" title="${esc(new Date(e.t * 1000).toLocaleString("id-ID"))}">${monAgo(e.t)}</td>
          <td><span class="badge ${{ down: "red", up: "green", reminder: "amber" }[e.kind] || ""}">${esc(e.title)}</span></td>
          <td class="small">${esc(e.msg)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">Belum ada kejadian.</td></tr>`}
      </table></div>
      <p class="muted small">Pengecekan dilakukan dari Mac ini, jadi hanya berjalan selama Mac menyala dan server aktif. Down dinyatakan setelah
        2 kali gagal berturut-turut, dan kegagalan saat Mac offline tidak dihitung.</p>`;
  },
  row(t) {
    const off = t.enabled === false;
    const dot = off ? "" : t.status === "up" ? "on" : t.status === "down" ? "bad" : "mid";
    const label = off ? "dijeda" : t.status === "up" ? "Up" : t.status === "down" ? "Down" : t.fails ? "mengecek ulang" : "menunggu cek pertama";
    const recent = t.recent || [];
    const bars = Array(Math.max(0, 60 - recent.length)).fill("<i></i>").join("")
      + recent.map(([at, ok, ms]) => `<i class="${ok ? "ok" : "bad"}" title="${esc(new Date(at * 1000).toLocaleString("id-ID"))} · ${ms} ms"></i>`).join("");
    return `<div class="card mon-card">
      <div class="item">
        <div style="min-width:0"><div class="row"><span class="dot ${dot}"></span><b>${esc(t.name)}</b>
            <span class="badge ${t.status === "down" && !off ? "red" : t.status === "up" && !off ? "green" : ""}">${label}</span>
            <span class="badge">${esc(MON_KINDS[t.kind])}</span></div>
          <div class="meta"><span class="pname">${esc(monAddr(t))}</span>
            ${t.last_check ? `<span>dicek ${monAgo(t.last_check)}</span><span>${t.last_ms} ms</span>` : ""}
            ${t.last_code ? `<span>HTTP ${t.last_code}</span>` : ""}
            ${t.status && t.since ? `<span>${t.status === "down" ? "down" : "up"} sejak ${monAgo(t.since)}</span>` : ""}
            <span>tiap ${MON_INTERVALS[t.interval]}</span></div>
          ${t.last_error && !off ? `<div class="small" style="color:var(--red);margin-top:4px">${esc(t.last_error)}</div>` : ""}</div>
        <div class="actions">${btn("Cek sekarang", "monAct", { action: "check", id: t.id })}
          ${btn(off ? "Lanjutkan" : "Jeda", "monAct", { action: "toggle", id: t.id })}
          ${btn("Edit", "monEdit", { id: t.id })}
          ${btn("Hapus", "monAct", { action: "delete", id: t.id, confirm: `Hapus monitor ${t.name} beserta riwayatnya?` }, "danger")}</div>
      </div>
      <div class="up-bar">${bars}</div>
      <div class="mon-uptime"><span>24 jam <b>${monPct(t.uptime["24h"])}</b></span><span>7 hari <b>${monPct(t.uptime["7d"])}</b></span><span>30 hari <b>${monPct(t.uptime["30d"])}</b></span></div>
    </div>`;
  },
};

handlers.monAct = async (d) => {
  await api("/api/monitor", { action: d.action, id: d.id });
  await tabs.monitor.load(true);
  monPoll();
};
handlers.monNotifyTest = async () => {
  await api("/api/monitor", { action: "notify-test" });
  toast("Notifikasi dikirim. Kalau tidak muncul, izinkan Script Editor di System Settings → Notifications.");
};
handlers.monEdit = (d) => {
  const t = tabs.monitor.data.targets.find((x) => x.id === d.id) || { kind: "http", interval: 60 };
  const f = monDialog(d.id ? `Edit ${t.name}` : "Tambah monitor", `
    <div class="grid two"><div class="field"><label>Nama</label><input name="name" required maxlength="100" value="${esc(t.name || "")}" placeholder="Website utama"></div>
      <div class="field"><label>Jenis</label><select name="kind">${Object.entries(MON_KINDS).map(([k, l]) => `<option value="${k}" ${k === t.kind ? "selected" : ""}>${l}</option>`).join("")}</select></div></div>
    <div class="field" data-mon="http"><label>URL</label><input name="url" value="${esc(t.url || "")}" placeholder="https://example.com"></div>
    <div class="field" data-mon="http"><label>Status HTTP yang dianggap up (opsional)</label><input name="expect" value="${esc((t.expect || []).join(", "))}" placeholder="kosong = semua di bawah 400; contoh: 200, 403"></div>
    <div class="grid two"><div class="field" data-mon="tcp ping"><label>Host / IP</label><input name="host" value="${esc(t.host || "")}" placeholder="203.0.113.10"></div>
      <div class="field" data-mon="tcp"><label>Port</label><input name="port" type="number" min="1" max="65535" value="${esc(t.port || "")}" placeholder="22"></div></div>
    <div class="field"><label>Cek setiap</label><select name="interval">${Object.entries(MON_INTERVALS).map(([k, l]) => `<option value="${k}" ${+k === t.interval ? "selected" : ""}>${l}</option>`).join("")}</select></div>`,
    async (v) => { await api("/api/monitor", { action: "save", id: d.id || "", ...v }); if (current === tabs.monitor) await tabs.monitor.load(true); });
  const sync = () => f.querySelectorAll("[data-mon]").forEach((x) => { x.hidden = !x.dataset.mon.split(" ").includes(f.elements.kind.value); });
  f.elements.kind.onchange = sync;
  sync();
};

// lencana sidebar + toast kejadian baru, aktif di halaman apa pun
let monSeq = null;
async function monPoll() {
  let d;
  try { d = await api(`/api/monitor/alerts?since=${monSeq ?? 0}`); } catch { return; }
  const badge = (id, n, title) => { const el = $(id); el.textContent = n || ""; el.title = n ? title : ""; el.classList.toggle("alert", n > 0); };
  badge("monBadge", d.down, `${d.down} monitor down`);
  badge("recBadge", d.due, `${d.due} catatan jatuh tempo dalam 30 hari`);
  if (monSeq !== null) d.events.reverse().forEach((e) => toast(`${e.title}: ${e.msg}`, e.kind === "down"));
  monSeq = d.seq;
}
monPoll();
setInterval(monPoll, 20000);

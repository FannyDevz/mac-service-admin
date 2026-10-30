// Tailscale (#tailscale): status & connect/disconnect, perangkat di tailnet (ping, SSH, exit node),
// pengaturan (`tailscale set`), Serve/Funnel untuk membagikan port lokal, dan ganti akun.

const TS_STATE = { Running: ["green", "Terhubung"], Stopped: ["", "Terputus"], NeedsLogin: ["amber", "Perlu login"],
  NeedsMachineAuth: ["amber", "Menunggu persetujuan admin"], Starting: ["blue", "Menghubungkan…"], NoState: ["", "Tidak aktif"] };
const tsAgo = (s) => {
  if (!s || s.startsWith("0001")) return "-";
  const m = Math.floor((Date.now() - new Date(s)) / 60000);
  return m < 1 ? "baru saja" : m < 60 ? `${m} menit lalu` : m < 1440 ? `${Math.floor(m / 60)} jam lalu` : `${Math.floor(m / 1440)} hari lalu`;
};
const tsIp4 = (p) => p.ips.find((ip) => ip.includes(".")) || p.ips[0] || "";
const tsCopy = (text) => `<button class="link-btn mono small" data-act="tsCopy" data-text="${esc(text)}" title="Salin">${esc(text)}</button>`;

tabs.tailscale = {
  logo: "tailscale", title: "Tailscale", interval: 10000,
  async load(silent) {
    let d;
    try { d = await api("/api/tailscale"); } catch (e) { return silent ? null : failView(e); }
    this.data = d;
    if (!d.installed) {
      view.innerHTML = `<div class="card"><h3>Tailscale belum terinstall</h3>
        <p class="muted">Tailscale membuat jaringan privat (VPN mesh berbasis WireGuard) antar perangkatmu: akses Mac ini dari HP atau laptop lain,
          bagikan app lokal ke tim lewat Serve/Funnel, atau pakai exit node.</p>
        ${btn("Install Tailscale (Homebrew cask)", "tsInstall", {}, "primary")}</div>`;
      return;
    }
    const [cls, label] = TS_STATE[d.state] || ["", d.state];
    $("headline").textContent = `v${d.version} · ${label}`;
    const running = d.state === "Running";
    if (!silent || !$("tsTop")) {
      view.innerHTML = `<div id="tsTop"></div><div id="tsPeers"></div>
        <div class="grid two" style="margin-top:14px"><div class="card" id="tsServe"></div><div id="tsSide"></div></div>`;
    }
    const health = d.health.filter((h) => !(d.state === "Stopped" && /stopped/i.test(h)));
    $("tsTop").innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <span class="badge ${cls}" style="font-size:12px;padding:3px 10px">${running ? `<span class="dot on" style="display:inline-block;width:7px;height:7px;margin-right:5px"></span>` : ""}${esc(label)}</span>
        <span class="muted small">${esc(d.user.login || "")}${d.tailnet.Name ? ` · tailnet <b>${esc(d.tailnet.Name)}</b>` : ""}</span>
        <span class="spacer"></span>
        ${running ? btn("Putuskan", "tsAct", { action: "down", confirm: "Putuskan Tailscale? Koneksi SSH/remote lewat Tailscale ke Mac ini akan terputus." }, "danger")
                  : btn(d.state === "NeedsLogin" ? "Login & hubungkan" : "Hubungkan", "tsAct", { action: "up", job: 1 }, "go")}
        ${btn("Netcheck", "tsAct", { action: "netcheck", job: 1 }, "", `title="Cek kualitas jaringan & DERP relay terdekat"`)}
        ${d.app ? btn("Buka aplikasi Tailscale", "tsAct", { action: "open-app" }) : ""}
        <a class="btn-link" href="https://login.tailscale.com/admin/machines" target="_blank" rel="noopener">Admin console ↗</a>
      </div>
      ${d.auth_url ? `<div class="warn row">Perangkat ini perlu login ke Tailscale. <span class="spacer"></span>
        <a class="btn-link primary-link" href="${esc(d.auth_url)}" target="_blank" rel="noopener">Buka halaman login ↗</a></div>` : ""}
      ${health.map((h) => `<div class="warn">⚠️ ${esc(h)}</div>`).join("")}
      <div class="stat">
        <div class="card"><div>Mac ini</div><div>${esc(d.self.name)}</div>
          <div class="muted small">${d.self.ips.map(tsCopy).join(" ")}</div></div>
        <div class="card"><div>Nama MagicDNS</div><div style="font-size:14px">${d.self.dns ? tsCopy(d.self.dns) : "-"}</div>
          <div class="muted small">${d.tailnet.MagicDNSEnabled ? "MagicDNS aktif" : "MagicDNS mati"} · kunci berlaku s.d. ${esc((d.self.key_expiry || "-").slice(0, 10))}</div></div>
        <div class="card"><div>Exit node</div><div>${d.exit_node ? esc(d.exit_node.name) : "Tidak dipakai"}</div>
          <div class="muted small">${d.exit_node ? btn("Berhenti pakai", "tsAct", { action: "exit-node", ip: "" }) : "Semua lalu lintas internet lewat jaringan biasa"}</div></div>
        <div class="card"><div>Perangkat</div><div>${d.peers.filter((p) => p.online).length} online <span class="muted small">dari ${d.peers.length}</span></div>
          <div class="muted small">${running ? "di tailnet ini" : "hubungkan untuk melihat status terkini"}</div></div>
      </div>`;
    $("tsPeers").innerHTML = this.peers(d);
    if (!silent || !$("tsServeForm")) {
      $("tsServe").innerHTML = this.serve(d);
      $("tsSide").innerHTML = this.side(d);
    } else {
      $("tsServeList").innerHTML = this.serveList(d);
    }
  },

  peers(d) {
    if (!d.peers.length) return `<div class="empty">${d.state === "Running" ? "Belum ada perangkat lain di tailnet ini." : "Perangkat tampil setelah Tailscale terhubung."}</div>`;
    const running = d.state === "Running";
    return `<h2>Perangkat</h2><div class="table-wrap"><table>
      <tr><th>Perangkat</th><th>IP</th><th>Koneksi</th><th>Terakhir terlihat</th><th>Trafik</th><th></th></tr>
      ${d.peers.map((p) => `<tr>
        <td><div class="name" style="flex-wrap:nowrap"><span class="dot ${p.online ? "on" : ""}" title="${p.online ? "online" : "offline"}"></span>${esc(p.name)}
            <span class="badge">${esc(p.os || "?")}</span>${p.exit_node ? `<span class="badge green">exit node aktif</span>` : p.exit_option ? `<span class="badge blue">exit node</span>` : ""}
            ${p.tags.map((t) => `<span class="badge">${esc(t.replace("tag:", "#"))}</span>`).join("")}</div>
          <div class="muted small">${esc(p.dns)}${p.user ? ` · ${esc(p.user)}` : ""}</div></td>
        <td class="small">${tsCopy(tsIp4(p))}</td>
        <td class="small">${!p.online ? "-" : p.direct ? `<span class="badge green" title="${esc(p.direct)}">langsung</span>` : p.relay ? `<span class="badge amber">relay ${esc(p.relay)}</span>` : "-"}</td>
        <td class="small">${p.online ? "sekarang" : tsAgo(p.last_seen)}</td>
        <td class="small muted">${p.rx || p.tx ? `↓${fmtBytes(p.rx)} ↑${fmtBytes(p.tx)}` : "-"}</td>
        <td><div class="actions">
          ${running && p.online ? btn("Ping", "tsAct", { action: "ping", ip: tsIp4(p), job: 1 }) : ""}
          ${p.online ? btn("SSH", "tsSsh", { host: p.dns || tsIp4(p) }, "", `title="Buka ssh ${esc(p.dns)} di tab Terminal"`) : ""}
          ${running && p.exit_option && !p.exit_node ? btn("Pakai exit node", "tsAct", { action: "exit-node", ip: tsIp4(p), confirm: `Arahkan semua lalu lintas internet lewat ${p.name}?` }) : ""}
          ${p.exit_node ? btn("Lepas exit node", "tsAct", { action: "exit-node", ip: "" }) : ""}
        </div></td></tr>`).join("")}
    </table></div>`;
  },

  serveList(d) {
    if (d.state !== "Running") return `<div class="muted small">Hubungkan Tailscale untuk melihat & mengatur Serve.</div>`;
    return d.serve.map((s) => {
      const url = `https://${s.host}${s.port === 443 ? "" : ":" + s.port}${s.path === "/" ? "" : s.path}`;
      return `<div class="priv-row"><div><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>
          ${s.funnel ? `<span class="badge amber">Funnel · publik</span>` : `<span class="badge blue">tailnet saja</span>`}
          <div class="muted small">→ ${esc(s.target)}</div></div>
        <div class="actions">${btn("Matikan", "tsAct", { action: "serve-off", https: s.port, funnel: s.funnel ? 1 : "", confirm: `Berhenti membagikan ${url}?` }, "danger")}</div></div>`;
    }).join("") || `<div class="muted small">Belum ada port yang dibagikan.</div>`;
  },
  serve(d) {
    return `<h3>Serve & Funnel <span class="spacer"></span>
        ${d.serve.length ? btn("Reset semua", "tsAct", { action: "serve-reset", confirm: "Hapus semua konfigurasi Serve/Funnel?" }, "danger") : ""}</h3>
      <p class="muted small" style="margin-top:-6px">Bagikan app lokal (mis. Laravel di port 8000) lewat HTTPS:
        <b>Serve</b> hanya untuk perangkat di tailnet, <b>Funnel</b> terbuka ke internet.</p>
      <div id="tsServeList">${this.serveList(d)}</div>
      <div class="row" id="tsServeForm" style="margin-top:12px">
        <input id="tsPort" type="number" min="1" max="65535" placeholder="Port lokal, mis. 8000" style="width:170px">
        <select id="tsHttps" title="Port HTTPS di sisi Tailscale"><option>443</option><option>8443</option><option>10000</option></select>
        <label class="chk"><input type="checkbox" id="tsFunnel"> Funnel (publik)</label>
        ${btn("Bagikan", "tsServeAdd", {}, "primary", d.state === "Running" ? "" : "disabled")}
      </div>`;
  },
  side(d) {
    const accounts = d.accounts.length > 1 ? `<div class="card" style="margin-top:14px"><h3>Akun</h3>
      ${d.accounts.map((a) => `<div class="priv-row"><div><b>${esc(a.account)}</b> <span class="muted small">${esc(a.tailnet)}</span></div>
        <div class="actions">${a.current ? `<span class="badge green">aktif</span>` : btn("Ganti", "tsAct", { action: "switch", id: a.id, confirm: `Ganti ke akun ${a.account}?` })}</div></div>`).join("")}</div>` : "";
    return `<div class="card"><h3>Pengaturan</h3>
      ${Object.entries(d.settings).map(([flag, label]) => `<label class="priv-row" style="cursor:pointer">
        <span>${esc(label)}<div class="muted small"><code>--${esc(flag)}</code></div></span>
        <input type="checkbox" data-ts-flag="${esc(flag)}" ${d.prefs[flag] ? "checked" : ""}></label>`).join("")}
      <p class="muted small" style="margin-bottom:0">Sebagian pengaturan (exit node, subnet) juga perlu disetujui di admin console.</p></div>${accounts}`;
  },
};

handlers.tsAct = async (d) => {
  const body = { action: d.action, ip: d.ip, https: d.https ? +d.https : undefined, funnel: !!d.funnel, id: d.id };
  if (d.job) return runJob(api("/api/tailscale", body), () => current === tabs.tailscale && tabs.tailscale.load());
  await api("/api/tailscale", body);
  const msg = { down: "Tailscale diputus", "exit-node": d.ip ? "Exit node dipakai" : "Exit node dilepas", "serve-off": "Berhenti dibagikan",
    "serve-reset": "Konfigurasi Serve direset", switch: "Akun diganti", "open-app": "Aplikasi Tailscale dibuka" }[d.action];
  if (msg) toast(msg);
  tabs.tailscale.load();
};
handlers.tsServeAdd = async () => {
  const port = +$("tsPort").value;
  if (!port) return toast("Isi port lokal dulu", true);
  const funnel = $("tsFunnel").checked;
  if (funnel && !confirm(`Funnel membuka port ${port} ke INTERNET (siapa pun yang tahu URL-nya). Lanjutkan?`)) return;
  const r = await api("/api/tailscale", { action: funnel ? "funnel" : "serve", port, https: +$("tsHttps").value });
  toast(funnel ? "Funnel aktif" : "Serve aktif");
  if (r.output) showLog(`tailscale ${funnel ? "funnel" : "serve"}`, r.output);
  $("tsPort").value = "";
  tabs.tailscale.load();
};
handlers.tsCopy = async (d) => { await navigator.clipboard.writeText(d.text); toast(`Disalin: ${d.text}`); };
handlers.tsSsh = (d) => window.runInTerminal(`ssh ${d.host}`);
handlers.tsInstall = () => runJob(api("/api/apps/action", { name: "tailscale-app", type: "cask", action: "install" }), () => current.load());

// toggle pengaturan (checkbox, bukan tombol → tidak lewat data-act)
document.addEventListener("change", async (e) => {
  const flag = e.target.dataset?.tsFlag;
  if (!flag) return;
  const el = e.target;
  el.disabled = true;
  try {
    await api("/api/tailscale", { action: "set", flag, value: el.checked });
    toast(`${tabs.tailscale.data.settings[flag]}: ${el.checked ? "aktif" : "mati"}`);
  } catch (err) { el.checked = !el.checked; toast(err.message, true); }
  finally { el.disabled = false; }
});

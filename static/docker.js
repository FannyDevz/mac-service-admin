// Docker: ringkasan & statistik live, container (+ detail, console, terminal),
// compose (daftar, edit, pembuat compose), image, volume, network, remote host.

const DK_TABS = [["", "Ringkasan"], ["containers", "Container"], ["compose", "Compose"], ["images", "Image"],
  ["volumes", "Volume"], ["networks", "Network"], ["remote", "Remote host"]];

const COMPOSE_TEMPLATES = [
  { key: "mysql", name: "MySQL", logo: "mysql", image: "mysql:8.4", ports: ["3306:3306"], env: { MYSQL_ROOT_PASSWORD: "secret", MYSQL_DATABASE: "app" }, volume: "/var/lib/mysql" },
  { key: "mariadb", name: "MariaDB", logo: "mariadb", image: "mariadb:11", ports: ["3306:3306"], env: { MARIADB_ROOT_PASSWORD: "secret", MARIADB_DATABASE: "app" }, volume: "/var/lib/mysql" },
  { key: "postgres", name: "PostgreSQL", logo: "postgresql", image: "postgres:17-alpine", ports: ["5432:5432"], env: { POSTGRES_PASSWORD: "secret", POSTGRES_DB: "app" }, volume: "/var/lib/postgresql/data" },
  { key: "redis", name: "Redis", logo: "redis", image: "redis:7-alpine", ports: ["6379:6379"], env: {}, volume: "/data" },
  { key: "mongo", name: "MongoDB", logo: "mongodb", image: "mongo:8", ports: ["27017:27017"], env: { MONGO_INITDB_ROOT_USERNAME: "root", MONGO_INITDB_ROOT_PASSWORD: "secret" }, volume: "/data/db" },
  { key: "mailpit", name: "Mailpit", logo: "", image: "axllent/mailpit", ports: ["8025:8025", "1025:1025"], env: {}, volume: null },
  { key: "minio", name: "MinIO", logo: "minio", image: "minio/minio", ports: ["9000:9000", "9001:9001"], env: { MINIO_ROOT_USER: "minio", MINIO_ROOT_PASSWORD: "minio12345" }, volume: "/data", command: 'server /data --console-address ":9001"' },
  { key: "meilisearch", name: "Meilisearch", logo: "meilisearch", image: "getmeili/meilisearch:latest", ports: ["7700:7700"], env: { MEILI_MASTER_KEY: "masterKey" }, volume: "/meili_data" },
  { key: "rabbitmq", name: "RabbitMQ", logo: "rabbitmq", image: "rabbitmq:4-management-alpine", ports: ["5672:5672", "15672:15672"], env: {}, volume: "/var/lib/rabbitmq" },
  { key: "memcached", name: "Memcached", logo: "", image: "memcached:alpine", ports: ["11211:11211"], env: {}, volume: null },
  { key: "phpmyadmin", name: "phpMyAdmin", logo: "", image: "phpmyadmin", ports: ["8080:80"], env: { PMA_HOST: "mysql" }, volume: null, depends: ["mysql", "mariadb"] },
  { key: "adminer", name: "Adminer", logo: "", image: "adminer", ports: ["8081:8080"], env: {}, volume: null },
  { key: "nginx", name: "Nginx", logo: "nginx", image: "nginx:alpine", ports: ["8088:80"], env: {}, bind: "./public:/usr/share/nginx/html:ro" },
  { key: "node", name: "Node.js app", logo: "node", image: "node:22-alpine", ports: ["3000:3000"], env: { NODE_ENV: "development" }, bind: "./:/app", workdir: "/app", command: "sh -c \"npm install && npm run dev\"" },
  { key: "php", name: "PHP / Laravel app", logo: "php", image: "serversideup/php:8.4-fpm-nginx", ports: ["8000:8080"], env: { PHP_OPCACHE_ENABLE: "0" }, bind: "./:/var/www/html" },
  { key: "ollama", name: "Ollama", logo: "ollama", image: "ollama/ollama", ports: ["11434:11434"], env: {}, volume: "/root/.ollama" },
];

const dkState = (s) => s === "running" ? "on" : s === "paused" || s === "restarting" ? "mid" : s === "dead" ? "bad" : "";
const dkPortLinks = (ports) => (ports || "").split(", ").filter(Boolean).map((p) => {
  const m = /:(\d+)->/.exec(p);
  return m ? `<a href="http://localhost:${m[1]}" target="_blank" rel="noopener"><code>${esc(p.replace(/^0\.0\.0\.0:|^\[::\]:/, ""))}</code></a>` : `<code>${esc(p)}</code>`;
}).filter((v, i, a) => a.indexOf(v) === i).join(" ");

tabs.docker = {
  interval: 4000,
  hist: [],
  prevStats: null,
  async load(silent) {
    const [sub, ...rest] = (this.param || "").split(":");
    this.sub = sub;
    if (silent && !["", "containers", "compose"].includes(sub)) return;  // auto-refresh hanya untuk halaman status
    let d;
    try { d = await api("/api/docker"); } catch (e) { return silent || failView(e); }
    this.data = d;
    const e = d.engine;
    if (!e.cli) { view.innerHTML = `<div class="warn">Docker CLI tidak ditemukan. Install OrbStack atau Docker Desktop.</div>`; return; }
    if (!silent || !$("dkBody")) {
      view.innerHTML = `<div id="dkEngine"></div>
        <div class="pills" style="margin:14px 0" id="dkNav">${DK_TABS.map(([k, l]) =>
          `<a class="pill-link ${k === sub || (sub === "container" && k === "containers") || (sub === "new-compose" && k === "compose") ? "active" : ""}" href="#docker${k ? ":" + k : ""}">${l}</a>`).join("")}</div>
        <div id="dkBody"><div class="loading">Memuat…</div></div>`;
    }
    this.renderEngine(e);
    if (!e.running) {
      $("headline").textContent = "Docker mati";
      $("dkBody").innerHTML = sub === "remote" ? "" : `<div class="empty">Docker engine belum berjalan. Klik <b>Start engine</b> di atas.</div>`;
      if (sub === "remote") await this.remote();
      return;
    }
    const cs = d.containers;
    $("headline").textContent = `${cs.filter((c) => c.state === "running").length}/${cs.length} container berjalan · ${esc(e.name || "")}`;
    const page = { "": "summary", containers: "containers", container: "container", compose: "compose", "new-compose": "builder",
      images: "images", volumes: "volumes", networks: "networks", remote: "remote" }[sub] || "summary";
    await this[page](silent, rest.join(":"));
  },
  leave() { $("tip").style.display = "none"; },

  renderEngine(e) {
    $("dkEngine").innerHTML = `<div class="card item">
      <div class="row" style="flex-wrap:nowrap;gap:12px">${logoSvg("docker", "pkg-logo")}
        <div><div class="name"><span class="dot ${e.running ? "on" : ""}"></span>Docker engine ${e.orbstack ? `<span class="badge blue">OrbStack</span>` : ""}
          <span class="badge">${e.running ? "berjalan" : "mati"}</span></div>
        ${e.running ? `<div class="meta"><span>v${esc(e.version)}</span><span>Compose ${esc(e.compose)}</span><span>${e.cpus} CPU</span>
          <span>RAM ${fmtBytes(e.memory)}</span><span>${esc(e.os)} · ${esc(e.driver)}</span><span>context <b>${esc(e.name)}</b></span></div>` : ""}</div></div>
      <div class="actions">
        ${btn("＋ Buat container", "dkRunDlg", {}, "primary")}
        ${e.orbstack ? (e.running ? btn("Stop engine", "dk", { action: "engine-stop", confirm: "Matikan OrbStack? Semua container akan berhenti." }, "danger")
          : btn("Start engine", "dk", { action: "engine-start" }, "go")) : ""}</div></div>`;
  },

  // ---------------------------------------------------------- ringkasan & statistik
  async summary(silent) {
    let st;
    try { st = await api("/api/docker/stats"); } catch { st = { t: Date.now(), stats: [] }; }
    const prev = this.prevStats, dt = prev ? (st.t - prev.t) / 1000 : 0;
    const rate = (s, k) => { const p = prev?.stats.find((x) => x.id === s.id); return p && dt > 0 ? Math.max(0, (s[k] - p[k]) / dt) : 0; };
    st.stats.forEach((s) => { s.rx_rate = rate(s, "net_rx"); s.tx_rate = rate(s, "net_tx"); });
    this.prevStats = st;
    const sum = (k) => st.stats.reduce((a, s) => a + (s[k] || 0), 0);
    this.hist.push({ t: st.t, cpu: sum("cpu"), mem: sum("mem"), rx: sum("rx_rate"), tx: sum("tx_rate") });
    this.hist = this.hist.filter((h) => h.t > Date.now() - WINDOW_MS);
    const e = this.data.engine, cs = this.data.containers, last = this.hist.at(-1);
    if (!silent || !$("dkKpi")) {
      $("dkBody").innerHTML = `
        <div class="grid kpis" id="dkKpi"></div>
        <div class="grid two">
          <div class="card"><h3>CPU semua container <span class="spacer"></span><span class="muted small">100% = 1 core</span></h3><div class="chart" id="dkCpu"></div></div>
          <div class="card"><h3>Jaringan</h3><div class="chart" id="dkNet"></div>
            <div class="legend"><span><i style="background:var(--series-1)"></i>Download</span><span><i style="background:var(--series-2)"></i>Upload</span></div></div>
        </div>
        <h2>Container berjalan</h2><div id="dkStats"></div>
        <h2 class="row">Pemakaian disk Docker <span class="spacer"></span>
          ${btn("Bersihkan build cache", "dk", { action: "builder-prune", confirm: "Hapus build cache?" })}
          ${btn("System prune", "dk", { action: "system-prune", confirm: "Hapus semua container berhenti, network tak terpakai, image dangling, dan build cache?" }, "danger")}</h2>
        <div id="dkDisk"><div class="loading">Menghitung…</div></div>`;
      this.diskCard();
    }
    const running = cs.filter((c) => c.state === "running").length;
    $("dkKpi").innerHTML = [
      ["Container", `${running}<small>/${cs.length}</small>`, `${this.data.projects.length} project compose`],
      ["CPU total", `${last.cpu.toFixed(1)}<small>%</small>`, `dari ${e.cpus * 100}% (${e.cpus} core)`],
      ["Memori", `${fmtBytes(last.mem)}`, `dari ${fmtBytes(e.memory)} jatah VM`],
      ["Jaringan", `${fmtRate(last.rx)}`, `upload ${fmtRate(last.tx)}`],
    ].map(([l, v, s]) => `<div class="card kpi"><div class="label"><span>${l}</span></div><div class="value" style="font-size:24px">${v}</div><div class="sub">${s}</div></div>`).join("");
    const times = this.hist.map((h) => h.t);
    lineChart($("dkCpu"), { times, series: [{ label: "CPU", color: "var(--series-1)", values: this.hist.map((h) => h.cpu) }], height: 150, area: true,
      fmt: (v, ax) => v == null ? "-" : ax ? `${Math.round(v)}%` : `${v.toFixed(1)}%`, floor: 10 });
    lineChart($("dkNet"), { times, series: [{ label: "Download", color: "var(--series-1)", values: this.hist.map((h) => h.rx) },
      { label: "Upload", color: "var(--series-2)", values: this.hist.map((h) => h.tx) }], height: 150,
      fmt: (v, ax) => v == null ? "-" : ax ? fmtBytes(v, 0) : fmtRate(v), floor: 10240, bytes: true });
    $("dkStats").innerHTML = st.stats.length ? `<div class="table-wrap"><table>
      <tr><th>Container</th><th>CPU</th><th>Memori</th><th class="num">Net ↓/↑</th><th class="num">Disk baca/tulis</th><th class="num">PID</th></tr>
      ${st.stats.sort((a, b) => b.cpu - a.cpu).map((s) => `<tr>
        <td><a href="#docker:container:${s.id}"><b>${esc(s.name)}</b></a></td>
        <td style="min-width:140px"><div class="row" style="gap:8px;flex-wrap:nowrap"><div class="meter" style="flex:1"><div style="width:${Math.min(100, s.cpu / e.cpus)}%"></div></div><span class="small">${s.cpu.toFixed(1)}%</span></div></td>
        <td style="min-width:160px"><div class="row" style="gap:8px;flex-wrap:nowrap"><div class="meter" style="flex:1"><div style="width:${s.mem_pct}%"></div></div><span class="small">${fmtBytes(s.mem)}</span></div></td>
        <td class="num small">${fmtRate(s.rx_rate)} / ${fmtRate(s.tx_rate)}</td>
        <td class="num small">${fmtBytes(s.blk_r)} / ${fmtBytes(s.blk_w)}</td><td class="num small">${s.pids}</td></tr>`).join("")}
      </table></div>` : `<div class="empty">Tidak ada container yang berjalan.</div>`;
  },
  async diskCard() {
    let d;
    try { d = await api("/api/docker/disk"); } catch (e) { $("dkDisk").innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    this.disk = d;
    const total = d.summary.reduce((a, s) => a + s.size, 0) || 1;
    const colors = ["--series-1", "--series-2", "--series-3", "--series-4"];
    $("dkDisk").innerHTML = `<div class="card">
      <div class="meter" style="height:12px">${d.summary.map((s, i) => `<div style="width:${(100 * s.size) / total}%;background:var(${colors[i]})" title="${s.type}: ${fmtBytes(s.size)}"></div>`).join("")}</div>
      <div class="legend">${d.summary.map((s, i) => `<span><i style="background:var(${colors[i]})"></i>${esc(s.type)} <b>${fmtBytes(s.size)}</b>
        <span class="muted">(${s.count}, bisa dibersihkan ${fmtBytes(s.reclaimable)})</span></span>`).join("")}</div></div>`;
  },

  // ---------------------------------------------------------- container
  async containers() {
    const cs = this.data.containers;
    const row = (c) => {
      const on = c.state === "running", d = { target: c.id };
      return `<div class="card item">
        <div><div class="name"><span class="dot ${dkState(c.state)}"></span><a href="#docker:container:${c.id}" style="color:inherit">${esc(c.name)}</a>
            <span class="badge">${esc(c.state)}</span>${c.health ? `<span class="badge ${c.health === "healthy" ? "green" : "amber"}">${c.health}</span>` : ""}
            ${c.project ? `<span class="badge blue">${esc(c.project)}</span>` : ""}</div>
          <div class="meta"><span><code>${esc(c.image)}</code></span><span>${esc(c.status)}</span>${c.ports ? `<span>${dkPortLinks(c.ports)}</span>` : ""}</div></div>
        <div class="actions">
          ${on ? btn("Stop", "dk", { ...d, action: "stop" }, "danger") + btn("Restart", "dk", { ...d, action: "restart" }) + btn("Pause", "dk", { ...d, action: "pause" })
               : c.state === "paused" ? btn("Lanjutkan", "dk", { ...d, action: "unpause" }, "go") : btn("Start", "dk", { ...d, action: "start" }, "go")}
          ${on ? btn("Terminal", "dkTerm", { id: c.id }) : ""}
          <a class="btn-link" href="#docker:container:${c.id}">Detail →</a>
          ${btn("Hapus", "dk", { ...d, action: "rm", confirm: `Hapus container ${c.name}?` }, "danger")}</div></div>`;
    };
    $("dkBody").innerHTML = `<div class="row" style="margin-bottom:10px"><span class="spacer"></span>
        ${btn("Hapus semua yang berhenti", "dk", { action: "container-prune", confirm: "Hapus semua container yang berhenti?" })}</div>
      <div class="list">${cs.map(row).join("") || `<div class="empty">Belum ada container.</div>`}</div>`;
  },

  async container(silent, id) {
    if (silent) return;
    let c;
    try { c = await api(`/api/docker/inspect?id=${encodeURIComponent(id)}`); } catch (e) { $("dkBody").innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    const on = c.state.Status === "running", d = { target: c.id };
    $("headline").textContent = c.name;
    $("dkBody").innerHTML = `
      <p style="margin:0 0 12px"><a href="#docker:containers">← Container</a></p>
      <div class="card item" style="margin-bottom:14px">
        <div><div class="name"><span class="dot ${dkState(c.state.Status)}"></span>${esc(c.name)} <span class="badge">${esc(c.state.Status)}</span>
          ${c.health ? `<span class="badge ${c.health === "healthy" ? "green" : "amber"}">${esc(c.health)}</span>` : ""}</div>
          <div class="meta"><span><code>${esc(c.image)}</code></span><span>ID <code>${esc(c.id)}</code></span><span>restart: ${esc(c.restart || "no")}</span></div></div>
        <div class="actions">${on ? btn("Stop", "dk", { ...d, action: "stop" }, "danger") + btn("Restart", "dk", { ...d, action: "restart" })
          : btn("Start", "dk", { ...d, action: "start" }, "go")}
          ${btn("Hapus", "dk", { ...d, action: "rm", confirm: `Hapus container ${c.name}?`, back: 1 }, "danger")}</div></div>
      <div class="card" style="margin-bottom:14px">
        <h3>🖥️ Console <span class="muted small">jalankan perintah di dalam container</span><span class="spacer"></span>
          ${on ? btn("Terminal interaktif (sh)", "dkTerm", { id: c.id }) + btn("bash", "dkTerm", { id: c.id, shell: "bash" }) : ""}</h3>
        ${on ? `<pre class="console" id="dkOut">Ketik perintah lalu Enter. Contoh: ls -la, php artisan migrate, env\n</pre>
          <form class="row console-in" id="dkExec"><span class="muted small" id="dkPwd">${esc(c.workdir || "/")}</span><code>$</code>
            <input name="cmd" autocomplete="off" spellcheck="false" style="flex:1" placeholder="perintah…"><button class="primary">Jalankan</button></form>`
          : `<div class="muted small">Container tidak berjalan. Start dulu untuk memakai console.</div>`}</div>
      <div class="grid two">
        <div class="card"><h3>Info</h3><dl class="kv">
          <dt>Perintah</dt><dd><code>${esc(c.command)}</code></dd><dt>Folder kerja</dt><dd><code>${esc(c.workdir || "/")}</code></dd>
          <dt>Dibuat</dt><dd>${esc(new Date(c.created).toLocaleString("id-ID"))}</dd>
          <dt>Port</dt><dd>${c.ports.map((p) => p.host ? `<a href="http://localhost:${esc(String(p.host).split(":").pop())}" target="_blank" rel="noopener"><code>${esc(p.host)}</code></a> → <code>${esc(p.container)}</code>` : `<code>${esc(p.container)}</code>`).join("<br>") || "-"}</dd>
          <dt>Network</dt><dd>${c.networks.map((n) => `${esc(n.name)} <span class="muted small">${esc(n.ip || "")}</span>`).join("<br>") || "-"}</dd></dl></div>
        <div class="card"><h3>Mount</h3>${c.mounts.map((m) => `<div class="issue" style="cursor:default"><span class="badge">${esc(m.type)}</span>
            <code>${esc(m.source)}</code> → <code>${esc(m.dest)}</code> ${m.rw ? "" : `<span class="badge">read-only</span>`}</div>`).join("") || `<div class="muted small">Tidak ada.</div>`}</div>
      </div>
      <h2>Environment <span class="muted small">nilai rahasia disamarkan — klik untuk melihat</span></h2>
      <div class="table-wrap"><table>${c.env.map((v) => `<tr><td><code>${esc(v.key)}</code></td>
        <td>${v.secret && v.value ? `<code class="secret" data-act="dkReveal" data-v="${esc(v.value)}">••••••••</code>` : `<code>${esc(v.value)}</code>`}</td></tr>`).join("")}</table></div>
      <h2 class="row">Log <span class="spacer"></span><label class="chk"><input type="checkbox" id="dkFollow"> refresh otomatis</label>${btn("Muat ulang", "dkLogs", { id: c.id })}</h2>
      <pre class="card console" id="dkLog" style="max-height:420px">Memuat…</pre>`;
    this.loadLogs(c.id);
    clearInterval(this.logTimer);
    this.logTimer = setInterval(() => { if (current === this && $("dkFollow")?.checked) this.loadLogs(c.id); }, 3000);
    if (on) this.bindConsole(c);
  },
  async loadLogs(id) {
    const r = await api(`/api/docker/logs?id=${encodeURIComponent(id)}&tail=400`);
    const el = $("dkLog");
    if (!el) return;
    const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    el.textContent = r.log || "(kosong)";
    if (atEnd) el.scrollTop = el.scrollHeight;
  },
  bindConsole(c) {
    const hist = [];
    let hi = 0, pwd = c.workdir || "";
    const input = $("dkExec").elements.cmd;
    input.focus();
    input.onkeydown = (e) => {
      if (e.key === "ArrowUp" && hist.length) { hi = Math.max(0, hi - 1); input.value = hist[hi]; e.preventDefault(); }
      if (e.key === "ArrowDown" && hist.length) { hi = Math.min(hist.length, hi + 1); input.value = hist[hi] || ""; e.preventDefault(); }
    };
    $("dkExec").onsubmit = async (e) => {
      e.preventDefault();
      const cmd = input.value.trim();
      if (!cmd) return;
      if (cmd === "clear") { $("dkOut").textContent = ""; input.value = ""; return; }
      hist.push(cmd); hi = hist.length; input.value = "";
      const out = $("dkOut");
      out.textContent += `\n${pwd || "/"} $ ${cmd}\n`;
      try {
        const r = await api("/api/docker/exec", { id: c.id, command: cmd, workdir: pwd });
        out.textContent += r.output + (r.code ? `\n[exit ${r.code}]` : "");
        if (r.pwd) { pwd = r.pwd; $("dkPwd").textContent = pwd; }
      } catch (err) { out.textContent += `ERROR: ${err.message}\n`; }
      out.scrollTop = out.scrollHeight;
    };
  },

  // ---------------------------------------------------------- compose
  async compose(silent) {
    const ps = this.data.projects, cs = this.data.containers;
    if (silent && $("dkComposeEditor")?.dataset.open) return;  // jangan ganggu editor
    $("dkBody").innerHTML = `<div class="row" style="margin-bottom:10px"><span class="muted small">Project compose yang pernah dijalankan di mesin ini.</span>
        <span class="spacer"></span><a class="btn-link primary-link" href="#docker:new-compose">＋ Buat compose baru</a></div>
      <div class="list">${ps.map((p) => {
        const list = cs.filter((c) => c.project === p.name), up = list.filter((c) => c.state === "running").length;
        const d = { target: p.name, files: JSON.stringify(p.files) };
        return `<div class="card">
          <div class="item"><div><div class="name">📦 ${esc(p.name)} <span class="badge ${up ? "green" : ""}">${up}/${list.length} berjalan</span></div>
            <div class="meta"><code>${esc(p.files.join(", "))}</code></div></div>
          <div class="actions">
            ${btn("Up", "dkCompose", { ...d, action: "compose-up" }, "go")}
            ${up ? btn("Restart", "dkCompose", { ...d, action: "compose-restart" }) + btn("Stop", "dkCompose", { ...d, action: "compose-stop" }, "danger") : ""}
            ${btn("Pull", "dkCompose", { ...d, action: "compose-pull" })}${btn("Build & up", "dkCompose", { ...d, action: "compose-up-build" })}
            ${btn("Log", "dkProjLog", { name: p.name })}${btn("Edit file", "dkComposeEdit", { path: p.files[0], name: p.name })}
            ${btn("Down", "dkCompose", { ...d, action: "compose-down", confirm: `docker compose down untuk ${p.name}? Container dihapus (volume tetap).` }, "danger")}
          </div></div>
          ${list.length ? `<div class="list" style="margin-top:10px">${list.map((c) => `<div class="row" style="padding:4px 0;border-top:1px solid var(--border)">
            <span class="dot ${dkState(c.state)}"></span><a href="#docker:container:${c.id}"><b>${esc(c.service || c.name)}</b></a>
            <span class="muted small"><code>${esc(c.image)}</code> · ${esc(c.status)}</span><span class="spacer"></span>${dkPortLinks(c.ports)}</div>`).join("")}</div>` : ""}
        </div>`;
      }).join("") || `<div class="empty">Belum ada project compose.</div>`}</div>
      <div id="dkComposeEditor"></div>`;
  },

  // ---------------------------------------------------------- pembuat compose
  async builder(silent) {
    if (silent) return;
    const b = this.bld ??= { project: "", dir: "~/docker", selected: {}, manual: false };
    $("dkBody").innerHTML = `
      <p style="margin:0 0 12px"><a href="#docker:compose">← Compose</a></p>
      <div class="grid two" style="align-items:start">
        <div class="list">
          <div class="card"><h3>1. Project</h3>
            <div class="field"><label>Nama project</label><input id="bName" value="${esc(b.project)}" placeholder="myapp-services"></div>
            <div class="field" style="margin-top:8px"><label>Lokasi</label><div class="row"><input id="bDir" value="${esc(b.dir)}" style="flex:1">${btn("📁 Pilih…", "bPick")}</div>
              <small class="muted" id="bPath"></small></div></div>
          <div class="card"><h3>2. Pilih service</h3><div class="grid cat-grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">
            ${COMPOSE_TEMPLATES.map((t) => `<label class="choice-item"><input type="checkbox" data-tpl="${t.key}" ${b.selected[t.key] ? "checked" : ""}>
              ${t.logo ? logoSvg(t.logo, "tpl-logo") : `<span class="tpl-logo"></span>`}<span><b>${esc(t.name)}</b><small>${esc(t.image)}</small></span></label>`).join("")}</div></div>
          <div id="bCfg"></div>
        </div>
        <div class="card" style="position:sticky;top:84px">
          <h3>3. compose.yaml <span class="spacer"></span><label class="chk"><input type="checkbox" id="bManual" ${b.manual ? "checked" : ""}> edit manual</label></h3>
          <div id="bWarn"></div>
          <textarea class="editor" id="bYaml" spellcheck="false" style="min-height:52vh" ${b.manual ? "" : "readonly"}></textarea>
          <pre id="bOut" style="display:none"></pre>
          <div class="row" style="margin-top:10px"><label class="chk"><input type="checkbox" id="bOverwrite"> timpa jika sudah ada</label><span class="spacer"></span>
            ${btn("Validasi", "bValidate")}${btn("Simpan", "bSave")}${btn("Simpan & jalankan", "bSave", { up: 1 }, "go")}</div>
        </div>
      </div>`;
    const sync = () => this.syncBuilder();
    $("bName").oninput = sync; $("bDir").oninput = sync;
    $("dkBody").querySelectorAll("[data-tpl]").forEach((cb) => (cb.onchange = () => {
      const t = COMPOSE_TEMPLATES.find((x) => x.key === cb.dataset.tpl);
      if (cb.checked) b.selected[t.key] = { image: t.image, ports: [...t.ports], env: Object.entries(t.env).map(([k, v]) => `${k}=${v}`).join("\n"), volume: !!(t.volume || t.bind) };
      else delete b.selected[t.key];
      this.renderCfg(); sync();
    }));
    $("bManual").onchange = (e) => { b.manual = e.target.checked; $("bYaml").readOnly = !b.manual; if (!b.manual) sync(); };
    this.renderCfg();
    sync();
  },
  renderCfg() {
    const b = this.bld;
    $("bCfg").innerHTML = Object.entries(b.selected).map(([k, s]) => {
      const t = COMPOSE_TEMPLATES.find((x) => x.key === k);
      return `<div class="card"><h3>${t.logo ? logoSvg(t.logo, "tpl-logo") : ""}${esc(t.name)} <span class="muted small">service <code>${k}</code></span></h3>
        <div class="grid two"><div class="field"><label>Image</label><input data-k="${k}" data-f="image" value="${esc(s.image)}"></div>
          <div class="field"><label>Port (host:container, pisahkan koma)</label><input data-k="${k}" data-f="ports" value="${esc(s.ports.join(", "))}"></div></div>
        ${t.volume || t.bind ? `<label class="chk" style="margin:8px 0"><input type="checkbox" data-k="${k}" data-f="volume" ${s.volume ? "checked" : ""}>
          ${t.volume ? `Simpan data di volume <code>${k}-data</code>` : `Mount folder <code>${esc(t.bind)}</code>`}</label>` : ""}
        <div class="field"><label>Environment (KEY=VALUE per baris)</label><textarea data-k="${k}" data-f="env" rows="${Math.max(2, s.env.split("\n").length)}" class="editor" style="min-height:0">${esc(s.env)}</textarea></div></div>`;
    }).join("");
    $("bCfg").querySelectorAll("[data-f]").forEach((el) => (el.oninput = el.onchange = () => {
      const s = b.selected[el.dataset.k];
      if (el.dataset.f === "ports") s.ports = el.value.split(",").map((p) => p.trim()).filter(Boolean);
      else if (el.dataset.f === "volume") s.volume = el.checked;
      else s[el.dataset.f] = el.value;
      this.syncBuilder();
    }));
  },
  yaml() {
    const q = (v) => JSON.stringify(String(v));
    const b = this.bld, vols = [];
    let y = "services:\n";
    for (const [k, s] of Object.entries(b.selected)) {
      const t = COMPOSE_TEMPLATES.find((x) => x.key === k);
      y += `  ${k}:\n    image: ${q(s.image)}\n    restart: unless-stopped\n`;
      if (s.ports.length) y += `    ports:\n${s.ports.map((p) => `      - ${q(p)}`).join("\n")}\n`;
      const env = s.env.split("\n").map((l) => l.trim()).filter((l) => l.includes("="));
      if (env.length) y += `    environment:\n${env.map((l) => { const i = l.indexOf("="); return `      ${l.slice(0, i).trim()}: ${q(l.slice(i + 1))}`; }).join("\n")}\n`;
      if (s.volume && t.volume) { y += `    volumes:\n      - ${q(`${k}-data:${t.volume}`)}\n`; vols.push(`${k}-data`); }
      if (s.volume && t.bind) y += `    volumes:\n      - ${q(t.bind)}\n`;
      if (t.workdir) y += `    working_dir: ${q(t.workdir)}\n`;
      if (t.command) y += `    command: ${t.command.startsWith("sh -c") ? q(t.command) : q(t.command)}\n`;
      const deps = (t.depends || []).filter((d) => b.selected[d]);
      if (deps.length) y += `    depends_on:\n${deps.map((d) => `      - ${d}`).join("\n")}\n`;
      if (t.depends && deps.length && s.env.includes("PMA_HOST=mysql") && !b.selected.mysql) y = y.replace('PMA_HOST: "mysql"', `PMA_HOST: "${deps[0]}"`);
    }
    if (vols.length) y += `\nvolumes:\n${vols.map((v) => `  ${v}:`).join("\n")}\n`;
    return Object.keys(b.selected).length ? y : "# Pilih minimal satu service di sebelah kiri\n";
  },
  async syncBuilder() {
    const b = this.bld;
    b.project = $("bName").value.trim(); b.dir = $("bDir").value.trim();
    $("bPath").innerHTML = b.project ? `→ <code>${esc(b.dir.replace(/\/$/, ""))}/${esc(b.project)}/compose.yaml</code>` : "";
    if (!b.manual) $("bYaml").value = this.yaml();
    // cek port host yang bentrok dengan proses lain (mis. MySQL Homebrew di 3306)
    const hostPorts = Object.values(b.selected).flatMap((s) => s.ports.map((p) => p.split(":").length > 1 ? p.split(":").at(-2) : null)).filter(Boolean);
    clearTimeout(this.portT);
    this.portT = setTimeout(async () => {
      const dup = hostPorts.filter((p, i) => hostPorts.indexOf(p) !== i);
      const { used } = hostPorts.length ? await api(`/api/docker/ports?ports=${hostPorts.join(",")}`) : { used: {} };
      $("bWarn").innerHTML = [...Object.entries(used).map(([p, proc]) => `⚠️ Port <b>${p}</b> sudah dipakai <code>${esc(proc)}</code> — ganti port host, mis. <b>${+p + 1}</b>.`),
        ...[...new Set(dup)].map((p) => `⚠️ Port <b>${p}</b> dipakai dua service.`)].map((w) => `<div class="warn">${w}</div>`).join("");
    }, 300);
  },

  // ---------------------------------------------------------- image, volume, network
  async images(silent) {
    if (silent) return;
    const d = this.disk = await api("/api/docker/disk");
    $("dkBody").innerHTML = `
      <form class="row" id="dkPull" style="margin-bottom:12px"><input name="image" placeholder="mis. redis:7-alpine, nginx, postgres:17" style="flex:1;max-width:360px"><button class="go">Pull image</button>
        <span class="spacer"></span>${btn("Hapus image dangling", "dk", { action: "image-prune" })}
        ${btn("Hapus semua image tak terpakai", "dk", { action: "image-prune-all", confirm: "Hapus SEMUA image yang tidak dipakai container?" }, "danger")}</form>
      <div class="table-wrap"><table><tr><th>Image</th><th class="num">Ukuran</th><th class="num">Dipakai</th><th>Dibuat</th><th></th></tr>
      ${d.images.sort((a, b) => b.size - a.size).map((i) => { const ref = i.repo === "<none>" ? i.id : `${i.repo}:${i.tag}`; return `<tr>
        <td><code>${esc(i.repo)}</code><span class="muted">:${esc(i.tag)}</span><div class="muted small">${esc(i.id)}</div></td>
        <td class="num">${fmtBytes(i.size)}</td><td class="num">${i.containers ? `<span class="badge green">${i.containers} container</span>` : `<span class="muted">–</span>`}</td>
        <td class="small muted">${esc(i.created)}</td>
        <td><div class="actions">${btn("Jalankan…", "dkRunDlg", { image: ref })}${btn("Pull ulang", "dk", { action: "image-pull", target: ref })}
          ${btn("Hapus", "dk", { action: "image-rm", target: ref, confirm: `Hapus image ${ref}?` }, "danger")}</div></td></tr>`; }).join("")}
      </table></div>`;
    $("dkPull").onsubmit = (e) => { e.preventDefault(); const v = e.target.elements.image.value.trim(); if (v) handlers.dk({ action: "image-pull", target: v }); };
  },
  async volumes(silent) {
    if (silent) return;
    const d = await api("/api/docker/disk");
    $("dkBody").innerHTML = `<div class="row" style="margin-bottom:12px"><span class="muted small">Volume menyimpan data (database, cache). Menghapus volume = data hilang.</span><span class="spacer"></span>
        ${btn("Hapus volume tak terpakai", "dk", { action: "volume-prune", confirm: "Hapus semua volume yang tidak dipakai container? DATA DI DALAMNYA HILANG." }, "danger")}</div>
      <div class="table-wrap"><table><tr><th>Volume</th><th>Project</th><th class="num">Ukuran</th><th class="num">Dipakai</th><th></th></tr>
      ${d.volumes.sort((a, b) => b.size - a.size).map((v) => `<tr><td><code>${esc(v.name)}</code></td><td>${v.project ? `<span class="badge blue">${esc(v.project)}</span>` : "–"}</td>
        <td class="num">${fmtBytes(v.size)}</td><td class="num">${v.links ? `<span class="badge green">${v.links}</span>` : "–"}</td>
        <td><div class="actions">${btn("Hapus", "dk", { action: "volume-rm", target: v.name, confirm: `Hapus volume ${v.name}? Datanya hilang permanen.` }, "danger")}</div></td></tr>`).join("")}
      </table></div>`;
  },
  async networks(silent) {
    if (silent) return;
    const { networks } = await api("/api/docker/networks");
    $("dkBody").innerHTML = `<div class="row" style="margin-bottom:12px"><span class="spacer"></span>${btn("Hapus network tak terpakai", "dk", { action: "network-prune" })}</div>
      <div class="table-wrap"><table><tr><th>Network</th><th>Driver</th><th>Project</th><th></th></tr>
      ${networks.map((n) => `<tr><td><code>${esc(n.name)}</code> ${n.builtin ? `<span class="badge">bawaan</span>` : ""}</td><td>${esc(n.driver)}</td>
        <td>${n.project ? `<span class="badge blue">${esc(n.project)}</span>` : "–"}</td>
        <td><div class="actions">${n.builtin ? "" : btn("Hapus", "dk", { action: "network-rm", target: n.name, confirm: `Hapus network ${n.name}?` }, "danger")}</div></td></tr>`).join("")}
      </table></div>`;
  },

  // ---------------------------------------------------------- remote (docker context)
  async remote() {
    const { contexts } = await api("/api/docker/contexts");
    $("dkBody").innerHTML = `
      <p class="muted small" style="margin-top:0">Kelola Docker di server lain lewat SSH. Setelah context dipilih, <b>semua</b> halaman Docker di sini
        mengelola server tersebut. Syarat: login SSH dengan key tanpa password (lihat File konfigurasi → SSH) dan Docker terinstall di server.</p>
      <div class="list">${contexts.map((c) => `<div class="card item">
        <div><div class="name">${c.current ? `<span class="dot on"></span>` : `<span class="dot"></span>`}${esc(c.name)}
          ${c.current ? `<span class="badge green">aktif</span>` : ""}</div>
          <div class="meta"><code>${esc(c.endpoint)}</code><span>${esc(c.description)}</span>${c.error ? `<span style="color:var(--red)">${esc(c.error)}</span>` : ""}</div></div>
        <div class="actions">${btn("Tes koneksi", "dkCtx", { action: "test", name: c.name })}
          ${c.current ? "" : btn("Pakai", "dkCtx", { action: "use", name: c.name }, "primary")}
          ${["default", "orbstack", "desktop-linux"].includes(c.name) || c.current ? "" : btn("Hapus", "dkCtx", { action: "rm", name: c.name, confirm: `Hapus context ${c.name}?` }, "danger")}</div></div>`).join("")}</div>
      <form class="card" id="dkCtxNew" style="margin-top:14px"><h3>＋ Tambah server Docker (SSH)</h3>
        <div class="grid two"><div class="field"><label>Nama</label><input name="name" placeholder="vps-produksi"></div>
          <div class="field"><label>Host SSH</label><input name="host" placeholder="ssh://root@203.0.113.10"></div></div>
        <div class="row" style="margin-top:10px"><input name="description" placeholder="keterangan (opsional)" style="flex:1"><button class="go">Tambah</button></div></form>`;
    $("dkCtxNew").onsubmit = async (e) => {
      e.preventDefault();
      try { await api("/api/docker/context", { action: "create", ...Object.fromEntries(new FormData(e.target)) }); toast("Context ditambahkan. Klik 'Tes koneksi'."); this.remote(); }
      catch (err) { toast(err.message, true); }
    };
  },
};

// ------------------------------------------------------------ handler
const dkReload = () => { if (current === tabs.docker) tabs.docker.load(); refreshNav(); };
handlers.dk = (d) => runJob(api("/api/docker/action", { action: d.action, target: d.target || "" }), () => {
  if (d.back) location.hash = "#docker:containers"; else dkReload();
});
handlers.dkCompose = (d) => runJob(api("/api/docker/action", { action: d.action, target: d.target, files: JSON.parse(d.files || "[]") }), dkReload);
handlers.dkTerm = async (d) => { await api("/api/docker/action", { action: "terminal", target: d.id, shell: d.shell || "sh" }); toast("Terminal dibuka"); };
handlers.dkReveal = (d, el) => { el.textContent = d.v; el.classList.remove("secret"); };
handlers.dkLogs = (d) => tabs.docker.loadLogs(d.id);
handlers.dkProjLog = async (d) => showLog(`compose ${d.name}`, (await api(`/api/docker/project-logs?name=${encodeURIComponent(d.name)}`)).log || "(kosong)");
handlers.dkCtx = async (d) => {
  const r = await api("/api/docker/context", { action: d.action, name: d.name });
  toast(d.action === "test" ? `✅ ${d.name}: ${r.output}` : d.action === "use" ? `Sekarang mengelola ${d.name}` : "OK");
  if (d.action !== "test") { tabs.docker.hist = []; tabs.docker.prevStats = null; tabs.docker.load(); refreshNav(); }
};
handlers.dkComposeEdit = async (d) => {
  const r = await api(`/api/docker/compose?path=${encodeURIComponent(d.path)}`);
  const box = $("dkComposeEditor");
  box.dataset.open = "1";
  box.innerHTML = `<div class="card" style="margin-top:14px"><h3>✏️ ${esc(d.path)}<span class="spacer"></span>${btn("Tutup", "dkComposeClose")}</h3>
    <textarea class="editor" id="ceYaml" spellcheck="false" style="min-height:50vh"></textarea><pre id="ceOut" style="display:none"></pre>
    <div class="row" style="margin-top:10px"><span class="spacer"></span>${btn("Validasi", "ceSave", { path: d.path, only: 1 })}
      ${btn("Simpan", "ceSave", { path: d.path })}${btn("Simpan & up -d", "ceSave", { path: d.path, name: d.name, up: 1 }, "go")}</div></div>`;
  $("ceYaml").value = r.content;
  box.scrollIntoView({ behavior: "smooth" });
};
handlers.dkComposeClose = () => { const b = $("dkComposeEditor"); b.innerHTML = ""; delete b.dataset.open; };
function outBox(id, text, ok) { const o = $(id); o.style.display = "block"; o.className = "card"; o.style.color = ok ? "" : "var(--red)"; o.textContent = text; }
handlers.ceSave = async (d) => {
  const content = $("ceYaml").value;
  if (d.only) { const r = await api("/api/docker/compose/validate", { content, dir: d.path.replace(/\/[^/]+$/, "") }); return outBox("ceOut", (r.ok ? "✅ " : "❌ ") + r.output, r.ok); }
  try {
    const r = await api("/api/docker/compose/save", { path: d.path, content, up: !!d.up, project: d.name });
    outBox("ceOut", `✅ Disimpan (backup dibuat). ${r.validation}`, true);
    if (r.job) runJob(Promise.resolve({ job: r.job }), dkReload);
  } catch (e) { outBox("ceOut", e.message, false); }
};
handlers.bPick = async () => {
  const r = await api("/api/pick-folder", { prompt: "Pilih lokasi project compose", start: $("bDir").value });
  if (!r.cancelled) { $("bDir").value = r.path; tabs.docker.syncBuilder(); }
};
handlers.bValidate = async () => {
  const b = tabs.docker.bld;
  const r = await api("/api/docker/compose/validate", { content: $("bYaml").value, dir: b.dir });
  outBox("bOut", (r.ok ? "✅ " : "❌ ") + r.output, r.ok);
};
handlers.bSave = async (d) => {
  const b = tabs.docker.bld;
  if (!b.project) return toast("Isi nama project dulu", true);
  try {
    const r = await api("/api/docker/compose/save", { dir: b.dir, project: b.project, content: $("bYaml").value, up: !!d.up, overwrite: $("bOverwrite").checked });
    outBox("bOut", `✅ Disimpan ke ${r.path}\n${r.validation}`, true);
    if (r.job) runJob(Promise.resolve({ job: r.job }), () => { tabs.docker.bld = null; location.hash = "#docker:compose"; });
  } catch (e) { outBox("bOut", e.message, false); }
};

// ---- dialog "Buat container" (docker run)
handlers.dkRunDlg = (d) => {
  let dlg = $("dkRunDlg");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "dkRunDlg"; dlg.className = "wide-dlg";
    document.body.append(dlg);
  }
  dlg.innerHTML = `<div class="dlg-head"><h3>＋ Buat container</h3><button onclick="dkRunDlg.close()">Tutup</button></div>
    <form class="new-app" id="dkRunForm">
      <div class="grid two"><div class="field"><label>Image</label><input name="image" required value="${esc(d.image || "")}" placeholder="nginx:alpine" list="dkImgList">
          <datalist id="dkImgList">${COMPOSE_TEMPLATES.map((t) => `<option value="${esc(t.image)}">${esc(t.name)}</option>`).join("")}</datalist></div>
        <div class="field"><label>Nama container</label><input name="name" placeholder="opsional"></div></div>
      <div class="field"><label>Port (host:container, satu per baris)</label><textarea name="ports" rows="2" class="editor" style="min-height:0" placeholder="8080:80"></textarea><div id="dkRunWarn"></div></div>
      <div class="field"><label>Environment (KEY=VALUE per baris)</label><textarea name="env" rows="3" class="editor" style="min-height:0"></textarea></div>
      <div class="field"><label>Volume / folder (sumber:tujuan per baris)</label><textarea name="volumes" rows="2" class="editor" style="min-height:0" placeholder="~/data:/data&#10;namavolume:/var/lib/mysql"></textarea></div>
      <div class="grid two"><div class="field"><label>Restart policy</label><select name="restart"><option value="unless-stopped">unless-stopped</option>
          <option value="always">always</option><option value="on-failure">on-failure</option><option value="no">no</option></select></div>
        <div class="field"><label>Perintah (opsional)</label><input name="command" placeholder="mis. redis-server --appendonly yes"></div></div>
      <div class="row"><span class="spacer"></span><button class="go">Jalankan container</button></div>
    </form>`;
  const f = $("dkRunForm");
  f.elements.image.oninput = () => {  // isi otomatis dari template yang cocok
    const t = COMPOSE_TEMPLATES.find((x) => x.image === f.elements.image.value);
    if (t) {
      if (!f.elements.ports.value) f.elements.ports.value = t.ports.join("\n");
      if (!f.elements.env.value) f.elements.env.value = Object.entries(t.env).map(([k, v]) => `${k}=${v}`).join("\n");
      if (!f.elements.volumes.value && t.volume) f.elements.volumes.value = `${t.key}-data:${t.volume}`;
      if (!f.elements.name.value) f.elements.name.value = t.key;
      f.elements.ports.oninput();
    }
  };
  f.elements.ports.oninput = async () => {
    const ports = f.elements.ports.value.split("\n").map((p) => p.trim().split(":")).filter((p) => p.length > 1).map((p) => p.at(-2));
    const { used } = ports.length ? await api(`/api/docker/ports?ports=${ports.join(",")}`) : { used: {} };
    $("dkRunWarn").innerHTML = Object.entries(used).map(([p, proc]) => `<div class="warn" style="margin:6px 0 0">⚠️ Port ${p} sudah dipakai <code>${esc(proc)}</code>.</div>`).join("");
  };
  f.onsubmit = (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    const lines = (s) => s.split("\n").map((x) => x.trim()).filter(Boolean);
    dlg.close();
    runJob(api("/api/docker/run", { ...v, ports: lines(v.ports), env: lines(v.env), volumes: lines(v.volumes) }), () => { location.hash = "#docker:containers"; dkReload(); });
  };
  if (d.image) f.elements.image.oninput();
  dlg.showModal();
};

// Konfigurasi: editor semua file config (shell, /etc/hosts, resolver, SSH, Git,
// php.ini, tmux, vim, package manager, .env project) dengan validasi & backup.

tabs.config = {
  files: [],
  item: null,
  dirty: false,
  async load() {
    let list;
    try { list = await api("/api/files"); } catch (e) { return failView(e); }
    this.files = list.files;
    const id = this.param || this.item?.id || "zshrc";
    view.innerHTML = `
      <div class="cfg-layout">
        <aside class="card cfg-list">
          <input type="search" id="cfgQ" placeholder="Cari file…" style="width:100%;margin-bottom:8px">
          <div id="cfgNav"></div>
        </aside>
        <section id="cfgMain"><div class="loading">Memuat…</div></section>
      </div>`;
    $("cfgQ").oninput = () => this.renderList();
    this.renderList();
    await this.open(this.files.some((f) => f.id === id) ? id : "zshrc");
  },
  renderList() {
    const q = ($("cfgQ")?.value || "").toLowerCase();
    const groups = {};
    this.files.filter((f) => !q || (f.label + f.path).toLowerCase().includes(q))
      .forEach((f) => (groups[f.group] ??= []).push(f));
    $("cfgNav").innerHTML = Object.entries(groups).map(([g, list]) => `
      <div class="nav-label" style="padding-left:4px">${esc(g)}</div>
      ${list.map((f) => `<a href="#config:${encodeURIComponent(f.id)}" class="cfg-item ${this.item?.id === f.id ? "active" : ""}" title="${esc(f.path)}">
        <span class="cfg-name">${esc(f.label)}</span>
        ${f.admin ? `<span title="Perlu password admin">🔒</span>` : ""}${f.sensitive ? `<span title="Berisi rahasia">🔑</span>` : ""}
        ${f.exists ? "" : `<span class="badge">baru</span>`}</a>`).join("")}`).join("")
      || `<div class="muted small">Tidak ada file.</div>`;
  },
  async open(id) {
    if (this.item && this.item.id !== id && !this.leaveOk()) return;
    const d = await api(`/api/files/read?id=${encodeURIComponent(id)}`);
    this.item = d;
    this.dirty = false;
    this.renderList();
    $("headline").textContent = d.path;
    $("cfgMain").innerHTML = `
      <div class="row" style="margin-bottom:10px">
        <div><div class="name" style="font-size:15px">${esc(d.label)}
            ${d.admin ? `<span class="badge amber">🔒 perlu password admin</span>` : ""}
            ${d.sensitive ? `<span class="badge amber">🔑 berisi rahasia</span>` : ""}
            ${d.exists ? "" : `<span class="badge">belum ada, dibuat saat disimpan</span>`}</div>
          <div class="muted small"><code>${esc(d.path)}</code> <span id="cfgState"></span></div></div>
        <span class="spacer"></span>
        ${d.validator ? btn("Validasi", "fileValidate") : ""}
        ${btn("Muat ulang", "fileReload")}
        ${btn("Simpan (⌘S)", "fileSave", {}, "primary")}
      </div>
      ${d.sensitive ? `<div class="warn">File ini berisi password/API key. Isinya hanya ditampilkan di Mac ini, jangan di-screenshot atau dibagikan.</div>` : ""}
      <textarea class="editor" id="fileEd" spellcheck="false" style="min-height:52vh"></textarea>
      <pre class="card" id="fileOut" style="display:none;margin-top:10px"></pre>
      <div class="grid two" style="margin-top:14px">
        <div id="filePanel"></div>
        <div class="card"><h3>Backup <span class="muted small">(otomatis tiap simpan, 20 terakhir)</span></h3>
          ${d.backups.length ? d.backups.map((b) => `<div class="row issue" style="cursor:default">
            <span class="spacer">${esc(b.replace(/^.*\.(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)$/, "$3/$2/$1 $4:$5:$6"))}</span>
            ${btn("Muat ke editor", "fileBackup", { backup: b })}</div>`).join("") : `<div class="muted small">Belum ada backup.</div>`}</div>
      </div>`;
    const ed = $("fileEd");
    ed.value = d.content;
    ed.oninput = () => { this.dirty = true; $("cfgState").textContent = "● belum disimpan"; };
    ed.onkeydown = (e) => {
      if (e.key === "Tab") { e.preventDefault(); ed.setRangeText(d.validator === "zsh" ? "    " : "  ", ed.selectionStart, ed.selectionEnd, "end"); ed.oninput(); }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); handlers.fileSave({}); }
    };
    await this.panel(d);
  },
  // panel tambahan sesuai jenis file
  async panel(d) {
    const el = $("filePanel");
    if (d.validator === "zsh") {
      el.innerHTML = `<div class="card"><h3>Pemeriksaan</h3>${d.issues.length ? d.issues.map((i) =>
        `<div class="issue" data-act="fileGoto" data-line="${i.line}">Baris ${i.line}: ${esc(i.msg)}</div>`).join("")
        : `<div class="muted small">✅ Tidak ada masalah.</div>`}
        <p class="muted small">Berlaku di terminal baru, atau jalankan <code>source ~/${esc(d.label)}</code>.</p></div>`;
    } else if (d.id === "hosts" || d.id.startsWith("resolver:")) {
      el.innerHTML = `<div class="card">
        ${d.id === "hosts" ? `<h3>Tambah entri hosts</h3>
          <form class="row" id="hostsAdd"><input name="ip" value="127.0.0.1" style="width:130px"><input name="host" placeholder="myapp.test" style="flex:1"><button>Tambah ke editor</button></form>` : ""}
        <h3 style="margin-top:14px">Resolver domain baru <span class="muted small">/etc/resolver</span></h3>
        <form class="row" id="resolverAdd"><input name="domain" placeholder="mis. local" style="flex:1"><input name="nameserver" value="127.0.0.1" style="width:130px"><button>Buat</button></form>
        <p class="muted small">Menyimpan file sistem akan memunculkan dialog password admin macOS, lalu cache DNS di-flush otomatis.</p></div>`;
      if ($("hostsAdd")) $("hostsAdd").onsubmit = (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        if (!f.host.trim()) return;
        const ed = $("fileEd");
        ed.value = ed.value.replace(/\n*$/, "\n") + `${f.ip.trim()}\t${f.host.trim()}\n`;
        ed.oninput();
        toast("Ditambahkan ke editor. Klik Simpan untuk menerapkan.");
      };
      $("resolverAdd").onsubmit = async (e) => {
        e.preventDefault();
        try {
          const r = await api("/api/files/resolver", Object.fromEntries(new FormData(e.target)));
          toast("Resolver dibuat");
          location.hash = `#config:${encodeURIComponent(r.id)}`;
        } catch (err) { toast(err.message, true); }
      };
    } else if (d.id === "ssh_config") {
      const k = await api("/api/ssh/keys");
      el.innerHTML = `<div class="card"><h3>SSH key</h3>
        ${k.keys.map((key, i) => `<div class="issue" style="cursor:default">
          <div class="row"><b>${esc(key.name)}</b><span class="badge">${esc(key.type)}</span><span class="muted small">${esc(key.comment)}</span>
            <span class="spacer"></span>${btn("Salin public key", "sshCopy", { i })}</div>
          <div class="muted small"><code>${esc(key.fingerprint || "")}</code></div></div>`).join("") || `<div class="muted small">Belum ada key.</div>`}
        <h3 style="margin-top:14px">Buat key baru (ed25519)</h3>
        <form class="list" id="sshGen">
          <div class="row"><input name="name" placeholder="id_ed25519_github" style="flex:1"><input name="comment" placeholder="email / komentar" style="flex:1"></div>
          <div class="row"><input name="passphrase" type="password" placeholder="passphrase (opsional)" style="flex:1"><button class="go">Generate</button></div>
        </form>
        <p class="muted small">Private key tidak pernah ditampilkan. Salin public key lalu tempel ke GitHub/GitLab/server.</p></div>`;
      this.keys = k.keys;
      $("sshGen").onsubmit = async (e) => {
        e.preventDefault();
        try {
          const r = await api("/api/ssh/generate", Object.fromEntries(new FormData(e.target)));
          toast(`Key ~/.ssh/${r.name} dibuat`);
          await this.panel(d);
        } catch (err) { toast(err.message, true); }
      };
    } else if (d.id === "gitconfig") {
      const g = await api("/api/git/identity");
      el.innerHTML = `<div class="card"><h3>Identitas Git</h3><dl class="kv">
        <dt>user.name</dt><dd>${esc(g.name || "-")}</dd><dt>user.email</dt><dd>${esc(g.email || "-")}</dd>
        <dt>core.excludesfile</dt><dd><code>${esc(g.excludesfile || "~/.config/git/ignore (default)")}</code></dd></dl>
        <p class="muted small">Ubah langsung di editor, bagian <code>[user]</code> dan <code>[core]</code>.</p></div>`;
    } else if (d.validator === "phpini") {
      el.innerHTML = `<div class="card"><h3>php.ini</h3><p class="muted small">Setelah menyimpan, restart PHP-FPM
        (${d.path.includes("Herd") ? `<a href="#herd">Herd → Restart</a>` : `<a href="#service:php">service php → Restart</a>`}) agar perubahan dipakai situs.
        CLI langsung memakai nilai baru.</p></div>`;
    } else {
      el.innerHTML = "";
    }
  },
  leaveOk() { return !this.dirty || confirm("Ada perubahan yang belum disimpan. Buang?"); },
};

function fileOut(text, ok = true) {
  const o = $("fileOut");
  o.style.display = "block";
  o.style.color = ok ? "" : "var(--red)";
  o.textContent = text;
}
handlers.fileReload = async () => { if (tabs.config.leaveOk()) { tabs.config.dirty = false; await tabs.config.open(tabs.config.item.id); } };
handlers.fileValidate = async () => {
  const r = await api("/api/files/validate", { id: tabs.config.item.id, content: $("fileEd").value });
  fileOut((r.ok ? "✅ " : "❌ ") + r.output, r.ok);
};
handlers.fileSave = async () => {
  const it = tabs.config.item, body = { id: it.id, content: $("fileEd").value };
  if (it.admin) toast("Masukkan password admin di dialog macOS…");
  let r;
  try {
    r = await api("/api/files/save", body);
  } catch (e) {
    fileOut(e.message, false);
    if (!e.message.startsWith("Tidak valid") || !confirm(e.message + "\n\nTetap simpan?")) return;
    r = await api("/api/files/save", { ...body, force: true });
  }
  tabs.config.dirty = false;
  toast(`${it.label} disimpan${r.backup ? " (backup dibuat)" : ""}`);
  await tabs.config.open(it.id);
  fileOut(`✅ Disimpan. ${r.validation}`);
};
handlers.fileGoto = (d) => {
  const ed = $("fileEd"), lines = ed.value.split("\n");
  const start = lines.slice(0, d.line - 1).join("\n").length + (d.line > 1 ? 1 : 0);
  ed.focus();
  ed.setSelectionRange(start, start + lines[d.line - 1].length);
  ed.scrollTop = (d.line - 5) * parseFloat(getComputedStyle(ed).lineHeight);
};
handlers.fileBackup = async (d) => {
  if (!tabs.config.leaveOk()) return;
  const { content } = await api(`/api/files/backup?id=${encodeURIComponent(tabs.config.item.id)}&backup=${encodeURIComponent(d.backup)}`);
  $("fileEd").value = content;
  $("fileEd").oninput();
  toast("Backup dimuat ke editor. Klik Simpan untuk memulihkan.");
};
handlers.sshCopy = async (d) => {
  await navigator.clipboard.writeText(tabs.config.keys[d.i].public);
  toast("Public key disalin");
};
window.addEventListener("beforeunload", (e) => { if (current === tabs.config && tabs.config.dirty) e.preventDefault(); });

(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const api = (p, o) => fetch(location.origin + p, o);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  let books = [];

  function toast(msg, err = false) {
    const el = document.createElement("div");
    el.className = "toast" + (err ? " err" : "");
    el.textContent = msg;
    $("#toasts").append(el);
    setTimeout(() => el.remove(), err ? 5000 : 2600);
  }

  function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }
  function fmtDate(iso) { const d = new Date(iso); return d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }); }
  function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; }

  function render() {
    const q = $("#search").value.trim().toLowerCase();
    const list = books.filter((b) => !q || (b.title + " " + b.author).toLowerCase().includes(q));
    $("#count").textContent = books.length ? `${books.length} cuốn` : "";
    $("#empty").hidden = books.length > 0;
    $("#books").innerHTML = list.map((b) => {
      const h = hue(b.title);
      return `<article class="book" data-id="${b.id}">
        <div class="cover" style="background: linear-gradient(160deg, hsl(${h} 45% 42%), hsl(${(h + 40) % 360} 55% 28%))"><span>${esc(b.title)}</span></div>
        <div class="meta"><b title="${esc(b.title)}">${esc(b.title)}</b>${esc(b.author || "—")} · ${fmtSize(b.size)} · ${fmtDate(b.added)}</div>
        <div class="acts"><a class="btn" href="/books/${b.id}.epub">Tải</a><button class="btn danger" data-del="${b.id}" type="button">Xóa</button></div>
      </article>`;
    }).join("");
  }

  async function refresh() {
    try {
      const r = await api("/api/books");
      if (!r.ok) throw new Error(r.status);
      books = await r.json();
      render();
    } catch (e) { toast("Không tải được kệ: " + e.message, true); }
  }

  function queueItem(name) {
    const li = document.createElement("li");
    li.innerHTML = `<div class="spin"></div><div class="name">${esc(name)}</div><div class="st">Đang chuyển…</div>`;
    $("#queue").append(li);
    return {
      set(st) { li.querySelector(".st").textContent = st; },
      done(st) { li.className = "ok"; li.querySelector(".spin").outerHTML = "<span>✓</span>"; this.set(st); setTimeout(() => li.remove(), 4000); },
      fail(st) { li.className = "err"; li.querySelector(".spin").outerHTML = "<span>✕</span>"; this.set(st); },
    };
  }

  async function upload(result, q) {
    const fd = new FormData();
    fd.append("file", new Blob([result.bytes], { type: "application/epub+zip" }), result.title + ".epub");
    fd.append("title", result.title);
    fd.append("author", result.author || "");
    q.set("Đang gửi lên kệ…");
    const r = await api("/api/books", { method: "POST", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
    return j.book;
  }

  async function sendFiles(files) {
    for (const f of files) {
      const q = queueItem(f.name);
      try {
        const res = await XteinkConvert.convertFile(f);
        const book = await upload(res, q);
        q.done("Đã lên kệ");
        books.unshift(book); render();
      } catch (e) { q.fail("Lỗi: " + e.message); }
    }
  }

  async function sendText() {
    const title = $("#pasteTitle").value.trim();
    const body = $("#pasteBody").value;
    if (!body.trim()) return toast("Chưa có nội dung", true);
    const name = (title || "Ghi chú " + new Date().toLocaleDateString("vi-VN")) + ".md";
    const md = title ? `---\ntitle: ${title}\n---\n${body}` : body;
    const btn = $("#pasteBtn"); btn.disabled = true;
    try {
      await sendFiles([new File([md], name, { type: "text/markdown" })]);
      $("#pasteBody").value = ""; $("#pasteTitle").value = "";
    } finally { btn.disabled = false; }
  }

  // Tabs
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    document.querySelectorAll("[data-tab-panel]").forEach((p) => (p.hidden = p.dataset.tabPanel !== t.dataset.tab));
  }));

  // Drop zone
  const drop = $("#drop");
  $("#file").addEventListener("change", (e) => { sendFiles([...e.target.files]); e.target.value = ""; });
  ["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === "drop" || e.target === document.documentElement) drop.classList.remove("over"); }));
  document.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) sendFiles([...e.dataTransfer.files]); });
  $("#pasteBtn").addEventListener("click", sendText);

  // Shelf
  $("#search").addEventListener("input", render);
  $("#books").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-del]");
    if (!btn) return;
    if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = "Chắc chứ?"; setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Xóa"; }, 2500); return; }
    const id = btn.dataset.del;
    const r = await api("/api/books/" + id, { method: "DELETE" });
    if (r.ok) { books = books.filter((b) => b.id !== id); render(); toast("Đã xóa khỏi kệ"); } else toast("Xóa lỗi", true);
  });

  // Sheet nối máy
  const sheet = $("#sheet"), back = $("#sheetBackdrop");
  const openSheet = (v) => { sheet.hidden = !v; back.hidden = !v; };
  $("#connectBtn").addEventListener("click", () => openSheet(true));
  $("#sheetClose").addEventListener("click", () => openSheet(false));
  back.addEventListener("click", () => openSheet(false));
  $("#opdsUrl").textContent = location.origin + "/opds";
  api("/api/me").then((r) => r.ok ? r.json() : null).then((me) => { if (me) $("#opdsUser").textContent = me.user; }).catch(() => {});
  document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#" + b.dataset.copy).textContent); toast("Đã copy"); } catch { toast("Không copy được, chọn tay nhé", true); }
  }));

  refresh();
})();

(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  let books = [];
  let me = null;
  /** Cấu hình công khai của trang (/api/config): có bật Google không, đăng ký có cần mã mời không */
  let cfg = { google: false, signup: true, needsCode: false };
  let lastUser = null;
  let authMode = "login";
  let authBusy = false;
  /** Tăng mỗi khi đổi người dùng / đăng xuất: việc đang chạy của người trước thấy khác số thì dừng. */
  let epoch = 0;

  // ── Băm mật khẩu ngay trên trình duyệt ──
  // Server chỉ nhận "proof" = PBKDF2-SHA256(mật khẩu, "xteinklover|v1|" + username, 600k vòng), không thấy mật khẩu thật.
  // Phải khớp CLIENT_KDF trong src/crypto.ts. Đổi tham số = mọi người không đăng nhập được nữa.
  const KDF_ITERATIONS = 600000;
  const PASSWORD_MIN = 8, PASSWORD_MAX = 128;
  // Bản sao luật tên đăng nhập ở src/validate.ts (tests/validate.test.ts kiểm hai bản khớp nhau)
  const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$/;
  const RESERVED = ["admin", "root", "api", "opds", "books", "login", "logout", "signup", "support", "xteink", "xteinklover", "system"];

  async function passwordProof(username, password) {
    if (!window.crypto?.subtle) throw new Error("Trình duyệt không hỗ trợ mã hóa, mở bằng HTTPS hoặc trình duyệt mới hơn");
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode("xteinklover|v1|" + username), iterations: KDF_ITERATIONS }, key, 256);
    return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function checkUsername(u) {
    if (u.length < 3 || u.length > 32) return "Tên đăng nhập dài 3–32 ký tự";
    if (!USERNAME_RE.test(u)) return "Tên đăng nhập chỉ gồm chữ thường không dấu, số và . _ -";
    if (RESERVED.includes(u)) return "Tên này đã được giữ, chọn tên khác";
    return null;
  }
  function checkNewPassword(username, password) {
    if (password.length < PASSWORD_MIN) return `Mật khẩu tối thiểu ${PASSWORD_MIN} ký tự`;
    if (password.length > PASSWORD_MAX) return `Mật khẩu tối đa ${PASSWORD_MAX} ký tự`;
    if (password.toLowerCase() === username) return "Mật khẩu không được trùng tên đăng nhập";
    return null;
  }

  // ── Gọi API ──
  async function api(path, opts = {}) {
    const init = { credentials: "same-origin", ...opts };
    if (opts.json !== undefined) {
      init.method = init.method || "POST";
      init.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
      init.body = JSON.stringify(opts.json);
      delete init.json;
    }
    let r;
    try { r = await fetch(location.origin + path, init); }
    catch { throw Object.assign(new Error("Mất kết nối mạng, thử lại"), { status: 0 }); }
    let data = null;
    try { data = await r.json(); } catch { /* không phải JSON */ }
    if (r.status === 401 && me && path !== "/api/login") sessionExpired();
    if (!r.ok) throw Object.assign(new Error((data && data.error) || `Lỗi ${r.status}`), { status: r.status, data });
    return data;
  }

  function toast(msg, err = false) {
    const el = document.createElement("div");
    el.className = "toast" + (err ? " err" : "");
    el.setAttribute("role", err ? "alert" : "status");
    el.textContent = msg;
    $("#toasts").append(el);
    setTimeout(() => el.remove(), err ? 5000 : 2600);
  }

  /** Khóa nút trong lúc chạy, chặn bấm đúp. */
  async function busy(btn, text, fn) {
    if (btn.dataset.busy) return;
    btn.dataset.busy = "1";
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = text;
    try { return await fn(); } finally { delete btn.dataset.busy; btn.disabled = false; btn.textContent = old; }
  }

  function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }
  function fmtDate(iso) { const d = new Date(iso); return d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }); }
  function fmtSize(b) {
    if (!b) return "0 KB";
    return b >= 1048576 ? (b / 1048576).toFixed(1).replace(/\.0$/, "") + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
  }

  // ── Trạng thái theo người dùng ──
  const keyNoteDefault = $("#keyNote").innerHTML;
  function resetUserState() {
    epoch++;
    books = [];
    render();
    $("#opdsKey").textContent = "khóa OPDS";
    $("#opdsKey").classList.remove("fresh");
    $("#copyKey").hidden = true;
    $("#keyNote").innerHTML = keyNoteDefault;
    for (const id of ["pasteTitle", "pasteBody", "search", "pwCurrent", "pwNext", "delPass", "delConfirm", "pwUser", "linkPass", "linkUser"]) $("#" + id).value = "";
    $("#queue").innerHTML = "";
    $("#usage").textContent = "";
    $("#accountInfo").textContent = "";
  }

  // ── Chuyển màn ──
  function showAuth() {
    me = null;
    epoch++; // việc đang chạy (gửi file, tải kệ) của phiên cũ dừng lại
    $("#authView").hidden = false;
    $("#appView").hidden = true;
    $("#topActions").hidden = true;
    closeSheets();
  }

  function sessionExpired() {
    const name = me?.user?.username || "";
    showAuth();
    setAuthMode("login");
    $("#authUser").value = name;
    const errEl = $("#authError");
    errEl.textContent = "Phiên đăng nhập đã hết hạn, đăng nhập lại nhé";
    errEl.hidden = false;
  }

  function showApp() {
    if (me.user.username !== lastUser) resetUserState();
    lastUser = me.user.username;
    $("#authView").hidden = true;
    $("#appView").hidden = false;
    $("#topActions").hidden = false;
    $("#whoami").textContent = "👤 " + me.user.username;
    $("#accountBtn").setAttribute("aria-label", "Tài khoản " + me.user.username);
    $("#opdsUser").textContent = me.user.username;
    $("#pwUser").value = me.user.username;
    $("#maxSize").textContent = "tối đa " + fmtSize(me.limits.maxUploadBytes);
    renderUsage();
    refresh();
  }

  function renderUsage() {
    if (!me) return;
    const u = me.usage, l = me.limits;
    $("#usage").textContent = `${u.books}/${l.maxBooks} cuốn · ${fmtSize(u.bytes)}/${fmtSize(l.maxStorageBytes)} · hôm nay đã gửi ${u.uploadsToday}/${l.maxUploadsPerDay}`;
    $("#accountInfo").textContent = `Đăng nhập là ${me.user.username} · tạo ngày ${new Date(me.user.created).toLocaleDateString("vi-VN")}`;
    renderAccount();
  }

  /** Mục tài khoản khác nhau giữa tài khoản có mật khẩu và tài khoản chỉ có Google. */
  function renderAccount() {
    if (!me) return;
    const u = me.user;
    $("#pwSection").hidden = !u.hasPassword;
    $("#delPass").hidden = !u.hasPassword;
    $("#delConfirm").hidden = u.hasPassword;
    $("#googleSection").hidden = !(cfg.google || u.google);
    $("#googleState").textContent = u.google
      ? (u.hasPassword ? "Đã liên kết. Đăng nhập được bằng Google hoặc bằng mật khẩu." : "Tài khoản này đăng nhập bằng Google.")
      : "Liên kết để lần sau bấm “Tiếp tục với Google” là vào, không phải gõ mật khẩu.";
    $("#linkForm").hidden = u.google || !cfg.google;
    $("#linkPass").hidden = !u.hasPassword;
    $("#linkUser").value = u.username;
    $("#unlinkBtn").hidden = !(u.google && u.hasPassword);
  }

  async function loadMe() {
    try {
      me = await api("/api/me");
      showApp();
    } catch (e) {
      if (e.status === 401) return showAuth();
      showAuth();
      const errEl = $("#authError");
      errEl.textContent = e.status === 0 ? "Mất kết nối mạng. Tải lại trang khi có mạng nhé." : "Máy chủ đang lỗi (" + e.message + "). Thử tải lại trang.";
      errEl.hidden = false;
    }
  }

  // ── Đăng nhập / đăng ký ──
  function setAuthMode(mode) {
    if (authBusy) return;
    authMode = mode;
    document.querySelectorAll("[data-auth-tab]").forEach((t) => {
      const on = t.dataset.authTab === mode;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", String(on));
    });
    const signup = mode === "signup";
    $("#authSubmit").textContent = signup ? "Tạo tài khoản" : "Đăng nhập";
    $("#authPass").autocomplete = signup ? "new-password" : "current-password";
    $("#codeField").hidden = !signup;
    $("#authHint").textContent = signup
      ? "Tên đăng nhập: chữ thường không dấu, số, dấu . _ -. Mật khẩu tối thiểu 8 ký tự. Không cần email, nên nhớ kỹ mật khẩu: quên là không lấy lại được."
      : cfg.google ? "Chưa có tài khoản? Bấm “Tiếp tục với Google”, hoặc “Tạo tài khoản”." : "Chưa có tài khoản? Bấm “Tạo tài khoản”.";
    $("#authError").hidden = true;
  }

  document.querySelectorAll("[data-auth-tab]").forEach((t) => t.addEventListener("click", () => setAuthMode(t.dataset.authTab)));

  $("#authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (authBusy) return;
    const mode = authMode;
    const btn = $("#authSubmit");
    const errEl = $("#authError");
    const fail = (msg) => { errEl.textContent = msg; errEl.hidden = false; };
    errEl.hidden = true;
    const username = $("#authUser").value.trim().toLowerCase();
    const password = $("#authPass").value;
    if (!username || !password) return fail("Điền tên đăng nhập và mật khẩu");
    if (mode === "signup") {
      const bad = checkUsername(username) || checkNewPassword(username, password);
      if (bad) return fail(bad);
    }
    const code = mode === "signup" ? $("#authCode").value.trim() : undefined;
    authBusy = true;
    document.querySelectorAll("[data-auth-tab]").forEach((t) => (t.disabled = true));
    try {
      await busy(btn, "Đang mã hóa mật khẩu…", async () => {
        const body = { username, proof: await passwordProof(username, password) };
        if (code) body.code = code;
        btn.textContent = mode === "signup" ? "Đang tạo tài khoản…" : "Đang đăng nhập…";
        const res = await api(mode === "signup" ? "/api/signup" : "/api/login", { json: body });
        $("#authPass").value = "";
        $("#authCode").value = "";
        await loadMe();
        if (res.opdsKey) {
          showKey(res.opdsKey);
          openSheet("connectSheet");
          toast("Đã tạo tài khoản. Lưu khóa OPDS này lại để nối máy.");
        }
      });
    } catch (err) {
      fail(err.message);
    } finally {
      authBusy = false;
      document.querySelectorAll("[data-auth-tab]").forEach((t) => (t.disabled = false));
    }
  });

  // ── Đăng nhập bằng Google ──
  /** Server cất state vào cookie rồi trả URL Google; trang chuyển sang Google, xong Google đưa về /?google=… */
  async function googleGo(mode, extra = {}) {
    const r = await api("/api/google/start", { json: { mode, ...extra } });
    location.assign(r.url);
    await new Promise(() => {}); // đang rời trang: giữ nút ở trạng thái chờ
  }

  $("#googleBtn").addEventListener("click", (e) => {
    const errEl = $("#authError");
    errEl.hidden = true;
    busy(e.currentTarget, "Đang mở Google…", () => googleGo("login")).catch((err) => { errEl.textContent = err.message; errEl.hidden = false; });
  });

  const GOOGLE_RESULT = {
    ok: ["Đã đăng nhập bằng Google"],
    linked: ["Đã liên kết Google. Lần sau bấm “Tiếp tục với Google” là vào."],
    taken: ["Google này đã gắn với một tài khoản khác", true],
    already: ["Tài khoản này đã gắn một Google khác. Gỡ liên kết cũ trước", true],
    cancel: ["Đã hủy đăng nhập Google", true],
    expired: ["Hết thời gian đăng nhập Google, thử lại nhé", true],
    error: ["Google chưa xác nhận được, thử lại nhé", true],
    closed: ["Trang này chưa mở đăng ký tài khoản mới", true],
    slow: ["Đăng nhập Google quá nhiều lần, đợi 15 phút rồi thử lại", true],
    off: ["Trang này chưa bật đăng nhập bằng Google", true],
  };

  function hidePick() {
    $("#pickCard").hidden = true;
    $("#authCard").hidden = false;
    $("#pickError").hidden = true;
  }

  async function showPick() {
    let p;
    try { p = await api("/api/google/pending"); }
    catch { toast("Hết thời gian chọn tên, bấm “Tiếp tục với Google” lại nhé", true); return loadMe(); }
    showAuth();
    $("#authCard").hidden = true;
    $("#pickCard").hidden = false;
    $("#pickUser").value = p.suggest || "";
    $("#pickCodeField").hidden = !p.needsCode;
    $("#pickUser").focus();
    $("#pickUser").select();
  }

  $("#pickForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#pickSubmit");
    const errEl = $("#pickError");
    const fail = (msg) => { errEl.textContent = msg; errEl.hidden = false; };
    errEl.hidden = true;
    const username = $("#pickUser").value.trim().toLowerCase();
    const bad = checkUsername(username);
    if (bad) return fail(bad);
    const code = $("#pickCode").value.trim();
    await busy(btn, "Đang tạo tài khoản…", async () => {
      try {
        const res = await api("/api/google/signup", { json: code ? { username, code } : { username } });
        $("#pickCode").value = "";
        hidePick();
        await loadMe();
        showKey(res.opdsKey);
        openSheet("connectSheet");
        toast("Đã tạo tài khoản. Lưu khóa OPDS này lại để nối máy.");
      } catch (err) {
        if (err.status === 410) { hidePick(); toast(err.message, true); }
        else fail(err.message);
      }
    });
  });

  $("#pickCancel").addEventListener("click", async () => {
    try { await api("/api/google/cancel", { json: {} }); } catch { /* cookie tự hết hạn */ }
    hidePick();
  });

  $("#linkForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter || $("#linkForm button");
    const extra = {};
    await busy(btn, "Đang mở Google…", async () => {
      try {
        if (me.user.hasPassword) {
          const pw = $("#linkPass").value;
          if (!pw) throw new Error("Nhập mật khẩu hiện tại để xác nhận");
          extra.proof = await passwordProof(me.user.username, pw);
        }
        await googleGo("link", extra);
      } catch (err) { toast(err.message, true); }
    });
  });

  $("#unlinkBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.busy) return;
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1"; btn.textContent = "Bấm lần nữa để gỡ";
      setTimeout(() => { btn.dataset.armed = ""; if (!btn.dataset.busy) btn.textContent = "Gỡ liên kết Google"; }, 3000);
      return;
    }
    btn.dataset.armed = ""; btn.textContent = "Gỡ liên kết Google";
    await busy(btn, "Đang gỡ…", async () => {
      try { await api("/api/google/unlink", { json: {} }); me.user.google = false; renderAccount(); toast("Đã gỡ liên kết Google"); }
      catch (err) { toast(err.message, true); }
    });
  });

  // ── Kệ sách ──
  function render() {
    const q = $("#search").value.trim().toLowerCase();
    const list = books.filter((b) => !q || (b.title + " " + b.author).toLowerCase().includes(q));
    $("#count").textContent = books.length ? `${books.length} cuốn` : "";
    $("#empty").hidden = books.length > 0;
    $("#books").innerHTML = list.map((b) => {
      const h = hue(b.title);
      return `<article class="book" data-id="${esc(b.id)}">
        <div class="cover" style="background: linear-gradient(160deg, hsl(${h} 45% 42%), hsl(${(h + 40) % 360} 55% 28%))"><span>${esc(b.title)}</span></div>
        <div class="meta"><b title="${esc(b.title)}">${esc(b.title)}</b>${esc(b.author || "—")} · ${fmtSize(b.size)} · ${fmtDate(b.added)}</div>
        <div class="acts"><a class="btn" href="/books/${encodeURIComponent(b.id)}.epub">Tải</a><button class="btn danger" data-del="${esc(b.id)}" type="button">Xóa</button></div>
      </article>`;
    }).join("");
  }

  async function refresh() {
    const my = epoch;
    try {
      const list = await api("/api/books");
      if (my !== epoch) return;
      books = list;
      render();
    } catch (e) { if (me) toast("Không tải được kệ: " + e.message, true); }
  }

  async function refreshUsage() {
    const my = epoch;
    try {
      const m = await api("/api/me");
      if (my !== epoch) return;
      me = m; renderUsage();
    } catch { /* bỏ qua */ }
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
    if (me && result.bytes.length > me.limits.maxUploadBytes) throw new Error("File quá " + fmtSize(me.limits.maxUploadBytes));
    q.set("Đang gửi lên kệ…");
    const qs = "?title=" + encodeURIComponent(result.title) + "&author=" + encodeURIComponent(result.author || "");
    const j = await api("/api/books" + qs, { method: "POST", headers: { "Content-Type": "application/epub+zip" }, body: new Blob([result.bytes]) });
    return j.book;
  }

  /** Bộ chuyển đổi là ES module (nạp sau app.js): đợi tới khi sẵn sàng. */
  async function converter() {
    for (let i = 0; i < 100 && !window.XteinkConvert; i++) await new Promise((r) => setTimeout(r, 100));
    if (!window.XteinkConvert) throw new Error("Chưa tải xong bộ chuyển đổi, tải lại trang rồi thử lại");
    return window.XteinkConvert;
  }

  /** Chuyển và gửi lần lượt; trả về số file gửi thành công. */
  async function sendFiles(files, opts = {}) {
    const my = epoch;
    let ok = 0;
    for (const f of files) {
      if (my !== epoch) break; // đã đăng xuất / đổi người: dừng, không gửi lên kệ người khác
      const q = queueItem(f.name);
      try {
        const conv = await converter();
        const pdfMode = document.querySelector('input[name="pdfMode"]:checked')?.value || "auto";
        const unit = /\.(pdf|cbz)$/i.test(f.name) ? "trang" : "phần";
        if (pdfMode === "auto" && /\.pdf$/i.test(f.name)) {
          q.set("Đang xem PDF…");
          const p = await conv.probePdf(f);
          q.set(`PDF ${p.pages} trang → ${p.mode === "image" ? "ảnh trang" : "chữ"}…`);
        }
        const res = await conv.convertFile(f, { ...opts, pdfMode, onProgress: (d, t) => q.set(`Đang chuyển… ${unit} ${d}/${t}${t > 30 ? " · giữ trang này mở" : ""}`) });
        if (my !== epoch) break;
        const book = await upload(res, q);
        if (my !== epoch) break;
        q.done(res.note ? `Đã lên kệ (${res.note})` : "Đã lên kệ");
        ok++;
        books.unshift(book); render();
      } catch (e) { q.fail("Lỗi: " + e.message); }
    }
    if (my === epoch) refreshUsage();
    return ok;
  }

  async function sendText() {
    const title = $("#pasteTitle").value.trim();
    const body = $("#pasteBody").value;
    if (!body.trim()) return toast("Chưa có nội dung", true);
    const fallback = "Ghi chú " + new Date().toLocaleDateString("vi-VN");
    const name = (title || fallback).replace(/[\\/:*?"<>|\r\n]+/g, " ") + ".md";
    await busy($("#pasteBtn"), "Đang gửi…", async () => {
      // Tiêu đề truyền riêng, không nhét vào frontmatter (giữ nguyên dấu ngoặc, frontmatter sẵn có của note).
      // Không gõ tiêu đề thì lấy từ frontmatter / H1 của văn bản; không có mới dùng "Ghi chú <ngày>".
      const ok = await sendFiles([new File([body], name, { type: "text/markdown" })], { title: title || undefined, fallbackTitle: fallback });
      if (ok > 0) { $("#pasteBody").value = ""; $("#pasteTitle").value = ""; }
    });
  }

  document.querySelectorAll("[data-tab]").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll("[data-tab]").forEach((x) => { x.classList.toggle("active", x === t); x.setAttribute("aria-selected", String(x === t)); });
    document.querySelectorAll("[data-tab-panel]").forEach((p) => (p.hidden = p.dataset.tabPanel !== t.dataset.tab));
  }));

  // Kéo thả: chỉ can thiệp khi kéo FILE (kéo chữ vào ô dán vẫn chạy bình thường)
  const drop = $("#drop");
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  $("#file").addEventListener("change", (e) => { sendFiles([...e.target.files]); e.target.value = ""; });
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#file").click(); } });
  ["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => { if (!hasFiles(e)) return; e.preventDefault(); if (me) drop.classList.add("over"); }));
  document.addEventListener("dragleave", (e) => { if (hasFiles(e) && e.relatedTarget === null) drop.classList.remove("over"); });
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    drop.classList.remove("over");
    if (!me) return toast("Đăng nhập trước rồi thả file nhé", true);
    sendFiles([...e.dataTransfer.files]);
  });
  $("#pasteBtn").addEventListener("click", sendText);

  $("#search").addEventListener("input", render);
  $("#books").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-del]");
    if (!btn || btn.dataset.busy) return;
    if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = "Chắc chứ?"; setTimeout(() => { btn.dataset.armed = ""; if (!btn.dataset.busy) btn.textContent = "Xóa"; }, 2500); return; }
    const id = btn.dataset.del;
    btn.dataset.armed = ""; btn.textContent = "Xóa";
    await busy(btn, "Đang xóa…", async () => {
      try {
        await api("/api/books/" + encodeURIComponent(id), { method: "DELETE" });
        books = books.filter((b) => b.id !== id); render(); toast("Đã xóa khỏi kệ");
        refreshUsage();
      } catch (err) { toast("Xóa lỗi: " + err.message, true); }
    });
  });

  // ── Sheets ──
  const back = $("#sheetBackdrop");
  let lastFocus = null;
  function openSheet(id) {
    closeSheets(false);
    lastFocus = document.activeElement;
    const s = $("#" + id);
    s.hidden = false;
    back.hidden = false;
    s.querySelector("[data-close]")?.focus();
  }
  function closeSheets(restore = true) {
    const wasOpen = [...document.querySelectorAll(".sheet")].some((s) => !s.hidden);
    document.querySelectorAll(".sheet").forEach((s) => (s.hidden = true));
    back.hidden = true;
    if (restore && wasOpen && lastFocus?.focus) lastFocus.focus();
  }
  $("#connectBtn").addEventListener("click", () => openSheet("connectSheet"));
  $("#accountBtn").addEventListener("click", () => openSheet("accountSheet"));
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeSheets()));
  back.addEventListener("click", () => closeSheets());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheets(); });
  $("#opdsUrl").textContent = location.origin + "/opds";

  function showKey(key) {
    $("#opdsKey").textContent = key;
    $("#opdsKey").classList.add("fresh");
    $("#copyKey").hidden = false;
    $("#keyNote").innerHTML = "Đây là <b>khóa OPDS</b>, điền vào ô Password trên máy. Lưu lại ngay: đóng trang là không xem lại được.";
  }

  $("#rotateKey").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.busy) return;
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1"; btn.textContent = "Khóa cũ trên máy sẽ ngừng chạy. Bấm lần nữa";
      setTimeout(() => { btn.dataset.armed = ""; if (!btn.dataset.busy) btn.textContent = "Tạo khóa mới"; }, 4000);
      return;
    }
    btn.dataset.armed = ""; btn.textContent = "Tạo khóa mới";
    await busy(btn, "Đang tạo…", async () => {
      try { const r = await api("/api/opds-key", { method: "POST", json: {} }); showKey(r.opdsKey); toast("Đã tạo khóa mới, sửa lại Password trên máy"); }
      catch (err) { toast(err.message, true); }
    });
  });

  document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#" + b.dataset.copy).textContent); toast("Đã copy"); } catch { toast("Không copy được, chọn tay nhé", true); }
  }));

  // ── Tài khoản ──
  $("#logoutBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.busy) return;
    let done = false;
    await busy(btn, "Đang đăng xuất…", async () => {
      try { await api("/api/logout", { method: "POST", json: {} }); done = true; }
      catch (err) {
        if (err.status === 401) done = true; // phiên đã hết sẵn
        else toast("Chưa đăng xuất được — kiểm tra mạng rồi bấm lại", true);
      }
    });
    if (done) { resetUserState(); lastUser = null; showAuth(); setAuthMode("login"); }
  });

  $("#pwForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter || $("#pwForm button");
    const u = me.user.username, current = $("#pwCurrent").value, next = $("#pwNext").value;
    if (!current) return toast("Nhập mật khẩu hiện tại", true);
    const bad = checkNewPassword(u, next);
    if (bad) return toast(bad, true);
    await busy(btn, "Đang mã hóa…", async () => {
      try {
        const [cur, nxt] = await Promise.all([passwordProof(u, current), passwordProof(u, next)]);
        await api("/api/password", { json: { current: cur, next: nxt } });
        $("#pwCurrent").value = ""; $("#pwNext").value = "";
        toast("Đã đổi mật khẩu, các nơi khác đã bị đăng xuất. Nếu nghi bị lộ, bấm “Tạo khóa mới” ở ⚡ Nối máy.");
      } catch (err) { toast(err.message, true); }
    });
  });

  $("#delForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter || $("#delForm button");
    if (btn.dataset.busy) return;
    const googleOnly = !me.user.hasPassword;
    if (googleOnly && $("#delConfirm").value.trim().toLowerCase() !== me.user.username) return toast("Gõ đúng tên đăng nhập để xác nhận xóa", true);
    if (!googleOnly && !$("#delPass").value) return toast("Nhập mật khẩu để xác nhận xóa", true);
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1"; btn.textContent = "Chắc chắn xóa hết?";
      setTimeout(() => { btn.dataset.armed = ""; if (!btn.dataset.busy) btn.textContent = "Xóa vĩnh viễn"; }, 4000);
      return;
    }
    btn.dataset.armed = ""; btn.textContent = "Xóa vĩnh viễn";
    const password = $("#delPass").value;
    await busy(btn, "Đang xóa…", async () => {
      try {
        const body = googleOnly ? { confirm: me.user.username } : { proof: await passwordProof(me.user.username, password) };
        await api("/api/account", { method: "DELETE", json: body });
        resetUserState(); lastUser = null; showAuth(); setAuthMode("signup");
        toast("Đã xóa tài khoản");
      } catch (err) {
        if (err.data?.reauth) {
          // Phiên đã cũ: đăng nhập lại bằng Google rồi quay về bấm Xóa lần nữa
          try { sessionStorage.setItem("xl_reauth", "delete"); } catch { /* không có sessionStorage vẫn chạy */ }
          toast("Xác nhận lại bằng Google trước khi xóa…");
          try { await googleGo("login"); } catch (e2) { toast(e2.message, true); }
        } else toast(err.message, true);
      }
    });
  });

  // ── Khởi động ──
  async function boot() {
    const g = new URLSearchParams(location.search).get("google");
    if (g) history.replaceState(null, "", "/"); // bỏ ?google=… khỏi thanh địa chỉ
    try { cfg = { ...cfg, ...(await api("/api/config")) }; } catch { /* không có cấu hình: ẩn nút Google */ }
    $("#googleBox").hidden = !cfg.google;
    setAuthMode("login");
    if (g === "pick") return showPick();
    await loadMe();
    const msg = GOOGLE_RESULT[g];
    if (msg) toast(msg[0], !!msg[1]);
    let reauth = null;
    try { reauth = sessionStorage.getItem("xl_reauth"); sessionStorage.removeItem("xl_reauth"); } catch { /* bỏ qua */ }
    if (me && g === "ok" && reauth === "delete") {
      openSheet("accountSheet");
      $("#delConfirm").value = me.user.username;
      toast("Đã xác nhận bằng Google. Bấm “Xóa vĩnh viễn” lần nữa trong 10 phút nếu vẫn muốn xóa.");
    } else if (me && (g === "linked" || g === "taken" || g === "already")) openSheet("accountSheet");
  }
  boot();
})();

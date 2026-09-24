(() => {
  const { L, tr, lang } = window.XL_I18N;
  const LOCALE = lang === "en" ? "en-GB" : "vi-VN";
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
    if (!window.crypto?.subtle) throw new Error(L("Trình duyệt không hỗ trợ mã hóa, mở bằng HTTPS hoặc trình duyệt mới hơn", "Your browser doesn't support encryption. Open the page over HTTPS or use a newer browser"));
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode("xteinklover|v1|" + username), iterations: KDF_ITERATIONS }, key, 256);
    return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function checkUsername(u) {
    if (u.length < 3 || u.length > 32) return L("Tên đăng nhập dài 3–32 ký tự", "Username must be 3–32 characters");
    if (!USERNAME_RE.test(u)) return L("Tên đăng nhập chỉ gồm chữ thường không dấu, số và . _ -", "Username may only contain lowercase letters, digits and . _ -");
    if (RESERVED.includes(u)) return L("Tên này đã được giữ, chọn tên khác", "That name is reserved, please pick another");
    return null;
  }
  function checkNewPassword(username, password) {
    if (password.length < PASSWORD_MIN) return L(`Mật khẩu tối thiểu ${PASSWORD_MIN} ký tự`, `Password must be at least ${PASSWORD_MIN} characters`);
    if (password.length > PASSWORD_MAX) return L(`Mật khẩu tối đa ${PASSWORD_MAX} ký tự`, `Password must be at most ${PASSWORD_MAX} characters`);
    if (password.toLowerCase() === username) return L("Mật khẩu không được trùng tên đăng nhập", "Password can't be the same as your username");
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
    catch { throw Object.assign(new Error(L("Mất kết nối mạng, thử lại", "Network connection lost, please try again")), { status: 0 }); }
    let data = null;
    try { data = await r.json(); } catch { /* không phải JSON */ }
    if (r.status === 401 && me && path !== "/api/login") sessionExpired();
    if (!r.ok) throw Object.assign(new Error((data && data.error) || L(`Lỗi ${r.status}`, `Error ${r.status}`)), { status: r.status, data });
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
  function fmtDate(iso) { const d = new Date(iso); return d.toLocaleDateString(LOCALE, { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" }); }
  function fmtSize(b) {
    if (!b) return "0 KB";
    return b >= 1048576 ? (b / 1048576).toFixed(1).replace(/\.0$/, "") + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
  }

  // ── Trạng thái theo người dùng ──
  // i18n.js có thể chưa kịp thay chữ HTML (chạy lúc DOMContentLoaded) → lấy bản tiếng Anh thẳng từ data-en-html nếu có
  const keyNoteDefault = (lang === "en" && $("#keyNote").dataset.enHtml) || $("#keyNote").innerHTML;
  function resetUserState() {
    epoch++;
    books = [];
    render();
    $("#opdsKey").textContent = L("khóa OPDS", "OPDS key");
    $("#opdsKey").classList.remove("fresh");
    $("#copyKey").hidden = true;
    $("#keyNote").innerHTML = keyNoteDefault;
    for (const id of ["pasteTitle", "pasteBody", "search", "pwCurrent", "pwNext", "delPass", "delConfirm", "pwUser", "linkPass", "linkUser", "tokenName", "tokenPass", "tokenUser"]) $("#" + id).value = "";
    $("#tokenList").innerHTML = "";
    $("#tokenNew").hidden = true;
    $("#tokenValue").textContent = "";
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
    try { localStorage.removeItem("xl_signed_in"); } catch { /* bỏ qua */ }
    $("#topActions").hidden = true;
    closeSheets();
  }

  function sessionExpired() {
    const name = me?.user?.username || "";
    showAuth();
    setAuthMode("login");
    $("#authUser").value = name;
    const errEl = $("#authError");
    errEl.textContent = L("Phiên đăng nhập đã hết hạn, đăng nhập lại nhé", "Your session has expired, please log in again");
    errEl.hidden = false;
  }

  function showApp() {
    if (me.user.username !== lastUser) resetUserState();
    lastUser = me.user.username;
    $("#authView").hidden = true;
    $("#appView").hidden = false;
    try { localStorage.setItem("xl_signed_in", "1"); } catch { /* bỏ qua */ }
    $("#topActions").hidden = false;
    $("#whoami").textContent = "👤 " + me.user.username;
    $("#accountBtn").setAttribute("aria-label", L("Tài khoản ", "Account ") + me.user.username);
    $("#opdsUser").textContent = me.user.username;
    $("#pwUser").value = me.user.username;
    $("#maxSize").textContent = L("tối đa ", "max ") + fmtSize(me.limits.maxUploadBytes);
    renderUsage();
    refresh();
  }

  function renderUsage() {
    if (!me) return;
    const u = me.usage, l = me.limits;
    $("#usage").textContent = L(
      `${u.books}/${l.maxBooks} cuốn · ${fmtSize(u.bytes)}/${fmtSize(l.maxStorageBytes)} · hôm nay đã gửi ${u.uploadsToday}/${l.maxUploadsPerDay}`,
      `${u.books}/${l.maxBooks} books · ${fmtSize(u.bytes)}/${fmtSize(l.maxStorageBytes)} · sent today ${u.uploadsToday}/${l.maxUploadsPerDay}`,
    );
    const created = new Date(me.user.created).toLocaleDateString(LOCALE);
    $("#accountInfo").textContent = L(`Đăng nhập là ${me.user.username} · tạo ngày ${created}`, `Logged in as ${me.user.username} · created ${created}`);
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
      ? (u.hasPassword
        ? L("Đã liên kết. Đăng nhập được bằng Google hoặc bằng mật khẩu.", "Linked. You can log in with Google or with your password.")
        : L("Tài khoản này đăng nhập bằng Google.", "This account logs in with Google."))
      : L("Liên kết để lần sau bấm “Tiếp tục với Google” là vào, không phải gõ mật khẩu.", "Link it so next time you just tap “Continue with Google”, no password needed.");
    $("#linkForm").hidden = u.google || !cfg.google;
    $("#linkPass").hidden = !u.hasPassword;
    $("#linkUser").value = u.username;
    $("#unlinkBtn").hidden = !(u.google && u.hasPassword);
    $("#tokenPass").hidden = !u.hasPassword;
    $("#tokenUser").value = u.username;
  }

  // ── Mã cho ứng dụng (plugin Obsidian) ──
  async function loadTokens() {
    const my = epoch;
    try {
      const list = await api("/api/tokens");
      if (my !== epoch) return;
      $("#tokenList").innerHTML = list.map((t) => `<li><div><b>${esc(t.name)}</b><span class="muted small">${L("tạo ", "created ")}${esc(fmtDate(new Date(t.created).toISOString()))} · ${t.lastUsed ? L("dùng lần cuối ", "last used ") + esc(fmtDate(new Date(t.lastUsed).toISOString())) : L("chưa dùng", "never used")}</span></div><button class="btn tiny danger" data-revoke="${esc(t.id)}" type="button">${L("Thu hồi", "Revoke")}</button></li>`).join("");
    } catch { /* bỏ qua: danh sách mã không quan trọng bằng phần còn lại */ }
  }

  $("#tokenForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter || $("#tokenForm button");
    const name = $("#tokenName").value.trim() || "Obsidian";
    await busy(btn, L("Đang tạo…", "Creating…"), async () => {
      try {
        const body = { name };
        if (me.user.hasPassword) {
          const pw = $("#tokenPass").value;
          if (!pw) throw new Error(L("Nhập mật khẩu hiện tại để xác nhận", "Enter your current password to confirm"));
          body.proof = await passwordProof(me.user.username, pw);
        }
        const r = await api("/api/tokens", { json: body });
        $("#tokenPass").value = ""; $("#tokenName").value = "";
        $("#tokenValue").textContent = r.token;
        $("#tokenNew").hidden = false;
        toast(L("Đã tạo mã. Copy dán vào plugin ngay nhé", "App token created. Copy it into the plugin now"));
        loadTokens();
      } catch (err) {
        if (err.data?.reauth) {
          try { sessionStorage.setItem("xl_reauth", "token"); } catch { /* bỏ qua */ }
          toast(L("Xác nhận lại bằng Google trước khi tạo mã…", "Confirm with Google again before creating a token…"));
          try { await googleGo("login"); } catch (e2) { toast(tr(e2.message), true); }
        } else toast(tr(err.message), true);
      }
    });
  });

  $("#tokenList").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-revoke]");
    if (!btn || btn.dataset.busy) return;
    if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = L("Chắc chứ?", "Sure?"); setTimeout(() => { btn.dataset.armed = ""; if (!btn.dataset.busy) btn.textContent = L("Thu hồi", "Revoke"); }, 2500); return; }
    btn.dataset.armed = ""; btn.textContent = L("Thu hồi", "Revoke");
    await busy(btn, L("Đang thu hồi…", "Revoking…"), async () => {
      try { await api("/api/tokens/" + encodeURIComponent(btn.dataset.revoke), { method: "DELETE" }); toast(L("Đã thu hồi mã, app dùng mã đó hết gửi được", "Token revoked. Apps using it can no longer send")); loadTokens(); }
      catch (err) { toast(tr(err.message), true); }
    });
  });

  async function loadMe() {
    try {
      me = await api("/api/me");
      showApp();
    } catch (e) {
      if (e.status === 401) return showAuth();
      showAuth();
      const errEl = $("#authError");
      errEl.textContent = e.status === 0
        ? L("Mất kết nối mạng. Tải lại trang khi có mạng nhé.", "No network connection. Reload the page once you're back online.")
        : L("Máy chủ đang lỗi (", "Server error (") + tr(e.message) + L("). Thử tải lại trang.", "). Try reloading the page.");
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
    $("#authSubmit").textContent = signup ? L("Tạo tài khoản", "Create account") : L("Đăng nhập", "Log in");
    $("#authPass").autocomplete = signup ? "new-password" : "current-password";
    $("#codeField").hidden = !signup;
    $("#authHint").textContent = signup
      ? L("Tên đăng nhập: chữ thường không dấu, số, dấu . _ -. Mật khẩu tối thiểu 8 ký tự. Không cần email, nên nhớ kỹ mật khẩu: quên là không lấy lại được.", "Username: lowercase letters, digits, . _ -. Password at least 8 characters. No email needed, so remember your password: it can't be recovered.")
      : cfg.google
        ? L("Chưa có tài khoản? Bấm “Tiếp tục với Google”, hoặc “Tạo tài khoản”.", "No account yet? Tap “Continue with Google” or “Create account”.")
        : L("Chưa có tài khoản? Bấm “Tạo tài khoản”.", "No account yet? Tap “Create account”.");
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
    if (!username || !password) return fail(L("Điền tên đăng nhập và mật khẩu", "Enter your username and password"));
    if (mode === "signup") {
      const bad = checkUsername(username) || checkNewPassword(username, password);
      if (bad) return fail(bad);
    }
    const code = mode === "signup" ? $("#authCode").value.trim() : undefined;
    authBusy = true;
    document.querySelectorAll("[data-auth-tab]").forEach((t) => (t.disabled = true));
    try {
      await busy(btn, L("Đang mã hóa mật khẩu…", "Encrypting password…"), async () => {
        const body = { username, proof: await passwordProof(username, password) };
        if (code) body.code = code;
        btn.textContent = mode === "signup" ? L("Đang tạo tài khoản…", "Creating account…") : L("Đang đăng nhập…", "Logging in…");
        const res = await api(mode === "signup" ? "/api/signup" : "/api/login", { json: body });
        $("#authPass").value = "";
        $("#authCode").value = "";
        await loadMe();
        consumeSharedLink();
        if (res.opdsKey) {
          showKey(res.opdsKey);
          openSheet("connectSheet");
          toast(L("Đã tạo tài khoản. Lưu khóa OPDS này lại để nối máy.", "Account created. Save this OPDS key to connect your reader."));
        }
      });
    } catch (err) {
      fail(tr(err.message));
      if (err.status === 403 && /Đã đủ số tài khoản/.test(err.message)) {
        // Bản chung đã đủ chỗ: chỉ sang chỗ tự dựng bản riêng (HTML cố định, không có dữ liệu người dùng)
        $("#authHint").innerHTML = L(
          'Bản chung đã đủ người. Bạn có thể tự dựng bản riêng miễn phí: <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/ptk862010/xteinklover" target="_blank" rel="noopener">Deploy to Cloudflare</a>.',
          'This shared copy is full. You can run your own for free: <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/ptk862010/xteinklover" target="_blank" rel="noopener">Deploy to Cloudflare</a>.',
        );
      }
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
    busy(e.currentTarget, L("Đang mở Google…", "Opening Google…"), () => googleGo("login")).catch((err) => { errEl.textContent = tr(err.message); errEl.hidden = false; });
  });

  const GOOGLE_RESULT = {
    ok: [L("Đã đăng nhập bằng Google", "Logged in with Google")],
    linked: [L("Đã liên kết Google. Lần sau bấm “Tiếp tục với Google” là vào.", "Google linked. Next time just tap “Continue with Google”.")],
    taken: [L("Google này đã gắn với một tài khoản khác", "This Google account is already linked to another account"), true],
    already: [L("Tài khoản này đã gắn một Google khác. Gỡ liên kết cũ trước", "This account is already linked to another Google account. Unlink it first"), true],
    cancel: [L("Đã hủy đăng nhập Google", "Google login cancelled"), true],
    expired: [L("Hết thời gian đăng nhập Google, thử lại nhé", "Google login timed out, please try again"), true],
    error: [L("Google chưa xác nhận được, thử lại nhé", "Google couldn't confirm your login, please try again"), true],
    closed: [L("Trang này chưa mở đăng ký tài khoản mới", "Sign-ups are currently closed on this site"), true],
    slow: [L("Đăng nhập Google quá nhiều lần, đợi 15 phút rồi thử lại", "Too many Google login attempts. Wait 15 minutes and try again"), true],
    off: [L("Trang này chưa bật đăng nhập bằng Google", "Google login isn't enabled on this site"), true],
  };

  function hidePick() {
    $("#pickCard").hidden = true;
    $("#authCard").hidden = false;
    $("#pickError").hidden = true;
  }

  async function showPick() {
    let p;
    try { p = await api("/api/google/pending"); }
    catch { toast(L("Hết thời gian chọn tên, bấm “Tiếp tục với Google” lại nhé", "Time to pick a username ran out. Tap “Continue with Google” again"), true); return loadMe(); }
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
    await busy(btn, L("Đang tạo tài khoản…", "Creating account…"), async () => {
      try {
        const res = await api("/api/google/signup", { json: code ? { username, code } : { username } });
        $("#pickCode").value = "";
        hidePick();
        await loadMe();
        showKey(res.opdsKey);
        openSheet("connectSheet");
        toast(L("Đã tạo tài khoản. Lưu khóa OPDS này lại để nối máy.", "Account created. Save this OPDS key to connect your reader."));
      } catch (err) {
        if (err.status === 410) { hidePick(); toast(tr(err.message), true); }
        else fail(tr(err.message));
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
    await busy(btn, L("Đang mở Google…", "Opening Google…"), async () => {
      try {
        if (me.user.hasPassword) {
          const pw = $("#linkPass").value;
          if (!pw) throw new Error(L("Nhập mật khẩu hiện tại để xác nhận", "Enter your current password to confirm"));
          extra.proof = await passwordProof(me.user.username, pw);
        }
        await googleGo("link", extra);
      } catch (err) { toast(tr(err.message), true); }
    });
  });

  $("#unlinkBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.busy) return;
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1"; btn.textContent = L("Bấm lần nữa để gỡ", "Tap again to unlink");
      setTimeout(() => { btn.dataset.armed = ""; if (!btn.dataset.busy) btn.textContent = L("Gỡ liên kết Google", "Unlink Google"); }, 3000);
      return;
    }
    btn.dataset.armed = ""; btn.textContent = L("Gỡ liên kết Google", "Unlink Google");
    await busy(btn, L("Đang gỡ…", "Unlinking…"), async () => {
      try { await api("/api/google/unlink", { json: {} }); me.user.google = false; renderAccount(); toast(L("Đã gỡ liên kết Google", "Google unlinked")); }
      catch (err) { toast(tr(err.message), true); }
    });
  });

  // ── Kệ sách ──
  function render() {
    const q = $("#search").value.trim().toLowerCase();
    const list = books.filter((b) => !q || (b.title + " " + b.author).toLowerCase().includes(q));
    $("#count").textContent = books.length ? L(`${books.length} cuốn`, `${books.length} ${books.length === 1 ? "book" : "books"}`) : "";
    $("#empty").hidden = books.length > 0;
    $("#books").innerHTML = list.map((b) => {
      const h = hue(b.title);
      return `<article class="book" data-id="${esc(b.id)}">
        <div class="cover" style="background: linear-gradient(160deg, hsl(${h} 45% 42%), hsl(${(h + 40) % 360} 55% 28%))"><span>${esc(b.title)}</span></div>
        <div class="meta"><b title="${esc(b.title)}">${esc(b.title)}</b>${esc(b.author || "—")} · ${fmtSize(b.size)} · ${fmtDate(b.added)}</div>
        <div class="acts"><a class="btn" href="/books/${encodeURIComponent(b.id)}.epub">${L("Tải", "Download")}</a><button class="btn danger" data-del="${esc(b.id)}" type="button">${L("Xóa", "Delete")}</button></div>
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
    } catch (e) { if (me) toast(L("Không tải được kệ: ", "Couldn't load your shelf: ") + tr(e.message), true); }
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
    li.innerHTML = `<div class="spin"></div><div class="name">${esc(name)}</div><div class="st">${L("Đang chuyển…", "Converting…")}</div>`;
    $("#queue").append(li);
    return {
      set(st) { li.querySelector(".st").textContent = st; },
      done(st) { li.className = "ok"; li.querySelector(".spin").outerHTML = "<span>✓</span>"; this.set(st); setTimeout(() => li.remove(), 4000); },
      fail(st) { li.className = "err"; li.querySelector(".spin").outerHTML = "<span>✕</span>"; this.set(st); },
    };
  }

  async function upload(result, q) {
    if (me && result.bytes.length > me.limits.maxUploadBytes) throw new Error(L("File quá ", "File is larger than ") + fmtSize(me.limits.maxUploadBytes));
    q.set(L("Đang gửi lên kệ…", "Sending to shelf…"));
    const qs = "?title=" + encodeURIComponent(result.title) + "&author=" + encodeURIComponent(result.author || "");
    const j = await api("/api/books" + qs, { method: "POST", headers: { "Content-Type": "application/epub+zip" }, body: new Blob([result.bytes]) });
    return j.book;
  }

  /** Bộ chuyển đổi là ES module (nạp sau app.js): đợi tới khi sẵn sàng. */
  async function converter() {
    for (let i = 0; i < 100 && !window.XteinkConvert; i++) await new Promise((r) => setTimeout(r, 100));
    if (!window.XteinkConvert) throw new Error(L("Chưa tải xong bộ chuyển đổi, tải lại trang rồi thử lại", "The converter hasn't finished loading. Reload the page and try again"));
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
        const unit = /\.(pdf|cbz)$/i.test(f.name) ? L("trang", "page") : L("phần", "part");
        if (pdfMode === "auto" && /\.pdf$/i.test(f.name)) {
          q.set(L("Đang xem PDF…", "Checking PDF…"));
          const p = await conv.probePdf(f);
          q.set(L(`PDF ${p.pages} trang → ${p.mode === "image" ? "ảnh trang" : "chữ"}…`, `PDF ${p.pages} pages → ${p.mode === "image" ? "page images" : "text"}…`));
        }
        const res = await conv.convertFile(f, { ...opts, pdfMode, onProgress: (d, t) => q.set(L(`Đang chuyển… ${unit} ${d}/${t}${t > 30 ? " · giữ trang này mở" : ""}`, `Converting… ${unit} ${d}/${t}${t > 30 ? " · keep this page open" : ""}`)) });
        if (my !== epoch) break;
        const book = await upload(res, q);
        if (my !== epoch) break;
        q.done(res.note ? L(`Đã lên kệ (${res.note})`, `Added to shelf (${tr(res.note)})`) : L("Đã lên kệ", "Added to shelf"));
        ok++;
        books.unshift(book); render();
      } catch (e) { q.fail(L("Lỗi: ", "Error: ") + tr(e.message)); }
    }
    if (my === epoch) refreshUsage();
    return ok;
  }

  /** Link bài viết → EPUB → lên kệ. */
  async function sendLink(raw) {
    const url = (raw || "").trim();
    if (!/^https?:\/\/\S+$/i.test(url)) return toast(L("Dán link bắt đầu bằng http:// hoặc https://", "Paste a link starting with http:// or https://"), true);
    const my = epoch;
    let host = url;
    try { host = new URL(url).hostname; } catch { /* để nguyên */ }
    const q = queueItem(host);
    try {
      const conv = await converter();
      const res = await conv.clipUrl(url, (msg) => q.set(tr(msg)));
      if (my !== epoch) return;
      const book = await upload(res, q);
      if (my !== epoch) return;
      q.done(L(`Đã lên kệ: ${res.title} (${res.note})`, `Added to shelf: ${res.title} (${tr(res.note)})`));
      books.unshift(book); render();
      refreshUsage();
      return true;
    } catch (e) { q.fail(L("Lỗi: ", "Error: ") + tr(e.message)); }
  }

  $("#clipForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    await busy($("#clipBtn"), L("Đang lấy…", "Fetching…"), async () => {
      if (await sendLink($("#clipUrl").value)) $("#clipUrl").value = "";
    });
  });

  // Dán từ trang web: giữ cấu trúc (tiêu đề, danh sách, link) bằng cách đổi HTML trong clipboard sang Markdown
  $("#pasteBody").addEventListener("paste", async (e) => {
    const html = e.clipboardData?.getData("text/html");
    if (!html || !/<(h[1-6]|p|ul|ol|li|a|strong|em|b|i|blockquote|table)\b/i.test(html)) return; // chữ trơn: để trình duyệt dán như thường
    e.preventDefault();
    const ta = e.currentTarget;
    const plain = e.clipboardData.getData("text/plain");
    let md = plain;
    try { md = await (await converter()).htmlToMarkdown(html) || plain; } catch { /* lỗi thì dán chữ trơn */ }
    ta.setRangeText(md, ta.selectionStart, ta.selectionEnd, "end");
    ta.dispatchEvent(new Event("input"));
  });

  function selectTab(name) {
    document.querySelectorAll("[data-tab]").forEach((x) => { const on = x.dataset.tab === name; x.classList.toggle("active", on); x.setAttribute("aria-selected", String(on)); });
    document.querySelectorAll("[data-tab-panel]").forEach((p) => (p.hidden = p.dataset.tabPanel !== name));
  }

  // Chia sẻ từ app khác (Android share target, phím tắt iPhone): /?url=… hoặc ?text=… có link
  function takeSharedLink() {
    const p = new URLSearchParams(location.search);
    const found = [p.get("url"), p.get("text"), p.get("title")].map((v) => (v || "").match(/https?:\/\/\S+/i)?.[0]).find(Boolean);
    if (found) {
      try { sessionStorage.setItem("xl_share", found); } catch { /* bỏ qua */ }
      history.replaceState(null, "", "/");
    }
  }
  function consumeSharedLink() {
    let link = null;
    try { link = sessionStorage.getItem("xl_share"); } catch { /* bỏ qua */ }
    if (!link || !me) return;
    try { sessionStorage.removeItem("xl_share"); } catch { /* bỏ qua */ }
    // Không tự gửi: link /?url=… ai cũng tạo được (gửi qua chat/email) → phải bấm “Lên kệ” mới chạy
    selectTab("link");
    $("#clipUrl").value = link;
    $("#clipForm").scrollIntoView({ block: "center" });
    $("#clipBtn").focus();
    let host = link;
    try { host = new URL(link).hostname; } catch { /* để nguyên */ }
    toast(L(`Bấm “Lên kệ” để lấy bài từ ${host}`, `Tap “Send to shelf” to fetch the article from ${host}`));
  }

  async function sendText() {
    const title = $("#pasteTitle").value.trim();
    const body = $("#pasteBody").value;
    if (!body.trim()) return toast(L("Chưa có nội dung", "Nothing to send yet"), true);
    const fallback = L("Ghi chú ", "Note ") + new Date().toLocaleDateString(LOCALE);
    const name = (title || fallback).replace(/[\\/:*?"<>|\r\n]+/g, " ") + ".md";
    await busy($("#pasteBtn"), L("Đang gửi…", "Sending…"), async () => {
      // Tiêu đề truyền riêng, không nhét vào frontmatter (giữ nguyên dấu ngoặc, frontmatter sẵn có của note).
      // Không gõ tiêu đề thì lấy từ frontmatter / H1 của văn bản; không có mới dùng "Ghi chú <ngày>".
      const ok = await sendFiles([new File([body], name, { type: "text/markdown" })], { title: title || undefined, fallbackTitle: fallback });
      if (ok > 0) { $("#pasteBody").value = ""; $("#pasteTitle").value = ""; }
    });
  }

  document.querySelectorAll("[data-tab]").forEach((t) => t.addEventListener("click", () => selectTab(t.dataset.tab)));

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
    if (!me) return toast(L("Đăng nhập trước rồi thả file nhé", "Log in first, then drop your files"), true);
    sendFiles([...e.dataTransfer.files]);
  });
  $("#pasteBtn").addEventListener("click", sendText);

  $("#search").addEventListener("input", render);
  $("#books").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-del]");
    if (!btn || btn.dataset.busy) return;
    if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = L("Chắc chứ?", "Sure?"); setTimeout(() => { btn.dataset.armed = ""; if (!btn.dataset.busy) btn.textContent = L("Xóa", "Delete"); }, 2500); return; }
    const id = btn.dataset.del;
    btn.dataset.armed = ""; btn.textContent = L("Xóa", "Delete");
    await busy(btn, L("Đang xóa…", "Deleting…"), async () => {
      try {
        await api("/api/books/" + encodeURIComponent(id), { method: "DELETE" });
        books = books.filter((b) => b.id !== id); render(); toast(L("Đã xóa khỏi kệ", "Removed from shelf"));
        refreshUsage();
      } catch (err) { toast(L("Xóa lỗi: ", "Delete failed: ") + tr(err.message), true); }
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
  $("#selfBtn").addEventListener("click", () => openSheet("selfSheet"));
  $("#accountBtn").addEventListener("click", () => { openSheet("accountSheet"); loadTokens(); });
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeSheets()));
  back.addEventListener("click", () => closeSheets());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheets(); });
  $("#opdsUrl").textContent = location.origin + "/opds";

  function showKey(key) {
    $("#opdsKey").textContent = key;
    $("#opdsKey").classList.add("fresh");
    $("#copyKey").hidden = false;
    $("#keyNote").innerHTML = L(
      "Đây là <b>khóa OPDS</b>, điền vào ô Password trên máy. Lưu lại ngay: đóng trang là không xem lại được.",
      "This is your <b>OPDS key</b>. Enter it in the Password field on your reader. Save it now: once you close this page you can't see it again.",
    );
  }

  $("#rotateKey").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.busy) return;
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1"; btn.textContent = L("Khóa cũ trên máy sẽ ngừng chạy. Bấm lần nữa", "The old key on your reader will stop working. Tap again");
      setTimeout(() => { btn.dataset.armed = ""; if (!btn.dataset.busy) btn.textContent = L("Tạo khóa mới", "New key"); }, 4000);
      return;
    }
    btn.dataset.armed = ""; btn.textContent = L("Tạo khóa mới", "New key");
    await busy(btn, L("Đang tạo…", "Creating…"), async () => {
      try { const r = await api("/api/opds-key", { method: "POST", json: {} }); showKey(r.opdsKey); toast(L("Đã tạo khóa mới, sửa lại Password trên máy", "New key created. Update the Password on your reader")); }
      catch (err) { toast(tr(err.message), true); }
    });
  });

  document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#" + b.dataset.copy).textContent); toast(L("Đã copy", "Copied")); } catch { toast(L("Không copy được, chọn tay nhé", "Couldn't copy, please select it manually"), true); }
  }));

  // ── Tài khoản ──
  $("#logoutBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.busy) return;
    let done = false;
    await busy(btn, L("Đang đăng xuất…", "Logging out…"), async () => {
      try { await api("/api/logout", { method: "POST", json: {} }); done = true; }
      catch (err) {
        if (err.status === 401) done = true; // phiên đã hết sẵn
        else toast(L("Chưa đăng xuất được — kiểm tra mạng rồi bấm lại", "Couldn't log out. Check your connection and try again"), true);
      }
    });
    if (done) { resetUserState(); lastUser = null; showAuth(); setAuthMode("login"); }
  });

  $("#pwForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter || $("#pwForm button");
    const u = me.user.username, current = $("#pwCurrent").value, next = $("#pwNext").value;
    if (!current) return toast(L("Nhập mật khẩu hiện tại", "Enter your current password"), true);
    const bad = checkNewPassword(u, next);
    if (bad) return toast(bad, true);
    await busy(btn, L("Đang mã hóa…", "Encrypting…"), async () => {
      try {
        const [cur, nxt] = await Promise.all([passwordProof(u, current), passwordProof(u, next)]);
        await api("/api/password", { json: { current: cur, next: nxt } });
        $("#pwCurrent").value = ""; $("#pwNext").value = "";
        toast(L(
          "Đã đổi mật khẩu: các nơi khác bị đăng xuất, mã ứng dụng bị thu hồi (tạo mã mới cho plugin). Nếu nghi bị lộ, bấm “Tạo khóa mới” ở ⚡ Nối máy.",
          "Password changed: other sessions were logged out and app tokens revoked (create a new one for the plugin). If you suspect a leak, tap “New key” under ⚡ Connect reader.",
        ));
        loadTokens();
      } catch (err) { toast(tr(err.message), true); }
    });
  });

  $("#delForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter || $("#delForm button");
    if (btn.dataset.busy) return;
    const googleOnly = !me.user.hasPassword;
    if (googleOnly && $("#delConfirm").value.trim().toLowerCase() !== me.user.username) return toast(L("Gõ đúng tên đăng nhập để xác nhận xóa", "Type your exact username to confirm deletion"), true);
    if (!googleOnly && !$("#delPass").value) return toast(L("Nhập mật khẩu để xác nhận xóa", "Enter your password to confirm deletion"), true);
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1"; btn.textContent = L("Chắc chắn xóa hết?", "Really delete everything?");
      setTimeout(() => { btn.dataset.armed = ""; if (!btn.dataset.busy) btn.textContent = L("Xóa vĩnh viễn", "Delete permanently"); }, 4000);
      return;
    }
    btn.dataset.armed = ""; btn.textContent = L("Xóa vĩnh viễn", "Delete permanently");
    const password = $("#delPass").value;
    await busy(btn, L("Đang xóa…", "Deleting…"), async () => {
      try {
        const body = googleOnly ? { confirm: me.user.username } : { proof: await passwordProof(me.user.username, password) };
        await api("/api/account", { method: "DELETE", json: body });
        resetUserState(); lastUser = null; showAuth(); setAuthMode("signup");
        toast(L("Đã xóa tài khoản", "Account deleted"));
      } catch (err) {
        if (err.data?.reauth) {
          // Phiên đã cũ: đăng nhập lại bằng Google rồi quay về bấm Xóa lần nữa
          try { sessionStorage.setItem("xl_reauth", "delete"); } catch { /* không có sessionStorage vẫn chạy */ }
          toast(L("Xác nhận lại bằng Google trước khi xóa…", "Confirm with Google again before deleting…"));
          try { await googleGo("login"); } catch (e2) { toast(tr(e2.message), true); }
        } else toast(tr(err.message), true);
      }
    });
  });

  // ── Ngôn ngữ ──
  $("#langBtn")?.addEventListener("click", () => XL_I18N.setLang(lang === "vi" ? "en" : "vi"));

  // ── Khởi động ──
  // Trang giới thiệu có sẵn trong HTML (cho máy tìm kiếm). Lần trước đã đăng nhập thì ẩn ngay, khỏi nháy
  // trong lúc chờ /api/me; loadMe sẽ quyết định hiện màn nào.
  try { if (localStorage.getItem("xl_signed_in") === "1") $("#authView").hidden = true; } catch { /* bỏ qua */ }

  async function boot() {
    const g = new URLSearchParams(location.search).get("google");
    if (g) history.replaceState(null, "", "/"); // bỏ ?google=… khỏi thanh địa chỉ
    takeSharedLink();
    $("#shortcutUrl").textContent = location.origin + "/?url=";
    try { cfg = { ...cfg, ...(await api("/api/config")) }; } catch { /* không có cấu hình: ẩn nút Google */ }
    $("#googleBox").hidden = !cfg.google;
    setAuthMode("login");
    if (g === "pick") return showPick();
    await loadMe();
    consumeSharedLink();
    const msg = GOOGLE_RESULT[g];
    if (msg) toast(msg[0], !!msg[1]);
    let reauth = null;
    try { reauth = sessionStorage.getItem("xl_reauth"); sessionStorage.removeItem("xl_reauth"); } catch { /* bỏ qua */ }
    if (me && g === "ok" && reauth === "token") {
      openSheet("accountSheet");
      loadTokens();
      $("#tokenForm").scrollIntoView({ block: "center" });
      toast(L("Đã xác nhận bằng Google. Bấm “Tạo mã” lần nữa trong 10 phút.", "Confirmed with Google. Tap “Create token” again within 10 minutes."));
    } else if (me && g === "ok" && reauth === "delete") {
      openSheet("accountSheet");
      $("#delConfirm").value = me.user.username;
      toast(L("Đã xác nhận bằng Google. Bấm “Xóa vĩnh viễn” lần nữa trong 10 phút nếu vẫn muốn xóa.", "Confirmed with Google. Tap “Delete permanently” again within 10 minutes if you still want to delete."));
    } else if (me && (g === "linked" || g === "taken" || g === "already")) openSheet("accountSheet");
  }
  boot();
})();

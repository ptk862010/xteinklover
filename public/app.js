(() => {
  const { L, tr, lang } = window.XL_I18N;
  const LOCALE = lang === "en" ? "en-GB" : "vi-VN";
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  let books = [];
  /** Tầng của người dùng; cách xem kệ: all | device | unsorted | authors | s:<id tầng> */
  let shelves = [];
  let view = "all";
  // Mặc định: cả kệ theo tầng (chưa có tầng nào thì tự thành "Tất cả")
  try { view = localStorage.getItem("xl_view2") || "shelf"; } catch { /* bỏ qua */ }
  let shelfTool = null; // null | "new" | "rename"
  let me = null;
  /** Cấu hình công khai của trang (/api/config): có bật Google không, đăng ký có cần mã mời không */
  let cfg = { google: false, signup: true, needsCode: false, selfHost: false };
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
    shelves = [];
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
    $("#syncPass").hidden = !u.hasPassword;
    $("#syncUserHidden").value = u.username;
    $("#syncUser").textContent = u.username;
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

  // ── Đồng bộ tiến độ đọc (KOSync: KOReader, CrossPoint) ──
  const groupCode = (c) => c.replace(/(\d{4})(?=\d)/g, "$1 ");
  async function loadSync() {
    const my = epoch;
    try {
      const r = await api("/api/sync-keys");
      if (my !== epoch) return;
      $("#syncKeyList").innerHTML = r.keys.map((k) => `<li><div><b>${esc(k.name)}</b><span class="muted small">${L("tạo ", "created ")}${esc(fmtDate(new Date(k.created).toISOString()))} · ${k.lastUsed ? L("đồng bộ lần cuối ", "last synced ") + esc(fmtDate(new Date(k.lastUsed).toISOString())) : L("chưa dùng", "never used")}</span></div><button class="btn tiny danger" data-revoke-sync="${esc(k.id)}" type="button">${L("Thu hồi", "Revoke")}</button></li>`).join("");
      $("#syncDocs").textContent = L(`Đã đồng bộ ${r.docs} cuốn.`, `${r.docs} book(s) synced.`);
      $("#syncClear").hidden = !r.docs;
    } catch { /* bỏ qua: không ảnh hưởng phần còn lại */ }
  }

  $("#syncForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter || $("#syncForm button");
    const name = $("#syncName").value.trim() || L("Máy đọc", "Reader");
    await busy(btn, L("Đang tạo…", "Creating…"), async () => {
      try {
        const body = { name };
        if (me.user.hasPassword) {
          const pw = $("#syncPass").value;
          if (!pw) throw new Error(L("Nhập mật khẩu hiện tại để xác nhận", "Enter your current password to confirm"));
          body.proof = await passwordProof(me.user.username, pw);
        }
        const r = await api("/api/sync-keys", { json: body });
        $("#syncPass").value = ""; $("#syncName").value = "";
        $("#syncCode").textContent = groupCode(r.code);
        $("#syncCode").dataset.raw = r.code;
        $("#syncNew").hidden = false;
        toast(L("Đã tạo mã đồng bộ. Gõ vào ô Password trên máy đọc ngay nhé", "Sync code created. Type it as the Password on your reader now"));
        loadSync();
      } catch (err) {
        if (err.data?.reauth) {
          try { sessionStorage.setItem("xl_reauth", "sync"); } catch { /* bỏ qua */ }
          toast(L("Xác nhận lại bằng Google trước khi tạo mã…", "Confirm with Google again before creating a code…"));
          try { await googleGo("login"); } catch (e2) { toast(tr(e2.message), true); }
        } else toast(tr(err.message), true);
      }
    });
  });

  // Chép chỉ 20 chữ số (không dấu cách): dán trên Android không dính khoảng trắng lạ
  $("#syncCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#syncCode").dataset.raw || ""); toast(L("Đã copy", "Copied")); } catch { toast(L("Không copy được, chọn tay nhé", "Couldn't copy, please select it manually"), true); }
  });

  $("#syncKeyList").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-revoke-sync]");
    if (!btn || btn.dataset.busy) return;
    if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = L("Chắc chứ?", "Sure?"); setTimeout(() => { btn.dataset.armed = ""; if (!btn.dataset.busy) btn.textContent = L("Thu hồi", "Revoke"); }, 2500); return; }
    btn.dataset.armed = ""; btn.textContent = L("Thu hồi", "Revoke");
    await busy(btn, L("Đang thu hồi…", "Revoking…"), async () => {
      try { await api("/api/sync-keys/" + encodeURIComponent(btn.dataset.revokeSync), { method: "DELETE" }); toast(L("Đã thu hồi mã, máy dùng mã đó hết đồng bộ được", "Code revoked. The reader using it can no longer sync")); loadSync(); }
      catch (err) { toast(tr(err.message), true); }
    });
  });

  $("#syncClear").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.busy) return;
    if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = L("Xóa hết tiến độ? Bấm lần nữa", "Clear all progress? Tap again"); setTimeout(() => { btn.dataset.armed = ""; if (!btn.dataset.busy) btn.textContent = L("Xóa dữ liệu đồng bộ", "Clear sync data"); }, 4000); return; }
    btn.dataset.armed = ""; btn.textContent = L("Xóa dữ liệu đồng bộ", "Clear sync data");
    await busy(btn, L("Đang xóa…", "Clearing…"), async () => {
      try { await api("/api/sync-progress", { method: "DELETE" }); toast(L("Đã xóa tiến độ đồng bộ", "Sync progress cleared")); loadSync(); }
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
      if (err.status === 403 && /Đã đủ số tài khoản/.test(err.message) && !cfg.selfHost) {
        // Bản tự dựng của người khác: đủ tài khoản thì hỏi chủ trang
        $("#authHint").textContent = L("Trang này đã đủ tài khoản. Hỏi chủ trang để được thêm chỗ nhé.", "This site has no free accounts left. Ask its owner for a spot.");
      } else if (err.status === 403 && /Đã đủ số tài khoản/.test(err.message)) {
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
  // Cách xem: all | device (Lên máy) | unsorted (Chưa phân loại) | authors (Theo tác giả) | s:<id tầng>
  function setView(v) {
    view = v; shelfTool = null;
    try { localStorage.setItem("xl_view2", v); } catch { /* bỏ qua */ }
    render();
  }
  const shelfOf = (b) => b.shelves || [];
  /** Còn thiếu tầng, tác giả hoặc bìa → nằm ở "Chưa phân loại" */
  const isUnsorted = (b) => !shelfOf(b).length || !b.author || !b.cover;
  const pct = (b) => (typeof b.progress === "number" ? Math.round(b.progress * 100) : null);

  function card(b) {
    const h = hue(b.title);
    const id = esc(b.id);
    const img = b.cover ? `<img src="/api/books/${encodeURIComponent(b.id)}/cover?v=${Number(b.cover)}" alt="" loading="lazy">` : "";
    const p = pct(b);
    const status = [b.onDevice && b.fetched ? L("✓ đã về máy", "✓ on reader") : "", p !== null ? L(`đọc ${p}%`, `${p}% read`) : ""].filter(Boolean).join(" · ");
    return `<article class="book" data-id="${id}">
      <div class="cover${img ? " has-img" : ""}" style="background: linear-gradient(160deg, hsl(${h} 45% 42%), hsl(${(h + 40) % 360} 55% 28%))">${img}<span>${esc(b.title)}</span>
        <button class="dev${b.onDevice ? " on" : ""}" type="button" data-dev="${id}" aria-pressed="${b.onDevice ? "true" : "false"}" title="${esc(L("Bật: máy đọc thấy cuốn này trong kệ OPDS", "On: your e-reader sees this book on its OPDS shelf"))}">${b.onDevice ? "⚡ " + L("Lên máy", "On device") : "＋ " + L("Lên máy", "Device")}</button>
        ${p !== null ? `<div class="prog" aria-hidden="true"><i style="width:${p}%"></i></div>` : ""}</div>
      <div class="meta"><b title="${esc(b.title)}">${esc(b.title)}</b>${esc(b.author || "—")} · ${fmtSize(b.size)} · ${fmtDate(b.added)}${status ? `<span class="st">${esc(status)}</span>` : ""}</div>
      <div class="acts"><a class="btn" href="/books/${encodeURIComponent(b.id)}.epub">${L("Tải", "Download")}</a><button class="btn" data-edit="${id}" type="button">${L("Sửa", "Edit")}</button><button class="btn danger" data-del="${id}" type="button">${L("Xóa", "Delete")}</button></div>
    </article>`;
  }

  function renderBar() {
    if (view.startsWith("s:") && !shelves.some((s) => "s:" + s.id === view)) view = "all";
    const cur0 = view === "shelf" && !shelves.length ? "all" : view;
    const chip = (v, label, n) => `<button class="chip${cur0 === v ? " on" : ""}" type="button" data-view="${esc(v)}" aria-pressed="${cur0 === v}">${esc(label)}${n === undefined ? "" : ` <span>${n}</span>`}</button>`;
    $("#shelfBar").innerHTML = [
      ...(shelves.length ? [chip("shelf", L("Kệ sách", "Bookcase"))] : []),
      chip("all", L("Tất cả", "All"), books.length),
      chip("device", L("⚡ Lên máy", "⚡ On device"), books.filter((b) => b.onDevice).length),
      chip("unsorted", L("Chưa phân loại", "Unsorted"), books.filter(isUnsorted).length),
      ...shelves.map((s) => chip("s:" + s.id, s.name, books.filter((b) => shelfOf(b).includes(s.id)).length)),
      chip("authors", L("Theo tác giả", "By author")),
      `<button class="chip add" type="button" data-newshelf>＋ ${L("Tầng", "Shelf")}</button>`,
    ].join("");
    const tools = $("#shelfTools");
    const cur = view.startsWith("s:") ? shelves.find((s) => "s:" + s.id === view) : null;
    if (shelfTool === "new" || (shelfTool === "rename" && cur)) {
      tools.innerHTML = `<input class="input" id="shelfName" maxlength="40" value="${esc(shelfTool === "rename" ? cur.name : "")}" placeholder="${esc(L("Tên tầng, vd Văn học", "Shelf name, e.g. Fiction"))}" aria-label="${esc(L("Tên tầng", "Shelf name"))}">
        <button class="btn primary" type="button" data-shelfsave>${shelfTool === "new" ? L("Tạo tầng", "Create") : L("Lưu tên", "Save")}</button><button class="btn ghost" type="button" data-shelfcancel>${L("Thôi", "Cancel")}</button>`;
    } else if (cur) {
      tools.innerHTML = `<span class="muted">${esc(L("Tầng", "Shelf"))} <b>${esc(cur.name)}</b>:</span><button class="btn" type="button" data-shelfrename>${L("Đổi tên", "Rename")}</button><button class="btn danger" type="button" data-shelfdel>${L("Xóa tầng", "Delete shelf")}</button><span class="muted small">${esc(L("Xóa tầng không xóa sách.", "Deleting a shelf keeps its books."))}</span>`;
    } else tools.innerHTML = "";
    tools.hidden = !tools.innerHTML;
    if (shelfTool) setTimeout(() => $("#shelfName")?.focus(), 0);
  }

  /** Một cuốn đứng trên tầng: chỉ bìa (như kệ thật), bấm vào để mở Sửa. */
  function spine(b) {
    const h = hue(b.title);
    const img = b.cover ? `<img src="/api/books/${encodeURIComponent(b.id)}/cover?v=${Number(b.cover)}" alt="" loading="lazy">` : "";
    const p = pct(b);
    const tip = [b.title, b.author, b.onDevice ? L("⚡ Lên máy", "⚡ On device") : "", b.onDevice && b.fetched ? L("đã về máy", "on reader") : "", p !== null ? L(`đọc ${p}%`, `${p}% read`) : ""].filter(Boolean).join(" · ");
    return `<button class="spine cover${img ? " has-img" : ""}" type="button" data-open="${esc(b.id)}" title="${esc(tip)}" aria-label="${esc(tip)}" style="background: linear-gradient(160deg, hsl(${h} 45% 42%), hsl(${(h + 40) % 360} 55% 28%))">${img}<span>${esc(b.title)}</span>
      ${b.onDevice ? `<i class="bolt" aria-hidden="true">⚡</i>` : ""}${p !== null ? `<i class="prog" aria-hidden="true"><i style="width:${p}%"></i></i>` : ""}</button>`;
  }

  /** Cả kệ: tầng Lên máy trên cùng, rồi các tầng tự tạo. Sách chưa phân loại không lên kệ, chỉ có dòng nhắc. */
  function renderCase() {
    const tier = (key, name, list, empty) => `<section class="tier"><h3 class="tier-name"><button type="button" data-view="${esc(key)}">${esc(name)} <span>${list.length}</span></button></h3>
      <div class="tier-row">${list.length ? list.map(spine).join("") : `<p class="tier-empty">${esc(empty)}</p>`}</div></section>`;
    const loose = books.filter(isUnsorted).length;
    $("#books").innerHTML = (loose ? `<button class="loose" type="button" data-view="unsorted">📥 ${esc(L(`${loose} cuốn chưa phân loại: thêm tác giả, bìa, tầng rồi nó tự lên kệ`, `${loose} unsorted: add an author, a cover and a shelf and it moves onto the bookcase`))} →</button>` : "")
      + tier("device", L("⚡ Lên máy", "⚡ On device"), books.filter((b) => b.onDevice), L("Chưa có cuốn nào. Mở một cuốn, tích Lên máy.", "Nothing yet. Open a book and tick On device."))
      + shelves.map((s) => tier("s:" + s.id, s.name, books.filter((b) => shelfOf(b).includes(s.id)), L("Tầng trống. Mở một cuốn, tích tầng này.", "Empty. Open a book and tick this shelf."))).join("");
  }

  function render() {
    renderBar();
    const q = $("#search").value.trim().toLowerCase();
    if (view === "shelf" && books.length && shelves.length && !q) {
      $("#count").textContent = L(`${books.length} cuốn`, `${books.length} ${books.length === 1 ? "book" : "books"}`);
      $("#empty").hidden = true;
      $("#shelfBar").hidden = false;
      return renderCase();
    }
    const inView = (b) => view === "device" ? b.onDevice : view === "unsorted" ? isUnsorted(b) : view.startsWith("s:") ? shelfOf(b).includes(view.slice(2)) : true;
    const list = books.filter((b) => (!q || (b.title + " " + b.author).toLowerCase().includes(q)) && inView(b));
    $("#count").textContent = books.length ? L(`${books.length} cuốn`, `${books.length} ${books.length === 1 ? "book" : "books"}`) : "";
    $("#empty").hidden = books.length > 0;
    $("#shelfBar").hidden = books.length === 0;
    if (!books.length) { $("#books").innerHTML = ""; return; }
    if (!list.length) {
      const msg = view === "unsorted" && !q ? L("Kệ gọn gàng: cuốn nào cũng đã có tầng, tác giả và bìa.", "All tidy: every book has a shelf, an author and a cover.")
        : view === "device" && !q ? L("Chưa có cuốn nào Lên máy. Bấm “＋ Lên máy” trên bìa để máy đọc thấy cuốn đó.", "Nothing on your device yet. Tap “＋ Device” on a cover so your e-reader sees it.")
        : L("Không có cuốn nào ở đây.", "No books here.");
      $("#books").innerHTML = `<p class="empty-view">${esc(msg)}</p>`;
      return;
    }
    if (view !== "authors") { $("#books").innerHTML = `<div class="grid">${list.map(card).join("")}</div>`; return; }
    const groups = new Map();
    for (const b of list) { const k = b.author || ""; groups.set(k, [...(groups.get(k) || []), b]); }
    const sorted = [...groups].sort((a, b) => (!a[0]) - (!b[0]) || b[1].length - a[1].length || a[0].localeCompare(b[0], LOCALE));
    $("#books").innerHTML = sorted.map(([a, bs]) => `<h3 class="group">${esc(a || L("Chưa rõ tác giả", "Unknown author"))} <span>${bs.length}</span></h3><div class="grid">${bs.map(card).join("")}</div>`).join("");
  }

  async function refresh() {
    const my = epoch;
    try {
      const [list, sh] = await Promise.all([api("/api/books"), api("/api/shelves")]);
      if (my !== epoch) return;
      books = list;
      shelves = sh;
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

  // ── Bìa sách (chỉ trên kệ web) ──
  async function saveCover(id, thumb) {
    const j = await api("/api/books/" + encodeURIComponent(id) + "/cover", { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: new Blob([thumb]) });
    const b = books.find((x) => x.id === id);
    if (b) { b.cover = j.cover; render(); }
  }

  /** Ảnh ứng viên (Google Books / Open Library) → tải qua máy chủ (CORS) → thu nhỏ → lưu. */
  async function applyCandidate(id, cand) {
    let r;
    try { r = await fetch(location.origin + "/api/fetch-image?url=" + encodeURIComponent(cand.image), { credentials: "same-origin" }); }
    catch { throw new Error(L("Mất kết nối mạng, thử lại", "Network connection lost, please try again")); }
    if (!r.ok) {
      let m = "";
      try { m = (await r.json()).error; } catch { /* không phải JSON */ }
      throw new Error(m || L(`Lỗi ${r.status}`, `Error ${r.status}`));
    }
    const thumb = await (await converter()).makeThumb(await r.blob());
    if (!thumb) throw new Error(L("Ảnh này hỏng, chọn bìa khác", "This image is broken, pick another cover"));
    await saveCover(id, thumb);
  }

  /** Sau khi gửi: bìa trong sách thì dùng luôn; không có mà sách có ISBN thì lấy bìa đúng bản in đó. Lỗi thì thôi. */
  async function attachCover(book, res) {
    const my = epoch;
    try {
      if (res.thumb) return await saveCover(book.id, res.thumb);
      if (!res.isbn) return;
      const found = await api("/api/covers/search?" + new URLSearchParams({ isbn: res.isbn, lang: res.lang || "" }));
      if (my === epoch && found.byIsbn && found.items[0]) await applyCandidate(book.id, found.items[0]);
    } catch { /* bìa không quan trọng bằng sách */ }
  }

  let coverFor = null;
  let coverCands = [];

  // ── Sửa sách: thông tin, Lên máy, tầng, ghi vào file ──
  function renderShelfChecks(checked) {
    $("#bfShelves").innerHTML = shelves.length
      ? shelves.map((s) => `<label><input type="checkbox" value="${esc(s.id)}"${checked.includes(s.id) ? " checked" : ""}>${esc(s.name)}</label>`).join("")
      : `<span class="muted small">${esc(L("Chưa có tầng nào. Gõ tên ở dưới để tạo.", "No shelves yet. Type a name below to create one."))}</span>`;
  }
  const checkedShelves = () => [...document.querySelectorAll("#bfShelves input:checked")].map((x) => x.value);

  function openBook(id) {
    const b = books.find((x) => x.id === id);
    if (!b) return;
    coverFor = id;
    $("#bfTitle").value = b.title;
    $("#bfAuthor").value = b.author || "";
    $("#bfIsbn").value = b.isbn || "";
    $("#bfDevice").checked = !!b.onDevice;
    // Máy đã tải bản này thì mặc định KHÔNG ghi file: file đổi thì máy phải tải lại, tiến độ đồng bộ tính theo file mới
    $("#bfWrite").checked = !b.fetched;
    $("#bfWriteNote").textContent = b.fetched
      ? L("Ghi tên, tác giả vào file EPUB. Máy đã tải cuốn này: ghi thì phải tải lại, tiến độ đồng bộ của file mới bắt đầu lại.", "Write title and author into the EPUB. Your reader already has this book: it will need to download it again, and synced progress restarts for the new file.")
      : L("Ghi tên, tác giả vào file EPUB (máy đọc hiện đúng tên mới).", "Write title and author into the EPUB file (the reader shows the new name).");
    $("#bfNewShelf").value = "";
    $("#bfStatus").textContent = "";
    $("#bfDownload").href = "/books/" + encodeURIComponent(b.id) + ".epub";
    renderShelfChecks(shelfOf(b));
    $("#coverTitleIn").value = b.title;
    $("#coverAuthorIn").value = b.author || "";
    $("#coverResults").innerHTML = "";
    $("#coverStatus").textContent = "";
    openSheet("bookSheet");
    searchCovers();
  }

  /** Tải file từ kệ → ghi tên / tác giả vào OPF (trên trình duyệt) → gửi lại thay file cũ. */
  async function writeMetaToFile(b, title, author) {
    const r = await fetch(location.origin + "/books/" + encodeURIComponent(b.id) + ".epub", { credentials: "same-origin" });
    if (!r.ok) throw new Error(L(`Không tải được sách (lỗi ${r.status})`, `Couldn't download the book (error ${r.status})`));
    const out = await (await converter()).rewriteMeta(new Uint8Array(await r.arrayBuffer()), { title, author });
    if (me && out.length > me.limits.maxUploadBytes) throw new Error(L("File quá ", "File is larger than ") + fmtSize(me.limits.maxUploadBytes));
    const j = await api("/api/books/" + encodeURIComponent(b.id) + "/file", { method: "PUT", headers: { "Content-Type": "application/epub+zip" }, body: new Blob([out]) });
    b.size = j.size; b.fetched = 0; b.progress = null;
  }

  $("#bookForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const b = books.find((x) => x.id === coverFor);
    if (!b) return;
    busy($("#bfSave"), L("Đang lưu…", "Saving…"), async () => {
      const title = $("#bfTitle").value.trim(), author = $("#bfAuthor").value.trim();
      const patch = { title, author, isbn: $("#bfIsbn").value.trim(), onDevice: $("#bfDevice").checked, shelves: checkedShelves() };
      const renamed = title !== b.title || author !== (b.author || "");
      try {
        await api("/api/books/" + encodeURIComponent(b.id), { method: "PATCH", json: patch });
        Object.assign(b, { title, author, isbn: patch.isbn.replace(/[\s-]/g, "").toUpperCase(), onDevice: patch.onDevice, shelves: patch.shelves });
        if ($("#bfWrite").checked && renamed) {
          $("#bfStatus").textContent = L("Đang ghi vào file…", "Writing into the file…");
          await writeMetaToFile(b, title, author);
        }
        render(); refreshUsage(); closeSheets();
        toast(L("Đã lưu", "Saved"));
      } catch (err) { $("#bfStatus").textContent = L("Lỗi: ", "Error: ") + tr(err.message); render(); }
    });
  });

  async function createShelf(name) {
    const s = await api("/api/shelves", { json: { name } });
    shelves = [...shelves, s].sort((a, b) => a.name.localeCompare(b.name, LOCALE));
    return s;
  }
  $("#bfAddShelf").addEventListener("click", (e) => busy(e.currentTarget, "…", async () => {
    const name = $("#bfNewShelf").value.trim();
    if (!name) return $("#bfNewShelf").focus();
    try {
      const keep = checkedShelves();
      const s = await createShelf(name);
      renderShelfChecks([...keep, s.id]);
      $("#bfNewShelf").value = "";
      render();
    } catch (err) { $("#bfStatus").textContent = tr(err.message); }
  }));
  $("#bfNewShelf").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#bfAddShelf").click(); } });

  // Thanh tầng: chọn cách xem, tạo / đổi tên / xóa tầng
  $("#shelfBar").addEventListener("click", (e) => {
    const v = e.target.closest("[data-view]")?.dataset.view;
    if (v) return setView(v);
    if (e.target.closest("[data-newshelf]")) { shelfTool = "new"; renderBar(); }
  });
  async function saveShelfTool() {
    const name = $("#shelfName").value.trim();
    if (!name) return;
    try {
      if (shelfTool === "new") {
        const s = await createShelf(name);
        shelfTool = null;
        setView("s:" + s.id);
        toast(L(`Đã tạo tầng “${s.name}”. Bấm Sửa ở từng cuốn để xếp vào.`, `Created “${s.name}”. Tap Edit on a book to add it.`));
      } else {
        const id = view.slice(2);
        await api("/api/shelves/" + encodeURIComponent(id), { method: "PATCH", json: { name } });
        shelves = shelves.map((s) => (s.id === id ? { ...s, name } : s));
        shelfTool = null; render();
      }
    } catch (err) { toast(tr(err.message), true); }
  }
  $("#shelfTools").addEventListener("keydown", (e) => {
    if (e.target.id !== "shelfName") return;
    if (e.key === "Enter") { e.preventDefault(); saveShelfTool(); }
    if (e.key === "Escape") { e.stopPropagation(); shelfTool = null; renderBar(); }
  });
  $("#shelfTools").addEventListener("click", async (e) => {
    if (e.target.closest("[data-shelfsave]")) return saveShelfTool();
    if (e.target.closest("[data-shelfcancel]")) { shelfTool = null; return renderBar(); }
    if (e.target.closest("[data-shelfrename]")) { shelfTool = "rename"; return renderBar(); }
    const del = e.target.closest("[data-shelfdel]");
    if (!del || del.dataset.busy) return;
    if (del.dataset.armed !== "1") { del.dataset.armed = "1"; del.textContent = L("Chắc chứ?", "Sure?"); setTimeout(() => { if (del.isConnected) { del.dataset.armed = ""; del.textContent = L("Xóa tầng", "Delete shelf"); } }, 2500); return; }
    const id = view.slice(2);
    await busy(del, L("Đang xóa…", "Deleting…"), async () => {
      try {
        await api("/api/shelves/" + encodeURIComponent(id), { method: "DELETE" });
        shelves = shelves.filter((s) => s.id !== id);
        books.forEach((b) => { b.shelves = shelfOf(b).filter((x) => x !== id); });
        setView("all");
        toast(L("Đã xóa tầng (sách vẫn còn)", "Shelf deleted (books kept)"));
      } catch (err) { toast(tr(err.message), true); }
    });
  });

  async function searchCovers() {
    const id = coverFor;
    const title = $("#coverTitleIn").value.trim();
    const author = $("#coverAuthorIn").value.trim();
    if (!title) { $("#coverStatus").textContent = L("Nhập tên sách để tìm", "Enter a title to search"); return; }
    $("#coverStatus").textContent = L("Đang tìm…", "Searching…");
    $("#coverResults").innerHTML = "";
    try {
      const j = await api("/api/covers/search?" + new URLSearchParams({ title, author, lang: lang === "en" ? "" : "vi" }));
      if (id !== coverFor) return;
      coverCands = j.items;
      $("#coverStatus").textContent = j.items.length
        ? L(`Tìm được ${j.items.length} bìa. Chưa đúng thì thử bỏ tác giả, hoặc tìm bằng tên gốc.`, `Found ${j.items.length} covers. Not it? Try without the author, or the original title.`)
        : L("Không tìm thấy bìa nào. Thử bỏ tác giả, hoặc tìm bằng tên gốc (tiếng Anh).", "No covers found. Try without the author, or the original title.");
      $("#coverResults").innerHTML = j.items.map((c, i) => `<button class="cand" type="button" data-cand="${i}" title="${esc(c.title)}">
        <img src="${esc(c.thumb)}" alt="" loading="lazy">
        <span class="t">${esc(c.title)}</span>
        <span class="s">${esc([c.publisher, c.year, (c.lang || "").toUpperCase()].filter(Boolean).join(" · "))}</span>
      </button>`).join("");
    } catch (e) { if (id === coverFor) $("#coverStatus").textContent = tr(e.message); }
  }

  $("#coverForm").addEventListener("submit", (e) => { e.preventDefault(); busy($("#coverSearchBtn"), L("Đang tìm…", "Searching…"), searchCovers); });
  // Ảnh không tải được (Google / Open Library lỗi) thì bỏ luôn ô đó
  $("#coverResults").addEventListener("error", (e) => { if (e.target.tagName === "IMG") e.target.closest(".cand")?.remove(); }, true);
  $("#coverResults").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-cand]");
    const cand = btn && coverCands[Number(btn.dataset.cand)];
    if (!cand || !coverFor || btn.disabled) return;
    const id = coverFor;
    const all = document.querySelectorAll(".cand");
    all.forEach((x) => (x.disabled = true));
    $("#coverStatus").textContent = L("Đang lưu bìa…", "Saving cover…");
    try { await applyCandidate(id, cand); closeSheets(); toast(L("Đã đổi bìa", "Cover updated")); }
    catch (err) { $("#coverStatus").textContent = L("Lỗi: ", "Error: ") + tr(err.message); }
    finally { all.forEach((x) => (x.disabled = false)); }
  });
  $("#coverFromFile").addEventListener("click", (e) => busy(e.currentTarget, L("Đang đọc file…", "Reading file…"), async () => {
    const id = coverFor;
    try {
      const r = await fetch(location.origin + "/books/" + encodeURIComponent(id) + ".epub", { credentials: "same-origin" });
      if (!r.ok) throw new Error(L(`Không tải được sách (lỗi ${r.status})`, `Couldn't download the book (error ${r.status})`));
      const meta = await (await converter()).readBook(new Uint8Array(await r.arrayBuffer()));
      if (!meta.thumb) { $("#coverStatus").textContent = L("File này không có ảnh bìa. Tìm trên mạng ở dưới nhé.", "This file has no cover image. Search online below."); return; }
      await saveCover(id, meta.thumb);
      if (id === coverFor) { closeSheets(); toast(L("Đã lấy bìa trong file", "Cover taken from the file")); }
    } catch (err) { $("#coverStatus").textContent = L("Lỗi: ", "Error: ") + tr(err.message); }
  }));

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
        attachCover(book, res);
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

  /** Bật / tắt "Lên máy" ngay trên bìa. */
  async function toggleDevice(btn) {
    const b = books.find((x) => x.id === btn.dataset.dev);
    if (!b || btn.dataset.busy) return;
    btn.dataset.busy = "1";
    const next = !b.onDevice;
    try {
      await api("/api/books/" + encodeURIComponent(b.id), { method: "PATCH", json: { onDevice: next } });
      b.onDevice = next;
      render();
      toast(next ? L("Đã cho lên máy: lần sau mở kệ OPDS trên máy là thấy", "On device: it shows up next time your reader opens the OPDS shelf") : L("Đã bỏ khỏi máy (sách vẫn trên kệ web)", "Removed from device (still on your web shelf)"));
    } catch (err) { delete btn.dataset.busy; toast(tr(err.message), true); }
  }

  $("#search").addEventListener("input", render);
  $("#books").addEventListener("click", async (e) => {
    const edit = e.target.closest("[data-edit], [data-open]");
    if (edit) return openBook(edit.dataset.edit || edit.dataset.open);
    const go = e.target.closest("[data-view]");
    if (go) return setView(go.dataset.view);
    const dev = e.target.closest("[data-dev]");
    if (dev) return toggleDevice(dev);
    const btn = e.target.closest("[data-del]");
    if (!btn || btn.dataset.busy) return;
    if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = L("Chắc chứ?", "Sure?"); setTimeout(() => { btn.dataset.armed = ""; if (!btn.dataset.busy) btn.textContent = L("Xóa", "Delete"); }, 2500); return; }
    const id = btn.dataset.del;
    btn.dataset.armed = ""; btn.textContent = L("Xóa", "Delete");
    await busy(btn, L("Đang xóa…", "Deleting…"), () => deleteBook(id));
  });

  async function deleteBook(id) {
    try {
      await api("/api/books/" + encodeURIComponent(id), { method: "DELETE" });
      books = books.filter((b) => b.id !== id); render(); toast(L("Đã xóa khỏi kệ", "Removed from shelf"));
      refreshUsage();
      return true;
    } catch (err) { toast(L("Xóa lỗi: ", "Delete failed: ") + tr(err.message), true); return false; }
  }

  // Trong hộp Sửa: xóa cần bấm hai lần
  $("#bfDelete").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.busy || !coverFor) return;
    if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = L("Bấm lần nữa để xóa", "Tap again to delete"); setTimeout(() => { btn.dataset.armed = ""; if (!btn.dataset.busy) btn.textContent = L("Xóa sách", "Delete book"); }, 2500); return; }
    btn.dataset.armed = "";
    const id = coverFor;
    await busy(btn, L("Đang xóa…", "Deleting…"), async () => { if (await deleteBook(id)) closeSheets(); });
    btn.textContent = L("Xóa sách", "Delete book");
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
  $("#connectBtn").addEventListener("click", () => { openSheet("connectSheet"); loadSync(); });
  $("#selfBtn").addEventListener("click", () => openSheet("selfSheet"));
  $("#demoSelf").addEventListener("click", () => openSheet("selfSheet"));
  $("#accountBtn").addEventListener("click", () => { openSheet("accountSheet"); loadTokens(); });
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeSheets()));
  back.addEventListener("click", () => closeSheets());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheets(); });
  $("#opdsUrl").textContent = location.origin + "/opds";
  $("#syncServer").textContent = location.origin;

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
        const keepSyncKeys = $("#pwKeepSync").checked;
        await api("/api/password", { json: { current: cur, next: nxt, keepSyncKeys } });
        $("#pwCurrent").value = ""; $("#pwNext").value = ""; $("#pwKeepSync").checked = false;
        toast(L(
          "Đã đổi mật khẩu: các nơi khác bị đăng xuất, mã ứng dụng bị thu hồi (tạo mã mới cho plugin)" + (keepSyncKeys ? "" : ", mã đồng bộ của máy đọc cũng bị thu hồi") + ". Nếu nghi bị lộ, bấm “Tạo khóa mới” ở ⚡ Nối máy.",
          "Password changed: other sessions were logged out and app tokens revoked (create a new one for the plugin)" + (keepSyncKeys ? "" : ", and your readers' sync codes too") + ". If you suspect a leak, tap “New key” under ⚡ Connect reader.",
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
    // Nút "Tự dựng" / Deploy chỉ có ở bản chung của tác giả (SHOW_SELF_HOST); bản tự dựng chỉ giữ dòng ghi công
    $("#selfBtn").hidden = !cfg.selfHost;
    $("#demoBar").hidden = !cfg.selfHost;
    $("#footSelfHost").hidden = !cfg.selfHost;
    $("#footCredit").hidden = !!cfg.selfHost;
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
    } else if (me && g === "ok" && reauth === "sync") {
      openSheet("connectSheet");
      loadSync();
      $("#syncForm").scrollIntoView({ block: "center" });
      toast(L("Đã xác nhận bằng Google. Bấm “Tạo mã đồng bộ” lần nữa trong 10 phút.", "Confirmed with Google. Tap “Create sync code” again within 10 minutes."));
    } else if (me && g === "ok" && reauth === "delete") {
      openSheet("accountSheet");
      $("#delConfirm").value = me.user.username;
      toast(L("Đã xác nhận bằng Google. Bấm “Xóa vĩnh viễn” lần nữa trong 10 phút nếu vẫn muốn xóa.", "Confirmed with Google. Tap “Delete permanently” again within 10 minutes if you still want to delete."));
    } else if (me && (g === "linked" || g === "taken" || g === "already")) openSheet("accountSheet");
  }
  boot();
})();

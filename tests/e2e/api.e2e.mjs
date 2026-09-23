// Test tích hợp chạy trên `wrangler dev` (D1 + KV local).
// Chạy: npm run test:e2e  (tự bật wrangler dev với state sạch, xem scripts/e2e.mjs)
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto as crypto } from "node:crypto";
import http from "node:http";

const BASE = process.env.BASE || "http://127.0.0.1:8799";
const enc = new TextEncoder();

async function proof(username, password) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode("xteinklover|v1|" + username), iterations: 600000 }, key, 256);
  return Buffer.from(bits).toString("hex");
}

/** Client giữ cookie như trình duyệt (cả cookie phiên lẫn cookie thiết bị), luôn gửi Origin đúng. */
function client() {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  return {
    /** Chỉ cookie phiên (để gửi riêng khi tải sách). */
    get cookie() { return jar.has("xl_session") ? `xl_session=${jar.get("xl_session")}` : ""; },
    forgetSession() { jar.delete("xl_session"); },
    cookieValue(name) { return jar.get(name); },
    async req(path, { method = "GET", json, body, headers = {}, origin = BASE } = {}) {
      const h = { ...headers };
      if (jar.size) h.Cookie = cookieHeader();
      if (origin && method !== "GET") h.Origin = origin;
      if (json !== undefined) { h["Content-Type"] = "application/json"; body = JSON.stringify(json); }
      const r = await fetch(BASE + path, { method, headers: h, body, redirect: "manual" });
      for (const set of r.headers.getSetCookie()) {
        const m = set.match(/^([^=]+)=([^;]*)/);
        if (!m) continue;
        if (m[2] && !/Max-Age=0/i.test(set)) jar.set(m[1], m[2]);
        else jar.delete(m[1]);
      }
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: r.status, data, headers: r.headers };
    },
  };
}

const basic = (u, p) => ({ Authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") });
const fakeEpub = (n = 2048) => { const b = new Uint8Array(n); b.set([0x50, 0x4b, 0x03, 0x04]); return b; };

async function signup(c, username, password = "matkhau-dai-1", extra = {}) {
  return c.req("/api/signup", { method: "POST", json: { username, proof: await proof(username, password), ...extra } });
}

async function uploadBook(c, title = "Sách thử", bytes = fakeEpub()) {
  const qs = `?title=${encodeURIComponent(title)}&author=${encodeURIComponent("Tác giả")}`;
  return c.req("/api/books" + qs, { method: "POST", body: bytes, headers: { "Content-Type": "application/epub+zip" } });
}

const U = "an" + Date.now().toString(36).slice(-5);
const V = "binh" + Date.now().toString(36).slice(-5);
const A = client();
const B = client();
let opdsKeyA = "";
let bookA = "";

test("trang tĩnh công khai, API cần đăng nhập", async () => {
  const home = await fetch(BASE + "/");
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Xteink/);
  assert.equal((await client().req("/api/me")).status, 401);
  assert.equal((await client().req("/api/books")).status, 401);
  const opds = await fetch(BASE + "/opds");
  assert.equal(opds.status, 401);
  assert.match(opds.headers.get("www-authenticate") || "", /Basic/);
});

test("đăng ký: kiểm tên, proof, trả khóa OPDS + cookie phiên", async () => {
  assert.equal((await client().req("/api/signup", { method: "POST", json: { username: "Ab", proof: "0".repeat(64) } })).status, 400);
  assert.equal((await client().req("/api/signup", { method: "POST", json: { username: "hople", proof: "password123" } })).status, 400);
  const r = await signup(A, U);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.user.username, U);
  assert.match(r.data.opdsKey, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
  assert.ok(A.cookie.startsWith("xl_session="), "cookie phiên");
  opdsKeyA = r.data.opdsKey;
  const dup = await signup(client(), U.toUpperCase());
  assert.equal(dup.status, 409, "trùng tên (không phân biệt hoa thường)");
});

test("chặn CSRF: POST khác origin hoặc thiếu Origin bị từ chối", async () => {
  const r = await A.req("/api/opds-key", { method: "POST", json: {}, origin: "https://evil.example" });
  assert.equal(r.status, 403);
  const r2 = await A.req("/api/opds-key", { method: "POST", json: {}, origin: null });
  assert.equal(r2.status, 403);
});

test("me trả hạn mức", async () => {
  const r = await A.req("/api/me");
  assert.equal(r.status, 200);
  assert.equal(r.data.user.username, U);
  assert.equal(r.data.usage.books, 0);
  assert.ok(r.data.limits.maxUploadBytes > 0);
});

test("gửi sách: chỉ nhận ZIP/EPUB, lên kệ, đếm lượt", async () => {
  const bad = await uploadBook(A, "x", enc.encode("không phải zip"));
  assert.equal(bad.status, 415);
  const r = await uploadBook(A, "Sách <b>của</b> An & Bình");
  assert.equal(r.status, 201, JSON.stringify(r.data));
  bookA = r.data.book.id;
  const list = await A.req("/api/books");
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].title, "Sách <b>của</b> An & Bình");
  assert.equal(list.data[0].user_id, undefined, "không lộ user_id");
  const me = await A.req("/api/me");
  assert.equal(me.data.usage.books, 1);
  assert.equal(me.data.usage.uploadsToday, 1);
});

test("máy đọc: OPDS bằng khóa, gõ hoa/không gạch vẫn được; sai khóa hoặc dùng mật khẩu thì 401", async () => {
  const ok = await fetch(BASE + "/opds", { headers: basic(U, opdsKeyA) });
  assert.equal(ok.status, 200);
  const xml = await ok.text();
  assert.match(xml, /application\/epub\+zip/);
  assert.ok(xml.includes("Sách &lt;b&gt;của&lt;/b&gt; An &amp; Bình"), "escape XML");
  assert.ok(xml.includes(`/books/${bookA}.epub`));
  assert.equal((await fetch(BASE + "/opds", { headers: basic(U.toUpperCase(), opdsKeyA.replace(/-/g, "").toUpperCase()) })).status, 200);
  assert.equal((await fetch(BASE + "/opds", { headers: basic(U, "sai-khoa-xxxx-yyyy") })).status, 401);
  assert.equal((await fetch(BASE + "/opds", { headers: basic(U, "matkhau-dai-1") })).status, 401);
  assert.equal((await fetch(BASE + "/opds", { headers: basic("khongco", opdsKeyA) })).status, 401);
});

test("tải sách: máy (Basic) và trình duyệt (cookie) đều được, nguyên byte", async () => {
  const d = await fetch(`${BASE}/books/${bookA}.epub`, { headers: basic(U, opdsKeyA) });
  assert.equal(d.status, 200);
  assert.equal(d.headers.get("content-type"), "application/epub+zip");
  const bytes = new Uint8Array(await d.arrayBuffer());
  assert.equal(bytes.length, 2048);
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.match(d.headers.get("content-disposition") || "", /filename\*=UTF-8''/);
  const c = await fetch(`${BASE}/books/${bookA}.epub`, { headers: { Cookie: A.cookie } });
  assert.equal(c.status, 200);
});

test("người khác không xem, không tải, không xóa được sách của mình", async () => {
  const r = await signup(B, V);
  assert.equal(r.status, 201);
  const keyB = r.data.opdsKey;
  assert.equal((await B.req("/api/books")).data.length, 0);
  assert.equal((await fetch(`${BASE}/books/${bookA}.epub`, { headers: basic(V, keyB) })).status, 404);
  assert.equal((await fetch(`${BASE}/books/${bookA}.epub`, { headers: { Cookie: B.cookie } })).status, 404);
  assert.equal((await B.req(`/api/books/${bookA}`, { method: "DELETE" })).status, 404);
  const feedB = await (await fetch(BASE + "/opds", { headers: basic(V, keyB) })).text();
  assert.ok(!feedB.includes(bookA));
  // Khóa của A không dùng được cho tên B
  assert.equal((await fetch(BASE + "/opds", { headers: basic(V, opdsKeyA) })).status, 401);
  assert.equal((await A.req("/api/books")).data.length, 1);
});

test("OPDS chia trang 50 cuốn (máy chỉ giữ 62 mục mỗi trang), có link next/previous", async () => {
  const c = client();
  const name = "trang" + Date.now().toString(36).slice(-5);
  const r = await signup(c, name);
  assert.equal(r.status, 201);
  for (let i = 0; i < 51; i++) assert.equal((await uploadBook(c, `Cuốn ${i}`, fakeEpub(64))).status, 201, `cuốn ${i}`);
  const h = basic(name, r.data.opdsKey);
  const p1 = await (await fetch(BASE + "/opds", { headers: h })).text();
  assert.equal((p1.match(/<entry>/g) || []).length, 50);
  assert.match(p1, /rel="next"[^>]*href="[^"]*\/opds\?page=2"/);
  assert.ok(!p1.includes('rel="previous"'));
  const p2 = await (await fetch(BASE + "/opds?page=2", { headers: h })).text();
  assert.equal((p2.match(/<entry>/g) || []).length, 1);
  assert.ok(p2.includes('rel="previous"'));
  assert.ok(!p2.includes('rel="next"'));
  assert.ok(p2.includes("<title>Cuốn 0</title>"), "cuốn cũ nhất ở trang 2");
  assert.ok(p1.includes("<title>Cuốn 50</title>"), "cuốn mới nhất ở trang 1");
});

test("trần dung lượng chung: vượt MAX_STORAGE_MB_TOTAL thì 507, không tốn lượt gửi", async () => {
  const before = (await B.req("/api/me")).data.usage.uploadsToday;
  const big = fakeEpub(1100 * 1024); // e2e đặt trần chung 1 MB
  const r = await uploadBook(B, "Quá to", big);
  assert.equal(r.status, 507, JSON.stringify(r.data));
  assert.equal((await B.req("/api/me")).data.usage.uploadsToday, before, "trả lại lượt");
});

test("đăng xuất rồi đăng nhập lại; sai mật khẩu báo chung chung", async () => {
  const c = client();
  const wrong = await c.req("/api/login", { method: "POST", json: { username: U, proof: await proof(U, "sai-mat-khau") } });
  assert.equal(wrong.status, 401);
  const ghost = await c.req("/api/login", { method: "POST", json: { username: "khongtontai", proof: await proof("khongtontai", "x12345678") } });
  assert.equal(ghost.status, 401);
  assert.equal(wrong.data.error, ghost.data.error, "không lộ tên nào tồn tại");
  const ok = await c.req("/api/login", { method: "POST", json: { username: U, proof: await proof(U, "matkhau-dai-1") } });
  assert.equal(ok.status, 200);
  assert.equal((await c.req("/api/me")).status, 200);
  const out = await c.req("/api/logout", { method: "POST", json: {} });
  assert.equal(out.status, 200);
  assert.equal((await c.req("/api/me")).status, 401);
});

test("đổi mật khẩu: sai mật khẩu cũ bị chặn; đổi xong phiên khác bị đăng xuất", async () => {
  const other = client();
  await other.req("/api/login", { method: "POST", json: { username: U, proof: await proof(U, "matkhau-dai-1") } });
  assert.equal((await other.req("/api/me")).status, 200);
  const bad = await A.req("/api/password", { method: "POST", json: { current: await proof(U, "sai"), next: await proof(U, "moi-dai-hon-8") } });
  assert.equal(bad.status, 403);
  const ok = await A.req("/api/password", { method: "POST", json: { current: await proof(U, "matkhau-dai-1"), next: await proof(U, "moi-dai-hon-8") } });
  assert.equal(ok.status, 200);
  assert.equal((await A.req("/api/me")).status, 200, "phiên hiện tại vẫn còn");
  assert.equal((await other.req("/api/me")).status, 401, "phiên khác bị đăng xuất");
  const relog = await client().req("/api/login", { method: "POST", json: { username: U, proof: await proof(U, "moi-dai-hon-8") } });
  assert.equal(relog.status, 200);
});

test("tạo khóa OPDS mới: khóa cũ hết hiệu lực", async () => {
  const r = await A.req("/api/opds-key", { method: "POST", json: {} });
  assert.equal(r.status, 200);
  assert.notEqual(r.data.opdsKey, opdsKeyA);
  assert.equal((await fetch(BASE + "/opds", { headers: basic(U, opdsKeyA) })).status, 401);
  assert.equal((await fetch(BASE + "/opds", { headers: basic(U, r.data.opdsKey) })).status, 200);
  opdsKeyA = r.data.opdsKey;
});

test("xóa sách", async () => {
  assert.equal((await A.req(`/api/books/${bookA}`, { method: "DELETE" })).status, 200);
  assert.equal((await A.req("/api/books")).data.length, 0);
  assert.equal((await fetch(`${BASE}/books/${bookA}.epub`, { headers: basic(U, opdsKeyA) })).status, 404);
  const me = await A.req("/api/me");
  assert.equal(me.data.usage.uploadsToday, 1, "xóa không trả lại lượt gửi");
});

test("khóa đăng nhập: 10 lần sai từ một nơi thì nơi đó bị chặn, chủ tài khoản ở nơi khác vẫn vào được", async () => {
  const attacker = client();
  const ipA = { "CF-Connecting-IP": "203.0.113.7" };
  const ipB = { "CF-Connecting-IP": "198.51.100.9" };
  const junk = "f".repeat(64); // không cần tính KDF, đúng định dạng là đủ
  for (let i = 0; i < 10; i++) {
    const r = await attacker.req("/api/login", { method: "POST", json: { username: V, proof: junk }, headers: ipA });
    assert.equal(r.status, 401, `lần ${i + 1}`);
  }
  const locked = await attacker.req("/api/login", { method: "POST", json: { username: V, proof: await proof(V, "matkhau-dai-1") }, headers: ipA });
  assert.equal(locked.status, 429, "cùng nơi: đúng mật khẩu cũng phải chờ");
  const owner = await client().req("/api/login", { method: "POST", json: { username: V, proof: await proof(V, "matkhau-dai-1") }, headers: ipB });
  assert.equal(owner.status, 200, "chủ tài khoản ở IP khác không bị khóa lây");
});

test("đăng nhập sai song song không lách được giới hạn 10 lần", async () => {
  const c = client();
  const ip = { "CF-Connecting-IP": "192.0.2.44" };
  const junk = "e".repeat(64);
  const rs = await Promise.all(Array.from({ length: 16 }, () => c.req("/api/login", { method: "POST", json: { username: V, proof: junk }, headers: ip })));
  const passed = rs.filter((r) => r.status === 401).length;
  assert.ok(passed <= 10, `chỉ tối đa 10 lần được kiểm mật khẩu, thực tế ${passed}`);
  assert.ok(rs.some((r) => r.status === 429));
});

test("nhập lại mật khẩu sai quá 5 lần trong một phiên: phiên đó bị hủy; khóa đăng nhập từ ngoài không chặn được đổi mật khẩu", async () => {
  // B đang đăng nhập; kẻ khác spam đăng nhập tên V (test trước) — B vẫn đổi được mật khẩu
  const wrong = await proof(V, "khong-phai");
  const ok = await B.req("/api/password", { method: "POST", json: { current: await proof(V, "matkhau-dai-1"), next: await proof(V, "matkhau-dai-1") } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const thief = client();
  await thief.req("/api/login", { method: "POST", json: { username: V, proof: await proof(V, "matkhau-dai-1") }, headers: { "CF-Connecting-IP": "198.51.100.10" } });
  assert.equal((await thief.req("/api/me")).status, 200);
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await thief.req("/api/password", { method: "POST", json: { current: wrong, next: wrong } })).status);
  assert.deepEqual(statuses, [403, 403, 403, 403, 403, 429], "5 lần sai, lần 6 bị chặn");
  assert.equal((await thief.req("/api/me")).status, 401, "phiên đoán mật khẩu bị hủy");
  assert.equal((await B.req("/api/me")).status, 200, "phiên khác của chủ tài khoản không bị ảnh hưởng");
});

test("dò mật khẩu phân tán từ nhiều IP chặn người lạ, nhưng trình duyệt quen của chủ vẫn đăng nhập được", async () => {
  const owner = client();
  const name = "quen" + Date.now().toString(36).slice(-5);
  assert.equal((await signup(owner, name)).status, 201);
  owner.forgetSession(); // như đã đăng xuất, còn cookie thiết bị
  const junk = "d".repeat(64);
  for (let n = 1; n <= 3; n++) {
    const bot = client();
    for (let i = 0; i < 10; i++) await bot.req("/api/login", { method: "POST", json: { username: name, proof: junk }, headers: { "CF-Connecting-IP": `100.64.0.${n}` } });
  }
  const good = await proof(name, "matkhau-dai-1");
  const stranger = await client().req("/api/login", { method: "POST", json: { username: name, proof: good }, headers: { "CF-Connecting-IP": "100.64.0.99" } });
  assert.equal(stranger.status, 429, "trình duyệt lạ bị chặn khi tên đang bị dò");
  const back = await owner.req("/api/login", { method: "POST", json: { username: name, proof: good }, headers: { "CF-Connecting-IP": "100.64.0.100" } });
  assert.equal(back.status, 200, "trình duyệt quen vẫn vào được");
});

test("trình duyệt mở /opds chưa đăng nhập: trang hướng dẫn, không bật hộp Basic auth", async () => {
  const r = await fetch(BASE + "/opds", { headers: { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" } });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("www-authenticate"), null);
  assert.match(await r.text(), /dành cho máy đọc sách/);
});

test("xóa tài khoản: cần đúng mật khẩu, xong thì không đăng nhập được", async () => {
  const bad = await A.req("/api/account", { method: "DELETE", json: { proof: await proof(U, "sai") } });
  assert.equal(bad.status, 403);
  await uploadBook(A, "Sẽ bị xóa theo");
  const ok = await A.req("/api/account", { method: "DELETE", json: { proof: await proof(U, "moi-dai-hon-8") } });
  assert.equal(ok.status, 200);
  assert.equal((await A.req("/api/me")).status, 401);
  assert.equal((await fetch(BASE + "/opds", { headers: basic(U, opdsKeyA) })).status, 401);
  const again = await client().req("/api/login", { method: "POST", json: { username: U, proof: await proof(U, "moi-dai-hon-8") } });
  assert.equal(again.status, 401);
});

// ── Đăng nhập bằng Google, với token endpoint giả (GOOGLE_TOKEN_URL trong scripts/e2e.mjs) ──
const GOOGLE_CID = "e2e.apps.googleusercontent.com";
/** code → claims của id_token mà "Google" sẽ trả */
const fakeCodes = new Map();
const fakeGoogle = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const f = new URLSearchParams(raw);
    const entry = fakeCodes.get(f.get("code"));
    const pkceOk = entry && createHash("sha256").update(f.get("code_verifier") || "").digest("base64url") === entry.challenge;
    const clientOk = f.get("client_id") === GOOGLE_CID && f.get("client_secret") === "e2e-secret" && f.get("grant_type") === "authorization_code";
    if (!entry || !pkceOk || !clientOk || !/\/auth\/google\/callback$/.test(f.get("redirect_uri") || "")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid_grant" }));
    }
    fakeCodes.delete(f.get("code")); // code chỉ dùng một lần
    const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ access_token: "x", id_token: `${b({ alg: "RS256" })}.${b(entry.claims)}.sig` }));
  });
});
await new Promise((r) => fakeGoogle.listen(8798, "127.0.0.1", r));
after(() => fakeGoogle.close());

let codeSeq = 0;
/**
 * Đi hết một vòng Google: start → (giả) người dùng đồng ý với tài khoản `sub` → callback.
 * `tamper` sửa claims hoặc state để thử các trường hợp xấu. Trả về Location của callback.
 */
async function googleRound(c, { mode = "login", sub, email, proof: pf, tamper = {}, headers = {} } = {}) {
  const st = await c.req("/api/google/start", { method: "POST", json: pf ? { mode, proof: pf } : { mode }, headers });
  if (st.status !== 200) return { start: st };
  const auth = new URL(st.data.url);
  assert.equal(auth.origin + auth.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.get("client_id"), GOOGLE_CID);
  const flow = JSON.parse(Buffer.from(c.cookieValue("xl_oauth"), "base64url").toString());
  const code = "c" + ++codeSeq;
  const claims = { iss: "https://accounts.google.com", aud: GOOGLE_CID, exp: Math.floor(Date.now() / 1000) + 600, nonce: flow.n, sub, email, email_verified: true, ...tamper.claims };
  fakeCodes.set(code, { claims, challenge: auth.searchParams.get("code_challenge") });
  const state = tamper.state ?? auth.searchParams.get("state");
  const cb = await c.req(`/auth/google/callback?code=${code}&state=${state}`, { headers });
  return { start: st, cb, location: cb.headers.get("location") };
}

test("Google: trang báo đã bật; người mới chọn tên rồi thành tài khoản không mật khẩu", async () => {
  const cfg = await client().req("/api/config");
  assert.deepEqual(cfg.data, { google: true, signup: true, needsCode: false });
  const g = client();
  const ip = { "CF-Connecting-IP": "203.0.113.50" };
  const r = await googleRound(g, { sub: "g-1001", email: "Phạm.Thử+x@gmail.com", headers: ip });
  assert.equal(r.cb.status, 303);
  assert.equal(r.location, "/?google=pick");
  assert.equal(g.cookieValue("xl_oauth"), undefined, "cookie state bị xóa sau callback");
  const pend = await g.req("/api/google/pending");
  assert.equal(pend.data.suggest, "pham.thu");
  // Chưa chọn tên thì chưa có tài khoản
  assert.equal((await g.req("/api/me")).status, 401);
  assert.equal((await g.req("/api/google/signup", { method: "POST", json: { username: "Ab" }, headers: ip })).status, 400);
  const made = await g.req("/api/google/signup", { method: "POST", json: { username: "pham.thu" }, headers: ip });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.match(made.data.opdsKey, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
  const me = await g.req("/api/me");
  assert.equal(me.data.user.hasPassword, false);
  assert.equal(me.data.user.google, true);
  // Chỗ giữ tên đã dùng xong
  assert.equal((await g.req("/api/google/pending")).status, 404);
  // Tài khoản Google không đăng nhập bằng mật khẩu được, kể cả đoán đúng "mật khẩu rỗng"
  const pw = await client().req("/api/login", { method: "POST", json: { username: "pham.thu", proof: await proof("pham.thu", "") } });
  assert.equal(pw.status, 401);
  // Máy đọc dùng khóa OPDS như mọi tài khoản
  assert.equal((await fetch(BASE + "/opds", { headers: basic("pham.thu", made.data.opdsKey) })).status, 200);
});

test("Google: lần sau bấm là vào luôn; tên gợi ý tránh tên đã có", async () => {
  const g = client();
  const r = await googleRound(g, { sub: "g-1001" });
  assert.equal(r.location, "/?google=ok");
  const me = await g.req("/api/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.user.username, "pham.thu");
  // Người khác cùng phần trước @ → gợi ý pham.thu2
  const h = client();
  const r2 = await googleRound(h, { sub: "g-1002", email: "pham.thu@yahoo.com" });
  assert.equal(r2.location, "/?google=pick");
  assert.equal((await h.req("/api/google/pending")).data.suggest, "pham.thu2");
  assert.equal((await h.req("/api/google/cancel", { method: "POST", json: {} })).status, 200);
  assert.equal((await h.req("/api/google/pending")).status, 404);
});

test("Google: chặn state sai, thiếu cookie, nonce sai, sai client, người dùng bấm hủy", async () => {
  const g = client();
  assert.equal((await googleRound(g, { sub: "g-2001", tamper: { state: "0".repeat(32) } })).location, "/?google=expired");
  assert.equal((await googleRound(g, { sub: "g-2001", tamper: { claims: { nonce: "khac" } } })).location, "/?google=error");
  assert.equal((await googleRound(g, { sub: "g-2001", tamper: { claims: { aud: "khac.apps.googleusercontent.com" } } })).location, "/?google=error");
  // Kẻ gian gửi link callback (code của hắn) cho nạn nhân: nạn nhân không có cookie state → không đăng nhập vào tài khoản hắn
  const victim = client();
  const cb = await victim.req(`/auth/google/callback?code=c999&state=${"a".repeat(32)}`);
  assert.equal(cb.headers.get("location"), "/?google=expired");
  assert.equal((await victim.req("/api/me")).status, 401);
  const cancel = await client().req("/auth/google/callback?error=access_denied&state=x");
  assert.equal(cancel.headers.get("location"), "/?google=cancel");
  assert.equal((await client().req("/auth/google/callback", { method: "POST" })).status, 405);
});

test("Google: liên kết vào tài khoản có mật khẩu cần nhập lại mật khẩu; một Google chỉ gắn một tài khoản", async () => {
  const c = client();
  const name = "lienket" + Date.now().toString(36).slice(-4);
  const ip = { "CF-Connecting-IP": "203.0.113.51" };
  assert.equal((await c.req("/api/signup", { method: "POST", json: { username: name, proof: await proof(name, "matkhau-dai-1") }, headers: ip })).status, 201);
  assert.equal((await client().req("/api/google/start", { method: "POST", json: { mode: "link" } })).status, 401);
  assert.equal((await googleRound(c, { mode: "link", sub: "g-3001" })).start.status, 400, "thiếu mật khẩu");
  assert.equal((await googleRound(c, { mode: "link", sub: "g-3001", proof: await proof(name, "sai-mat-khau") })).start.status, 403);
  // Google đã thuộc tài khoản pham.thu → không gắn được
  const taken = await googleRound(c, { mode: "link", sub: "g-1001", proof: await proof(name, "matkhau-dai-1") });
  assert.equal(taken.location, "/?google=taken");
  const ok = await googleRound(c, { mode: "link", sub: "g-3001", proof: await proof(name, "matkhau-dai-1") });
  assert.equal(ok.location, "/?google=linked");
  assert.equal((await c.req("/api/me")).data.user.google, true);
  // Gắn Google thứ hai → phải gỡ cái cũ trước
  const second = await googleRound(c, { mode: "link", sub: "g-3002", proof: await proof(name, "matkhau-dai-1") });
  assert.equal(second.location, "/?google=already");
  // Đăng nhập bằng Google vào đúng tài khoản đó
  const other = client();
  assert.equal((await googleRound(other, { sub: "g-3001" })).location, "/?google=ok");
  assert.equal((await other.req("/api/me")).data.user.username, name);
  // Gỡ liên kết (tài khoản còn mật khẩu) → Google đó thành người mới
  assert.equal((await c.req("/api/google/unlink", { method: "POST", json: {} })).status, 200);
  assert.equal((await googleRound(client(), { sub: "g-3001" })).location, "/?google=pick");
});

test("Google: tài khoản chỉ có Google — không gỡ được Google, xóa tài khoản cần gõ đúng tên", async () => {
  const g = client();
  assert.equal((await googleRound(g, { sub: "g-1001" })).location, "/?google=ok");
  assert.equal((await g.req("/api/google/unlink", { method: "POST", json: {} })).status, 400);
  assert.equal((await g.req("/api/password", { method: "POST", json: { current: "0".repeat(64), next: "1".repeat(64) } })).status, 400);
  assert.equal((await g.req("/api/account", { method: "DELETE", json: { confirm: "nguoikhac" } })).status, 400);
  // Phiên vừa đăng nhập bằng Google (< 10 phút) → xóa được
  const del = await g.req("/api/account", { method: "DELETE", json: { confirm: "pham.thu" } });
  assert.equal(del.status, 200, JSON.stringify(del.data));
  // Google đó giờ là người mới
  assert.equal((await googleRound(client(), { sub: "g-1001" })).location, "/?google=pick");
});

test("route lạ và method sai", async () => {
  assert.equal((await A.req("/api/khongco")).status, 401);
  assert.equal((await B.req("/api/khongco")).status, 404);
  assert.equal((await fetch(BASE + "/opds", { method: "POST", headers: { ...basic(V, "x"), Origin: BASE } })).status, 405);
});

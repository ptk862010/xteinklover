// Bản tự chạy (node/): KV trên thư mục, trang tĩnh + _headers, vá MD5 / FixedLengthStream, cầu nối http.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirKV, fileNameForKey } from "../node/kv";
import { createAssets, extendCsp, parseHeadersFile, resolveAssetPath } from "../node/assets";
import { FixedLengthStream, declaredLength, installRuntime } from "../node/runtime";
import { createNodeHandler, originOf } from "../node/server";
import { SqliteD1 } from "../node/d1";
import type { Env } from "../src/env";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `xl-${p}-`));

test("KV: tên file không thoát khỏi thư mục, Windows đọc được", () => {
  assert.equal(fileNameForKey("b:abc123"), "b%3Aabc123");
  assert.equal(fileNameForKey("../../etc/passwd"), "%2E%2E%2F%2E%2E%2Fetc%2Fpasswd");
  assert.equal(fileNameForKey("ả"), "%E1%BA%A3");
  assert.throws(() => fileNameForKey(""));
});

test("KV: put / get (text, arrayBuffer, stream) / delete; khóa không có thì null", async () => {
  const dir = tmp("kv");
  const kv = await DirKV.open(dir);
  await kv.put("b:1", new Uint8Array([1, 2, 3]));
  assert.deepEqual(new Uint8Array((await kv.get("b:1", "arrayBuffer")) as ArrayBuffer), new Uint8Array([1, 2, 3]));
  const stream = (await kv.get("b:1", "stream")) as ReadableStream;
  assert.deepEqual(new Uint8Array(await new Response(stream).arrayBuffer()), new Uint8Array([1, 2, 3]));
  await kv.put("k", "xin chào");
  assert.equal(await kv.get("k"), "xin chào");
  await kv.put("j", JSON.stringify({ a: 1 }));
  assert.deepEqual(await kv.get("j", { type: "json" }), { a: 1 });
  assert.equal(await kv.get("nope", "stream"), null);
  assert.equal(await kv.get("nope", "arrayBuffer"), null);
  await kv.delete("b:1");
  await kv.delete("b:1"); // xóa lần hai không lỗi
  assert.equal(await kv.get("b:1", "arrayBuffer"), null);
  assert.ok(!readdirSync(dir).some((f) => f.includes(".tmp-")), "không sót file tạm");
});

test("D1 SQLite: file thật, BLOB từ ArrayBuffer, PRAGMA / RETURNING trả dòng, batch lỗi thì hoàn tác", async () => {
  const d = new SqliteD1(join(tmp("d1"), "t.db"));
  await d.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, b BLOB)").run();
  const bytes = new Uint8Array([9, 8, 7]);
  await d.prepare("INSERT INTO t (id, b) VALUES (?, ?)").bind(1, bytes.buffer).run();
  const row = await d.prepare("SELECT b FROM t WHERE id = 1").first<{ b: Uint8Array }>();
  assert.deepEqual(new Uint8Array(row!.b), bytes);
  assert.equal((await d.prepare("PRAGMA journal_mode").first<{ journal_mode: string }>())?.journal_mode, "wal");
  const upd = await d.prepare("UPDATE t SET b = NULL WHERE id = 1 RETURNING id").all<{ id: number }>();
  assert.deepEqual(upd.results, [{ id: 1 }]);
  assert.equal((await d.prepare("DELETE FROM t WHERE id = 99").run()).meta.changes, 0);
  await assert.rejects(d.batch([d.prepare("INSERT INTO t (id) VALUES (2)"), d.prepare("INSERT INTO t (id) VALUES (2)")]));
  assert.equal(await d.prepare("SELECT COUNT(*) AS n FROM t").first("n"), 1);
  d.close();
});

test("_headers: đọc luật, * khớp mọi đường dẫn, bỏ dòng chú thích", () => {
  const rules = parseHeadersFile("# chú thích\n/*\n  X-A: 1\n  Content-Security-Policy: default-src 'self'; img-src data:\n/app.js\n  X-B: 2\n");
  assert.equal(rules.length, 2);
  assert.ok(rules[0].pattern.test("/anything/here"));
  assert.deepEqual(rules[0].headers[1], ["Content-Security-Policy", "default-src 'self'; img-src data:"]);
  assert.ok(rules[1].pattern.test("/app.js") && !rules[1].pattern.test("/appXjs"));
});

test("CSP: bản tự chạy thêm http: vào connect-src để gọi máy đọc, chỉ thị khác giữ nguyên", async () => {
  assert.equal(extendCsp("default-src 'self'; connect-src 'self' blob:; img-src data:", "connect-src", "http:"), "default-src 'self'; connect-src 'self' blob: http:; img-src data:");
  assert.equal(extendCsp("default-src 'self'", "connect-src", "http:"), "default-src 'self'; connect-src http:");
  const root = tmp("csp");
  writeFileSync(join(root, "index.html"), "x");
  writeFileSync(join(root, "_headers"), "/*\n  Content-Security-Policy: default-src 'self'; connect-src 'self'\n");
  const csp = async (o = {}) => (await createAssets(root, o).fetch(new Request("http://x/"))).headers.get("content-security-policy");
  assert.equal(await csp(), "default-src 'self'; connect-src 'self'");
  assert.equal(await csp({ connectSrc: "http:" }), "default-src 'self'; connect-src 'self' http:");
});

test("trang tĩnh: chặn đi ngược thư mục, file ẩn, _headers", () => {
  const root = tmp("pub");
  assert.equal(resolveAssetPath(root, "/../secret"), null);
  assert.equal(resolveAssetPath(root, "/%2e%2e/secret"), null);
  assert.equal(resolveAssetPath(root, "/a/..%2F..%2Fx"), null);
  assert.equal(resolveAssetPath(root, "/.env"), null);
  assert.equal(resolveAssetPath(root, "/_headers"), null);
  assert.equal(resolveAssetPath(root, "/%E0%A4%A"), null);
  assert.equal(resolveAssetPath(root, "/..\\x"), null);
  assert.equal(resolveAssetPath(root, "/app.js"), join(root, "app.js"));
});

test("trang tĩnh: / → index.html, header từ _headers, ETag → 304, gzip, HEAD không body, 404", async () => {
  const root = tmp("pub");
  writeFileSync(join(root, "index.html"), "<!doctype html><h1>kệ</h1>" + "x".repeat(2000));
  writeFileSync(join(root, "app.js"), "console.log(1)");
  writeFileSync(join(root, "_headers"), "/*\n  X-Frame-Options: DENY\n");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "index.html"), "docs");
  const a = createAssets(root);
  const get = (p: string, h: Record<string, string> = {}, method = "GET") => a.fetch(new Request("http://x" + p, { headers: h, method }));

  const home = await get("/");
  assert.equal(home.status, 200);
  assert.equal(home.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(home.headers.get("x-frame-options"), "DENY");
  assert.match(await home.text(), /kệ/);
  assert.equal(await (await get("/docs/")).text(), "docs");
  assert.equal(await (await get("/app")).status, 404, "không đoán .js");
  assert.equal((await get("/nope.css")).status, 404);
  assert.equal((await get("/_headers")).status, 404);

  const etag = home.headers.get("etag")!;
  assert.equal((await get("/", { "If-None-Match": etag })).status, 304);

  const gz = await get("/", { "Accept-Encoding": "gzip, br" });
  assert.equal(gz.headers.get("content-encoding"), "gzip");
  assert.ok(Number(gz.headers.get("content-length")) < 2000);

  const head = await get("/app.js", {}, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await get("/", {}, "POST")).status, 405);
});

test("runtime: MD5 qua crypto.subtle như Workers; FixedLengthStream khai độ dài và kiểm đủ byte", async () => {
  installRuntime();
  const hex = (b: ArrayBuffer) => Buffer.from(b).toString("hex");
  assert.equal(hex(await crypto.subtle.digest("MD5", new TextEncoder().encode("abc"))), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(hex(await crypto.subtle.digest({ name: "md5" }, new Uint8Array(0))), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(hex(await crypto.subtle.digest("SHA-256", new Uint8Array(0))).slice(0, 8), "e3b0c442", "SHA-256 vẫn là bản gốc");

  const ok = new FixedLengthStream(3);
  assert.equal(declaredLength(ok.readable), 3);
  const w = ok.writable.getWriter();
  void w.write(new Uint8Array([1, 2, 3])).then(() => w.close());
  assert.equal((await new Response(ok.readable).arrayBuffer()).byteLength, 3);

  const short = new FixedLengthStream(5);
  const w2 = short.writable.getWriter();
  void w2.write(new Uint8Array([1])).then(() => w2.close()).catch(() => undefined);
  await assert.rejects(new Response(short.readable).arrayBuffer());
  assert.equal(declaredLength(null), undefined);
});

/** Server thật trên cổng ngẫu nhiên, worker giả trả lại những gì nó nhìn thấy. */
async function bridge(trustProxy: "" | "1" | "cloudflare", fetchImpl: (req: Request) => Promise<Response> | Response): Promise<{ base: string; server: Server }> {
  const worker = { fetch: (req: Request) => fetchImpl(req) } as unknown as ExportedHandler<Env>;
  const handler = createNodeHandler({ worker, env: {} as Env, trustProxy, maxBodyBytes: 1000 }, new Set());
  const server = createServer((q, s) => void handler(q, s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, server };
}

type Echo = { ip: string; url: string; method: string; body: string | null };
const echo = async (req: Request) =>
  Response.json({ ip: req.headers.get("CF-Connecting-IP"), url: req.url, method: req.method, body: req.body ? await req.text() : null });

test("cầu nối: CF-Connecting-IP do server đặt — client tự gửi thì bị thay, trừ khi tin proxy", async () => {
  const plain = await bridge("", echo);
  const r = await (await fetch(plain.base + "/api/x?q=1", { headers: { "CF-Connecting-IP": "6.6.6.6", "X-Forwarded-For": "7.7.7.7" } })).json() as Echo;
  assert.equal(r.ip, "127.0.0.1", "không tin header khi không có proxy");
  assert.equal(r.url, plain.base + "/api/x?q=1");
  plain.server.close();

  const behind = await bridge("1", echo);
  const r2 = await (await fetch(behind.base + "/", { headers: { "X-Forwarded-For": "6.6.6.6, 203.0.113.5" } })).json() as Echo;
  assert.equal(r2.ip, "203.0.113.5", "lấy mục proxy thêm vào (cuối), không lấy mục client tự ghi");
  behind.server.close();

  const cf = await bridge("cloudflare", echo);
  const r3 = await (await fetch(cf.base + "/", { headers: { "CF-Connecting-IP": "198.51.100.1" } })).json() as Echo;
  assert.equal(r3.ip, "198.51.100.1");
  cf.server.close();
});

test("cầu nối: body POST tới worker; quá trần thì 413; HEAD không body; nhiều Set-Cookie; FixedLengthStream → Content-Length", async () => {
  installRuntime();
  const { base, server } = await bridge("", async (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/cookies") {
      const h = new Headers();
      h.append("Set-Cookie", "a=1; Path=/");
      h.append("Set-Cookie", "b=2; Path=/");
      return new Response("ok", { headers: h });
    }
    if (u.pathname === "/file") {
      const { readable, writable } = new FixedLengthStream(4);
      const w = writable.getWriter();
      void w.write(new Uint8Array([1, 2, 3, 4])).then(() => w.close());
      return new Response(readable);
    }
    if (u.pathname === "/early") return new Response("no", { status: 401 }); // không đọc body
    return echo(req);
  });
  const post = await (await fetch(base + "/p", { method: "POST", body: "xin chào" })).json() as Echo;
  assert.equal(post.body, "xin chào");
  assert.equal((await fetch(base + "/p", { method: "POST", body: "x".repeat(2000) })).status, 413);
  assert.equal((await fetch(base + "/early", { method: "POST", body: "x".repeat(900) })).status, 401, "trả lời sớm không làm đứt kết nối");
  const head = await fetch(base + "/p", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.deepEqual((await fetch(base + "/cookies")).headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"]);
  const file = await fetch(base + "/file");
  assert.equal(file.headers.get("content-length"), "4");
  assert.equal((await file.arrayBuffer()).byteLength, 4);
  server.close();
});

test("cầu nối: Host lạ thì 400; PUBLIC_URL ép địa chỉ gốc; https chỉ khi tin proxy", () => {
  const req = (headers: Record<string, string>) => ({ headers, socket: {} }) as unknown as import("node:http").IncomingMessage;
  assert.equal(originOf(req({ host: "sach.lan:8787" }), { trustProxy: "" }), "http://sach.lan:8787");
  assert.equal(originOf(req({ host: "[::1]:8787" }), { trustProxy: "" }), "http://[::1]:8787");
  assert.equal(originOf(req({ host: "evil.com/x" }), { trustProxy: "" }), null);
  assert.equal(originOf(req({ host: "" }), { trustProxy: "" }), null);
  assert.equal(originOf(req({ host: "a.b", "x-forwarded-proto": "https" }), { trustProxy: "" }), "http://a.b");
  assert.equal(originOf(req({ host: "a.b", "x-forwarded-proto": "https" }), { trustProxy: "1" }), "https://a.b");
  assert.equal(originOf(req({ host: "whatever" }), { trustProxy: "", publicUrl: "https://sach.example.com/x" }), "https://sach.example.com");
});

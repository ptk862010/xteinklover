import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIp, ipv6Prefix64, readCookie, sameOrigin, sessionCookie } from "../src/http";
import { contentDisposition } from "../src/books";

test("IPv6 gom theo /64, IPv4 giữ nguyên", () => {
  assert.equal(ipv6Prefix64("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  assert.equal(ipv6Prefix64("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(ipv6Prefix64("2001:DB8:0001:0002::ffff"), "2001:db8:1:2::/64");
  assert.equal(ipv6Prefix64("::1"), "0:0:0:0::/64");
  const req = (ip: string) => new Request("https://x.dev/", { headers: { "CF-Connecting-IP": ip } });
  assert.equal(clientIp(req("1.2.3.4")), "1.2.3.4");
  assert.equal(clientIp(req("2001:db8:1:2:aaaa::1")), clientIp(req("2001:db8:1:2:bbbb::9")));
});

test("cookie phiên: __Host- trên HTTPS, Secure/HttpOnly/SameSite", () => {
  const c = sessionCookie(new URL("https://app.example.dev/api/login"), "t0k");
  assert.match(c, /^__Host-xl_session=t0k; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  assert.doesNotMatch(sessionCookie(new URL("http://127.0.0.1/"), "t"), /Secure|__Host-/);
  const r = new Request("https://x/", { headers: { Cookie: "a=1; __Host-xl_session=abc; b=2" } });
  assert.equal(readCookie(r, "__Host-xl_session"), "abc");
  assert.equal(readCookie(r, "xl_session"), null);
});

test("sameOrigin: Origin đúng / sai / thiếu", () => {
  const u = new URL("https://app.example.dev/api/x");
  const mk = (h: Record<string, string>) => new Request(u, { method: "POST", headers: h });
  assert.ok(sameOrigin(mk({ Origin: "https://app.example.dev" }), u));
  assert.ok(!sameOrigin(mk({ Origin: "https://evil.dev" }), u));
  assert.ok(!sameOrigin(mk({}), u));
  assert.ok(sameOrigin(mk({ "Sec-Fetch-Site": "same-origin" }), u));
  assert.ok(!sameOrigin(mk({ "Sec-Fetch-Site": "same-site" }), u));
});

test("Content-Disposition: ASCII an toàn + UTF-8, không lỗi khi cắt giữa emoji", () => {
  const cd = contentDisposition('Hóa thân "Kafka"\r\nX: y', "id1");
  assert.ok(!/[\r\n]/.test(cd));
  assert.match(cd, /^attachment; filename="Hoa than _Kafka_X_ y\.epub"; filename\*=UTF-8''/);
  const long = "a".repeat(119) + "😀" + "b";
  assert.doesNotThrow(() => contentDisposition(long, "id2"));
});

test("readJson: đọc tối đa 16 KB kể cả khi không có Content-Length", async () => {
  const { readJson } = await import("../src/http");
  const ok = new Request("https://x/", { method: "POST", body: JSON.stringify({ a: 1 }) });
  assert.deepEqual(await readJson(ok), { a: 1 });
  const big = new ReadableStream({
    pull(c) { c.enqueue(new TextEncoder().encode("x".repeat(8192))); },
  });
  const huge = new Request("https://x/", { method: "POST", body: big, duplex: "half" } as RequestInit);
  assert.equal(await readJson(huge), null);
  assert.equal(await readJson(new Request("https://x/", { method: "POST", body: "[1,2]" })), null, "mảng không phải object");
  assert.equal(await readJson(new Request("https://x/", { method: "POST", body: "{hỏng" })), null);
});

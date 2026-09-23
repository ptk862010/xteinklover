import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTarget } from "../src/clip";
import { decodeHtml } from "../web/clip";

const SELF = "app.xteinklover.workers.dev";
const ok = (u: string) => checkTarget(u, SELF) instanceof URL;

test("dán link: nhận http(s) tới tên miền công khai", () => {
  assert.ok(ok("https://vnexpress.net/bai-viet-123.html"));
  assert.ok(ok("http://example.com/a?b=c#d"));
  assert.ok(ok("https://sub.example.co.uk:443/x"));
});

test("dán link: chặn IP, localhost, tên nội bộ, cổng lạ, scheme lạ, có mật khẩu, chính trang này", () => {
  for (const u of [
    "http://127.0.0.1/",
    "http://10.0.0.5/admin",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://localhost:8787/",
    "http://router.local/",
    "http://nas.lan/",
    "http://intranet/",
    "https://example.com:8443/",
    "ftp://example.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pass@example.com/",
    "https://app.xteinklover.workers.dev/api/me",
    "không phải link",
  ]) {
    assert.equal(typeof checkTarget(u, SELF), "string", u);
  }
  assert.equal(typeof checkTarget(123, SELF), "string");
  assert.equal(typeof checkTarget("https://" + "a".repeat(2100) + ".com", SELF), "string");
});

test("chế độ test (FETCH_ALLOW_LOCAL) chỉ mở cho 127.0.0.1 / localhost", () => {
  assert.ok(checkTarget("http://127.0.0.1:9999/x", SELF, true) instanceof URL);
  assert.equal(typeof checkTarget("http://10.0.0.1/", SELF, true), "string");
});

test("giải mã trang: theo header, theo thẻ meta, mặc định UTF-8", () => {
  const utf8 = new TextEncoder().encode("<p>Tiếng Việt</p>");
  assert.equal(decodeHtml(utf8, ""), "<p>Tiếng Việt</p>");
  assert.equal(decodeHtml(utf8, "UTF-8"), "<p>Tiếng Việt</p>");
  // windows-1258 (tiếng Việt cũ): "Vi" + 0xEA (ê) + "t"
  const cp = new Uint8Array([...new TextEncoder().encode('<meta charset="windows-1258"><p>Vi'), 0xea, ...new TextEncoder().encode("t</p>")]);
  assert.match(decodeHtml(cp, ""), /Viêt/);
  assert.equal(decodeHtml(utf8, "charset-la"), "<p>Tiếng Việt</p>", "charset lạ → UTF-8");
});

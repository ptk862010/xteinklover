import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DOCUMENT_RE, codeVariants, keyMatches, makeVerifiers, newSyncCode, parseProgress, KOSYNC_ERR } from "../src/kosync";

const md5 = async (s: string) => createHash("md5").update(s, "utf8").digest("hex");
const md5Sync = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

test("md5 của node khớp vector RFC 1321 (hàm băm dùng trong test)", async () => {
  assert.equal(await md5(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(await md5("abc"), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(await md5("12345678901234567890123456789012345678901234567890123456789012345678901234567890"), "57edf4a22be3c955ac49da2e2107b67a");
});

test("mã đồng bộ: 20 chữ số, mỗi lần khác nhau", () => {
  const a = newSyncCode();
  assert.match(a, /^[0-9]{20}$/);
  const seen = new Set(Array.from({ length: 50 }, () => newSyncCode()));
  assert.equal(seen.size, 50);
});

test("mã đồng bộ: 3 cách gõ (liền, cách dấu cách, gạch ngang)", () => {
  assert.deepEqual(codeVariants("12345678901234567890"), [
    "12345678901234567890",
    "1234 5678 9012 3456 7890",
    "1234-5678-9012-3456-7890",
  ]);
});

test("bộ xác minh: khớp md5 của cả 3 cách gõ, hex hoa/thường; không khớp mã khác hoặc salt khác", async () => {
  const code = "98765432109876543210";
  const salt = "00112233445566778899aabbccddeeff";
  const v = await makeVerifiers(code, salt, md5);
  assert.match(v.v_plain, /^[0-9a-f]{64}$/);
  assert.notEqual(v.v_plain, v.v_space);
  const row = { salt, ...v };
  for (const typed of codeVariants(code)) {
    assert.equal(await keyMatches(md5Sync(typed), row), true, typed);
    assert.equal(await keyMatches(md5Sync(typed).toUpperCase(), row), true, "hex chữ hoa");
  }
  assert.equal(await keyMatches(md5Sync("98765432109876543211"), row), false);
  assert.equal(await keyMatches(md5Sync(code + " "), row), false, "thừa dấu cách là mã khác");
  assert.equal(await keyMatches("", row), false);
  assert.equal(await keyMatches("not-hex", row), false);
  const other = await makeVerifiers(code, "ffeeddccbbaa99887766554433221100", md5);
  assert.notEqual(other.v_plain, v.v_plain, "salt khác → bộ xác minh khác");
});

test("document: chữ số, chữ cái, _ ; 1–64 ký tự", () => {
  assert.equal(DOCUMENT_RE.test("59d481d168cca6267322f150c5f6a2a3"), true);
  assert.equal(DOCUMENT_RE.test("A_b9"), true);
  for (const bad of ["", "a:b", "a/b", "a.b", "a b", "x".repeat(65)]) assert.equal(DOCUMENT_RE.test(bad), false, bad);
});

const good = { document: "59d481d168cca6267322f150c5f6a2a3", progress: "/body/DocFragment[11]/body/div/p[7]/text().123", percentage: 0.4213, device: "Kindle", device_id: "A1B2C3" };

test("PUT progress hợp lệ: giữ nguyên progress, device_id tuỳ chọn, bỏ qua trường lạ", () => {
  const r = parseProgress({ ...good, metadata: { title: "x" }, position: { a: 1 } });
  assert.ok(r.ok);
  assert.deepEqual(r.value, good);
  const noId = parseProgress({ ...good, device_id: undefined });
  assert.ok(noId.ok);
  assert.equal(noId.value.device_id, null);
  const page = parseProgress({ ...good, progress: "56" });
  assert.ok(page.ok);
  assert.equal(page.value.progress, "56", "số trang vẫn là chuỗi");
});

test("PUT progress: kẹp percentage, nhận chuỗi số, cắt device dài", () => {
  const hi = parseProgress({ ...good, percentage: 1.0000001 });
  assert.ok(hi.ok);
  assert.equal(hi.value.percentage, 1);
  const lo = parseProgress({ ...good, percentage: -0.2 });
  assert.ok(lo.ok);
  assert.equal(lo.value.percentage, 0);
  const str = parseProgress({ ...good, percentage: "0.5" });
  assert.ok(str.ok);
  assert.equal(str.value.percentage, 0.5);
  const zero = parseProgress({ ...good, percentage: 0 });
  assert.ok(zero.ok);
  const long = parseProgress({ ...good, device: "d".repeat(300), device_id: "i".repeat(300) });
  assert.ok(long.ok);
  assert.equal(long.value.device.length, 128);
  assert.equal(long.value.device_id?.length, 128);
});

test("PUT progress: từ chối cái không cứu được, đúng mã lỗi KOSync", () => {
  const code = (b: Record<string, unknown> | null) => {
    const r = parseProgress(b);
    return r.ok ? 0 : r.code;
  };
  assert.equal(code(null), KOSYNC_ERR.INVALID);
  assert.equal(code({ ...good, document: undefined }), KOSYNC_ERR.DOCUMENT);
  assert.equal(code({ ...good, document: "a:b" }), KOSYNC_ERR.DOCUMENT);
  assert.equal(code({ ...good, progress: undefined }), KOSYNC_ERR.INVALID);
  assert.equal(code({ ...good, progress: 56 }), KOSYNC_ERR.INVALID);
  assert.equal(code({ ...good, progress: "" }), KOSYNC_ERR.INVALID);
  assert.equal(code({ ...good, progress: "x".repeat(4097) }), KOSYNC_ERR.INVALID);
  assert.equal(code({ ...good, percentage: "abc" }), KOSYNC_ERR.INVALID);
  assert.equal(code({ ...good, percentage: null }), KOSYNC_ERR.INVALID);
  assert.equal(code({ ...good, percentage: Infinity }), KOSYNC_ERR.INVALID);
  assert.equal(code({ ...good, device: undefined }), KOSYNC_ERR.INVALID);
  assert.equal(code({ ...good, device: 5 }), KOSYNC_ERR.INVALID);
});

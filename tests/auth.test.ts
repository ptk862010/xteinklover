import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOpdsKey, opdsKeyHash, parseBasicAuth } from "../src/auth";

const h = (u: string, p: string) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");

test("parseBasicAuth tách user:pass, giữ dấu : trong mật khẩu", () => {
  assert.deepEqual(parseBasicAuth(h("kien", "a:b:c")), { user: "kien", pass: "a:b:c" });
  assert.equal(parseBasicAuth(null), null);
  assert.equal(parseBasicAuth("Bearer x"), null);
  assert.equal(parseBasicAuth("Basic !!!"), null);
});

test("parseBasicAuth giải mã UTF-8", () => {
  assert.deepEqual(parseBasicAuth(h("kiên", "mật")), { user: "kiên", pass: "mật" });
});

test("khóa OPDS gõ có/không gạch, hoa/thường đều khớp", async () => {
  assert.equal(normalizeOpdsKey("AbCd-efgh 2345-"), "abcdefgh2345");
  assert.equal(await opdsKeyHash("abcd-efgh-jkmn-pqrs"), await opdsKeyHash("ABCDEFGHJKMNPQRS"));
  assert.notEqual(await opdsKeyHash("abcd-efgh-jkmn-pqrs"), await opdsKeyHash("abcd-efgh-jkmn-pqrt"));
});

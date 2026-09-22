import { test } from "node:test";
import assert from "node:assert/strict";
import { isAuthorized, parseBasicAuth, safeEqual } from "../src/auth";

const h = (u: string, p: string) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");

test("parseBasicAuth tách user:pass, giữ dấu : trong mật khẩu", () => {
  assert.deepEqual(parseBasicAuth(h("kien", "a:b:c")), { user: "kien", pass: "a:b:c" });
  assert.equal(parseBasicAuth(null), null);
  assert.equal(parseBasicAuth("Bearer x"), null);
  assert.equal(parseBasicAuth("Basic !!!"), null);
});

test("isAuthorized đúng/sai", () => {
  assert.ok(isAuthorized(h("kien", "pw"), "kien", "pw"));
  assert.ok(!isAuthorized(h("kien", "PW"), "kien", "pw"));
  assert.ok(!isAuthorized(h("x", "pw"), "kien", "pw"));
  assert.ok(safeEqual("ă", "ă") && !safeEqual("a", "ab"));
});

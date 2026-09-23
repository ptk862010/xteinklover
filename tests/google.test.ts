import { test } from "node:test";
import assert from "node:assert/strict";
import { checkClaims, decodeJwtPayload, flowCookie, newFlow, pkceChallenge, readFlow, usernameBase, usernameCandidates } from "../src/google";

const CID = "123.apps.googleusercontent.com";
const NOW = 1_800_000_000;
const good = { iss: "https://accounts.google.com", aud: CID, exp: NOW + 3600, nonce: "n1", sub: "1049", email: "a.b@gmail.com", email_verified: true };

test("PKCE S256 khớp ví dụ trong RFC 7636", async () => {
  assert.equal(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("id_token: nhận khi đúng iss/aud/exp/nonce; email chỉ lấy khi đã xác minh", () => {
  assert.deepEqual(checkClaims(good, CID, "n1", NOW), { sub: "1049", email: "a.b@gmail.com" });
  assert.deepEqual(checkClaims({ ...good, iss: "accounts.google.com" }, CID, "n1", NOW)?.sub, "1049");
  assert.equal(checkClaims({ ...good, email_verified: false }, CID, "n1", NOW)?.email, undefined);
});

test("id_token: từ chối sai issuer, sai client, hết hạn, sai nonce, sub lạ", () => {
  assert.equal(checkClaims({ ...good, iss: "https://evil.example" }, CID, "n1", NOW), null);
  assert.equal(checkClaims({ ...good, aud: "khac.apps.googleusercontent.com" }, CID, "n1", NOW), null);
  assert.equal(checkClaims({ ...good, aud: [CID, "khac"] }, CID, "n1", NOW), null, "nhiều aud mà azp không phải mình");
  assert.ok(checkClaims({ ...good, aud: [CID, "khac"], azp: CID }, CID, "n1", NOW));
  assert.equal(checkClaims({ ...good, exp: NOW - 120 }, CID, "n1", NOW), null);
  assert.equal(checkClaims({ ...good, nonce: "n2" }, CID, "n1", NOW), null);
  assert.equal(checkClaims({ ...good, nonce: undefined }, CID, "n1", NOW), null);
  assert.equal(checkClaims({ ...good, sub: "a b" }, CID, "n1", NOW), null);
  assert.equal(checkClaims({ ...good, sub: 1049 }, CID, "n1", NOW), null);
});

test("decodeJwtPayload đọc phần giữa, bỏ qua chuỗi hỏng", () => {
  const part = Buffer.from(JSON.stringify({ sub: "x", name: "Kiên" })).toString("base64url");
  assert.deepEqual(decodeJwtPayload(`h.${part}.s`), { sub: "x", name: "Kiên" });
  assert.equal(decodeJwtPayload("a.b"), null);
  assert.equal(decodeJwtPayload("a.!!!.c"), null);
  assert.equal(decodeJwtPayload(`h.${Buffer.from("[1]").toString("base64url")}.s`), null);
});

function reqWith(cookie: string) {
  const v = cookie.match(/^([^=]+)=([^;]*)/)!;
  return new Request("http://x/", { headers: { Cookie: `${v[1]}=${v[2]}` } });
}

test("cookie state: ghi rồi đọc lại được; hết hạn hoặc bị sửa thì bỏ", () => {
  const url = new URL("http://localhost:8787/");
  const f = newFlow("link", "0f8fad5b-d9cb-469f-a165-70867728950e", 1000);
  const c = flowCookie(url, f);
  assert.match(c, /^xl_oauth=.+HttpOnly; SameSite=Lax; Max-Age=600$/);
  assert.deepEqual(readFlow(reqWith(c), url, 2000), f);
  assert.equal(readFlow(reqWith(c), url, 1000 + 601_000), null, "quá 10 phút");
  assert.equal(readFlow(reqWith(c.replace("xl_oauth=", "xl_oauth=A")), url, 2000), null);
  const bad = { ...f, m: "admin" };
  const forged = `xl_oauth=${Buffer.from(JSON.stringify(bad)).toString("base64url")}`;
  assert.equal(readFlow(reqWith(forged), url, 2000), null);
  assert.match(flowCookie(new URL("https://app.example/"), f), /^__Host-xl_oauth=.+; Secure$/);
});

test("gợi ý tên đăng nhập từ email: bỏ dấu, ký tự lạ, phần +tag", () => {
  assert.equal(usernameBase("Phạm.Trung_Kiên+sach@gmail.com"), "pham.trung_kien");
  assert.equal(usernameBase("Đức@x.vn"), "duc");
  assert.equal(usernameBase("ab@x.vn"), "abreader");
  assert.equal(usernameBase("..__@x.vn"), "");
  assert.equal(usernameBase(undefined), "");
  assert.equal(usernameBase("admin@x.vn"), "admin", "tên giữ chỗ bị lọc ở usernameCandidates");
  const c = usernameCandidates("admin@x.vn", () => 1234);
  assert.ok(!c.includes("admin"));
  assert.equal(c[0], "admin2");
  assert.deepEqual(usernameCandidates(undefined, () => 1234), ["reader1234", "reader1234", "reader1234"]);
  assert.equal(usernameCandidates("kien@gmail.com")[1], "kien2");
  assert.ok(usernameCandidates("a".repeat(60) + "@x.vn").every((u) => u.length <= 32));
});

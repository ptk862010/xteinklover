import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanText, isProof, normalizeUsername, usernameError } from "../src/validate";

test("tên đăng nhập hợp lệ / không hợp lệ", () => {
  for (const ok of ["kien", "a.b", "user_01", "x-y-z", "abc"]) assert.equal(usernameError(ok), null, ok);
  for (const bad of ["ab", "kiên", "Kien", ".abc", "abc.", "a b", "x".repeat(33), "admin", "a/b"]) assert.notEqual(usernameError(bad), null, bad);
  assert.equal(normalizeUsername("  KIEN "), "kien");
  assert.equal(normalizeUsername(42), "");
});

test("proof phải đúng 64 hex thường", () => {
  assert.ok(isProof("0".repeat(64)));
  assert.ok(!isProof("0".repeat(63)));
  assert.ok(!isProof("G".repeat(64)));
  assert.ok(!isProof(undefined));
});

test("cleanText bỏ ký tự điều khiển, gộp khoảng trắng, cắt độ dài", () => {
  assert.equal(cleanText("  a\u0000b\n\n c ", "x"), "a b c");
  assert.equal(cleanText("", "x"), "x");
  assert.equal(cleanText(5, "x"), "x");
  assert.equal(cleanText("abcdef", "x", 3), "abc");
});

test("luật tên đăng nhập ở trình duyệt (public/app.js) khớp server", async () => {
  const { readFileSync } = await import("node:fs");
  const { USERNAME_RE } = await import("../src/validate");
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const re = app.match(/const USERNAME_RE = (\/.+\/);/)?.[1];
  assert.equal(re, String(USERNAME_RE));
  const reserved = app.match(/const RESERVED = (\[[^\]]+\]);/)?.[1];
  assert.ok(reserved, "có RESERVED trong app.js");
  const clientList = JSON.parse(reserved!) as string[];
  for (const name of clientList) assert.notEqual(usernameError(name), null, `server cũng chặn ${name}`);
  for (const name of ["admin", "root", "api", "opds", "books", "login", "logout", "signup", "support", "xteink", "xteinklover", "system"]) {
    assert.ok(clientList.includes(name), `trình duyệt cũng chặn ${name}`);
  }
});

test("cleanText cắt theo ký tự, không cắt đôi emoji", () => {
  assert.equal(cleanText("ab😀cd", "x", 3), "ab😀");
});

test("cleanText bỏ ký tự XML không hợp lệ (U+FFFE/FFFF, surrogate lẻ), giữ emoji", () => {
  assert.equal(cleanText("a\ufffeb\uffffc\ud800d\udc00e😀f", "x"), "a b c d e😀f");
});

test("signupOpen: đóng khi không có mã mời và không bật OPEN_SIGNUP", async () => {
  const { signupOpen } = await import("../src/accounts");
  const base = {} as Parameters<typeof signupOpen>[0];
  assert.equal(signupOpen({ ...base }), false);
  assert.equal(signupOpen({ ...base, SIGNUP_CODE: "   " }), false);
  assert.equal(signupOpen({ ...base, SIGNUP_CODE: "moi" }), true);
  assert.equal(signupOpen({ ...base, OPEN_SIGNUP: "1" }), true);
  assert.equal(signupOpen({ ...base, OPEN_SIGNUP: "true" }), false);
});

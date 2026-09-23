import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVER_ITERATIONS, fromHex, hashProof, newReadableKey, newToken, timingSafeEqualStr, toHex, verifyProof } from "../src/crypto";

test("SERVER_ITERATIONS không vượt trần 100k của production Workers", () => {
  assert.ok(SERVER_ITERATIONS > 0 && SERVER_ITERATIONS <= 100_000);
});

test("hashProof / verifyProof đúng và sai", async () => {
  const proof = "a".repeat(64);
  const h = await hashProof(proof);
  assert.match(h.hash, /^[0-9a-f]{64}$/);
  assert.match(h.salt, /^[0-9a-f]{32}$/);
  assert.equal(h.iterations, SERVER_ITERATIONS);
  assert.ok(await verifyProof(proof, h));
  assert.ok(!(await verifyProof("b".repeat(64), h)));
  // salt ngẫu nhiên → hai lần băm khác nhau
  assert.notEqual((await hashProof(proof)).hash, h.hash);
});

test("khóa đọc được: 4 nhóm 4 ký tự, không có ký tự dễ nhầm", () => {
  for (let i = 0; i < 200; i++) {
    const k = newReadableKey();
    assert.match(k, /^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){3}$/);
  }
  assert.notEqual(newReadableKey(), newReadableKey());
});

test("token phiên 64 hex", () => {
  assert.match(newToken(), /^[0-9a-f]{64}$/);
});

test("hex hai chiều + so sánh", () => {
  assert.equal(toHex(fromHex("00ff10")), "00ff10");
  assert.throws(() => fromHex("zz"));
  assert.ok(timingSafeEqualStr("ă", "ă"));
  assert.ok(!timingSafeEqualStr("a", "ab"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { koreaderHash } from "../src/kohash";

const nodeMd5 = async (b: Uint8Array) => createHash("md5").update(b).digest("hex");

/** Cách tính viết lại độc lập, theo đúng mô tả của KOReader: mẫu 1 KB ở 0, 1K, 4K, 16K… (lshift(1024, 2i), i = -1 → 0). */
function expected(bytes: Uint8Array): string {
  const h = createHash("md5");
  for (const off of [0, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864, 268435456, 1073741824]) {
    if (off >= bytes.length) break;
    h.update(bytes.subarray(off, off + 1024));
  }
  return h.digest("hex");
}

function pattern(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + (i >> 10)) & 0xff;
  return b;
}

test("koreaderHash: khớp partial MD5 của KOReader với nhiều cỡ file (kể cả mẫu cuối bị cụt)", async () => {
  for (const n of [10, 1024, 1025, 5000, 70_000, 300_000, 1_100_000]) {
    const b = pattern(n);
    assert.equal(await koreaderHash(b, nodeMd5), expected(b), `cỡ ${n}`);
  }
});

test("koreaderHash: đổi một byte ngoài các vị trí lấy mẫu thì mã giữ nguyên, trong vị trí lấy mẫu thì đổi", async () => {
  const a = pattern(20_000);
  const outside = a.slice();
  outside[3000] ^= 1;
  const inside = a.slice();
  inside[4100] ^= 1;
  const h = await koreaderHash(a, nodeMd5);
  assert.equal(await koreaderHash(outside, nodeMd5), h);
  assert.notEqual(await koreaderHash(inside, nodeMd5), h);
  assert.match(h, /^[0-9a-f]{32}$/);
});

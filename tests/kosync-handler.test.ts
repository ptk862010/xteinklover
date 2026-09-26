import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as db from "../src/db";
import type { Env } from "../src/env";
import worker from "../src/index";
import { kosync, kosyncEarly, makeVerifiers } from "../src/kosync";
import { addUser, freshDb } from "./d1shim";

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
const CODE = "11112222333344445555";
const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => undefined), passThroughOnException() {} } as unknown as ExecutionContext;

async function setup(extra: Partial<Env> = {}) {
  const { fake, db: d } = freshDb();
  addUser(fake, "u1", "kien", Date.now());
  const salt = "ab".repeat(16);
  await db.insertSyncKey(d, { id: "k1", user_id: "u1", name: "Kindle", salt, ...(await makeVerifiers(CODE, salt, async (s) => md5(s))), created_at: Date.now(), last_used: 0 }, 5);
  const env = { DB: d, ...extra } as unknown as Env;
  return { fake, env };
}

const H = (key = md5(CODE), user = "kien") => ({ "x-auth-user": user, "x-auth-key": key, Accept: "application/vnd.koreader.v1+json" });

async function call(env: Env, path: string, init: RequestInit = {}) {
  const req = new Request("https://xteinklover.test" + path, init);
  const res = await kosync(req, env, ctx, path, (init.method ?? "GET").toUpperCase());
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, type: res.headers.get("content-type") };
}

const put = (env: Env, body: unknown, headers = H()) =>
  call(env, "/syncs/progress", { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });

const DOC = "59d481d168cca6267322f150c5f6a2a3";
const P = { document: DOC, progress: "/body/DocFragment[3]/body/p[42]/text().17", percentage: 0.4213, device: "Kindle", device_id: "ABCDEF0123456789ABCDEF0123456789" };

test("KOSync: đăng nhập đúng mã (3 cách gõ, tên hoa/thường, có dấu cách thừa ở tên) → 200 authorized", async () => {
  const { env } = await setup();
  for (const typed of [CODE, "1111 2222 3333 4444 5555", "1111-2222-3333-4444-5555"]) {
    const r = await call(env, "/users/auth", { headers: H(md5(typed), " Kien ") });
    assert.equal(r.status, 200, typed);
    assert.deepEqual(r.body, { authorized: "OK" });
    assert.match(r.type ?? "", /application\/json/);
  }
});

test("KOSync: sai mã / sai tên / thiếu header → 401 {code 2001}", async () => {
  const { env } = await setup();
  const cases: Record<string, string>[] = [H(md5("sai")), H(md5(CODE), "khongco"), { "x-auth-user": "kien" }, {}];
  for (const h of cases) {
    const r = await call(env, "/users/auth", { headers: h });
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 2001);
  }
});

test("KOSync: sách chưa có tiến độ → 200 {} (không 404/5xx)", async () => {
  const { env } = await setup();
  const r = await call(env, "/syncs/progress/" + DOC, { headers: H() });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {});
});

test("KOSync: đẩy rồi kéo — progress nguyên văn, timestamp giây, device_id giữ lại", async () => {
  const { env } = await setup();
  const before = Math.floor(Date.now() / 1000);
  const w = await put(env, P);
  assert.equal(w.status, 200);
  assert.equal(w.body.document, DOC);
  assert.equal(Number.isInteger(w.body.timestamp), true);
  assert.ok(w.body.timestamp >= before && w.body.timestamp < before + 5, "đơn vị giây");
  const r = await call(env, "/syncs/progress/" + DOC, { headers: H() });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { document: DOC, percentage: 0.4213, progress: P.progress, device: "Kindle", device_id: P.device_id, timestamp: w.body.timestamp });
  // Máy CrossPoint đẩy tiếp: ghi đè, không có device_id thì không trả device_id
  const w2 = await put(env, { document: DOC, progress: "56", percentage: "0.5", device: "CrossPoint" });
  assert.equal(w2.status, 200);
  const r2 = await call(env, "/syncs/progress/" + DOC, { headers: H() });
  assert.equal(r2.body.progress, "56");
  assert.equal(r2.body.percentage, 0.5);
  assert.equal(r2.body.device_id, undefined);
});

test("KOSync: dữ liệu hỏng → 403 với mã đúng; JSON hỏng → 400; không bao giờ 401", async () => {
  const { env } = await setup();
  assert.equal((await put(env, { ...P, document: "a:b" })).body.code, 2004);
  assert.equal((await put(env, { ...P, progress: 5 })).status, 403);
  const bad = await call(env, "/syncs/progress", { method: "PUT", headers: H(), body: "{not json" });
  assert.equal(bad.status, 400);
  const arr = await call(env, "/syncs/progress", { method: "PUT", headers: H(), body: "[1,2]" });
  assert.equal(arr.status, 400);
});

test("KOSync: đường / method lạ → 404 JSON; mã sách sai luật ở GET → 404", async () => {
  const { env } = await setup();
  for (const [path, method] of [["/syncs/progress", "GET"], ["/users/me", "DELETE"], ["/users/password", "PUT"], ["/users/auth", "POST"], ["/syncs/xyz", "GET"], ["/syncs/progress/a.b", "GET"]]) {
    const r = await call(env, path, { method, headers: H() });
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.equal(r.body.code, 2008);
  }
});

test("KOSync: đăng ký qua máy đọc bị tắt → 402, lời nhắn song ngữ trỏ đúng origin; healthcheck", () => {
  const url = new URL("https://ban-tu-dung.example/users/create");
  const r = kosyncEarly("/users/create", "POST", url);
  assert.ok(r);
  assert.equal(r.status, 402);
  const hc = kosyncEarly("/healthcheck", "GET", url);
  assert.equal(hc?.status, 200);
  assert.equal(kosyncEarly("/users/auth", "GET", url), null);
  return r.json().then((raw) => {
    const b = raw as { code: number; message: string };
    assert.equal(b.code, 2005);
    assert.match(b.message, /https:\/\/ban-tu-dung\.example/);
    assert.match(b.message, /Create your account/);
  });
});

test("KOSync: quá trần sách mới/ngày → 403; sách đã có vẫn cập nhật bình thường", async () => {
  const { env } = await setup({ MAX_SYNC_NEW_PER_DAY: "2" });
  assert.equal((await put(env, { ...P, document: "d1" })).status, 200);
  assert.equal((await put(env, { ...P, document: "d2" })).status, 200);
  assert.equal((await put(env, { ...P, document: "d3" })).status, 403);
  assert.equal((await put(env, { ...P, document: "d1", progress: "/moi" })).status, 200, "cập nhật không bị trần chặn");
});

test("KOSync: trần lượt ghi mỗi người mỗi ngày → 503 (không 401), không ghi thêm; đọc vẫn chạy", async () => {
  const { env } = await setup({ MAX_SYNC_WRITES_PER_DAY: "3" });
  for (let i = 1; i <= 3; i++) assert.equal((await put(env, { ...P, progress: "/p" + i })).status, 200, "lần " + i);
  const over = await put(env, { ...P, progress: "/p4" });
  assert.equal(over.status, 503);
  assert.equal(over.body.code, 2000);
  const r = await call(env, "/syncs/progress/" + DOC, { headers: H() });
  assert.equal(r.status, 200);
  assert.equal(r.body.progress, "/p3", "lần vượt trần không được ghi");
});

test("KOSync: trần lượt ghi cả hệ thống mỗi ngày → 503 cho mọi người", async () => {
  const { fake, env } = await setup({ MAX_SYNC_WRITES_PER_DAY_TOTAL: "2" });
  addUser(fake, "u2", "binh", Date.now());
  const salt = "cd".repeat(16);
  await db.insertSyncKey(env.DB, { id: "k2", user_id: "u2", name: "Xteink", salt, ...(await makeVerifiers(CODE, salt, async (s) => md5(s))), created_at: Date.now(), last_used: 0 }, 5);
  assert.equal((await put(env, P)).status, 200);
  assert.equal((await put(env, P, H(md5(CODE), "binh"))).status, 200);
  assert.equal((await put(env, P, H(md5(CODE), "binh"))).status, 503);
  assert.equal((await put(env, P)).status, 503);
});

test("KOSync: request sai định dạng (key không phải md5, tên sai luật) bị loại trước khi chạm D1", async () => {
  let touched = 0;
  const spy = {
    prepare() {
      touched++;
      throw new Error("không được gọi D1");
    },
    batch() {
      touched++;
      throw new Error("không được gọi D1");
    },
  };
  const env = { DB: spy } as unknown as Env;
  for (const h of [H("khong-phai-md5"), H(md5(CODE), "a"), H(md5(CODE), "ten co dau cach"), { "x-auth-user": "kien", "x-auth-key": "0".repeat(31) }]) {
    assert.equal((await call(env, "/users/auth", { headers: h })).status, 401);
  }
  assert.equal(touched, 0);
});

test("KOSync: mã bị thu hồi → 401 ngay", async () => {
  const { env } = await setup();
  assert.equal((await call(env, "/users/auth", { headers: H() })).status, 200);
  await db.deleteSyncKey(env.DB, "u1", "k1");
  assert.equal((await call(env, "/users/auth", { headers: H() })).status, 401);
});

test("KOSync: D1 lỗi lúc xác thực → 5xx {code 2000}, KHÔNG BAO GIỜ 401 (401 làm KOReader vứt tiến độ)", async () => {
  const broken = {
    prepare() {
      throw new Error("D1_ERROR: database unavailable");
    },
    batch() {
      throw new Error("D1_ERROR: database unavailable");
    },
  };
  const env = { DB: broken } as unknown as Env;
  await assert.rejects(call(env, "/users/auth", { headers: H() }), /D1_ERROR/);
  // Qua cổng chính (index.ts): catch trả JSON KOSync
  const origError = console.error;
  console.error = () => undefined;
  try {
    for (const path of ["/users/auth", "/syncs/progress/" + DOC]) {
      const res = await worker.fetch(new Request("https://xteinklover.test" + path, { headers: H() }), env, ctx);
      assert.ok(res.status >= 500, `${path}: ${res.status}`);
      assert.equal(((await res.json()) as { code: number }).code, 2000);
    }
    const quotaEnv = { DB: { prepare() { throw new Error("D1 free tier daily limit exceeded"); } } } as unknown as Env;
    const q = await worker.fetch(new Request("https://xteinklover.test/users/auth", { headers: H() }), quotaEnv, ctx);
    assert.equal(q.status, 503);
  } finally {
    console.error = origError;
  }
});

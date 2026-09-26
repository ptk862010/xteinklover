import { test } from "node:test";
import assert from "node:assert/strict";
import * as db from "../src/db";
import { addUser, freshDb } from "./d1shim";

const DAY = 86400_000;
const NOW = Date.UTC(2026, 8, 26, 12);
const nowSec = Math.floor(NOW / 1000);

function keyRow(id: string, userId: string, lastUsed = 0): db.SyncKeyRow {
  return { id, user_id: userId, name: "Kindle", salt: "00".repeat(16), v_plain: "a".repeat(64), v_space: "b".repeat(64), v_dash: "c".repeat(64), created_at: NOW, last_used: lastUsed };
}

function progress(document: string, progress = "/body/DocFragment[1]/body/p[1]/text().0", percentage = 0.1): db.SyncProgressIn {
  return { document, progress, percentage, device: "Kindle", device_id: "DEV1" };
}

async function setup() {
  const { fake, db: d } = freshDb();
  addUser(fake, "u1", "kien", NOW);
  assert.equal(await db.insertSyncKey(d, keyRow("k1", "u1"), 5), true);
  return { fake, d };
}

test("mã đồng bộ: tối đa 5 mã mỗi người; liệt kê; thu hồi đúng chủ", async () => {
  const { fake, d } = await setup();
  for (let i = 2; i <= 5; i++) assert.equal(await db.insertSyncKey(d, keyRow("k" + i, "u1"), 5), true);
  assert.equal(await db.insertSyncKey(d, keyRow("k6", "u1"), 5), false);
  assert.equal((await db.listSyncKeys(d, "u1")).length, 5);
  addUser(fake, "u2", "binh", NOW);
  assert.equal(await db.deleteSyncKey(d, "u2", "k1"), false, "người khác không thu hồi được");
  assert.equal(await db.deleteSyncKey(d, "u1", "k1"), true);
  assert.equal((await db.listSyncKeys(d, "u1")).length, 4);
});

test("xác thực: một truy vấn lấy user + các mã; tên lạ → null; user chưa có mã → mảng rỗng", async () => {
  const { fake, d } = await setup();
  const a = await db.getSyncAuth(d, "kien");
  assert.ok(a);
  assert.equal(a.user.id, "u1");
  assert.deepEqual(a.keys.map((k) => k.id), ["k1"]);
  assert.equal(await db.getSyncAuth(d, "khongco"), null);
  addUser(fake, "u2", "binh", NOW);
  const b = await db.getSyncAuth(d, "binh");
  assert.ok(b);
  assert.deepEqual(b.keys, []);
});

test("tiến độ: sách chưa có → null; ghi mới rồi cập nhật; đếm số sách bằng trigger", async () => {
  const { d } = await setup();
  assert.equal(await db.getSyncProgress(d, "u1", "doc1"), null);
  assert.equal(await db.updateSyncProgress(d, "u1", progress("doc1"), nowSec), false, "chưa có dòng để cập nhật");
  assert.equal(await db.insertSyncProgress(d, "u1", progress("doc1"), nowSec, 1000), true);
  assert.equal(await db.syncDocCount(d, "u1"), 1);
  assert.equal(await db.updateSyncProgress(d, "u1", { ...progress("doc1", "/p[9]", 0.9), device: "Xteink", device_id: null }, nowSec + 5), true);
  const r = await db.getSyncProgress(d, "u1", "doc1");
  assert.deepEqual(r, { document: "doc1", progress: "/p[9]", percentage: 0.9, device: "Xteink", device_id: null, updated_at: nowSec + 5 });
  assert.equal(await db.syncDocCount(d, "u1"), 1, "cập nhật không đổi số sách");
});

test("tiến độ: nhánh thêm mới gặp sách đã có (hai PUT song song) → cập nhật, không lỗi, không đếm đôi", async () => {
  const { d } = await setup();
  assert.equal(await db.insertSyncProgress(d, "u1", progress("doc1", "/a", 0.1), nowSec, 1000), true);
  assert.equal(await db.insertSyncProgress(d, "u1", progress("doc1", "/b", 0.2), nowSec + 1, 1000), true);
  assert.equal((await db.getSyncProgress(d, "u1", "doc1"))?.progress, "/b");
  assert.equal(await db.syncDocCount(d, "u1"), 1);
});

test("tiến độ: vượt trần thì đẩy sách lâu nhất không đụng tới, sách mới vẫn vào", async () => {
  const { d } = await setup();
  for (let i = 1; i <= 3; i++) assert.equal(await db.insertSyncProgress(d, "u1", progress("doc" + i), nowSec + i, 3), true);
  // doc1 cũ nhất, nhưng vừa được đọc lại → doc2 thành cũ nhất
  await db.updateSyncProgress(d, "u1", progress("doc1", "/moi"), nowSec + 10);
  assert.equal(await db.insertSyncProgress(d, "u1", progress("doc4"), nowSec + 11, 3), true);
  assert.equal(await db.syncDocCount(d, "u1"), 3);
  assert.equal(await db.getSyncProgress(d, "u1", "doc2"), null, "doc2 bị đẩy ra");
  for (const doc of ["doc1", "doc3", "doc4"]) assert.ok(await db.getSyncProgress(d, "u1", doc), doc);
});

test("tiến độ: sách mới không bao giờ tự đẩy chính nó ra dù trùng giây", async () => {
  const { d } = await setup();
  for (let i = 1; i <= 3; i++) await db.insertSyncProgress(d, "u1", progress("doc" + i), nowSec, 3);
  assert.equal(await db.insertSyncProgress(d, "u1", progress("doc4"), nowSec, 3), true);
  assert.ok(await db.getSyncProgress(d, "u1", "doc4"));
  assert.equal(await db.syncDocCount(d, "u1"), 3);
});

test("tiến độ: không ghi cho tài khoản đã xoá hoặc không còn mã đồng bộ (không dòng mồ côi)", async () => {
  const { fake, d } = await setup();
  addUser(fake, "u2", "binh", NOW);
  assert.equal(await db.insertSyncProgress(d, "u2", progress("doc1"), nowSec, 1000), false, "không có mã");
  assert.equal(await db.insertSyncProgress(d, "ghost", progress("doc1"), nowSec, 1000), false, "không có user");
  assert.equal(fake.raw.prepare("SELECT COUNT(*) AS n FROM sync_progress").get()?.n, 0);
});

test("cron: giữ tài khoản có mã dùng trong 90 ngày; xoá tài khoản mã bỏ hoang cùng dữ liệu đồng bộ", async () => {
  const { fake, db: d } = freshDb();
  // Cả ba: không đăng nhập 30 ngày, không có sách
  addUser(fake, "keep", "dongbo", NOW - 30 * DAY);
  addUser(fake, "drop", "bohoang", NOW - 30 * DAY);
  addUser(fake, "plain", "trong", NOW - 30 * DAY);
  await db.insertSyncKey(d, keyRow("kk", "keep", NOW - 20 * DAY), 5);
  await db.insertSyncKey(d, keyRow("kd", "drop", NOW - 100 * DAY), 5);
  await db.insertSyncProgress(d, "keep", progress("doc1"), nowSec, 1000);
  await db.insertSyncProgress(d, "drop", progress("doc1"), nowSec, 1000);
  await db.cronCleanup(d, NOW);
  const ids = (fake.raw.prepare("SELECT id FROM users ORDER BY id").all() as { id: string }[]).map((r) => r.id);
  assert.deepEqual(ids, ["keep"]);
  assert.equal(fake.raw.prepare("SELECT COUNT(*) AS n FROM sync_keys WHERE user_id = 'drop'").get()?.n, 0);
  assert.equal(fake.raw.prepare("SELECT COUNT(*) AS n FROM sync_progress WHERE user_id = 'drop'").get()?.n, 0);
  assert.equal(fake.raw.prepare("SELECT COUNT(*) AS n FROM sync_counts WHERE user_id = 'drop'").get()?.n, 0);
  assert.equal(await db.syncDocCount(d, "keep"), 1);
});

test("chạm mã: ghi lần dùng cuối và tính tài khoản còn hoạt động (ms, không lùi)", async () => {
  const { fake, d } = await setup();
  await db.touchSyncKey(d, "k1", "u1", NOW + DAY);
  assert.equal((await db.listSyncKeys(d, "u1"))[0].last_used, NOW + DAY);
  assert.equal(fake.raw.prepare("SELECT last_login AS t FROM users WHERE id = 'u1'").get()?.t, NOW + DAY);
  await db.touchSyncKey(d, "k1", "u1", NOW - DAY);
  assert.equal(fake.raw.prepare("SELECT last_login AS t FROM users WHERE id = 'u1'").get()?.t, NOW + DAY, "không lùi last_login");
});

test("xoá tài khoản xoá sạch mã, tiến độ, bộ đếm", async () => {
  const { fake, d } = await setup();
  await db.insertSyncProgress(d, "u1", progress("doc1"), nowSec, 1000);
  await db.deleteUserCascade(d, "u1", NOW);
  for (const t of ["users", "sync_keys", "sync_progress", "sync_counts"]) {
    assert.equal(fake.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n, 0, t);
  }
});

test("đổi mật khẩu: thu hồi mã đồng bộ, trừ khi chọn giữ; tiến độ vẫn còn", async () => {
  const { d } = await setup();
  await db.insertSyncProgress(d, "u1", progress("doc1"), nowSec, 1000);
  const h = { hash: "h2", salt: "s2", iterations: 2000 };
  await db.changePasswordAndRevoke(d, "u1", h, "keep-session", true);
  assert.equal((await db.listSyncKeys(d, "u1")).length, 1, "giữ mã");
  await db.changePasswordAndRevoke(d, "u1", h, "keep-session", false);
  assert.equal((await db.listSyncKeys(d, "u1")).length, 0, "thu hồi mã");
  assert.ok(await db.getSyncProgress(d, "u1", "doc1"), "tiến độ không mất");
});

test("xoá dữ liệu đồng bộ của một người: về 0 sách", async () => {
  const { d } = await setup();
  await db.insertSyncProgress(d, "u1", progress("doc1"), nowSec, 1000);
  await db.insertSyncProgress(d, "u1", progress("doc2"), nowSec, 1000);
  await db.clearSyncProgress(d, "u1");
  assert.equal(await db.syncDocCount(d, "u1"), 0);
  assert.equal(await db.getSyncProgress(d, "u1", "doc1"), null);
});

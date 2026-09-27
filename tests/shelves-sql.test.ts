import { test } from "node:test";
import assert from "node:assert/strict";
import * as db from "../src/db";
import { addUser, freshDb } from "./d1shim";

const NOW = Date.UTC(2026, 8, 27, 12);

function book(id: string, userId = "u1", size = 1000, koHash: string | null = null): db.BookRow {
  return { id, user_id: userId, title: "Sách " + id, author: "", size, added: new Date(NOW).toISOString(), blob_key: "b:" + id, ko_hash: koHash };
}

async function setup() {
  const { fake, db: d } = freshDb();
  addUser(fake, "u1", "kien", NOW);
  addUser(fake, "u2", "binh", NOW);
  for (const id of ["a1", "a2", "a3"]) assert.equal(await db.insertBookWithinQuota(d, book(id), 10, 1e9, 1e9), "ok");
  assert.equal(await db.insertBookWithinQuota(d, book("b1", "u2"), 10, 1e9, 1e9), "ok");
  return { fake, d };
}

test("sách mới: mặc định Lên máy, chưa về máy, chưa có tầng; ko_hash lưu lúc gửi", async () => {
  const { d } = await setup();
  assert.equal(await db.insertBookWithinQuota(d, book("a4", "u1", 10, "f".repeat(32)), 10, 1e9, 1e9), "ok");
  const m = (await db.listBooks(d, "u1")).map(db.toMeta).find((b) => b.id === "a4")!;
  assert.equal(m.onDevice, true);
  assert.equal(m.fetched, 0);
  assert.deepEqual(m.shelves, []);
  assert.equal(m.progress, null);
  assert.equal(m.isbn, "");
});

test("tầng: tạo (trùng tên / quá số lượng bị chặn), đổi tên, gán sách, đếm, xóa tầng thì gỡ khỏi sách", async () => {
  const { d } = await setup();
  assert.equal(await db.createShelf(d, { id: "s1", user_id: "u1", name: "Văn học", created_at: NOW }, 3), "ok");
  assert.equal(await db.createShelf(d, { id: "s2", user_id: "u1", name: "Văn học", created_at: NOW }, 3), "exists");
  assert.equal(await db.createShelf(d, { id: "s2", user_id: "u1", name: "Higashino Keigo", created_at: NOW }, 3), "ok");
  assert.equal(await db.createShelf(d, { id: "s3", user_id: "u1", name: "Kinh doanh", created_at: NOW }, 3), "ok");
  assert.equal(await db.createShelf(d, { id: "s4", user_id: "u1", name: "Thừa", created_at: NOW }, 3), "full");
  assert.equal(await db.createShelf(d, { id: "x1", user_id: "u2", name: "Văn học", created_at: NOW }, 3), "ok", "người khác đặt trùng tên được");

  assert.equal(await db.setBookShelves(d, "u1", "a1", ["s1", "s2", "x1", "khongco"]), true);
  assert.equal(await db.setBookShelves(d, "u1", "a2", ["s1"]), true);
  assert.equal(await db.setBookShelves(d, "u1", "b1", ["s1"]), false, "không gán được sách người khác");
  const a1 = (await db.listBooks(d, "u1")).map(db.toMeta).find((b) => b.id === "a1")!;
  assert.deepEqual([...(a1.shelves ?? [])].sort(), ["s1", "s2"], "tầng của người khác và tầng lạ bị bỏ qua");

  const shelves = await db.listShelves(d, "u1");
  assert.deepEqual(shelves.map((s) => [s.id, s.count]), [["s2", 1], ["s3", 0], ["s1", 2]], "xếp theo tên");
  assert.equal(await db.renameShelf(d, "u1", "s3", "Higashino Keigo"), "exists");
  assert.equal(await db.renameShelf(d, "u1", "s3", "Kinh tế"), "ok");
  assert.equal(await db.renameShelf(d, "u2", "s3", "Cướp"), "missing");

  assert.equal(await db.deleteShelf(d, "u2", "s1"), false);
  assert.equal(await db.deleteShelf(d, "u1", "s1"), true);
  const after = (await db.listBooks(d, "u1")).map(db.toMeta);
  assert.deepEqual(after.find((b) => b.id === "a1")!.shelves, ["s2"]);
  assert.deepEqual(after.find((b) => b.id === "a2")!.shelves, []);
  // Gán lại = thay cả danh sách
  assert.equal(await db.setBookShelves(d, "u1", "a1", []), true);
  assert.deepEqual((await db.listBooks(d, "u1")).map(db.toMeta).find((b) => b.id === "a1")!.shelves, []);
});

test("sửa thông tin sách: chỉ chủ sửa được; Lên máy quyết định sách nào có trong OPDS", async () => {
  const { d } = await setup();
  assert.equal(await db.updateBookMeta(d, "u1", "a1", { title: "Phía Sau Nghi Can X", author: "Higashino Keigo", isbn: "9786041085251" }), true);
  assert.equal(await db.updateBookMeta(d, "u1", "a2", { on_device: 0 }), true);
  assert.equal(await db.updateBookMeta(d, "u2", "a3", { on_device: 0 }), false);
  assert.equal(await db.updateBookMeta(d, "u1", "khongco", { title: "x" }), false);
  const a1 = db.toMeta((await db.getBook(d, "u1", "a1"))!);
  assert.deepEqual([a1.title, a1.author, a1.isbn], ["Phía Sau Nghi Can X", "Higashino Keigo", "9786041085251"]);
  const device = await db.listDeviceBooks(d, "u1", 50, 0);
  assert.deepEqual(device.map((b) => b.id).sort(), ["a1", "a3"]);
});

test("đã về máy + tiến độ đọc: nối sync_progress theo ko_hash của file", async () => {
  const { d } = await setup();
  const h = "a".repeat(32);
  await db.setKoHash(d, "a1", h);
  assert.deepEqual((await db.booksMissingHash(d, 10)).map((b) => b.id).sort(), ["a2", "a3", "b1"]);
  await db.markFetched(d, "u1", "a1", NOW);
  await db.markFetched(d, "u2", "a2", NOW); // không phải chủ: không ghi
  // KOSync chỉ lưu tiến độ cho người đã có mã đồng bộ
  for (const u of ["u1", "u2"]) {
    await db.insertSyncKey(d, { id: "k" + u, user_id: u, name: "X4", salt: "00", v_plain: "a", v_space: "b", v_dash: "c", created_at: NOW, last_used: 0 }, 5);
  }
  await db.insertSyncProgress(d, "u1", { document: h.toUpperCase(), progress: "p", percentage: 0.43, device: "X4", device_id: null }, 1_700_000_000, 1000);
  await db.insertSyncProgress(d, "u2", { document: h, progress: "p", percentage: 0.9, device: "K", device_id: null }, 1_700_000_000, 1000);
  const list = (await db.listBooks(d, "u1")).map(db.toMeta);
  const a1 = list.find((b) => b.id === "a1")!;
  assert.equal(a1.fetched, NOW);
  assert.equal(a1.progress, 0.43, "chỉ tiến độ của chính mình");
  assert.equal(list.find((b) => b.id === "a2")!.fetched, 0);
});

test("thay file: kiểm dung lượng kệ và kho chung theo phần chênh; cập nhật thống kê; máy phải tải lại", async () => {
  const { fake, d } = await setup();
  const total = () => (fake.raw.prepare("SELECT value FROM stats WHERE key = 'bytes'").get() as { value: number }).value;
  const before = total();
  await db.markFetched(d, "u1", "a1", NOW);
  assert.equal(await db.replaceBookFile(d, "u1", "a1", 1500, "b".repeat(32), 1e9, 1e9), "ok");
  assert.equal(total(), before + 500);
  const a1 = db.toMeta((await db.getBook(d, "u1", "a1"))!);
  assert.equal(a1.size, 1500);
  assert.equal(a1.fetched, 0, "máy đang giữ bản cũ");
  assert.equal(await db.replaceBookFile(d, "u1", "a1", 1500 + 2500, null, 3500 + 1000, 1e9), "shelf_full", "kệ u1: 1500+1000+1000 + phần tăng 2500 > 4500");
  assert.equal(await db.replaceBookFile(d, "u1", "a1", 1500 + 10_000, null, 1e9, before + 5000), "store_full");
  assert.equal(await db.replaceBookFile(d, "u2", "a1", 10, null, 1e9, 1e9), "missing");
  assert.equal(total(), before + 500, "thất bại thì không đổi thống kê");
  // Hoàn tác (ghi KV lỗi): trả lại kích thước và lúc máy tải
  assert.equal(await db.replaceBookFile(d, "u1", "a1", 1000, null, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, NOW), "ok");
  const back = db.toMeta((await db.getBook(d, "u1", "a1"))!);
  assert.deepEqual([back.size, back.fetched, total()], [1000, NOW, before]);
});

test("xóa tài khoản: xóa luôn tầng và liên kết tầng–sách", async () => {
  const { fake, d } = await setup();
  await db.createShelf(d, { id: "s1", user_id: "u1", name: "A", created_at: NOW }, 10);
  await db.setBookShelves(d, "u1", "a1", ["s1"]);
  await db.deleteUserCascade(d, "u1", NOW);
  const n = (sql: string) => (fake.raw.prepare(sql).get() as { n: number }).n;
  assert.equal(n("SELECT COUNT(*) AS n FROM shelves WHERE user_id = 'u1'"), 0);
  assert.equal(n("SELECT COUNT(*) AS n FROM book_shelves"), 0);
});

test("nâng cấp v5 → v6 (như bản thật): sách cũ giữ nguyên, mặc định Lên máy, chưa có mã KOReader", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { MIGRATIONS } = await import("../src/schema");
  const raw = new DatabaseSync(":memory:");
  for (const group of MIGRATIONS.slice(0, 5)) for (const sql of group) raw.prepare(sql).run();
  raw.prepare("INSERT INTO users (id, username, pass_hash, pass_salt, pass_iter, client_kdf, opds_key_hash, created_at) VALUES ('u1','kien','h','s',1,'k','o','x')").run();
  raw.prepare("INSERT INTO books (id, user_id, title, author, size, added, blob_key, cover) VALUES ('old1','u1','Hóa thân','Kafka',611,'x','b:old1',2)").run();
  for (const sql of MIGRATIONS[5]) raw.prepare(sql).run();
  const row = raw.prepare("SELECT * FROM books WHERE id = 'old1'").get() as Record<string, unknown>;
  assert.deepEqual([row.title, row.cover, row.on_device, row.fetched_at, row.ko_hash, row.isbn], ["Hóa thân", 2, 1, 0, null, ""]);
});

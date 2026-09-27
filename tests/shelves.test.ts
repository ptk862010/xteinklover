import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBookPatch, parseShelfName } from "../src/shelves";

test("parseBookPatch: làm sạch tên / tác giả, kiểm ISBN, onDevice là boolean, shelves là mảng id", () => {
  assert.deepEqual(parseBookPatch({ title: "  Phía   Sau Nghi Can X ", author: "Higashino\u0000 Keigo", isbn: "978-604-1-08525-1", onDevice: false, shelves: ["s1", "s1", "s2"] }), {
    patch: { title: "Phía Sau Nghi Can X", author: "Higashino Keigo", isbn: "9786041085251", on_device: 0 },
    shelves: ["s1", "s2"],
  });
  assert.deepEqual(parseBookPatch({ onDevice: true }), { patch: { on_device: 1 }, shelves: undefined });
  assert.deepEqual(parseBookPatch({ isbn: "" }), { patch: { isbn: "" }, shelves: undefined });
  assert.deepEqual(parseBookPatch({ author: "" }), { patch: { author: "" }, shelves: undefined });
});

test("parseBookPatch: dữ liệu sai thì trả lỗi tiếng Việt", () => {
  assert.equal(typeof parseBookPatch(null), "string");
  assert.equal(parseBookPatch({ title: "   " }), "Tên sách không được để trống");
  assert.equal(parseBookPatch({ isbn: "9786041085254" }), "ISBN không hợp lệ");
  assert.equal(parseBookPatch({ onDevice: "có" }), "Dữ liệu không hợp lệ");
  assert.equal(parseBookPatch({ shelves: "s1" }), "Dữ liệu không hợp lệ");
  assert.equal(parseBookPatch({ shelves: ["<script>"] }), "Dữ liệu không hợp lệ");
  assert.equal(parseBookPatch({ shelves: Array.from({ length: 101 }, (_, i) => "s" + i) }), "Dữ liệu không hợp lệ");
});

test("parseShelfName: 1–40 ký tự sau khi làm sạch", () => {
  assert.equal(parseShelfName("  Văn   học "), "Văn học");
  assert.equal(parseShelfName(""), null);
  assert.equal(parseShelfName(42), null);
  assert.equal(parseShelfName("x".repeat(41)), null);
});

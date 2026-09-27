import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSearch, googleUrl, isJpeg, openLibraryUrl, parseGoogle, parseOpenLibrary, rankCandidates, type CoverCandidate } from "../src/covers";

test("cleanSearch: bỏ đuôi rác trong tên file, tách “Tên - Tác giả” khi chưa có tác giả", () => {
  assert.deepEqual(cleanSearch("Hóa thân - Franz Kafka", ""), { title: "Hóa thân", author: "Franz Kafka" });
  assert.deepEqual(cleanSearch("Hóa thân - Franz Kafka", "Franz Kafka"), { title: "Hóa thân", author: "Franz Kafka" });
  assert.deepEqual(cleanSearch("Sapiens_ Lược Sử Loài Người (z-lib.org)", ""), { title: "Sapiens Lược Sử Loài Người", author: "" });
  assert.deepEqual(cleanSearch("[Ebook] Nhà Giả Kim [PDF]", "  Paulo   Coelho "), { title: "Nhà Giả Kim", author: "Paulo Coelho" });
  // Tên có gạch nối thật (không có khoảng trắng hai bên) thì giữ
  assert.deepEqual(cleanSearch("Spider-Man", ""), { title: "Spider-Man", author: "" });
});

test("googleUrl: ISBN thì tìm theo isbn:, không thì intitle:/inauthor:; có key", () => {
  const byIsbn = new URL(googleUrl({ title: "x", author: "y", isbn: "9786041085251" }, "K"));
  assert.equal(byIsbn.searchParams.get("q"), "isbn:9786041085251");
  assert.equal(byIsbn.searchParams.get("key"), "K");
  // Từng từ một (cụm trong ngoặc kép hay trượt với sách tiếng Việt); bỏ dấu câu, ngoặc kép
  const byName = new URL(googleUrl({ title: "Phía Sau: Nghi Can X", author: "Higashino Keigo" }, "K"));
  assert.equal(byName.searchParams.get("q"), "intitle:Phía intitle:Sau intitle:Nghi intitle:Can intitle:X inauthor:Higashino inauthor:Keigo");
  assert.equal(new URL(googleUrl({ title: 'Hóa "thân"', author: "" }, "")).searchParams.get("q"), "intitle:Hóa intitle:thân");
  assert.equal(new URL(googleUrl({ title: "a", author: "" }, "")).searchParams.has("key"), false);
});

test("parseGoogle: chỉ lấy cuốn có ảnh, ảnh qua https cỡ lớn, bỏ id lạ", () => {
  const items = parseGoogle({
    items: [
      { id: "lEfe0QEACAAJ", volumeInfo: { title: "The Metamorphosis / Hóa thân", authors: ["Franz Kafka"], language: "vi", publishedDate: "2026-02-14", publisher: "Tranzlaty", imageLinks: { thumbnail: "http://books.google.com/x" } } },
      { id: "noimg0000000", volumeInfo: { title: "Không ảnh", language: "vi" } },
      { id: "bad id<script>", volumeInfo: { title: "Lạ", imageLinks: { thumbnail: "http://x" } } },
    ],
  });
  assert.equal(items.length, 1);
  const c = items[0];
  assert.equal(c.source, "google");
  assert.equal(c.title, "The Metamorphosis / Hóa thân");
  assert.equal(c.authors, "Franz Kafka");
  assert.equal(c.year, "2026");
  assert.equal(c.lang, "vi");
  assert.equal(c.image, "https://books.google.com/books/content?id=lEfe0QEACAAJ&printsec=frontcover&img=1&zoom=1&fife=w480&source=gbs_api");
  assert.ok(c.thumb.startsWith("https://books.google.com/books/content?id=lEfe0QEACAAJ&"));
  assert.deepEqual(parseGoogle({ error: { message: "quota" } }), []);
  assert.deepEqual(parseGoogle(null), []);
});

test("openLibraryUrl + parseOpenLibrary: ảnh theo cover_i, mã ngôn ngữ 3 chữ đổi về 2 chữ", () => {
  assert.equal(new URL(openLibraryUrl({ title: "Metamorphosis", author: "Kafka" })).searchParams.get("title"), "Metamorphosis");
  assert.equal(new URL(openLibraryUrl({ title: "x", author: "", isbn: "0306406152" })).searchParams.get("isbn"), "0306406152");
  const items = parseOpenLibrary({
    docs: [
      { title: "Metamorphosis", author_name: ["Franz Kafka"], cover_i: 12820198, first_publish_year: 1915, language: ["ger", "eng"], publisher: ["Martino"] },
      { title: "Không bìa", author_name: ["A"] },
      { title: "Bìa âm", cover_i: -1 },
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].image, "https://covers.openlibrary.org/b/id/12820198-L.jpg");
  assert.equal(items[0].thumb, "https://covers.openlibrary.org/b/id/12820198-M.jpg");
  assert.equal(items[0].year, "1915");
  assert.equal(items[0].lang, "de");
  assert.deepEqual(parseOpenLibrary({}), []);
});

test("rankCandidates: bỏ trùng ảnh, cùng ngôn ngữ lên trước (giữ thứ tự còn lại), cắt số lượng", () => {
  const c = (id: string, lang?: string): CoverCandidate => ({ source: "google", title: id, authors: "", lang, image: "https://i/" + id, thumb: "https://t/" + id });
  const out = rankCandidates([c("a", "en"), c("b", "vi"), c("a", "en"), c("d"), c("e", "vi")], { lang: "vi" }, 3);
  assert.deepEqual(out.map((x) => x.title), ["b", "e", "a"]);
  assert.deepEqual(rankCandidates([c("a", "en"), c("b", "vi")]).map((x) => x.title), ["a", "b"]);
});

test("rankCandidates: tên trùng tên sách (bỏ dấu, không phân biệt hoa thường) lên trước cả ngôn ngữ", () => {
  const c = (title: string, lang: string): CoverCandidate => ({ source: "google", title, authors: "", lang, image: "https://i/" + title, thumb: "https://t/" + title });
  const items = [c("Vụ Án Mạng Bên Hồ", "vi"), c("The Metamorphosis", "en"), c("The Metamorphosis / Hóa thân", "vi"), c("Hoa Than", "en")];
  const out = rankCandidates(items, { title: "Hóa thân", lang: "vi" });
  assert.deepEqual(out.map((x) => x.title), ["The Metamorphosis / Hóa thân", "Hoa Than", "Vụ Án Mạng Bên Hồ", "The Metamorphosis"]);
});

test("isJpeg: chỉ nhận JPEG", () => {
  assert.equal(isJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0])), true);
  assert.equal(isJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), false);
  assert.equal(isJpeg(new Uint8Array([0xff])), false);
});

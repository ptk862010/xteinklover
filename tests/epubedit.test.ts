import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { buildEpub } from "../web/epub";
import { rewriteEpubMeta, setOpfMeta } from "../web/epubedit";
import { readEpubMeta } from "../web/epubmeta";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

test("setOpfMeta: thay tên, gom tác giả thành một, giữ người dịch và phần còn lại; thoát ký tự XML", () => {
  const opf = `<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title id="t1">Hoa-than_z-lib</dc:title>
    <dc:creator opf:role="aut">Unknown</dc:creator>
    <dc:creator>Ai đó</dc:creator>
    <dc:creator opf:role="trl">Người dịch</dc:creator>
    <dc:language>vi</dc:language>
  </metadata><manifest/></package>`;
  const out = setOpfMeta(opf, { title: "Hóa thân & truyện <khác>", author: "Franz Kafka" });
  assert.match(out, /<dc:title id="t1">Hóa thân &amp; truyện &lt;khác&gt;<\/dc:title>/);
  assert.equal((out.match(/<dc:creator/g) || []).length, 2);
  assert.match(out, /<dc:creator>Franz Kafka<\/dc:creator>/);
  assert.match(out, /<dc:creator opf:role="trl">Người dịch<\/dc:creator>/);
  assert.match(out, /<dc:language>vi<\/dc:language>/);
});

test("setOpfMeta: OPF thiếu tên / tác giả thì chèn vào <metadata>; tác giả rỗng thì bỏ hết tác giả", () => {
  const opf = `<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:language>en</dc:language></metadata></package>`;
  const out = setOpfMeta(opf, { title: "A", author: "B" });
  assert.match(out, /<metadata[^>]*>\s*<dc:title>A<\/dc:title>\s*<dc:creator>B<\/dc:creator>/);
  const none = setOpfMeta(`<package><metadata><dc:title>X</dc:title><dc:creator>Y</dc:creator></metadata></package>`, { title: "X", author: "" });
  assert.equal(none.includes("dc:creator"), false);
});

test("rewriteEpubMeta: EPUB mới đọc lại ra tên/tác giả mới, giữ bìa, mimetype vẫn đứng đầu và không nén", async () => {
  const bytes = await buildEpub({
    title: "Tên cũ",
    author: "Tác giả cũ",
    lang: "vi",
    bodyXhtml: "<p>nội dung</p>",
    images: [{ href: "images/cover.jpg", bytes: JPEG, mediaType: "image/jpeg" }],
    coverHref: "images/cover.jpg",
    identifier: "urn:t",
    date: "2026-09-27T00:00:00.000Z",
  });
  const out = await rewriteEpubMeta(bytes, { title: "Phía Sau Nghi Can X", author: "Higashino Keigo" });
  const m = readEpubMeta(out);
  assert.equal(m.title, "Phía Sau Nghi Can X");
  assert.equal(m.author, "Higashino Keigo");
  assert.deepEqual(m.cover && [...m.cover.bytes], [...JPEG]);
  // mimetype: mục đầu tiên, phương thức nén 0 (STORE) ở header cục bộ
  assert.equal(new TextDecoder().decode(out.subarray(30, 38)), "mimetype");
  assert.equal(out[8] | (out[9] << 8), 0);
  const zip = await JSZip.loadAsync(out);
  assert.equal(Object.keys(zip.files)[0], "mimetype");
  assert.match(await zip.file("OEBPS/text.xhtml")!.async("text"), /nội dung/);
});

test("rewriteEpubMeta: file không phải EPUB thì báo lỗi rõ ràng", async () => {
  await assert.rejects(rewriteEpubMeta(new Uint8Array([1, 2, 3]), { title: "a", author: "" }), /EPUB/);
  const zip = new JSZip();
  zip.file("a.txt", "x");
  await assert.rejects(rewriteEpubMeta(await zip.generateAsync({ type: "uint8array" }), { title: "a", author: "" }), /EPUB/);
});

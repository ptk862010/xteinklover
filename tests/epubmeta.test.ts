import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { buildEpub } from "../web/epub";
import { isIsbn, readEpubMeta } from "../web/epubmeta";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9]);

async function epub2(opf: string, files: Record<string, Uint8Array> = {}, opfPath = "OPS/book.opf"): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file(opfPath, opf);
  for (const [p, b] of Object.entries(files)) zip.file(p, b);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

test("readEpubMeta: EPUB do buildEpub dựng — tên, tác giả, ngôn ngữ, bìa cover-image", async () => {
  const bytes = await buildEpub({
    title: "Hóa thân & truyện khác",
    author: "Franz Kafka",
    lang: "vi",
    bodyXhtml: "<p>x</p>",
    images: [{ href: "images/cover.jpg", bytes: JPEG, mediaType: "image/jpeg" }],
    coverHref: "images/cover.jpg",
    identifier: "urn:t",
    date: "2026-09-27T00:00:00.000Z",
  });
  const m = readEpubMeta(bytes);
  assert.equal(m.title, "Hóa thân & truyện khác");
  assert.equal(m.author, "Franz Kafka");
  assert.equal(m.lang, "vi");
  assert.equal(m.isbn, undefined);
  assert.deepEqual(m.cover && [...m.cover.bytes], [...JPEG]);
  assert.equal(m.cover?.mediaType, "image/jpeg");
});

test("readEpubMeta: EPUB 2 — <meta content trước name>, ISBN hợp lệ, nhiều tác giả, bỏ người dịch, href có ../ và %20", async () => {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title><![CDATA[Nhà giả kim]]></dc:title>
    <dc:creator opf:role="aut" opf:file-as="Coelho, Paulo">Paulo Coelho</dc:creator>
    <dc:creator opf:role="trl">Lê Chu Cầu</dc:creator>
    <dc:identifier opf:scheme="uuid">9786041234567-khong-phai</dc:identifier>
    <dc:identifier opf:scheme="ISBN">978-604-1-08525-1</dc:identifier>
    <dc:language>vi</dc:language>
    <meta content="bia" name="cover"/>
  </metadata>
  <manifest>
    <item href="../Images/bia%20sach.png" id="bia" media-type="image/png"/>
  </manifest>
</package>`;
  const m = readEpubMeta(await epub2(opf, { "Images/bia sach.png": PNG }));
  assert.equal(m.title, "Nhà giả kim");
  assert.equal(m.author, "Paulo Coelho");
  assert.equal(m.isbn, "9786041085251");
  assert.equal(m.cover?.mediaType, "image/png");
  assert.deepEqual(m.cover && [...m.cover.bytes], [...PNG]);
});

test("readEpubMeta: không khai bìa thì đoán theo tên file ảnh có chữ cover; tên rác bị bỏ", async () => {
  const opf = `<package><metadata><dc:title>Microsoft Word - sach.doc</dc:title><dc:creator>Unknown</dc:creator></metadata>
  <manifest><item id="x1" href="text.xhtml" media-type="application/xhtml+xml"/><item id="img9" href="img/Cover.jpeg" media-type="image/jpeg"/></manifest></package>`;
  const m = readEpubMeta(await epub2(opf, { "OPS/img/Cover.jpeg": JPEG }));
  assert.equal(m.title, undefined);
  assert.equal(m.author, undefined);
  assert.equal(m.cover?.mediaType, "image/jpeg");
});

test("readEpubMeta: file hỏng, không có container, bìa khai mà thiếu file → không ném lỗi", async () => {
  assert.deepEqual(readEpubMeta(new Uint8Array([1, 2, 3])), {});
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  assert.deepEqual(readEpubMeta(await zip.generateAsync({ type: "uint8array" })), {});
  const opf = `<package><metadata><dc:title>A</dc:title></metadata><manifest><item id="c" href="c.jpg" media-type="image/jpeg" properties="cover-image"/></manifest></package>`;
  const m = readEpubMeta(await epub2(opf));
  assert.equal(m.title, "A");
  assert.equal(m.cover, undefined);
});

test("isIsbn: kiểm số kiểm tra ISBN-10 / ISBN-13", () => {
  assert.equal(isIsbn("9786041085251"), true);
  assert.equal(isIsbn("9786041085254"), false);
  assert.equal(isIsbn("0306406152"), true);
  assert.equal(isIsbn("080442957X"), true);
  assert.equal(isIsbn("0306406153"), false);
  assert.equal(isIsbn("123"), false);
});

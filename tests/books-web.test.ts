import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { buildEpub } from "../web/epub";
import { mobiEncryption } from "../web/mobi";

function fakePdb(type: string, encryption: number): ArrayBuffer {
  const buf = new ArrayBuffer(200);
  const u8 = new Uint8Array(buf);
  u8.set(new TextEncoder().encode(type), 60);
  const v = new DataView(buf);
  v.setUint16(76, 1); // số record
  v.setUint32(78, 100); // record 0 ở offset 100
  v.setUint16(100 + 12, encryption);
  return buf;
}

test("mobiEncryption: đọc cờ DRM, từ chối file không phải MOBI", () => {
  assert.equal(mobiEncryption(fakePdb("BOOKMOBI", 0)), 0);
  assert.equal(mobiEncryption(fakePdb("BOOKMOBI", 2)), 2);
  assert.throws(() => mobiEncryption(fakePdb("NOTABOOK", 0)), /MOBI/);
  assert.throws(() => mobiEncryption(new ArrayBuffer(10)), /ngắn/);
});

test("buildEpub nhiều chương: spine đúng thứ tự, mục lục, bìa, mimetype đầu tiên không nén", async () => {
  const bytes = await buildEpub({
    title: "Sách <thử>",
    lang: "vi",
    chapters: [
      { title: "Một", bodyXhtml: "<p>1</p>", headings: [] },
      { bodyXhtml: '<h2 id="x">Hai</h2><p>2</p>', headings: [{ id: "x", level: 2, text: "Hai" }] },
    ],
    images: [{ href: "images/cover.jpg", bytes: new Uint8Array([0xff, 0xd8, 0xff]), mediaType: "image/jpeg" }],
    coverHref: "images/cover.jpg",
    identifier: "urn:t",
    date: "2026-09-23T00:00:00.000Z",
  });
  const zip = await JSZip.loadAsync(bytes);
  assert.equal(Object.keys(zip.files)[0], "mimetype");
  const opf = await zip.file("OEBPS/content.opf")!.async("text");
  assert.ok(opf.indexOf('idref="text0"') < opf.indexOf('idref="text1"'));
  assert.match(opf, /href="images\/cover.jpg" media-type="image\/jpeg" properties="cover-image"/);
  assert.match(opf, /<meta name="cover" content="img0"\/>/);
  assert.ok(opf.includes("<dc:title>Sách &lt;thử&gt;</dc:title>"));
  const nav = await zip.file("OEBPS/nav.xhtml")!.async("text");
  assert.ok(nav.includes('href="text.xhtml">Một') && nav.includes('href="text2.xhtml#x">Hai'));
  assert.ok(await zip.file("OEBPS/text2.xhtml")!.async("text"));
});

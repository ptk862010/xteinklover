import { test } from "node:test";
import assert from "node:assert/strict";
import { acquisitionFeed, newBookId } from "../src/opds";

test("newBookId tăng dần theo thời gian", () => {
  assert.ok(newBookId(1000) < newBookId(2000));
  assert.match(newBookId(), /^[a-z0-9]+$/);
});

test("acquisitionFeed có đúng những thứ CrossPoint đọc", () => {
  const xml = acquisitionFeed({
    base: "https://x.example",
    title: 'Kệ "sách"',
    updated: "2026-09-22T10:00:00.000Z",
    books: [{ id: "abc1", title: "A & B", author: "Kiên", size: 2048, added: "2026-09-22T09:00:00.000Z" }],
  });
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes("<title>Kệ &quot;sách&quot;</title>"));
  assert.ok(xml.includes("<title>A &amp; B</title>"));
  assert.ok(xml.includes("<author><name>Kiên</name></author>"));
  assert.ok(xml.includes("<id>urn:xteinklover:abc1</id>"));
  assert.ok(xml.includes('<link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="https://x.example/books/abc1.epub"/>'));
  // XML hợp lệ
  const { DOMParser } = require("@xmldom/xmldom") as { DOMParser: new () => { parseFromString(s: string, t: string): unknown } };
  assert.doesNotThrow(() => new DOMParser().parseFromString(xml, "text/xml"));
});

test("acquisitionFeed: link next/previous ở cấp feed, self là trang hiện tại", () => {
  const xml = acquisitionFeed({
    base: "https://x.example",
    title: "K",
    updated: "2026-09-22T10:00:00.000Z",
    books: [],
    self: "https://x.example/opds?page=2",
    prev: "https://x.example/opds",
    next: "https://x.example/opds?page=3&a=b",
  });
  const beforeEntries = xml.split("<entry>")[0];
  assert.ok(beforeEntries.includes('rel="previous"'));
  assert.ok(beforeEntries.includes('href="https://x.example/opds?page=3&amp;a=b"'), "escape & trong href");
  assert.ok(xml.includes('<link rel="self" type="application/atom+xml;profile=opds-catalog;kind=acquisition" href="https://x.example/opds?page=2"/>'));
  const none = acquisitionFeed({ base: "https://x.example", title: "K", updated: "2026-09-22T10:00:00.000Z", books: [] });
  assert.ok(!none.includes('rel="next"') && !none.includes('rel="previous"'));
});

test("navigationFeed: mỗi tầng là một mục điều hướng (link atom+xml, không có link tải EPUB), XML hợp lệ", async () => {
  const { navigationFeed } = await import("../src/opds");
  const xml = navigationFeed({
    base: "https://x.example",
    title: "Kệ của Kiên",
    updated: "2026-09-27T10:00:00.000Z",
    items: [
      { id: "s1", name: "Trinh thám & <Kinh dị>", count: 2 },
      { id: "s2", name: "Văn học", count: 1 },
    ],
  });
  assert.ok(xml.includes("<title>Trinh thám &amp; &lt;Kinh dị&gt;</title>"));
  assert.ok(xml.includes('<link rel="subsection" type="application/atom+xml;profile=opds-catalog;kind=acquisition" href="https://x.example/opds/shelf/s1"/>'));
  assert.ok(xml.includes("<id>urn:xteinklover:shelf:s2</id>"));
  assert.ok(xml.includes("2 cuốn"));
  assert.equal(xml.includes("opds-spec.org/acquisition"), false, "không có link tải trong feed thư mục");
  assert.ok(xml.includes('<link rel="self" type="application/atom+xml;profile=opds-catalog;kind=navigation" href="https://x.example/opds"/>'));
  const { DOMParser } = require("@xmldom/xmldom") as { DOMParser: new () => { parseFromString(s: string, t: string): unknown } };
  assert.doesNotThrow(() => new DOMParser().parseFromString(xml, "text/xml"));
});

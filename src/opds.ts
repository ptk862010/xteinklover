import type { BookMeta } from "./db";

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** id tăng dần theo thời gian (sắp mới → cũ bằng id) + 8 ký tự ngẫu nhiên từ crypto. */
export function newBookId(now = Date.now()): string {
  let rand = "";
  for (const b of crypto.getRandomValues(new Uint8Array(8))) rand += (b % 36).toString(36);
  return `${now.toString(36).padStart(9, "0")}${rand}`;
}

/** Tên file tải về đẹp cho máy (máy tự làm lại từ title/author, nhưng href có .epub để parser ưu tiên). */
export function bookHref(base: string, id: string): string {
  return `${base}/books/${id}.epub`;
}

/**
 * Feed acquisition tối giản đúng thứ CrossPoint 1.6.0 đọc:
 * entry.title, entry.author.name, entry.id, link rel=…/acquisition type=application/epub+zip;
 * phân trang bằng link rel=next/previous ở cấp feed (máy chỉ giữ 62 mục mỗi trang).
 */
export interface FeedOptions {
  base: string;
  title: string;
  books: BookMeta[];
  updated: string;
  /** URL trang hiện tại (mặc định base/opds). */
  self?: string;
  next?: string;
  prev?: string;
}

const NAV_TYPE = "application/atom+xml;profile=opds-catalog;kind=acquisition";

export function acquisitionFeed(opts: FeedOptions): string {
  const entries = opts.books
    .map(
      (b) => `  <entry>
    <title>${escapeXml(b.title)}</title>
    <author><name>${escapeXml(b.author || "Xteink Lover")}</name></author>
    <id>urn:xteinklover:${b.id}</id>
    <updated>${b.added}</updated>
    <dc:date>${b.added.slice(0, 10)}</dc:date>
    <content type="text">${escapeXml(`${(b.size / 1024).toFixed(0)} KB · thêm ${b.added.slice(0, 16).replace("T", " ")}`)}</content>
    <link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="${escapeXml(bookHref(opts.base, b.id))}"/>
  </entry>`,
    )
    .join("\n");
  // Link phân trang phải nằm ở cấp feed (CrossPoint bỏ qua link trong <entry>)
  const pageLinks =
    (opts.prev ? `  <link rel="previous" type="${NAV_TYPE}" href="${escapeXml(opts.prev)}"/>\n` : "") +
    (opts.next ? `  <link rel="next" type="${NAV_TYPE}" href="${escapeXml(opts.next)}"/>\n` : "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:xteinklover:catalog</id>
  <title>${escapeXml(opts.title)}</title>
  <updated>${opts.updated}</updated>
  <author><name>Xteink Lover</name></author>
  <link rel="self" type="${NAV_TYPE}" href="${escapeXml(opts.self ?? `${opts.base}/opds`)}"/>
  <link rel="start" type="${NAV_TYPE}" href="${escapeXml(opts.base)}/opds"/>
${pageLinks}${entries}
</feed>
`;
}

export const OPDS_CONTENT_TYPE = "application/atom+xml;profile=opds-catalog;kind=acquisition;charset=utf-8";

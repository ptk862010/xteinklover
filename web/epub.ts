import JSZip from "jszip";

export interface EpubImage {
  /** đường dẫn trong EPUB, vd images/img1.jpg */
  href: string;
  bytes: Uint8Array;
  mediaType: string;
}

export interface EpubHeading {
  id: string;
  level: number;
  text: string;
}

/** Một chương = một file XHTML trong spine. Sách dài chia nhiều chương cho máy đọc nhẹ bộ nhớ. */
export interface EpubChapter {
  /** Tên hiện trong mục lục; bỏ trống thì mục lục lấy các tiêu đề h1–h3 bên trong. */
  title?: string;
  /** XHTML hợp lệ, nằm trong <body> */
  bodyXhtml: string;
  headings: EpubHeading[];
}

export interface EpubInput {
  title: string;
  author?: string;
  lang: string;
  /** Sách một chương (cách cũ). Bỏ qua nếu có `chapters`. */
  bodyXhtml?: string;
  headings?: EpubHeading[];
  chapters?: EpubChapter[];
  images: EpubImage[];
  /** href của ảnh bìa trong `images` (máy dùng làm ảnh đại diện). */
  coverHref?: string;
  /** Sách ảnh trang (PDF/CBZ): mỗi chương một ảnh, CSS cho ảnh vừa khít màn hình. */
  fixedPages?: boolean;
  identifier: string;
  /** ISO 8601 */
  date: string;
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const STYLE = `body { font-family: serif; line-height: 1.4; margin: 0.5em; }
h1, h2, h3, h4 { line-height: 1.2; page-break-after: avoid; }
img { max-width: 100%; height: auto; }
pre { white-space: pre-wrap; font-family: monospace; font-size: 0.85em; }
code { font-family: monospace; font-size: 0.9em; }
blockquote { margin: 0.6em 0 0.6em 0.8em; padding-left: 0.6em; border-left: 3px solid #666; }
.callout { margin: 0.8em 0; padding: 0.4em 0.7em; border: 1px solid #888; }
.callout-title { font-weight: bold; margin-bottom: 0.3em; }
table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
th, td { border: 1px solid #888; padding: 0.2em 0.4em; vertical-align: top; }
hr { border: 0; border-top: 1px solid #888; margin: 1em 0; }
.tag { font-family: monospace; font-size: 0.85em; }
.task-done { text-decoration: line-through; }
body.page { margin: 0; padding: 0; text-align: center; }
body.page img { display: block; margin: 0 auto; max-width: 100%; max-height: 100%; }
`;

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

function chaptersOf(input: EpubInput): EpubChapter[] {
  if (input.chapters?.length) return input.chapters;
  return [{ bodyXhtml: input.bodyXhtml ?? "", headings: input.headings ?? [] }];
}

const chapterHref = (i: number) => (i === 0 ? "text.xhtml" : `text${i + 1}.xhtml`);

interface TocEntry {
  href: string;
  text: string;
}

function tocEntries(input: EpubInput, chapters: EpubChapter[]): TocEntry[] {
  const out: TocEntry[] = [];
  chapters.forEach((c, i) => {
    const href = chapterHref(i);
    if (c.title) out.push({ href, text: c.title });
    else for (const h of c.headings) out.push({ href: `${href}#${h.id}`, text: h.text });
  });
  return out.length ? out : [{ href: chapterHref(0), text: input.title }];
}

function contentOpf(input: EpubInput, chapters: EpubChapter[]): string {
  const imageItems = input.images
    .map((img, i) => {
      const cover = img.href === input.coverHref ? ' properties="cover-image"' : "";
      return `    <item id="img${i}" href="${escapeXml(img.href)}" media-type="${img.mediaType}"${cover}/>`;
    })
    .join("\n");
  const chapterItems = chapters.map((_, i) => `    <item id="text${i}" href="${chapterHref(i)}" media-type="application/xhtml+xml"/>`).join("\n");
  const spine = chapters.map((_, i) => `    <itemref idref="text${i}"/>`).join("\n");
  const author = input.author ? `    <dc:creator id="creator">${escapeXml(input.author)}</dc:creator>\n` : "";
  const coverIdx = input.coverHref ? input.images.findIndex((im) => im.href === input.coverHref) : -1;
  // EPUB 2 reader (và một số firmware) tìm bìa qua <meta name="cover">
  const coverMeta = coverIdx >= 0 ? `    <meta name="cover" content="img${coverIdx}"/>\n` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${input.lang}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(input.identifier)}</dc:identifier>
    <dc:title>${escapeXml(input.title)}</dc:title>
    <dc:language>${input.lang}</dc:language>
${author}    <dc:date>${input.date}</dc:date>
    <meta property="dcterms:modified">${input.date.replace(/\.\d+Z$/, "Z")}</meta>
${coverMeta}  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
${chapterItems}
${imageItems}
  </manifest>
  <spine toc="ncx">
${spine}
  </spine>
</package>
`;
}

function navXhtml(input: EpubInput, toc: TocEntry[]): string {
  const items = toc.map((t) => `      <li><a href="${escapeXml(t.href)}">${escapeXml(t.text)}</a></li>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${input.lang}">
<head><title>${escapeXml(input.title)}</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Mục lục</h1>
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>
`;
}

function tocNcx(input: EpubInput, toc: TocEntry[]): string {
  const points = toc
    .map(
      (t, i) => `    <navPoint id="np${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${escapeXml(t.text)}</text></navLabel>
      <content src="${escapeXml(t.href)}"/>
    </navPoint>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(input.identifier)}"/>
    <meta name="dtb:depth" content="2"/>
  </head>
  <docTitle><text>${escapeXml(input.title)}</text></docTitle>
  <navMap>
${points}
  </navMap>
</ncx>
`;
}

export function textXhtml(input: EpubInput, chapter: EpubChapter = chaptersOf(input)[0]): string {
  const bodyClass = input.fixedPages ? ' class="page"' : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${input.lang}">
<head>
  <title>${escapeXml(chapter.title || input.title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body${bodyClass}>
${chapter.bodyXhtml}
</body>
</html>
`;
}

/** Đóng gói EPUB 3: mimetype phải là file đầu tiên và không nén. */
export async function buildEpub(input: EpubInput): Promise<Uint8Array> {
  const chapters = chaptersOf(input);
  const toc = tocEntries(input, chapters);
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", CONTAINER_XML);
  zip.file("OEBPS/content.opf", contentOpf(input, chapters));
  zip.file("OEBPS/nav.xhtml", navXhtml(input, toc));
  zip.file("OEBPS/toc.ncx", tocNcx(input, toc));
  zip.file("OEBPS/style.css", STYLE);
  chapters.forEach((c, i) => zip.file(`OEBPS/${chapterHref(i)}`, textXhtml(input, c)));
  // Ảnh JPEG đã nén sẵn: lưu STORE cho nhanh, khỏi nén lại vô ích
  for (const img of input.images) zip.file(`OEBPS/${img.href}`, img.bytes, { compression: img.mediaType === "image/jpeg" ? "STORE" : "DEFLATE" });
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

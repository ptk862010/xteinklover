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

export interface EpubInput {
  title: string;
  author?: string;
  lang: string;
  /** XHTML hợp lệ, nằm trong <body> */
  bodyXhtml: string;
  images: EpubImage[];
  headings: EpubHeading[];
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
`;

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

function contentOpf(input: EpubInput): string {
  const imageItems = input.images
    .map((img, i) => `    <item id="img${i}" href="${escapeXml(img.href)}" media-type="${img.mediaType}"/>`)
    .join("\n");
  const author = input.author ? `    <dc:creator id="creator">${escapeXml(input.author)}</dc:creator>\n` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${input.lang}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(input.identifier)}</dc:identifier>
    <dc:title>${escapeXml(input.title)}</dc:title>
    <dc:language>${input.lang}</dc:language>
${author}    <dc:date>${input.date}</dc:date>
    <meta property="dcterms:modified">${input.date.replace(/\.\d+Z$/, "Z")}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>
${imageItems}
  </manifest>
  <spine toc="ncx">
    <itemref idref="text"/>
  </spine>
</package>
`;
}

function navXhtml(input: EpubInput): string {
  const items = input.headings.length
    ? input.headings.map((h) => `      <li><a href="text.xhtml#${h.id}">${escapeXml(h.text)}</a></li>`).join("\n")
    : `      <li><a href="text.xhtml">${escapeXml(input.title)}</a></li>`;
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

function tocNcx(input: EpubInput): string {
  const heads = input.headings.length ? input.headings : [{ id: "", level: 1, text: input.title }];
  const points = heads
    .map(
      (h, i) => `    <navPoint id="np${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${escapeXml(h.text)}</text></navLabel>
      <content src="text.xhtml${h.id ? "#" + h.id : ""}"/>
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

export function textXhtml(input: EpubInput): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${input.lang}">
<head>
  <title>${escapeXml(input.title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${input.bodyXhtml}
</body>
</html>
`;
}

/** Đóng gói EPUB 3: mimetype phải là file đầu tiên và không nén. */
export async function buildEpub(input: EpubInput): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", CONTAINER_XML);
  zip.file("OEBPS/content.opf", contentOpf(input));
  zip.file("OEBPS/nav.xhtml", navXhtml(input));
  zip.file("OEBPS/toc.ncx", tocNcx(input));
  zip.file("OEBPS/style.css", STYLE);
  zip.file("OEBPS/text.xhtml", textXhtml(input));
  for (const img of input.images) zip.file(`OEBPS/${img.href}`, img.bytes);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

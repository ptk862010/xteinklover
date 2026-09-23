// Dàn chữ PDF thành đoạn văn: phần thuần (không cần PDF.js), để unit test chạy trên Node.
import type { EpubChapter } from "./epub";
import { escapeXml } from "./epub";

/** Một mẩu chữ từ PDF.js getTextContent (chỉ các trường cần dùng). */
export interface TextPiece {
  str: string;
  transform: number[];
  height: number;
}

export interface Line {
  text: string;
  y: number;
  size: number;
}

/**
 * Gom các mẩu chữ cùng dòng (cùng tọa độ y), sắp trái → phải. Cỡ chữ của dòng = cỡ của phần nhiều ký tự nhất
 * (chữ cái đầu chương phóng to / drop cap không làm cả dòng thành tiêu đề).
 */
export function pageLines(items: TextPiece[]): Line[] {
  const rows: { y: number; parts: { x: number; s: string; size: number }[] }[] = [];
  for (const it of items) {
    if (!it.str) continue;
    const [, , c, d, x, y] = it.transform;
    const size = Math.hypot(c, d) || it.height || 10;
    let row = rows.find((r) => Math.abs(r.y - y) < size * 0.5);
    if (!row) rows.push((row = { y, parts: [] }));
    row.parts.push({ x, s: it.str, size });
  }
  const dominantSize = (parts: { s: string; size: number }[]) => {
    const bySize = new Map<number, number>();
    for (const p of parts) {
      const k = Math.round(p.size * 2) / 2;
      bySize.set(k, (bySize.get(k) ?? 0) + p.s.trim().length);
    }
    return [...bySize].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
  };
  return rows
    .sort((a, b) => b.y - a.y)
    .map((r) => ({
      y: r.y,
      size: dominantSize(r.parts),
      text: r.parts
        .sort((a, b) => a.x - b.x)
        .map((p) => p.s)
        .join("")
        .replace(/\s+/g, " ")
        .trim(),
    }))
    .filter((l) => l.text);
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Chuẩn hóa dòng đầu/cuối trang: bỏ số (kể cả "3 6" in giãn), bỏ số trang ở hai đầu. */
export function edgeKey(t: string): string {
  return t
    .toLowerCase()
    .replace(/\d[\d\s]*/g, "#")
    .replace(/\s+/g, " ")
    .replace(/^[#\s|·•–—-]+|[#\s|·•–—-]+$/g, "")
    .trim();
}

/**
 * Dòng đầu/cuối trang lặp lại (tên sách, tên chương, số trang) → header/footer. Tiêu đề chạy theo chương chỉ lặp
 * trong chương đó nên ngưỡng là "từ 3 trang trở lên" (và ≥ 3% số trang), không phải một tỉ lệ lớn của cả cuốn.
 */
function repeatedEdges(pages: Line[][]): Set<string> {
  const counts = new Map<string, number>();
  for (const lines of pages) {
    const edge = new Set([...lines.slice(0, 2), ...lines.slice(-2)].map((l) => edgeKey(l.text)));
    for (const k of edge) if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const min = Math.max(3, Math.ceil(pages.length * 0.03));
  return new Set([...counts].filter(([, n]) => n >= min).map(([k]) => k));
}

/** Số trang in dính đầu dòng ("3 5 tôi làm việc…"): bỏ nếu con số gần số thứ tự trang. */
export function stripLeadingPageNumber(text: string, pageNo: number): string {
  const m = text.match(/^(\d(?: ?\d){0,3})\s+(?=\D)/);
  if (!m) return text;
  const printed = parseInt(m[1].replace(/\s/g, ""), 10);
  return Math.abs(printed - pageNo) <= 40 ? text.slice(m[0].length) : text;
}

const PAGE_NUMBER = /^(?:[-–—\s]*\d{1,4}[-–—\s]*|[ivxlcdm]{1,6}|trang \d+|page \d+(?: of \d+)?)$/i;
const SENTENCE_END = /[.!?…:;"”»)\]]$/;

export interface Block {
  kind: "p" | "h";
  text: string;
}

/** Dựng đoạn văn từ các dòng: nối dòng trong đoạn, nối từ bị ngắt bằng gạch nối, nhận tiêu đề theo cỡ chữ. */
export function toBlocks(pages: Line[][]): { blocks: Block[]; pageStarts: number[] } {
  const edges = repeatedEdges(pages);
  const allLines = pages.flat();
  const bodySize = median(allLines.map((l) => l.size));
  const blocks: Block[] = [];
  const pageStarts: number[] = [];
  let open: Block | null = null;
  pages.forEach((lines, pi) => {
    pageStarts.push(blocks.length);
    const kept = lines
      .filter((l, i) => {
        const edge = i < 2 || i >= lines.length - 2;
        const key = edgeKey(l.text);
        return !(edge && (!key || edges.has(key) || PAGE_NUMBER.test(l.text)));
      })
      .map((l, i) => (i === 0 ? { ...l, text: stripLeadingPageNumber(l.text, pi + 1) } : l));
    const gaps = kept.slice(1).map((l, i) => kept[i].y - l.y).filter((g) => g > 0);
    const lineGap = median(gaps) || bodySize * 1.3;
    const typicalLen = median(kept.map((l) => l.text.length));
    kept.forEach((l, i) => {
      const isHeading = l.size >= bodySize * 1.3 && l.text.length <= 90;
      if (isHeading) {
        open = null;
        const prev = blocks[blocks.length - 1];
        // Tiêu đề dài bị gãy thành 2 dòng liền nhau: gộp lại
        if (prev?.kind === "h" && i > 0 && kept[i - 1].size >= bodySize * 1.3 && kept[i - 1].y - l.y < l.size * 1.8) prev.text += " " + l.text;
        else blocks.push({ kind: "h", text: l.text });
        return;
      }
      // Dòng đầu trang: nối tiếp đoạn cuối trang trước nếu câu trước chưa kết thúc, không thì mở đoạn mới
      if (i === 0) {
        if (open && !SENTENCE_END.test(open.text)) open.text = joinLine(open.text, l.text);
        else blocks.push((open = { kind: "p", text: l.text }));
        return;
      }
      const prevLine = kept[i - 1];
      const bigGap = prevLine.y - l.y > lineGap * 1.45;
      const shortPrev = prevLine.text.length < typicalLen * 0.7 && SENTENCE_END.test(prevLine.text);
      if (!open || bigGap || shortPrev) blocks.push((open = { kind: "p", text: l.text }));
      else open.text = joinLine(open.text, l.text);
    });
  });
  return { blocks, pageStarts };
}

export function joinLine(a: string, b: string): string {
  // "chuyển-\nđổi" → "chuyểnđổi" chỉ khi chữ sau viết thường (từ bị ngắt); còn lại nối bằng dấu cách
  if (/[A-Za-zÀ-ỹ]-$/.test(a) && /^[a-zà-ỹ]/.test(b)) return a.slice(0, -1) + b;
  return a + " " + b;
}

/** Chia chương ~20 trang (file XHTML nhỏ, máy đọc mở nhanh); ưu tiên cắt ở tiêu đề. */
export function toChapters(blocks: Block[], pageStarts: number[]): EpubChapter[] {
  const chapters: EpubChapter[] = [];
  let buf: string[] = [];
  let heads: EpubChapter["headings"] = [];
  let pagesInChapter = 0;
  const flush = () => {
    if (!buf.length) return;
    chapters.push({ bodyXhtml: buf.join("\n"), headings: heads });
    buf = [];
    heads = [];
    pagesInChapter = 0;
  };
  const startSet = new Set(pageStarts);
  blocks.forEach((b, i) => {
    if (startSet.has(i)) pagesInChapter++;
    if (b.kind === "h" && pagesInChapter > 8) flush();
    else if (pagesInChapter > 20 && startSet.has(i)) flush();
    if (b.kind === "h") {
      const id = `c${chapters.length + 1}h${heads.length + 1}`;
      heads.push({ id, level: 2, text: b.text.slice(0, 120) });
      buf.push(`<h2 id="${id}">${escapeXml(b.text)}</h2>`);
    } else buf.push(`<p>${escapeXml(b.text)}</p>`);
  });
  flush();
  return chapters;
}

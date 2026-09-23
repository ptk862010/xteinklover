import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeKey, joinLine, pageLines, stripLeadingPageNumber, toBlocks, toChapters, type TextPiece } from "../web/pdftext";

/** Mẩu chữ giả: cỡ `size`, tại (x, y). */
const piece = (str: string, x: number, y: number, size = 10): TextPiece => ({ str, transform: [size, 0, 0, size, x, y], height: size });

test("pageLines: gom theo dòng, sắp trái→phải; drop cap không đổi cỡ của dòng", () => {
  const lines = pageLines([piece("thế giới", 60, 700), piece("Xin chào ", 10, 700), piece("N", 10, 680, 30), piece("hiệm vụ của nhà điều hành là", 25, 680)]);
  assert.deepEqual(lines.map((l) => l.text), ["Xin chào thế giới", "Nhiệm vụ của nhà điều hành là"]);
  assert.equal(lines[1].size, 10, "chữ cái to đầu dòng không làm dòng thành tiêu đề");
});

test("joinLine: nối từ bị ngắt bằng gạch nối, còn lại thêm dấu cách", () => {
  assert.equal(joinLine("chuyển-", "đổi dữ liệu"), "chuyểnđổi dữ liệu");
  assert.equal(joinLine("Hà Nội -", "Hải Phòng"), "Hà Nội - Hải Phòng");
  assert.equal(joinLine("xin", "chào"), "xin chào");
});

function page(n: number, body: string[]): TextPiece[] {
  const out = [piece("TÊN SÁCH", 10, 780, 8)];
  body.forEach((t, i) => out.push(piece(t, 10, 740 - i * 12)));
  out.push(piece(String(n), 200, 20, 8));
  return out;
}

test("toBlocks: bỏ header/footer lặp lại + số trang, nối đoạn qua trang, nhận tiêu đề", () => {
  const pages = [
    [...page(1, []), piece("Chương 1", 10, 760, 18)],
    page(2, ["Dòng một của đoạn văn khá dài để đủ độ dài chuẩn", "tiếp tục đoạn văn thứ nhất và chưa hết câu"]),
    page(3, ["vẫn là câu đó, giờ mới kết thúc.", "Đoạn hai bắt đầu ở đây và cũng khá là dài dòng lắm", "thêm một dòng dài nữa cho đoạn hai có đủ độ dài chuẩn", "đúng thế."]),
    page(4, ["Trang bốn một đoạn riêng."]),
  ].map(pageLines);
  const { blocks } = toBlocks(pages);
  const texts = blocks.map((b) => `${b.kind}:${b.text}`);
  assert.ok(!texts.some((t) => t.includes("TÊN SÁCH")), "header lặp lại bị bỏ");
  assert.ok(!texts.some((t) => /^p:\d+$/.test(t)), "số trang bị bỏ");
  assert.equal(texts[0], "h:Chương 1");
  assert.ok(texts.includes("p:Dòng một của đoạn văn khá dài để đủ độ dài chuẩn tiếp tục đoạn văn thứ nhất và chưa hết câu vẫn là câu đó, giờ mới kết thúc."), "nối đoạn qua trang: " + texts.join(" | "));
  assert.ok(texts.includes("p:Đoạn hai bắt đầu ở đây và cũng khá là dài dòng lắm thêm một dòng dài nữa cho đoạn hai có đủ độ dài chuẩn đúng thế."), "dòng ngắn cuối đoạn → đoạn mới");
  assert.equal(texts.at(-1), "p:Trang bốn một đoạn riêng.", "câu trước đã hết thì trang sau mở đoạn mới");
});

test("toChapters: escape XML, id tiêu đề duy nhất", () => {
  const ch = toChapters(
    [
      { kind: "h", text: "A & B" },
      { kind: "p", text: "<script>x</script>" },
    ],
    [0],
  );
  assert.equal(ch.length, 1);
  assert.ok(ch[0].bodyXhtml.includes("<h2 id=\"c1h1\">A &amp; B</h2>"));
  assert.ok(ch[0].bodyXhtml.includes("&lt;script&gt;"));
  assert.deepEqual(ch[0].headings, [{ id: "c1h1", level: 2, text: "A & B" }]);
});

test("edgeKey / stripLeadingPageNumber: header có số trang in giãn, số trang dính đầu dòng", () => {
  assert.equal(edgeKey("3 6 QUẢN LÝ BẢN THÂN"), "quản lý bản thân");
  assert.equal(edgeKey("QUẢN LÝ BẢN THÂN 37"), "quản lý bản thân");
  assert.equal(edgeKey("- 12 -"), "");
  assert.equal(stripLeadingPageNumber("3 5 tôi làm việc là như thế này.", 40), "tôi làm việc là như thế này.");
  assert.equal(stripLeadingPageNumber("1945 là năm độc lập", 40), "1945 là năm độc lập", "số xa số trang thì giữ");
});

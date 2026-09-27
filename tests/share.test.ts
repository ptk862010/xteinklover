import { test } from "node:test";
import assert from "node:assert/strict";
// public/share.js là script trình duyệt, xuất thêm qua module.exports để test
// eslint-disable-next-line @typescript-eslint/no-require-imports
const share = require("../public/share.js") as {
  periodRange: (kind: string, now: Date, lang?: string) => { from: number; to: number; label: string };
  finishedIn: <T extends { finished?: number }>(books: T[], from: number, to: number) => T[];
};

test("periodRange: tháng này / tháng trước / năm nay / năm trước theo giờ máy, nhãn tiếng Việt và tiếng Anh", () => {
  const now = new Date(2026, 8, 27, 15, 30); // 27/09/2026
  const m = share.periodRange("month", now);
  assert.equal(m.from, new Date(2026, 8, 1).getTime());
  assert.equal(m.to, new Date(2026, 9, 1).getTime());
  assert.equal(m.label, "Tháng 9/2026");
  const pm = share.periodRange("prevMonth", new Date(2026, 0, 10));
  assert.equal(pm.from, new Date(2025, 11, 1).getTime());
  assert.equal(pm.label, "Tháng 12/2025");
  const y = share.periodRange("year", now);
  assert.deepEqual([y.from, y.to, y.label], [new Date(2026, 0, 1).getTime(), new Date(2027, 0, 1).getTime(), "Năm 2026"]);
  assert.equal(share.periodRange("prevYear", now).label, "Năm 2025");
  assert.equal(share.periodRange("month", now, "en").label, "September 2026");
});

test("finishedIn: chỉ sách đọc xong trong khoảng [from, to), xếp theo ngày đọc xong", () => {
  const books = [{ id: "a", finished: 30 }, { id: "b", finished: 0 }, { id: "c", finished: 10 }, { id: "d", finished: 100 }, { id: "e" }];
  assert.deepEqual(share.finishedIn(books, 10, 100).map((b) => b.id), ["c", "a"]);
});

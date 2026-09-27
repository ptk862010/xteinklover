import { test } from "node:test";
import assert from "node:assert/strict";
// public/devicepush.js là script trình duyệt, xuất thêm qua module.exports để test
// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require("../public/devicepush.js") as {
  safeName: (s: string, fallback?: string) => string;
  fileName: (b: Book) => string;
  planPush: (o: { shelves: Shelf[]; books: Book[]; device: { folders: string[]; files: Record<string, { name: string; size: number }[]> } }) => Plan;
  cleanHost: (s: string) => string | null;
  device: (host: string, f: typeof fetch) => Dev;
  scan: (dev: Dev, shelves: Shelf[]) => Promise<{ root: string; rootExists: boolean; folders: string[]; files: Record<string, { name: string; size: number }[]> }>;
  runPush: (plan: Plan, deletes: Plan["deletes"], io: Record<string, unknown>) => Promise<number>;
};
type Book = { id: string; title: string; author?: string; size: number; shelves?: string[] };
type Shelf = { id: string; name: string };
type Plan = {
  mkdirs: string[];
  uploads: { book: Book; folder: string; name: string; reason: string }[];
  moves: { book: Book; folder: string; name: string; from: string }[];
  deletes: { folder: string; name: string; size: number }[];
  unchanged: number;
};
type Dev = Record<string, (...a: never[]) => Promise<unknown>>;

test("safeName / fileName: bỏ ký tự FAT cấm, không lặp tác giả, không kết thúc bằng dấu chấm", () => {
  assert.equal(P.safeName('Ai: "Tôi"? <1/2>'), "Ai_ _Tôi_ _1_2_");
  assert.equal(P.safeName("Hết...  "), "Hết");
  assert.equal(P.safeName("", "x"), "x");
  assert.equal(Array.from(P.safeName("a".repeat(200))).length, 90);
  assert.equal(P.fileName({ id: "1", title: "Hóa thân", author: "Franz Kafka", size: 1 }), "Franz Kafka - Hóa thân.epub");
  assert.equal(P.fileName({ id: "1", title: "Hóa thân - Franz Kafka", author: "Franz Kafka", size: 1 }), "Hóa thân - Franz Kafka.epub");
  assert.equal(P.fileName({ id: "1", title: "Tự truyện", size: 1 }), "Tự truyện.epub");
});

test("cleanHost: IP, tên .local, bỏ http:// và đường dẫn; từ chối thứ lạ", () => {
  assert.equal(P.cleanHost(" 192.168.0.128 "), "192.168.0.128");
  assert.equal(P.cleanHost("http://crosspoint.local/files"), "crosspoint.local");
  assert.equal(P.cleanHost("10.0.0.5:8080"), "10.0.0.5:8080");
  assert.equal(P.cleanHost("a b"), null);
  assert.equal(P.cleanHost("evil.com@x"), null);
  assert.equal(P.cleanHost(""), null);
});

const shelves: Shelf[] = [{ id: "s1", name: "Văn học" }, { id: "s2", name: "Trinh thám" }, { id: "s3", name: "Trống" }];

test("planPush: chép cuốn mới, bỏ qua cuốn đã có, chép lại cuốn đổi file, chuyển thư mục khi đổi tầng, liệt kê file thừa", () => {
  const books: Book[] = [
    { id: "a", title: "Hóa thân", author: "Franz Kafka", size: 100, shelves: ["s1"] },
    { id: "b", title: "Phía sau nghi can X", author: "Higashino Keigo", size: 200, shelves: ["s2"] }, // đã chuyển từ Văn học sang
    { id: "c", title: "Nhà giả kim", author: "Paulo Coelho", size: 300, shelves: ["s1"] }, // file trên máy cũ hơn
    { id: "d", title: "Chưa xếp", size: 50, shelves: [] },
  ];
  const plan = P.planPush({
    shelves,
    books,
    device: {
      folders: ["văn học", "PDF"], // thẻ nhớ không phân biệt hoa thường
      files: {
        "văn học": [
          { name: "Franz Kafka - Hóa thân.epub", size: 100 },
          { name: "Higashino Keigo - Phía sau nghi can X.epub", size: 200 },
          { name: "Paulo Coelho - Nhà giả kim.epub", size: 299 },
          { name: "Sách cũ đã gỡ.epub", size: 10 },
        ],
        PDF: [{ name: "x.pdf", size: 1 }],
      },
    },
  });
  assert.equal(plan.unchanged, 1);
  assert.deepEqual(plan.uploads.map((u) => [u.folder, u.name, u.reason]), [["văn học", "Paulo Coelho - Nhà giả kim.epub", "changed"]]);
  assert.deepEqual(plan.moves.map((m) => [m.from, m.folder, m.name]), [["văn học", "Trinh thám", "Higashino Keigo - Phía sau nghi can X.epub"]]);
  assert.deepEqual(plan.mkdirs, ["Trinh thám"], "chỉ tạo thư mục tầng có sách, dùng tên có sẵn trên thẻ");
  assert.deepEqual(plan.deletes.map((d) => d.name), ["Sách cũ đã gỡ.epub"], "không đụng thư mục PDF");
});

test("planPush: file cùng tên ở tầng khác nhưng khác kích thước thì chép mới, không chuyển nhầm", () => {
  const plan = P.planPush({
    shelves,
    books: [{ id: "a", title: "Thơ", size: 10, shelves: ["s2"] }],
    device: { folders: ["Văn học"], files: { "Văn học": [{ name: "Thơ.epub", size: 99 }] } },
  });
  assert.equal(plan.moves.length, 0);
  assert.deepEqual(plan.uploads.map((u) => [u.folder, u.name]), [["Trinh thám", "Thơ.epub"]]);
  assert.deepEqual(plan.deletes.map((d) => d.name), ["Thơ.epub"], "file lạ chỉ được liệt kê để người dùng tự tích");
});

test("planPush: hai cuốn trùng tên trong một tầng thì thêm (2); thẻ trống thì chép hết", () => {
  const books: Book[] = [
    { id: "a", title: "Thơ", author: "Xuân Diệu", size: 1, shelves: ["s1"] },
    { id: "b", title: "thơ", author: "xuân diệu", size: 2, shelves: ["s1"] },
  ];
  const plan = P.planPush({ shelves, books, device: { folders: [], files: {} } });
  assert.deepEqual(plan.uploads.map((u) => u.name), ["Xuân Diệu - Thơ.epub", "xuân diệu - thơ (2).epub"]);
  assert.deepEqual(plan.mkdirs, ["Văn học"]);
  assert.equal(plan.deletes.length, 0);
});

/** Máy đọc giả: đường dẫn → kích thước, trả lời như API File Transfer của CrossPoint. */
function fakeReader(initial: Record<string, number>, dirs: string[]) {
  const files = new Map(Object.entries(initial));
  const folders = new Set(dirs);
  const calls: string[] = [];
  const children = (path: string) => {
    const pre = path === "/" ? "/" : path + "/";
    const out: { name: string; size: number; isDirectory: boolean }[] = [];
    for (const d of folders) if (d.startsWith(pre) && !d.slice(pre.length).includes("/")) out.push({ name: d.slice(pre.length), size: 0, isDirectory: true });
    for (const [f, size] of files) if (f.startsWith(pre) && !f.slice(pre.length).includes("/")) out.push({ name: f.slice(pre.length), size, isDirectory: false });
    return out;
  };
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u.pathname}`);
    if (u.pathname === "/api/files") return Response.json(children(u.searchParams.get("path")!));
    const form = init?.body instanceof URLSearchParams ? init.body : null;
    if (u.pathname === "/mkdir") {
      const parent = form!.get("path")!;
      folders.add((parent === "/" ? "" : parent) + "/" + form!.get("name"));
      return new Response("ok");
    }
    if (u.pathname === "/move") {
      const path = form!.get("path")!;
      files.set(form!.get("dest") + "/" + path.split("/").pop(), files.get(path)!);
      files.delete(path);
      return new Response("ok");
    }
    if (u.pathname === "/delete") {
      files.delete(form!.get("path")!);
      return new Response("ok");
    }
    if (u.pathname === "/upload") {
      const fd = init!.body as FormData;
      const file = fd.get("file") as File;
      assert.ok(file && file.size > 0, "không bao giờ gửi upload rỗng (máy treo)");
      files.set(u.searchParams.get("path") + "/" + file.name, file.size);
      return new Response("File uploaded successfully");
    }
    return new Response("nope", { status: 404 });
  };
  return { files, folders, calls, impl: impl as typeof fetch };
}

test("scan + runPush trên máy giả: tạo /Sach, thư mục tầng, chép, chuyển, xóa file đã chọn, đánh dấu đã về máy", async () => {
  const r = fakeReader({ "/Sach/Văn học/Cũ.epub": 5, "/Sach/Văn học/Higashino Keigo - Phía sau nghi can X.epub": 200, "/Sach/PDF/a.pdf": 9 }, ["/Sach", "/Sach/Văn học", "/Sach/PDF"]);
  const dev = P.device("192.168.0.128", r.impl);
  const books: Book[] = [
    { id: "a", title: "Hóa thân", author: "Franz Kafka", size: 3, shelves: ["s1"] },
    { id: "b", title: "Phía sau nghi can X", author: "Higashino Keigo", size: 200, shelves: ["s2"] },
  ];
  const tree = await P.scan(dev, shelves);
  assert.equal(tree.root, "/Sach");
  assert.deepEqual(Object.keys(tree.files), ["Văn học"], "chỉ đọc thư mục mang tên tầng");
  const plan = P.planPush({ shelves, books, device: tree });
  const fetched: string[] = [];
  const steps: string[] = [];
  const n = await P.runPush(plan, plan.deletes, {
    dev,
    root: tree.root,
    rootExists: tree.rootExists,
    getBook: async (b: Book) => new Blob([new Uint8Array(b.size)]),
    markFetched: async (b: Book) => { fetched.push(b.id); },
    onStep: (_i: number, _t: number, label: string) => { if (label) steps.push(label); },
  });
  assert.equal(n, 4, "mkdir Trinh thám, chuyển, chép, xóa");
  assert.deepEqual([...r.files.keys()].sort(), ["/Sach/PDF/a.pdf", "/Sach/Trinh thám/Higashino Keigo - Phía sau nghi can X.epub", "/Sach/Văn học/Franz Kafka - Hóa thân.epub"]);
  assert.deepEqual(fetched.sort(), ["a", "b"]);
  assert.equal(steps.length, 4);
});

test("scan: thẻ chưa có /Sach thì runPush tạo trước; máy báo lỗi thì dừng và nói việc đang làm", async () => {
  const r = fakeReader({}, []);
  const dev = P.device("x", r.impl);
  const tree = await P.scan(dev, shelves);
  assert.deepEqual([tree.root, tree.rootExists], ["/Sach", false]);
  const plan = P.planPush({ shelves, books: [{ id: "a", title: "A", size: 1, shelves: ["s1"] }], device: tree });
  await P.runPush(plan, [], { dev, root: tree.root, rootExists: false, getBook: async () => new Blob(["x"]), markFetched: async () => {}, onStep: () => {} });
  assert.ok(r.files.has("/Sach/Văn học/A.epub"));
  assert.equal(r.calls[1], "POST /mkdir", "tạo /Sach trước");

  const broken = P.device("x", (async () => new Response("SD full", { status: 500 })) as typeof fetch);
  await assert.rejects(
    P.runPush({ mkdirs: ["Văn học"], uploads: [], moves: [], deletes: [], unchanged: 0 }, [], { dev: broken, root: "/Sach", rootExists: true, getBook: async () => new Blob(), markFetched: async () => {}, onStep: () => {} }),
    /Văn học\/: 500 SD full/,
  );
});

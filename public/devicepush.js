// Đổ kệ xuống máy đọc: trình duyệt nói chuyện thẳng với CrossPoint ở chế độ File Transfer (cùng WiFi),
// mỗi tầng một thư mục trong /Sach. Chỉ bản tự chạy trong mạng nhà (trang http) mới gọi được máy.
// API của máy: GET /api/files?path=, POST /mkdir, /upload?path= (multipart), /move, /delete. Máy có CORS *.
// Xuất window.XL_PUSH cho app.js; module.exports cho test (tests/devicepush.test.ts).
(() => {
  const ROOT_NAME = "Sach";
  const NAME_MAX = 90;
  const TIMEOUT_MS = 20_000;
  const UPLOAD_TIMEOUT_MS = 180_000;

  /** Tên hợp lệ trên thẻ nhớ FAT: bỏ ký tự cấm, gọn khoảng trắng, không kết thúc bằng dấu chấm, không quá dài. */
  function safeName(s, fallback = "_") {
    const clean = String(s ?? "")
      .normalize("NFC")
      .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
      .replace(/\s+/g, " ")
      .trim();
    const cut = Array.from(clean).slice(0, NAME_MAX).join("").replace(/[. ]+$/, "");
    return cut || fallback;
  }

  /** "Tác giả - Tên sách.epub"; tên đã có tác giả thì không lặp lại. */
  function fileName(book) {
    const title = safeName(book.title, book.id);
    const author = book.author ? safeName(book.author, "") : "";
    const base = author && !title.toLowerCase().includes(author.toLowerCase()) ? `${author} - ${title}` : title;
    return safeName(base, book.id) + ".epub";
  }

  const key = (folder, name) => `${folder.toLowerCase()}/${name.toLowerCase()}`;

  /** Đặt tên không trùng (thẻ nhớ không phân biệt hoa thường): trùng thì thêm " (2)", " (3)"… */
  function unique(name, taken, ext = "") {
    const stem = ext ? name.slice(0, -ext.length) : name;
    let out = name;
    for (let i = 2; taken.has(out.toLowerCase()); i++) out = `${stem} (${i})${ext}`;
    taken.add(out.toLowerCase());
    return out;
  }

  /**
   * So kệ với thẻ nhớ → việc cần làm. Chỉ đụng vào thư mục mang tên một tầng; thư mục khác trong /Sach (vd PDF) để yên.
   * device = { folders: string[] (thư mục đang có trong /Sach), files: { [folder]: {name, size}[] } }
   */
  function planPush({ shelves, books, device }) {
    const folderTaken = new Set();
    const folderOf = new Map(shelves.map((s) => [s.id, unique(safeName(s.name), folderTaken)]));
    const onDisk = new Map(device.folders.map((f) => [f.toLowerCase(), f]));
    const shelfFolders = new Set([...folderOf.values()].map((f) => f.toLowerCase()));

    // Sách cần có trên máy
    const nameTaken = new Map();
    const expected = [];
    for (const b of [...books].sort((x, y) => String(x.id).localeCompare(String(y.id)))) {
      const folder = folderOf.get((b.shelves || [])[0]);
      if (!folder) continue;
      const taken = nameTaken.get(folder.toLowerCase()) ?? nameTaken.set(folder.toLowerCase(), new Set()).get(folder.toLowerCase());
      expected.push({ book: b, folder: onDisk.get(folder.toLowerCase()) ?? folder, name: unique(fileName(b), taken, ".epub") });
    }
    const expectedKeys = new Set(expected.map((e) => key(e.folder, e.name)));

    // File đang có trong các thư mục tầng
    const present = new Map();
    const byName = new Map();
    for (const f of device.folders) {
      if (!shelfFolders.has(f.toLowerCase())) continue;
      for (const file of device.files[f] || []) {
        present.set(key(f, file.name), { folder: f, name: file.name, size: file.size });
        const list = byName.get(file.name.toLowerCase()) ?? [];
        byName.set(file.name.toLowerCase(), [...list, f]);
      }
    }

    const used = new Set();
    const uploads = [], moves = [];
    let unchanged = 0;
    for (const e of expected) {
      const here = present.get(key(e.folder, e.name));
      if (here) {
        used.add(key(e.folder, e.name));
        if (here.size !== e.book.size) uploads.push({ ...e, reason: "changed" });
        else unchanged++;
        continue;
      }
      // Cùng tên, cùng kích thước ở thư mục tầng khác mà ở đó không cần nữa → chuyển thư mục thay vì chép lại
      const from = (byName.get(e.name.toLowerCase()) || []).find(
        (f) => !used.has(key(f, e.name)) && !expectedKeys.has(key(f, e.name)) && present.get(key(f, e.name)).size === e.book.size,
      );
      if (from) {
        used.add(key(from, e.name));
        moves.push({ ...e, from });
      } else uploads.push({ ...e, reason: "new" });
    }
    const deletes = [...present.entries()].filter(([k]) => !used.has(k) && !expectedKeys.has(k)).map(([, v]) => ({ folder: v.folder, name: v.name, size: v.size }));
    const needed = new Set([...uploads, ...moves].map((x) => x.folder));
    const mkdirs = [...needed].filter((f) => !onDisk.has(f.toLowerCase()));
    return { mkdirs, uploads, moves, deletes, unchanged };
  }

  /** Địa chỉ máy đọc: IP hoặc tên (crosspoint.local), có thể kèm cổng. */
  function cleanHost(input) {
    const h = String(input || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    return /^[a-z0-9.-]+(:\d{1,5})?$/i.test(h) ? h : null;
  }

  /** Client cho API File Transfer của CrossPoint. Mọi request đều đủ tham số: máy dễ treo khi nhận request lạ. */
  function device(host, fetchImpl = fetch) {
    const base = `http://${host}`;
    const call = async (path, init = {}, timeout = TIMEOUT_MS) => {
      const r = await fetchImpl(base + path, { ...init, signal: AbortSignal.timeout(timeout) });
      const text = await r.text();
      if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 120)}`.trim());
      return text;
    };
    const form = (o) => ({ method: "POST", body: new URLSearchParams(o) });
    return {
      async status() { return JSON.parse(await call("/api/status")); },
      async list(path) {
        const v = JSON.parse(await call("/api/files?path=" + encodeURIComponent(path)));
        return Array.isArray(v) ? v : [];
      },
      mkdir(parent, name) { return call("/mkdir", form({ name, path: parent })); },
      move(path, dest) { return call("/move", form({ path, dest })); },
      remove(path) { return call("/delete", form({ path })); },
      upload(dir, name, blob) {
        const fd = new FormData();
        fd.append("file", blob, name);
        return call("/upload?path=" + encodeURIComponent(dir), { method: "POST", body: fd }, UPLOAD_TIMEOUT_MS);
      },
    };
  }

  /** Đọc /Sach (tên có sẵn trên thẻ, hoa thường tùy máy) và các thư mục con mang tên tầng. */
  async function scan(dev, shelves) {
    const top = await dev.list("/");
    const rootDir = top.find((f) => f.isDirectory && f.name.toLowerCase() === ROOT_NAME.toLowerCase());
    const root = "/" + (rootDir ? rootDir.name : ROOT_NAME);
    if (!rootDir) return { root, rootExists: false, folders: [], files: {} };
    const wanted = new Set(shelves.map((s) => safeName(s.name).toLowerCase()));
    const entries = await dev.list(root);
    const folders = entries.filter((f) => f.isDirectory).map((f) => f.name);
    const files = {};
    for (const f of folders) {
      if (!wanted.has(f.toLowerCase())) continue;
      files[f] = (await dev.list(`${root}/${f}`)).filter((x) => !x.isDirectory).map((x) => ({ name: x.name, size: x.size }));
    }
    return { root, rootExists: true, folders, files };
  }

  /**
   * Làm theo kế hoạch, từng việc một (máy yếu, không chạy song song). Lỗi thì dừng, báo việc đang làm dở.
   * io = { dev, root, rootExists, getBook(book) → Blob, markFetched(book), onStep(done, total, label) }
   */
  async function runPush(plan, deletes, io) {
    const steps = [];
    if (!io.rootExists) steps.push({ label: io.root, run: () => io.dev.mkdir("/", io.root.slice(1)) });
    for (const f of plan.mkdirs) steps.push({ label: `${f}/`, run: () => io.dev.mkdir(io.root, f) });
    for (const m of plan.moves) {
      steps.push({ label: `${m.from} → ${m.folder}: ${m.name}`, run: async () => { await io.dev.move(`${io.root}/${m.from}/${m.name}`, `${io.root}/${m.folder}`); await io.markFetched(m.book); } });
    }
    for (const u of plan.uploads) {
      steps.push({ label: `${u.folder}/${u.name}`, run: async () => { await io.dev.upload(`${io.root}/${u.folder}`, u.name, await io.getBook(u.book)); await io.markFetched(u.book); } });
    }
    for (const d of deletes) steps.push({ label: `✕ ${d.folder}/${d.name}`, run: () => io.dev.remove(`${io.root}/${d.folder}/${d.name}`) });
    for (let i = 0; i < steps.length; i++) {
      io.onStep(i, steps.length, steps[i].label);
      try {
        await steps[i].run();
      } catch (e) {
        const err = new Error(`${steps[i].label}: ${e && e.message ? e.message : e}`);
        err.done = i;
        throw err;
      }
    }
    io.onStep(steps.length, steps.length, "");
    return steps.length;
  }

  const HOST_KEY = "xl_reader_host";

  /**
   * Nối hộp "Đổ kệ xuống máy" (#pushSheet trong index.html) với app.js.
   * ui = { $, L, esc, tr, toast, busy, api, books(), shelves(), render() }
   */
  function mountUi(ui) {
    const { $, L, esc } = ui;
    let state = null; // { dev, tree, plan }
    const note = (t) => { $("#pushNote").textContent = t; };
    const netHint = (host) => L(`Không gọi được máy đọc ở ${host}. Máy còn mở File Transfer và cùng WiFi không?`, `Can't reach the reader at ${host}. Is File Transfer still open, on the same Wi-Fi?`);
    try { $("#pushHost").value = localStorage.getItem(HOST_KEY) || ""; } catch { /* không có localStorage */ }
    $("#pushHttps").hidden = location.protocol !== "https:";

    function renderPlan() {
      const p = state.plan;
      const unsorted = ui.books().filter((b) => !(b.shelves || []).length).length;
      const item = (t) => `<li>${esc(t)}</li>`;
      const todo = p.uploads.length + p.moves.length;
      $("#pushPlan").innerHTML = `
        <p><b>${esc(state.label)}</b></p>
        <ul class="push-sum">
          <li>${esc(L("Chép mới", "New"))}: <b>${p.uploads.filter((u) => u.reason === "new").length}</b></li>
          <li>${esc(L("Chép lại (file đã đổi)", "Re-copy (file changed)"))}: <b>${p.uploads.filter((u) => u.reason === "changed").length}</b></li>
          <li>${esc(L("Chuyển tầng", "Move"))}: <b>${p.moves.length}</b></li>
          <li>${esc(L("Đã có trên máy", "Already there"))}: <b>${p.unchanged}</b></li>
        </ul>
        ${todo ? `<details><summary>${esc(L("Xem danh sách", "Show list"))}</summary><ul class="push-list">${[
          ...p.moves.map((m) => item(`${m.from} → ${m.folder}/${m.name}`)),
          ...p.uploads.map((u) => item(`${u.folder}/${u.name}`)),
        ].join("")}</ul></details>` : ""}
        ${p.deletes.length ? `<p class="muted small">${esc(L("Có trên máy mà không còn trên kệ. Tích cuốn nào muốn xóa khỏi máy:", "On the reader but no longer on the shelf. Tick the ones to delete from the reader:"))}</p>
          <div class="push-dels">${p.deletes.map((d, i) => `<label class="check"><input type="checkbox" data-del="${i}"><span>${esc(`${d.folder}/${d.name}`)}</span></label>`).join("")}</div>` : ""}
        ${unsorted ? `<p class="muted small">${esc(L(`${unsorted} cuốn Chưa phân loại không chép (chưa lên tầng nào).`, `${unsorted} unsorted books are skipped (not on a shelf).`))}</p>` : ""}`;
      const nothing = !todo && !p.deletes.length && !state.plan.mkdirs.length;
      $("#pushRun").hidden = nothing;
      note(nothing ? L("Máy đã khớp với kệ, không có gì phải chép.", "The reader already matches your shelves.") : "");
    }

    $("#pushScan").addEventListener("click", (e) => ui.busy(e.currentTarget, "…", async () => {
      const host = cleanHost($("#pushHost").value);
      if (!host) { note(L("Gõ địa chỉ IP hiện trên màn hình máy đọc, vd 192.168.1.50", "Type the IP shown on the reader, e.g. 192.168.1.50")); return $("#pushHost").focus(); }
      try { localStorage.setItem(HOST_KEY, host); } catch { /* bỏ qua */ }
      $("#pushPlan").innerHTML = "";
      $("#pushRun").hidden = true;
      note(L("Đang đọc thẻ nhớ…", "Reading the SD card…"));
      const dev = device(host);
      try {
        const st = await dev.status();
        const tree = await scan(dev, ui.shelves());
        state = { dev, tree, plan: planPush({ shelves: ui.shelves(), books: ui.books(), device: tree }), label: `${st.device || "Xteink"} · CrossPoint ${st.version || "?"} · ${tree.root}` };
        renderPlan();
      } catch (err) {
        state = null;
        note(err instanceof TypeError || err?.name === "TimeoutError" ? netHint(host) : ui.tr(String(err?.message || err)));
      }
    }));

    $("#pushRun").addEventListener("click", (e) => ui.busy(e.currentTarget, "…", async () => {
      if (!state) return;
      const dels = [...document.querySelectorAll("#pushPlan [data-del]:checked")].map((x) => state.plan.deletes[Number(x.dataset.del)]);
      if (dels.length && !confirm(L(`Xóa ${dels.length} file khỏi máy đọc?`, `Delete ${dels.length} files from the reader?`))) return;
      $("#pushScan").disabled = true;
      try {
        const n = await runPush(state.plan, dels, {
          dev: state.dev,
          root: state.tree.root,
          rootExists: state.tree.rootExists,
          getBook: async (b) => {
            const r = await fetch(`/books/${encodeURIComponent(b.id)}.epub`, { credentials: "same-origin" });
            if (!r.ok) throw new Error(L("không tải được sách từ kệ", "couldn't fetch the book from the shelf"));
            return r.blob();
          },
          markFetched: async (b) => {
            await ui.api("/api/books/" + encodeURIComponent(b.id), { method: "PATCH", json: { fetched: true } }).catch(() => undefined);
            b.fetched = Date.now();
          },
          onStep: (i, total, label) => note(label ? L(`Đang làm ${i + 1}/${total}: ${label}`, `Working ${i + 1}/${total}: ${label}`) : ""),
        });
        state = null;
        $("#pushRun").hidden = true;
        $("#pushPlan").innerHTML = "";
        note(L(`Xong ${n} việc. Trên máy: Duyệt file → ${ROOT_NAME}.`, `Done, ${n} steps. On the reader: Browse → ${ROOT_NAME}.`));
        ui.toast(L("Đã đổ kệ xuống máy", "Shelves copied to the reader"));
      } catch (err) {
        note(`${L("Dừng ở", "Stopped at")} ${err.message}. ${L("Bấm Kiểm tra để làm tiếp phần còn lại.", "Press Check to continue with the rest.")}`);
      } finally {
        $("#pushScan").disabled = false;
        ui.render();
      }
    }));
  }

  const api = { safeName, fileName, planPush, cleanHost, device, scan, runPush, mountUi, ROOT_NAME };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.XL_PUSH = api;
})();

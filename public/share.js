// Ảnh chia sẻ "sách đã đọc" (tháng / năm): vẽ ngay trên trình duyệt bằng canvas, không gửi dữ liệu đi đâu.
// Khổ 1080 × 1350 (4:5) hợp Facebook, Instagram, Zalo. Trông như tủ trưng bày trên kệ web.
// Xuất window.XL_SHARE cho app.js; module.exports cho test (tests/share.test.ts).
(() => {
  const W = 1080, H = 1350;
  const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const C = {
    frame: "#2e1f13", back1: "#2a221d", back2: "#120f0d", spot: "rgba(255,214,150,0.16)",
    plankTop: "#8a6240", plankFront: "#4d331f", brass1: "#e6c97d", brass2: "#a37a2f", ink: "#f3e8d4", ink2: "#c9b89c",
  };

  /** Khoảng thời gian theo giờ máy người dùng: [from, to) tính bằng ms, kèm nhãn. */
  function periodRange(kind, now = new Date(), lang = "vi") {
    const y = now.getFullYear(), m = now.getMonth();
    const month = (yy, mm) => {
      const d = new Date(yy, mm, 1);
      return { from: d.getTime(), to: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(), label: lang === "en" ? `${MONTHS_EN[d.getMonth()]} ${d.getFullYear()}` : `Tháng ${d.getMonth() + 1}/${d.getFullYear()}` };
    };
    const year = (yy) => ({ from: new Date(yy, 0, 1).getTime(), to: new Date(yy + 1, 0, 1).getTime(), label: lang === "en" ? `${yy}` : `Năm ${yy}` });
    if (kind === "prevMonth") return month(y, m - 1);
    if (kind === "year") return year(y);
    if (kind === "prevYear") return year(y - 1);
    return month(y, m);
  }

  /** Sách đọc xong trong [from, to), xếp theo ngày đọc xong. */
  function finishedIn(books, from, to) {
    return books.filter((b) => b.finished && b.finished >= from && b.finished < to).sort((a, b) => a.finished - b.finished);
  }

  function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }

  /** Xuống dòng theo bề rộng, tối đa `max` dòng (dòng cuối thêm …). */
  function wrap(ctx, text, width, max) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let cur = "";
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (ctx.measureText(t).width <= width || !cur) cur = t;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    if (lines.length > max) { lines.length = max; lines[max - 1] = lines[max - 1].replace(/\s*\S*$/, "") + "…"; }
    return lines;
  }

  function drawCover(ctx, b, img, x, y, w, h) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.55)"; ctx.shadowBlur = 18; ctx.shadowOffsetX = 8; ctx.shadowOffsetY = 10;
    ctx.fillStyle = "#000";
    ctx.fillRect(x, y, w, h);
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    if (img) {
      // Cắt giữa cho vừa khung 2:3
      const s = Math.max(w / img.width, h / img.height);
      const dw = img.width * s, dh = img.height * s;
      ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    } else {
      const hh = hue(b.title);
      const g = ctx.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, `hsl(${hh} 45% 42%)`); g.addColorStop(1, `hsl(${(hh + 40) % 360} 55% 28%)`);
      ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "#fff";
      const fs = Math.max(14, Math.round(w / 8));
      ctx.font = `700 ${fs}px Fraunces, Georgia, serif`;
      const lines = wrap(ctx, b.title, w - fs, 5);
      const base = y + h - fs * (b.author ? 2.1 : 0.8);
      lines.forEach((l, i) => ctx.fillText(l, x + fs / 2, base - (lines.length - 1 - i) * fs * 1.15));
      if (b.author) {
        ctx.font = `500 ${Math.round(fs * 0.62)}px Inter, system-ui, sans-serif`;
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.fillText(wrap(ctx, b.author, w - fs, 1)[0], x + fs / 2, y + h - fs * 0.8);
      }
    }
    // Gáy sách: vệt tối bên trái
    ctx.fillStyle = "rgba(0,0,0,0.22)"; ctx.fillRect(x, y, Math.max(3, w * 0.035), h);
    ctx.restore();
  }

  function plate(ctx, text, cx, y, fs) {
    ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
    const tw = ctx.measureText(text).width + fs * 1.4, th = fs * 1.5;
    const g = ctx.createLinearGradient(0, y, 0, y + th);
    g.addColorStop(0, C.brass1); g.addColorStop(1, C.brass2);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.roundRect(cx - tw / 2, y, tw, th, 4); ctx.fill();
    ctx.fillStyle = "#2a1c06"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, cx, y + th / 2 + 1);
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  }

  /**
   * Vẽ ảnh. opts: { title, subtitle, books, loadCover(b) → Promise<ImageBitmap|null>, footer, lang, dateFmt(ms) }
   * Nhiều quá thì vẽ tối đa 20 cuốn + "và N cuốn nữa".
   */
  async function drawShare(canvas, opts) {
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    try { await Promise.all(["700 64px Fraunces", "600 30px Inter", "500 30px Inter"].map((f) => document.fonts.load(f))); } catch { /* font hệ thống */ }
    // Khung + vách sau
    ctx.fillStyle = C.frame; ctx.fillRect(0, 0, W, H);
    const pad = 44;
    const bg = ctx.createLinearGradient(0, pad, 0, H - pad);
    bg.addColorStop(0, C.back1); bg.addColorStop(1, C.back2);
    ctx.fillStyle = bg; ctx.fillRect(pad, pad, W - pad * 2, H - pad * 2);
    // Tiêu đề
    ctx.fillStyle = C.ink; ctx.font = "700 76px Fraunces, Georgia, serif";
    ctx.fillText(opts.title, pad + 48, pad + 120);
    ctx.fillStyle = C.brass1; ctx.font = "500 36px Inter, system-ui, sans-serif";
    ctx.fillText(opts.subtitle, pad + 50, pad + 180);

    const all = opts.books;
    const shown = all.slice(0, 20);
    const top = pad + 240, bottom = H - pad - 90, left = pad + 40, right = W - pad - 40;
    if (!shown.length) {
      ctx.fillStyle = C.ink2; ctx.font = "italic 500 34px Inter, system-ui, sans-serif";
      ctx.fillText(opts.empty, left + 10, top + 120);
    } else {
      // Ít sách thì bìa to, dàn giữa; nhiều thì nhiều cột và nhiều tầng
      const n = shown.length;
      const cols = n <= 3 ? n : n <= 4 ? 2 : n <= 9 ? 3 : n <= 12 ? 4 : 5;
      const rows = Math.ceil(n / cols);
      const gap = 32, plankH = 40;
      const rowH = (ww) => ww * 1.5 + plankH + 30;
      let w = Math.min(340, (right - left - gap * (cols - 1)) / cols);
      if (rows * rowH(w) > bottom - top) w = ((bottom - top) / rows - plankH - 30) / 1.5;
      const startY = top + Math.max(0, (bottom - top - rows * rowH(w)) / 2);
      const imgs = await Promise.all(shown.map((b) => opts.loadCover(b).catch(() => null)));
      // Chia đều giữa các tầng (10 cuốn → 4 + 3 + 3, không phải 4 + 4 + 2)
      const per = Array.from({ length: rows }, (_, r) => Math.floor(n / rows) + (r < n % rows ? 1 : 0));
      const startAt = (r) => per.slice(0, r).reduce((a, x) => a + x, 0);
      for (let r = 0; r < rows; r++) {
        const items = shown.slice(startAt(r), startAt(r) + per[r]);
        const y0 = startY + r * rowH(w);
        const rowW = items.length * w + (items.length - 1) * gap;
        const x0 = (W - rowW) / 2;
        // Đèn rọi
        const sp = ctx.createRadialGradient(W / 2, y0, 10, W / 2, y0, W * 0.55);
        sp.addColorStop(0, C.spot); sp.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = sp; ctx.fillRect(pad, y0 - 10, W - pad * 2, w * 1.5 + 20);
        items.forEach((b, i) => drawCover(ctx, b, imgs[startAt(r) + i], x0 + i * (w + gap), y0 + 10, w, w * 1.5));
        // Ván: mặt trên + mép trước, ngày đọc xong khắc dưới từng cuốn
        const py = y0 + 10 + w * 1.5;
        ctx.fillStyle = C.plankTop; ctx.fillRect(pad, py, W - pad * 2, 12);
        ctx.save(); ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 16; ctx.shadowOffsetY = 10;
        ctx.fillStyle = C.plankFront; ctx.fillRect(pad, py + 12, W - pad * 2, plankH - 12); ctx.restore();
        items.forEach((b, i) => plate(ctx, opts.dateFmt(b.finished), x0 + i * (w + gap) + w / 2, py + 17, Math.max(14, Math.round(w / 11))));
      }
      if (all.length > shown.length) {
        ctx.fillStyle = C.ink2; ctx.font = "500 30px Inter, system-ui, sans-serif";
        ctx.fillText(opts.more(all.length - shown.length), left + 10, bottom + 10);
      }
    }
    // Chân ảnh
    ctx.fillStyle = C.ink2; ctx.font = "500 26px Inter, system-ui, sans-serif"; ctx.textAlign = "right";
    ctx.fillText(opts.footer, W - pad - 40, H - pad - 34);
    ctx.textAlign = "left";
    // Kính: vệt sáng chéo
    ctx.save(); ctx.globalAlpha = 0.05; ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.moveTo(W * 0.62, pad); ctx.lineTo(W * 0.72, pad); ctx.lineTo(W * 0.42, H - pad); ctx.lineTo(W * 0.32, H - pad); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  const api = { periodRange, finishedIn, drawShare };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.XL_SHARE = api;
})();

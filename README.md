# Xteink Lover

"Send to Kindle" cho máy đọc sách **Xteink** chạy CrossPoint: ném file vào trang web → thành EPUB → nằm trong **kệ OPDS cá nhân** → trên máy mở kệ là tải, từ bất cứ WiFi nào, không cần cùng mạng, không cần bật File Transfer.

- Cloudflare Worker + KV (free tier, không cần thẻ). Static assets phục vụ trang upload.
- Chuyển đổi Markdown / TXT / HTML → EPUB **ngay trên trình duyệt** (`web/convert.ts`, dùng lại bộ đóng gói EPUB của plugin Xteink Sync). EPUB gửi thẳng.
- Toàn bộ (trang, API, feed, file) sau HTTP Basic auth — CrossPoint hỗ trợ Basic.

## Chạy thử local

```bash
npm install
npm run build:web      # public/convert.js
npm test
npm run dev            # http://127.0.0.1:8787  (mật khẩu trong .dev.vars)
```

## Deploy (một lần)

```bash
npx wrangler login                                   # mở trình duyệt, đăng nhập Cloudflare
npx wrangler kv namespace create BOOKS               # dán id vào wrangler.toml
npx wrangler secret put OPDS_PASSWORD                # mật khẩu kệ
npm run build:web && npm run deploy                  # → https://app.xteinklover.workers.dev
```

Đổi `OPDS_USER`, `CATALOG_TITLE` trong `wrangler.toml` nếu muốn.

## Nối Xteink

Settings → System → OPDS Servers → thêm: URL `https://<domain>/opds`, username/password như trên. Trên máy: Settings → OPDS → chọn kệ → sách mới nằm trên cùng → bấm tải.

## API

| | |
| :--- | :--- |
| `GET /opds` | feed OPDS (acquisition) |
| `GET /books/<id>.epub` | tải sách |
| `GET /api/books` | danh sách JSON |
| `POST /api/books` | multipart `file` (EPUB), `title`, `author` |
| `DELETE /api/books/<id>` | xóa |

Giới hạn KV free: 1 GB, 25 MB/file, 1.000 lần ghi/ngày, 1.000 lần list/ngày (mỗi lần mở kệ trên máy = 1 list).

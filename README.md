# Xteink Lover

"Send to Kindle" cho máy đọc sách **Xteink** chạy firmware **CrossPoint**: ném file vào trang web → thành EPUB → nằm trong **kệ OPDS riêng** → trên máy mở kệ là tải. Không cần cùng WiFi, không cần bật File Transfer.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ptk862010/xteinklover)

- Nhận: EPUB, Markdown, TXT, HTML, hoặc dán văn bản. Chuyển sang EPUB **ngay trên trình duyệt**.
- Chạy trên Cloudflare Workers + KV, gói free, **không cần gắn thẻ**.
- Trang web, API, feed và file đều sau đăng nhập (HTTP Basic, CrossPoint hỗ trợ).

## Tự cài một phút

1. Bấm nút **Deploy to Cloudflare** ở trên, đăng nhập (hoặc tạo) tài khoản Cloudflare miễn phí.
2. Điền **OPDS_USER** (tên đăng nhập) và **OPDS_PASSWORD** (mật khẩu) cho kệ. Cloudflare tự tạo chỗ lưu sách.
3. Build xong thì mở `https://xteinklover.<subdomain-của-bạn>.workers.dev`, đăng nhập bằng tài khoản vừa đặt.

Kệ nằm trong tài khoản Cloudflare của bạn, không đi qua ai khác.

## Nối Xteink

Trên máy: **Settings → System → OPDS Servers → thêm**
- URL: `https://<địa chỉ của bạn>/opds`
- Username / Password: như đã đặt ở bước 2

Đọc: **Settings → OPDS** → chọn kệ → sách mới nằm trên cùng → bấm tải. Trang web có nút **⚡ Nối máy** để copy sẵn các giá trị này.

## Cài bằng dòng lệnh

```bash
npm install
npx wrangler login
npx wrangler secret put OPDS_USER
npx wrangler secret put OPDS_PASSWORD
npm run deploy          # lần đầu Cloudflare tự tạo KV
```

Chạy thử local: chép `.dev.vars.example` thành `.dev.vars`, điền mật khẩu, rồi `npm run dev` → http://127.0.0.1:8787. Test: `npm test`.

## Giới hạn gói free

| | |
| :--- | :--- |
| Dung lượng | 1 GB, tối đa 20 MB/file (đổi `MAX_UPLOAD_MB`, trần KV là 25 MB) |
| Gửi sách | 1.000 lần ghi KV/ngày |
| Mở kệ trên máy | 1.000 lần list KV/ngày |
| Request | 100.000/ngày |

Một người dùng thì không chạm tới.

## API

| | |
| :--- | :--- |
| `GET /opds` | feed OPDS (acquisition) |
| `GET /books/<id>.epub` | tải sách |
| `GET /api/books` | danh sách JSON |
| `POST /api/books` | multipart `file` (EPUB), `title`, `author` |
| `DELETE /api/books/<id>` | xóa |

## English

Send-to-Kindle for **Xteink** readers running **CrossPoint** firmware. Drop a file (EPUB, Markdown, TXT, HTML) or paste text; it is converted to EPUB in your browser and added to a private OPDS catalog that the reader pulls over any WiFi. Click **Deploy to Cloudflare**, set `OPDS_USER` and `OPDS_PASSWORD`, then add `https://<your-worker>/opds` under Settings → System → OPDS Servers on the device. Runs on the Cloudflare free plan, no card required.

## License

MIT

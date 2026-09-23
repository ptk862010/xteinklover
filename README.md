# Xteink Lover

"Send to Kindle" cho máy đọc sách **Xteink** chạy firmware **CrossPoint**: ném file vào trang web → thành EPUB → nằm trên **kệ OPDS riêng** → trên máy mở kệ là tải. Không cần cùng WiFi, không cần bật File Transfer.

Dùng ngay, miễn phí: **https://app.xteinklover.workers.dev** — tạo tài khoản là có kệ riêng.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ptk862010/xteinklover)

- Nhận **EPUB, MOBI, AZW3, AZW, PRC, PDF, CBZ** (truyện tranh), Markdown, TXT, HTML hoặc văn bản dán vào. Mọi thứ được chuyển sang EPUB **ngay trên trình duyệt**, máy chủ không tốn CPU.
- Tài khoản bằng tên đăng nhập + mật khẩu, không cần email. Mật khẩu được băm trên trình duyệt, máy chủ không bao giờ thấy mật khẩu thật.
- Máy đọc sách đăng nhập bằng **khóa OPDS** riêng (không dùng mật khẩu tài khoản), tạo lại được bất cứ lúc nào.
- Chạy trên Cloudflare Workers + D1 + KV, gói free, **không cần gắn thẻ**.

## Định dạng

| File | Cách chuyển |
| :--- | :--- |
| EPUB | Gửi nguyên |
| MOBI, AZW3 (KF8), AZW, PRC | Giữ chữ, ảnh, bìa, chia chương. Sách **có DRM** (mua trên Kindle Store) không chuyển được |
| PDF — chế độ **Chữ** | Rút chữ, bỏ header/footer và số trang, nối lại đoạn văn, nhận tiêu đề theo cỡ chữ. Đọc thoải mái, đổi cỡ chữ được. Hợp sách chữ |
| PDF — chế độ **Ảnh trang** | Mỗi trang thành ảnh xám vừa màn 480×800 (trang ngang tự xoay). Giữ nguyên bố cục. Hợp PDF scan, sách vẽ, sơ đồ |
| PDF — **Tự chọn** (mặc định) | 5 trang đầu gần như không có chữ → Ảnh trang, còn lại → Chữ |
| CBZ | Mỗi ảnh một trang, như Ảnh trang |
| Markdown, TXT, HTML | Chuyển thẳng |

Máy CrossPoint không đọc PDF và MOBI trực tiếp, nên mọi thứ lên kệ đều là EPUB. File sau khi chuyển tối đa 20 MB (PDF ảnh trang dài quá thì tách file hoặc dùng chế độ Chữ).

Thư viện: [foliate-js](https://github.com/johnfactotum/foliate-js) (MIT) đọc MOBI/KF8, [PDF.js](https://mozilla.github.io/pdf.js/) (Apache-2.0) đọc PDF — chỉ tải về khi có người gửi đúng loại file đó.

## Nối Xteink

1. Trên trang web, bấm **⚡ Nối máy**: có URL, User và khóa OPDS (khóa chỉ hiện một lần lúc tạo tài khoản hoặc khi bấm *Tạo khóa mới*).
2. Trên máy: **Settings → System → OPDS Servers → Add**
   - URL: `https://<địa chỉ>/opds`
   - Username: tên đăng nhập
   - Password: **khóa OPDS** (gõ có hay không có dấu gạch đều được)
3. Đọc: **Settings → OPDS** → chọn kệ → sách mới nằm trên cùng → bấm tải.

## Tự cài cho riêng mình

1. Bấm **Deploy to Cloudflare** ở trên, đăng nhập (hoặc tạo) tài khoản Cloudflare miễn phí.
2. Điền **SIGNUP_CODE**: một mã mời tự đặt. Bắt buộc — không có mã thì trang không cho ai đăng ký, để người lạ không chiếm kệ trước bạn. Cloudflare tự tạo KV và D1; bảng dữ liệu được tạo ở request đầu tiên.
3. Mở `https://xteinklover.<subdomain-của-bạn>.workers.dev` → **Tạo tài khoản** → nhập mã mời.

Mặc định `MAX_USERS = "1"`: sau tài khoản của bạn thì không ai đăng ký được nữa. Muốn cho cả nhà dùng thì tăng số này trong `wrangler.toml`.

Dòng lệnh:

```bash
npm install
npx wrangler login
npx wrangler secret put SIGNUP_CODE
npm run deploy          # lần đầu Cloudflare tự tạo KV + D1
```

### Đăng nhập bằng Google (không bắt buộc)

Không cấu hình thì trang chỉ có tên + mật khẩu. Muốn có nút "Tiếp tục với Google":

1. Vào [Google Cloud Console](https://console.cloud.google.com/) → tạo project → **Google Auth Platform**.
2. **Branding**: tên app, email hỗ trợ. **Audience**: External, rồi bấm **Publish app**. Trang chỉ xin `openid` + `email` (phạm vi không nhạy cảm) nên không phải qua xét duyệt. Để ở chế độ Testing thì chỉ các email được thêm vào danh sách test user mới đăng nhập được.
3. **Clients → Create client → Web application**. Mục *Authorized redirect URIs* thêm `https://<địa-chỉ-của-bạn>/auth/google/callback` (chạy thử ở máy thì thêm `http://localhost:8787/auth/google/callback`).
4. Client ID để ở `[vars]`, Client secret để làm secret:

```bash
# wrangler.toml → [vars]: GOOGLE_CLIENT_ID = "xxxx.apps.googleusercontent.com"
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Người mới bấm Google thì chọn một tên đăng nhập (tên này điền vào ô User trên máy đọc). Tài khoản có mật khẩu thì vào **Tài khoản → Liên kết Google**. Trang chỉ lưu mã định danh Google, không lưu email: email chỉ dùng một lần để gợi ý tên. Máy đọc sách vẫn dùng khóa OPDS như mọi tài khoản.

### Dán link bài viết

Tab **Dán link**: dán link bài báo, blog → trang tự cắt lấy nội dung chính và ảnh (Readability), làm EPUB, lên kệ. Server chỉ lấy hộ trang (vượt CORS), không phân tích: cắt bài chạy trên trình duyệt. Chặn link tới IP, địa chỉ nội bộ, cổng lạ, kể cả khi trang chuyển hướng; tối đa 40 link và 600 ảnh mỗi người mỗi giờ. Bài cần đăng nhập (báo trả phí) thì server không lấy được: copy nội dung rồi dán vào tab **Dán văn bản** (dán từ trang web giữ tiêu đề, danh sách, link).

Trên Android, cài trang như app (menu Chrome → *Thêm vào màn hình chính*), rồi ở app nào cũng bấm **Chia sẻ → Xteink Lover**. iPhone: Phím tắt mở `https://<địa-chỉ>/?url=<link>`.

### Gửi từ Obsidian

Plugin Obsidian **Xteink Sync** gửi note thẳng lên kệ, từ bất cứ đâu: trên web vào **Tài khoản → Mã cho ứng dụng → Tạo mã**, dán mã vào cài đặt plugin (Gửi tới: Kệ Xteink Lover). Mã chỉ xem, gửi, xóa được sách; tối đa 5 mã, thu hồi riêng từng mã.

## Phát triển

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev             # http://127.0.0.1:8787
npm test                # unit test
npm run test:e2e        # test tích hợp: bật wrangler dev với dữ liệu sạch, chạy cả luồng
npm run typecheck
```

## Cấu hình (`[vars]` trong wrangler.toml)

Cột "Mặc định" là giá trị khi không khai báo biến. `wrangler.toml` (tự cài) đặt sẵn `MAX_USERS = "1"`.

| Biến | Mặc định | Ý nghĩa |
| :--- | :--- | :--- |
| `MAX_USERS` | 0 (không giới hạn) | Số tài khoản tối đa |
| `SIGNUP_CODE` (secret) | trống | Mã mời. Không đặt thì đăng ký bị đóng |
| `OPEN_SIGNUP` | trống | `"1"` = ai cũng đăng ký được, không cần mã (bản công khai) |
| `MAX_SIGNUPS_PER_DAY` | 20 | Tài khoản mới tối đa mỗi ngày, cả hệ thống |
| `MAX_UPLOAD_MB` | 20 | Dung lượng tối đa một file (trần KV 25 MB) |
| `MAX_BOOKS_PER_USER` | 300 | Số sách tối đa trên một kệ |
| `MAX_STORAGE_MB_PER_USER` | 200 | Dung lượng tối đa một kệ |
| `MAX_STORAGE_MB_TOTAL` | 900 | Dung lượng tối đa cả hệ thống (KV free: 1 GB) |
| `MAX_UPLOADS_PER_DAY` | 50 | Lượt gửi mỗi người mỗi ngày |
| `MAX_UPLOADS_PER_DAY_TOTAL` | 900 | Lượt gửi cả hệ thống mỗi ngày (KV free: 1.000 ghi/ngày) |
| `GOOGLE_CLIENT_ID` | trống | Bật đăng nhập bằng Google (cần cả `GOOGLE_CLIENT_SECRET`) |
| `GOOGLE_CLIENT_SECRET` (secret) | trống | Client secret của Google |

Ngày tính theo UTC, reset lúc 7:00 sáng giờ Việt Nam, trùng giờ Cloudflare reset quota free.

## Giới hạn gói free của Cloudflare

| | |
| :--- | :--- |
| Worker | 100.000 request/ngày, 10 ms CPU/request |
| KV (file sách) | 1 GB, 25 MB/file, 1.000 ghi + 1.000 xóa/ngày |
| D1 (tài khoản, danh mục) | 5 triệu đọc, 100.000 ghi/ngày, 500 MB |

Trang tĩnh không tính vào 100.000 request. Mỗi lần máy mở kệ hoặc tải sách tính 1 request.

Hạn mức 100.000 request/ngày là chung cả tài khoản Cloudflare. Trên địa chỉ `*.workers.dev` không đặt được luật chặn theo IP, nên nếu ai đó cố tình bắn request liên tục thì trang sẽ ngừng tới 7:00 sáng hôm sau. Muốn chặn được thì gắn tên miền riêng và bật rate limiting của Cloudflare, hoặc lên gói Workers Paid.

Mỗi giờ Worker tự dọn phiên hết hạn và bộ đếm cũ, xóa file của sách đã gỡ (tối đa 40 file mỗi lần), và xóa tài khoản rỗng (không có sách) không đăng nhập 14 ngày.

Mỗi lần đăng nhập sai ghi 2–3 dòng D1. Kẻ dò mật khẩu dùng rất nhiều IP có thể làm cạn 100.000 lượt ghi D1/ngày trước cả 100.000 request; cách chặn giống trên.

## API

| | |
| :--- | :--- |
| `POST /api/signup` | `{username, proof, code?}` → tạo tài khoản, trả khóa OPDS + cookie phiên |
| `POST /api/login` | `{username, proof}` |
| `POST /api/logout` | |
| `GET /api/me` | tài khoản, mức dùng, hạn mức |
| `POST /api/password` | `{current, next}` (đều là proof) |
| `POST /api/opds-key` | tạo khóa OPDS mới |
| `DELETE /api/account` | `{proof}` → xóa tài khoản và toàn bộ sách. Tài khoản chỉ có Google: `{confirm: username}`, phiên phải mới đăng nhập trong 10 phút |
| `GET /api/config` | `{google, signup, needsCode}` — trang có bật Google không |
| `POST /api/google/start` | `{mode: "login" \| "link", proof?}` → `{url}` của Google (liên kết vào tài khoản có mật khẩu thì cần `proof`) |
| `GET /auth/google/callback` | Google chuyển về; trả 303 về `/?google=ok\|pick\|linked\|…` |
| `GET /api/google/pending` | người mới từ Google: `{suggest, needsCode}` |
| `POST /api/google/signup` | `{username, code?}` → tạo tài khoản gắn Google |
| `POST /api/google/cancel` · `POST /api/google/unlink` | bỏ chọn tên · gỡ Google (chỉ khi tài khoản có mật khẩu) |
| `POST /api/fetch-page` | `{url}` → byte thô của trang (header `X-Final-Url`, `X-Charset`) để trình duyệt cắt bài |
| `GET /api/fetch-image?url=` | ảnh trong bài (không nhận SVG) |
| `GET /api/tokens` · `POST /api/tokens` | liệt kê / tạo mã ứng dụng `{name, proof?}` (tài khoản có mật khẩu phải kèm `proof`; chỉ có Google thì phải vừa đăng nhập lại trong 10 phút) |
| `DELETE /api/tokens/<id>` | thu hồi mã |
| `GET /api/books` | danh sách sách |
| `POST /api/books?title=&author=` | body là file EPUB thô |
| `DELETE /api/books/<id>` | xóa sách |
| `GET /opds` | feed OPDS (Basic auth: tên đăng nhập + khóa OPDS) |
| `GET /books/<id>.epub` | tải sách (Basic auth hoặc cookie) |

`proof` = hex của PBKDF2-SHA256(mật khẩu, `"xteinklover|v1|" + username`, 600.000 vòng, 32 byte). Mọi request đổi dữ liệu phải có `Origin` cùng trang.

**Mã ứng dụng** (`Authorization: Bearer xlapp_…`) chỉ dùng được cho `GET /api/me`, `GET /api/books`, `POST /api/books`, `DELETE /api/books/<id>`; không cần `Origin`. Việc khác trả 403.

`POST /api/books`: body là file EPUB thô (`Content-Type: application/epub+zip`, bắt buộc `Content-Length`), tiêu đề và tác giả ở query `?title=&author=`.

## Bảo mật, tóm tắt

- Mật khẩu băm hai tầng: trình duyệt PBKDF2 600.000 vòng, máy chủ băm thêm với salt ngẫu nhiên. Máy chủ không thấy mật khẩu thật.
- Đăng nhập sai 10 lần từ một nơi (tên + IP) thì nơi đó bị chặn 15 phút; một tên bị dò quá 30 lần/15 phút từ mọi nơi thì trình duyệt lạ bị chặn, còn trình duyệt bạn đã từng đăng nhập đúng (cookie thiết bị) vẫn vào được.
- Nhập lại mật khẩu sai 5 lần trong một phiên (đổi mật khẩu / xóa tài khoản) thì phiên đó bị đăng xuất; các phiên khác không ảnh hưởng.
- Tối đa 10 phiên đăng nhập mỗi người; đổi mật khẩu đăng xuất mọi nơi khác. Khóa OPDS riêng, đổi được bất cứ lúc nào.
- Cookie `__Host-`, `HttpOnly`, `SameSite=Lax`, kiểm `Origin` mọi request ghi; trang có CSP chặn script lạ.
- Google: authorization code + PKCE, `state` và `nonce` giữ trong cookie HttpOnly 10 phút. `id_token` nhận thẳng từ token endpoint của Google qua HTTPS nên chỉ kiểm `iss`/`aud`/`exp`/`nonce`, không kiểm chữ ký (OpenID Connect Core 3.1.3.7). Liên kết Google vào tài khoản có mật khẩu phải nhập lại mật khẩu, để phiên bị trộm không gắn được Google của kẻ trộm.

## English

Send-to-Kindle for **Xteink** readers running **CrossPoint** firmware. Create an account at https://app.xteinklover.workers.dev (or self-host with the Deploy button), drop files (EPUB, MOBI, AZW3, AZW, PRC, PDF, CBZ, Markdown, TXT, HTML) or paste text; they are converted to EPUB in your browser and added to your private OPDS catalog. On the reader, add `https://<host>/opds` under Settings → System → OPDS Servers with your username and your **OPDS key** as the password. Runs on the Cloudflare free plan (Workers + D1 + KV), no card required.

## License

MIT

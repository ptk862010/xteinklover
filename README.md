# Xteink Lover

"Send to Kindle" cho máy đọc sách **Xteink** chạy firmware **CrossPoint**: thả file vào trang web → thành EPUB → nằm trên **kệ OPDS riêng** → trên máy mở kệ là tải. Không cần cùng WiFi, không cần bật File Transfer.

Dùng thử: **https://xteinklover.ongk.dev** (bản demo, có giới hạn chỗ). Dùng lâu dài thì nên **tự dựng bản riêng** bằng nút bên dưới: miễn phí, không cần thẻ, gói miễn phí của Cloudflare cho 1 GB lưu sách, sách chỉ nằm trong tài khoản của bạn.

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

Máy cần firmware **CrossPoint** (mã nguồn mở, đã kiểm với bản 1.6): firmware gốc của Xteink không có OPDS. Cài bằng Chrome/Edge trên máy tính ở https://crosspointreader.com/#flash-tools (máy mua qua bên thứ ba có thể bị khóa USB, xem mục mở khóa trên trang đó). Chưa cài được thì tải EPUB trên web rồi chép vào thẻ nhớ.

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

### Đồng bộ tiến độ đọc (KOReader, CrossPoint)

Đọc trên máy này, mở sách trên máy kia là đọc tiếp đúng chỗ. Xteink Lover nói giao thức **KOSync** của KOReader (đạt bộ kiểm `kosync-conformance`), nên chạy với **KOReader** (Kindle đã jailbreak, Kobo, Android) và **CrossPoint** (Xteink). Không phải đăng ký máy chủ đồng bộ nào khác.

1. Trên web: **⚡ Nối máy → Đồng bộ tiến độ đọc → Tạo mã đồng bộ**, mỗi máy một mã (20 chữ số, hiện một lần, tối đa 5). Mã là Password trên máy đọc, không phải mật khẩu tài khoản; gõ liền, cách dấu cách hay gạch ngang đều được.
2. Hai máy lấy **cùng một file** từ kệ OPDS này.
3. **KOReader:** mở sách → Tools → Progress sync → Custom sync server = `https://<địa chỉ>` → **Login** (tên đăng nhập + mã). Document matching method = **Binary**. Bật *Automatically keep documents in sync* (trên Kindle phải đặt trước *Settings → Network → Action when Wi-Fi is off = Turn on*); nên đặt cả hai chiều *Sync to a newer / older state* = **Prompt**.
4. **CrossPoint:** Settings → System → KOReader Sync: Sync Server URL = `https://<địa chỉ>` (**có** `https://`), Username, Password = mã → Authenticate. **Document Matching = Binary** (mặc định là Filename, phải đổi). Đồng bộ bấm tay: Reader Menu → Sync Progress.

Đăng ký tài khoản từ máy đọc bị tắt (tài khoản chỉ tạo trên web). Đổi mật khẩu thì mọi mã đồng bộ bị thu hồi, trừ khi tích ô "Giữ mã đồng bộ của các máy đọc". Tài khoản có mã được dùng trong 90 ngày không bị coi là bỏ hoang.

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
| `SHOW_SELF_HOST` | trống | `"1"` = hiện nút "Tự dựng" / Deploy to Cloudflare (bản chung của tác giả). Bản tự dựng để trống: chỉ có dòng ghi công nhỏ ở chân trang |
| `GOOGLE_CLIENT_ID` | trống | Bật đăng nhập bằng Google (cần cả `GOOGLE_CLIENT_SECRET`) |
| `GOOGLE_CLIENT_SECRET` (secret) | trống | Client secret của Google |
| `MAX_SYNC_DOCS` | 1000 | Đồng bộ tiến độ: số sách tối đa mỗi người; vượt thì đẩy ra sách lâu nhất không đụng tới (không báo lỗi) |
| `MAX_SYNC_NEW_PER_DAY` | 300 | Đồng bộ tiến độ: số sách **mới** tối đa mỗi người mỗi ngày (0 = không giới hạn) |
| `MAX_SYNC_WRITES_PER_DAY` | 2000 | Đồng bộ tiến độ: lượt ghi tối đa mỗi người mỗi ngày; quá thì máy nhận 503 (tự gửi lại sau), không 401 |
| `MAX_SYNC_WRITES_PER_DAY_TOTAL` | 15000 | Đồng bộ tiến độ: lượt ghi tối đa cả hệ thống mỗi ngày (giữ phần quota D1 cho kệ sách) |

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
| `GET /api/sync-keys` · `POST /api/sync-keys` | liệt kê mã đồng bộ + số sách đã đồng bộ / tạo mã `{name, proof?}` (như mã ứng dụng) → `{id, name, code, username, server}` |
| `DELETE /api/sync-keys/<id>` · `DELETE /api/sync-progress` | thu hồi một mã · xóa hết tiến độ đồng bộ |
| `GET /users/auth` | KOSync: kiểm đăng nhập (`x-auth-user`, `x-auth-key` = md5 của mã đồng bộ gõ vào) |
| `PUT /syncs/progress` | KOSync: `{document, progress, percentage, device, device_id?}` → `{document, timestamp}` |
| `GET /syncs/progress/<document>` | KOSync: tiến độ đã lưu, hoặc `{}` nếu chưa có |
| `POST /users/create` · `GET /healthcheck` | KOSync: đăng ký bị tắt (402) · `{"state":"OK"}` |

`proof` = hex của PBKDF2-SHA256(mật khẩu, `"xteinklover|v1|" + username`, 600.000 vòng, 32 byte). Mọi request đổi dữ liệu phải có `Origin` cùng trang.

**Mã ứng dụng** (`Authorization: Bearer xlapp_…`) chỉ dùng được cho `GET /api/me`, `GET /api/books`, `POST /api/books`, `DELETE /api/books/<id>` và `POST /api/opds-key` (plugin tự ghi khóa OPDS mới vào máy đọc; người cầm mã vì vậy tải được sách trên kệ); không cần `Origin`. Việc khác trả 403.

`POST /api/books`: body là file EPUB thô (`Content-Type: application/epub+zip`, bắt buộc `Content-Length`), tiêu đề và tác giả ở query `?title=&author=`.

## Bảo mật, tóm tắt

- Mật khẩu băm hai tầng: trình duyệt PBKDF2 600.000 vòng, máy chủ băm thêm với salt ngẫu nhiên. Máy chủ không thấy mật khẩu thật.
- Đăng nhập sai 10 lần từ một nơi (tên + IP) thì nơi đó bị chặn 15 phút; một tên bị dò quá 30 lần/15 phút từ mọi nơi thì trình duyệt lạ bị chặn, còn trình duyệt bạn đã từng đăng nhập đúng (cookie thiết bị) vẫn vào được.
- Nhập lại mật khẩu sai 5 lần trong một phiên (đổi mật khẩu / xóa tài khoản) thì phiên đó bị đăng xuất; các phiên khác không ảnh hưởng.
- Tối đa 10 phiên đăng nhập mỗi người; đổi mật khẩu đăng xuất mọi nơi khác. Khóa OPDS riêng, đổi được bất cứ lúc nào.
- Cookie `__Host-`, `HttpOnly`, `SameSite=Lax`, kiểm `Origin` mọi request ghi; trang có CSP chặn script lạ.
- Đồng bộ tiến độ: máy đọc gửi md5 của mã đồng bộ; máy chủ chỉ lưu `sha256(salt riêng từng mã + md5)` cho 3 cách gõ. Mã chỉ dùng được cho `/users/auth` và `/syncs/*`, không mở được kệ sách hay tài khoản; cookie phiên không dùng được ở đó. Lỗi máy chủ không bao giờ trả 401 (KOReader nhận 401 sẽ bỏ tiến độ). CrossPoint gửi kèm mã thô trong header `Authorization` và không kiểm chứng chỉ TLS: đừng dùng mã trên Wi-Fi lạ, lộ thì thu hồi trên web.
- Google: authorization code + PKCE, `state` và `nonce` giữ trong cookie HttpOnly 10 phút. `id_token` nhận thẳng từ token endpoint của Google qua HTTPS nên chỉ kiểm `iss`/`aud`/`exp`/`nonce`, không kiểm chữ ký (OpenID Connect Core 3.1.3.7). Liên kết Google vào tài khoản có mật khẩu phải nhập lại mật khẩu, để phiên bị trộm không gắn được Google của kẻ trộm.

## English

**Send-to-Kindle for Xteink e-readers running CrossPoint firmware.** Drop a file (EPUB, MOBI, AZW3, AZW, PRC, PDF, CBZ, Markdown, TXT, HTML), paste text, or paste an article link. It is converted to EPUB in your browser and added to your private OPDS shelf. The reader pulls it over Wi-Fi from anywhere. The interface is in English and Vietnamese (EN/VI button, or `?lang=en`).

- Demo: https://xteinklover.ongk.dev/?lang=en (limited space, for trying it out). For everyday use, run your own copy with the Deploy button: free, no card, 1 GB for books on the Cloudflare free plan.
- Obsidian: the **Xteink Sync** plugin (Community plugins) sends notes here with an app token
- **Reading progress sync** for **KOReader** (Kindle, Kobo, Android) and **CrossPoint** (Xteink): the same account is a KOReader-compatible sync server (passes `kosync-conformance`). Under ⚡ Connect → *Sync reading progress*, create one **sync code** per device and use it as the reader's password with server `https://<your address>`. Set **Document matching = Binary** on both readers (CrossPoint defaults to Filename) and get the books from this shelf so both have the same file. On a Kindle, set *Settings → Network → Action when Wi-Fi is off = Turn on* before enabling KOReader's automatic sync.

**Requires CrossPoint firmware** (open source, tested with 1.6); the stock Xteink firmware has no OPDS. Install it from Chrome/Edge on a computer at https://crosspointreader.com/#flash-tools.

### Self-host in one click

1. Press **Deploy to Cloudflare** at the top of this page and sign in to (or create) a free Cloudflare account. No card needed.
2. When asked for **SIGNUP_CODE**, type an invite code of your choice. It's required: without it nobody can sign up, so strangers can't take your instance first. Cloudflare creates the KV namespace and the D1 database for you; tables are created on the first request.
3. Open `https://xteinklover.<your-subdomain>.workers.dev` → **Create account** → enter your invite code.
4. On the reader: Settings → System → OPDS Servers → Add → URL `https://xteinklover.<your-subdomain>.workers.dev/opds`, your username, and your **OPDS key** (shown under ⚡ Connect) as the password.

`MAX_USERS` is `1` by default, so only you can sign up. Raise it in `wrangler.toml` to share with family or friends. Optional: Google sign-in (`GOOGLE_CLIENT_ID` var + `GOOGLE_CLIENT_SECRET` secret, see the Vietnamese section above), and all limits in the configuration table.

From the command line instead:

```bash
npm install
npx wrangler login
npx wrangler secret put SIGNUP_CODE
npm run deploy
```

Free plan limits (shared by the whole Cloudflare account): 100,000 Worker requests/day, KV 1 GB and 1,000 writes/day, D1 5 million reads and 100,000 writes/day. Quotas reset at 00:00 UTC.

## License

MIT

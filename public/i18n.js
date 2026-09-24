// Ngôn ngữ giao diện: tiếng Việt (mặc định, có sẵn trong HTML) hoặc tiếng Anh.
// - HTML: chữ tiếng Anh nằm ở thuộc tính data-en / data-en-html / data-en-placeholder / data-en-title / data-en-aria-label
// - app.js: L("tiếng Việt", "English")
// - Thông báo lỗi từ máy chủ và bộ chuyển đổi (luôn là tiếng Việt): XL_I18N.tr(msg) dịch theo bảng MESSAGES
// Chọn ngôn ngữ: ?lang= → lựa chọn đã lưu → trình duyệt. Máy tìm kiếm luôn nhận tiếng Việt ở địa chỉ gốc
// (bản tiếng Anh có địa chỉ riêng /?lang=en, khai báo bằng hreflang).
(() => {
  const SUPPORTED = ["vi", "en"];

  function resolve() {
    try {
      const q = new URLSearchParams(location.search).get("lang");
      if (SUPPORTED.includes(q)) return q;
    } catch { /* bỏ qua */ }
    try {
      const saved = localStorage.getItem("xl_lang");
      if (SUPPORTED.includes(saved)) return saved;
    } catch { /* bỏ qua */ }
    if (/bot|crawl|spider|slurp|facebookexternalhit|lighthouse/i.test(navigator.userAgent)) return "vi";
    const langs = navigator.languages?.length ? navigator.languages : [navigator.language || "vi"];
    return langs.some((l) => /^vi\b/i.test(l)) ? "vi" : "en";
  }

  const lang = resolve();

  /** Thông báo tiếng Việt (máy chủ, bộ chuyển đổi) → tiếng Anh. Không có trong bảng thì giữ nguyên. */
  const MESSAGES = [
    // Máy chủ: đăng nhập, tài khoản
    [/^Cần đăng nhập$/, "Please sign in"],
    [/^Dữ liệu không hợp lệ$/, "Invalid request"],
    [/^Sai tên đăng nhập hoặc mật khẩu$/, "Wrong username or password"],
    [/^Sai quá nhiều lần, đợi 15 phút rồi thử lại$/, "Too many attempts. Wait 15 minutes and try again"],
    [/^Sai mật khẩu quá nhiều lần\. Phiên này đã bị đăng xuất, hãy đăng nhập lại$/, "Too many wrong passwords. This session was signed out, please sign in again"],
    [/^Mật khẩu không đúng$/, "Wrong password"],
    [/^Mật khẩu không hợp lệ, tải lại trang rồi thử lại$/, "Invalid password data. Reload the page and try again"],
    [/^Tên đăng nhập đã có người dùng$/, "That username is taken"],
    [/^Tên đăng nhập dài 3–32 ký tự$/, "Username must be 3–32 characters"],
    [/^Tên đăng nhập chỉ gồm chữ thường không dấu, số và \. _ -$/, "Username: lowercase letters a–z, digits and . _ - only"],
    [/^Tên này đã được giữ, chọn tên khác$/, "That name is reserved, pick another"],
    [/^Mã mời không đúng$/, "Wrong invite code"],
    [/^Trang này chưa mở đăng ký \(chủ trang cần đặt SIGNUP_CODE\)$/, "Sign-up is closed on this site (the owner needs to set SIGNUP_CODE)"],
    [/^Đăng ký quá nhiều lần, thử lại sau một giờ$/, "Too many sign-ups. Try again in an hour"],
    [/^Hôm nay đã đủ lượt đăng ký mới, mai quay lại nhé$/, "No more new accounts today. Please come back tomorrow"],
    [/^Đã đủ số tài khoản, hiện không nhận đăng ký mới$/, "This site is full and not accepting new accounts right now"],
    [/^Gõ đúng tên đăng nhập để xác nhận$/, "Type your username exactly to confirm"],
    [/^Đăng nhập lại bằng Google để xác nhận xóa$/, "Sign in with Google again to confirm deletion"],
    [/^Đăng nhập lại bằng Google để tạo mã$/, "Sign in with Google again to create a token"],
    [/^Tài khoản này đăng nhập bằng Google, chưa có mật khẩu$/, "This account signs in with Google and has no password"],
    [/^Tài khoản này chỉ đăng nhập bằng Google, không gỡ được$/, "This account only signs in with Google, so Google can't be unlinked"],
    [/^Sai nguồn gửi$/, "Request blocked (wrong origin)"],
    [/^Không hỗ trợ$/, "Not supported"],
    [/^Không có$/, "Not found"],
    [/^Lỗi máy chủ, thử lại sau$/, "Server error, please try again later"],
    [/^Hệ thống đã dùng hết lượt miễn phí hôm nay, thử lại sau 7 giờ sáng$/, "The free daily quota is used up. Try again after 00:00 UTC"],
    // Google
    [/^Trang này chưa bật đăng nhập bằng Google$/, "Google sign-in is not enabled on this site"],
    [/^Google này đã có tài khoản rồi, bấm Đăng nhập bằng Google$/, "This Google account already has an account here. Use Continue with Google"],
    [/^Hết thời gian chọn tên, bấm Đăng nhập bằng Google lại nhé$/, "Time's up for picking a name. Continue with Google again"],
    [/^Không có đăng ký Google nào đang chờ$/, "No pending Google sign-up"],
    // Mã ứng dụng
    [/^Mã ứng dụng sai hoặc đã bị thu hồi$/, "App token is wrong or has been revoked"],
    [/^Mã ứng dụng không dùng được cho việc này, đăng nhập trên web$/, "App tokens can't do this. Sign in on the website"],
    [/^Tối đa (\d+) mã, thu hồi bớt mã cũ trước$/, "At most $1 tokens. Revoke an old one first"],
    [/^Không có mã này$/, "Token not found"],
    // Sách
    [/^Không có sách này$/, "Book not found"],
    [/^Thiếu Content-Length$/, "Missing Content-Length"],
    [/^File quá (\d+) MB$/, "File is larger than $1 MB"],
    [/^Chỉ nhận EPUB \(trang web tự chuyển file khác sang EPUB trước khi gửi\)$/, "Only EPUB is accepted (the website converts other files to EPUB before sending)"],
    [/^Hôm nay đã gửi (\d+) cuốn, mai gửi tiếp nhé$/, "You've sent $1 books today. Send more tomorrow"],
    [/^Kệ đã đủ (\d+) cuốn hoặc (\d+) MB, xóa bớt rồi gửi tiếp$/, "Your shelf is full ($1 books or $2 MB). Delete some, then send again"],
    [/^Kho chung đã đầy, chưa nhận thêm sách được\. Xin lỗi, thử lại sau nhé$/, "Shared storage is full, no more books can be added right now. Sorry, try again later"],
    [/^Hệ thống đã hết lượt gửi hôm nay \(gói miễn phí\), thử lại sau 7 giờ sáng$/, "The site has used today's free upload quota. Try again after 00:00 UTC"],
    [/^Tải lên bị ngắt, thử lại$/, "Upload was interrupted, try again"],
    // Dán link
    [/^Link không hợp lệ$/, "Invalid link"],
    [/^Chỉ nhận link http\(s\)$/, "Only http(s) links"],
    [/^Link không được chứa tên đăng nhập, mật khẩu$/, "Links can't contain a username or password"],
    [/^Chỉ nhận cổng web thông thường$/, "Only standard web ports"],
    [/^Không nhận link tới địa chỉ IP, dùng tên miền$/, "Links to IP addresses aren't allowed, use a domain name"],
    [/^Không nhận địa chỉ nội bộ$/, "Local network addresses aren't allowed"],
    [/^Đây là link của chính Xteink Lover$/, "That's a link to Xteink Lover itself"],
    [/^Tối đa (\d+) link mỗi giờ, thử lại sau$/, "At most $1 links per hour, try again later"],
    [/^Không mở được trang \(hết giờ chờ hoặc trang không tồn tại\)$/, "Couldn't open the page (timed out or it doesn't exist)"],
    [/^Trang chuyển hướng quá nhiều lần$/, "Too many redirects"],
    [/^Trang chuyển hướng sang địa chỉ hỏng$/, "The page redirected to a broken address"],
    [/^Trang cần đăng nhập hoặc chặn truy cập tự động\..*$/, "The page needs a login or blocks automated access. Open the article in your browser, copy it and paste it into the “Paste text” tab"],
    [/^Trang trả về lỗi (\d+)$/, "The page returned error $1"],
    [/^Link này không phải trang web \(có thể là file\)\..*$/, "This link isn't a web page (maybe a file). Download it and drop it into the file box"],
    [/^Trang quá lớn$/, "Page is too large"],
    [/^Không phải ảnh$/, "Not an image"],
    [/^Ảnh quá lớn$/, "Image is too large"],
    [/^Tải ảnh quá nhiều, thử lại sau$/, "Too many image downloads, try again later"],
    [/^Không tìm thấy nội dung bài viết ở link này\..*$/, "Couldn't find an article at this link. Open it in your browser, copy it and paste it into the “Paste text” tab"],
    [/^Đang lấy trang…$/, "Fetching the page…"],
    [/^Đang cắt lấy nội dung chính…$/, "Extracting the article…"],
    [/^Đang tải ảnh (\d+)\/(\d+)…$/, "Downloading image $1/$2…"],
    [/^Đang đóng gói EPUB…$/, "Packing the EPUB…"],
    [/^bài viết, (\d+) ảnh$/, "article, $1 images"],
    [/^bài viết$/, "article"],
    // Bộ chuyển đổi
    [/^Chưa hỗ trợ \.([^ ]+) \(CBR là RAR — nén lại thành \.cbz\)$/, "Not supported: .$1 (CBR is RAR, repack it as .cbz)"],
    [/^Chưa hỗ trợ \.([^ ]+) \(Word: lưu thành \.html hoặc PDF rồi gửi\)$/, "Not supported: .$1 (Word: save as .html or PDF, then send)"],
    [/^Chưa hỗ trợ \.(.+)$/, "Not supported: .$1"],
    [/^File \.epub hỏng \(không phải ZIP\)$/, "Broken .epub file (not a ZIP)"],
    [/^File CBZ hỏng \(không phải ZIP\)$/, "Broken CBZ file (not a ZIP)"],
    [/^Trong CBZ không có ảnh nào$/, "No images inside the CBZ"],
    [/^File rỗng hoặc không đọc được$/, "Empty or unreadable file"],
    [/^File quá ngắn, không phải sách MOBI$/, "File too short to be a MOBI book"],
    [/^Không phải file MOBI\/AZW hợp lệ$/, "Not a valid MOBI/AZW file"],
    [/^File MOBI hỏng$/, "Broken MOBI file"],
    [/^Sách có DRM \(mua từ Kindle Store\).*$/, "This book has DRM (bought from the Kindle Store) and can't be converted. Only DRM-free MOBI/AZW files work"],
    [/^Không đọc được nội dung sách$/, "Couldn't read the book's content"],
    [/^PDF có mật khẩu — mở khóa trước rồi gửi$/, "The PDF is password-protected. Unlock it first"],
    [/^Không đọc được PDF \(file hỏng\?\)$/, "Couldn't read the PDF (broken file?)"],
    [/^PDF không có chữ \(bản scan\) — chọn chế độ Ảnh trang$/, "The PDF has no text (a scan). Choose Page images"],
    [/^Không có trang nào$/, "No pages"],
    [/^Không nén được ảnh$/, "Couldn't compress an image"],
    [/^Quá (\d+) MB sau (\d+) trang.*$/, "Over $1 MB after $2 pages. Split the file (or, for a text PDF, choose Text)"],
    [/^ảnh trang, (\d+) trang$/, "page images, $1 pages"],
    [/^chữ, (\d+) trang$/, "text, $1 pages"],
    [/^(\d+) trang$/, "$1 pages"],
  ];

  function tr(msg) {
    const s = String(msg ?? "");
    if (lang === "vi" || !s) return s;
    for (const [re, en] of MESSAGES) {
      if (re.test(s)) return s.replace(re, en);
    }
    return s;
  }

  function L(vi, en) {
    return lang === "en" ? en : vi;
  }

  /** Thay chữ trong HTML theo thuộc tính data-en*. Chỉ chạy khi đang dùng tiếng Anh. */
  function apply(root = document) {
    if (lang !== "en") return;
    root.querySelectorAll("[data-en]").forEach((el) => { el.textContent = el.dataset.en; });
    // data-en-html chỉ chứa HTML do chính trang này viết (không có dữ liệu người dùng)
    root.querySelectorAll("[data-en-html]").forEach((el) => { el.innerHTML = el.dataset.enHtml; });
    for (const attr of ["placeholder", "title", "aria-label", "content"]) {
      const key = "en" + attr.replace(/(^|-)(\w)/g, (_m, _d, c) => c.toUpperCase());
      root.querySelectorAll(`[data-en-${attr}]`).forEach((el) => el.setAttribute(attr, el.dataset[key]));
    }
  }

  function setLang(next) {
    if (!SUPPORTED.includes(next) || next === lang) return;
    try { localStorage.setItem("xl_lang", next); } catch { /* bỏ qua */ }
    const url = new URL(location.href);
    url.searchParams.delete("lang");
    location.replace(url.pathname + url.search + url.hash);
  }

  document.documentElement.lang = lang;
  if (lang === "en") {
    document.title = "Xteink Lover: send books to your Xteink e-reader from anywhere";
    // i18n.js nằm cuối <body>, trước app.js: HTML đã có đủ, dịch ngay để app.js đọc được chữ tiếng Anh
    apply();
  }

  window.XL_I18N = { lang, L, tr, apply, setLang };
})();

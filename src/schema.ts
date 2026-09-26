/**
 * Bảng D1, tạo và nâng cấp ngay trong Worker (người tự cài bằng nút Deploy không phải chạy migration tay).
 * MIGRATIONS chỉ được THÊM phần tử mới ở cuối, không sửa phần tử đã phát hành: phiên bản = số phần tử
 * đã chạy, lưu ở bảng schema_meta. Nên viết câu lệnh chạy lại được (IF NOT EXISTS / OR IGNORE); với
 * ALTER TABLE thì không được, nhưng ensureSchema tự xử lý khi hai isolate cùng nâng cấp (xem db.ts).
 */
export const MIGRATIONS: string[][] = [
  // v1 — tài khoản, phiên, sách, bộ đếm, thống kê dung lượng, hàng chờ xóa file
  [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL,
      pass_salt TEXT NOT NULL,
      pass_iter INTEGER NOT NULL,
      client_kdf TEXT NOT NULL,
      opds_key_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_login INTEGER NOT NULL DEFAULT 0
    )`,
    // recheck_fails: số lần nhập lại mật khẩu sai TRONG phiên này (phiên bị trộm chỉ đoán được vài lần)
    `CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      recheck_fails INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
    `CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at)`,
    `CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      size INTEGER NOT NULL,
      added TEXT NOT NULL,
      blob_key TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS books_user ON books(user_id, id)`,
    // Bộ đếm theo cửa sổ thời gian: đăng nhập sai, đăng ký, lượt gửi sách mỗi ngày
    `CREATE TABLE IF NOT EXISTS attempts (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      window_start INTEGER NOT NULL
    )`,
    // Trình duyệt đã từng đăng nhập đúng: không bị khóa theo bộ đếm chung của tên đăng nhập
    // (người ngoài dò mật khẩu từ nhiều IP không khóa lây được chủ tài khoản)
    `CREATE TABLE IF NOT EXISTS devices (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id)`,
    // File KV cần xóa sau (xóa tài khoản, xóa sách). Vẫn tính vào dung lượng cho tới khi thật sự xóa khỏi KV.
    `CREATE TABLE IF NOT EXISTS pending_deletes (
      blob_key TEXT PRIMARY KEY,
      size INTEGER NOT NULL DEFAULT 0,
      queued_at INTEGER NOT NULL
    )`,
    // Tổng byte đang nằm trong KV = sách + file chờ xóa. Trigger giữ số này đúng theo từng dòng thêm/xóa,
    // nên xóa trùng hay xóa song song cũng không trừ hai lần.
    `CREATE TABLE IF NOT EXISTS stats (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    )`,
    `INSERT OR IGNORE INTO stats (key, value)
      SELECT 'bytes', (SELECT COALESCE(SUM(size), 0) FROM books) + (SELECT COALESCE(SUM(size), 0) FROM pending_deletes)`,
    `CREATE TRIGGER IF NOT EXISTS books_bytes_ins AFTER INSERT ON books
      BEGIN UPDATE stats SET value = value + NEW.size WHERE key = 'bytes'; END`,
    `CREATE TRIGGER IF NOT EXISTS books_bytes_del AFTER DELETE ON books
      BEGIN UPDATE stats SET value = MAX(value - OLD.size, 0) WHERE key = 'bytes'; END`,
    `CREATE TRIGGER IF NOT EXISTS pending_bytes_ins AFTER INSERT ON pending_deletes
      BEGIN UPDATE stats SET value = value + NEW.size WHERE key = 'bytes'; END`,
    `CREATE TRIGGER IF NOT EXISTS pending_bytes_del AFTER DELETE ON pending_deletes
      BEGIN UPDATE stats SET value = MAX(value - OLD.size, 0) WHERE key = 'bytes'; END`,
  ],
  // v2 — đăng nhập bằng Google. Chỉ lưu mã định danh (sub), không lưu email. Mỗi tài khoản tối đa một Google.
  // Tài khoản chỉ dùng Google: pass_iter = 0, pass_hash rỗng (không đăng nhập bằng mật khẩu được).
  [
    `CREATE TABLE IF NOT EXISTS identities (
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (provider, subject)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS identities_user ON identities(user_id, provider)`,
    // Google đã xác nhận, đang chờ người dùng chọn tên đăng nhập (token ngẫu nhiên trong cookie, ở đây lưu hash)
    `CREATE TABLE IF NOT EXISTS oauth_pending (
      token_hash TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      suggest TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
  ],
  // v3 — mã cho ứng dụng (plugin Obsidian…): Bearer token, lưu SHA-256, tối đa vài mã mỗi người
  [
    `CREATE TABLE IF NOT EXISTS app_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS app_tokens_user ON app_tokens(user_id)`,
  ],
  // v4 — đồng bộ tiến độ đọc (giao thức KOSync của KOReader, CrossPoint cũng dùng).
  // Mã đồng bộ: mỗi máy một mã 20 chữ số; máy gửi md5(mã gõ vào) nên lưu 3 bộ xác minh cho 3 cách gõ, có salt riêng.
  // Tiến độ: một dòng mỗi (người, sách), ghi đè sau cùng thắng; số sách đếm bằng trigger để khỏi COUNT(*).
  [
    `CREATE TABLE IF NOT EXISTS sync_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      salt TEXT NOT NULL,
      v_plain TEXT NOT NULL,
      v_space TEXT NOT NULL,
      v_dash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS sync_keys_user ON sync_keys(user_id)`,
    // updated_at tính bằng GIÂY (trả thẳng làm timestamp của KOSync)
    `CREATE TABLE IF NOT EXISTS sync_progress (
      user_id TEXT NOT NULL,
      document TEXT NOT NULL,
      progress TEXT NOT NULL,
      percentage REAL NOT NULL,
      device TEXT NOT NULL,
      device_id TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, document)
    )`,
    `CREATE INDEX IF NOT EXISTS sync_progress_user_time ON sync_progress(user_id, updated_at)`,
    `CREATE TABLE IF NOT EXISTS sync_counts (
      user_id TEXT PRIMARY KEY,
      n INTEGER NOT NULL
    )`,
    `CREATE TRIGGER IF NOT EXISTS sync_count_ins AFTER INSERT ON sync_progress
      BEGIN
        INSERT OR IGNORE INTO sync_counts (user_id, n) VALUES (NEW.user_id, 0);
        UPDATE sync_counts SET n = n + 1 WHERE user_id = NEW.user_id;
      END`,
    `CREATE TRIGGER IF NOT EXISTS sync_count_del AFTER DELETE ON sync_progress
      BEGIN UPDATE sync_counts SET n = MAX(n - 1, 0) WHERE user_id = OLD.user_id; END`,
  ],
];

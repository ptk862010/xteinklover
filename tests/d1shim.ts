/**
 * D1 giả trên node:sqlite (SQLite thật, trong RAM) — để test đúng các câu SQL của db.ts mà không cần wrangler.
 * Dùng chung lớp SqliteD1 với bản tự chạy (node/d1.ts).
 */
import { SqliteD1 } from "../node/d1";
import { MIGRATIONS } from "../src/schema";

export { SqliteD1 as FakeD1 };
type FakeD1 = SqliteD1;

/** DB mới với toàn bộ migration, và ép kiểu sang D1Database cho các hàm trong db.ts. */
export function freshDb(): { fake: FakeD1; db: D1Database } {
  const fake = new SqliteD1();
  for (const group of MIGRATIONS) for (const sql of group) fake.raw.prepare(sql).run();
  return { fake, db: fake as unknown as D1Database };
}

export function addUser(fake: FakeD1, id: string, username: string, lastLoginMs: number): void {
  fake.raw
    .prepare(
      "INSERT INTO users (id, username, pass_hash, pass_salt, pass_iter, client_kdf, opds_key_hash, created_at, last_login) VALUES (?, ?, 'h', 's', 2000, 'k', 'o', '2026-01-01', ?)",
    )
    .run(id, username, lastLoginMs);
}

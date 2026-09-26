/**
 * D1 giả trên node:sqlite (SQLite thật, trong RAM) — để test đúng các câu SQL của db.ts mà không cần wrangler.
 * Chỉ đủ phần API mà db.ts dùng: prepare().bind().first()/all()/run(), batch() (một transaction), exec().
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { MIGRATIONS } from "../src/schema";

class Stmt {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: SQLInputValue[] = [],
  ) {}
  bind(...params: unknown[]): Stmt {
    return new Stmt(this.db, this.sql, params.map((p) => (p === undefined ? null : (p as SQLInputValue))));
  }
  async first<T>(col?: string): Promise<T | null> {
    return this.firstSync<T>(col);
  }
  firstSync<T>(col?: string): T | null {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : { ...row }) as T;
  }
  async all<T>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
    return this.allSync<T>();
  }
  allSync<T>(): { results: T[]; success: true; meta: { changes: number } } {
    const st = this.db.prepare(this.sql);
    if (/^\s*(select|with)\b|\breturning\b/i.test(this.sql)) {
      const rows = st.all(...this.params) as Record<string, unknown>[];
      return { results: rows.map((r) => ({ ...r }) as T), success: true, meta: { changes: 0 } };
    }
    const r = st.run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes) } };
  }
  async run(): Promise<{ results: unknown[]; success: true; meta: { changes: number } }> {
    return this.allSync();
  }
}

export class FakeD1 {
  readonly raw = new DatabaseSync(":memory:");
  prepare(sql: string): Stmt {
    return new Stmt(this.raw, sql);
  }
  async batch<T>(stmts: Stmt[]): Promise<{ results: T[]; success: true; meta: { changes: number } }[]> {
    this.raw.exec("BEGIN");
    try {
      const out = stmts.map((s) => s.allSync<T>());
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }
  async exec(sql: string): Promise<void> {
    this.raw.exec(sql);
  }
}

/** DB mới với toàn bộ migration, và ép kiểu sang D1Database cho các hàm trong db.ts. */
export function freshDb(): { fake: FakeD1; db: D1Database } {
  const fake = new FakeD1();
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

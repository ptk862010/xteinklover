/**
 * D1 chạy trên node:sqlite (SQLite thật). Dùng cho bản tự chạy (Docker / Node) và cho test.
 * Chỉ đủ phần API mà db.ts dùng: prepare().bind().first()/all()/run(), batch() (một transaction), exec().
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

type D1Result<T> = { results: T[]; success: true; meta: { changes: number } };

/** D1 nhận ArrayBuffer cho cột BLOB, node:sqlite chỉ nhận TypedArray: đổi trước khi bind. */
function toSql(p: unknown): SQLInputValue {
  if (p === undefined) return null;
  if (p instanceof ArrayBuffer) return new Uint8Array(p);
  return p as SQLInputValue;
}

export class SqliteStmt {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: SQLInputValue[] = [],
  ) {}
  bind(...params: unknown[]): SqliteStmt {
    return new SqliteStmt(this.db, this.sql, params.map(toSql));
  }
  async first<T>(col?: string): Promise<T | null> {
    return this.firstSync<T>(col);
  }
  firstSync<T>(col?: string): T | null {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : { ...row }) as T;
  }
  async all<T>(): Promise<D1Result<T>> {
    return this.allSync<T>();
  }
  allSync<T>(): D1Result<T> {
    const st = this.db.prepare(this.sql);
    // Câu trả về cột (SELECT, WITH, PRAGMA, … RETURNING) thì lấy dòng; còn lại thì chạy và đếm số dòng đổi
    if (st.columns().length > 0) {
      const rows = st.all(...this.params) as Record<string, unknown>[];
      return { results: rows.map((r) => ({ ...r }) as T), success: true, meta: { changes: 0 } };
    }
    const r = st.run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes) } };
  }
  async run(): Promise<D1Result<unknown>> {
    return this.allSync();
  }
}

export class SqliteD1 {
  readonly raw: DatabaseSync;
  /** path = ":memory:" cho test; file thật thì bật WAL để đọc không chặn ghi. */
  constructor(path = ":memory:") {
    this.raw = new DatabaseSync(path);
    if (path !== ":memory:") {
      this.raw.exec("PRAGMA journal_mode = WAL");
      this.raw.exec("PRAGMA synchronous = NORMAL");
      this.raw.exec("PRAGMA busy_timeout = 5000");
    }
  }
  prepare(sql: string): SqliteStmt {
    return new SqliteStmt(this.raw, sql);
  }
  async batch<T>(stmts: SqliteStmt[]): Promise<D1Result<T>[]> {
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
  close(): void {
    this.raw.close();
  }
  /** Ép kiểu sang D1Database cho các hàm trong src/. */
  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}

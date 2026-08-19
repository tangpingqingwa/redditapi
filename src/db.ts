import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

export function openDatabase(path: string): SqliteDatabase {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  if (path !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  migrate(db);
  return db;
}

export function migrate(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const appliedRows = db.prepare("SELECT id FROM schema_migrations").all() as Array<{
    id: string;
  }>;
  const applied = new Set(appliedRows.map((row) => row.id));

  const insert = db.prepare(
    "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
  );
  const apply = db.transaction((name: string, sql: string) => {
    db.exec(sql);
    insert.run(name, new Date().toISOString());
  });

  for (const name of files) {
    if (applied.has(name)) {
      continue;
    }
    apply(name, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }
}

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_FREE_CREDITS, DEFAULT_FREE_RPM } from "../config.js";
import type { SqliteDatabase } from "../db.js";
import type { KeyPrefix, KeyRecord } from "../types.js";

const KEY_PREFIXES = ["rk_live", "rk_test"] as const;

type KeyRow = {
  id: string;
  prefix: string;
  hash: string;
  plan: string;
  credits: number;
  rpm: number;
  created_at: string;
};

export function parseKeyPrefix(secret: string): KeyPrefix | null {
  for (const prefix of KEY_PREFIXES) {
    if (secret.startsWith(`${prefix}_`) && secret.length > prefix.length + 1) {
      return prefix;
    }
  }
  return null;
}

export function hashKey(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function createKeySecret(prefix: KeyPrefix): string {
  return `${prefix}_${randomBytes(24).toString("hex")}`;
}

export function insertKeyFromSecret(
  db: SqliteDatabase,
  secret: string,
  options: { plan?: string; credits?: number; rpm?: number } = {},
): KeyRecord {
  const prefix = parseKeyPrefix(secret);
  if (prefix === null) {
    throw new Error("API key must start with rk_live_ or rk_test_");
  }

  const record: KeyRecord = {
    id: `key_${randomUUID()}`,
    prefix,
    hash: hashKey(secret),
    plan: options.plan ?? "free",
    credits: options.credits ?? DEFAULT_FREE_CREDITS,
    rpm: options.rpm ?? DEFAULT_FREE_RPM,
    createdAt: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO keys (id, prefix, hash, plan, credits, rpm, created_at)
     VALUES (@id, @prefix, @hash, @plan, @credits, @rpm, @createdAt)`,
  ).run(record);

  return record;
}

export function findKeyBySecret(db: SqliteDatabase, secret: string): KeyRecord | null {
  if (parseKeyPrefix(secret) === null) {
    return null;
  }
  const row = db
    .prepare(
      `SELECT id, prefix, hash, plan, credits, rpm, created_at
       FROM keys WHERE hash = ?`,
    )
    .get(hashKey(secret));
  if (row === undefined) {
    return null;
  }
  return rowToRecord(row as KeyRow);
}

export function maybeBootstrapKey(db: SqliteDatabase, secret?: string): void {
  if (secret === undefined) {
    return;
  }
  const count = db.prepare("SELECT COUNT(*) AS n FROM keys").get() as { n: number };
  if (count.n > 0) {
    return;
  }
  insertKeyFromSecret(db, secret);
}

function rowToRecord(row: KeyRow): KeyRecord {
  if (row.prefix !== "rk_live" && row.prefix !== "rk_test") {
    throw new Error(`Unknown key prefix in database: ${row.prefix}`);
  }
  return {
    id: row.id,
    prefix: row.prefix,
    hash: row.hash,
    plan: row.plan,
    credits: row.credits,
    rpm: row.rpm,
    createdAt: row.created_at,
  };
}

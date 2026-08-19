import type { FastifyReply, FastifyRequest } from "fastify";
import { findKeyBySecret } from "../billing/keys.js";
import type { SqliteDatabase } from "../db.js";
import type { KeyRecord } from "../types.js";
import { sendErr } from "./envelope.js";

export type AuthedRequest = FastifyRequest & { apiKey: KeyRecord };

export function readBearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function requireKey(
  db: SqliteDatabase,
  request: FastifyRequest,
  reply: FastifyReply,
  requestId: string,
): KeyRecord | null {
  const secret = readBearerToken(request.headers.authorization);
  if (secret === null) {
    sendErr(reply, "unauthorized", requestId);
    return null;
  }
  const key = findKeyBySecret(db, secret);
  if (key === null) {
    sendErr(reply, "unauthorized", requestId);
    return null;
  }
  (request as AuthedRequest).apiKey = key;
  return key;
}

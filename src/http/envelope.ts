import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { Err, ErrorCode, Ok, OkMeta } from "../types.js";

export const HTTP_STATUS_BY_ERROR: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  payment_required: 402,
  subreddit_quarantined: 403,
  subreddit_private: 403,
  not_found: 404,
  rate_limited: 429,
  upstream_blocked: 503,
  internal: 500,
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  "rate_limited",
  "upstream_blocked",
  "internal",
]);

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  invalid_request: "Bad request.",
  unauthorized: "Missing or invalid API key.",
  payment_required: "Out of credits.",
  not_found: "Not found.",
  subreddit_quarantined: "This subreddit is quarantined.",
  subreddit_private: "This subreddit is private.",
  rate_limited: "Rate limit exceeded.",
  upstream_blocked: "Upstream blocked the request.",
  internal: "Internal error.",
};

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE.has(code);
}

export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

export function buildOk<T>(
  data: T,
  meta: Partial<OkMeta> & { requestId: string },
): Ok<T> {
  return {
    data,
    meta: {
      cached: meta.cached ?? false,
      creditsCharged: meta.creditsCharged ?? 0,
      requestId: meta.requestId,
      upstreamMs: meta.upstreamMs ?? 0,
      ...(meta.truncated === undefined ? {} : { truncated: meta.truncated }),
    },
  };
}

export function buildErr(code: ErrorCode, requestId: string, message?: string): Err {
  return {
    error: {
      code,
      message: message ?? DEFAULT_MESSAGES[code],
      retryable: isRetryable(code),
    },
    meta: { creditsCharged: 0, requestId },
  };
}

export function sendOk<T>(
  reply: FastifyReply,
  data: T,
  meta: Partial<OkMeta> & { requestId: string },
  status = 200,
): FastifyReply {
  return reply.status(status).send(buildOk(data, meta));
}

export function sendErr(
  reply: FastifyReply,
  code: ErrorCode,
  requestId: string,
  message?: string,
): FastifyReply {
  return reply.status(HTTP_STATUS_BY_ERROR[code]).send(buildErr(code, requestId, message));
}

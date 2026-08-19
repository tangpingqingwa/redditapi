import type { FastifyPluginAsync } from "fastify";
import { chargeCredits } from "../../billing/keys.js";
import {
  DEFAULT_MAX_COMMENTS,
  MAX_COMMENTS_CAP,
  getPost,
  unrollThread,
  type RedditAdapter,
} from "../../core/thread.js";
import type { SqliteDatabase } from "../../db.js";
import type { ThreadSort } from "../../types.js";
import { requireKey } from "../auth.js";
import { newRequestId, sendErr, sendOk } from "../envelope.js";

export const THREADS_BY_URL_PATH = "/v1/threads/by-url" as const;
export const POST_BY_ID_PATH = "/v1/posts/:id" as const;

const SORTS = new Set<ThreadSort>(["best", "new", "top", "qa"]);

export type ThreadRoutesOptions = {
  db: SqliteDatabase;
  reddit: RedditAdapter;
};

export const threadRoutes: FastifyPluginAsync<ThreadRoutesOptions> = async (app, opts) => {
  app.get(THREADS_BY_URL_PATH, async (request, reply) => {
    const requestId = newRequestId();
    const key = requireKey(opts.db, request, reply, requestId);
    if (key === null) {
      return reply;
    }

    const query = request.query as Record<string, unknown>;
    const url = singleParam(query.url);
    if (url === undefined || url.trim() === "") {
      return sendErr(reply, "invalid_request", requestId, "url is required.");
    }

    const sortRaw = singleParam(query.sort) ?? "best";
    if (!SORTS.has(sortRaw as ThreadSort)) {
      return sendErr(reply, "invalid_request", requestId, "sort must be best, new, top, or qa.");
    }

    const maxComments = parseMaxComments(singleParam(query.max_comments));
    if (maxComments === null) {
      return sendErr(
        reply,
        "invalid_request",
        requestId,
        `max_comments must be an integer 1-${MAX_COMMENTS_CAP}.`,
      );
    }

    const result = await unrollThread(opts.reddit, {
      url,
      maxComments,
      sort: sortRaw as ThreadSort,
    });
    if (!result.ok) {
      return sendErr(reply, result.code, requestId, result.message);
    }

    const charged = chargeCredits(opts.db, key, result.credits, THREADS_BY_URL_PATH, false);
    if (!charged.ok) {
      return sendErr(reply, "payment_required", requestId);
    }

    return sendOk(reply, result.data, {
      requestId,
      creditsCharged: result.credits,
      cached: false,
      upstreamMs: result.upstreamMs,
      truncated: result.truncated,
    });
  });

  app.get<{ Params: { id: string } }>(POST_BY_ID_PATH, async (request, reply) => {
    const requestId = newRequestId();
    const key = requireKey(opts.db, request, reply, requestId);
    if (key === null) {
      return reply;
    }

    const result = await getPost(opts.reddit, request.params.id);
    if (!result.ok) {
      return sendErr(reply, result.code, requestId, result.message);
    }

    const charged = chargeCredits(opts.db, key, result.credits, "/v1/posts/{id}", false);
    if (!charged.ok) {
      return sendErr(reply, "payment_required", requestId);
    }

    return sendOk(reply, result.data, {
      requestId,
      creditsCharged: result.credits,
      cached: false,
      upstreamMs: result.upstreamMs,
    });
  });
};

function singleParam(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
}

function parseMaxComments(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") {
    return DEFAULT_MAX_COMMENTS;
  }
  if (!/^[0-9]+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_COMMENTS_CAP) {
    return null;
  }
  return value;
}

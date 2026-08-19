import type { FastifyPluginAsync } from "fastify";
import { chargeCredits } from "../../billing/keys.js";
import { searchReddit } from "../../core/search.js";
import type { RedditAdapter } from "../../core/thread.js";
import type { SqliteDatabase } from "../../db.js";
import { requireKey } from "../auth.js";
import { newRequestId, sendErr, sendOk } from "../envelope.js";

export const SEARCH_PATH = "/v1/search" as const;

export type SearchRoutesOptions = {
  db: SqliteDatabase;
  reddit: RedditAdapter;
};

type SearchQuerystring = {
  q?: string;
  sub?: string;
  sort?: string;
  cursor?: string;
  limit?: string;
};

export const searchRoutes: FastifyPluginAsync<SearchRoutesOptions> = async (app, opts) => {
  app.get<{ Querystring: SearchQuerystring }>(SEARCH_PATH, async (request, reply) => {
    const requestId = newRequestId();
    const key = requireKey(opts.db, request, reply, requestId);
    if (key === null) {
      return reply;
    }

    const result = await searchReddit(opts.reddit, {
      q: singleParam(request.query.q) ?? "",
      sub: singleParam(request.query.sub),
      sort: singleParam(request.query.sort),
      cursor: singleParam(request.query.cursor),
      limit: singleParam(request.query.limit),
    });
    if (!result.ok) {
      return sendErr(reply, result.code, requestId, result.message);
    }

    if (result.credits > 0) {
      const charged = chargeCredits(opts.db, key, result.credits, SEARCH_PATH, false);
      if (!charged.ok) {
        return sendErr(reply, "payment_required", requestId);
      }
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

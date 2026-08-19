import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { chargeCredits } from "../../billing/keys.js";
import { getLatest, listSubreddit } from "../../core/listings.js";
import type { RedditAdapter } from "../../core/thread.js";
import type { SqliteDatabase } from "../../db.js";
import type { ListingSort } from "../../types.js";
import { requireKey } from "../auth.js";
import { newRequestId, sendErr, sendOk } from "../envelope.js";

export const LISTING_HOT_PATH = "/v1/r/:sub/hot" as const;
export const LISTING_NEW_PATH = "/v1/r/:sub/new" as const;
export const LISTING_TOP_PATH = "/v1/r/:sub/top" as const;
export const LATEST_PATH = "/v1/r/:sub/latest" as const;

export type ListingRoutesOptions = {
  db: SqliteDatabase;
  reddit: RedditAdapter;
};

type ListingParams = {
  sub: string;
};

type ListingQuerystring = {
  t?: string;
  cursor?: string;
  limit?: string;
};

export const listingRoutes: FastifyPluginAsync<ListingRoutesOptions> = async (app, opts) => {
  registerListing(app, opts, LISTING_HOT_PATH, "hot");
  registerListing(app, opts, LISTING_NEW_PATH, "new");
  registerListing(app, opts, LISTING_TOP_PATH, "top");

  app.get<{ Params: ListingParams }>(LATEST_PATH, async (request, reply) => {
    const requestId = newRequestId();
    const key = requireKey(opts.db, request, reply, requestId);
    if (key === null) {
      return reply;
    }

    const result = await getLatest(opts.reddit, { subreddit: request.params.sub });
    if (!result.ok) {
      return sendErr(reply, result.code, requestId, result.message);
    }

    return sendOk(reply, result.data, {
      requestId,
      creditsCharged: 0,
      cached: false,
      upstreamMs: result.upstreamMs,
    });
  });
};

function registerListing(
  app: FastifyInstance,
  opts: ListingRoutesOptions,
  path: string,
  sort: ListingSort,
): void {
  app.get<{ Params: ListingParams; Querystring: ListingQuerystring }>(path, async (request, reply) => {
    const requestId = newRequestId();
    const key = requireKey(opts.db, request, reply, requestId);
    if (key === null) {
      return reply;
    }

    const result = await listSubreddit(opts.reddit, {
      subreddit: request.params.sub,
      sort,
      t: singleParam(request.query.t),
      cursor: singleParam(request.query.cursor),
      limit: singleParam(request.query.limit),
    });
    if (!result.ok) {
      return sendErr(reply, result.code, requestId, result.message);
    }

    const charged = chargeCredits(opts.db, key, result.credits, path, false);
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
}

function singleParam(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
}

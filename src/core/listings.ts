import type { ErrorCode, ListingData, ListingKind, ListingSort, RedditPost, TopWindow } from "../types.js";
import { mapRedditPost, type RedditAdapter } from "./thread.js";

export const LISTING_DEFAULT_LIMIT = 25;
export const LISTING_MIN_LIMIT = 1;
export const LISTING_MAX_LIMIT = 100;
export const LATEST_LIMIT = 25;
export const LISTING_CREDIT_COST = 1;

const SUBREDDIT_NAME = /^[A-Za-z0-9_]{2,21}$/;
const CURSOR_TOKEN = /^t3_[A-Za-z0-9]+$/;
const TOP_WINDOWS = new Set<TopWindow>(["day", "week", "month", "year", "all"]);

export type ListingQuery = {
  subreddit: string;
  sort: ListingSort;
  t?: string;
  cursor?: string;
  limit?: string;
};

export type LatestQuery = {
  subreddit: string;
};

export type ListingOk = {
  ok: true;
  data: ListingData;
  credits: 0 | 1;
  upstreamMs: number;
};

export type ListingErr = {
  ok: false;
  code: ErrorCode;
  message: string;
};

export type ListingResult = ListingOk | ListingErr;

export function normalizeSubreddit(raw: string): string | null {
  const trimmed = raw.trim().replace(/^r\//i, "");
  if (!SUBREDDIT_NAME.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export async function listSubreddit(adapter: RedditAdapter, query: ListingQuery): Promise<ListingResult> {
  const parsed = parseListingQuery(query);
  if (!parsed.ok) {
    return parsed;
  }
  return fetchMappedListing(adapter, parsed, LISTING_CREDIT_COST);
}

export async function getLatest(adapter: RedditAdapter, query: LatestQuery): Promise<ListingResult> {
  const subreddit = normalizeSubreddit(query.subreddit);
  if (subreddit === null) {
    return fail("invalid_request", "subreddit must be a public r/ name.");
  }
  return fetchMappedListing(
    adapter,
    {
      ok: true,
      subreddit,
      sort: "latest",
      t: undefined,
      cursor: undefined,
      limit: LATEST_LIMIT,
    },
    0,
  );
}

type ParsedListing = {
  ok: true;
  subreddit: string;
  sort: ListingKind;
  t: TopWindow | undefined;
  cursor: string | undefined;
  limit: number;
};

function parseListingQuery(query: ListingQuery): ParsedListing | ListingErr {
  const subreddit = normalizeSubreddit(query.subreddit);
  if (subreddit === null) {
    return fail("invalid_request", "subreddit must be a public r/ name.");
  }

  const tRaw = trimToUndefined(query.t);
  let t: TopWindow | undefined;
  if (query.sort === "top") {
    t = (tRaw ?? "day") as TopWindow;
    if (!TOP_WINDOWS.has(t)) {
      return fail("invalid_request", "t must be day, week, month, year, or all.");
    }
  } else if (tRaw !== undefined) {
    return fail("invalid_request", "t is only valid on /top.");
  }

  const cursor = trimToUndefined(query.cursor);
  if (cursor !== undefined && !CURSOR_TOKEN.test(cursor)) {
    return fail("invalid_request", "cursor is not a valid page token.");
  }

  const limit = parseLimit(query.limit);
  if (limit === null) {
    return fail("invalid_request", `limit must be an integer ${LISTING_MIN_LIMIT}-${LISTING_MAX_LIMIT}.`);
  }

  return { ok: true, subreddit, sort: query.sort, t, cursor, limit };
}

async function fetchMappedListing(
  adapter: RedditAdapter,
  parsed: ParsedListing,
  credits: 0 | 1,
): Promise<ListingResult> {
  const started = performance.now();
  const fetched = await adapter.fetchListing({
    subreddit: parsed.subreddit,
    sort: parsed.sort,
    t: parsed.t,
    cursor: parsed.cursor,
    limit: parsed.limit,
  });
  if (!fetched.ok) {
    return fail(fetched.code, fetched.message ?? defaultMessage(fetched.code));
  }

  const mapped = mapListingPayload(fetched.listing, parsed);
  if (!mapped.ok) {
    return mapped;
  }

  const data =
    parsed.sort === "latest" ? { ...mapped.data, nextCursor: null } : mapped.data;

  return {
    ok: true,
    data,
    credits,
    upstreamMs: Math.max(0, Math.round(performance.now() - started)),
  };
}

function mapListingPayload(
  listing: unknown,
  parsed: ParsedListing,
): { ok: true; data: ListingData } | ListingErr {
  const record = asRecord(listing);
  if (record === null) {
    return fail("upstream_blocked", "Unexpected listing payload.");
  }
  const data = asRecord(record.data) ?? record;
  const children = Array.isArray(data.children) ? data.children : [];
  const posts: RedditPost[] = [];
  for (const child of children) {
    const thing = asRecord(child);
    if (thing === null || thing.kind !== "t3") {
      continue;
    }
    const postData = asRecord(thing.data);
    if (postData === null) {
      continue;
    }
    posts.push(mapRedditPost(postData));
  }

  const after = typeof data.after === "string" && data.after !== "" ? data.after : null;
  return {
    ok: true,
    data: {
      subreddit: parsed.subreddit,
      sort: parsed.sort,
      t: parsed.t ?? null,
      posts,
      nextCursor: after,
    },
  };
}

function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") {
    return LISTING_DEFAULT_LIMIT;
  }
  if (!/^[0-9]+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < LISTING_MIN_LIMIT || value > LISTING_MAX_LIMIT) {
    return null;
  }
  return value;
}

function defaultMessage(code: ErrorCode): string {
  switch (code) {
    case "not_found":
      return "Not found.";
    case "subreddit_private":
      return "This subreddit is private.";
    case "subreddit_quarantined":
      return "This subreddit is quarantined.";
    default:
      return "Bad request.";
  }
}

function fail(code: ErrorCode, message: string): ListingErr {
  return { ok: false, code, message };
}

function trimToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

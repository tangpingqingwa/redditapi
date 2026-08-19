import type { ErrorCode, RedditPost, SearchData, SearchSort } from "../types.js";
import { normalizeSubreddit } from "./listings.js";
import { mapRedditPost, type RedditAdapter } from "./thread.js";

export const SEARCH_DEFAULT_LIMIT = 25;
export const SEARCH_MIN_LIMIT = 1;
export const SEARCH_MAX_LIMIT = 100;
export const SEARCH_CREDIT_COST = 1;

const CURSOR_TOKEN = /^t3_[A-Za-z0-9]+$/;
const SEARCH_SORTS = new Set<SearchSort>(["relevance", "hot", "top", "new", "comments"]);

export type SearchQuery = {
  q: string;
  sub?: string;
  sort?: string;
  cursor?: string;
  limit?: string;
};

export type SearchOk = {
  ok: true;
  data: SearchData;
  credits: 0 | 1;
  upstreamMs: number;
};

export type SearchErr = {
  ok: false;
  code: ErrorCode;
  message: string;
};

export type SearchResult = SearchOk | SearchErr;

export function parseSearchQuery(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }
  const q = raw.trim().replace(/\s+/g, " ");
  return q === "" ? null : q;
}

export async function searchReddit(adapter: RedditAdapter, query: SearchQuery): Promise<SearchResult> {
  const parsed = parseSearchInput(query);
  if (!parsed.ok) {
    return parsed;
  }

  const started = performance.now();
  const fetched = await adapter.fetchSearch({
    q: parsed.q,
    subreddit: parsed.subreddit,
    sort: parsed.sort,
    cursor: parsed.cursor,
    limit: parsed.limit,
  });
  if (!fetched.ok) {
    return fail(fetched.code, fetched.message ?? defaultMessage(fetched.code));
  }

  const mapped = mapSearchPayload(fetched.listing, parsed);
  if (!mapped.ok) {
    return mapped;
  }

  return {
    ok: true,
    data: mapped.data,
    credits: mapped.data.posts.length === 0 ? 0 : SEARCH_CREDIT_COST,
    upstreamMs: Math.max(0, Math.round(performance.now() - started)),
  };
}

type ParsedSearch = {
  ok: true;
  q: string;
  subreddit: string | undefined;
  sort: SearchSort;
  cursor: string | undefined;
  limit: number;
};

function parseSearchInput(query: SearchQuery): ParsedSearch | SearchErr {
  const q = parseSearchQuery(query.q);
  if (q === null) {
    return fail("invalid_request", "q is required.");
  }

  const subRaw = trimToUndefined(query.sub);
  let subreddit: string | undefined;
  if (subRaw !== undefined) {
    const normalized = normalizeSubreddit(subRaw);
    if (normalized === null) {
      return fail("invalid_request", "sub must be a public r/ name.");
    }
    subreddit = normalized;
  }

  const sortRaw = trimToUndefined(query.sort) ?? "relevance";
  if (!SEARCH_SORTS.has(sortRaw as SearchSort)) {
    return fail("invalid_request", "sort must be relevance, hot, top, new, or comments.");
  }

  const cursor = trimToUndefined(query.cursor);
  if (cursor !== undefined && !CURSOR_TOKEN.test(cursor)) {
    return fail("invalid_request", "cursor is not a valid page token.");
  }

  const limit = parseLimit(query.limit);
  if (limit === null) {
    return fail("invalid_request", `limit must be an integer ${SEARCH_MIN_LIMIT}-${SEARCH_MAX_LIMIT}.`);
  }

  return { ok: true, q, subreddit, sort: sortRaw as SearchSort, cursor, limit };
}

function mapSearchPayload(
  listing: unknown,
  parsed: ParsedSearch,
): { ok: true; data: SearchData } | SearchErr {
  const record = asRecord(listing);
  if (record === null) {
    return fail("upstream_blocked", "Unexpected search payload.");
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
      q: parsed.q,
      subreddit: parsed.subreddit ?? null,
      sort: parsed.sort,
      posts,
      nextCursor: after,
    },
  };
}

function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") {
    return SEARCH_DEFAULT_LIMIT;
  }
  if (!/^[0-9]+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < SEARCH_MIN_LIMIT || value > SEARCH_MAX_LIMIT) {
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

function fail(code: ErrorCode, message: string): SearchErr {
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

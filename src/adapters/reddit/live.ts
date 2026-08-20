import { resolveUserAgent } from "../../config.js";
import type {
  AdapterFailure,
  AdapterListingOk,
  AdapterMoreOk,
  AdapterThreadOk,
  ListingFetchInput,
  RedditAdapter,
  SearchFetchInput,
  ThreadRef,
} from "../../core/thread.js";
import type { ErrorCode, ThreadSort } from "../../types.js";

export const DEFAULT_REDDIT_ORIGIN = "https://old.reddit.com";
export const LIVE_TIMEOUT_MS = 15_000;
export const LIVE_CONCURRENCY = 4;

export type LiveFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

export type LiveRedditOptions = {
  fetch?: LiveFetch;
  origin?: string;
  userAgent?: string;
  timeoutMs?: number;
  concurrency?: number;
};

export function createLiveRedditAdapter(options: LiveRedditOptions = {}): RedditAdapter {
  const origin = (options.origin ?? DEFAULT_REDDIT_ORIGIN).replace(/\/+$/, "");
  const userAgent = options.userAgent ?? resolveUserAgent();
  const timeoutMs = options.timeoutMs ?? LIVE_TIMEOUT_MS;
  const fetchFn = options.fetch ?? defaultFetch;
  const limit = createLimiter(options.concurrency ?? LIVE_CONCURRENCY);

  return {
    async fetchThread(ref: ThreadRef, sort: ThreadSort): Promise<AdapterThreadOk | AdapterFailure> {
      const params = new URLSearchParams({ raw_json: "1", sort, limit: "500" });
      const result = await redditGet(limit, fetchFn, `${origin}${threadPath(ref)}.json?${params}`, userAgent, timeoutMs);
      if (!result.ok) {
        return result;
      }
      if (!Array.isArray(result.body)) {
        return fail("upstream_blocked", "Unexpected thread payload.");
      }
      return { ok: true, listing: result.body };
    },

    async fetchMoreChildren(
      linkId: string,
      children: string[],
      sort: ThreadSort,
    ): Promise<AdapterMoreOk | AdapterFailure> {
      const ids = children.map(stripThingPrefix).filter((id) => id !== "");
      if (ids.length === 0) {
        return { ok: true, things: [] };
      }
      const params = new URLSearchParams({
        api_type: "json",
        raw_json: "1",
        link_id: fullname(linkId, "t3"),
        children: ids.join(","),
        sort,
      });
      const result = await redditGet(
        limit,
        fetchFn,
        `${origin}/api/morechildren?${params}`,
        userAgent,
        timeoutMs,
      );
      if (!result.ok) {
        return result;
      }
      return { ok: true, things: moreThings(result.body) };
    },

    async fetchListing(input: ListingFetchInput): Promise<AdapterListingOk | AdapterFailure> {
      const sortPath = input.sort === "latest" ? "new" : input.sort;
      const params = new URLSearchParams({ raw_json: "1", limit: String(input.limit) });
      if (input.cursor !== undefined) {
        params.set("after", input.cursor);
      }
      if (input.sort === "top") {
        params.set("t", input.t ?? "day");
      }
      const result = await redditGet(
        limit,
        fetchFn,
        `${origin}/r/${encodeURIComponent(input.subreddit)}/${sortPath}.json?${params}`,
        userAgent,
        timeoutMs,
      );
      if (!result.ok) {
        return result;
      }
      if (asRecord(result.body) === null) {
        return fail("upstream_blocked", "Unexpected listing payload.");
      }
      return { ok: true, listing: result.body };
    },

    async fetchSearch(input: SearchFetchInput): Promise<AdapterListingOk | AdapterFailure> {
      const params = new URLSearchParams({
        raw_json: "1",
        q: input.q,
        sort: input.sort,
        limit: String(input.limit),
      });
      if (input.cursor !== undefined) {
        params.set("after", input.cursor);
      }
      let path = "/search.json";
      if (input.subreddit !== undefined) {
        path = `/r/${encodeURIComponent(input.subreddit)}/search.json`;
        params.set("restrict_sr", "1");
      }
      const result = await redditGet(limit, fetchFn, `${origin}${path}?${params}`, userAgent, timeoutMs);
      if (!result.ok) {
        return result;
      }
      if (asRecord(result.body) === null) {
        return fail("upstream_blocked", "Unexpected search payload.");
      }
      return { ok: true, listing: result.body };
    },
  };
}

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

async function redditGet(
  limit: <T>(fn: () => Promise<T>) => Promise<T>,
  fetchFn: LiveFetch,
  url: string,
  userAgent: string,
  timeoutMs: number,
): Promise<{ ok: true; body: unknown } | AdapterFailure> {
  return limit(async () => {
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: "GET",
        headers: {
          "user-agent": userAgent,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return fail("upstream_blocked", "Upstream blocked the request.");
    }

    const body = await readBody(response);
    const mapped = mapUpstreamFailure(response, body);
    if (mapped !== null) {
      return mapped;
    }
    if (body === null) {
      return fail("upstream_blocked", "Unexpected upstream payload.");
    }
    return { ok: true, body };
  });
}

function mapUpstreamFailure(response: Response, body: unknown): AdapterFailure | null {
  const record = asRecord(body);
  const reason = redditReason(record);
  const errorCode = typeof record?.error === "number" ? record.error : null;

  if (reason === "private" || reason === "gold_only" || reason === "password") {
    return fail("subreddit_private", "This subreddit is private.");
  }
  if (reason === "quarantined") {
    return fail("subreddit_quarantined", "This subreddit is quarantined.");
  }
  if (reason === "banned" || reason === "banned_by_admin" || response.status === 404 || errorCode === 404) {
    return fail("not_found", "Not found.");
  }
  if (response.status === 429 || errorCode === 429) {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter !== null && retryAfter !== "") {
      return fail("rate_limited", `Rate limit exceeded. Retry after ${retryAfter}s.`);
    }
    return fail("rate_limited", "Rate limit exceeded.");
  }
  if (errorCode === 403 || response.status === 403) {
    return fail("upstream_blocked", "Upstream blocked the request.");
  }
  if (!response.ok || (errorCode !== null && errorCode >= 400)) {
    return fail("upstream_blocked", "Upstream blocked the request.");
  }
  return null;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

function threadPath(ref: ThreadRef): string {
  const permalink = ref.permalink.replace(/\/+$/, "");
  if (permalink.startsWith("/")) {
    return permalink;
  }
  if (ref.subreddit !== null && ref.subreddit !== "") {
    return `/r/${ref.subreddit}/comments/${ref.postId}`;
  }
  return `/comments/${ref.postId}`;
}

function moreThings(body: unknown): unknown[] {
  const root = asRecord(body);
  const data = asRecord(asRecord(root?.json)?.data) ?? asRecord(root?.data);
  return Array.isArray(data?.things) ? data.things : [];
}

function fullname(id: string, prefix: "t3"): string {
  const trimmed = id.trim();
  if (trimmed.startsWith(`${prefix}_`)) {
    return trimmed;
  }
  return `${prefix}_${stripThingPrefix(trimmed)}`;
}

function stripThingPrefix(id: string): string {
  return id.replace(/^t[13]_/i, "");
}

function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const cap = Math.max(1, max);
  let active = 0;
  const waiters: Array<() => void> = [];
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= cap) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      const next = waiters.shift();
      next?.();
    }
  };
}

function redditReason(record: Record<string, unknown> | null): string {
  if (record === null) {
    return "";
  }
  if (typeof record.reason === "string") {
    return record.reason;
  }
  const data = asRecord(record.data);
  return typeof data?.reason === "string" ? data.reason : "";
}

function fail(code: ErrorCode, message: string): AdapterFailure {
  return { ok: false, code, message };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

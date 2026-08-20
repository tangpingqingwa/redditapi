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
/** Public JSON when old.reddit returns a login wall (lor2) or 403 HTML. */
export const FALLBACK_REDDIT_ORIGIN = "https://www.reddit.com";
export const LIVE_TIMEOUT_MS = 15_000;
export const LIVE_CONCURRENCY = 4;

export type LiveFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    redirect?: "follow" | "error" | "manual";
  },
) => Promise<Response>;

export type LiveRedditOptions = {
  fetch?: LiveFetch;
  origin?: string;
  /** Set null to disable. Default: www.reddit.com when origin is the default. */
  fallbackOrigin?: string | null;
  userAgent?: string;
  timeoutMs?: number;
  concurrency?: number;
};

type CookieJar = Map<string, string>;

export function createLiveRedditAdapter(options: LiveRedditOptions = {}): RedditAdapter {
  const origin = (options.origin ?? DEFAULT_REDDIT_ORIGIN).replace(/\/+$/, "");
  const fallbackOrigin = resolveFallbackOrigin(origin, options);
  const userAgent = options.userAgent ?? resolveUserAgent();
  const timeoutMs = options.timeoutMs ?? LIVE_TIMEOUT_MS;
  const fetchFn = options.fetch ?? defaultFetch;
  const limit = createLimiter(options.concurrency ?? LIVE_CONCURRENCY);
  const cookies: CookieJar = new Map();
  const warmup: { current: Promise<boolean> | null } = { current: null };

  return {
    async fetchThread(ref: ThreadRef, sort: ThreadSort): Promise<AdapterThreadOk | AdapterFailure> {
      const params = new URLSearchParams({ raw_json: "1", sort, limit: "500" });
      const result = await redditGet(
        limit,
        fetchFn,
        `${origin}${threadPath(ref)}.json?${params}`,
        userAgent,
        timeoutMs,
        cookies,
        warmup,
        fallbackOrigin,
      );
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
        cookies,
        warmup,
        fallbackOrigin,
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
        cookies,
        warmup,
        fallbackOrigin,
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
      const result = await redditGet(
        limit,
        fetchFn,
        `${origin}${path}?${params}`,
        userAgent,
        timeoutMs,
        cookies,
        warmup,
        fallbackOrigin,
      );
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
  // Never follow /login/?reason=lor2 — that 404 must not become not_found.
  return fetch(input, { ...init, redirect: "manual" });
}

function resolveFallbackOrigin(origin: string, options: LiveRedditOptions): string | undefined {
  if (options.fallbackOrigin === null) {
    return undefined;
  }
  const raw =
    options.fallbackOrigin ?? (options.origin === undefined ? FALLBACK_REDDIT_ORIGIN : undefined);
  if (raw === undefined) {
    return undefined;
  }
  const fallback = raw.replace(/\/+$/, "");
  return fallback === origin ? undefined : fallback;
}

async function redditGet(
  limit: <T>(fn: () => Promise<T>) => Promise<T>,
  fetchFn: LiveFetch,
  url: string,
  userAgent: string,
  timeoutMs: number,
  cookies: CookieJar,
  warmup: { current: Promise<boolean> | null },
  fallbackOrigin?: string,
): Promise<{ ok: true; body: unknown } | AdapterFailure> {
  return limit(async () => {
    const urls = requestUrls(url, fallbackOrigin);
    let last: AdapterFailure | null = null;
    for (const candidate of urls) {
      let result = await redditGetOnce(fetchFn, candidate, userAgent, timeoutMs, cookies);
      if (result.ok) {
        return result;
      }
      if (result.code === "upstream_blocked" && allowsPublicSession(candidate) && !cookies.has("token_v2")) {
        const authed = await ensurePublicSession(warmup, fetchFn, sessionOrigin(candidate), userAgent, timeoutMs, cookies);
        if (authed) {
          result = await redditGetOnce(fetchFn, candidate, userAgent, timeoutMs, cookies);
          if (result.ok) {
            return result;
          }
        }
      }
      last = result;
      if (!shouldRetryOtherOrigin(result)) {
        return result;
      }
    }
    return last ?? fail("upstream_blocked", "Upstream blocked the request.");
  });
}

async function redditGetOnce(
  fetchFn: LiveFetch,
  url: string,
  userAgent: string,
  timeoutMs: number,
  cookies: CookieJar,
): Promise<{ ok: true; body: unknown } | AdapterFailure> {
  const response = await liveFetch(fetchFn, url, userAgent, timeoutMs, cookies, {
    accept: "application/json",
  });
  if (response === null) {
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
}

function ensurePublicSession(
  warmup: { current: Promise<boolean> | null },
  fetchFn: LiveFetch,
  origin: string,
  userAgent: string,
  timeoutMs: number,
  cookies: CookieJar,
): Promise<boolean> {
  if (cookies.has("token_v2")) {
    return Promise.resolve(true);
  }
  if (warmup.current !== null) {
    return warmup.current;
  }
  const pending = completeJsChallenge(fetchFn, origin, userAgent, timeoutMs, cookies).then(
    (ok) => {
      if (!ok && warmup.current === pending) {
        warmup.current = null;
      }
      return ok;
    },
    () => {
      if (warmup.current === pending) {
        warmup.current = null;
      }
      return false;
    },
  );
  warmup.current = pending;
  return pending;
}

async function completeJsChallenge(
  fetchFn: LiveFetch,
  origin: string,
  userAgent: string,
  timeoutMs: number,
  cookies: CookieJar,
): Promise<boolean> {
  const pageUrl = `${origin}/`;
  const page = await liveFetch(fetchFn, pageUrl, userAgent, timeoutMs, cookies, {
    accept: "text/html",
  });
  if (page === null || isLoginWallResponse(page)) {
    return false;
  }
  let html: string;
  try {
    html = await page.text();
  } catch {
    return false;
  }
  const challenge = parseJsChallenge(html);
  if (challenge === null) {
    return false;
  }
  const dest = new URL(challenge.action, pageUrl);
  dest.searchParams.set("solution", challenge.solution);
  dest.searchParams.set("js_challenge", "1");
  dest.searchParams.set("token", challenge.token);
  dest.searchParams.set("jsc_orig_r", challenge.jscOrigR);
  const solved = await liveFetch(fetchFn, dest.toString(), userAgent, timeoutMs, cookies, {
    accept: "text/html",
    referer: pageUrl,
  });
  if (solved === null || isLoginWallResponse(solved)) {
    return false;
  }
  try {
    await solved.text();
  } catch {
    return false;
  }
  return cookies.has("token_v2");
}

function parseJsChallenge(html: string): { action: string; token: string; solution: string; jscOrigR: string } | null {
  if (!/js_challenge/i.test(html)) {
    return null;
  }
  const doubled = html.match(/await\(\s*async\s+e\s*=>\s*e\s*\+\s*e\s*\)\s*\(\s*"([0-9a-f]+)"\s*\)/i);
  const token = html.match(/name="token"\s+value="([^"]+)"/i);
  const action =
    html.match(/<form[^>]*method="GET"[^>]*action="([^"]*)"/i) ??
    html.match(/<form[^>]*action="([^"]*)"[^>]*method="GET"/i);
  if (doubled === null || token === null || action === null) {
    return null;
  }
  const orig = html.match(/name="jsc_orig_r"\s+value="([^"]*)"/i);
  return {
    action: action[1] === "" ? "/" : action[1],
    token: token[1],
    solution: `${doubled[1]}${doubled[1]}`,
    jscOrigR: orig?.[1] ?? "",
  };
}

async function liveFetch(
  fetchFn: LiveFetch,
  url: string,
  userAgent: string,
  timeoutMs: number,
  cookies: CookieJar,
  extraHeaders: Record<string, string>,
): Promise<Response | null> {
  const headers: Record<string, string> = {
    "user-agent": userAgent,
    ...extraHeaders,
  };
  const cookie = cookieHeader(cookies);
  if (cookie !== "") {
    headers.cookie = cookie;
  }
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
  applySetCookie(cookies, response);
  return response;
}

function cookieHeader(cookies: CookieJar): string {
  if (cookies.size === 0) {
    return "";
  }
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function applySetCookie(cookies: CookieJar, response: Response): void {
  const raw = readSetCookie(response);
  for (const header of raw) {
    const nv = header.split(";")[0] ?? "";
    const eq = nv.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const name = nv.slice(0, eq).trim();
    const value = nv.slice(eq + 1);
    if (name === "") {
      continue;
    }
    if (value === "" || /(?:^|;)\s*max-age=0(?:;|$)/i.test(header) || /expires=thu,\s*01 jan 1970/i.test(header)) {
      cookies.delete(name);
      continue;
    }
    cookies.set(name, value);
  }
}

function readSetCookie(response: Response): string[] {
  const headers = response.headers;
  if (typeof headers.getSetCookie === "function") {
    const listed = headers.getSetCookie();
    if (listed.length > 0) {
      return listed;
    }
  }
  const single = headers.get("set-cookie");
  return single === null || single === "" ? [] : [single];
}

function allowsPublicSession(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "www.reddit.com" || host === "reddit.com";
  } catch {
    return false;
  }
}

function sessionOrigin(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

function requestUrls(url: string, fallbackOrigin?: string): string[] {
  if (fallbackOrigin === undefined) {
    return [url];
  }
  const fallback = rewriteOrigin(url, fallbackOrigin);
  return fallback === url ? [url] : [url, fallback];
}

function rewriteOrigin(url: string, origin: string): string {
  const parsed = new URL(url);
  const target = new URL(origin);
  parsed.protocol = target.protocol;
  parsed.host = target.host;
  return parsed.toString();
}

function shouldRetryOtherOrigin(failure: AdapterFailure): boolean {
  return failure.code === "upstream_blocked" || failure.code === "rate_limited";
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
  // Login wall / 403 interstitial / followed lor2 404 — never not_found.
  if (isLoginWallResponse(response) || isBlockedHtml(response, body, errorCode)) {
    return fail("upstream_blocked", "Upstream blocked the request.");
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

function isLoginWallResponse(response: Response): boolean {
  const candidates = [response.url, response.headers.get("location") ?? ""];
  for (const raw of candidates) {
    if (raw === "") {
      continue;
    }
    try {
      const parsed = new URL(raw, response.url !== "" ? response.url : DEFAULT_REDDIT_ORIGIN);
      if (parsed.searchParams.get("reason") === "lor2") {
        return true;
      }
      const path = parsed.pathname.replace(/\/+$/, "") || "/";
      if (path === "/login" || path.startsWith("/login/")) {
        return true;
      }
    } catch {
      if (/reason=lor2/i.test(raw) || /\/login(?:\/|\?|$)/i.test(raw)) {
        return true;
      }
    }
  }
  return false;
}

function isBlockedHtml(response: Response, body: unknown, errorCode: number | null): boolean {
  if (body !== null) {
    return false;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/html/i.test(contentType)) {
    return false;
  }
  // .json asked for JSON; HTML 403/404/200 interstitial is a wall, not a missing post.
  return response.status === 200 || response.status === 403 || response.status === 404 || errorCode === 403;
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

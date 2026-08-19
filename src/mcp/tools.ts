import { chargeCredits } from "../billing/keys.js";
import { getLatest, listSubreddit } from "../core/listings.js";
import { searchReddit } from "../core/search.js";
import {
  DEFAULT_MAX_COMMENTS,
  MAX_COMMENTS_CAP,
  getPost,
  unrollThread,
  type RedditAdapter,
} from "../core/thread.js";
import type { SqliteDatabase } from "../db.js";
import { isRetryable } from "../http/envelope.js";
import type { Err, ErrorCode, KeyRecord, ListingSort, Ok, ThreadSort } from "../types.js";

export const UNROLL_THREAD_TOOL = "unroll_thread" as const;
export const GET_POST_TOOL = "get_post" as const;
export const LIST_SUBREDDIT_TOOL = "list_subreddit" as const;
export const SEARCH_REDDIT_TOOL = "search_reddit" as const;
export const GET_LATEST_TOOL = "get_latest" as const;

export const MCP_TOOL_NAMES = [
  UNROLL_THREAD_TOOL,
  GET_POST_TOOL,
  LIST_SUBREDDIT_TOOL,
  SEARCH_REDDIT_TOOL,
  GET_LATEST_TOOL,
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export type McpToolDefinition = {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpToolOutcome = Ok<unknown> | Err;

export type CallMcpToolInput = {
  name: string;
  args: Record<string, unknown>;
  db: SqliteDatabase;
  reddit: RedditAdapter;
  key: KeyRecord;
  requestId: string;
};

export const MCP_SKILL =
  "Read-only public Reddit. Do not use for voting or posting. Private subs will 403. Comment trees may truncate.";

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: UNROLL_THREAD_TOOL,
    description:
      "Unroll a public Reddit thread (post + nested comments). Maps to GET /v1/threads/by-url. " +
      "1 credit if commentCount <= 400, else 2. Trees may truncate at max_comments. " +
      MCP_SKILL,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description: "reddit.com or old.reddit permalink",
        },
        max_comments: {
          type: "integer",
          minimum: 1,
          maximum: MAX_COMMENTS_CAP,
          description: `Cap after MoreComments expand (default ${DEFAULT_MAX_COMMENTS}, max ${MAX_COMMENTS_CAP})`,
        },
        sort: {
          type: "string",
          enum: ["best", "new", "top", "qa"],
          description: "Comment sort (default best)",
        },
      },
    },
  },
  {
    name: GET_POST_TOOL,
    description:
      "Post only, no comments. Maps to GET /v1/posts/{id}. 1 credit on success. " + MCP_SKILL,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: {
          type: "string",
          description: "Post id abc123 or t3_abc123",
        },
      },
    },
  },
  {
    name: LIST_SUBREDDIT_TOOL,
    description:
      "One page of a public subreddit listing. Maps to GET /v1/r/{sub}/hot|new|top. " +
      "1 credit per page. " +
      MCP_SKILL,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sub"],
      properties: {
        sub: {
          type: "string",
          description: "Public subreddit name (with or without r/)",
        },
        sort: {
          type: "string",
          enum: ["hot", "new", "top"],
          description: "Listing sort (default hot)",
        },
        t: {
          type: "string",
          enum: ["day", "week", "month", "year", "all"],
          description: "Top window; only valid when sort=top",
        },
        cursor: {
          type: "string",
          description: "Page token from nextCursor",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Page size 1-100 (default 25)",
        },
      },
    },
  },
  {
    name: SEARCH_REDDIT_TOOL,
    description:
      "Search public posts. Maps to GET /v1/search. 1 credit per page with hits; empty = 0. " +
      MCP_SKILL,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["q"],
      properties: {
        q: {
          type: "string",
          description: "Search query",
        },
        sub: {
          type: "string",
          description: "Optional subreddit scope",
        },
        sort: {
          type: "string",
          enum: ["relevance", "hot", "top", "new", "comments"],
          description: "Search sort (default relevance)",
        },
        cursor: {
          type: "string",
          description: "Page token from nextCursor",
        },
      },
    },
  },
  {
    name: GET_LATEST_TOOL,
    description:
      "Newest ~25 posts in a public subreddit. Maps to GET /v1/r/{sub}/latest. 0 credits. " +
      MCP_SKILL,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sub"],
      properties: {
        sub: {
          type: "string",
          description: "Public subreddit name (with or without r/)",
        },
      },
    },
  },
];

export function isMcpToolName(name: string): name is McpToolName {
  return (MCP_TOOL_NAMES as readonly string[]).includes(name);
}

/** Dispatch an MCP tool to core/* only. */
export async function callMcpTool(input: CallMcpToolInput): Promise<McpToolOutcome> {
  if (!isMcpToolName(input.name)) {
    return fail("invalid_request", input.requestId, `Unknown MCP tool '${input.name}'.`);
  }

  switch (input.name) {
    case UNROLL_THREAD_TOOL:
      return dispatchUnroll(input);
    case GET_POST_TOOL:
      return dispatchGetPost(input);
    case LIST_SUBREDDIT_TOOL:
      return dispatchListSubreddit(input);
    case SEARCH_REDDIT_TOOL:
      return dispatchSearch(input);
    case GET_LATEST_TOOL:
      return dispatchLatest(input);
  }
}

async function dispatchUnroll(input: CallMcpToolInput): Promise<McpToolOutcome> {
  const url = readStringArg(input.args, "url");
  if (url === undefined) {
    return fail("invalid_request", input.requestId, "url is required.");
  }
  const sortRaw = readStringArg(input.args, "sort") ?? "best";
  if (!isThreadSort(sortRaw)) {
    return fail("invalid_request", input.requestId, "sort must be best, new, top, or qa.");
  }
  const maxComments = parseMaxComments(input.args.max_comments);
  if (maxComments === null) {
    return fail(
      "invalid_request",
      input.requestId,
      `max_comments must be an integer 1-${MAX_COMMENTS_CAP}.`,
    );
  }

  const result = await unrollThread(input.reddit, {
    url,
    maxComments,
    sort: sortRaw,
  });
  if (!result.ok) {
    return fail(result.code, input.requestId, result.message);
  }
  const charged = chargeOrFail(input, result.credits, "/v1/threads/by-url");
  if (charged !== null) {
    return charged;
  }
  return ok(result.data, input.requestId, result.credits, result.upstreamMs, result.truncated);
}

async function dispatchGetPost(input: CallMcpToolInput): Promise<McpToolOutcome> {
  const id = readStringArg(input.args, "id");
  if (id === undefined) {
    return fail("invalid_request", input.requestId, "id is required.");
  }
  const result = await getPost(input.reddit, id);
  if (!result.ok) {
    return fail(result.code, input.requestId, result.message);
  }
  const charged = chargeOrFail(input, result.credits, "/v1/posts/{id}");
  if (charged !== null) {
    return charged;
  }
  return ok(result.data, input.requestId, result.credits, result.upstreamMs);
}

async function dispatchListSubreddit(input: CallMcpToolInput): Promise<McpToolOutcome> {
  const sub = readStringArg(input.args, "sub");
  if (sub === undefined) {
    return fail("invalid_request", input.requestId, "sub is required.");
  }
  const sortRaw = readStringArg(input.args, "sort") ?? "hot";
  if (!isListingSort(sortRaw)) {
    return fail("invalid_request", input.requestId, "sort must be hot, new, or top.");
  }
  const result = await listSubreddit(input.reddit, {
    subreddit: sub,
    sort: sortRaw,
    t: readStringArg(input.args, "t"),
    cursor: readStringArg(input.args, "cursor"),
    limit: readLimitArg(input.args, "limit"),
  });
  if (!result.ok) {
    return fail(result.code, input.requestId, result.message);
  }
  const charged = chargeOrFail(input, result.credits, `/v1/r/{sub}/${sortRaw}`);
  if (charged !== null) {
    return charged;
  }
  return ok(result.data, input.requestId, result.credits, result.upstreamMs);
}

async function dispatchSearch(input: CallMcpToolInput): Promise<McpToolOutcome> {
  const q = readStringArg(input.args, "q") ?? "";
  const result = await searchReddit(input.reddit, {
    q,
    sub: readStringArg(input.args, "sub"),
    sort: readStringArg(input.args, "sort"),
    cursor: readStringArg(input.args, "cursor"),
    limit: readLimitArg(input.args, "limit"),
  });
  if (!result.ok) {
    return fail(result.code, input.requestId, result.message);
  }
  if (result.credits > 0) {
    const charged = chargeOrFail(input, result.credits, "/v1/search");
    if (charged !== null) {
      return charged;
    }
  }
  return ok(result.data, input.requestId, result.credits, result.upstreamMs);
}

async function dispatchLatest(input: CallMcpToolInput): Promise<McpToolOutcome> {
  const sub = readStringArg(input.args, "sub");
  if (sub === undefined) {
    return fail("invalid_request", input.requestId, "sub is required.");
  }
  const result = await getLatest(input.reddit, { subreddit: sub });
  if (!result.ok) {
    return fail(result.code, input.requestId, result.message);
  }
  return ok(result.data, input.requestId, 0, result.upstreamMs);
}

function chargeOrFail(input: CallMcpToolInput, credits: number, route: string): Err | null {
  if (credits < 1) {
    return null;
  }
  const charged = chargeCredits(input.db, input.key, credits, route, false);
  if (!charged.ok) {
    return fail("payment_required", input.requestId);
  }
  return null;
}

function ok(
  data: unknown,
  requestId: string,
  creditsCharged: number,
  upstreamMs: number,
  truncated?: boolean,
): Ok<unknown> {
  return {
    data,
    meta: {
      cached: false,
      creditsCharged,
      requestId,
      upstreamMs,
      ...(truncated === undefined ? {} : { truncated }),
    },
  };
}

function fail(code: ErrorCode, requestId: string, message?: string): Err {
  return {
    error: {
      code,
      message: message ?? defaultMessage(code),
      retryable: isRetryable(code),
    },
    meta: { creditsCharged: 0, requestId },
  };
}

function defaultMessage(code: ErrorCode): string {
  switch (code) {
    case "payment_required":
      return "Out of credits.";
    default:
      return "Bad request.";
  }
}

function readStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function readLimitArg(args: Record<string, unknown>, key: string): string | undefined {
  return readStringArg(args, key);
}

function parseMaxComments(raw: unknown): number | null {
  if (raw === undefined || raw === "") {
    return DEFAULT_MAX_COMMENTS;
  }
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= 1 && raw <= MAX_COMMENTS_CAP ? raw : null;
  }
  if (typeof raw === "string") {
    if (!/^[0-9]+$/.test(raw)) {
      return null;
    }
    const value = Number(raw);
    return Number.isInteger(value) && value >= 1 && value <= MAX_COMMENTS_CAP ? value : null;
  }
  return null;
}

function isThreadSort(value: string): value is ThreadSort {
  return value === "best" || value === "new" || value === "top" || value === "qa";
}

function isListingSort(value: string): value is ListingSort {
  return value === "hot" || value === "new" || value === "top";
}

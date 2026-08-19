import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";
import { insertKeyFromSecret } from "../src/billing/keys.js";
import { openDatabase } from "../src/db.js";
import { MCP_PATH, MCP_PROTOCOL_VERSION } from "../src/mcp/server.js";
import {
  GET_LATEST_TOOL,
  GET_POST_TOOL,
  LIST_SUBREDDIT_TOOL,
  MCP_SKILL,
  SEARCH_REDDIT_TOOL,
  UNROLL_THREAD_TOOL,
} from "../src/mcp/tools.js";
import type { ErrorCode, ListingData, RedditPost, SearchData, ThreadData } from "../src/types.js";

const KEY = "rk_test_mcp_fixture_secret";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHORT_URL = "https://www.reddit.com/r/test/comments/short1/a_short_thread/";

type OkBody<T> = {
  data: T;
  meta: {
    cached: boolean;
    creditsCharged: number;
    requestId: string;
    upstreamMs: number;
    truncated?: boolean;
  };
};

type ErrBody = {
  error: { code: ErrorCode; message: string; retryable: boolean };
  meta: { creditsCharged: number; requestId: string };
};

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: OkBody<unknown> | ErrBody;
  isError: boolean;
};

type JsonRpcOk = {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
};

async function appWithKey(credits = 100) {
  const db = openDatabase(":memory:");
  insertKeyFromSecret(db, KEY, { credits });
  const app = await buildApp({ db });
  after(() => app.close());
  return { app, db };
}

function auth() {
  return { authorization: `Bearer ${KEY}` };
}

async function rpc(
  app: Awaited<ReturnType<typeof buildApp>>,
  method: string,
  params?: unknown,
  headers: Record<string, string> = auth(),
) {
  return app.inject({
    method: "POST",
    url: MCP_PATH,
    headers,
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });
}

async function callTool(
  app: Awaited<ReturnType<typeof buildApp>>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await rpc(app, "tools/call", { name, arguments: args });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as JsonRpcOk;
  const result = body.result as ToolResult;
  assert.ok(result);
  assert.equal(typeof result.isError, "boolean");
  return result;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      out.push(...walkTs(path));
    } else if (name.name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

function remainingCredits(db: ReturnType<typeof openDatabase>): number {
  return (db.prepare("SELECT credits FROM keys").get() as { credits: number }).credits;
}

test("GET /llms.txt is public and matches the checked-in file", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({ method: "GET", url: "/llms.txt" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /text\/plain/);
  const onDisk = readFileSync(join(ROOT, "llms.txt"), "utf8");
  assert.equal(response.body, onDisk);
  assert.match(onDisk, /unroll_thread/);
  assert.match(onDisk, /get_post/);
  assert.match(onDisk, /list_subreddit/);
  assert.match(onDisk, /search_reddit/);
  assert.match(onDisk, /get_latest/);
  assert.match(onDisk, /do not use for voting or posting/i);
  assert.match(onDisk, /private subs will 403/i);
  assert.match(onDisk, /trees may truncate/i);
});

test("GET /.well-known/mcp/server-card.json lists shipped tools only", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: "/.well-known/mcp/server-card.json",
  });
  assert.equal(response.statusCode, 200);
  const card = response.json() as { tools: string[]; transport: string };
  assert.equal(card.transport, "streamable-http");
  assert.deepEqual(card.tools, [
    UNROLL_THREAD_TOOL,
    GET_POST_TOOL,
    LIST_SUBREDDIT_TOOL,
    SEARCH_REDDIT_TOOL,
    GET_LATEST_TOOL,
  ]);
});

test("POST /mcp without bearer is 401 with 0 credits", async () => {
  const { app } = await appWithKey();
  const response = await rpc(app, "initialize", undefined, {});
  assert.equal(response.statusCode, 401);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "unauthorized");
  assert.equal(body.meta.creditsCharged, 0);
});

test("initialize and tools/list describe the five SPEC tools and skill", async () => {
  const { app } = await appWithKey();

  const init = await rpc(app, "initialize");
  assert.equal(init.statusCode, 200);
  const initResult = (init.json() as JsonRpcOk).result as {
    protocolVersion: string;
    capabilities: { tools: unknown };
    serverInfo: { name: string };
    instructions: string;
  };
  assert.equal(initResult.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(initResult.serverInfo.name, "redditapi");
  assert.ok(initResult.capabilities.tools);
  assert.equal(initResult.instructions, MCP_SKILL);
  assert.match(initResult.instructions, /do not use for voting or posting/i);
  assert.match(initResult.instructions, /private subs will 403/i);
  assert.match(initResult.instructions, /trees may truncate/i);

  const listed = await rpc(app, "tools/list");
  assert.equal(listed.statusCode, 200);
  const tools = (
    (listed.json() as JsonRpcOk).result as {
      tools: Array<{ name: string; description: string }>;
    }
  ).tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [UNROLL_THREAD_TOOL, GET_POST_TOOL, LIST_SUBREDDIT_TOOL, SEARCH_REDDIT_TOOL, GET_LATEST_TOOL],
  );
  for (const tool of tools) {
    assert.match(tool.description, /do not use for voting or posting/i);
    assert.match(tool.description, /private subs will 403/i);
    assert.match(tool.description, /trees may truncate/i);
  }
});

test("MCP unroll_thread matches REST by-url and charges 1", async () => {
  const { app, db } = await appWithKey(10);

  const rest = await app.inject({
    method: "GET",
    url: `/v1/threads/by-url?url=${encodeURIComponent(SHORT_URL)}`,
    headers: auth(),
  });
  assert.equal(rest.statusCode, 200);
  const restBody = rest.json() as OkBody<ThreadData>;
  assert.equal(restBody.data.post.id, "t3_short1");
  assert.equal(restBody.data.commentCount, 3);
  assert.equal(restBody.meta.creditsCharged, 1);

  const mcp = await callTool(app, UNROLL_THREAD_TOOL, { url: SHORT_URL });
  assert.equal(mcp.isError, false);
  const mcpBody = mcp.structuredContent as OkBody<ThreadData>;
  assert.deepEqual(mcpBody.data, restBody.data);
  assert.equal(mcpBody.meta.creditsCharged, 1);
  assert.equal(mcpBody.meta.truncated, false);
  assert.equal(remainingCredits(db), 8);
});

test("MCP get_post matches REST and charges 1", async () => {
  const { app, db } = await appWithKey(6);

  const rest = await app.inject({
    method: "GET",
    url: "/v1/posts/t3_short1",
    headers: auth(),
  });
  const restBody = rest.json() as OkBody<RedditPost>;
  assert.equal(rest.statusCode, 200);
  assert.equal(restBody.data.title, "A short thread");
  assert.equal(restBody.meta.creditsCharged, 1);

  const mcp = await callTool(app, GET_POST_TOOL, { id: "short1" });
  assert.equal(mcp.isError, false);
  const mcpBody = mcp.structuredContent as OkBody<RedditPost>;
  assert.deepEqual(mcpBody.data, restBody.data);
  assert.equal(mcpBody.meta.creditsCharged, 1);
  assert.equal(remainingCredits(db), 4);
});

test("MCP list_subreddit and get_latest match REST credit rules", async () => {
  const { app, db } = await appWithKey(5);

  const restHot = await app.inject({
    method: "GET",
    url: "/v1/r/test/hot",
    headers: auth(),
  });
  const restHotBody = restHot.json() as OkBody<ListingData>;
  const mcpHot = await callTool(app, LIST_SUBREDDIT_TOOL, { sub: "test", sort: "hot" });
  assert.equal(mcpHot.isError, false);
  const mcpHotBody = mcpHot.structuredContent as OkBody<ListingData>;
  assert.deepEqual(mcpHotBody.data, restHotBody.data);
  assert.equal(mcpHotBody.meta.creditsCharged, 1);

  const restLatest = await app.inject({
    method: "GET",
    url: "/v1/r/test/latest",
    headers: auth(),
  });
  const mcpLatest = await callTool(app, GET_LATEST_TOOL, { sub: "r/test" });
  assert.equal(mcpLatest.isError, false);
  const mcpLatestBody = mcpLatest.structuredContent as OkBody<ListingData>;
  assert.deepEqual(mcpLatestBody.data, (restLatest.json() as OkBody<ListingData>).data);
  assert.equal(mcpLatestBody.meta.creditsCharged, 0);
  assert.equal(remainingCredits(db), 3);
});

test("MCP search_reddit matches REST and charges 1 only when there are hits", async () => {
  const { app, db } = await appWithKey(4);

  const rest = await app.inject({
    method: "GET",
    url: "/v1/search?q=api&sub=test&sort=new",
    headers: auth(),
  });
  const restBody = rest.json() as OkBody<SearchData>;
  assert.ok(restBody.data.posts.length > 0);
  assert.equal(restBody.meta.creditsCharged, 1);

  const mcp = await callTool(app, SEARCH_REDDIT_TOOL, { q: "api", sub: "test", sort: "new" });
  assert.equal(mcp.isError, false);
  const mcpBody = mcp.structuredContent as OkBody<SearchData>;
  assert.deepEqual(mcpBody.data, restBody.data);
  assert.equal(mcpBody.meta.creditsCharged, 1);

  const empty = await callTool(app, SEARCH_REDDIT_TOOL, { q: "zzzz-no-such-token" });
  assert.equal(empty.isError, false);
  const emptyBody = empty.structuredContent as OkBody<SearchData>;
  assert.deepEqual(emptyBody.data.posts, []);
  assert.equal(emptyBody.meta.creditsCharged, 0);
  assert.equal(remainingCredits(db), 2);
});

test("MCP private sub and unknown tools charge 0", async () => {
  const { app, db } = await appWithKey(7);

  const priv = await callTool(app, LIST_SUBREDDIT_TOOL, { sub: "privatesub" });
  assert.equal(priv.isError, true);
  const privBody = priv.structuredContent as ErrBody;
  assert.equal(privBody.error.code, "subreddit_private");
  assert.equal(privBody.meta.creditsCharged, 0);

  const unknown = await callTool(app, "vote_post", { id: "short1" });
  assert.equal(unknown.isError, true);
  const unknownBody = unknown.structuredContent as ErrBody;
  assert.equal(unknownBody.error.code, "invalid_request");
  assert.equal(unknownBody.meta.creditsCharged, 0);
  assert.equal(remainingCredits(db), 7);
});

test("HTTP and MCP call core only and never import the fixture adapter", () => {
  const files = [...walkTs(join(ROOT, "src/http")), ...walkTs(join(ROOT, "src/mcp"))];
  assert.ok(files.length > 0);
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /adapters\/reddit/, file);
    assert.doesNotMatch(src, /\bfetch\s*\(/, file);
  }
  const tools = readFileSync(join(ROOT, "src/mcp/tools.ts"), "utf8");
  assert.match(tools, /unrollThread/);
  assert.match(tools, /getPost/);
  assert.match(tools, /listSubreddit/);
  assert.match(tools, /searchReddit/);
  assert.match(tools, /getLatest/);
  assert.match(tools, /search_reddit/);
});

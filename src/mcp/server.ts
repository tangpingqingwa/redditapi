import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { RedditAdapter } from "../core/thread.js";
import type { SqliteDatabase } from "../db.js";
import { requireKey } from "../http/auth.js";
import { newRequestId } from "../http/envelope.js";
import { callMcpTool, MCP_SKILL, MCP_TOOLS, type McpToolOutcome } from "./tools.js";

export const MCP_PATH = "/mcp" as const;
export const LLMS_TXT_PATH = "/llms.txt" as const;
export const MCP_SERVER_CARD_PATH = "/.well-known/mcp/server-card.json" as const;
export const MCP_PROTOCOL_VERSION = "2025-03-26" as const;

const LLMS_TXT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../llms.txt"), "utf8");

export type McpRoutesOptions = {
  db: SqliteDatabase;
  reddit: RedditAdapter;
};

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcError = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string };
};

type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

const SERVER_CARD = {
  name: "redditapi",
  description: "Read-only public Reddit threads, listings, and search. Bearer auth.",
  url: "https://mcp.redditapi.dev/mcp",
  transport: "streamable-http",
  authentication: { type: "bearer" },
  tools: MCP_TOOLS.map((tool) => tool.name),
};

export const mcpRoutes: FastifyPluginAsync<McpRoutesOptions> = async (app, opts) => {
  app.get(LLMS_TXT_PATH, async (_request, reply) => {
    return reply.type("text/plain; charset=utf-8").status(200).send(LLMS_TXT);
  });

  app.get(MCP_SERVER_CARD_PATH, async (_request, reply) => {
    return reply.status(200).send(SERVER_CARD);
  });

  app.post(MCP_PATH, async (request, reply) => {
    const requestId = newRequestId();
    const key = requireKey(opts.db, request, reply, requestId);
    if (key === null) {
      return reply;
    }

    const rpc = parseJsonRpc(request.body);
    if (!rpc.ok) {
      return sendRpc(reply, rpc.error);
    }
    if (rpc.request.id === undefined) {
      return reply.status(202).send();
    }

    const result = await dispatch(opts, key, requestId, {
      ...rpc.request,
      id: rpc.request.id,
    });
    return sendRpc(reply, result);
  });
};

async function dispatch(
  opts: McpRoutesOptions,
  key: Parameters<typeof callMcpTool>[0]["key"],
  requestId: string,
  rpc: JsonRpcRequest & { id: JsonRpcId },
): Promise<JsonRpcSuccess | JsonRpcError> {
  switch (rpc.method) {
    case "initialize":
      return ok(rpc.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "redditapi", version: "0.1.0" },
        instructions: MCP_SKILL,
      });
    case "ping":
      return ok(rpc.id, {});
    case "tools/list":
      return ok(rpc.id, { tools: MCP_TOOLS });
    case "tools/call":
      return callTool(opts, key, requestId, rpc);
    default:
      return rpcError(rpc.id, -32601, `Method not found: ${rpc.method}`);
  }
}

async function callTool(
  opts: McpRoutesOptions,
  key: Parameters<typeof callMcpTool>[0]["key"],
  requestId: string,
  rpc: JsonRpcRequest & { id: JsonRpcId },
): Promise<JsonRpcSuccess | JsonRpcError> {
  const parsed = parseToolCall(rpc.params);
  if (!parsed.ok) {
    return rpcError(rpc.id, -32602, parsed.message);
  }
  const outcome = await callMcpTool({
    name: parsed.name,
    args: parsed.args,
    db: opts.db,
    reddit: opts.reddit,
    key,
    requestId,
  });
  return ok(rpc.id, toolResult(outcome));
}

function toolResult(outcome: McpToolOutcome): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: McpToolOutcome;
  isError: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(outcome) }],
    structuredContent: outcome,
    isError: "error" in outcome,
  };
}

function parseToolCall(
  params: unknown,
): { ok: true; name: string; args: Record<string, unknown> } | { ok: false; message: string } {
  if (!isRecord(params) || typeof params.name !== "string" || params.name === "") {
    return { ok: false, message: "tools/call requires params.name." };
  }
  if (params.arguments === undefined) {
    return { ok: true, name: params.name, args: {} };
  }
  if (!isRecord(params.arguments)) {
    return { ok: false, message: "tools/call arguments must be an object." };
  }
  return { ok: true, name: params.name, args: params.arguments };
}

function parseJsonRpc(
  body: unknown,
): { ok: true; request: JsonRpcRequest } | { ok: false; error: JsonRpcError } {
  if (Array.isArray(body)) {
    return {
      ok: false,
      error: rpcError(null, -32600, "JSON-RPC batches are not supported."),
    };
  }
  if (!isRecord(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return {
      ok: false,
      error: rpcError(readId(body), -32600, "Invalid JSON-RPC request."),
    };
  }
  return {
    ok: true,
    request: {
      jsonrpc: "2.0",
      id: "id" in body ? readId(body) : undefined,
      method: body.method,
      params: body.params,
    },
  };
}

function readId(body: unknown): JsonRpcId {
  if (!isRecord(body)) {
    return null;
  }
  const id = body.id;
  if (typeof id === "string" || typeof id === "number" || id === null) {
    return id;
  }
  return null;
}

function ok(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function sendRpc(reply: FastifyReply, body: JsonRpcSuccess | JsonRpcError): FastifyReply {
  return reply.status(200).send(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

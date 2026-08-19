import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  DEFAULT_MAX_COMMENTS,
  parseRedditThreadUrl,
  unrollThread,
  type RedditAdapter,
} from "../../core/thread.js";
import type { ErrorCode } from "../../types.js";
import { renderHome } from "../../views/home.js";
import { renderThreadPage } from "../../views/thread.js";
import { HTTP_STATUS_BY_ERROR } from "../envelope.js";

export const HOME_PATH = "/" as const;
export const PERMALINK_PATH = "/r/:sub/comments/:id/:slug?" as const;

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../public");

export type HtmlRoutesOptions = {
  reddit: RedditAdapter;
};

type HomeQuery = {
  url?: string | string[];
};

type PermalinkParams = {
  sub: string;
  id: string;
  slug?: string;
};

const UNROLL_FAILED = "We could not unroll this thread.";

export const htmlRoutes: FastifyPluginAsync<HtmlRoutesOptions> = async (app, opts) => {
  const stylesheet = readFileSync(join(PUBLIC_DIR, "unroller.css"), "utf8");
  const script = readFileSync(join(PUBLIC_DIR, "unroller.js"), "utf8");

  app.get("/unroller.css", async (_request, reply) => {
    return reply.type("text/css; charset=utf-8").send(stylesheet);
  });

  app.get("/unroller.js", async (_request, reply) => {
    return reply.type("text/javascript; charset=utf-8").send(script);
  });

  app.get<{ Querystring: HomeQuery }>(HOME_PATH, async (request, reply) => {
    const raw = firstQueryValue(request.query.url);
    if (raw === undefined) {
      return sendHtml(reply, 200, renderHome());
    }
    if (raw.trim() === "") {
      return sendHtml(
        reply,
        400,
        renderHome({
          url: raw,
          error: "Paste a reddit.com or old.reddit permalink.",
          title: "Paste a Reddit URL",
        }),
        true,
      );
    }
    const parsed = parseRedditThreadUrl(raw);
    if (parsed === null) {
      return sendHtml(
        reply,
        400,
        renderHome({
          url: raw,
          error: "url must be a reddit.com or old.reddit permalink.",
          title: "Not a Reddit thread",
        }),
        true,
      );
    }
    const location = parsed.subreddit
      ? `/r/${parsed.subreddit}/comments/${parsed.postId}${slugFromPermalink(parsed.permalink)}`
      : `/r/reddit/comments/${parsed.postId}`;
    return reply.redirect(location, 302);
  });

  app.get<{ Params: PermalinkParams }>(PERMALINK_PATH, async (request, reply) => {
    const sub = request.params.sub.trim();
    const id = request.params.id.trim();
    const slug = request.params.slug?.trim();
    if (sub === "" || id === "") {
      return sendHtml(
        reply,
        400,
        renderHome({
          error: "Provide a subreddit and post id.",
          title: "Invalid permalink",
        }),
        true,
      );
    }

    const permalink = `/r/${sub}/comments/${id}${slug ? `/${slug}` : ""}`;
    const result = await unrollThread(opts.reddit, {
      url: `https://www.reddit.com${permalink}/`,
      maxComments: DEFAULT_MAX_COMMENTS,
      sort: "best",
    });
    if (!result.ok) {
      return sendHtml(
        reply,
        HTTP_STATUS_BY_ERROR[result.code],
        renderHome({
          url: `https://www.reddit.com${permalink}/`,
          error: `${UNROLL_FAILED} ${errorCopy(result.code, result.message)}`,
          title: errorTitle(result.code),
        }),
        true,
      );
    }
    return sendHtml(reply, 200, renderThreadPage(result.data, result.truncated));
  });
};

function sendHtml(reply: FastifyReply, status: number, body: string, noindex = false): FastifyReply {
  if (noindex) {
    reply.header("x-robots-tag", "noindex");
  }
  return reply.type("text/html; charset=utf-8").status(status).send(body);
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value[0] : value;
}

function slugFromPermalink(permalink: string): string {
  const parts = permalink.split("/").filter(Boolean);
  if (parts[0] === "r" && parts[2] === "comments" && parts[4] !== undefined && parts[4] !== "") {
    return `/${parts[4]}`;
  }
  return "";
}

function errorTitle(code: ErrorCode): string {
  switch (code) {
    case "not_found":
      return "Thread not found";
    case "subreddit_private":
      return "Private subreddit";
    case "subreddit_quarantined":
      return "Quarantined subreddit";
    default:
      return "Could not unroll";
  }
}

function errorCopy(code: ErrorCode, message: string): string {
  switch (code) {
    case "not_found":
      return "This thread was deleted or does not exist.";
    case "subreddit_private":
      return "This subreddit is private.";
    case "subreddit_quarantined":
      return "This subreddit is quarantined.";
    default:
      return message;
  }
}

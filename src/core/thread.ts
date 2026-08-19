import type {
  ErrorCode,
  RedditComment,
  RedditPost,
  SearchSort,
  ThreadData,
  ThreadSort,
} from "../types.js";

export const DEFAULT_MAX_COMMENTS = 500;
export const MAX_COMMENTS_CAP = 1000;
export const MORE_BATCH_SIZE = 100;
export const CREDIT_EXPAND_THRESHOLD = 400;

export type ThreadRef = {
  postId: string;
  subreddit: string | null;
  permalink: string;
};

export type AdapterFailure = {
  ok: false;
  code: ErrorCode;
  message?: string;
};

export type AdapterThreadOk = {
  ok: true;
  listing: unknown;
};

export type AdapterMoreOk = {
  ok: true;
  things: unknown[];
};

export type AdapterListingOk = {
  ok: true;
  listing: unknown;
};

export type ListingFetchInput = {
  subreddit: string;
  sort: "hot" | "new" | "top" | "latest";
  t?: "day" | "week" | "month" | "year" | "all";
  cursor?: string;
  limit: number;
};

export type SearchFetchInput = {
  q: string;
  subreddit?: string;
  sort: SearchSort;
  cursor?: string;
  limit: number;
};

export type RedditAdapter = {
  fetchThread(ref: ThreadRef, sort: ThreadSort): Promise<AdapterThreadOk | AdapterFailure>;
  fetchMoreChildren(
    linkId: string,
    children: string[],
    sort: ThreadSort,
  ): Promise<AdapterMoreOk | AdapterFailure>;
  fetchListing(input: ListingFetchInput): Promise<AdapterListingOk | AdapterFailure>;
  fetchSearch(input: SearchFetchInput): Promise<AdapterListingOk | AdapterFailure>;
};

export type UnrollInput = {
  url: string;
  maxComments: number;
  sort: ThreadSort;
};

export type UnrollOk = {
  ok: true;
  data: ThreadData;
  credits: 1 | 2;
  truncated: boolean;
  upstreamMs: number;
};

export type UnrollErr = {
  ok: false;
  code: ErrorCode;
  message: string;
};

export type UnrollResult = UnrollOk | UnrollErr;

export type PostOk = {
  ok: true;
  data: RedditPost;
  credits: 1;
  upstreamMs: number;
};

export type PostResult = PostOk | UnrollErr;

const POST_ID = /^[A-Za-z0-9]+$/;

type MoreJob = {
  parentId: string;
  children: string[];
};

type MutableComment = RedditComment & { parentId: string };

const THREAD_PATH =
  /^(?:https?:\/\/)?(?:www\.|old\.|np\.|new\.)?reddit\.com(\/r\/[^/?#]+\/comments\/[a-z0-9]+(?:\/[^/?#]*)*)\/?$/i;
const COMMENTS_ONLY_PATH =
  /^(?:https?:\/\/)?(?:www\.|old\.|np\.|new\.)?reddit\.com(\/comments\/[a-z0-9]+(?:\/[^/?#]*)*)\/?$/i;

export function parseRedditThreadUrl(raw: string): ThreadRef | null {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }

  let pathname: string;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withScheme);
    const host = parsed.hostname.toLowerCase();
    if (host !== "reddit.com" && !host.endsWith(".reddit.com")) {
      return null;
    }
    pathname = parsed.pathname;
  } catch {
    return null;
  }

  const path = pathname.replace(/\/+$/, "") || "/";
  const full = `reddit.com${path}`;
  const match = THREAD_PATH.exec(full) ?? COMMENTS_ONLY_PATH.exec(full);
  if (match === null) {
    return null;
  }

  const permalink = match[1] ?? "";
  const parts = permalink.split("/").filter(Boolean);
  let subreddit: string | null = null;
  let postId: string | undefined;
  if (parts[0] === "r" && parts[2] === "comments") {
    subreddit = parts[1] ?? null;
    postId = parts[3];
  } else if (parts[0] === "comments") {
    postId = parts[1];
  }
  if (postId === undefined || postId === "") {
    return null;
  }

  return { postId: postId.toLowerCase(), subreddit, permalink };
}

export function creditsForCommentCount(commentCount: number): 1 | 2 {
  return commentCount <= CREDIT_EXPAND_THRESHOLD ? 1 : 2;
}

export function normalizePostId(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  const id = trimmed.replace(/^t3_/i, "").toLowerCase();
  if (!POST_ID.test(id)) {
    return null;
  }
  return id;
}

export async function getPost(adapter: RedditAdapter, id: string): Promise<PostResult> {
  const postId = normalizePostId(id);
  if (postId === null) {
    return { ok: false, code: "invalid_request", message: "id must be a Reddit post id (abc123 or t3_abc123)." };
  }

  const started = performance.now();
  const fetched = await adapter.fetchThread({ postId, subreddit: null, permalink: `/comments/${postId}` }, "best");
  if (!fetched.ok) {
    return { ok: false, code: fetched.code, message: fetched.message ?? defaultMessage(fetched.code) };
  }

  const parsed = parseThreadListing(fetched.listing);
  if (!parsed.ok) {
    return parsed;
  }

  return {
    ok: true,
    data: parsed.post,
    credits: 1,
    upstreamMs: Math.max(0, Math.round(performance.now() - started)),
  };
}

export async function unrollThread(adapter: RedditAdapter, input: UnrollInput): Promise<UnrollResult> {
  const ref = parseRedditThreadUrl(input.url);
  if (ref === null) {
    return { ok: false, code: "invalid_request", message: "url must be a reddit.com or old.reddit permalink." };
  }

  const started = performance.now();
  const fetched = await adapter.fetchThread(ref, input.sort);
  if (!fetched.ok) {
    return { ok: false, code: fetched.code, message: fetched.message ?? defaultMessage(fetched.code) };
  }

  const parsed = parseThreadListing(fetched.listing);
  if (!parsed.ok) {
    return parsed;
  }

  const comments: MutableComment[] = [];
  const byId = new Map<string, MutableComment>();
  const moreQueue: MoreJob[] = [];
  let truncated = false;

  const budget = { left: input.maxComments };
  truncated = walkListing(parsed.commentChildren, parsed.post.id, comments, byId, moreQueue, budget) || truncated;

  const linkId = parsed.post.id;
  while (budget.left > 0 && moreQueue.length > 0) {
    const batch = takeMoreBatch(moreQueue, MORE_BATCH_SIZE);
    if (batch.length === 0) {
      truncated = true;
      break;
    }
    const more = await adapter.fetchMoreChildren(linkId, batch, input.sort);
    if (!more.ok) {
      return { ok: false, code: more.code, message: more.message ?? defaultMessage(more.code) };
    }
    truncated =
      applyMoreThings(more.things, comments, byId, moreQueue, budget) || truncated;
  }

  if (moreQueue.length > 0) {
    truncated = true;
  }

  const tree = nestComments(comments, parsed.post.id);
  const data: ThreadData = {
    post: parsed.post,
    comments: tree,
    commentCount: comments.length,
  };

  return {
    ok: true,
    data,
    credits: creditsForCommentCount(data.commentCount),
    truncated,
    upstreamMs: Math.max(0, Math.round(performance.now() - started)),
  };
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

function parseThreadListing(listing: unknown):
  | { ok: true; post: RedditPost; commentChildren: unknown[] }
  | UnrollErr {
  if (!Array.isArray(listing) || listing.length < 2) {
    return { ok: false, code: "upstream_blocked", message: "Unexpected thread payload." };
  }
  const postListing = asRecord(listing[0]);
  const commentListing = asRecord(listing[1]);
  const postChildren = listingChildren(postListing);
  const postThing = postChildren[0];
  if (postThing === undefined) {
    return { ok: false, code: "not_found", message: "Not found." };
  }
  const kind = asRecord(postThing)?.kind;
  const postData = asRecord(asRecord(postThing)?.data);
  if (kind !== "t3" || postData === null) {
    return { ok: false, code: "not_found", message: "Not found." };
  }
  if (isRemovedPost(postData)) {
    return { ok: false, code: "not_found", message: "Not found." };
  }
  return {
    ok: true,
    post: mapRedditPost(postData),
    commentChildren: listingChildren(commentListing),
  };
}

function isRemovedPost(data: Record<string, unknown>): boolean {
  if (data.removed_by_category !== undefined && data.removed_by_category !== null) {
    return true;
  }
  const author = typeof data.author === "string" ? data.author : "";
  const selftext = typeof data.selftext === "string" ? data.selftext : "";
  return author === "[deleted]" && selftext === "[removed]";
}

export function mapRedditPost(data: Record<string, unknown>): RedditPost {
  const id = fullname(data, "t3");
  const permalink = typeof data.permalink === "string" ? data.permalink : `/comments/${stripPrefix(id)}/`;
  const author = typeof data.author === "string" && data.author !== "" ? data.author : "[deleted]";
  const selftext = typeof data.selftext === "string" ? data.selftext : "";
  return {
    id,
    subreddit: typeof data.subreddit === "string" ? data.subreddit : "",
    title: typeof data.title === "string" ? data.title : "",
    author: author === "[deleted]" ? "[deleted]" : author,
    selftext,
    selftextMarkdown: selftext,
    url: typeof data.url === "string" ? data.url : permalink,
    permalink,
    score: hiddenScore(data) ? null : asNumber(data.score),
    createdAt: isoFromUtc(data.created_utc),
    nsfw: Boolean(data.over_18),
    spoiler: Boolean(data.spoiler),
    locked: Boolean(data.locked),
    flair: typeof data.link_flair_text === "string" ? data.link_flair_text : null,
  };
}

function walkListing(
  children: unknown[],
  parentId: string,
  out: MutableComment[],
  byId: Map<string, MutableComment>,
  moreQueue: MoreJob[],
  budget: { left: number },
): boolean {
  let truncated = false;
  for (const child of children) {
    const thing = asRecord(child);
    if (thing === null) {
      continue;
    }
    if (thing.kind === "more") {
      enqueueMore(asRecord(thing.data), parentId, moreQueue);
      continue;
    }
    if (thing.kind !== "t1") {
      continue;
    }
    if (budget.left <= 0) {
      truncated = true;
      continue;
    }
    const mapped = mapComment(asRecord(thing.data), parentId);
    if (mapped === null) {
      continue;
    }
    budget.left -= 1;
    out.push(mapped);
    byId.set(mapped.id, mapped);
    const replies = replyChildren(asRecord(thing.data));
    truncated = walkListing(replies, mapped.id, out, byId, moreQueue, budget) || truncated;
  }
  return truncated;
}

function applyMoreThings(
  things: unknown[],
  out: MutableComment[],
  byId: Map<string, MutableComment>,
  moreQueue: MoreJob[],
  budget: { left: number },
): boolean {
  let truncated = false;
  for (const raw of things) {
    const thing = asRecord(raw);
    if (thing === null) {
      continue;
    }
    if (thing.kind === "more") {
      const data = asRecord(thing.data);
      const parentId = typeof data?.parent_id === "string" ? data.parent_id : "";
      enqueueMore(data, parentId, moreQueue);
      continue;
    }
    if (thing.kind !== "t1") {
      continue;
    }
    if (budget.left <= 0) {
      truncated = true;
      break;
    }
    const data = asRecord(thing.data);
    const parentId = typeof data?.parent_id === "string" ? data.parent_id : "";
    const mapped = mapComment(data, parentId);
    if (mapped === null) {
      continue;
    }
    if (byId.has(mapped.id)) {
      continue;
    }
    budget.left -= 1;
    out.push(mapped);
    byId.set(mapped.id, mapped);
    const replies = replyChildren(data);
    truncated = walkListing(replies, mapped.id, out, byId, moreQueue, budget) || truncated;
  }
  return truncated;
}

function mapComment(data: Record<string, unknown> | null, parentId: string): MutableComment | null {
  if (data === null) {
    return null;
  }
  const id = fullname(data, "t1");
  if (id === "t1_") {
    return null;
  }
  const rawAuthor = typeof data.author === "string" && data.author !== "" ? data.author : "[deleted]";
  const rawBody = typeof data.body === "string" ? data.body : "";
  const status = commentStatus(data, rawBody);
  const author = status === "deleted" ? "[deleted]" : rawAuthor;
  const body = status === "visible" ? rawBody : "";
  return {
    id,
    parentId,
    author,
    body,
    bodyMarkdown: body,
    score: hiddenScore(data) ? null : asNumber(data.score),
    createdAt: isoFromUtc(data.created_utc),
    distinguished: distinguishedOf(data.distinguished),
    status,
    replies: [],
  };
}

function commentStatus(data: Record<string, unknown>, body: string): RedditComment["status"] {
  if (body === "[deleted]") {
    return "deleted";
  }
  if (
    body === "[removed]" ||
    body === "[removed by moderator]" ||
    (data.removed_by_category !== undefined && data.removed_by_category !== null)
  ) {
    return "removed";
  }
  return "visible";
}

function nestComments(flat: MutableComment[], postId: string): RedditComment[] {
  const roots: RedditComment[] = [];
  const byId = new Map<string, RedditComment>();
  for (const comment of flat) {
    const node: RedditComment = {
      id: comment.id,
      author: comment.author,
      body: comment.body,
      bodyMarkdown: comment.bodyMarkdown,
      score: comment.score,
      createdAt: comment.createdAt,
      distinguished: comment.distinguished,
      status: comment.status,
      replies: [],
    };
    byId.set(node.id, node);
  }
  for (const comment of flat) {
    const node = byId.get(comment.id);
    if (node === undefined) {
      continue;
    }
    if (comment.parentId === postId || !byId.has(comment.parentId)) {
      roots.push(node);
      continue;
    }
    byId.get(comment.parentId)?.replies.push(node);
  }
  return roots;
}

function enqueueMore(data: Record<string, unknown> | null, parentId: string, moreQueue: MoreJob[]): void {
  if (data === null) {
    return;
  }
  const count = asNumber(data.count) ?? 0;
  const children = Array.isArray(data.children)
    ? data.children.filter((id): id is string => typeof id === "string" && id !== "")
    : [];
  if (count <= 0 && children.length === 0) {
    return;
  }
  moreQueue.push({
    parentId: typeof data.parent_id === "string" ? data.parent_id : parentId,
    children,
  });
}

function takeMoreBatch(moreQueue: MoreJob[], limit: number): string[] {
  const batch: string[] = [];
  while (moreQueue.length > 0 && batch.length < limit) {
    const job = moreQueue[0];
    if (job === undefined) {
      break;
    }
    if (job.children.length === 0) {
      moreQueue.shift();
      continue;
    }
    const take = job.children.splice(0, limit - batch.length);
    batch.push(...take);
    if (job.children.length === 0) {
      moreQueue.shift();
    }
  }
  return batch;
}

function listingChildren(listing: Record<string, unknown> | null): unknown[] {
  const data = asRecord(listing?.data);
  return Array.isArray(data?.children) ? data.children : [];
}

function replyChildren(data: Record<string, unknown> | null): unknown[] {
  if (data === null) {
    return [];
  }
  if (data.replies === "" || data.replies === undefined || data.replies === null) {
    return [];
  }
  return listingChildren(asRecord(data.replies));
}

function fullname(data: Record<string, unknown>, prefix: "t1" | "t3"): string {
  if (typeof data.name === "string" && data.name.startsWith(`${prefix}_`)) {
    return data.name;
  }
  if (typeof data.id === "string" && data.id.startsWith(`${prefix}_`)) {
    return data.id;
  }
  if (typeof data.id === "string" && data.id !== "") {
    return `${prefix}_${data.id}`;
  }
  return `${prefix}_`;
}

function stripPrefix(id: string): string {
  return id.replace(/^t[13]_/, "");
}

function hiddenScore(data: Record<string, unknown>): boolean {
  return data.hide_score === true || data.score_hidden === true;
}

function distinguishedOf(value: unknown): RedditComment["distinguished"] {
  if (value === "moderator" || value === "admin") {
    return value;
  }
  return null;
}

function isoFromUtc(value: unknown): string {
  const seconds = asNumber(value);
  if (seconds === null) {
    return new Date(0).toISOString();
  }
  return new Date(seconds * 1000).toISOString();
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

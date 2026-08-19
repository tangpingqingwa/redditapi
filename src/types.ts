export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "payment_required"
  | "subreddit_quarantined"
  | "subreddit_private"
  | "not_found"
  | "rate_limited"
  | "upstream_blocked"
  | "internal";

export type OkMeta = {
  cached: boolean;
  creditsCharged: number;
  requestId: string;
  upstreamMs: number;
  truncated?: boolean;
};

export type ThreadSort = "best" | "new" | "top" | "qa";

export type CommentStatus = "visible" | "deleted" | "removed";

export type RedditPost = {
  id: string;
  subreddit: string;
  title: string;
  author: string | "[deleted]";
  selftext: string;
  selftextMarkdown: string;
  url: string;
  permalink: string;
  score: number | null;
  createdAt: string;
  nsfw: boolean;
  spoiler: boolean;
  locked: boolean;
  flair: string | null;
};

export type RedditComment = {
  id: string;
  author: string | "[deleted]";
  body: string;
  bodyMarkdown: string;
  score: number | null;
  createdAt: string;
  distinguished: "moderator" | "admin" | null;
  status: CommentStatus;
  replies: RedditComment[];
};

export type ThreadData = {
  post: RedditPost;
  comments: RedditComment[];
  commentCount: number;
};

export type Ok<T> = {
  data: T;
  meta: OkMeta;
};

export type Err = {
  error: { code: ErrorCode; message: string; retryable: boolean };
  meta: { creditsCharged: 0; requestId: string };
};

export type KeyPrefix = "rk_live" | "rk_test";

export type KeyRecord = {
  id: string;
  prefix: KeyPrefix;
  hash: string;
  plan: string;
  credits: number;
  rpm: number;
  createdAt: string;
};

export type MeData = {
  id: string;
  prefix: KeyPrefix;
  plan: string;
  creditsRemaining: number;
  rpm: number;
};

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

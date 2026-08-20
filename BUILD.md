# RedditAPI — Detailed Specification and Build Plan

**Contract:** [SPEC.md](./SPEC.md)  
**Git:** [CONTRIBUTING.md](./CONTRIBUTING.md)

Same envelope, keys, and credit rules as ClipAPI. **Copy those modules, do not publish a shared private package in v1** (duplicate ~200 LOC; keep repos independent). Prefix keys `rk_live_` / `rk_test_`.

---

## 1. Stack

Identical to ClipAPI: Node 22, TS strict, Fastify, Zod, SQLite, `node:test`.

Plus: HTML unroller views (same process, different routes).

---

## 2. Architecture

```
REST / MCP / HTML unroller
        │
   core/thread.ts   expand MoreComments up to cap
        │
   adapters/reddit/   old.reddit JSON or oauth-less public JSON
        │
   fixture | live
```

HTTP/MCP/HTML call `core` only.

---

## 3. Thread expansion algorithm

Input: permalink URL or `t3_` id + `max_comments` (default 500, max 1000).

1. Fetch post + first comment page.
2. Walk tree. For each `more` node with `count > 0`, enqueue `children` ids.
3. Fetch `/api/morechildren` (or fixture equivalent) in batches of 100 until:
   - no more, or
   - `visibleComments >= max_comments`
4. If stopped early: `meta.truncated = true`. Credits: 1 if final `commentCount <= 400` else 2 (SPEC).
5. Map each node (`author` and `status` are independent):
   - `body === '[deleted]'` → `status: deleted`, empty body, author `[deleted]`
   - `body === '[removed]'` / `[removed by moderator]` or `removed_by_category` set → `status: removed`, empty body (keep author)
   - author `[deleted]` with a real body stays `visible`
   - else `visible`
6. **Never** invent body text for deleted/removed.

Cache key: `(postId, sort, max_comments)` TTL 2–15 min. ETag = hash(body).

---

## 4. Types (comments)

```ts
type RedditComment = {
  id: string;
  author: string | "[deleted]";
  body: string;
  bodyMarkdown: string;
  score: number | null;
  createdAt: string;
  distinguished: "moderator" | "admin" | null;
  status: "visible" | "deleted" | "removed";
  replies: RedditComment[];
};
```

---

## 5. Unroller HTML

- `/` paste
- `/r/{sub}/comments/{id}/{slug?}` 
- Same core as API
- Ads slots + CTA to `/#pricing` of API
- Index successful threads; noindex errors

---

## 6. Tests

Fixtures: small thread; thread with `more`; deleted child; private sub → 403; latest 0 credits.

`scripts/test.sh` → tsc + node:test after PR 1.

---

## 7. PR plan

### PR 1: Skeleton + envelope + keys
- **Description:** Clone ClipAPI PR1–2 pattern: healthz, sqlite, `rk_` keys, `/v1/me`.
- **Files:** package.json, tsconfig, src/server.ts, db, auth, envelope, tests/envelope.test.ts, scripts/test.sh
- **Dependencies:** None

### PR 2: Thread by-url + expansion + statuses
- **Description:** core/thread + fixture adapter covering more/deleted/removed.
- **Files:** src/core/thread.ts, adapters/reddit/fixture.ts, routes/threads.ts, tests/thread.test.ts, fixtures/*.json, openapi snippet
- **Dependencies:** PR 1
- **Acceptance:** SPEC acceptance 1–4.

### PR 3: HTML unroller
- **Description:** `/` and permalink HTML, noindex on errors, legal footer.
- **Files:** src/views/*, public/*, tests/html.test.ts
- **Dependencies:** PR 2
- **Acceptance:** SPEC 7.

### PR 4: listings + latest
- **Description:** `/v1/r/:sub/hot|new|top`, `/latest` 0 credits.
- **Files:** core/listings.ts, routes, tests
- **Dependencies:** PR 2
- **Acceptance:** SPEC 6, private sub 403.

### PR 5: search + MCP
- **Description:** search + MCP tools unroll_thread, get_post, list_subreddit, search_reddit, get_latest.
- **Files:** core/search.ts, src/mcp/*, tests
- **Dependencies:** PR 4

### Follow-up: live Reddit adapter
- **Description:** Env-gated public JSON adapter. Tries `old.reddit` then `www.reddit.com/.json`. Default remains fixtures. `REDDITAPI_LIVE=1` selects live. Login-wall / 403 HTML / `lor2` map to `upstream_blocked` (never `not_found`, never invented comments). After a www HTML wall, complete Reddit’s public JS challenge, keep `token_v2`, and retry JSON. Other failures map to SPEC codes and charge 0. Not required in CI.
- **Files:** src/adapters/reddit/live.ts, src/adapters/reddit/index.ts, src/config.ts, tests/live-adapter.test.ts, scripts/test.sh
- **Dependencies:** PR 5

### Follow-up: live smoke (operator only)
- **Description:** `REDDITAPI_LIVE=1` local process walks unroll, post-only, listing, search, and a private/removed case. Record PASS / PASS-ERROR / FAIL. Not required for `main`.
- **Files:** `scripts/live-smoke.sh`, `docs/live-smoke.md`
- **Dependencies:** live Reddit adapter
- **Acceptance:** script is not called from `scripts/test.sh` or Actions. CI must not set `REDDITAPI_LIVE`.


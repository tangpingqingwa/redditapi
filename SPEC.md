# RedditAPI — Product Development Spec

**Version:** 1.0  
**Status:** Ready to build  
**Repo:** https://github.com/tangpingqingwa/redditapi  
**Clients:** DailyBrief, SkillSeed, first-party free unroller on same origin or `redditunroll.com`

Self-serve thread trees after Reddit’s 2023 API pricing locked out indies.

---

## 1. Product statement

Read-only REST + MCP for public Reddit posts, nested comments, subreddit listings, and search.

One-line pitch: **Unroll a 500-comment thread in one call. $5/mo. Failures are free.**

---

## 2. Goals and non-goals

### Goals

- One call returns the post + expanded comment tree (MoreComments resolved up to a documented cap).
- Deleted / removed / [removed by moderator] nodes are **marked**, never filled in.
- Official Reddit JSON / old.reddit / whatever works this month stays behind the adapter.
- Free HTML unroller for SEO + ads; same backend as the API.
- 100 free credits, $5 / 1,000, annual $54.

### Non-goals

- Vote, comment, post, mod, awards.
- Private, banned, or password subs.
- Firehose / historical Pushshift dump.
- “Grow my subreddit” automation.

---

## 3. Auth and envelope

Same conventions as ClipAPI:

- `Authorization: Bearer rk_live_...`
- Success `{ data, meta }`; error `{ error, meta.creditsCharged: 0 }`
- Shared error codes plus:

| code | HTTP | meaning |
|---|---|---|
| `subreddit_quarantined` | 403 | public listing blocked without explicit opt-in we will not do |
| `subreddit_private` | 403 | not public |
| `comment_cap` | 200* | tree truncated; see `meta.truncated` |

\*HTTP 200 with `meta.truncated = true` and `meta.creditsCharged` as documented. Do not 206.

---

## 4. Endpoints

### 4.1 `GET /v1/threads/by-url`

**Credits:** 1 if `commentCount <= 400`; 2 if we expand beyond that, max 2.

Query: `url` (reddit.com or old.reddit permalink), optional `max_comments` (default 500, max 1000), `sort` (`best` \| `new` \| `top` \| `qa`).

`data`:

```ts
{
  post: RedditPost
  comments: RedditComment[]   // nested via replies[]
  commentCount: number
}
```

```ts
type RedditPost = {
  id: string            // t3_...
  subreddit: string
  title: string
  author: string | "[deleted]"
  selftext: string
  selftextMarkdown: string
  url: string           // outbound or permalink
  permalink: string
  score: number | null  // null if hidden
  createdAt: string
  nsfw: boolean
  spoiler: boolean
  locked: boolean
  flair: string | null
}

type RedditComment = {
  id: string            // t1_...
  author: string | "[deleted]"
  body: string
  bodyMarkdown: string
  score: number | null
  createdAt: string
  distinguished: "moderator" | "admin" | null
  status: "visible" | "deleted" | "removed"
  replies: RedditComment[]
}
```

`status: deleted` → body empty, author `[deleted]`. Never reconstruct.

### 4.2 `GET /v1/posts/{id}`

Post only. Credits: 1. `id` accepts `abc123` or `t3_abc123`.

### 4.3 `GET /v1/r/{sub}/hot` `.../new` `.../top`

Credits: 1 per page. Query: `t` for top (`day`/`week`/`month`/`year`/`all`), `cursor`, `limit` (1–100).

### 4.4 `GET /v1/search`

Credits: 1 per page with hits; empty = 0. Query: `q`, optional `sub`, `sort`, `cursor`.

### 4.5 `GET /v1/r/{sub}/latest`

Credits: 0. Newest posts, ~25. Monitor hook for DailyBrief.

### 4.6 Control plane

`/v1/me`, `/v1/usage`, `/healthz`.

---

## 5. Free unroller site

Path: `/` paste box; `/r/{sub}/comments/{id}/{slug?}` HTML.

- Same adapter as API.
- Ads + `noindex` on errors.
- Footer CTA to API pricing.
- Independent / not affiliated copy.
- No JSON on the www host except optional `__NEXT_DATA__` for the page itself.

---

## 6. Caching

| Resource | TTL | Notes |
|---|---|---|
| Thread | 2–15 min, ETag | comments change |
| Post-only | 15 min | |
| Listings | 2 min | |
| Latest | 2 min | |
| Search | 5 min | |

Honor Reddit `Retry-After`. Global concurrency cap. Ban = P0 outage, not a growth tactic.

User-Agent: identify this service + contact email (polite). One egress IP documented internally.

---

## 7. Billing

Identical numbers to ClipAPI ($0 / $5 / $54). Separate Stripe product. Do not share credit pools across products in v1 (simpler support).

---

## 8. MCP

Tools: `unroll_thread`, `get_post`, `list_subreddit`, `search_reddit`, `get_latest`.

Skill must say: do not use for voting or posting; private subs will 403; trees may truncate.

---

## 9. Acceptance

| # | Case | Expected |
|---|---|---|
| 1 | Short thread <50 comments | full tree, 1 credit |
| 2 | Thread with MoreComments | expanded to cap, `truncated` if needed |
| 3 | Deleted comment in tree | `status=deleted`, empty body |
| 4 | Removed post | 404 or post `removed` — pick one and test it; prefer 404 `not_found` if listing gone |
| 5 | Private sub | 403 `subreddit_private`, 0 credit |
| 6 | `latest` | 0 credit |
| 7 | Unroller HTML contains comment text | SEO |
| 8 | Repeat by-url within TTL | ETag / cached |

---

## 10. Milestones

**M1:** by-url + comment expand + statuses.  
**M2:** unroller HTML + ads + legal.  
**M3:** listings + latest; keys; Stripe.  
**M4:** search + MCP.  

Launch = M3.

---

## 11. Legal

Read-only public pages. Customer ToS: no harassment, no deanonymization products, no using us to evade a ban. We will drop keys that look like vote brigades (write-shaped traffic).

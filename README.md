# RedditAPI

Threads, comments, subreddit listings, and search as a self-serve REST + MCP.

Reddit’s own API is alive and priced for companies. This product exists for everyone who got cut off in 2023 and never came back.

## Why this, and why overseas

The English indie internet still runs on Reddit. Support bots, trend agents, “what is HN+Reddit saying about X,” and comment-to-newsletter tools all need structured threads. Official free access is gone; documented paid tiers start where a weekend project cannot follow. Pushshift-shaped replacements are either dead or hostile.

Search is already there: `reddit api alternative 2026`, `reddit comment api`, `pull reddit thread json`.

## Exact demand

- Who: indie SaaS, research agents, DailyBrief, SEO people watching subreddits
- Input: post URL, `r/name`, username, search query
- Output: a stable thread tree (post + nested comments), listings, search hits
- Acceptance: unroll a 500-comment thread in one call; deleted/removed nodes marked, not invented; failures 0 credits

## Exact connector

| Endpoint | Job | Credits |
|---|---|---|
| `/v1/threads/by-url` | Full post + comment tree | 1 (large threads may be 2) |
| `/v1/posts/{id}` | Post only | 1 |
| `/v1/r/{sub}/hot` `/new` `/top` | Listing page | 1 |
| `/v1/search` | Site or subreddit search | 1 / page |
| `/v1/r/{sub}/latest` | Monitor hook | free |

Old Reddit / JSON fallbacks / whatever works this month stay behind the contract. Callers never pin a selector.

## Exact combination

- Free site: paste a Reddit link, read the whole thread as clean text (ads + SEO), same move as TikTokToTranscript
- Paid API at $5 / mo / 1,000
- Evergreen post: `Reddit API pricing after the 2023 changes`
- MCP tools: `unroll_thread`, `search_reddit`, `list_subreddit`
- DailyBrief source: “these five subreddits, one morning mail”

## Cost control

- Threads change; cache short (2–15 min) with ETag
- Listings even shorter
- Media as URLs only
- One box + polite concurrency; getting banned is a product outage, not a growth hack
- Failures and quarantined subs: 0 credits + a reason code

## Business model

Free unroller ads + credit API. Do not compete with Brandwatch. Compete with “I will not pay Reddit’s official bill to unroll one thread.”

Success: the free page can rank for `reddit thread unroller`; API at $1k MRR; DailyBrief’s Reddit sources never scrape on their own.

## Will not do

- No vote, post, or mod actions
- No bypass for private / quarantined-without-access subs
- No full firehose
- No “grow my subreddit” automation

## First two weeks

1. Shared backend for the free unroller and `by-url`
2. Nested comments, MoreComments expansion, removed/deleted
3. OpenAPI + one MCP tool
4. Pricing page vs. official Reddit API tiers

## Dogfood

Competitive research, launch feedback, and “what r/SaaS thinks of X” all go through RedditAPI. If we still click Continue thread in a browser, this is not shipped.

## Risk

ToS and IP bans. Product language is read-only public content. Rate yourself harder than you rate customers. When Reddit changes JSON, tests go red before Twitter does.

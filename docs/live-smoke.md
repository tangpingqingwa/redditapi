# Live smoke — Reddit unroll + listing + search

Operator-only. `bash scripts/live-smoke.sh` is **not** called from `scripts/test.sh` or GitHub Actions. `REDDITAPI_LIVE` stays unset in CI.

Ran this session against a local process with `REDDITAPI_LIVE=1` (temp SQLite + bootstrap `rk_test_live_smoke_local`). Egress was this machine’s public IP. The live adapter still tries `old.reddit.com` JSON first, then `www.reddit.com` JSON. Redirects are not followed into `/login`. A www HTML wall is treated as a public JS challenge: the adapter solves `e+e`, stores `token_v2`, and retries JSON.

| Field | Value |
|---|---|
| Date | 2026-08-20 |
| SHA | `feat/live-smoke` (this PR) |
| Command | `bash scripts/live-smoke.sh` |
| Base | `http://127.0.0.1:<ephemeral>` started by the script |
| Flag | `REDDITAPI_LIVE=1` only |
| User-Agent | `redditapi/0.1 (+https://github.com/tangpingqingwa/redditapi; contact@redditapi.dev)` |

## Cases

| case | verdict | detail |
|---|---|---|
| unroll public thread | PASS | `GET /v1/threads/by-url` for `https://www.reddit.com/r/pics/comments/92dd8/test_post_please_ignore/` → HTTP 200, `post=t3_92dd8`, title `test post please ignore`, `comments=50`, `creditsCharged=1`. First comment `t1_c0b6xx0` author `Kharos`, body starts `Don't tell me what to do!` |
| GET post-only | PASS | `GET /v1/posts/92dd8` → HTTP 200, `id=t3_92dd8`, title `test post please ignore`, `creditsCharged=1`, no comments field |
| sub listing | PASS | `GET /v1/r/pics/hot?limit=5` → HTTP 200, `posts=5`, first `t3_1vt0u4g` title `You can cover your faces, we can still tell you’re pigs! [OC]`, `creditsCharged=1` |
| search | PASS | `GET /v1/search?q=cats&limit=5` → HTTP 200, `hits=5`, first `t3_1smpzom` title `Children and cats`, `creditsCharged=1` |
| private or gated sub | PASS-ERROR | `GET /v1/r/lounge/hot?limit=5` → HTTP 403 `subreddit_private`, `creditsCharged=0` (`gold_only` JSON after session) |
| removed or missing post | PASS-ERROR | `GET /v1/posts/thispostdoesnotexist999` → HTTP 404 `not_found`, `creditsCharged=0` (JSON `{ "error": 404 }`) |

**Totals:** PASS=4 PASS-ERROR=2 FAIL=0  
**RESULT: PASS**

Titles and comment text above were returned by Reddit on this run. Nothing was invented.

## What the process actually saw

Direct probes from this host (same UA) before the JS-challenge session:

- `old.reddit.com/...json` → HTTP 302 `Location: /login/?reason=lor2` (login wall, empty body). Adapter does **not** follow that redirect.
- Bare `www.reddit.com/.json` (no session) → HTTP 403 HTML interstitial (`text/html`, ~190k).
- `GET https://www.reddit.com/` HTML includes a `js_challenge` form (`await (async e=>e+e)("…")` + hidden `token`). Completing it sets `token_v2`. Retrying `.json` then returns public JSON.

After the session:

- Thread JSON for `t3_92dd8` → HTTP 200, title `test post please ignore`.
- Listing JSON `/r/pics/hot.json` → HTTP 200, first title as in the table.
- Search JSON `q=cats` → HTTP 200, first title `Children and cats`.
- `/r/lounge/hot.json` → HTTP 403 JSON `{ "reason": "gold_only", "error": 403 }` → SPEC `subreddit_private`, 0 credits.
- Missing post JSON → HTTP 404 `{ "error": 404 }` → SPEC `not_found`, 0 credits.

Login-wall / 403 HTML / `lor2` still map to `upstream_blocked`, never `not_found`, never invented comments. A true missing listing (JSON `{ "error": 404 }`) stays `not_found`.

## Re-run

```bash
# starts its own server
bash scripts/live-smoke.sh

# or attach to an already-live box
LIVE_SMOKE_BASE=http://127.0.0.1:3000 \
LIVE_SMOKE_KEY=rk_test_... \
bash scripts/live-smoke.sh
```

Overrides: `LIVE_SMOKE_THREAD_URL`, `LIVE_SMOKE_POST_ID`, `LIVE_SMOKE_SUB`, `LIVE_SMOKE_SEARCH_Q`, `LIVE_SMOKE_PRIVATE_SUB`, `LIVE_SMOKE_REMOVED_ID`.

Do not set `REDDITAPI_LIVE=1` in `.github/workflows/ci.yml`. Offline gate remains `bash scripts/test.sh`.

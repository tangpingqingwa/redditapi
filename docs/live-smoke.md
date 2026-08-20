# Live smoke — Reddit unroll + listing + search

Operator-only. `bash scripts/live-smoke.sh` is **not** called from `scripts/test.sh` or GitHub Actions. `REDDITAPI_LIVE` stays unset in CI.

Ran this session against a local process with `REDDITAPI_LIVE=1` (temp SQLite + bootstrap `rk_test_live_smoke_local`). Egress was this machine’s public IP. The live adapter now tries `old.reddit.com` JSON first, then `www.reddit.com` JSON with the documented User-Agent. Redirects are not followed into `/login`.

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
| unroll public thread | FAIL | `GET /v1/threads/by-url` for `https://www.reddit.com/r/pics/comments/92dd8/test_post_please_ignore/` → HTTP 503 `upstream_blocked`, `creditsCharged=0` |
| GET post-only | FAIL | `GET /v1/posts/92dd8` → HTTP 503 `upstream_blocked`, `creditsCharged=0` |
| sub listing | FAIL | `GET /v1/r/pics/hot?limit=5` → HTTP 503 `upstream_blocked`, `creditsCharged=0` |
| search | FAIL | `GET /v1/search?q=cats&limit=5` → HTTP 503 `upstream_blocked`, `creditsCharged=0` |
| private or gated sub | PASS-ERROR | `GET /v1/r/lounge/hot?limit=5` → HTTP 503 `upstream_blocked`, `creditsCharged=0` |
| removed or missing post | PASS-ERROR | `GET /v1/posts/thispostdoesnotexist999` → HTTP 503 `upstream_blocked`, `creditsCharged=0` |

**Totals:** PASS=0 PASS-ERROR=2 FAIL=4  
**RESULT: FAIL**

This host cannot complete a real public unroll or listing/search. Do not treat the error-path rows as a live PASS.

## What the process actually saw

Direct probes from this host (same UA) after the adapter fix:

- `old.reddit.com/...json` → HTTP 302 `Location: /login/?reason=lor2` (login wall, empty body). Adapter does **not** follow that redirect.
- `www.reddit.com/.json` and thread/listing/search `.json` → HTTP 403 HTML interstitial (`text/html`, ~190k). Same with a browser-like User-Agent.
- Node `fetch` to `www.reddit.com/.json` (manual and follow) is also 403 HTML. No public JSON body.

The adapter maps login-wall / 403 HTML / `lor2` to SPEC `upstream_blocked` and charges 0. It does **not** map those to `not_found`. Success paths never produced a post title or comment tree. Nothing was invented.

A true missing listing (JSON `{ "error": 404 }`) still maps to `not_found` in offline tests. This egress never received that JSON from Reddit, so the live missing-post case is also `upstream_blocked`.

Private / missing cases still satisfied the error half of the unit: SPEC code, `meta.creditsCharged: 0`. Required public reads did not PASS.

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

# Live smoke — Reddit unroll + listing + search

Operator-only. `bash scripts/live-smoke.sh` is **not** called from `scripts/test.sh` or GitHub Actions. `REDDITAPI_LIVE` stays unset in CI.

Ran this session against a local process with `REDDITAPI_LIVE=1` (temp SQLite + bootstrap `rk_test_live_smoke_local`). Egress was this machine’s public IP to `old.reddit.com` JSON.

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
| unroll public thread | FAIL | `GET /v1/threads/by-url` for `https://www.reddit.com/r/pics/comments/92dd8/test_post_please_ignore/` → HTTP 404 `not_found`, `creditsCharged=0` |
| GET post-only | FAIL | `GET /v1/posts/92dd8` → HTTP 404 `not_found`, `creditsCharged=0` |
| sub listing | FAIL | `GET /v1/r/pics/hot?limit=5` → HTTP 404 `not_found`, `creditsCharged=0` |
| search | FAIL | `GET /v1/search?q=cats&limit=5` → HTTP 404 `not_found`, `creditsCharged=0` |
| private or gated sub | PASS-ERROR | `GET /v1/r/lounge/hot?limit=5` → HTTP 404 `not_found`, `creditsCharged=0` (SPEC error, 0 credits) |
| removed or missing post | PASS-ERROR | `GET /v1/posts/thispostdoesnotexist999` → HTTP 404 `not_found`, `creditsCharged=0` |

**Totals:** PASS=0 PASS-ERROR=2 FAIL=4  
**RESULT: FAIL**

## What the process actually saw

Direct probes from this host (same UA) before the script:

- `old.reddit.com/...json` → HTTP 302 `Location: /login/?reason=lor2` (login wall, empty body).
- `www.reddit.com/...json` → HTTP 403 HTML interstitial.
- Node `fetch` to `old.reddit.com` (the live adapter) follows that 302, then Reddit’s login page is 404 text/`Not Found`. The adapter maps 404 → SPEC `not_found` and charges 0.

So the local process *did* walk every required flow with live flags on. Reddit did not return public JSON from this egress. Success paths never produced a post title or comment tree. Nothing was invented.

Private / missing cases still satisfied the error half of the unit: SPEC code, `meta.creditsCharged: 0`.

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

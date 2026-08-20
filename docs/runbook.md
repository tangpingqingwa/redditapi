# RedditAPI — one-box runbook

Single Docker host. SQLite on a volume. The adapter stays on fixtures until you set `REDDITAPI_LIVE=1`.

## Env

Copy [`.env.example`](../.env.example) to `/etc/redditapi.env` (mode `600`). Set:

| Variable | Production |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | listen port (default `3000`) |
| `REDDITAPI_DATABASE` | volume path, e.g. `/app/data/redditapi.sqlite` |
| `REDDITAPI_BOOTSTRAP_KEY` | optional first `rk_live_...` when the DB is empty |
| `REDDITAPI_LIVE` | leave `0` (or unset) until soak. Only `1` goes live |
| `REDDITAPI_USER_AGENT` | optional; default already identifies the service |

Do not bake secrets into the image. Do not commit `.env`.

## Build and run

```bash
docker build -t redditapi:local .
docker run --rm --name redditapi \
  --env-file /etc/redditapi.env \
  -p 3000:3000 \
  -v redditapi-data:/app/data \
  redditapi:local
```

The process listens on `0.0.0.0:$PORT` as the non-root `node` user.

## Health

`GET /healthz` → `200 {"ok":true}`. No auth.

```bash
curl -fsS "http://127.0.0.1:${PORT:-3000}/healthz"
```

Put TLS on Caddy or nginx in front of `127.0.0.1:$PORT`. After bootstrap:

```bash
curl -fsS -H "Authorization: Bearer $REDDITAPI_BOOTSTRAP_KEY" \
  "http://127.0.0.1:${PORT:-3000}/v1/me"
```

Unroller HTML is the same process (`/` paste box, `/r/{sub}/comments/{id}`).

## Enable live Reddit

1. Confirm `/healthz` is green with live off (fixture adapter).
2. Set `REDDITAPI_LIVE=1` only. `true` / `0` / empty stay on fixtures.
3. Recreate the container. Egress is public `old.reddit` JSON; identify via `REDDITAPI_USER_AGENT`.
4. Private / quarantined / removed / 429 / transport map to SPEC codes and charge 0 credits.
5. Leave the flag unset in CI. `scripts/test.sh` unsets it and fails if `.github/workflows/ci.yml` sets `REDDITAPI_LIVE=1`.

Roll back: set `REDDITAPI_LIVE=0` (or unset) and restart. Do not run live fetch from CI.

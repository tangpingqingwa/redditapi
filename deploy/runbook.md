# Deploy RedditAPI (one VPS)

Single Docker process, SQLite on a host volume. Default adapter is fixtures. Live Reddit is opt-in.

## Box

- Any Docker host (Ubuntu 22.04+ is fine)
- One public egress IP (document it internally; a ban is a P0)
- Map host `80`/`443` (or `$PORT`) to the container

## Env

```bash
git clone https://github.com/tangpingqingwa/redditapi.git
cd redditapi
cp .env.example .env
```

Set at least:

| Variable | Purpose |
|---|---|
| `PORT` | Listen port inside the container (default `3000`) |
| `REDDITAPI_DATABASE` | SQLite file. Use `/app/data/redditapi.sqlite` with the volume below |
| `REDDITAPI_BOOTSTRAP_KEY` | Optional first `rk_live_…` / `rk_test_…` when `keys` is empty |

Leave `REDDITAPI_LIVE` unset or `0` until you are ready. Never commit `.env`.

## Run

```bash
docker build -t redditapi:latest .
mkdir -p /var/lib/redditapi
docker run -d --name redditapi --restart unless-stopped \
  --env-file .env \
  -e PORT=3000 \
  -e REDDITAPI_DATABASE=/app/data/redditapi.sqlite \
  -p 3000:3000 \
  -v /var/lib/redditapi:/app/data \
  redditapi:latest
```

The process binds `0.0.0.0:$PORT`. Put Caddy or nginx in front for TLS.

## Health

```bash
curl -fsS "http://127.0.0.1:${PORT:-3000}/healthz"
# {"ok":true}
```

`GET /healthz` is unauthenticated — use it for Docker / systemd / load-balancer checks. `GET /v1/me` still needs `Authorization: Bearer rk_…`.

## Enable live Reddit

Fixtures stay on until the value is exactly `1`:

```bash
# in .env — 0 / true / unset remain fixtures
REDDITAPI_LIVE=1
REDDITAPI_USER_AGENT=redditapi/0.1 (+https://your.domain; you@your.domain)
```

Then `docker restart redditapi`. Confirm `/healthz` still returns `{"ok":true}`, then call `/v1/threads/by-url` with a public permalink.

Do not set `REDDITAPI_LIVE=1` in CI. Private / quarantined / removed / 429 / network failures charge 0 credits. Login-wall (`/login/?reason=lor2`) and 403 HTML are `upstream_blocked`, not `not_found`. Honor `Retry-After`. Getting banned is an outage, not a growth tactic.

## Data

Back up the SQLite file on the volume. The bootstrap key is inserted only when the `keys` table is empty.

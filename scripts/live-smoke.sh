#!/usr/bin/env bash
# Optional operator smoke against *live* Reddit.
# Not called from scripts/test.sh. Never set REDDITAPI_LIVE in GitHub Actions.
#
# Starts a local process with REDDITAPI_LIVE=1 (or attaches to LIVE_SMOKE_BASE)
# and walks: unroll, post-only, sub listing, search, private/removed.
# Each case is PASS / PASS-ERROR / FAIL. Failures stay 0 credits.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  echo "FAIL: live-smoke must not run in GitHub Actions" >&2
  exit 1
fi

if [[ "${CI:-}" == "true" && "${LIVE_SMOKE_ALLOW_CI:-}" != "1" ]]; then
  echo "FAIL: live-smoke is opt-in and refuses CI unless LIVE_SMOKE_ALLOW_CI=1" >&2
  exit 1
fi

PASS=0
PASS_ERROR=0
FAIL=0
STARTED_PID=""
TMPDIR_SMOKE=""

cleanup() {
  if [[ -n "${STARTED_PID}" ]]; then
    kill "${STARTED_PID}" >/dev/null 2>&1 || true
    wait "${STARTED_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${TMPDIR_SMOKE}" && -d "${TMPDIR_SMOKE}" ]]; then
    rm -rf "${TMPDIR_SMOKE}"
  fi
}
trap cleanup EXIT

fail_msg() {
  echo "FAIL: $*" >&2
}

pick_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

record() {
  local name="$1" verdict="$2" detail="$3"
  case "$verdict" in
    PASS) PASS=$((PASS + 1)) ;;
    PASS-ERROR) PASS_ERROR=$((PASS_ERROR + 1)) ;;
    FAIL) FAIL=$((FAIL + 1)) ;;
    *) verdict="FAIL"; FAIL=$((FAIL + 1)); detail="unknown verdict: $2 ($detail)" ;;
  esac
  printf '%s\n' "| ${name} | ${verdict} | ${detail} |"
  RESULTS+=("${name}"$'\t'"${verdict}"$'\t'"${detail}")
}

http_get() {
  local out="$1"
  local url="$2"
  shift 2
  local code
  set +e
  code="$(curl -sS -o "${out}.body" -w '%{http_code}' --max-time "${CURL_TIMEOUT}" \
    -H "authorization: Bearer ${KEY}" \
    -H "accept: application/json" \
    "$@" \
    "${url}")"
  local st=$?
  set -e
  if [[ $st -ne 0 ]]; then
    printf '000' > "${out}.code"
    printf '%s' "curl_exit_${st}" > "${out}.body"
    return 0
  fi
  printf '%s' "$code" > "${out}.code"
}

expect_success() {
  local name="$1"
  local bodyf="$2"
  local codef="$3"
  local check="$4"
  local code
  code="$(cat "$codef")"
  if [[ "$code" != "200" ]]; then
    local err_code credits
    err_code="$(python3 -c 'import json,sys
try:
  d=json.load(open(sys.argv[1]))
  print((d.get("error") or {}).get("code") or "")
except Exception:
  print("")' "$bodyf")"
    credits="$(python3 -c 'import json,sys
try:
  d=json.load(open(sys.argv[1]))
  print((d.get("meta") or {}).get("creditsCharged", ""))
except Exception:
  print("")' "$bodyf")"
    record "$name" "FAIL" "http ${code} error=${err_code:-?} creditsCharged=${credits:-?} (wanted 200)"
    python3 -c 'import json,sys
p=sys.argv[1]
try:
  d=json.load(open(p))
  err=d.get("error") or {}
  print("  body:", {"code": err.get("code"), "message": err.get("message"), "creditsCharged": (d.get("meta") or {}).get("creditsCharged")})
except Exception:
  t=open(p, errors="replace").read()[:240]
  print("  body:", t)' "$bodyf" || true
    return
  fi
  local detail
  if ! detail="$(python3 - "$bodyf" "$check" <<'PY'
import json, sys
path, kind = sys.argv[1], sys.argv[2]
doc = json.load(open(path))
data = doc.get("data")
meta = doc.get("meta") or {}
credits = meta.get("creditsCharged")
if not isinstance(data, dict):
    print("missing data object")
    sys.exit(1)
if kind == "unroll":
    post = data.get("post") or {}
    comments = data.get("comments")
    count = data.get("commentCount")
    pid = post.get("id") or ""
    title = post.get("title")
    if not str(pid).startswith("t3_"):
        print(f"post.id {pid!r} is not t3_*")
        sys.exit(1)
    if not isinstance(title, str) or title.strip() == "":
        print("empty post.title")
        sys.exit(1)
    if not isinstance(comments, list):
        print("comments is not a list")
        sys.exit(1)
    if not isinstance(count, int) or count < 0:
        print(f"bad commentCount {count!r}")
        sys.exit(1)
    if credits not in (1, 2):
        print(f"creditsCharged {credits!r} not 1 or 2")
        sys.exit(1)
    print(f"http 200 post={pid} comments={count} creditsCharged={credits}")
elif kind == "post":
    pid = data.get("id") or ""
    title = data.get("title")
    if not str(pid).startswith("t3_"):
        print(f"id {pid!r} is not t3_*")
        sys.exit(1)
    if not isinstance(title, str) or title.strip() == "":
        print("empty title")
        sys.exit(1)
    if "comments" in data:
        print("post-only payload included comments")
        sys.exit(1)
    if credits != 1:
        print(f"creditsCharged {credits!r} != 1")
        sys.exit(1)
    print(f"http 200 id={pid} creditsCharged={credits}")
elif kind == "listing":
    posts = data.get("posts")
    sub = data.get("subreddit")
    if not isinstance(posts, list) or len(posts) == 0:
        print("listing returned no posts")
        sys.exit(1)
    first = posts[0] if posts else {}
    pid = (first or {}).get("id") or ""
    title = (first or {}).get("title")
    if not str(pid).startswith("t3_"):
        print(f"first post id {pid!r} is not t3_*")
        sys.exit(1)
    if not isinstance(title, str) or title.strip() == "":
        print("empty first title")
        sys.exit(1)
    if credits != 1:
        print(f"creditsCharged {credits!r} != 1")
        sys.exit(1)
    print(f"http 200 sub={sub} posts={len(posts)} first={pid} creditsCharged={credits}")
elif kind == "search":
    posts = data.get("posts")
    q = data.get("q")
    if not isinstance(posts, list):
        print("search posts is not a list")
        sys.exit(1)
    if len(posts) == 0:
        if credits != 0:
            print(f"empty search creditsCharged {credits!r} != 0")
            sys.exit(1)
        print(f"http 200 q={q!r} hits=0 creditsCharged=0")
        sys.exit(0)
    first = posts[0] or {}
    pid = first.get("id") or ""
    title = first.get("title")
    if not str(pid).startswith("t3_"):
        print(f"first hit id {pid!r} is not t3_*")
        sys.exit(1)
    if not isinstance(title, str) or title.strip() == "":
        print("empty first hit title")
        sys.exit(1)
    if credits != 1:
        print(f"creditsCharged {credits!r} != 1")
        sys.exit(1)
    print(f"http 200 q={q!r} hits={len(posts)} first={pid} creditsCharged={credits}")
else:
    print(f"unknown check {kind}")
    sys.exit(1)
PY
  )"; then
    record "$name" "FAIL" "${detail}"
    return
  fi
  record "$name" "PASS" "${detail}"
}

expect_spec_error() {
  local name="$1"
  local bodyf="$2"
  local codef="$3"
  local detail
  if ! detail="$(python3 - "$bodyf" "$codef" <<'PY'
import json, sys
body_path, code_path = sys.argv[1], sys.argv[2]
http = open(code_path).read().strip()
try:
    doc = json.load(open(body_path))
except Exception as exc:
    print(f"http {http} non-json ({exc})")
    sys.exit(1)
err = doc.get("error") or {}
meta = doc.get("meta") or {}
code = err.get("code")
credits = meta.get("creditsCharged")
allowed = {
    "not_found",
    "subreddit_private",
    "subreddit_quarantined",
    "upstream_blocked",
    "rate_limited",
}
if code not in allowed:
    print(f"http {http} error={code!r} not a SPEC live-failure code")
    sys.exit(1)
if credits != 0:
    print(f"http {http} error={code} creditsCharged={credits!r} != 0")
    sys.exit(1)
print(f"http {http} error={code} creditsCharged=0")
PY
  )"; then
    record "$name" "FAIL" "${detail}"
    return
  fi
  record "$name" "PASS-ERROR" "${detail}"
}

RESULTS=()
CURL_TIMEOUT="${LIVE_SMOKE_TIMEOUT:-60}"
THREAD_URL="${LIVE_SMOKE_THREAD_URL:-https://www.reddit.com/r/pics/comments/92dd8/test_post_please_ignore/}"
LISTING_SUB="${LIVE_SMOKE_SUB:-pics}"
SEARCH_Q="${LIVE_SMOKE_SEARCH_Q:-cats}"
PRIVATE_SUB="${LIVE_SMOKE_PRIVATE_SUB:-lounge}"
REMOVED_ID="${LIVE_SMOKE_REMOVED_ID:-thispostdoesnotexist999}"
POST_ID="${LIVE_SMOKE_POST_ID:-92dd8}"
KEY="${LIVE_SMOKE_KEY:-rk_test_live_smoke_local}"

echo "== live-smoke (operator only; not CI) =="
echo "thread=${THREAD_URL}"
echo "post=${POST_ID}"
echo "listing=r/${LISTING_SUB}"
echo "search=${SEARCH_Q}"
echo "private=r/${PRIVATE_SUB}"
echo "removed=${REMOVED_ID}"

if [[ -n "${LIVE_SMOKE_BASE:-}" ]]; then
  BASE="${LIVE_SMOKE_BASE%/}"
  echo "attach ${BASE}"
  if ! curl -fsS --max-time 5 "${BASE}/healthz" >/dev/null; then
    fail_msg "LIVE_SMOKE_BASE ${BASE} /healthz failed"
    exit 1
  fi
else
  if [[ ! -d node_modules ]]; then
    if [[ -f package-lock.json ]]; then
      npm ci
    else
      npm install
    fi
  fi
  TMPDIR_SMOKE="$(mktemp -d "${TMPDIR:-/tmp}/redditapi-live-smoke.XXXXXX")"
  PORT="$(pick_port)"
  BASE="http://127.0.0.1:${PORT}"
  export REDDITAPI_LIVE=1
  export PORT
  export REDDITAPI_DATABASE="${TMPDIR_SMOKE}/redditapi.sqlite"
  export REDDITAPI_BOOTSTRAP_KEY="${KEY}"
  export REDDITAPI_USER_AGENT="${REDDITAPI_USER_AGENT:-redditapi/0.1 (+https://github.com/tangpingqingwa/redditapi; contact@redditapi.dev)}"
  echo "start REDDITAPI_LIVE=1 on ${BASE}"
  npm start >"${TMPDIR_SMOKE}/server.log" 2>&1 &
  STARTED_PID=$!
  ready=0
  for _ in $(seq 1 40); do
    if ! kill -0 "${STARTED_PID}" >/dev/null 2>&1; then
      fail_msg "server exited before /healthz"
      sed -n '1,80p' "${TMPDIR_SMOKE}/server.log" >&2 || true
      exit 1
    fi
    if curl -fsS --max-time 2 "${BASE}/healthz" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.25
  done
  if [[ "$ready" != "1" ]]; then
    fail_msg "server did not become ready on ${BASE}/healthz"
    sed -n '1,80p' "${TMPDIR_SMOKE}/server.log" >&2 || true
    exit 1
  fi
fi

WORKDIR="${TMPDIR_SMOKE:-$(mktemp -d "${TMPDIR:-/tmp}/redditapi-live-smoke.XXXXXX")}"
if [[ -z "${TMPDIR_SMOKE}" ]]; then
  TMPDIR_SMOKE="$WORKDIR"
fi

echo
echo "| case | verdict | detail |"
echo "|---|---|---|"

http_get "${WORKDIR}/unroll" \
  "${BASE}/v1/threads/by-url?url=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "${THREAD_URL}")&max_comments=50"
expect_success "unroll public thread" "${WORKDIR}/unroll.body" "${WORKDIR}/unroll.code" "unroll"

http_get "${WORKDIR}/post" "${BASE}/v1/posts/${POST_ID}"
expect_success "GET post-only" "${WORKDIR}/post.body" "${WORKDIR}/post.code" "post"

http_get "${WORKDIR}/listing" "${BASE}/v1/r/${LISTING_SUB}/hot?limit=5"
expect_success "sub listing" "${WORKDIR}/listing.body" "${WORKDIR}/listing.code" "listing"

http_get "${WORKDIR}/search" "${BASE}/v1/search?q=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "${SEARCH_Q}")&limit=5"
expect_success "search" "${WORKDIR}/search.body" "${WORKDIR}/search.code" "search"

http_get "${WORKDIR}/private" "${BASE}/v1/r/${PRIVATE_SUB}/hot?limit=5"
expect_spec_error "private or gated sub" "${WORKDIR}/private.body" "${WORKDIR}/private.code"

http_get "${WORKDIR}/removed" "${BASE}/v1/posts/${REMOVED_ID}"
expect_spec_error "removed or missing post" "${WORKDIR}/removed.body" "${WORKDIR}/removed.code"

echo
echo "summary: PASS=${PASS} PASS-ERROR=${PASS_ERROR} FAIL=${FAIL}"
if [[ "$FAIL" -gt 0 ]]; then
  echo "RESULT: FAIL"
  exit 1
fi
if [[ "$PASS" -eq 0 ]]; then
  echo "RESULT: FAIL (no successful live read)"
  exit 1
fi
echo "RESULT: PASS"
exit 0

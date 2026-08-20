#!/usr/bin/env bash
# Offline gate for main. Must exit 0 on a clean clone with no secrets.
# Contract checks stay; once package.json exists we also typecheck and run
# node:test. Do not require live third-party networks.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

echo "== contract files =="
for f in README.md SPEC.md BUILD.md CONTRIBUTING.md scripts/test.sh; do
  [[ -f "$f" ]] || fail "missing $f"
  [[ -s "$f" ]] || fail "empty $f"
done

echo "== contributing rules are documented =="
grep -q 'main must always be buildable' CONTRIBUTING.md \
  || grep -q 'main` must always be buildable' CONTRIBUTING.md \
  || fail "CONTRIBUTING.md does not state the main-branch rule"

echo "== SPEC mentions git collaboration =="
grep -q 'Git collaboration' SPEC.md || fail "SPEC.md missing Git collaboration section"

echo "== no committed secrets =="
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git ls-files | grep -E '(^|/)\.env$|(^|/)id_rsa$|\.pem$|credentials\.json$' >/dev/null; then
    fail "secret-like path is tracked"
  fi
fi

echo "== markdown is UTF-8 text =="
file -b --mime-encoding README.md SPEC.md CONTRIBUTING.md | grep -qiE 'utf-8|us-ascii' \
  || fail "docs are not UTF-8/ASCII"

if [[ -f package.json ]]; then
  echo "== install =="
  if [[ ! -d node_modules ]]; then
    if [[ -f package-lock.json ]]; then
      npm ci
    else
      npm install
    fi
  fi

  echo "== tsc --noEmit =="
  npx tsc --noEmit

  ls tests/*.test.ts >/dev/null 2>&1 || fail "no tests/*.test.ts files"

  echo "== fixtures present =="
  for f in fixtures/small.json fixtures/with-more.json fixtures/morechildren.json \
    fixtures/deleted.json fixtures/removed-post.json fixtures/private.json fixtures/large.json \
    fixtures/listings.json fixtures/search.json \
    openapi/threads.yaml openapi/listings.yaml openapi/search.yaml \
    tests/thread.test.ts tests/html.test.ts tests/listings.test.ts \
    tests/search.test.ts tests/mcp.test.ts \
    src/core/listings.ts src/http/routes/listings.ts \
    src/core/search.ts src/http/routes/search.ts \
    src/mcp/server.ts src/mcp/tools.ts llms.txt \
    src/views/home.ts src/views/thread.ts src/views/layout.ts src/views/legal.ts \
    public/unroller.css public/unroller.js \
    src/adapters/reddit/live.ts src/adapters/reddit/index.ts \
    tests/live-adapter.test.ts; do
    [[ -f "$f" ]] || fail "missing $f"
    [[ -s "$f" ]] || fail "empty $f"
  done

  echo "== HTML unroller contract =="
  grep -q 'SPEC 7' tests/html.test.ts || fail "tests/html.test.ts missing SPEC 7"
  grep -q 'LEGAL_FOOTER' tests/html.test.ts || fail "tests/html.test.ts missing legal footer"
  grep -q 'adsbygoogle' tests/html.test.ts || fail "tests/html.test.ts missing ads"
  grep -q 'noindex' tests/html.test.ts || fail "tests/html.test.ts missing noindex"
  if grep -qE 'www\.reddit\.com/api|oauth\.reddit\.com' tests/html.test.ts; then
    fail "tests/html.test.ts mentions live Reddit hosts"
  fi

  echo "== listings + latest contract =="
  grep -q 'SPEC 6' tests/listings.test.ts || fail "tests/listings.test.ts missing SPEC 6"
  grep -q 'subreddit_private' tests/listings.test.ts || fail "tests/listings.test.ts missing private sub"
  grep -q '/v1/r/test/latest' tests/listings.test.ts || fail "tests/listings.test.ts missing latest path"
  grep -q 'creditsCharged, 0' tests/listings.test.ts || fail "tests/listings.test.ts missing 0-credit latest"
  if grep -qE 'www\.reddit\.com/api|oauth\.reddit\.com' tests/listings.test.ts; then
    fail "tests/listings.test.ts mentions live Reddit hosts"
  fi

  echo "== search + MCP contract =="
  grep -q '/v1/search' tests/search.test.ts || fail "tests/search.test.ts missing /v1/search"
  grep -q 'creditsCharged, 0' tests/search.test.ts || fail "tests/search.test.ts missing 0-credit empty search"
  grep -q '/v1/posts/' tests/search.test.ts || fail "tests/search.test.ts missing GET /v1/posts"
  grep -q 'unroll_thread' tests/mcp.test.ts || fail "tests/mcp.test.ts missing unroll_thread"
  grep -q 'get_post' tests/mcp.test.ts || fail "tests/mcp.test.ts missing get_post"
  grep -q 'list_subreddit' tests/mcp.test.ts || fail "tests/mcp.test.ts missing list_subreddit"
  grep -q 'search_reddit' tests/mcp.test.ts || fail "tests/mcp.test.ts missing search_reddit"
  grep -q 'get_latest' tests/mcp.test.ts || fail "tests/mcp.test.ts missing get_latest"
  grep -q 'do not use for voting or posting' llms.txt || fail "llms.txt missing voting/posting skill"
  grep -q 'private subs will 403' llms.txt || fail "llms.txt missing private-sub skill"
  grep -q 'trees may truncate' llms.txt || fail "llms.txt missing truncate skill"
  grep -q 'search_reddit' src/mcp/tools.ts || fail "src/mcp/tools.ts missing search_reddit"
  grep -q 'unrollThread' src/mcp/tools.ts || fail "src/mcp/tools.ts must call core unrollThread"
  grep -q 'searchReddit' src/mcp/tools.ts || fail "src/mcp/tools.ts must call core searchReddit"
  if grep -qE 'www\.reddit\.com/api|oauth\.reddit\.com' tests/search.test.ts tests/mcp.test.ts; then
    fail "search/MCP tests mention live Reddit hosts"
  fi
  for dir in src/http src/mcp; do
    if grep -R --include='*.ts' -l 'adapters/reddit' "$dir" >/dev/null 2>&1; then
      fail "$dir imported adapters/reddit"
    fi
  done
  if grep -R --include='*.ts' -nE '\bfetch\s*\(' src/mcp; then
    fail "src/mcp must not call fetch"
  fi

  echo "== live adapter is env-gated and not in CI =="
  grep -q 'REDDITAPI_LIVE' src/config.ts || fail "src/config.ts missing REDDITAPI_LIVE"
  grep -q 'liveRedditEnabled' src/adapters/reddit/index.ts || fail "adapter index missing liveRedditEnabled"
  grep -q 'createLiveRedditAdapter' src/adapters/reddit/live.ts || fail "missing createLiveRedditAdapter"
  grep -q 'createAppAdapter' src/app.ts || fail "src/app.ts must select adapter via createAppAdapter"
  if grep -q 'REDDITAPI_LIVE=1' .github/workflows/ci.yml; then
    fail "CI must not set REDDITAPI_LIVE=1"
  fi
  if grep -qE 'www\.reddit\.com/api|oauth\.reddit\.com' tests/live-adapter.test.ts; then
    fail "tests/live-adapter.test.ts mentions live Reddit hosts"
  fi
  if grep -R --include='*.ts' -nE '\bfetch\s*\(' src/core src/http src/mcp src/adapters/reddit/fixture.ts; then
    fail "core/http/mcp/fixture must not call fetch"
  fi
  if grep -R --include='*.ts' -nE "from ['\"]undici['\"]|from ['\"]node:https?['\"]" src; then
    fail "src/ must not import undici or node:http"
  fi
  if ! grep -nE '\bfetch\s*\(' src/adapters/reddit/live.ts >/dev/null; then
    fail "live adapter must implement fetch"
  fi

  echo "== deploy artifacts (Dockerfile + runbook) =="
  [[ -f Dockerfile ]] || fail "missing Dockerfile"
  [[ -f .env.example ]] || fail "missing .env.example"
  [[ -f docs/runbook.md ]] || fail "missing docs/runbook.md"
  grep -q 'node:22' Dockerfile || fail "Dockerfile must use Node 22"
  grep -qE '^USER[[:space:]]+node$' Dockerfile || fail "Dockerfile must run as non-root USER node"
  grep -q 'PORT' Dockerfile || fail "Dockerfile must honor PORT"
  if grep -E 'REDDITAPI_LIVE[[:space:]]*=[[:space:]]*1' Dockerfile >/dev/null; then
    fail "Dockerfile must not enable live Reddit"
  fi
  grep -q 'REDDITAPI_LIVE' .env.example || fail ".env.example missing REDDITAPI_LIVE"
  grep -q 'REDDITAPI_DATABASE' .env.example || fail ".env.example missing REDDITAPI_DATABASE"
  grep -q 'REDDITAPI_BOOTSTRAP_KEY' .env.example || fail ".env.example missing REDDITAPI_BOOTSTRAP_KEY"
  grep -q '/healthz' docs/runbook.md || fail "runbook missing /healthz"
  grep -q 'REDDITAPI_LIVE=1' docs/runbook.md || fail "runbook missing live Reddit enablement"
  grep -q 'docker build' docs/runbook.md || fail "runbook missing docker build"
  grep -q 'docker run' docs/runbook.md || fail "runbook missing docker run"
  if grep -qE 'www\.reddit\.com/api|oauth\.reddit\.com' Dockerfile .env.example docs/runbook.md; then
    fail "deploy artifacts must not pin oauth.reddit or www.reddit.com/api"
  fi

  echo "== unit tests =="
  # Quoted so bash 3.2 does not eat **; Node 22's test runner expands the glob.
  # Fixture / mocked fetch only — never hit live Reddit.
  unset REDDITAPI_LIVE || true
  set +e
  output="$(npx tsx --test 'tests/**/*.test.ts' 2>&1)"
  status=$?
  set -e
  printf '%s\n' "$output"
  [[ $status -eq 0 ]] || fail "unit tests failed"
  echo "$output" | grep -Eq 'tests [1-9]' || fail "test runner reported 0 tests"
fi

echo "OK: buildable and testable"

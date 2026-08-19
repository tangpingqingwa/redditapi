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
    fixtures/listings.json openapi/threads.yaml openapi/listings.yaml \
    tests/thread.test.ts tests/html.test.ts tests/listings.test.ts \
    src/core/listings.ts src/http/routes/listings.ts \
    src/views/home.ts src/views/thread.ts src/views/layout.ts src/views/legal.ts \
    public/unroller.css public/unroller.js; do
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
  if grep -R --include='*.ts' -nE 'search_reddit|/v1/search|src/mcp' src tests; then
    fail "search/MCP belongs in PR 5, not listings"
  fi

  echo "== offline adapters only =="
  if grep -R --include='*.ts' -nE '\bfetch\s*\(' src; then
    fail "src/ must not call fetch (fixture adapter only)"
  fi
  if grep -R --include='*.ts' -nE "from ['\"]undici['\"]|from ['\"]node:https?['\"]" src; then
    fail "src/ must not import an HTTP client yet"
  fi

  echo "== unit tests =="
  # Quoted so bash 3.2 does not eat **; Node 22's test runner expands the glob.
  set +e
  output="$(npx tsx --test 'tests/**/*.test.ts' 2>&1)"
  status=$?
  set -e
  printf '%s\n' "$output"
  [[ $status -eq 0 ]] || fail "unit tests failed"
  echo "$output" | grep -Eq 'tests [1-9]' || fail "test runner reported 0 tests"
fi

echo "OK: buildable and testable"

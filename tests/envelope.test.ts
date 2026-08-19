import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createKeySecret, insertKeyFromSecret } from "../src/billing/keys.js";
import { DEFAULT_FREE_CREDITS, DEFAULT_FREE_RPM } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { buildErr, HTTP_STATUS_BY_ERROR, isRetryable } from "../src/http/envelope.js";
import type { ErrorCode } from "../src/types.js";

const BOOTSTRAP_TEST_KEY = "rk_test_envelope_bootstrap_secret";

test("missing bearer on /v1/me is 401 with creditsCharged 0", async () => {
  const app = await buildApp();
  after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/v1/me" });
  const body = response.json();

  assert.equal(response.statusCode, 401);
  assert.equal(body.error.code, "unauthorized");
  assert.equal(body.error.retryable, false);
  assert.equal(body.meta.creditsCharged, 0);
  assert.match(body.meta.requestId, /^req_/);
  assert.equal("data" in body, false);
});

test("malformed Authorization header is 401 with creditsCharged 0", async () => {
  const app = await buildApp();
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: "Basic abc" },
  });
  const body = response.json();

  assert.equal(response.statusCode, 401);
  assert.equal(body.error.code, "unauthorized");
  assert.equal(body.meta.creditsCharged, 0);
});

test("ClipAPI ck_ prefix is 401 with creditsCharged 0", async () => {
  const app = await buildApp();
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: "Bearer ck_live_not_a_reddit_key" },
  });
  const body = response.json();

  assert.equal(response.statusCode, 401);
  assert.equal(body.error.code, "unauthorized");
  assert.equal(body.meta.creditsCharged, 0);
});

test("unknown rk_ key is 401 with creditsCharged 0", async () => {
  const app = await buildApp();
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: "Bearer rk_live_not_in_database" },
  });
  const body = response.json();

  assert.equal(response.statusCode, 401);
  assert.equal(body.error.code, "unauthorized");
  assert.equal(body.meta.creditsCharged, 0);
});

test("bootstrap test key can call GET /v1/me and sees credits", async () => {
  const app = await buildApp({ bootstrapKey: BOOTSTRAP_TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${BOOTSTRAP_TEST_KEY}` },
  });
  const body = response.json();

  assert.equal(response.statusCode, 200);
  assert.equal(body.data.prefix, "rk_test");
  assert.equal(body.data.plan, "free");
  assert.equal(body.data.creditsRemaining, DEFAULT_FREE_CREDITS);
  assert.equal(body.data.rpm, DEFAULT_FREE_RPM);
  assert.match(body.data.id, /^key_/);
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(body.meta.cached, false);
  assert.match(body.meta.requestId, /^req_/);
  assert.equal("error" in body, false);
});

test("inserted live key is returned on /v1/me", async () => {
  const db = openDatabase(":memory:");
  const secret = createKeySecret("rk_live");
  insertKeyFromSecret(db, secret, { plan: "monthly", credits: 1000, rpm: 200 });
  const app = await buildApp({ db });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${secret}` },
  });
  const body = response.json();

  assert.equal(response.statusCode, 200);
  assert.equal(body.data.prefix, "rk_live");
  assert.equal(body.data.plan, "monthly");
  assert.equal(body.data.creditsRemaining, 1000);
  assert.equal(body.data.rpm, 200);
  assert.equal(body.meta.creditsCharged, 0);
});

test("every error envelope charges 0 credits and maps HTTP status", () => {
  const retryable: ReadonlySet<ErrorCode> = new Set([
    "rate_limited",
    "upstream_blocked",
    "internal",
  ]);
  const codes = Object.keys(HTTP_STATUS_BY_ERROR) as ErrorCode[];
  assert.ok(codes.length >= 8);

  for (const code of codes) {
    const body = buildErr(code, "req_probe");
    assert.equal(HTTP_STATUS_BY_ERROR[code] >= 400, true, code);
    assert.equal(body.error.code, code);
    assert.equal(body.error.retryable, retryable.has(code));
    assert.equal(isRetryable(code), retryable.has(code));
    assert.equal(body.meta.creditsCharged, 0);
    assert.equal(body.meta.requestId, "req_probe");
  }
});

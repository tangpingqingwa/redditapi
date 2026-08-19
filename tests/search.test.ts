import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../src/app.js";
import { insertKeyFromSecret } from "../src/billing/keys.js";
import { parseSearchQuery } from "../src/core/search.js";
import { normalizePostId } from "../src/core/thread.js";
import { openDatabase } from "../src/db.js";
import type { RedditPost, SearchData } from "../src/types.js";

const KEY = "rk_test_search_fixture_secret";

async function appWithKey(credits = 100) {
  const db = openDatabase(":memory:");
  insertKeyFromSecret(db, KEY, { credits });
  const app = await buildApp({ db });
  after(() => app.close());
  return { app, db };
}

function auth(url: string) {
  return {
    method: "GET" as const,
    url,
    headers: { authorization: `Bearer ${KEY}` },
  };
}

test("parseSearchQuery trims and rejects empty q", () => {
  assert.equal(parseSearchQuery("  api  pricing "), "api pricing");
  assert.equal(parseSearchQuery(""), null);
  assert.equal(parseSearchQuery("   "), null);
  assert.equal(parseSearchQuery(undefined), null);
});

test("normalizePostId accepts bare and t3_ ids", () => {
  assert.equal(normalizePostId("short1"), "short1");
  assert.equal(normalizePostId("t3_short1"), "short1");
  assert.equal(normalizePostId("T3_SHORT1"), "short1");
  assert.equal(normalizePostId(""), null);
  assert.equal(normalizePostId("bad id"), null);
});

test("GET /v1/search returns hits, honors sub/sort, and charges 1 per page with hits", async () => {
  const { app, db } = await appWithKey();

  const all = await app.inject(auth("/v1/search?q=api"));
  const allBody = all.json() as { data: SearchData; meta: { creditsCharged: number } };
  assert.equal(all.statusCode, 200);
  assert.equal(allBody.data.q, "api");
  assert.equal(allBody.data.subreddit, null);
  assert.equal(allBody.data.sort, "relevance");
  assert.ok(allBody.data.posts.length >= 2);
  assert.equal(allBody.data.posts[0]?.id, "t3_saas1");
  assert.equal(allBody.meta.creditsCharged, 1);

  const scoped = await app.inject(auth("/v1/search?q=api&sub=test&sort=new&limit=2"));
  const scopedBody = scoped.json() as { data: SearchData; meta: { creditsCharged: number } };
  assert.equal(scoped.statusCode, 200);
  assert.equal(scopedBody.data.subreddit, "test");
  assert.equal(scopedBody.data.sort, "new");
  assert.deepEqual(
    scopedBody.data.posts.map((post) => post.id),
    ["t3_new1", "t3_mid1"],
  );
  assert.equal(scopedBody.data.nextCursor, "t3_mid1");
  assert.equal(scopedBody.meta.creditsCharged, 1);

  const pageTwo = await app.inject(auth("/v1/search?q=api&sub=test&sort=new&limit=2&cursor=t3_mid1"));
  const pageTwoBody = pageTwo.json() as { data: SearchData };
  assert.equal(pageTwo.statusCode, 200);
  assert.deepEqual(
    pageTwoBody.data.posts.map((post) => post.id),
    ["t3_hot1"],
  );
  assert.equal(pageTwoBody.data.nextCursor, null);

  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, 97);
});

test("empty search page charges 0 credits", async () => {
  const { app, db } = await appWithKey(5);
  const response = await app.inject(auth("/v1/search?q=zzzz-no-such-token"));
  const body = response.json() as { data: SearchData; meta: { creditsCharged: number } };
  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.data.posts, []);
  assert.equal(body.meta.creditsCharged, 0);
  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, 5);
});

test("private sub search is 403 with 0 credits", async () => {
  const { app, db } = await appWithKey(8);
  const response = await app.inject(auth("/v1/search?q=secret&sub=privatesub"));
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "subreddit_private");
  assert.equal(response.json().meta.creditsCharged, 0);
  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, 8);
});

test("missing q, bad sort, cursor, and sub are 400 with 0 credits", async () => {
  const { app, db } = await appWithKey(3);
  const cases = [
    "/v1/search",
    "/v1/search?q=",
    "/v1/search?q=api&sort=best",
    "/v1/search?q=api&cursor=not-a-token",
    "/v1/search?q=api&sub=has%20space",
    "/v1/search?q=api&limit=0",
  ];
  for (const url of cases) {
    const response = await app.inject(auth(url));
    assert.equal(response.statusCode, 400, url);
    assert.equal(response.json().error.code, "invalid_request");
    assert.equal(response.json().meta.creditsCharged, 0);
  }
  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, 3);
});

test("GET /v1/posts/{id} returns the post only and charges 1", async () => {
  const { app, db } = await appWithKey();
  const bare = await app.inject(auth("/v1/posts/short1"));
  const body = bare.json() as { data: RedditPost; meta: { creditsCharged: number } };
  assert.equal(bare.statusCode, 200);
  assert.equal(body.data.id, "t3_short1");
  assert.equal(body.data.title, "A short thread");
  assert.equal(body.data.author, "alice");
  assert.equal("comments" in body.data, false);
  assert.equal(body.meta.creditsCharged, 1);

  const prefixed = await app.inject(auth("/v1/posts/t3_short1"));
  assert.equal(prefixed.statusCode, 200);
  assert.equal((prefixed.json() as { data: RedditPost }).data.id, "t3_short1");

  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, 98);
});

test("removed and unknown posts are 404 with 0 credits; bad id is 400", async () => {
  const { app, db } = await appWithKey(4);
  const gone = await app.inject(auth("/v1/posts/gone1"));
  assert.equal(gone.statusCode, 404);
  assert.equal(gone.json().error.code, "not_found");
  assert.equal(gone.json().meta.creditsCharged, 0);

  const missing = await app.inject(auth("/v1/posts/nope1"));
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "not_found");

  const bad = await app.inject(auth("/v1/posts/bad%20id"));
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, "invalid_request");

  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, 4);
});

test("unauthenticated search and posts are 401; 0-credit keys can still search empty", async () => {
  const { app, db } = await appWithKey(0);

  const unauth = await app.inject({ method: "GET", url: "/v1/search?q=api" });
  assert.equal(unauth.statusCode, 401);
  assert.equal(unauth.json().error.code, "unauthorized");
  assert.equal(unauth.json().meta.creditsCharged, 0);

  const paid = await app.inject(auth("/v1/search?q=api"));
  assert.equal(paid.statusCode, 402);
  assert.equal(paid.json().error.code, "payment_required");
  assert.equal(paid.json().meta.creditsCharged, 0);

  const empty = await app.inject(auth("/v1/search?q=zzzz-no-such-token"));
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.json().meta.creditsCharged, 0);

  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, 0);
});

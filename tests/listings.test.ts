import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../src/app.js";
import { insertKeyFromSecret } from "../src/billing/keys.js";
import { normalizeSubreddit } from "../src/core/listings.js";
import { openDatabase } from "../src/db.js";
import type { ListingData } from "../src/types.js";

const KEY = "rk_test_listings_fixture_secret";

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

test("normalizeSubreddit accepts public r/ names", () => {
  assert.equal(normalizeSubreddit("test"), "test");
  assert.equal(normalizeSubreddit(" r/AskReddit "), "AskReddit");
  assert.equal(normalizeSubreddit("a"), null);
  assert.equal(normalizeSubreddit("has space"), null);
});

test("hot/new/top return posts, honor sort, and charge 1 credit per page", async () => {
  const { app, db } = await appWithKey();

  const hot = await app.inject(auth("/v1/r/test/hot"));
  const hotBody = hot.json() as { data: ListingData; meta: { creditsCharged: number } };
  assert.equal(hot.statusCode, 200);
  assert.equal(hotBody.data.subreddit, "test");
  assert.equal(hotBody.data.sort, "hot");
  assert.equal(hotBody.data.t, null);
  assert.equal(hotBody.data.posts[0]?.id, "t3_hot1");
  assert.equal(hotBody.data.posts[0]?.title, "Hottest post");
  assert.equal(hotBody.meta.creditsCharged, 1);

  const newest = await app.inject(auth("/v1/r/test/new?limit=2"));
  const newestBody = newest.json() as { data: ListingData; meta: { creditsCharged: number } };
  assert.equal(newest.statusCode, 200);
  assert.equal(newestBody.data.sort, "new");
  assert.deepEqual(
    newestBody.data.posts.map((post) => post.id),
    ["t3_new1", "t3_mid1"],
  );
  assert.equal(newestBody.data.nextCursor, "t3_mid1");
  assert.equal(newestBody.meta.creditsCharged, 1);

  const pageTwo = await app.inject(auth("/v1/r/test/new?limit=2&cursor=t3_mid1"));
  const pageTwoBody = pageTwo.json() as { data: ListingData };
  assert.equal(pageTwo.statusCode, 200);
  assert.deepEqual(
    pageTwoBody.data.posts.map((post) => post.id),
    ["t3_hot1", "t3_old1"],
  );
  assert.equal(pageTwoBody.data.nextCursor, null);

  const top = await app.inject(auth("/v1/r/test/top?t=week"));
  const topBody = top.json() as { data: ListingData };
  assert.equal(top.statusCode, 200);
  assert.equal(topBody.data.sort, "top");
  assert.equal(topBody.data.t, "week");
  assert.equal(topBody.data.posts[0]?.id, "t3_hot1");
  assert.equal(topBody.data.posts[1]?.id, "t3_old1");

  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, 96);
});

test("SPEC 6: latest returns newest posts and charges 0 credits", async () => {
  const { app, db } = await appWithKey(4);
  const response = await app.inject(auth("/v1/r/test/latest"));
  const body = response.json() as { data: ListingData; meta: { creditsCharged: number; cached: boolean } };

  assert.equal(response.statusCode, 200);
  assert.equal(body.data.sort, "latest");
  assert.equal(body.data.t, null);
  assert.equal(body.data.nextCursor, null);
  assert.ok(body.data.posts.length <= 25);
  assert.deepEqual(
    body.data.posts.map((post) => post.id),
    ["t3_new1", "t3_mid1", "t3_hot1", "t3_old1"],
  );
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(body.meta.cached, false);
  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, 4);
});

test("private subreddit listings and latest are 403 with 0 credits", async () => {
  const { app, db } = await appWithKey(8);
  for (const path of ["/v1/r/privatesub/hot", "/v1/r/privatesub/latest"]) {
    const response = await app.inject(auth(path));
    const body = response.json();
    assert.equal(response.statusCode, 403, path);
    assert.equal(body.error.code, "subreddit_private");
    assert.equal(body.meta.creditsCharged, 0);
  }
  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, 8);
});

test("quarantined and unknown subreddits stay 0 credits", async () => {
  const { app, db } = await appWithKey(5);
  const quarantined = await app.inject(auth("/v1/r/quarantinedsub/new"));
  assert.equal(quarantined.statusCode, 403);
  assert.equal(quarantined.json().error.code, "subreddit_quarantined");
  assert.equal(quarantined.json().meta.creditsCharged, 0);

  const missing = await app.inject(auth("/v1/r/nosuchsub/top"));
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "not_found");
  assert.equal(missing.json().meta.creditsCharged, 0);

  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, 5);
});

test("bad sub, limit, cursor, and t are 400 with 0 credits", async () => {
  const { app, db } = await appWithKey(3);
  const cases = [
    "/v1/r/%20/hot",
    "/v1/r/has%20space/new",
    "/v1/r/test/hot?limit=0",
    "/v1/r/test/hot?limit=101",
    "/v1/r/test/new?cursor=not-a-token",
    "/v1/r/test/top?t=hour",
    "/v1/r/test/hot?t=week",
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

test("unauthenticated listings are 401; 0-credit keys can still call latest", async () => {
  const { app, db } = await appWithKey(0);

  const unauth = await app.inject({ method: "GET", url: "/v1/r/test/hot" });
  assert.equal(unauth.statusCode, 401);
  assert.equal(unauth.json().error.code, "unauthorized");
  assert.equal(unauth.json().meta.creditsCharged, 0);

  const paid = await app.inject(auth("/v1/r/test/hot"));
  assert.equal(paid.statusCode, 402);
  assert.equal(paid.json().error.code, "payment_required");
  assert.equal(paid.json().meta.creditsCharged, 0);

  const latest = await app.inject(auth("/v1/r/test/latest"));
  assert.equal(latest.statusCode, 200);
  assert.equal(latest.json().meta.creditsCharged, 0);
  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, 0);
});

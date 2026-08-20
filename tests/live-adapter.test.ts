import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createAppAdapter } from "../src/adapters/reddit/index.js";
import { createLiveRedditAdapter, type LiveFetch } from "../src/adapters/reddit/live.js";
import { buildApp } from "../src/app.js";
import { insertKeyFromSecret } from "../src/billing/keys.js";
import { unrollThread } from "../src/core/thread.js";
import { openDatabase } from "../src/db.js";
import type { ThreadData } from "../src/types.js";

const KEY = "rk_test_live_adapter_secret";

type MockResponse = {
  status: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function textResponse(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers });
}

function mockFetch(handler: (url: URL) => MockResponse): LiveFetch {
  return async (input) => {
    const url = new URL(input);
    const mapped = handler(url);
    if (mapped.text !== undefined) {
      return textResponse(mapped.status, mapped.text, mapped.headers);
    }
    return jsonResponse(mapped.status, mapped.body ?? {}, mapped.headers);
  };
}

function listingThing(id: string, title: string): unknown {
  return {
    kind: "t3",
    data: {
      id,
      name: `t3_${id}`,
      subreddit: "test",
      title,
      author: "alice",
      selftext: "body",
      url: `https://www.reddit.com/r/test/comments/${id}/`,
      permalink: `/r/test/comments/${id}/`,
      score: 1,
      created_utc: 1_700_000_000,
      over_18: false,
      spoiler: false,
      locked: false,
      link_flair_text: null,
    },
  };
}

test("createAppAdapter stays on fixtures unless REDDITAPI_LIVE=1", async () => {
  assert.notEqual(process.env.REDDITAPI_LIVE, "1");
  const selected = createAppAdapter();
  const known = await selected.fetchThread(
    { postId: "short1", subreddit: "test", permalink: "/r/test/comments/short1" },
    "best",
  );
  assert.equal(known.ok, true);
  const missing = await selected.fetchThread(
    { postId: "nope1", subreddit: "test", permalink: "/r/test/comments/nope1" },
    "best",
  );
  assert.equal(missing.ok, false);
  if (missing.ok) {
    return;
  }
  assert.equal(missing.code, "not_found");
});

test("mocked live thread maps private/quarantined/removed and charges 0", async () => {
  const adapter = createLiveRedditAdapter({
    fetch: mockFetch((url) => {
      const path = url.pathname;
      if (path.includes("/r/privatesub/")) {
        return { status: 403, body: { reason: "private" } };
      }
      if (path.includes("/r/quarantinedsub/")) {
        return { status: 403, body: { reason: "quarantined" } };
      }
      if (path.includes("/comments/gone1")) {
        return { status: 404, body: { error: 404 } };
      }
      throw new Error(`unexpected live url ${url.href}`);
    }),
  });

  const privateThread = await unrollThread(adapter, {
    url: "https://www.reddit.com/r/privatesub/comments/priv1/secret/",
    maxComments: 50,
    sort: "best",
  });
  assert.equal(privateThread.ok, false);
  if (privateThread.ok) {
    return;
  }
  assert.equal(privateThread.code, "subreddit_private");

  const quarantined = await unrollThread(adapter, {
    url: "https://www.reddit.com/r/quarantinedsub/comments/q1/q/",
    maxComments: 50,
    sort: "best",
  });
  assert.equal(quarantined.ok, false);
  if (quarantined.ok) {
    return;
  }
  assert.equal(quarantined.code, "subreddit_quarantined");

  const removed = await unrollThread(adapter, {
    url: "https://www.reddit.com/r/test/comments/gone1/removed/",
    maxComments: 50,
    sort: "best",
  });
  assert.equal(removed.ok, false);
  if (removed.ok) {
    return;
  }
  assert.equal(removed.code, "not_found");
});

test("mocked live morechildren expands without inventing comment text", async () => {
  const adapter = createLiveRedditAdapter({
    fetch: mockFetch((url) => {
      if (url.pathname.endsWith(".json") && url.pathname.includes("/comments/more1")) {
        return {
          status: 200,
          body: [
            {
              kind: "Listing",
              data: { children: [listingThing("more1", "Expand me")] },
            },
            {
              kind: "Listing",
              data: {
                children: [
                  {
                    kind: "t1",
                    data: {
                      id: "root1",
                      name: "t1_root1",
                      author: "root",
                      body: "Visible root",
                      score: 5,
                      created_utc: 1_700_001_100,
                      distinguished: null,
                      replies: {
                        kind: "Listing",
                        data: {
                          children: [
                            {
                              kind: "more",
                              data: {
                                count: 1,
                                children: ["exp1"],
                                parent_id: "t1_root1",
                                id: "moreroot",
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          ],
        };
      }
      if (url.pathname === "/api/morechildren") {
        assert.equal(url.searchParams.get("link_id"), "t3_more1");
        assert.equal(url.searchParams.get("children"), "exp1");
        return {
          status: 200,
          body: {
            json: {
              data: {
                things: [
                  {
                    kind: "t1",
                    data: {
                      id: "exp1",
                      name: "t1_exp1",
                      parent_id: "t1_root1",
                      author: "exp",
                      body: "expanded one",
                      score: 4,
                      created_utc: 1_700_001_300,
                      distinguished: null,
                      replies: "",
                    },
                  },
                ],
              },
            },
          },
        };
      }
      throw new Error(`unexpected live url ${url.href}`);
    }),
  });

  const result = await unrollThread(adapter, {
    url: "https://old.reddit.com/r/test/comments/more1/expand_me/",
    maxComments: 50,
    sort: "best",
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.data.commentCount, 2);
  assert.equal(result.data.comments[0]?.replies[0]?.body, "expanded one");
  assert.equal(result.credits, 1);
  assert.equal(result.truncated, false);
});

test("HTTP by-url with mocked live adapter maps private to 403 and 0 credits", async () => {
  const db = openDatabase(":memory:");
  insertKeyFromSecret(db, KEY, { credits: 10 });
  const reddit = createLiveRedditAdapter({
    fetch: mockFetch((url) => {
      assert.match(url.pathname, /\/r\/privatesub\/comments\/priv1/);
      return { status: 403, body: { reason: "private" } };
    }),
  });
  const app = await buildApp({ db, reddit });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/threads/by-url?url=https://www.reddit.com/r/privatesub/comments/priv1/secret/",
    headers: { authorization: `Bearer ${KEY}` },
  });
  const body = response.json() as {
    error: { code: string };
    meta: { creditsCharged: number };
  };
  assert.equal(response.statusCode, 403);
  assert.equal(body.error.code, "subreddit_private");
  assert.equal(body.meta.creditsCharged, 0);
  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, 10);
});

test("HTTP listings and search with mocked live adapter stay 0 credits on failure", async () => {
  const db = openDatabase(":memory:");
  insertKeyFromSecret(db, KEY, { credits: 7 });
  const reddit = createLiveRedditAdapter({
    fetch: mockFetch((url) => {
      if (url.pathname === "/r/privatesub/hot.json") {
        return { status: 403, body: { reason: "private" } };
      }
      if (url.pathname === "/r/quarantinedsub/search.json") {
        return { status: 403, body: { reason: "quarantined" } };
      }
      if (url.pathname === "/r/test/new.json") {
        return {
          status: 200,
          body: {
            kind: "Listing",
            data: { after: null, children: [listingThing("new1", "Newest post")] },
          },
        };
      }
      throw new Error(`unexpected live url ${url.href}`);
    }),
  });
  const app = await buildApp({ db, reddit });
  after(() => app.close());

  const privateListing = await app.inject({
    method: "GET",
    url: "/v1/r/privatesub/hot",
    headers: { authorization: `Bearer ${KEY}` },
  });
  assert.equal(privateListing.statusCode, 403);
  assert.equal(privateListing.json().error.code, "subreddit_private");
  assert.equal(privateListing.json().meta.creditsCharged, 0);

  const quarantinedSearch = await app.inject({
    method: "GET",
    url: "/v1/search?q=secret&sub=quarantinedsub",
    headers: { authorization: `Bearer ${KEY}` },
  });
  assert.equal(quarantinedSearch.statusCode, 403);
  assert.equal(quarantinedSearch.json().error.code, "subreddit_quarantined");
  assert.equal(quarantinedSearch.json().meta.creditsCharged, 0);

  const latest = await app.inject({
    method: "GET",
    url: "/v1/r/test/latest",
    headers: { authorization: `Bearer ${KEY}` },
  });
  const latestBody = latest.json() as { data: { posts: Array<{ title: string }>; sort: string }; meta: { creditsCharged: number } };
  assert.equal(latest.statusCode, 200);
  assert.equal(latestBody.data.sort, "latest");
  assert.equal(latestBody.data.posts[0]?.title, "Newest post");
  assert.equal(latestBody.meta.creditsCharged, 0);

  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, 7);
});

test("rate-limited and network failures map to SPEC errors with 0 credits", async () => {
  const limited = createLiveRedditAdapter({
    fetch: mockFetch(() => ({ status: 429, body: {}, headers: { "retry-after": "12" } })),
  });
  const rate = await limited.fetchListing({ subreddit: "test", sort: "hot", limit: 25 });
  assert.equal(rate.ok, false);
  if (rate.ok) {
    return;
  }
  assert.equal(rate.code, "rate_limited");

  const blocked = createLiveRedditAdapter({
    fetch: async () => {
      throw new Error("ECONNRESET");
    },
  });
  const net = await blocked.fetchSearch({ q: "api", sort: "relevance", limit: 25 });
  assert.equal(net.ok, false);
  if (net.ok) {
    return;
  }
  assert.equal(net.code, "upstream_blocked");
});

test("default buildApp still serves fixture threads (CI path)", async () => {
  const db = openDatabase(":memory:");
  insertKeyFromSecret(db, KEY, { credits: 5 });
  const app = await buildApp({ db });
  after(() => app.close());
  const response = await app.inject({
    method: "GET",
    url: "/v1/threads/by-url?url=https://www.reddit.com/r/test/comments/short1/a_short_thread/",
    headers: { authorization: `Bearer ${KEY}` },
  });
  const body = response.json() as { data: ThreadData; meta: { creditsCharged: number } };
  assert.equal(response.statusCode, 200);
  assert.equal(body.data.post.id, "t3_short1");
  assert.equal(body.meta.creditsCharged, 1);
});

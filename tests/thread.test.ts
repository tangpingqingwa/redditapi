import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createFixtureAdapter } from "../src/adapters/reddit/fixture.js";
import { buildApp } from "../src/app.js";
import { insertKeyFromSecret } from "../src/billing/keys.js";
import {
  creditsForCommentCount,
  parseRedditThreadUrl,
  unrollThread,
} from "../src/core/thread.js";
import { openDatabase } from "../src/db.js";
import type { RedditComment, ThreadData } from "../src/types.js";

const KEY = "rk_test_thread_fixture_secret";

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

function walk(comments: RedditComment[], visit: (c: RedditComment) => void): void {
  for (const comment of comments) {
    visit(comment);
    walk(comment.replies, visit);
  }
}

test("parseRedditThreadUrl accepts reddit.com and old.reddit permalinks", () => {
  assert.deepEqual(
    parseRedditThreadUrl("https://www.reddit.com/r/test/comments/short1/a_short_thread/"),
    { postId: "short1", subreddit: "test", permalink: "/r/test/comments/short1/a_short_thread" },
  );
  assert.deepEqual(
    parseRedditThreadUrl("https://old.reddit.com/r/test/comments/short1/slug/?sort=new"),
    { postId: "short1", subreddit: "test", permalink: "/r/test/comments/short1/slug" },
  );
  assert.deepEqual(parseRedditThreadUrl("reddit.com/comments/short1"), {
    postId: "short1",
    subreddit: null,
    permalink: "/comments/short1",
  });
  assert.equal(parseRedditThreadUrl("https://example.com/r/test/comments/short1"), null);
  assert.equal(parseRedditThreadUrl("not a url"), null);
});

test("credits are 1 at 400 comments and 2 above", () => {
  assert.equal(creditsForCommentCount(0), 1);
  assert.equal(creditsForCommentCount(400), 1);
  assert.equal(creditsForCommentCount(401), 2);
});

test("SPEC 1: short thread returns full tree and charges 1 credit", async () => {
  const { app, db } = await appWithKey();
  const response = await app.inject(
    auth("/v1/threads/by-url?url=https://www.reddit.com/r/test/comments/short1/a_short_thread/"),
  );
  const body = response.json() as { data: ThreadData; meta: Record<string, unknown> };

  assert.equal(response.statusCode, 200);
  assert.equal(body.data.post.id, "t3_short1");
  assert.equal(body.data.post.title, "A short thread");
  assert.equal(body.data.post.author, "alice");
  assert.equal(body.data.post.flair, "Discussion");
  assert.equal(body.data.commentCount, 3);
  assert.equal(body.data.comments.length, 2);
  assert.equal(body.data.comments[0]?.replies[0]?.body, "Nice");
  assert.equal(body.data.comments[1]?.distinguished, "moderator");
  assert.equal(body.meta.creditsCharged, 1);
  assert.equal(body.meta.truncated, false);
  assert.equal(body.meta.cached, false);
  assert.match(String(body.meta.requestId), /^req_/);

  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, 99);
});

test("SPEC 2: MoreComments expands to the cap and sets truncated when needed", async () => {
  const { app } = await appWithKey();
  const full = await app.inject(
    auth("/v1/threads/by-url?url=https://old.reddit.com/r/test/comments/more1/expand_me/"),
  );
  const fullBody = full.json() as { data: ThreadData; meta: { truncated: boolean; creditsCharged: number } };

  assert.equal(full.statusCode, 200);
  assert.equal(fullBody.data.commentCount, 7);
  assert.equal(fullBody.meta.truncated, false);
  assert.equal(fullBody.meta.creditsCharged, 1);
  const ids: string[] = [];
  walk(fullBody.data.comments, (c) => ids.push(c.id));
  assert.ok(ids.includes("t1_exp1"));
  assert.ok(ids.includes("t1_exp4"));
  assert.ok(ids.includes("t1_exp5"));
  assert.equal(fullBody.data.comments[0]?.replies.map((c) => c.id).includes("t1_exp1"), true);

  const capped = await app.inject(
    auth("/v1/threads/by-url?url=https://www.reddit.com/r/test/comments/more1/&max_comments=3"),
  );
  const cappedBody = capped.json() as { data: ThreadData; meta: { truncated: boolean } };
  assert.equal(capped.statusCode, 200);
  assert.equal(cappedBody.data.commentCount, 3);
  assert.equal(cappedBody.meta.truncated, true);
});

test("SPEC 2 large: expanding past 400 comments charges 2 and can truncate", async () => {
  const adapter = createFixtureAdapter();
  const expanded = await unrollThread(adapter, {
    url: "https://www.reddit.com/r/test/comments/big1/large/",
    maxComments: 500,
    sort: "best",
  });
  assert.equal(expanded.ok, true);
  if (!expanded.ok) {
    return;
  }
  assert.equal(expanded.data.commentCount, 450);
  assert.equal(expanded.credits, 2);
  assert.equal(expanded.truncated, false);

  const limited = await unrollThread(adapter, {
    url: "https://www.reddit.com/r/test/comments/big1/large/",
    maxComments: 50,
    sort: "best",
  });
  assert.equal(limited.ok, true);
  if (!limited.ok) {
    return;
  }
  assert.equal(limited.data.commentCount, 50);
  assert.equal(limited.truncated, true);
  assert.equal(limited.credits, 1);

  const { app, db } = await appWithKey();
  const response = await app.inject(
    auth("/v1/threads/by-url?url=https://www.reddit.com/r/test/comments/big1/large/"),
  );
  const body = response.json() as { data: ThreadData; meta: { creditsCharged: number; truncated: boolean } };
  assert.equal(response.statusCode, 200);
  assert.equal(body.data.commentCount, 450);
  assert.equal(body.meta.creditsCharged, 2);
  assert.equal(body.meta.truncated, false);
  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, 98);
});

test("SPEC 3: deleted and removed comments are marked and never reconstructed", async () => {
  const { app } = await appWithKey();
  const response = await app.inject(
    auth("/v1/threads/by-url?url=https://www.reddit.com/r/test/comments/del1/deleted_child/"),
  );
  const body = response.json() as { data: ThreadData };

  assert.equal(response.statusCode, 200);
  const byId = new Map<string, RedditComment>();
  walk(body.data.comments, (c) => byId.set(c.id, c));

  const deleted = byId.get("t1_goneuser");
  assert.ok(deleted);
  assert.equal(deleted.status, "deleted");
  assert.equal(deleted.author, "[deleted]");
  assert.equal(deleted.body, "");
  assert.equal(deleted.bodyMarkdown, "");

  const removed = byId.get("t1_modgone");
  assert.ok(removed);
  assert.equal(removed.status, "removed");
  assert.equal(removed.body, "");
  assert.equal(removed.bodyMarkdown, "");
  assert.equal(removed.score, null);
  assert.equal(removed.distinguished, "admin");

  const visible = byId.get("t1_keep1");
  assert.equal(visible?.status, "visible");
  assert.equal(visible?.body, "Still here");

  const accountDeleted = byId.get("t1_acctgone");
  assert.ok(accountDeleted);
  assert.equal(accountDeleted.status, "visible");
  assert.equal(accountDeleted.author, "[deleted]");
  assert.equal(accountDeleted.body, "Account is gone but the comment remains");
  assert.equal(accountDeleted.bodyMarkdown, "Account is gone but the comment remains");

  const removedByCategory = byId.get("t1_modcat");
  assert.ok(removedByCategory);
  assert.equal(removedByCategory.status, "removed");
  assert.equal(removedByCategory.author, "mod_target");
  assert.equal(removedByCategory.body, "");
  assert.equal(removedByCategory.bodyMarkdown, "");

  const removedByPhrase = byId.get("t1_modphrase");
  assert.ok(removedByPhrase);
  assert.equal(removedByPhrase.status, "removed");
  assert.equal(removedByPhrase.author, "someone");
  assert.equal(removedByPhrase.body, "");
  assert.equal(removedByPhrase.bodyMarkdown, "");
});

test("SPEC 4: removed post is 404 not_found with 0 credits", async () => {
  const { app, db } = await appWithKey();
  const response = await app.inject(
    auth("/v1/threads/by-url?url=https://www.reddit.com/r/test/comments/gone1/removed/"),
  );
  const body = response.json();

  assert.equal(response.statusCode, 404);
  assert.equal(body.error.code, "not_found");
  assert.equal(body.meta.creditsCharged, 0);
  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, 100);
});

test("private subreddit is 403 with 0 credits", async () => {
  const { app } = await appWithKey();
  const response = await app.inject(
    auth("/v1/threads/by-url?url=https://www.reddit.com/r/privatesub/comments/priv1/secret/"),
  );
  const body = response.json();
  assert.equal(response.statusCode, 403);
  assert.equal(body.error.code, "subreddit_private");
  assert.equal(body.meta.creditsCharged, 0);
});

test("missing url, bad sort, and unknown post map to documented errors", async () => {
  const { app } = await appWithKey();

  const missing = await app.inject(auth("/v1/threads/by-url"));
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error.code, "invalid_request");
  assert.equal(missing.json().meta.creditsCharged, 0);

  const badSort = await app.inject(
    auth("/v1/threads/by-url?url=https://www.reddit.com/r/test/comments/short1/&sort=hot"),
  );
  assert.equal(badSort.statusCode, 400);

  const unknown = await app.inject(
    auth("/v1/threads/by-url?url=https://www.reddit.com/r/test/comments/nope1/missing/"),
  );
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().error.code, "not_found");
});

test("unauthenticated by-url is 401 and charges nothing", async () => {
  const app = await buildApp();
  after(() => app.close());
  const response = await app.inject({
    method: "GET",
    url: "/v1/threads/by-url?url=https://www.reddit.com/r/test/comments/short1/",
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().meta.creditsCharged, 0);
});

test("out of credits is 402 before charging a 2-credit unroll", async () => {
  const { app, db } = await appWithKey(1);
  const response = await app.inject(
    auth("/v1/threads/by-url?url=https://www.reddit.com/r/test/comments/big1/large/"),
  );
  assert.equal(response.statusCode, 402);
  assert.equal(response.json().error.code, "payment_required");
  assert.equal(response.json().meta.creditsCharged, 0);
  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, 1);
});

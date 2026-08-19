import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createFixtureAdapter } from "../src/adapters/reddit/fixture.js";
import { buildApp } from "../src/app.js";
import { insertKeyFromSecret } from "../src/billing/keys.js";
import type { AdapterFailure, AdapterMoreOk, AdapterThreadOk, RedditAdapter, ThreadRef } from "../src/core/thread.js";
import { openDatabase } from "../src/db.js";
import type { ThreadSort } from "../src/types.js";
import { LEGAL_FOOTER } from "../src/views/legal.js";

const KEY = "rk_test_html_unroller";

async function htmlApp(reddit?: RedditAdapter) {
  const db = openDatabase(":memory:");
  insertKeyFromSecret(db, KEY, { credits: 50 });
  const app = await buildApp({
    db,
    reddit: reddit ?? createFixtureAdapter(),
  });
  after(() => app.close());
  return { app, db };
}

function isHtml(response: { headers: Record<string, unknown> }): void {
  const type = String(response.headers["content-type"] ?? "");
  assert.match(type, /text\/html/);
}

function robots(headers: Record<string, unknown>): string {
  return String(headers["x-robots-tag"] ?? "");
}

test("GET / is an HTML unroller form with ads, API CTA, and legal footer", async () => {
  const { app } = await htmlApp();
  const response = await app.inject({ method: "GET", url: "/" });
  assert.equal(response.statusCode, 200);
  isHtml(response);
  const body = response.body;
  assert.match(body, /<form /);
  assert.match(body, /name="url"/);
  assert.match(body, /reddit thread unroller/i);
  assert.match(body, /adsbygoogle/);
  assert.match(body, /data-ad-client=/);
  assert.match(body, /Need a Reddit thread API\?/);
  assert.match(body, /href="\/#pricing"/);
  assert.ok(body.includes(LEGAL_FOOTER));
  assert.match(body, /not affiliated/);
  assert.doesNotMatch(body, /name=["']robots["'][^>]*noindex/i);
  assert.equal(robots(response.headers), "");
  assert.doesNotMatch(body, /__NEXT_DATA__/);
});

test("GET /?url= redirects to the permalink path for reddit.com and old.reddit", async () => {
  const { app } = await htmlApp();
  const cases = [
    [
      "https://www.reddit.com/r/test/comments/short1/a_short_thread/",
      "/r/test/comments/short1/a_short_thread",
    ],
    [
      "https://old.reddit.com/r/test/comments/short1/a_short_thread/?sort=new",
      "/r/test/comments/short1/a_short_thread",
    ],
  ] as const;
  for (const [url, location] of cases) {
    const response = await app.inject({
      method: "GET",
      url: `/?url=${encodeURIComponent(url)}`,
    });
    assert.equal(response.statusCode, 302, url);
    assert.equal(response.headers.location, location);
  }
});

test("SPEC 7: unroller HTML contains comment text", async () => {
  const { app, db } = await htmlApp();
  const before = db.prepare("SELECT credits FROM keys").get() as { credits: number };

  const response = await app.inject({
    method: "GET",
    url: "/r/test/comments/short1/a_short_thread",
  });
  assert.equal(response.statusCode, 200);
  isHtml(response);
  assert.equal(robots(response.headers), "");
  assert.doesNotMatch(response.body, /name=["']robots["'][^>]*noindex/i);
  assert.match(response.body, /A short thread/);
  assert.match(response.body, /Hello \*\*world\*\*/);
  assert.match(response.body, /First!/);
  assert.match(response.body, /Nice/);
  assert.match(response.body, /Second/);
  assert.match(response.body, /data-comment-id="t1_c1"/);
  assert.match(response.body, /data-comment-id="t1_c1r1"/);
  assert.match(response.body, /data-comment-id="t1_c2"/);
  assert.ok(response.body.includes(LEGAL_FOOTER));
  assert.match(response.body, /adsbygoogle/);
  assert.match(response.body, /Need a Reddit thread API\?/);
  assert.match(response.body, /href="\/#pricing"/);
  assert.doesNotMatch(response.body, /__NEXT_DATA__/);

  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, before.credits);
});

test("permalink without slug still unrolls the fixture thread", async () => {
  const { app } = await htmlApp();
  const response = await app.inject({ method: "GET", url: "/r/test/comments/short1" });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /First!/);
});

test("failed unroll is noindex HTML and leaves the comment tree empty", async () => {
  const { app, db } = await htmlApp();

  const removed = await app.inject({ method: "GET", url: "/r/test/comments/gone1/removed" });
  assert.equal(removed.statusCode, 404);
  isHtml(removed);
  assert.match(robots(removed.headers), /noindex/i);
  assert.match(removed.body, /name=["']robots["'][^>]*content=["']noindex["']/i);
  assert.match(removed.body, /We could not unroll this thread/);
  assert.match(removed.body, /deleted or does not exist/i);
  assert.doesNotMatch(removed.body, /data-comment-id=/);
  assert.doesNotMatch(removed.body, /class="comment"/);
  assert.ok(removed.body.includes(LEGAL_FOOTER));

  const priv = await app.inject({
    method: "GET",
    url: "/r/privatesub/comments/priv1/secret",
  });
  assert.equal(priv.statusCode, 403);
  assert.match(robots(priv.headers), /noindex/i);
  assert.match(priv.body, /We could not unroll this thread/);
  assert.match(priv.body, /private/i);
  assert.doesNotMatch(priv.body, /data-comment-id=/);

  const unknown = await app.inject({ method: "GET", url: "/r/test/comments/nope1/missing" });
  assert.equal(unknown.statusCode, 404);
  assert.match(robots(unknown.headers), /noindex/i);
  assert.doesNotMatch(unknown.body, /data-comment-id=/);

  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, 50);
});

test("empty and junk paste-box URLs are 400 noindex HTML", async () => {
  const { app } = await htmlApp();

  const empty = await app.inject({ method: "GET", url: "/?url=" });
  assert.equal(empty.statusCode, 400);
  isHtml(empty);
  assert.match(robots(empty.headers), /noindex/i);
  assert.match(empty.body, /name=["']robots["'][^>]*noindex/i);
  assert.match(empty.body, /Paste a reddit\.com or old\.reddit permalink/);
  assert.doesNotMatch(empty.body, /data-comment-id=/);

  const junk = await app.inject({
    method: "GET",
    url: `/?url=${encodeURIComponent("https://example.com/not-a-thread")}`,
  });
  assert.equal(junk.statusCode, 400);
  isHtml(junk);
  assert.match(robots(junk.headers), /noindex/i);
  assert.match(junk.body, /reddit\.com or old\.reddit permalink/);
  assert.doesNotMatch(junk.body, /data-comment-id=/);
});

test("deleted and removed comments stay empty on the HTML page", async () => {
  const { app } = await htmlApp();
  const response = await app.inject({
    method: "GET",
    url: "/r/test/comments/del1/deleted_child",
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Still here/);
  assert.match(response.body, /Account is gone but the comment remains/);
  assert.match(response.body, /data-comment-id="t1_goneuser"[^>]*data-status="deleted"/);
  assert.match(response.body, /data-comment-id="t1_modgone"[^>]*data-status="removed"/);
  assert.doesNotMatch(response.body, /this should be wiped/);
  assert.doesNotMatch(response.body, /\[deleted\]<\/p>/);
  assert.doesNotMatch(response.body, /\[removed\]/);
  assert.doesNotMatch(response.body, /\[removed by moderator\]/);
});

test("HTML unroller does not charge API credits and stays offline", async () => {
  let threadCalls = 0;
  const fixture = createFixtureAdapter();
  const reddit: RedditAdapter = {
    async fetchThread(ref: ThreadRef, sort: ThreadSort): Promise<AdapterThreadOk | AdapterFailure> {
      threadCalls += 1;
      return fixture.fetchThread(ref, sort);
    },
    async fetchMoreChildren(): Promise<AdapterMoreOk | AdapterFailure> {
      throw new Error("HTML unroller must not need morechildren for the short fixture");
    },
  };
  const { app, db } = await htmlApp(reddit);
  const first = await app.inject({ method: "GET", url: "/r/test/comments/short1/a_short_thread" });
  const second = await app.inject({ method: "GET", url: "/r/test/comments/short1/a_short_thread" });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(threadCalls, 2);
  const remaining = db.prepare("SELECT credits FROM keys").get() as { credits: number };
  assert.equal(remaining.credits, 50);
});

test("user-supplied URL text is escaped on the error page", async () => {
  const { app } = await htmlApp();
  const xss = `"><script>alert(1)</script>`;
  const response = await app.inject({
    method: "GET",
    url: `/?url=${encodeURIComponent(xss)}`,
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.includes("<script>alert(1)</script>"), false);
  assert.match(response.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("static unroller assets are served from public/", async () => {
  const { app } = await htmlApp();
  const css = await app.inject({ method: "GET", url: "/unroller.css" });
  assert.equal(css.statusCode, 200);
  assert.match(String(css.headers["content-type"] ?? ""), /text\/css/);
  assert.match(css.body, /adsbygoogle|\.ad /);

  const js = await app.inject({ method: "GET", url: "/unroller.js" });
  assert.equal(js.statusCode, 200);
  assert.match(String(js.headers["content-type"] ?? ""), /javascript/);
  assert.match(js.body, /#copy-thread/);
  assert.match(js.body, /clipboard/);
});

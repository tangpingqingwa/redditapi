import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterFailure,
  AdapterListingOk,
  AdapterMoreOk,
  AdapterThreadOk,
  ListingFetchInput,
  RedditAdapter,
  ThreadRef,
} from "../../core/thread.js";
import type { ThreadSort } from "../../types.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

type FixtureKind = "listing" | "error" | "large" | "listings";

type FixtureErrorDoc = {
  kind: "error";
  code: "not_found" | "subreddit_private" | "subreddit_quarantined";
  message?: string;
};

type FixtureLargeDoc = {
  kind: "large";
  postId: string;
  subreddit: string;
  title: string;
  firstPage: number;
  more: number;
};

type FixtureListingPost = {
  id: string;
  title: string;
  author: string;
  selftext: string;
  score: number;
  created_utc: number;
  over_18: boolean;
  spoiler: boolean;
  locked: boolean;
  link_flair_text: string | null;
};

type FixtureListingsDoc = {
  kind: "listings";
  subreddit: string;
  posts: FixtureListingPost[];
};

const POST_FIXTURES: Record<string, string> = {
  short1: "small.json",
  more1: "with-more.json",
  del1: "deleted.json",
  gone1: "removed-post.json",
  priv1: "private.json",
  big1: "large.json",
};

let moreIndex: Map<string, unknown> | undefined;

export function createFixtureAdapter(): RedditAdapter {
  return {
    async fetchThread(ref: ThreadRef, _sort: ThreadSort): Promise<AdapterThreadOk | AdapterFailure> {
      if (ref.subreddit?.toLowerCase() === "privatesub") {
        return readError("private.json");
      }
      const file = POST_FIXTURES[ref.postId];
      if (file === undefined) {
        return { ok: false, code: "not_found" };
      }
      const doc = readJson(file);
      const kind = fixtureKind(doc);
      if (kind === "error") {
        return errorFromDoc(doc);
      }
      if (kind === "large") {
        return { ok: true, listing: buildLargeListing(doc as FixtureLargeDoc) };
      }
      return { ok: true, listing: doc };
    },

    async fetchMoreChildren(
      linkId: string,
      children: string[],
      _sort: ThreadSort,
    ): Promise<AdapterMoreOk | AdapterFailure> {
      if (linkId === "t3_big1" || linkId === "big1") {
        return { ok: true, things: children.map((id) => syntheticComment(id, linkId)) };
      }
      const index = loadMoreIndex();
      const things: unknown[] = [];
      for (const id of children) {
        const thing = index.get(id) ?? index.get(id.replace(/^t1_/, ""));
        if (thing !== undefined) {
          things.push(thing);
        }
      }
      return { ok: true, things };
    },

    async fetchListing(input: ListingFetchInput): Promise<AdapterListingOk | AdapterFailure> {
      const sub = input.subreddit.toLowerCase();
      if (sub === "privatesub") {
        return readError("private.json");
      }
      if (sub === "quarantinedsub") {
        return { ok: false, code: "subreddit_quarantined", message: "This subreddit is quarantined." };
      }
      if (sub !== "test") {
        return { ok: false, code: "not_found" };
      }
      return { ok: true, listing: buildSubredditListing(input) };
    },
  };
}

function fixtureKind(doc: unknown): FixtureKind {
  if (typeof doc === "object" && doc !== null && "kind" in doc) {
    const kind = (doc as { kind: unknown }).kind;
    if (kind === "error" || kind === "large" || kind === "listings") {
      return kind;
    }
  }
  return "listing";
}

function readError(file: string): AdapterFailure {
  return errorFromDoc(readJson(file));
}

function errorFromDoc(doc: unknown): AdapterFailure {
  const typed = doc as FixtureErrorDoc;
  return { ok: false, code: typed.code, message: typed.message };
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8")) as unknown;
}

function loadMoreIndex(): Map<string, unknown> {
  if (moreIndex !== undefined) {
    return moreIndex;
  }
  const doc = readJson("morechildren.json") as { json?: { data?: { things?: unknown[] } } };
  const things = doc.json?.data?.things ?? [];
  const index = new Map<string, unknown>();
  for (const thing of things) {
    if (typeof thing !== "object" || thing === null || !("data" in thing)) {
      continue;
    }
    if ((thing as { kind?: unknown }).kind !== "t1") {
      continue;
    }
    const data = (thing as { data?: { id?: unknown; name?: unknown } }).data;
    if (typeof data?.id === "string") {
      index.set(data.id, thing);
    }
    if (typeof data?.name === "string") {
      index.set(data.name, thing);
      index.set(data.name.replace(/^t1_/, ""), thing);
    }
  }
  moreIndex = index;
  return index;
}

function buildLargeListing(doc: FixtureLargeDoc): unknown {
  const postId = doc.postId.replace(/^t3_/, "");
  const children: unknown[] = [];
  for (let i = 0; i < doc.firstPage; i += 1) {
    children.push(syntheticComment(`s${i}`, `t3_${postId}`));
  }
  const moreIds = Array.from({ length: doc.more }, (_, i) => `m${i}`);
  children.push({
    kind: "more",
    data: {
      count: moreIds.length,
      children: moreIds,
      parent_id: `t3_${postId}`,
      id: "morelarge",
      name: "t1_morelarge",
    },
  });
  return [
    {
      kind: "Listing",
      data: {
        children: [
          {
            kind: "t3",
            data: {
              id: postId,
              name: `t3_${postId}`,
              subreddit: doc.subreddit,
              title: doc.title,
              author: "op",
              selftext: "Large fixture thread",
              url: `https://www.reddit.com/r/${doc.subreddit}/comments/${postId}/large/`,
              permalink: `/r/${doc.subreddit}/comments/${postId}/large/`,
              score: 1,
              created_utc: 1_700_000_000,
              over_18: false,
              spoiler: false,
              locked: false,
              link_flair_text: null,
            },
          },
        ],
      },
    },
    { kind: "Listing", data: { children } },
  ];
}

function loadListingsDoc(): FixtureListingsDoc {
  return readJson("listings.json") as FixtureListingsDoc;
}

function buildSubredditListing(input: ListingFetchInput): unknown {
  const doc = loadListingsDoc();
  const ordered = orderListingPosts(doc.posts, input);
  const start = cursorIndex(ordered, input.cursor);
  const page = ordered.slice(start, start + input.limit);
  const last = page[page.length - 1];
  const hasMore = start + page.length < ordered.length;
  return {
    kind: "Listing",
    data: {
      after: hasMore && last !== undefined ? `t3_${last.id}` : null,
      children: page.map((post) => listingThing(doc.subreddit, post)),
    },
  };
}

function orderListingPosts(posts: FixtureListingPost[], input: ListingFetchInput): FixtureListingPost[] {
  const copy = posts.slice();
  if (input.sort === "new" || input.sort === "latest") {
    copy.sort((a, b) => b.created_utc - a.created_utc);
    return copy;
  }
  if (input.sort === "top") {
    copy.sort((a, b) => b.score - a.score);
    return copy;
  }
  copy.sort((a, b) => b.score - a.score || b.created_utc - a.created_utc);
  return copy;
}

function cursorIndex(posts: FixtureListingPost[], cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  const id = cursor.replace(/^t3_/, "");
  const index = posts.findIndex((post) => post.id === id);
  return index === -1 ? posts.length : index + 1;
}

function listingThing(subreddit: string, post: FixtureListingPost): unknown {
  return {
    kind: "t3",
    data: {
      id: post.id,
      name: `t3_${post.id}`,
      subreddit,
      title: post.title,
      author: post.author,
      selftext: post.selftext,
      url: `https://www.reddit.com/r/${subreddit}/comments/${post.id}/`,
      permalink: `/r/${subreddit}/comments/${post.id}/`,
      score: post.score,
      created_utc: post.created_utc,
      over_18: post.over_18,
      spoiler: post.spoiler,
      locked: post.locked,
      link_flair_text: post.link_flair_text,
    },
  };
}

function syntheticComment(id: string, parentId: string): unknown {
  const short = id.replace(/^t1_/, "");
  return {
    kind: "t1",
    data: {
      id: short,
      name: `t1_${short}`,
      parent_id: parentId.startsWith("t3_") || parentId.startsWith("t1_") ? parentId : `t3_${parentId}`,
      author: "user",
      body: `comment ${short}`,
      score: 1,
      created_utc: 1_700_000_100,
      distinguished: null,
      replies: "",
    },
  };
}

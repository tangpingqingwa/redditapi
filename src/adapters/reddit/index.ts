import { liveRedditEnabled } from "../../config.js";
import type { RedditAdapter } from "../../core/thread.js";
import { createFixtureAdapter } from "./fixture.js";
import { createLiveRedditAdapter } from "./live.js";

export { createFixtureAdapter } from "./fixture.js";
export { createLiveRedditAdapter } from "./live.js";

/** Fixture unless REDDITAPI_LIVE=1. Tests inject an adapter and stay offline. */
export function createAppAdapter(): RedditAdapter {
  if (liveRedditEnabled()) {
    return createLiveRedditAdapter();
  }
  return createFixtureAdapter();
}

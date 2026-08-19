import { escapeAttr, escapeHtml } from "./escape.js";
import { renderPage } from "./layout.js";

export type HomeInput = {
  url?: string;
  error?: string;
  title?: string;
};

export function renderHome(input: HomeInput = {}): string {
  const urlValue = input.url ?? "";
  const hasError = input.error !== undefined;
  const errorBanner = hasError
    ? `<p class="banner error" role="alert">${escapeHtml(input.error ?? "")}</p>`
    : "";
  const heading = input.title ?? "Reddit thread unroller";
  return renderPage({
    title: hasError ? `${heading} | RedditAPI` : "Reddit thread unroller | RedditAPI",
    description: hasError
      ? (input.error ?? "We could not unroll this thread.")
      : "Paste a Reddit thread URL. Read the post and nested comments as clean text. Free, no signup.",
    noindex: hasError,
    canonicalPath: hasError ? undefined : "/",
    body: `<main>
    <h1>${escapeHtml(heading)}</h1>
    <p>Paste a public reddit.com or old.reddit permalink. We expand the comment tree. Deleted and removed comments stay empty — we never invent a body.</p>
    ${errorBanner}
    ${renderPasteForm(urlValue)}
    <section id="pricing">
      <h2>Need this as JSON?</h2>
      <p>Same backend as this page: <code>GET /v1/threads/by-url</code>. 100 free credits. $5 / 1,000. Annual $54.</p>
    </section>
  </main>`,
  });
}

export function renderPasteForm(urlValue = ""): string {
  return `<form method="get" action="/">
      <label for="url">Reddit thread URL</label>
      <input id="url" name="url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://www.reddit.com/r/test/comments/abc123/slug/" value="${escapeAttr(urlValue)}">
      <button type="submit">Unroll thread</button>
    </form>`;
}

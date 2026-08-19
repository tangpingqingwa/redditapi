import type { RedditComment, RedditPost, ThreadData } from "../types.js";
import { escapeAttr, escapeHtml, nl2br } from "./escape.js";
import { renderPage } from "./layout.js";

export function renderThreadPage(data: ThreadData, truncated: boolean): string {
  const { post } = data;
  const title = `${post.title} | RedditAPI`;
  const description = firstLine(post.selftext) || `Unrolled r/${post.subreddit} thread: ${post.title}`;
  const flags = postFlags(post);
  const selftext =
    post.selftext === ""
      ? ""
      : `<div class="selftext">${nl2br(escapeHtml(post.selftext))}</div>`;
  const comments =
    data.comments.length === 0
      ? `<p class="empty-comments">No comments.</p>`
      : `<ol class="comments">${data.comments.map((comment) => renderComment(comment)).join("\n")}</ol>`;
  const truncatedNote = truncated
    ? `<p class="banner truncated" role="status">This tree was truncated at the comment cap.</p>`
    : "";
  return renderPage({
    title,
    description,
    canonicalPath: post.permalink,
    body: `<main>
    <p><a href="/">← New unroll</a></p>
    <article class="post" data-post-id="${escapeAttr(post.id)}">
      <p class="meta">r/${escapeHtml(post.subreddit)} · ${escapeHtml(post.author)}${flags}</p>
      <h1>${escapeHtml(post.title)}</h1>
      ${selftext}
      <p class="meta">${data.commentCount} comment${data.commentCount === 1 ? "" : "s"}</p>
    </article>
    ${truncatedNote}
    <button type="button" id="copy-thread">Copy thread</button>
    ${comments}
  </main>`,
  });
}

function renderComment(comment: RedditComment): string {
  const statusLabel =
    comment.status === "visible" ? "" : `<span class="status">${escapeHtml(comment.status)}</span>`;
  const body =
    comment.status === "visible" && comment.body !== ""
      ? `<p class="comment-body">${nl2br(escapeHtml(comment.body))}</p>`
      : `<p class="comment-body comment-empty"></p>`;
  const replies =
    comment.replies.length === 0
      ? ""
      : `<ol class="comments">${comment.replies.map((reply) => renderComment(reply)).join("\n")}</ol>`;
  return `<li class="comment" id="${escapeAttr(comment.id)}" data-comment-id="${escapeAttr(comment.id)}" data-status="${escapeAttr(comment.status)}">
      <header>
        <span class="author">${escapeHtml(comment.author)}</span>
        ${statusLabel}
      </header>
      ${body}
      ${replies}
    </li>`;
}

function postFlags(post: RedditPost): string {
  const bits: string[] = [];
  if (post.nsfw) {
    bits.push("NSFW");
  }
  if (post.spoiler) {
    bits.push("spoiler");
  }
  if (post.locked) {
    bits.push("locked");
  }
  if (post.flair !== null && post.flair !== "") {
    bits.push(post.flair);
  }
  return bits.length === 0 ? "" : ` · ${escapeHtml(bits.join(" · "))}`;
}

function firstLine(text: string): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  if (line === "") {
    return "";
  }
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

(() => {
  const button = document.querySelector("#copy-thread");
  if (!button) {
    return;
  }
  button.addEventListener("click", () => {
    const title = document.querySelector("article.post h1");
    const selftext = document.querySelector("article.post .selftext");
    const comments = Array.from(document.querySelectorAll(".comment-body"))
      .map((el) => (el.textContent || "").trim())
      .filter(Boolean);
    const parts = [];
    if (title && title.textContent) {
      parts.push(title.textContent.trim());
    }
    if (selftext && selftext.textContent) {
      parts.push(selftext.textContent.trim());
    }
    parts.push(...comments);
    const text = parts.join("\n\n");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
    }
  });
})();

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPE[ch] ?? ch);
}

export function escapeAttr(value: string): string {
  return escapeHtml(value);
}

export function nl2br(escaped: string): string {
  return escaped.replace(/\n/g, "<br>");
}

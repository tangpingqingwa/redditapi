import { escapeAttr, escapeHtml } from "./escape.js";
import { ADSENSE_CLIENT, ADSENSE_SLOT, API_CTA_HREF, API_CTA_LABEL, LEGAL_FOOTER } from "./legal.js";

export type PageOptions = {
  title: string;
  description: string;
  body: string;
  canonicalPath?: string;
  noindex?: boolean;
};

export function renderPage(options: PageOptions): string {
  const robots = options.noindex === true ? `  <meta name="robots" content="noindex">\n` : "";
  const canonical =
    options.noindex === true || options.canonicalPath === undefined
      ? ""
      : `  <link rel="canonical" href="${escapeAttr(options.canonicalPath)}">\n`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
${robots}  <title>${escapeHtml(options.title)}</title>
  <meta name="description" content="${escapeAttr(options.description)}">
${canonical}  <link rel="stylesheet" href="/unroller.css">
  <script src="/unroller.js" defer></script>
</head>
<body>
  ${options.body}
  ${renderAdSlot()}
  ${renderFooter()}
</body>
</html>
`;
}

export function renderFooter(): string {
  return `<footer>
    <p><a href="${escapeAttr(API_CTA_HREF)}">${escapeHtml(API_CTA_LABEL)}</a></p>
    <p>${escapeHtml(LEGAL_FOOTER)}</p>
  </footer>`;
}

export function renderAdSlot(): string {
  return `<aside class="ad" aria-label="advertisement">
    <ins class="adsbygoogle"
         style="display:block"
         data-ad-client="${escapeAttr(ADSENSE_CLIENT)}"
         data-ad-slot="${escapeAttr(ADSENSE_SLOT)}"
         data-ad-format="auto"
         data-full-width-responsive="true"></ins>
  </aside>`;
}

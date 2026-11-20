// The page for an address that is nothing of the site:
// design/copy/not-found.md. The Go backend answered such an address in plain
// text; here it is a page like the others, so that on a test roster's site
// it has the mark and the date above it (design/copy/test-site.md: a link
// that stopped working after the roster was cleared lands here). Nothing of
// the address is written back.
import { html } from "./html.ts";
import type { Document } from "./layout.ts";

export function notFoundPage(): Document {
  const content = html`<section class="missing">
<h1 class="title">找不到這一頁</h1>
<p>這個網址沒有對到任何頁面。請確認網址有沒有抄錯。</p>
<p><a href="/">回到首頁</a></p>
</section>`;
  return { title: "找不到這一頁", kind: "not-found", content };
}

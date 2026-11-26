// The page for a network that sent too many requests for pages:
// design/copy/too-many-requests.md, with 429 and Retry-After (ADR-0026).
// It says how long to wait and nothing of who was counted: no address.
// It is laid out as the page for an address that is not there (its class,
// so the style sheet has nothing new), and has no link preview.
import { html } from "./html.ts";
import type { Document } from "./layout.ts";

export function tooManyRequestsPage(): Document {
  const content = html`<section class="missing">
<h1 class="title">請稍後再試</h1>
<p>這個網路送出的請求太多，請過一分鐘再試。</p>
</section>`;
  return { title: "請稍後再試", kind: "not-found", preview: false, content };
}

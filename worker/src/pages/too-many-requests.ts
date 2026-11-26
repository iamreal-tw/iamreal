// The page for a network that sent too many requests for pages:
// design/copy/too-many-requests.md, with 429 and Retry-After (ADR-0026).
// It says how long to wait and nothing of who was counted: no address.
// It is laid out as the page for an address that is not there (its class,
// so the style sheet has nothing new), and has no link preview.
import { html } from "./html.ts";
import type { Document } from "./layout.ts";

/**
 * The page for when the proof log's object is overloaded (ADR-0026,
 * "Durable Object 撐不住時"): design/copy/too-many-requests.md, "人太多的時候",
 * with 503 and Retry-After. Not this network's doing, so it says nothing of
 * one.
 */
export function busyPage(): Document {
  const content = html`<section class="missing">
<h1 class="title">現在人太多</h1>
<p>現在使用島民證明的人太多，請過一分鐘再試。</p>
</section>`;
  return { title: "現在人太多", kind: "not-found", preview: false, content };
}

export function tooManyRequestsPage(): Document {
  const content = html`<section class="missing">
<h1 class="title">請稍後再試</h1>
<p>這個網路送出的請求太多，請過一分鐘再試。</p>
</section>`;
  return { title: "請稍後再試", kind: "not-found", preview: false, content };
}

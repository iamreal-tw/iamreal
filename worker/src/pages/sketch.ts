// The pictures of the pages that teach (design/copy/check.md, 示意圖;
// design/copy/hang.md, 示意圖): a rounded panel on the soft grey, its title a
// small line, its pieces drawn with the style sheet's classes and hidden
// from a screen reader, which is told the picture in words instead. No
// image, no inline style. The example profile is one drawing for both
// pages: the line a holder hangs on /hang is the line a visitor looks for
// on /check.
import { type Html, html } from "./html.ts";

/** A picture: its title, what a screen reader is told of it, its pieces (hidden from a screen reader) and, if it has one, the sentence under it. */
export function sketch(kind: string, title: string, told: string, pieces: Html, note?: string): Html {
  return html`<figure class="sketch ${kind}">
<figcaption>${title}</figcaption>
<p class="sr">${told}</p>
<div class="sketch-body" aria-hidden="true">
${pieces}
</div>
${note === undefined ? html`` : html`<p class="sketch-note">${note}</p>
`}</figure>`;
}

/** A small label under what it marks: in ink for what to look for (check.md), in raspberry for where to press (hang.md). */
export function tag(words: string, kind: "find" | "press"): Html {
  return html`<span class="tag${kind === "press" ? " press" : ""}">${words}</span>`;
}

/** What a profile drawing shows. */
export interface Profile {
  /** The display name, or null for a grey bar in its place. */
  name: string | null;
  /** The account, with its @. */
  account: string;
  /** The account bold and underlined, as the one to compare (check.md, step 3). */
  same?: boolean;
  /** Smaller, beside another picture (check.md, step 3). */
  small?: boolean;
  /** The link under the bio, written without https://, and the label of the frame around it if it has one. */
  link?: { address: string; found?: string };
  /** The number of followers as words, or null for a grey bar in its place. */
  followers: string | null;
  /** The two buttons under the profile, the left one 編輯個人檔案 marked as where to press with this label (hang.md, 圖 1). */
  edit?: string;
}

/** The example profile: a white card with a thin frame, nothing of Threads' own look. */
export function profile(p: Profile): Html {
  const link = p.link === undefined ? html`` : html`<p class="link-row${p.link.found === undefined ? "" : " boxed"}"><span class="link-icon"></span>${p.link.address}</p>
${p.link.found === undefined ? html`` : html`${tag(p.link.found, "find")}
`}`;
  return html`<div class="profile${p.small ? " small" : ""}">
<div class="who">${p.name === null ? html`<span class="name blank"></span>` : html`<b class="name">${p.name}</b>`}<span class="handle${p.same ? " same" : ""}">${p.account}</span></div>
<span class="avatar"></span>
<span class="bio"></span>
<span class="bio short"></span>
${link}${p.followers === null ? html`<span class="followers blank"></span>` : html`<p class="followers">${p.followers}</p>`}
${p.edit === undefined ? html`` : html`<p class="buttons"><span class="press">編輯個人檔案</span><span class="blank"></span></p>
${tag(p.edit, "press")}
`}</div>`;
}

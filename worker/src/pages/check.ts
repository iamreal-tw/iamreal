// How to check a Threads account's proof: design/copy/check.md. Four steps,
// each a row: its words and its 惡意手法 (a <details>, closed until it is
// opened, so that the page needs no script) on the left, its picture on the
// right. Then what a proof tells you, three side by side, and the usual
// situations, as on what a card proof needs.
//
// The pictures are drawn with the style sheet's classes, in the colours
// check.md allows (ink, text, secondary, line, soft): no image, no inline
// style. Their pieces are hidden from a screen reader, which is told each
// picture in words instead. The names, addresses, dates and numbers in
// them are check.md's fixed examples, not the proof log's. Where a step or
// a picture writes a proof's address or the site's domain, it writes the
// site's own (design/copy/test-site.md).
import { type Html, html } from "./html.ts";
import type { Document, Site } from "./layout.ts";

/** The short ID of check.md's examples. */
const EXAMPLE = "7K2Q9FM4XD";

/** One step: its number, its name, what it says, its 惡意手法 and its picture. */
function step(n: number, name: string, says: Html | string, trick: string, picture: Html): Html {
  return html`<li class="step">
<div class="step-text">
<span class="n">${n}</span>
<h3>${name}</h3>
<p>${says}</p>
<details class="trick">
<summary>惡意手法</summary>
<p>${trick}</p>
</details>
</div>
${picture}
</li>`;
}

/** A picture: its title, what a screen reader is told of it, its pieces (hidden from a screen reader) and, if it has one, the sentence under it. */
function sketch(kind: string, title: string, told: string, pieces: Html, note?: string): Html {
  return html`<figure class="sketch ${kind}">
<figcaption>${title}</figcaption>
<p class="sr">${told}</p>
<div class="sketch-body" aria-hidden="true">
${pieces}
</div>
${note === undefined ? html`` : html`<p class="sketch-note">${note}</p>
`}</figure>`;
}

/** The profile of check.md's example account, as steps 1 and 3 draw it: in step 1 its link is boxed and labelled, in step 3 its @alice is underlined. */
function profile(host: string, step: 1 | 3): Html {
  const link = html`<span class="link-icon"></span>${host}/p/${EXAMPLE}`;
  return html`<div class="profile${step === 3 ? " small" : ""}">
<div class="who"><b class="name">Alice</b><span class="handle${step === 3 ? " same" : ""}">@alice</span></div>
<span class="avatar"></span>
<span class="bio"></span>
<span class="bio short"></span>
${step === 1 ? html`<p class="link-row boxed">${link}</p>
<span class="tag">找這個連結</span>` : html`<p class="link-row">${link}</p>`}
<p class="followers">1,204 位粉絲</p>
</div>`;
}

export function checkPage(site: Site): Document {
  const host = site.host;
  const content = html`<section class="intro">
<h1 class="title">如何檢查 Threads 帳號的島民證明</h1>
<p>在 Threads 上看到一個帳號，想知道有沒有一張台灣的自然人憑證替它背書，照下面四步看。不用安裝任何東西，也不用登入。</p>
</section>
<section class="steps">
<h2>四個步驟</h2>
<ol class="step-list">
${step(
  1,
  "在個人檔案上找連結",
  `打開那個帳號在 Threads 的個人檔案，找 ${host}/p/ 開頭的連結，例如 ${host}/p/${EXAMPLE}。帳號主人自己把這個連結掛上個人檔案，才代表他承認這張證明。`,
  "在貼文、留言或私訊裡貼出島民證明的截圖或連結，宣稱自己有台灣人背書。截圖可以造假，連結也可能是別人的；任何一張卡片都能宣告任何帳號。只有帳號主人掛在自己個人檔案上的連結才算數。",
  sketch("find", "Threads 的個人檔案（示意）", `一個帳號的個人檔案：名稱 Alice、帳號 @alice，簡介下面有一行連結 ${host}/p/${EXAMPLE}，要找的就是這個連結。`, profile(host, 1)),
)}
${step(
  2,
  "點開，看網址列",
  `網域要一字不差是 ${host}。像 ${host}.○○○.com、iamreal-tw.○○○ 這樣前後多了字的，都不是島民證明的網站，不要在那裡輸入任何資料。`,
  "做一個和島民證明長得一模一樣的假網站，網域只差幾個字，在上面寫著這個帳號有島民證明。畫面可以照抄，網域抄不了。",
  sketch(
    "addresses",
    "點開之後的網址列（示意）",
    `三個網址。${host}/p/${EXAMPLE} 是島民證明的網站。${host}.○○○.com/p/${EXAMPLE} 在 ${host} 後面多了字，iamreal-tw.○○○/p/${EXAMPLE} 的網域不一樣，這兩個都不是。`,
    html`<p class="address right"><span class="verdict">是</span><span class="bar"><b>${host}</b>/p/${EXAMPLE}</span></p>
<p class="address-note">島民證明的網站</p>
<p class="not-these">下面這些都不是：</p>
<p class="address wrong"><span class="verdict">✕ 不是</span><span class="bar">${host}<span class="extra">.○○○.com</span>/p/${EXAMPLE}</span></p>
<p class="address-note">${host} 後面多了字</p>
<p class="address wrong"><span class="verdict">✕ 不是</span><span class="bar">iamreal<span class="extra">-</span>tw<span class="extra">.○○○</span>/p/${EXAMPLE}</span></p>
<p class="address-note">網域不一樣</p>`,
  ),
)}
${step(
  3,
  "比對帳號名稱",
  "頁面上最大的字是這張島民證明給的帳號，要和你剛才看的帳號一字不差，句點和底線也算。",
  "把別人的島民證明連結掛到自己的個人檔案上，或取一個很像的帳號名稱，例如用 @alice_ 冒充 @alice。島民證明頁上寫的帳號和你看的不一樣，就不算。",
  sketch(
    "compare",
    "兩邊對照（示意）",
    "左邊是 Threads 的個人檔案，帳號 @alice；右邊是島民證明的頁面，第 1,284 張島民證明，最大的字也是 @alice。",
    html`<div class="side">
<p class="side-label">Threads 的個人檔案</p>
${profile(host, 3)}
</div>
<span class="equals">＝</span>
<div class="side">
<p class="side-label">島民證明的頁面</p>
<div class="proof-sample">
<p class="ordinal">第 1,284 張島民證明</p>
<p class="sample-title">一張台灣國民的自然人憑證，<br>把它在 Threads 唯一的名額給了</p>
<p class="sample-account">@alice</p>
</div>
</div>`,
    "@alice、@alice_、@alice.tw 是三個不同的帳號，要一字不差。",
  ),
)}
${step(
  4,
  "看上次過卡是幾天前",
  "過卡那一天，這張自然人憑證在效期內、不在廢止清冊上。之後卡片還有沒有效，要等下一次過卡才知道。所以越久沒過卡，這張證明的說服力越低；我們建議持卡人每三個月過卡一次。",
  "用一張卡替一個帳號換島民證明，接著掛失這張卡、補辦新卡，再替下一個帳號換一張，一個人就能替好幾個帳號背書。掛失的卡不能再過卡，舊帳號的證明停在掛失之前，天數只會越來越大。",
  sketch(
    "last",
    "島民證明頁上的「上次過卡」（示意）",
    "兩行同樣式的字：上次過卡：12 天前（2026-11-13）；上次過卡：400 天前（2025-10-21）。",
    html`<p class="when">上次過卡：12 天前<span class="date">（2026-11-13）</span></p>
<p class="when">上次過卡：400 天前<span class="date">（2025-10-21）</span></p>`,
    "兩張證明的寫法相同，差別只在天數。天數越大，這張證明的說服力越低：卡片可能已經掛失或過期，再也沒辦法過卡，上次過卡的日期就停在那一天。",
  ),
)}
</ol>
</section>
<section class="tells">
<h2>島民證明告訴你什麼</h2>
<div class="three">
<section><h3>告訴你的</h3>
<p>有一張台灣國民的自然人憑證，把它在 Threads 唯一的名額給了這個帳號，以及上次過卡是哪一天。</p></section>
<section><h3>不會告訴你的</h3>
<p>卡片是誰的，以及過卡的人是不是自然人憑證上的那個人：卡片可能遺失，也可能被借走或賣給別人。</p></section>
<section><h3>一張卡片，一個帳號</h3>
<p>一張自然人憑證在 Threads 同一時間只能把名額給一個帳號。要有一萬個有島民證明的帳號，得先有一萬張真的卡片。</p></section>
</div>
</section>
<section class="situations">
<h2>常見的狀況</h2>
<section class="situation"><h3>個人檔案上沒有連結</h3>
<p>可以到<a href="/proof-log#q">證明紀錄</a>查這個帳號，看有沒有自然人憑證把名額給了它。查得到也不代表帳號主人承認：任何一張卡片都能宣告任何帳號，帳號主人把連結掛上個人檔案，才看得出他承認。</p></section>
<section class="situation"><h3>點開的頁面寫的是別的帳號</h3>
<p>這個連結不是這個帳號的島民證明，不能拿來當作這個帳號的背書。可能是有人故意掛上別人的島民證明，假裝有台灣人背書；也可能是帳號改了名稱、還沒回來更換，或持卡人已經把名額換給了別的帳號。</p></section>
<section class="situation"><h3>頁面說「找不到這張島民證明」</h3>
<p>這個網址沒有對到任何一張自然人憑證。如果你是從某個帳號的個人檔案點進去的，那個帳號掛的島民證明並不存在。可能是有人故意掛上不存在的連結，假裝有台灣人背書；也可能是連結抄錯了。</p></section>
<section class="situation"><h3>想自己驗證每一張島民證明</h3>
<p>每一張島民證明都附著一份零知識證明，公布在證明紀錄裡，任何人都能用公開的程式重算。做法在<a href="/verify">如何驗證證明紀錄</a>。</p></section>
</section>`;
  return { title: "如何檢查 Threads 帳號的島民證明", kind: "check", content };
}

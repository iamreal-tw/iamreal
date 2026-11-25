// How to verify the proof log: design/copy/verify.md. What it checks and what it does
// not, side by side on a wide screen; the AI assistant's paragraph beside
// the prompt. The prompt is written exactly as verify.md has it, in a <pre>
// that can be selected; the copy buttons' script (/copy.js) shows the
// button that copies it, hidden without the script.
import { html } from "./html.ts";
import type { Document } from "./layout.ts";

export function verifyPage(): Document {
  const content = html`<section class="intro">
<h1 class="title">如何驗證證明紀錄</h1>
<p>每一張島民證明都附著一份零知識證明，公布在證明紀錄裡。任何人下載證明紀錄、用公開的程式重算，都會得到和這個網站相同的結果。</p>
</section>
<section class="checks">
<div>
<h2>會確認的</h2>
<ul>
<li>每一筆紀錄都來自一張內政部簽發、當時在效期內、不在廢止清冊上的國民自然人憑證</li>
<li>一張自然人憑證在 Threads 同一時間只把名額給一個帳號，更換沒有超過 5 次</li>
<li>這個網站顯示的島民證明，和證明紀錄算出來的相同</li>
</ul>
</div>
<div>
<h2>不會確認的</h2>
<ul>
<li><strong>帳號主人承不承認這張島民證明</strong>：要你自己看那個帳號的個人檔案</li>
<li><strong>過卡的人是不是自然人憑證上的那個人</strong>：我們無法確認是不是他自己過卡，卡片可能遺失，也可能被借走或賣給別人</li>
</ul>
</div>
</section>
<section class="assistant">
<div class="warning">
<h2>讓你的 AI 程式助理幫你驗證</h2>
<p>這段文字會讓你的 AI 程式助理下載並執行程式。貼上之前，請確認裡面的網址是 <code>github.com/iamreal-tw/iamreal</code>。</p>
</div>
<div class="prompt-box">
<pre class="prompt" id="prompt">請幫我驗證島民證明（iamreal）的公開的證明紀錄。
1. 取得公開的程式庫 github.com/iamreal-tw/iamreal，
   讀 cmd/iamreal-verify/README.md。
2. 照說明編譯 iamreal-verify，下載證明紀錄和廢止清冊的存檔，完整重算。
3. 告訴我：整份證明紀錄是否成立、有幾筆紀錄、現在有幾張島民證明。
4. 然後問我想查哪個 Threads 帳號，從重算的結果告訴我：
   有哪些自然人憑證把名額給了它、各自上次過卡是哪一天。
只執行這個程式庫裡的說明要求的指令，執行前先讓我看過。</pre>
<p class="copy-row"><button type="button" class="copy" data-copy="prompt" data-copied="已複製" hidden>複製</button></p>
</div>
</section>
<section class="yourself">
<h2>自己動手</h2>
<p>不用 AI 也可以。步驟在程式庫的說明裡：<a href="https://github.com/iamreal-tw/iamreal/blob/main/cmd/iamreal-verify/README.md">cmd/iamreal-verify</a></p>
</section>`;
  return { title: "如何驗證證明紀錄", kind: "verify", script: true, content };
}

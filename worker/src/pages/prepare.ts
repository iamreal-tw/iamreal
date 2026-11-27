// What a card proof needs: design/copy/prepare.md. Every page's foot links
// here, and so does step 2 of the card proof on the web when the component
// cannot be reached. Two lists side by side on a wide screen (what to have,
// the four steps), then the usual troubles, one heading each. The two links
// out go to MOICA's site, whose addresses prepare.md gives with their
// sources.
import { html } from "./html.ts";
import type { Document } from "./layout.ts";

/** MOICA's download page of the component (prepare.md, section 3). */
const MOICA_DOWNLOAD = "https://moica.nat.gov.tw/rac_plugin.html";

/** MOICA's site, where a locked card is unlocked (prepare.md, section 4). */
const MOICA_SITE = "https://moica.nat.gov.tw/";

export function preparePage(): Document {
  const content = html`<section class="intro">
<h1 class="title">過卡需要什麼</h1>
<p>用電腦過卡要先準備好讀卡機和內政部的元件。用手機過卡只要手機和卡片，不用看這一頁。</p>
</section>
<div class="columns">
<section class="needs">
<h2>需要什麼</h2>
<dl class="items">
<div><dt>實體的自然人憑證</dt><dd>本國國民的自然人憑證。行動自然人憑證不能用。</dd></div>
<div><dt>晶片讀卡機</dt><dd>插得進自然人憑證的 USB 讀卡機。</dd></div>
<div><dt>Windows 10 以上或 macOS 的電腦</dt><dd>和一般的瀏覽器。</dd></div>
<div><dt>內政部的「跨平台網頁元件」</dt><dd>讓網頁能透過讀卡機和卡片溝通，裝在你的電腦上。</dd></div>
<div><dt>卡片的 PIN</dt><dd>自然人憑證的密碼。</dd></div>
</dl>
</section>
<section class="how">
<h2>四個步驟</h2>
<ol class="items">
<li><span class="n">1</span><div><b>下載並安裝內政部的「跨平台網頁元件」</b><p>到<a href="${MOICA_DOWNLOAD}">內政部憑證管理中心的下載頁</a>，選你的作業系統（Windows 或 macOS），照畫面安裝。已經裝過的，也到同一頁下載最新版，先移除舊版再安裝。安裝完成後，關掉所有網頁，再重新打開瀏覽器。</p></div></li>
<li><span class="n">2</span><div><b>確認元件裝好了</b><p>Windows：「開始」的「所有程式」裡有「跨平台網頁元件」資料夾。macOS：打開「應用程式」裡的 HiPKILocalSignServer，上面寫「目前狀態為：開啟中」；寫「關閉中」的話，按「啟動HiPKILocalSignServer」。</p></div></li>
<li><span class="n">3</span><div><b>接上讀卡機，插入自然人憑證</b><p>晶片朝讀卡機裡面插到底。</p></div></li>
<li><span class="n">4</span><div><b>開始過卡</b><p>回到島民證明，按「我要換島民證明」，選「我的電腦有讀卡機」。</p></div></li>
</ol>
</section>
</div>
<section class="situations">
<h2>常見的狀況</h2>
<section class="situation"><h3>過卡時說「連不上內政部的元件」</h3>
<p>元件沒有安裝，或沒有在執行。請照上面第 1、2 步確認，再回到過卡的畫面按「再讀一次卡片」。</p></section>
<section class="situation"><h3>過卡時說「找不到讀卡機」</h3>
<p>請確認讀卡機已經接上電腦。換一個 USB 孔，或拔掉再接一次。</p></section>
<section class="situation"><h3>瀏覽器擋下了內政部元件的視窗</h3>
<p>請按網址列右邊的「已封鎖彈出式視窗」，選「一律允許」這個網站，再按一次。</p></section>
<section class="situation"><h3>卡片被鎖住、忘了 PIN</h3>
<p>PIN 連續輸入錯誤三次，卡片會被鎖住。請到<a href="${MOICA_SITE}">內政部憑證管理中心的網站</a>解鎖或重設 PIN。我們不知道你的 PIN，也沒辦法替你解鎖。</p></section>
<section class="situation"><h3>沒有讀卡機</h3>
<p>可以改用手機：下載「島民證明」app，用手機感應卡片，不需要讀卡機和元件。</p></section>
</section>`;
  return { title: "過卡需要什麼", kind: "prepare", content };
}

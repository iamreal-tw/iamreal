// The questions and answers of design/copy/faq.md, each written once: the
// FAQ page (/faq) has every one, under its category, the home page eight
// (design/copy/home.md, 常見問題). The markup is the Go backend's
// (e159ab9:server/pages/templates/faq.html, faq-answers.html). A blank line in
// faq.md is a new paragraph; its lines that start with · are a list.
import { Html, html } from "./html.ts";
import type { Document } from "./layout.ts";

/** One question: its id on the FAQ page (faq.md, under each question), the question and its answer. */
export interface Question {
  readonly id: string;
  readonly question: string;
  readonly answer: Html;
}

/** One category: its name, its id on the FAQ page (faq.md, under each category) and its questions, in faq.md's order. */
export interface Category {
  readonly name: string;
  readonly id: string;
  readonly questions: readonly Question[];
}

/** The four categories of faq.md, in its order. */
export const CATEGORIES: readonly Category[] = [
  {
    name: "關於隱私",
    id: "cat-privacy",
    questions: [
      {
        id: "personal-data",
        question: "我的個資會外流嗎？",
        answer: new Html(`<p>你的姓名、身分證字號、自然人憑證和 PIN 都不會離開你的裝置。公開的證明紀錄會記下哪個社交帳號有島民證明，但對應不回是哪張卡片。</p>
<p><strong>注意：</strong>拿到你的卡片和 PIN 的人，查得出你換過哪個帳號的島民證明，所以卡片請小心保管。</p>`),
      },
      {
        id: "government",
        question: "政府會知道我是哪個帳號嗎？",
        answer: new Html(`<p>從證明紀錄查不出來。Threads、政府、我們，都查不出一張島民證明是哪一張卡片換的。這也是只收實體卡片的原因。</p>
<p>但過卡時連線的 IP 位址會留 31 天，用來限制請求次數、擋下濫用、查問題。</p>
<p>這依賴於當前卡片的金鑰 (RSA 2048) 無法破解，不是永久的保證。</p>`),
      },
      {
        id: "security",
        question: "島民證明服務安全嗎？",
        answer: new Html(`<p>島民證明的程式碼全部公開在 <a href="https://github.com/iamreal-tw/iamreal">GitHub</a>，任何人都能檢查：你的卡片資料是不是真的只留在你的裝置上、伺服器收到了什麼、證明是怎麼算出來的。</p>
<p>證明紀錄也是公開的。任何人都能用公開的程式，自己重新驗證每一張島民證明，不用相信我們。</p>
<p>公開程式碼不代表沒有漏洞。非常歡迎你到 GitHub 回報發現的問題。</p>
<p>有三件事要照實告訴你：</p>
<ul class="dots">
<li>你的島民編號，是用卡片簽一段固定的文字算出來的，只有拿著卡片的人簽得出來。這把金鑰是卡片上的 RSA 2048 位元金鑰，也就是你用自然人憑證報稅時用的同一把。它目前沒有已知的破解方法，但沒有人能保證永遠如此（例如量子電腦出現突破性進展）。很多年後如果卡片的金鑰被破解，手上已經有你憑證的人（例如發卡的內政部），就能查出你換過哪個 Threads 帳號的島民證明。只看得到公開證明紀錄的人，還是查不出來。</li>
<li>網頁版的簽章會經過內政部的讀卡元件，和其他使用自然人憑證的網站一樣。元件看得到卡片簽出來的內容。我們沒有檢查過這個元件會不會留存或送出它。</li>
<li>這套算法由 Claude Fable 5.2 做過設計層面的檢查，還沒有外部的專家審查過。程式碼和規格都是公開的，你也可以自己檢查。</li>
</ul>`),
      },
      {
        id: "what-we-see",
        question: "營運者看得到什麼？",
        answer: new Html(`<p>和證明紀錄裡公開的相同：Threads 帳號、島民編號、日期，還有那一份證明。你的姓名、身分證字號、自然人憑證和 PIN 都不會送到我們的伺服器。</p>
<p>除此之外，你送出過卡的那一次，伺服器記下時間、成功或失敗和 IP 位址，保留 31 天後自動刪除，這是用來擋下濫用與查問題。</p>
<p>頁面和 app 也會送出計數，例如打開了哪一種頁面、過卡走到哪一步，讓營運者知道用戶在哪裡卡住。計數帶著隨機的編號，最長一個月就會更換，所以營運者認不出一個月以前的你。網站不放 cookie，頁面上也沒有其他公司的分析或追蹤程式。</p>`),
      },
      {
        id: "threads-knows",
        question: "打開一張島民證明，Threads 會知道嗎？",
        answer: new Html(`<p>會。</p>
<p>如果你在 Threads 裡點連結，網頁是用 Threads 內建的瀏覽器打開的，它是 Meta 的程式，看得到你打開了哪一頁。想避免的話，複製網址到你自己的瀏覽器打開。</p>
<p>此外，島民證明的頁面也會直接嵌入 Threads 帳號的個人檔案，所以 Threads 知道有人從你的 IP 位址看了這個帳號的個人檔案。如果這個瀏覽器登入著 Threads，它很可能也知道你是哪個帳號，在看哪個個人檔案。</p>`),
      },
    ],
  },
  {
    name: "它能證明什麼",
    id: "cat-what",
    questions: [
      {
        id: "not-a-troll",
        question: "有島民證明，就代表不是網軍嗎？",
        answer: new Html(`<p>不是。它只代表有一張真的自然人憑證，把名額給了這個帳號。島民證明擋不住把自己卡片賣掉的台灣人，但它會讓假帳號的成本變得很高。</p>
<p>自然人憑證需要本人到戶政事務所申辦，一張 250 元。一張自然人憑證在 Threads 只能換一張，要建立一萬個有島民證明的帳號，得先有一萬張真的卡片。</p>`),
      },
      {
        id: "someone-else",
        question: "別人可以換一張寫著我帳號的島民證明嗎？",
        answer: new Html(`<p>可以，這擋不了。但這對對方幾乎沒有好處：他用掉的是自己卡片唯一的名額。你還是可以用自己的卡片，替自己的帳號換一張島民證明，並在個人檔案上掛「自己卡片的證明」。</p>`),
      },
      {
        id: "lent-or-sold",
        question: "卡片借人或賣給別人怎麼辦？",
        answer: new Html(`<p>拿到卡片和 PIN 的人就能產生一筆新的證明紀錄，我們無法判斷證明是否為持卡人產生。</p>
<p>但把自然人憑證交給別人，代價遠遠大過一張島民證明。它加上 PIN，就是你在網路上的身分證和印鑑：對方可以用你的名義報稅、查你的財產和所得資料、向政府申辦各種業務，簽出來的文件有法律效力。</p>
<p>別人看島民證明時，還會注意上次過卡是幾天前。卡片掛失之後，那張卡就不能再更新。</p>`),
      },
      {
        id: "why-refresh",
        question: "為什麼要定期回來更新？",
        answer: new Html(`<p>只有過卡的當下，才檢查得到自然人憑證在效期內、不在廢止清冊上。卡片之後遺失、被廢止、到了別人手上，證明紀錄都不會知道，要等下一次過卡。</p>
<p>惡意用戶可能會不斷「辦新卡，替某個帳號證明、掛失卡片」，掛失後的卡片無法更新島民證明，因此這些證明會呈現不再更新的狀態。而一般正常持卡人可以持續更新同一張島民證明。</p>
<p>我們不會寄信或傳訊息提醒你過卡。提醒只會來自你手機上的島民證明 app，而且是你自己設定的。</p>`),
      },
      {
        id: "lost-card",
        question: "卡片遺失了，我的島民證明怎麼辦？",
        answer: new Html(`<p>先去掛失。掛失之後那張卡片就不能再過卡。</p>
<p>舊的那一張島民證明還會留在證明紀錄裡，沒有人能把它拿掉，但它的上次過卡會停住，越來越舊。</p>
<p>補辦的新卡片是新的名額，可以重新換一張島民證明。記得把個人檔案上的證明連結更新。</p>`),
      },
      {
        id: "ordinal",
        question: "島民證明上的「第 N 張」是什麼？",
        answer: new Html(`<p>這張自然人憑證第一次留下有效的紀錄時，它是證明紀錄裡的第幾張卡片。你可以當成「第 N 張開始使用島民證明的卡片」。之後換帳號、收回再宣告、再次過卡，號碼都不變；換了新的自然人憑證會拿到新的號碼。</p>`),
      },
      {
        id: "profile-not-shown",
        question: "島民證明上的個人檔案為什麼顯示不出來？",
        answer: new Html(`<p>可能是這個帳號不公開、關掉了讓別的網站嵌入的設定、改了名稱，或已經不存在。Threads 對這幾種情況的顯示分不出是哪一種。</p>
<p>這種時候，請直接到 Threads 上看那個帳號的個人檔案有沒有這張島民證明的連結。</p>`),
      },
      {
        id: "renamed",
        question: "我改了 Threads 的名稱，島民證明會跟著改嗎？",
        answer: new Html(`<p>不會。證明紀錄記的是你過卡時填的名稱，我們查不到 Threads 上的改動。請回來過卡，把帳號換成新的名稱；這會用掉一次更換額度，一張卡片最多可以更換 5 次。所有的更換紀錄都會公開。</p>
<p>請留意，你的 Threads 舊名稱之後可能被別人拿去用。記得一起更換證明上的名稱，避免證明繼續寫著舊帳號。</p>`),
      },
    ],
  },
  {
    name: "怎麼用",
    id: "cat-use",
    questions: [
      {
        id: "free",
        question: "這個服務要錢嗎？",
        answer: new Html(`<p>不用。</p>`),
      },
      {
        id: "no-card-yet",
        question: "我還沒有自然人憑證，怎麼辦？",
        answer: new Html(`<p>滿 18 歲，未受監護宣告，本人帶身分證正本，到任何一間戶政事務所申辦，不限戶籍地。申請時要填一個電子郵件信箱。工本費 250 元，當天拿到卡片。</p>`),
      },
      {
        id: "mobile-certificate",
        question: "為什麼不能用行動自然人憑證？",
        answer: new Html(`<p>實體卡片的簽章在卡片裡完成，只經過你的裝置。</p>
<p>行動自然人憑證的簽章要經過內政部的伺服器，內政部查得出是誰在使用；簽章流程還需要輸入身分證字號，我們就得經手不必要的個資。</p>
<p>而且行動自然人憑證的金鑰每年換一次，換手機也會換。島民編號是從金鑰算出來的，金鑰一換就是新的編號，一個人就能換好幾張島民證明。</p>
<p>基於上述考量，只能收實體的卡片。</p>`),
      },
      {
        id: "not-a-citizen",
        question: "我不是中華民國國民，可以用嗎？",
        answer: new Html(`<p>不行。島民證明只接受台灣中華民國國民的自然人憑證正卡。非中華民國國籍人所持有的自然人憑證無法使用於島民證明。</p>`),
      },
      {
        id: "under-18",
        question: "我未滿 18 歲，可以用嗎？",
        answer: new Html(`<p>目前不行。自然人憑證要年滿 18 歲才能申辦。</p>
<p>請你理解我不是想刻意排除未滿 18 歲的使用者，而是目前技術上沒有簡單容易的方式能驗證一個未滿 18 歲的使用者是台灣人。</p>`),
      },
      {
        id: "change-or-remove",
        question: "換錯帳號、想改、想拿掉怎麼辦？",
        answer: new Html(`<p>當天發現帳號寫錯，可以當天回來過卡改掉。這叫更正，不算更換。</p>
<p>之後想換成別的帳號：可以，這叫更換。一張自然人憑證在 Threads 一共可以更換 5 次，用掉就不會恢復。所有的紀錄都會留在證明紀錄裡，讓大家查閱。</p>
<p>想拿掉：可以收回，收回不算更換。收回之後再換回同一個帳號，不算更換；換成別的帳號，算一次更換。</p>
<p>一張卡片一天最多過卡 3 次，避免一天內無限次更改。</p>
<p>所有操作紀錄會公開，而且無法刪除，這樣任何人才能驗證證明紀錄的有效性。</p>`),
      },
      {
        id: "how-many",
        question: "一張自然人憑證可以換幾張島民證明？",
        answer: new Html(`<p>一張自然人憑證只能換一張證明，上面寫一個 Threads 帳號。你有兩個 Threads 帳號的話，只能選一個。</p>
<p>有些人可能有更換 Threads 帳號的需求，我們允許一張自然人憑證終身更換宣告的帳號 5 次。但每次更換都會留下公開紀錄供他人稽核。</p>`),
      },
    ],
  },
  {
    name: "誰在做",
    id: "cat-who",
    questions: [
      {
        id: "who",
        question: "誰在做島民證明？",
        answer: new Html(`<p>Opass Chang，一個希望能改善台灣網路討論環境、減少假帳號協同行為的台灣軟體工程師。目前由本人負擔開發與伺服器維護費用，沒有政黨、政府或公司出資。如果你想了解我，歡迎到我的 <a href="https://opasschang.com">Blog</a>。</p>
<p>如果是關於島民證明的技術問題或建議，歡迎到 <a href="https://github.com/iamreal-tw/iamreal/discussions">GitHub 的公開討論區</a> 留言討論。</p>`),
      },
      {
        id: "shutdown",
        question: "這個服務倒了怎麼辦？",
        answer: new Html(`<p>島民證明的網址會打不開，也沒有地方可以過卡，僅此而已。</p>
<p>證明紀錄都是公開的。任何人都可以下載證明紀錄保存，自己驗證每一筆。原始碼也都是公開的，任何人都能重新架一個類似的服務。</p>`),
      },
      {
        id: "request-id",
        question: "回報問題時要附的請求編號是什麼？",
        answer: new Html(`<p>過卡出錯時，畫面會顯示一串請求編號。把它附在回報裡，我們才找得到那一次請求的紀錄，方便除錯抓問題。</p>`),
      },
    ],
  },
];

/** The question with this id. */
export function question(id: string): Question {
  for (const c of CATEGORIES) for (const q of c.questions) if (q.id === id) return q;
  throw new Error(`faq: no question ${id}`);
}

/**
 * The FAQ page: under the title the list of the categories, each a link to
 * its category; every question folded, as the home page's are (faq.md, at
 * the top): a <details> with the question's id, the question its <summary>,
 * which opens and closes it without a script. None is open when the page
 * opens. The page loads the copy buttons' script (site/copy.js), which opens
 * the question the address names (/faq#<id>): browsers do not open a
 * <details> that is itself the target. Nothing after the last question but
 * the foot (faq.md, 還沒定的).
 */
export function faqPage(): Document {
  const content = html`<h1 class="title">常見問題</h1>
<div class="faq-body">
<nav class="categories" aria-label="分類"><ol>
${CATEGORIES.map((c) => html`<li><a href="#${c.id}">${c.name}</a></li>`)}
</ol></nav>
<div class="faq-questions">
${CATEGORIES.map(
  (c) => html`<section class="category" id="${c.id}">
<h2>${c.name}</h2>
${c.questions.map((q) => html`<details class="question" id="${q.id}"><summary>${q.question}</summary>
${q.answer}</details>`)}
</section>`,
)}
</div>
</div>`;
  return { title: "常見問題", kind: "faq", script: true, content };
}

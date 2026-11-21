// The questions and answers of design/copy/faq.md, each written once: the
// FAQ page (/faq) shows every one, under its category, the home page seven
// (design/copy/home.md, section 6). The markup is the Go backend's
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

/** The four categories of faq.md, in its order, each with its questions in its order. */
export const CATEGORIES: readonly { readonly name: string; readonly questions: readonly Question[] }[] = [
  {
    name: "關於隱私",
    questions: [
      {
        id: "personal-data",
        question: "我的個資會外流嗎？",
        answer: new Html(`<p>你的姓名、身分證字號、自然人憑證和 PIN 都不會離開你的裝置。公開的名冊會記下哪個社交帳號有島民證明，但對應不回是哪張卡片。</p>
<p><strong>注意：</strong>拿到你的卡片和 PIN 的人，查得出你換過哪個帳號的島民證明，所以卡片請小心保管。</p>`),
      },
      {
        id: "government",
        question: "政府會知道我是哪個帳號嗎？",
        answer: new Html(`<p>查不出來。Threads、政府、我們，都查不出一張島民證明是哪一張卡片換的。這也是只收實體卡片的原因。</p>
<p>這靠的是現在破解不了的加密，不是永久的保證。 <a href="/faq#security">了解更多</a></p>`),
      },
      {
        id: "security",
        question: "這個技術安全嗎？",
        answer: new Html(`<p>沒有哪一種技術可以保證絕對安全，所以我們把能檢查的都公開：程式碼全部公開，名冊也公開，每一筆都可以自己驗證。你的 PIN、姓名和自然人憑證只在你的裝置上處理，這一點可以從程式碼確認。</p>
<p>有三件事要照實告訴你：</p>
<ul class="dots">
<li>匿名靠的是現在的加密技術。沒有人查得出一張島民證明是哪一張卡片換的，靠的是卡片上的 RSA 2048 位元金鑰，也就是你用自然人憑證報稅時靠的同一把金鑰。它目前沒有已知的破解方法，但沒有人能保證永遠如此。很多年後如果它被破解，會被知道的是：某一張自然人憑證換過哪個 Threads 帳號的島民證明。</li>
<li>網頁版的簽章會經過內政部的讀卡元件，和其他使用自然人憑證的網站一樣。元件看得到卡片簽出來的內容。我們沒有檢查過這個元件會不會留存或送出它。</li>
<li>這套算法由 AI 做過設計層面的檢查，還沒有外部的專家看過。程式碼和規格都是公開的，你也可以自己檢查。</li>
</ul>
<p><a href="https://github.com/iamreal-tw/iamreal/blob/main/docs/adr/0004-scoped-ids-and-proofs-are-public.md">完整的說明</a></p>`),
      },
      {
        id: "what-we-see",
        question: "營運者看得到什麼？",
        answer: new Html(`<p>和名冊上公開的一樣：Threads 帳號、島民編號、日期，還有那一份證明。你的姓名、身分證字號、自然人憑證和 PIN 不會送到我們的伺服器。</p>
<p>除此之外，伺服器記下每個請求的時間、哪一個功能、成功或失敗和 IP 位址，留 31 天後自動刪除，用來限制請求次數、擋下濫用、查問題。在意的話，請經 VPN 過卡。</p>
<p>頁面也會送出計數，例如打開了哪一種頁面、過卡走到哪一步，讓營運者知道網站哪裡不好用。計數裡沒有認得出你的東西。網站不放 cookie，頁面上也沒有其他公司的分析或追蹤程式。</p>
<p><a href="/privacy">完整的說明</a></p>`),
      },
      {
        id: "threads-knows",
        question: "打開一張島民證明，Threads 會知道嗎？",
        answer: new Html(`<p>會。島民證明的頁面會直接向 Threads 載入那個帳號的個人檔案，讓你當場看到上面有沒有這張證明的連結。所以 Threads 知道有人從你的網路位址看了這個帳號的個人檔案。如果這個瀏覽器登入著 Threads，它很可能也知道是哪個帳號在看。</p>
<p>頁面上沒有 Threads 的程式，也不會把你看的是哪一頁告訴 Threads。</p>`),
      },
    ],
  },
  {
    name: "它能證明什麼",
    questions: [
      {
        id: "not-a-troll",
        question: "有島民證明，就代表不是網軍嗎？",
        answer: new Html(`<p>不是。它只代表有一張真的自然人憑證，把名額給了這個帳號。島民證明擋不住把自己卡片賣掉的台灣人，但它會讓假帳號的成本變得很高：一張自然人憑證在 Threads 只能換一張，要一萬個這樣的帳號，得先有一萬張真的卡片。</p>`),
      },
      {
        id: "someone-else",
        question: "別人可以換一張寫著我帳號的島民證明嗎？",
        answer: new Html(`<p>可以，這擋不了。但這對對方幾乎沒有好處：他用掉的是自己唯一的名額。你還是可以用自己的卡片，替自己的帳號換一張島民證明。你沒有把那一張的連結掛上個人檔案，別人就看得出你沒有承認。</p>`),
      },
      {
        id: "lent-or-sold",
        question: "卡片借人或賣給別人怎麼辦？",
        answer: new Html(`<p>擋不了，拿到卡片和 PIN 的人就能替它換。</p>
<p>但把自然人憑證交給別人，代價遠遠大過一張島民證明。它加上 PIN，就是你在網路上的身分證和印鑑：對方可以用你的名義報稅、查你的財產和所得資料、向政府申辦各種業務，簽出來的文件有法律效力。</p>
<p>別人看島民證明時，看的也不只是有沒有，還有上次過卡是幾天前。卡片掛失之後，那張卡就不能再更新。</p>`),
      },
      {
        id: "why-refresh",
        question: "為什麼要定期回來更新？",
        answer: new Html(`<p>只有過卡的當下，才檢查得到自然人憑證在效期內、不在廢止清冊上。卡片之後遺失、被廢止、到了別人手上，名冊都不會知道，要等下一次過卡。</p>
<p>所以別人看的是你上次過卡是幾天前；隔得越久，說服力越低。建議每季回來過卡一次。</p>
<p>我們不會寄信或傳訊息提醒你過卡。提醒只會來自你自己手機上的島民證明 app，而且是你自己設定的。</p>
<p>過卡時比對的廢止清冊，最多可以是 3 天前的那一份，所以剛被廢止的自然人憑證，有幾天的時間還過得了卡。</p>`),
      },
      {
        id: "lost-card",
        question: "卡片遺失了，我的島民證明怎麼辦？",
        answer: new Html(`<p>先去掛失。掛失之後那張卡片就不能再過卡。</p>
<p>舊的那一張島民證明還會留在名冊上，沒有人能把它拿掉，但它的上次過卡會停住，越來越舊。</p>
<p>補辦的新卡片是新的名額，可以重新換一張島民證明。新的這一張網址不同，記得把個人檔案上的連結換掉。</p>`),
      },
      {
        id: "profile-not-shown",
        question: "島民證明上的個人檔案為什麼顯示不出來？",
        answer: new Html(`<p>可能是這個帳號不公開、關掉了讓別的網站嵌入的設定、改了名稱，或已經不存在。Threads 對這幾種情況顯示的是同一句話，分不出是哪一種。</p>
<p>這種時候，請直接到 Threads 上看那個帳號的個人檔案有沒有這張島民證明的連結。</p>`),
      },
      {
        id: "renamed",
        question: "我改了 Threads 的名稱，島民證明會跟著改嗎？",
        answer: new Html(`<p>不會。名冊記的是你過卡時填的名稱，我們查不到 Threads 上的改動。請回來過卡，把帳號換成新的名稱；這會用掉一次更換。</p>
<p>還沒更換之前，島民證明上寫的仍是舊名稱。舊名稱之後可能被別人註冊。</p>`),
      },
    ],
  },
  {
    name: "怎麼用",
    questions: [
      {
        id: "free",
        question: "這個服務要錢嗎？",
        answer: new Html(`<p>不用。換島民證明、更新、更換帳號、收回，都免費。</p>`),
      },
      {
        id: "no-card-yet",
        question: "我還沒有自然人憑證，怎麼辦？",
        answer: new Html(`<p>本人帶身分證正本，到任何一間戶政事務所申辦，不限戶籍地。申請時要填一個電子郵件信箱。工本費 250 元，當天拿到卡片。</p>`),
      },
      {
        id: "mobile-certificate",
        question: "為什麼不能用行動自然人憑證？",
        answer: new Html(`<p>實體卡片的簽章在卡片裡完成，只經過你的裝置。</p>
<p>行動自然人憑證的簽章要經過內政部的伺服器，內政部查得出是誰在使用；流程還要你輸入身分證字號，我們就得經手不必要的個資。所以只收實體的卡片。</p>`),
      },
      {
        id: "not-a-citizen",
        question: "我不是中華民國國民，可以用嗎？",
        answer: new Html(`<p>不行。我們只收台灣中華民國國民的自然人憑證正卡，外來人口申辦的自然人憑證不能用。</p>`),
      },
      {
        id: "under-18",
        question: "我未滿 18 歲，可以用嗎？",
        answer: new Html(`<p>目前不行。自然人憑證要年滿 18 歲才能申辦。</p>`),
      },
      {
        id: "change-or-remove",
        question: "換錯帳號、想改、想拿掉怎麼辦？",
        answer: new Html(`<p>當天就發現換錯了：當天回來過卡改掉。這叫更正，不算更換。</p>
<p>之後想換成別的帳號：可以，這叫更換。一張自然人憑證在 Threads 一共可以更換 5 次，用掉就不會恢復。</p>
<p>想拿掉：可以收回。收回之後再換回同一個帳號，不算更換。</p>
<p>一張卡片一天最多過卡 3 次。</p>
<p>所有紀錄公開後無法刪除，這樣任何人才能驗證。名冊上會留著你換過、收回過的紀錄。</p>`),
      },
      {
        id: "how-many",
        question: "一張自然人憑證可以換幾張島民證明？",
        answer: new Html(`<p>一張，上面寫一個 Threads 帳號。你有兩個 Threads 帳號的話，只能選一個。</p>
<p>現在只有 Threads。島民證明只涵蓋上面寫的那個帳號，不包括 Instagram 或其他平台上同名的帳號。</p>`),
      },
    ],
  },
  {
    name: "誰在做",
    questions: [
      {
        id: "who",
        question: "誰在做島民證明？",
        answer: new Html(`<p>一個興趣使然的台灣工程師。有任何技術問題或建議，歡迎到 <a href="https://github.com/iamreal-tw/iamreal">GitHub</a> 討論。</p>`),
      },
      {
        id: "shutdown",
        question: "這個服務倒了怎麼辦？",
        answer: new Html(`<p>名冊和程式都是公開的。任何人都可以下載名冊，自己驗證每一筆。我們不在了，已經換出的島民證明還是驗得出來。</p>
<p>會停掉的是這個網站：島民證明的網址會打不開，也沒有地方可以再過卡。</p>`),
      },
      {
        id: "request-id",
        question: "回報問題時要附的請求編號是什麼？",
        answer: new Html(`<p>過卡出錯時，畫面會顯示一串請求編號。把它附在回報裡，我們才找得到那一次請求的紀錄。</p>
<p>你告訴我們請求編號，我們就知道你在那個時間做了那一次請求；如果那一次有寫進名冊，可能對得出是哪一筆紀錄。</p>`),
      },
    ],
  },
];

/** The question with this id. */
export function question(id: string): Question {
  for (const c of CATEGORIES) for (const q of c.questions) if (q.id === id) return q;
  throw new Error(`faq: no question ${id}`);
}

/** The FAQ page: every question a heading with its id, its answer shown under it. Nothing after the last question but the foot (faq.md, 還沒定的). */
export function faqPage(): Document {
  const content = html`<h1 class="title">常見問題</h1>
${CATEGORIES.map(
  (c) => html`<section class="category">
<h2>${c.name}</h2>
${c.questions.map((q) => html`<section class="question" id="${q.id}"><h3>${q.question}</h3>
${q.answer}</section>`)}
</section>`,
)}`;
  return { title: "常見問題", kind: "faq", content };
}

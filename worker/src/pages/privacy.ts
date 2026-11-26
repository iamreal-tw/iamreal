// The privacy statement: design/copy/privacy.md, its fourteen sections in
// its order. Section 1's first line is the page's title; each of the others
// has its heading as the page's heading and its code block as the text (a
// blank line a new paragraph, a line that starts with · an item of a list,
// the lines of one paragraph on lines of their own). What privacy.md says
// under the blocks is done here: the first sentence of each point of section
// 2, and of section 4's 要知道的事 and its points, in bold; the links of
// sections 6, 8, 12 and 14. Every page's foot links here (home.md, 頁尾), and
// so do the apps' settings (design/copy/app.md).
import { Html, html } from "./html.ts";
import type { Document } from "./layout.ts";

/** One section of privacy.md after the first: its heading and the paragraphs of its code block. */
interface Section {
  readonly heading: string;
  readonly paragraphs: readonly string[];
}

/** Section 1: the title, then its paragraphs. */
const OPENING: readonly string[] = [
  "隱私權說明",
  "最後修改：2026-11-26",
  "這份說明講 iamreal.tw 拿到什麼、公開什麼、不拿什麼、留多久，以及你能做什麼。拿這些，是為了維持一份任何人都能重驗的公開的證明紀錄，和讓網站正常運作、擋下濫用。",
  "這份說明也適用於測試網站 test.iamreal.tw 和 test-data.iamreal.tw。",
  "營運者：Opass Chang，個人開發和營運 iamreal.tw\n聯絡信箱：th33ts@gmail.com",
];

const SECTIONS: readonly Section[] = [
  {
    heading: "先講結論",
    paragraphs: [
      "· 營運者不知道持卡人是誰。你的姓名、身分證字號、自然人憑證、PIN 和卡片的簽章都不會離開你的裝置。送出的是一份零知識證明，和一個由你的卡片算出、營運者算不回來的島民編號。",
      "· 宣告是公開的，而且一直留著。任何人都看得到「有一張卡片宣告了 Threads 的 @alice」，也能下載整份證明紀錄自己重驗。",
      "· 宣告不能刪除，只能收回。原因在下面「為什麼不能刪除」。",
      "· 過卡時連線的 IP 位址，營運者和 Cloudflare 留 31 天。這段期間內，營運者或依法調閱的機關，可以經電信業者查到一筆紀錄是從哪條網路線路送出的。",
    ],
  },
  {
    heading: "持卡人：留在你裝置上的",
    paragraphs: [
      "過卡的時候，你的裝置讀取卡片、請卡片簽章、算出證明。下面這些只在你的裝置上用，不會送給營運者：",
      "· PIN：只在記憶體裡停留到送給卡片為止\n· 姓名和自然人憑證的內容，包括憑證序號和公鑰\n· 卡片的簽章",
      "過卡的頁面在你的瀏覽器裡只存一樣東西：它用過的廢止清冊的版本號，用來確認下次拿到的清冊不比這次舊。這個值不會送出。",
      "用 app 過卡時，app 在手機上存兩樣東西：它用過的廢止清冊的版本號，和網頁一樣；還有開著過卡提醒時，提醒的間隔、時刻和下次提醒的日子。關掉提醒，這些設定就刪掉。這兩樣都不會送出。",
    ],
  },
  {
    heading: "持卡人：送出、而且公開的",
    paragraphs: [
      "一次過卡，營運者收到下面這些，寫進公開的證明紀錄：",
      "· 帳號清單：這張卡片宣告的帳號，例如 Threads 的 @alice。收回就是清單裡少了那個帳號\n· 島民編號：你的卡片在證明紀錄裡的編號。由卡片的簽章算出，只有你的裝置算得出來。一張卡片只有一個，不分平台\n· 題目：營運者發給這次過卡的一次性亂數，裡面有當天的日期，只到日\n· 發證金鑰是第二代還是第三代：你的自然人憑證由內政部哪一代的發證金鑰簽發\n· 廢止清冊的樹根：代表這次過卡用的那一份內政部廢止清冊\n· 證明：一份零知識證明，確認上面這些成立，但不透露你的自然人憑證",
      "這些合起來，任何人都看得到：某一天，有一張由某一代發證金鑰簽發、當時有效的卡片，宣告了這幾個帳號；以及同一張卡片之前宣告過哪些帳號、在哪幾天。看不到是哪一張卡片、是誰。",
      "要知道的事：",
      "· 拿到你的卡片和 PIN 的人，查得出這張卡片宣告過的帳號。他可以用你的卡片算出同一個島民編號，再對照證明紀錄。卡片請自己保管，不要借給別人。",
      "· 同一張卡片宣告的帳號，列在同一張島民證明上。換帳號時，證明紀錄裡前後的帳號是同一個島民編號，看得出是同一張卡片。",
      "· 卡片展期之後，發證金鑰可能從第二代變成第三代。證明紀錄裡同一個島民編號的發證金鑰換了代，看得出這張卡片在那段期間展期過。內政部知道誰在什麼時候展期。",
      "· 匿名靠的是現在的加密技術。查不出島民編號是哪一張卡片，靠的是卡片上的 RSA 金鑰目前沒有已知的破解方法；沒有人能保證永遠如此。",
    ],
  },
  {
    heading: "連線紀錄",
    paragraphs: [
      "你送出過卡的那一次，營運者的後台記下：請求編號、時間、結果、錯誤代碼、IP 位址、國家、網路業者的編號、過卡裝置編號（見下面「Cookie 和計數」）。成功的另外記它是證明紀錄的第幾筆。",
      "· 留 31 天，到期自動刪除。",
      "· 送出沒有成功時，送出的內容（島民編號、帳號、題目、證明）和 IP 位址記在同一筆，同樣留 31 天，用來重現問題。這些內容沒有公開在任何地方，例如一張卡片試著宣告某個帳號、但沒有成功。成功的過卡不另外記內容，內容已經在證明紀錄裡。",
      "· 其他的請求，營運者的後台不記：看頁面、開始過卡、查卡片現況，和因為送出太多請求被擋下的。Cloudflare 替我們送出網站，它自己留著連線的資料 31 天，裡面有 IP 位址，營運者看得到；那一份不是每個請求都有。",
      "· 頁面和 app 送出的計數不記在這裡，也不記 IP 位址（見下面「Cookie 和計數」）。",
      "· IP 位址只用來限制每個來源的請求次數、擋下濫用的連線、查問題。證明紀錄裡的紀錄不會因為 IP 位址被標記或移除：證明成立的紀錄就算數。",
      "有些請求不經過營運者的程式，直接由 Cloudflare 回答：下載證明紀錄和廢止清冊（data.iamreal.tw，包括過卡時頁面自動下載的廢止清冊）、過卡頁面的程式和電路檔，以及 Cloudflare 的快取直接回答的頁面。這些不在上面的連線紀錄裡；Cloudflare 的後台同樣列得出它們的來源 IP 位址、網址和時間，營運者看得到，留 31 天。",
    ],
  },
  {
    heading: "Cloudflare",
    paragraphs: [
      "iamreal.tw 整個放在 Cloudflare 上：頁面、後台、證明紀錄和連線紀錄都在 Cloudflare 的機器上，沒有其他的主機。",
      "· Cloudflare 看得到所有連線。它自己的紀錄照它的隱私權政策保存，營運者管不到。\n· Cloudflare 的機房在世界各地，資料存放的位置可能在台灣以外。",
    ],
  },
  {
    heading: "Cookie 和計數",
    paragraphs: [
      "不放 cookie。頁面上沒有其他公司的分析或追蹤程式。",
      "為了知道網站和 app 哪裡不好用，頁面和 app 會自己向營運者的後台送出計數：",
      "· 打開了哪一種頁面：首頁、島民證明、查詢頁、證明紀錄頁、常見問題、過卡需要什麼、隱私權說明、過卡。打開島民證明時，連同是哪一張\n· 從哪個網站連過來，只記網域，例如 google.com；是不是在某個 app 裡打開的\n· 過卡走到哪一步，停下來時的錯誤代碼\n· 按了哪些按鈕，例如「開始過卡」「下載 app」\n· 瀏覽器和作業系統的種類；在網頁過卡時，另外有它們的版本和讀卡機的名稱\n· 過卡的幾個步驟花了多久，只分成幾段，不是確切的時間\n· 在 app 裡過卡時：手機型號、系統版本、app 的版本",
      "計數的內容只能是事先定好的代號、照固定格式檢查的版本號和讀卡機名稱，和下面三種隨機的編號。沒有你輸入的字，也沒有卡片上的任何內容。",
      "· 造訪編號：看頁面時帶，一次造訪一個，關掉分頁就消失。營運者看得出你這一次看了哪些頁，看不出你之後還有沒有再來。從過卡的頁面回到其他頁面時，換一個新的\n· 過卡裝置編號：過卡時帶，送出時也帶，存在 app 或瀏覽器裡，31 天後換一個新的。營運者看得出這 31 天內，同一台裝置過了幾次卡、用了哪幾張卡片。看頁面時不帶\n· 嘗試編號：一次過卡一個，停下或完成就丟",
      "這些編號由你的裝置隨機產生，換掉時不留舊的，做法寫在公開的程式裡。所以營運者認不出一個月以前的你。",
      "瀏覽器設了「不要追蹤」時，計數照樣送出。造訪編號連得起來的，只有同一個分頁幾分鐘內的請求，這些請求本來就從同一個 IP 位址送出；過卡裝置編號用來查濫用和查問題，和用來限制請求次數的 IP 位址一樣，不提供退出。",
      "因為過卡裝置編號，同一台裝置 31 天內的每一次過卡都連得起來，不管當時連的是哪個網路。用自己的手機替家人過卡，這 31 天內營運者也看得出那幾張卡片是同一支手機過的。",
      "計數一筆一筆的內容留 31 天，裡面沒有 IP 位址。營運者另外把計數加總成每天和每月的次數，永久保存；裡面沒有 IP 位址，也沒有任何編號。每張島民證明只存每個月的總數：被打開幾次、從它開始和完成了幾次過卡。手機型號、各種版本、讀卡機的名稱也只存每個月的總數，人數太少的不存。",
      "島民證明上「下載 app」的連結帶著這張證明的短編號，App Store 和 Google Play 據此告訴營運者每張證明帶來幾次安裝。所以 Apple 和 Google 知道這次安裝是從哪一張島民證明來的。app 不讀這個參數。",
      "過卡停下來時，計數裡有停在哪一步和原因的代號，沒有是哪一張卡片。原因是卡片已被廢止或暫時停用時，這 31 天內營運者看得出有一台裝置有一張這樣的卡片，看不出是哪一張，也看不出是從哪個 IP 位址。",
      "這些數字只有營運者看得到，不在任何頁面上公開。",
      "例外：網站被大量的請求灌爆時，營運者會暫時打開 Cloudflare 的檢查頁，事後公告開了多久。這段期間打開首頁、島民證明、查詢頁或證明紀錄頁，要先通過一次檢查；通過後 Cloudflare 放一個 cf_clearance cookie，只用來記得你通過了檢查，預設 30 分鐘後失效。過卡和下載證明紀錄不受影響。",
    ],
  },
  {
    heading: "看島民證明的人",
    paragraphs: [
      "打開一張島民證明，頁面會直接向 Threads 載入那個帳號的個人檔案，讓你當場看帳號主人有沒有放這張島民證明的連結。所以 Threads 知道有人從你的 IP 位址看了這個帳號的個人檔案；如果這個瀏覽器登入著 Threads，它很可能也知道是哪個帳號在看。",
      "頁面上沒有 Threads 的程式，也不會把你看的是哪一頁告訴 Threads。　了解更多",
    ],
  },
  {
    heading: "帳號主人：如果有人宣告了你的帳號",
    paragraphs: [
      "任何持卡人都可以宣告任何帳號，宣告不代表帳號主人同意。如果你的帳號被宣告了：",
      "· 證明紀錄裡會有「有一張卡片宣告了 @你的帳號」。營運者不知道那是誰的卡片，也沒有辦法替你查。\n· 你可以把那張島民證明的連結放在自己的個人檔案上，表示你承認它；不放，就是沒有承認。島民證明的頁面會嵌入你的個人檔案，讓看的人自己判斷。\n· 營運者不提供刪除或隱去宣告，也不能阻止別人宣告你的帳號。收到依法提出的要求時，個別處理。\n· 證明紀錄是公開的，任何人都可以下載保存；別人下載過的副本收不回來。",
    ],
  },
  {
    heading: "為什麼不能刪除",
    paragraphs: [
      "證明紀錄的用處，是任何人都能自己重算、確認營運者沒有作假。要做到這一點，每一筆紀錄都必須附證明，而且留著：",
      "· 如果可以刪掉一筆宣告，證明紀錄就沒辦法證明營運者沒有偷偷刪掉別的。\n· 只拿掉帳號名稱也沒有用：證明是對著帳號名稱算的，把猜的名稱代進去驗證，就找得回來。\n· 沒有證明的刪除，任何人冒充持卡人，就能讓別人的紀錄消失。",
      "你能做的是收回：過卡一次，把那個帳號從清單上拿掉，立刻生效。收回本身也會寫進證明紀錄，原本的紀錄還在。",
      "這是設計上的選擇。如果你認為自己依法有權要求刪除或停止處理，請來信，營運者個別處理。",
    ],
  },
  {
    heading: "營運者不拿的",
    paragraphs: [
      "· 身分證字號、姓名、出生日期、憑證序號\n· PIN\n· 你在 Threads 的登入、密碼、私訊、追蹤名單。過卡不需要登入 Threads",
    ],
  },
  {
    heading: "誰還看得到",
    paragraphs: [
      "· 所有人：證明紀錄、廢止清冊的存檔、每天的指紋、程式碼都公開。",
      "· Cloudflare：所有連線，見上面。",
      "· 內政部：營運者從內政部下載公開的廢止清冊，不把任何持卡人的資料送給內政部，手上也沒有可以送的。",
      "· 內政部的讀卡元件：在電腦上過卡時，卡片的簽章經過你電腦上的內政部讀卡元件，和其他使用自然人憑證的網站一樣。元件看得到卡片簽出來的內容；營運者沒有檢查過它會不會留存或送出。",
      "· Threads：營運者不和 Threads 交換資料。島民證明的頁面會向 Threads 載入個人檔案，見上面。",
      "· Apple 和 Google：app 從 App Store、Google Play 安裝。商店自己收安裝數、各版本的使用量和當機報告；當機報告只來自在手機設定裡同意分享的人，營運者看得到報告，不知道是誰。這些照 Apple 的隱私權政策和 Google 的隱私權政策處理。",
      "· 寫信給營運者：信和你的信箱位址留在營運者的信箱（Gmail）裡。",
    ],
  },
  {
    heading: "保存多久",
    paragraphs: [
      "· 證明紀錄、雜湊清單、每天的指紋、廢止清冊的存檔：永久。這是任何人能重驗的前提。\n· 每天公開的卡片狀態檔：7 天。\n· 連線紀錄，包括沒有成功的送出的內容：31 天。計數一筆一筆的內容：31 天。\n· 計數加總成的每天和每月的次數：永久，裡面沒有 IP 位址和任何編號。每張島民證明只有每個月的總數。\n· 測試網站的測試的證明紀錄會不定期清空。清空之後，上面的紀錄和島民證明就找不到了；別人下載過的副本收不回來。",
    ],
  },
  {
    heading: "你的權利，和這份說明的修改",
    paragraphs: [
      "個人資料保護法給你查詢、閱覽、複製、補充更正、停止蒐集處理利用、刪除的權利。證明紀錄的內容本來就公開；不提供刪除的理由在上面。如果你認為自己依法有權要求刪除或停止處理，或想查連線紀錄裡和你有關的部分，請寫信到 th33ts@gmail.com，營運者個別處理。",
      "這份說明放在公開的程式庫裡，每一次修改都有紀錄，任何人都看得到改了什麼、什麼時候改的。　修改紀錄",
    ],
  },
];

/** The words of a section that are links, and where they go (privacy.md, under each section). */
const LINKS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Cloudflare: { 它的隱私權政策: "https://www.cloudflare.com/privacypolicy/" },
  看島民證明的人: { 了解更多: "/faq#threads-knows" },
  誰還看得到: { "Apple 的隱私權政策": "https://www.apple.com/legal/privacy/", "Google 的隱私權政策": "https://policies.google.com/privacy" },
  "你的權利，和這份說明的修改": { 修改紀錄: "https://github.com/iamreal-tw/iamreal/commits/main/design/copy/privacy.md" },
};

/** The section whose points begin in bold from the start (privacy.md, section 2), and the paragraph after which they do (section 4). */
const BOLD_POINTS = "先講結論";
const BOLD_FROM = "要知道的事：";

/** `text`, each of `links`' words where it appears a link. */
function linked(text: string, links: Readonly<Record<string, string>>): Html {
  const pieces: Html[] = [];
  let rest = text;
  for (;;) {
    let first: { at: number; words: string } | null = null;
    for (const words of Object.keys(links)) {
      const at = rest.indexOf(words);
      if (at >= 0 && (first === null || at < first.at)) first = { at, words };
    }
    if (first === null) break;
    pieces.push(html`${rest.slice(0, first.at)}<a href="${links[first.words]!}">${first.words}</a>`);
    rest = rest.slice(first.at + first.words.length);
  }
  pieces.push(html`${rest}`);
  return new Html(pieces.map((p) => p.text).join(""));
}

/** A point whose first sentence is in bold. */
function boldFirst(text: string, links: Readonly<Record<string, string>>): Html {
  const end = text.indexOf("。") + 1;
  return end <= 0 ? html`<strong>${linked(text, links)}</strong>` : html`<strong>${linked(text.slice(0, end), links)}</strong>${linked(text.slice(end), links)}`;
}

/**
 * The paragraphs of a section: a paragraph whose lines all start with · is items of a list, and lists that follow one another
 * are one list; another paragraph's lines are lines of one paragraph.
 */
function body(heading: string, paragraphs: readonly string[]): Html {
  const links = LINKS[heading] ?? {};
  const out: Html[] = [];
  let items: Html[] = [];
  let bold = heading === BOLD_POINTS;
  const endList = (): void => {
    if (items.length > 0) out.push(html`<ul class="dots">\n${items}\n</ul>`);
    items = [];
  };
  for (const p of paragraphs) {
    const lines = p.split("\n");
    if (lines.every((l) => l.startsWith("· "))) {
      for (const l of lines) {
        const text = l.slice(2);
        items.push(html`<li>${bold ? boldFirst(text, links) : linked(text, links)}</li>`);
      }
      continue;
    }
    endList();
    if (p === BOLD_FROM) {
      out.push(html`<p><strong>${p}</strong></p>`);
      bold = true;
      continue;
    }
    out.push(html`<p>${new Html(lines.map((l) => linked(l, links).text).join("<br>\n"))}</p>`);
  }
  endList();
  return html`${out}`;
}

export function privacyPage(): Document {
  const [title, updated, ...opening] = OPENING;
  const content = html`<section class="intro">
<h1 class="title">${title!}</h1>
<p class="small">${updated!}</p>
${body("", opening)}
</section>
${SECTIONS.map((s) => html`<section class="part">
<h2>${s.heading}</h2>
${body(s.heading, s.paragraphs)}
</section>`)}`;
  return { title: title!, kind: "privacy", content };
}

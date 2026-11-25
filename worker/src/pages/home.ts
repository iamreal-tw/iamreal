// The home page: design/copy/home.md, from 第一屏 to 結尾 (the navigation
// bar and the foot are the layout's), laid out after design/DESIGN.md and
// design/screens/home-desktop.png, home-phone.png.
//
// 常見問題 shows eight questions of design/copy/faq.md, each with the answer
// faq.md has for it, from faq.ts, where the FAQ page reads them too.
//
// The pages allow no inline style (README.md, "頁面送的標頭"), so whatever
// is placed by a number (a dot, the ratio bar) is SVG, placed by its
// attributes; the style sheet gives it its colours.
import { type Question, question } from "./faq.ts";
import { type Html, html, thousands } from "./html.ts";
import { type Document, LOGO, NEEDS } from "./layout.ts";

/** The home page's two numbers (home.md, 一起能改變什麼). */
export interface HomeNumbers {
  /** The cards that give their place on Threads to an account now. */
  readonly declared: number;
  /** Those among them whose last card proof is in the last 90 days. */
  readonly recent: number;
}

/** The eight questions of 常見問題, in its order, by their ids on the FAQ page: the same words and the same markup as there (faq.ts). */
const QUESTIONS: readonly Question[] = ["personal-data", "government", "security", "not-a-troll", "someone-else", "lent-or-sold", "free", "who"].map(question);

/** The link preview (home.md, 連結被貼出去時的預覽): its title, the <title>, and the headline followed by the first line under it. */
const TITLE = "島民證明";
const TAB_TITLE = "島民證明｜iamreal.tw";
const DESCRIPTION = "一起讓台灣的網路聲量更真實。你每天看到的討論、動態，背後有多少是真正的台灣人？";

/** The distance between two dots, and where the first one is (design/tokens.json, --dot-pitch): every dot is on this grid. */
const PITCH = 18;
const at = (n: number): number => PITCH / 2 + PITCH * n;

/** A dot of an account with a proof, at this column and row of the grid. */
const proofDot = ([c, r]: readonly [number, number]): Html => html`<circle class="proof" cx="${at(c)}" cy="${at(r)}" r="5"></circle>`;

/**
 * "You": the red dot, the ring around it, and its label on a patch of the
 * page's white. `pulse` for the one on the first screen, whose ring the
 * style sheet makes pulse three times (design/DESIGN.md, 動態).
 */
function youDot([c, r]: readonly [number, number], pulse: boolean): Html {
  const x = at(c);
  const y = at(r);
  return html`<circle class="you-ring${pulse ? " pulse" : ""}" cx="${x}" cy="${y}" r="14"></circle>
<circle class="you" cx="${x}" cy="${y}" r="7"></circle>
<rect class="you-patch" x="${x + 11}" y="${y - 13}" width="32" height="26"></rect>
<text class="you-label" x="${x + 19}" y="${y + 6}">你</text>`;
}

/** A draw of numbers in [0, 1) that is the same every time for the same seed (mulberry32): the dots are placed one by one, and the page is the same on every load. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The first screen's dots, as the final design places them (in the right
 * half on a wide screen; under the headline on a phone, where the top left
 * of them shows, "you" among them).
 */
const HERO_PLACED: readonly (readonly [number, number])[] = [
  [9, 4], [21, 6], [30, 9], [11, 13], [26, 2], [17, 17], [31, 19], [8, 23], [23, 24], [28, 29], [11, 31], [19, 34], [30, 35], [4, 8], [20, 12],
];
const HERO_YOU = [14, 11] as const;

/**
 * Right of the dots placed by hand, as far as a 4K window shows (#335):
 * columns 32 to 119 and the 35 rows of the first screen on a wide screen,
 * in blocks of 8 columns by 7 rows; three blocks in four get one dot, in a
 * cell drawn at random. About as dense as the dots placed by hand, spread
 * evenly; a 1280px window ends before column 32, so it shows none of them.
 */
const HERO_FILL_FROM = 32;
const HERO_FILL_BLOCKS = [11, 5] as const;
const HERO_BLOCK = [8, 7] as const;
const HERO_PROOF: readonly (readonly [number, number])[] = (() => {
  const random = seeded(0x2b9e1c);
  const out: (readonly [number, number])[] = [...HERO_PLACED];
  for (let bc = 0; bc < HERO_FILL_BLOCKS[0]; bc++) {
    for (let br = 0; br < HERO_FILL_BLOCKS[1]; br++) {
      if (random() >= 0.75) continue;
      out.push([HERO_FILL_FROM + bc * HERO_BLOCK[0] + Math.floor(random() * HERO_BLOCK[0]), br * HERO_BLOCK[1] + Math.floor(random() * HERO_BLOCK[1])]);
    }
  }
  return out;
})();

/**
 * The crowd of 一起能改變什麼: 71 columns by 17 rows, as wide as the site;
 * an account has a proof the more likely the further right (design/DESIGN.md,
 * 點: density, placed one by one, no pattern). The same every time: the
 * draw is seeded, with a seed of its own.
 */
const CROWD_COLUMNS = 71;
const CROWD_ROWS = 17;
const CROWD_YOU = [5, 8] as const;
const CROWD_PROOF: readonly (readonly [number, number])[] = (() => {
  const random = seeded(0x1d6b78);
  const out: [number, number][] = [];
  for (let c = 0; c < CROWD_COLUMNS; c++) {
    const chance = 0.015 + 0.55 * (c / (CROWD_COLUMNS - 1)) ** 2.2;
    for (let r = 0; r < CROWD_ROWS; r++) {
      const nearYou = Math.abs(c - CROWD_YOU[0]) <= 3 && Math.abs(r - CROWD_YOU[1]) <= 1;
      if (random() < chance && !nearYou) out.push([c, r]);
    }
  }
  return out;
})();

/** The part of the cards with an account now whose last card proof is recent, in per cent: what the ratio bar fills. None when there is no card. */
function recentShare({ declared, recent }: HomeNumbers): string {
  return declared === 0 ? "0" : String(Math.round((recent / declared) * 1000) / 10);
}

export function homePage(numbers: HomeNumbers): Document {
  const content = html`<section class="hero">
<div class="in">
<div class="copy">
<p class="kicker">島民證明・從你我開始的網路信任行動</p>
<h1 class="headline"><span class="line">一起讓台灣的</span><span class="line">網路聲量更真實。</span></h1>
<div class="lede">
<p class="stress">你每天看到的討論、動態，背後有多少是真正的台灣人？</p>
<p>用台灣自然人憑證，換一張島民證明：宣告你的 Threads 帳號是台灣人持有，同時不需要公開你的真實身分。</p>
</div>
<p class="actions"><a class="button big" href="/proof">我要換島民證明</a> <a href="/proof-log">看其他人的島民證明</a></p>
<p class="again">已經換過了？<a href="/proof">更新我的島民證明</a></p>
<p class="small needs">${NEEDS}</p>
</div>
<figure class="hero-field">
<figcaption class="sr">一則貼文下面的許多留言帳號，其中有些已經換了島民證明，其中一個是你。</figcaption>
<div class="rings fade" aria-hidden="true"></div>
<svg class="dot-field" aria-hidden="true" focusable="false">
${HERO_PROOF.map(proofDot)}
${youDot(HERO_YOU, true)}
</svg>
<p class="legend" aria-hidden="true"><span class="key"><i class="ring"></i>一則留言的帳號</span> <span class="key"><i class="filled"></i>有一張台灣自然人憑證替這個帳號背書</span></p>
</figure>
</div>
</section>

<section class="why">
<div class="in">
<div class="split">
<div class="head">
<p class="kicker">為什麼需要島民證明？</p>
<h2 class="heading"><span class="line">我們看得見聲量，</span><span class="line">卻不一定看得清它的來源。</span></h2>
<p class="lede">當一篇貼文有上千則留言，我們很難知道背後有多少不同的人參與。帳號可以被大量建立，聲量也可能受到協調操作。AI 只會讓這件事更便宜、更像真人。</p>
<p class="lede">我們可以立場不同、支持不同的黨。但知道彼此是同一國的人，討論才有意義。</p>
</div>
<ul class="cases">
<li class="case">
<p class="kind">一則「真心推薦」</p>
<blockquote>救命，這網站到底是在做功德還是怎樣<br>
居然到現在都沒什麼人推 ○○○<br>
專門幫你搞定英文搭配詞的神器，十萬多個單字全部免費刷到飽<br>
單字背一堆但組不起來的真的必試，趁它還沒被大家擠爆前先低調存起來</blockquote>
<p class="count">428 則留言</p>
<ul class="comments">
<li><i aria-hidden="true"></i>真的！我也在用，超好用</li>
<li><i aria-hidden="true"></i>先存起來 +1</li>
<li><i aria-hidden="true"></i>早知道就好了，謝分享</li>
</ul>
<p class="count"><span class="strip rings short" aria-hidden="true"></span>還有 425 則</p>
<p class="what">一則像真心推薦的行銷文案，下面一排附和的留言。</p>
</li>
<li class="case">
<p class="kind">一則「大家都不知道的真相」</p>
<blockquote>我一直以為大家都知道○○背後是誰在出錢，沒想到知道的人這麼少。</blockquote>
<p class="count">2,316 則留言</p>
<ul class="comments">
<li><i aria-hidden="true"></i>現在才知道，震驚到說不出話</li>
<li><i aria-hidden="true"></i>難怪最近越來越亂，原來有人在背後操作</li>
<li><i aria-hidden="true"></i>用 AI 查了一下，錢怎麼流的都查得到，大家自己去看</li>
</ul>
<p class="count"><span class="strip rings long" aria-hidden="true"></span>還有 2,313 則</p>
<p class="what">先說「大家都不知道」，再由一群講法各不相同的帳號接力補上「證據」，讓人覺得真相正在被揭開。</p>
</li>
</ul>
</div>
<p class="heading conclusion"><span class="line">我們需要更多可以驗證的資訊，</span><span class="line">而不只是猜測。</span></p>
</div>
</section>

<section class="how">
<div class="in">
<div class="split">
<div class="head">
<p class="kicker">保護隱私，也能建立信任</p>
<h2 class="heading"><span class="line">證明你是台灣人，</span><span class="line">不必公開你是誰。</span></h2>
</div>
<div>
<p class="lede">島民證明用台灣自然人憑證和零知識證明，在你自己的裝置上算出一份證明，內容是<span class="claim">「有一張有效的台灣自然人憑證，宣稱自己是某個 Threads 帳號的持有者」</span></p>
<p class="lede">這張證明不會透露你的姓名、身分證字號，也看不出是哪一張卡片。每張證明都會公開在網站上，任何人都能驗證「這段宣告簽署自一張有效的自然人憑證」和「每張卡片只能宣告一個 Threads 帳號」。</p>
</div>
</div>
<figure class="flow">
<figcaption class="sr">自然人憑證、姓名、身分證字號和 PIN 留在你的電腦或手機上；只有島民證明送出去，放進公開的證明紀錄；任何人都能驗證。</figcaption>
<div class="at-home">
<div class="laptop" aria-hidden="true">
<div class="screen"><p class="s-brand">島民證明</p><p class="s-label">PIN</p><p class="s-pin">••••••</p><p class="s-run"><i></i>在這台電腦上算證明</p></div>
<div class="base"></div>
<div class="reader"><div class="id-card"><span class="chip"></span><span class="stripe"></span><span class="stripe short"></span></div></div>
</div>
<p class="caption"><b>個資不離開你的設備</b>自然人憑證、姓名、身分證字號和 PIN，只會留在你的電腦或手機。</p>
</div>
<div class="sent">
<p class="label">只送出這張零知識證明</p>
<div class="proof-card" aria-hidden="true"><p class="card-top">${LOGO}<span>島民證明</span>　<span class="platform">Threads</span></p><p class="account">@alice</p><p class="short-id">島民編號 <span class="id">7K2Q9FM4XD</span> 開頭</p></div>
<p class="caption">一張匿名但有效的自然人憑證宣告自己持有 Threads 帳號 @alice。</p>
</div>
<div class="public">
<div class="log-mock" aria-hidden="true"><p class="log-title">公開的證明紀錄</p><p class="row first">@alice　<span><span class="id">7K2Q9FM4XD</span> 開頭</span></p><p class="row"><i></i><i class="end"></i></p><p class="row"><i class="mid"></i><i class="end"></i></p><p class="row"><i class="long"></i><i class="end"></i></p></div>
<div class="viewers" aria-hidden="true"><span class="phone"></span><span class="laptop-icon"></span><span class="window"></span></div>
<div class="caption"><b>不需要信任我們，任何人都能驗證證明紀錄</b><ol class="checks"><li>1. 每個證明都來自一張當時有效的卡片簽署</li><li>2. 每張卡片同時只能宣告一個 Threads 帳號</li></ol></div>
</div>
</figure>
<p class="see"><a href="/proof-log">看一張島民證明的樣子</a></p>
<dl class="tenets">
<div><dt>保護個資</dt><dd>Threads、政府、甚至就連我們自己，都查不出一張島民證明背後是哪一張卡片。只知道你的自然人憑證在簽名當下是有效的。</dd></div>
<div><dt>自願參與</dt><dd>要不要換、換給哪個帳號、要不要把證明連結放到個人檔案上，都由你決定。</dd></div>
<div><dt>無關政治傾向</dt><dd>只要你持有台灣自然人憑證，就能夠使用本服務宣告你的帳號是台灣人所持有，無任何審查，任何政治立場都可以使用。</dd></div>
</dl>
<div class="limit">
<p class="heading"><span class="line">一張自然人憑證，</span><span class="line">只能替一個 Threads 帳號背書。</span></p>
<div>
<p>第一次申辦自然人憑證，要年滿 18 歲、本人到戶政事務所、花費 250 元。</p>
<p>要產生一萬張島民證明，得先有一萬張真的自然人憑證，這會大幅增加假扮真人帳號的成本。</p>
</div>
</div>
</div>
</section>

<section class="together">
<div class="in">
<div class="head">
<p class="kicker">我們一起，能改變什麼？</p>
<h2 class="heading"><span class="line">證明的人越多，</span><span class="line">假扮台灣人的成本就越高。</span></h2>
<p class="lede">每多一個人換一張島民證明，就多一個有島民證明的帳號。有證明的帳號越多，只靠假帳號堆出來的聲量就越顯得單薄，想操作輿論的人得付出更多。</p>
</div>
<div class="tally">
<p class="stat"><span class="label">現在有</span> <b class="number">${thousands(numbers.declared)}</b> <span class="unit">張島民證明</span></p>
<p class="stat recent"><span class="label">其中</span> <b class="number">${thousands(numbers.recent)}</b> <span class="unit">張在過去三個月內過卡</span></p>
<svg class="ratio" aria-hidden="true" focusable="false"><rect class="track" width="100%" height="12" rx="6"></rect><rect class="part" width="${recentShare(numbers)}%" height="12" rx="6"></rect></svg>
<p class="ratio-key" aria-hidden="true"><span><i class="part"></i>過去三個月內過卡</span> <span><i class="track"></i>超過三個月沒有過卡</span></p>
<p class="small note">每一張證明，背後都是一張自然人憑證。</p>
</div>
</div>
<figure class="crowd">
<figcaption class="sr">一大片留言的帳號，越往右，有島民證明的帳號越多；其中一個是你。</figcaption>
<div class="rings" aria-hidden="true"></div>
<svg class="dot-field" aria-hidden="true" focusable="false">
${CROWD_PROOF.map(proofDot)}
${youDot(CROWD_YOU, false)}
</svg>
</figure>
<div class="in">
<div class="stack">
<div class="layer ground"><p class="when"><i></i>現在</p>
<b>查一個帳號有沒有台灣人背書</b>
<p>任何人都能查閱一個 Threads 帳號，看看是否有島民證明替其背書，還可以檢查上次過卡更新是幾天前。</p></div>
<div class="layer up"><p class="when">基於島民證明的資料，分析 Threads 的聲量</p>
<b>讓聲量更容易被檢視</b>
<p>任何人都能夠使用證明紀錄，開發服務或外掛，分析一則 Threads 動態的留言裡，有島民證明的帳號比例。</p></div>
<div class="layer up"><p class="when">願景</p>
<b>真實台灣人的討論空間</b>
<p>其他網站可以整合或參考島民證明的技術，開設能驗證持有自然人憑證的討論區。在不揭露個資的情況下，確保一張卡只能註冊一個帳號。</p></div>
</div>
<p class="closing">當更多人參與島民證明，它就有機會成為讓網路討論更容易被檢視的共同基礎。</p>
</div>
</section>

<section class="qa">
<div class="in split">
<h2 class="heading">常見問題</h2>
<div>
<div class="questions">
${QUESTIONS.map((q) => html`<details><summary>${q.question}</summary>\n${q.answer}</details>`)}
</div>
<p class="more-qa"><a href="/faq">更多常見問題</a></p>
</div>
</div>
</section>

<section class="end">
<div class="in split">
<div class="ask">
<p class="kicker">讓台灣的網路討論，多一份真實的力量</p>
<h2 class="heading"><span class="line">改變網路環境，</span><span class="line">從我們自己開始。</span></h2>
<p class="lede">讓保護隱私又能驗證的證明，成為台灣網路討論的一種新選擇。加入島民證明，一起改變我們的網路討論環境。</p>
<p><a class="button big" href="/proof">我要換島民證明</a></p>
</div>
<div>
<h3 class="steps-title">如何換</h3>
<ol class="steps">
<li><span class="n">1</span><div><b>準備自然人憑證</b><span class="small">實體的卡片，和支援 NFC 的手機（iPhone 或 Android 都可以）。用讀卡機和電腦也可以。</span></div></li>
<li><span class="n">2</span><div><b>用卡片宣告你的帳號</b><span class="small">過卡：輸入你的 Threads 帳號名稱，用卡片在你的裝置上算出證明。</span></div></li>
<li><span class="n">3</span><div><b>拿到島民證明</b><span class="small">過卡完成後，你會拿到這張證明的連結，任何人都能驗證：「有一張匿名的自然人憑證宣告自己持有某個 Threads 帳號」。</span></div></li>
<li><span class="n">4</span><div><b><a href="/hang">用你的帳號承認這張證明</a></b><span class="small">把證明連結掛到 Threads 的個人檔案上。別人才看得出這個帳號承認這張證明（因為任何卡片都能宣告任何帳號，但一卡只能宣告一帳號）。</span></div></li>
</ol>
<div class="after">
<p class="small">還沒有自然人憑證？本人帶身分證到戶政事務所，250 元，當天拿到。任何一間戶政事務所都可以辦，不限戶籍地。</p>
<p class="small">我們只收台灣中華民國國民的自然人憑證正卡。非中華民國國籍人所持有的自然人憑證無法使用於島民證明。</p>
</div>
</div>
</div>
</section>`;
  return { title: TITLE, tabTitle: TAB_TITLE, description: DESCRIPTION, kind: "home", content };
}

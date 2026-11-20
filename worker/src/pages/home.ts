// The home page: design/copy/home.md, sections 1 to 8 (the navigation bar
// and section 9 are the layout's). The markup is the Go backend's
// (server/pages/templates/home.html).
//
// Section 6 shows seven questions of design/copy/faq.md, each with the
// answer faq.md has for it. They are written here until the FAQ page is
// made (the Go backend's server/pages/templates/faq-answers.html has every
// question); that page will then read the same pieces.
import { Html, html, thousands } from "./html.ts";
import { type Document, NEEDS } from "./layout.ts";

/** The home page's two numbers (home.md, section 2). */
export interface HomeNumbers {
  /** The cards that give their place on Threads to an account now. */
  readonly declared: number;
  /** Those among them whose last card proof is in the last 90 days. */
  readonly recent: number;
}

/** The seven questions of section 6, in its order, each with its answer (faq.md). */
const QUESTIONS: readonly { readonly question: string; readonly answer: Html }[] = [
  {
    question: "我的個資會外流嗎？",
    answer: html`<p>你的姓名、身分證字號、自然人憑證和 PIN 都不會離開你的裝置。公開的名冊會記下哪個社交帳號有島民證明，但對應不回是哪張卡片。</p>
<p><strong>注意：</strong>拿到你的卡片和 PIN 的人，查得出你換過哪個帳號的島民證明，所以卡片請小心保管。</p>`,
  },
  {
    question: "政府會知道我是哪個帳號嗎？",
    answer: html`<p>查不出來。Threads、政府、島民，都查不出一張島民證明是哪一張卡片換的。這也是只收實體卡片的原因。</p>
<p>這靠的是現在破解不了的加密，不是永久的保證。 <a href="/faq#security">了解更多</a></p>`,
  },
  {
    question: "有島民證明，就代表不是網軍嗎？",
    answer: html`<p>不是。它只代表有一張真的自然人憑證，把名額給了這個帳號。島民證明擋不住把自己卡片賣掉的台灣人，但它會讓假帳號的成本變得很高：一張自然人憑證在 Threads 只能換一張，要一萬個這樣的帳號，得先有一萬張真的卡片。</p>`,
  },
  {
    question: "別人可以換一張寫著我帳號的島民證明嗎？",
    answer: html`<p>可以，這擋不了。但這對對方幾乎沒有好處：他用掉的是自己唯一的名額。你還是可以用自己的卡片，替自己的帳號換一張島民證明。你沒有把那一張的連結掛上個人檔案，別人就看得出你沒有承認。</p>`,
  },
  {
    question: "卡片借人或賣給別人怎麼辦？",
    answer: html`<p>擋不了，拿到卡片和 PIN 的人就能替它換。</p>
<p>但把自然人憑證交給別人，代價遠遠大過一張島民證明。它加上 PIN，就是你在網路上的身分證和印鑑：對方可以用你的名義報稅、查你的財產和所得資料、向政府申辦各種業務，簽出來的文件有法律效力。</p>
<p>別人看島民證明時，看的也不只是有沒有，還有上次過卡是幾天前。卡片掛失之後，那張卡就不能再更新。</p>`,
  },
  {
    question: "這個服務要錢嗎？",
    answer: html`<p>不用。換島民證明、更新、更換帳號、收回，都免費。</p>`,
  },
  {
    question: "誰在做島民？",
    answer: html`<p>一個興趣使然的台灣工程師。有任何技術問題或建議，歡迎到 <a href="https://github.com/iamreal-tw/iamreal">GitHub</a> 討論。</p>`,
  },
];

/** The link preview (home.md, 連結被貼出去時的預覽): its title, the <title>, and the first screen's two lines as one sentence. */
const TITLE = "島民";
const TAB_TITLE = "島民｜iamreal.tw";
const DESCRIPTION = "讓 Threads 上的人知道，你是真的台灣人。用自然人憑證證明，除了 Threads 帳號名稱，不會揭露任何個資。";

export function homePage(numbers: HomeNumbers): Document {
  const content = html`<section class="hero">
<p class="brand"><b>島民</b> <span>iamreal.tw</span></p>
<h1 class="headline"><span class="line">讓 Threads 上的人知道，你是真的台灣人。</span><span class="line">用自然人憑證證明，除了 Threads 帳號名稱，不會揭露任何個資。</span></h1>
<p class="actions"><a class="button big" href="/proof">我要換島民證明</a> <a href="/roster">看已經換出的島民證明</a></p>
<p class="small needs">${NEEDS}</p>
<div class="mini-proof">
<p class="mini-top"><span>島民證明</span> <span class="platform">Threads</span></p>
<p class="mini-account">@alice</p>
<dl>
<dt>上次過卡</dt> <dd>12 天前</dd>
<dt>島民編號</dt> <dd><span class="id">7K2Q9FM4XD</span> 開頭</dd>
</dl>
</div>
</section>

<section class="numbers">
<p class="count">現在有 <b>${thousands(numbers.declared)}</b> 張島民證明</p>
<p class="count">其中 <b>${thousands(numbers.recent)}</b> 張在過去三個月內過卡</p>
<p>每一張證明，背後都是一張自然人憑證。</p>
</section>

<section class="why">
<h2 class="big-heading"><span class="line">留言區裡，</span><span class="line">哪些是真的人？</span></h2>
<p>社群平台上的假帳號越來越多，AI 只會讓假帳號更便宜、更像真人。靠每個人自己封鎖，只怕會是螳臂當車。</p>
<p>我們可以立場不同、支持不同的黨。但知道彼此是同一國的人，討論才有意義。</p>
<p>島民讓你不用告訴任何人你是誰，就能證明你是中華民國國民、證明你是台灣人。</p>
</section>

<section class="how">
<h2 class="big-heading">怎麼換島民證明</h2>
<ol class="steps">
<li><span class="n">1</span><div><b>準備自然人憑證</b><span class="small">實體的卡片、讀卡機和電腦。</span></div></li>
<li><span class="n">2</span><div><b>過卡</b><span class="small">卡片簽下你的帳號，在你的裝置上算出一份證明。送出去的只有證明、帳號和島民編號。</span></div></li>
<li><span class="n">3</span><div><b><a href="/hang">掛到 Threads 的個人檔案上</a></b><span class="small">把島民證明的連結放進個人檔案。掛上去，別人才看得出這個帳號承認這張證明。</span></div></li>
</ol>
</section>

<section class="proves">
<h2 class="big-heading">它證明了什麼</h2>
<p>一張島民證明有兩半。</p>
<div class="halves">
<div class="half">
<p class="tag">第一半　算得出來的</p>
<p>一張台灣實體自然人憑證，在 Threads 只能換一張島民證明。這一張證明上面寫給 @alice。</p>
<p class="small">這一半任何人都可以驗證，不用相信我們。它是一份<a href="/verify">零知識證明</a>：確認得了卡片是有效的，卻不用暴露卡片上的個資。</p>
</div>
<div class="half">
<p class="tag">第二半　要自己看的</p>
<p>@alice 把這張證明的連結，掛在自己的個人檔案上。</p>
<p class="small">這表示帳號主人承認這張島民證明。點連結進去，可以看到上次過卡是幾天前。</p>
</div>
</div>
<p class="both">兩半都在，才是「@alice 說自己是島民」。</p>
<p>只有第一半，只代表有人拿卡片換了一張宣告 @alice 的島民證明，但看不出換的人是不是 @alice 的主人。</p>
</section>

<section class="scarce">
<h2 class="big-heading">難以灌水</h2>
<p>第一次申辦自然人憑證，要年滿 18 歲、本人到戶政事務所。</p>
<p>一張自然人憑證在 Threads 只能換一張。要一萬張島民證明，得先有一萬張真的自然人憑證。</p>
</section>

<section class="qa">
<h2 class="big-heading">常見問題</h2>
<div class="questions">
${QUESTIONS.map((q) => html`<details><summary>${q.question}</summary>\n${q.answer}</details>`)}
</div>
<p class="more-qa"><a href="/faq">更多常見問題</a></p>
</section>

<section class="helps">
<h2 class="big-heading">所以島民可以幫上什麼忙？</h2>
<ul class="uses">
<li><span class="when">現在</span><div><b>協助判斷一個 Threads 帳號背後是不是台灣人</b>
<span class="sub">注意：還是有人會出售或出借自己的自然人憑證。</span>
<span class="sub">有些話題，知道對方也是台灣人，才有得談。</span></div></li>
<li><span class="when">現在</span><div><b>增加網軍建立假帳號的成本</b></div></li>
<li><span class="when">現在</span><div><b>增加詐騙集團建立假帳號的成本</b></div></li>
<li><span class="when">之後</span><div><b>分析一則貼文下面，留言裡有島民證明的比例</b></div></li>
<li><span class="when">之後</span><div><b>需要一人一個帳號、又不想透露身分的場合</b>
<span class="sub">例如連署、搶票、留言。</span></div></li>
</ul>
</section>

<section class="end">
<h2 class="big-heading"><span class="line">假帳號要多少有多少。</span><span class="line">你，只有一個。</span></h2>
<p class="lead">站出來的台灣人越多，假帳號就越難假裝成「大家」。</p>
<p><a class="button big" href="/proof">我要換島民證明</a></p>
<p class="small">還沒有自然人憑證？本人帶身分證到戶政事務所，250 元，當天拿到。任何一間戶政事務所都可以辦，不限戶籍地。</p>
<p class="small">${NEEDS}島民只收台灣中華民國國民的自然人憑證正卡。</p>
</section>`;
  return { title: TITLE, tabTitle: TAB_TITLE, description: DESCRIPTION, kind: "home", content };
}

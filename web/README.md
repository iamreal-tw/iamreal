# web/：網頁版的過卡

**這個目錄讓人檢查的事：憑證、公鑰、簽章、PIN 沒有離開持卡人的裝置。** 這裡是從「讀到卡片上的憑證」到「送出證明」之間，在持卡人的瀏覽器裡做的每一件事：過卡的引擎（`src/`，不含畫面）、內政部元件的橋接（`src/card/hipki.ts`）、過卡的畫面（`src/ui/`）。

程式照 `spec/` 和 `docs/api/card-proof.md` 實作，規格裡的算法引用 `protocol/`，不引用 `worker/`。裝置上的保護照 ADR-0015、ADR-0016：保護持卡人、對抗伺服器的限制寫死在這裡，伺服器只能讓它更嚴。

## 在本機用真卡片過卡

需要 Node 22（22.6 以上）、pnpm 10、讀卡機和內政部的元件（HiPKI，`http://localhost:61161`）。不需要 Cloudflare 的帳號：後台是 `worker/`，跑在本機的 workerd。

```
pnpm install --frozen-lockfile             # 在根目錄：pnpm workspace，web/、worker/、protocol/ 一起裝
cd worker
pnpm local                                 # 可加 --port 8080、--data <目錄>
```

`pnpm local`（`worker/scripts/local.ts`，`worker/README.md`「在本機用真卡片過卡」）依序：通用參數不在就下載（`pnpm fetch-crs`）、建置本機用真卡片的頁面（`vite build --mode localcard`，`src/target-local.ts` 換掉 `src/target.ts`：內政部的發證金鑰、元件在 `http://localhost:61161`、沒有假卡片和測試金鑰，和正式的建置相同；**但簽的是測試的證明紀錄的場合字串 `iamreal-test:public:0__________`**，在這裡試真卡片算出的匿名編號和公開的證明紀錄裡的無關；認得測試的證明紀錄的兩個平台 `test-example`、`threads`）、在本機的 workerd 啟動部署的那一份 Worker（內政部的發證金鑰和清冊網址、Worker 裡的驗證器；測試環境的設定，所以是測試的證明紀錄）、跑一次清冊鏡像（抓內政部真的 G2、G3 清冊），在 `http://localhost:8080/proof` 提供頁面（同一個 Worker 在 `http://localhost:8080/` 提供首頁和其他訪客的頁面）。按 Ctrl-C 停止。證明紀錄、清冊存檔、頁面在 `worker/local/`（不進版控）；刪掉這個目錄就從空的證明紀錄重來。Go 的舊後台用的 `web/local/` 不再讀寫。正式的建置（`pnpm build`）不變，簽的是公開的證明紀錄的場合字串。

用桌機的 Chrome 開 `http://localhost:8080/proof`。`localhost` 是瀏覽器認定的安全來源，不需要 HTTPS：在後台送的標頭之下，頁面是跨來源隔離的（多執行緒），也能和元件的視窗來回（2026-11-16 在這台 Mac 的 Chrome 157 實測，只送 `CheckEnvir`：`test/e2e/check-component.ts`）。Safari、Firefox 忽略 `Document-Isolation-Policy`，證明用 1 個執行緒；這一頁沒有在它們上面測過。後台另外送 `Cross-Origin-Opener-Policy: same-origin-allow-popups`（見「頁面需要的標頭」）；加了它之後元件還能不能用，Chrome 以外的瀏覽器和真的過卡還沒有確認。

確認頁面本身沒問題、但還不想插卡時：`pnpm local` 啟動時已經跑過不插卡的檢查（`worker/test/site-check.ts`）；`node --experimental-strip-types test/e2e/smoke.ts http://localhost:8080/proof` 再用無頭 Chrome 開到第一個畫面為止（不按「讀取卡片」，元件不會收到任何請求），檢查標頭、跨來源隔離、證明引擎啟動、沒有違反 CSP、沒有連到別的網域。

## 三種用真元件的建置

用內政部的發證金鑰和真的元件（`http://localhost:61161`）的建置有三種，都不含假卡片和測試金鑰（`test/build.test.ts` 逐一檢查）。差在簽哪一份證明紀錄的場合字串、清冊存檔從哪裡下載、完成畫面的連結寫哪個網域、頁面上有沒有測試的證明紀錄的標示：

| | 正式 | 測試網站 | 本機真卡片 |
|---|---|---|---|
| 指令 | `pnpm build` | `pnpm build:test-site` | `pnpm local` |
| Vite 的 mode、換上的 `src/target.ts` | `production`，`src/target.ts` 本身 | `testsite`，`src/target-test-site.ts` | `localcard`，`src/target-local.ts` |
| 用在哪裡 | 正式網站 `iamreal.tw` | 測試網站 `test.iamreal.tw`（ADR-0028）：部署時由 `worker/` 建置、放進 Static Assets（`worker/README.md`「Static Assets」） | 這台電腦，`http://localhost:8080/proof` |
| 卡片簽的場合字串 | 公開的證明紀錄的 `iamreal:public:0_______________` | 測試的證明紀錄的 `iamreal-test:public:0__________` | 測試的證明紀錄的 `iamreal-test:public:0__________` |
| 裝置認得的平台 | `threads` | `test-example`、`threads` | `test-example`、`threads` |
| 資料網域（`DATA_ORIGIN`） | `https://data.iamreal.tw` | `https://test-data.iamreal.tw` | 空字串：頁面自己的網域，本機的 Worker 在 `/crl/…` 提供清冊（`worker/local-build/`） |
| 伺服器送的 CSP `connect-src` | `'self' https://data.iamreal.tw` | `'self' https://test-data.iamreal.tw` | `'self' https://test-data.iamreal.tw`（測試網站的那一份；頁面只連自己的網域） |
| 完成畫面的連結（`SITE_DOMAIN`） | `iamreal.tw/p/<短編號>` | `test.iamreal.tw/p/<短編號>` | `iamreal.tw/p/<短編號>`（本機的網址不寫進連結，照正式的） |
| 測試的證明紀錄的標示 | 沒有 | 每一頁最上面：`測試的證明紀錄　不定期清空，上次清空：<日期>`（`design/copy/test-site.md`） | 沒有 |
| 後台 | `worker/` 的正式環境（還沒有） | `worker/` 的測試環境 | `worker/` 的測試環境，跑在本機的 workerd |

其他都相同：發證金鑰、元件的網址、PIN 等第二次簽章的 5 分鐘、每一項檢查。在測試網站或本機試真卡片算出的匿名編號和公開的證明紀錄裡的無關（`spec/scope.md`）。

測試網站的建置要給它一個日期，環境變數 `IAMREAL_TEST_PROOF_LOG_CLEARED_ON`（`YYYY-MM-DD`）：測試的證明紀錄上次清空的日期，寫在標示旁。沒給、或不是日曆上有的日期，不建置（`vite.config.ts`）。部署時由 `worker/scripts/deploy.ts` 的 `buildSite` 從 `worker/wrangler.jsonc` 的 `TEST_PROOF_LOG_CLEARED_ON` 帶進來，建置完再核對頁面裡的日期就是那一個；自己建置時：

```
IAMREAL_TEST_PROOF_LOG_CLEARED_ON=2026-11-19 pnpm build:test-site
```

**標示只在測試網站的建置裡。** 它是一支自己的進入點 `src/ui/test-proof-log.ts`（和它的樣式 `test-proof-log.css`），`vite.config.ts` 只在 `testsite` 模式把它加進頁面的 HTML，其他建置的模組圖裡沒有它：`src/target.ts`、`main.ts`、`style.css` 都不知道有標示。句子在建置時從 `design/copy/test-site.md` 讀進來（`src/ui/` 沒有自己的句子），和日期、這份建置的 target 讓卡片簽的場合字串寫成一段 JSON 放在那支程式裡；頁面最上面的那一行由它畫，樣式和後台產生的頁面相同。`vite.config.ts` 建置前讀 `src/target-test-site.ts`：它簽的不是測試的證明紀錄的場合字串就不建置。部署前的檢查再從建置出來的程式讀那段 JSON，核對日期和場合字串（`worker/scripts/proof-page.ts`）。

`test/build.test.ts` 釘住正式的建置沒有標示的任何檔案和字，而且只有過卡的頁面一個 HTML。

**完成畫面的連結跟著建置的網站。** `SITE_DOMAIN` 在 target 裡：測試網站的建置寫 `test.iamreal.tw/p/<短編號>`，「複製連結」複製的是 `https://test.iamreal.tw/p/<短編號>`，就是測試的證明紀錄裡這張島民證明的網址（後台在測試網站的島民證明和掛上去那一頁寫的也是這個網域，`design/copy/test-site.md`「寫出島民證明網址的地方」）。

無頭瀏覽器的測試另外有兩種建置，都不用真元件：`test`（`test/e2e/target.ts`：測試的發證金鑰、假元件）和 `engine`（引擎自己的測試頁）。

## 畫面和引擎怎麼分層

| 層 | 檔案 | 做什麼 | 不做什麼 |
|---|---|---|---|
| 畫面 | `src/ui/` | `design/copy/card-proof.md` 的六步、三次點擊；兩張清單每一項的狀態、停住時的原因寫在哪一項下面；把停止原因、這張卡片的帳號清單和每一列下面的那一行、要簽的整份清單和每一列會發生什麼、完成時證明紀錄記下的對到 `design/copy/card-proof.json` 的句子（`messages.ts`）；在點擊裡開元件的視窗，被擋時不往下做 | 不檢查任何東西、不碰憑證和簽章的位元組；沒有自己的句子（`test/copy.test.ts` 檢查 `src/ui/` 和 HTML 裡沒有中日韓文字） |
| 每個平台的寫法 | `src/platforms.ts` | 後台不給、每個平台不同的寫法（見下面「每個平台不同的東西」） | 沒有句子；格式的提示是 `card-proof.json` 的鍵；不決定有哪些平台，也不決定場合字串 |
| 引擎 | `src/flow.ts`、`src/index.ts` 和其他 | 全部的檢查、何時讓卡片簽、何時查現況、讀後台的平台表、建清單、每個平台會是哪一種、拒絕不能做的清單、PIN 留多久、算證明、送出、比對後台記下的和畫面說的；做完一件事就告訴畫面（`onProgress`） | 不知道有畫面 |
| 卡片 | `src/card/card.ts` 的介面；`hipki.ts`（元件）、`fake.ts`（測試金鑰） | 讀憑證（不用 PIN，元件有回應時先說一聲）、簽 31 個位元組（要 PIN），簽章附上實際簽章的憑證 | 不判斷憑證能不能用 |

畫面的文字在 `design/copy/card-proof.json`，是 `design/copy/card-proof.md` 的句子照畫面分組、例子換成 `{名稱}`（`{account}` 是帶前綴的帳號，例如 `@alice`）。`test/copy.test.ts` 兩個方向都比：JSON 的每一句代入 Markdown 的例子後，在 Markdown 裡一字不差；Markdown 的每個畫面（程式碼區塊）和表格裡「畫面寫」「標題」「證明紀錄會公開記下」「按鈕」那幾欄的每一格，都由 JSON 的句子組成，剩下的只能是照原樣顯示的值（例子的帳號、日期、姓名、完成畫面的連結、平台的顯示名稱和代號，`src/platforms.ts` 的前綴）和 Markdown 畫按鈕、清單、可展開問題的符號（`[ ]`、`›`、`▸`、`○`、`·`）。「（QR code）」和「第 2 步那張表裡同一種情況的句子」是文件的註，不比。文件裡沒有的句子，畫面只顯示代碼（見「停止的原因」和「文件沒有句子、畫面顯示代碼的地方」）。JSON 的每一句都在那份 Markdown 裡。

`card-proof.json` 的 `app` 那一組（選裝置、用手機過卡）是 app 推出之後用的：畫面現在不顯示它們（`card-proof.md`「app 推出之前」），文字測試照樣比對它們在 Markdown 裡。`app_` 開頭的那幾組是 Android、iOS 的 app 自己的句子（`card-proof.md` 標「app」的段落），網頁不顯示；文字測試照樣兩個方向比對，並檢查它們沒有「這台裝置」「這台電腦」。

第 1 到 5 步不連到別的頁面（`docs/design/principles.md` 原則 1：點出去會打斷過卡），也沒有「了解更多」。例外是第 2 步停在「連不上內政部的元件」時那一句後面的「過卡需要什麼」：在這一頁排除不了。它連到網站的「過卡需要什麼」`/prepare`（後台產生的頁面，`design/copy/prepare.md`）。完成畫面（第 6 步，過卡已經結束）的連結：帳號的個人檔案、「打開你的島民證明」（這個網站的 `/p/<島民編號>`）、「分享到 Threads」（Threads 的發文畫面，只帶入這張島民證明的網址）。全部在新分頁開：離開這一頁，過卡就中斷了。

過卡的說明頁 `/proof/help.html` 拿掉了（#292）：建置裡沒有它，舊網址轉（`301`）到 `/prepare`（`worker/site/_redirects`）。Android、iOS 的 app 改版之前還連到那個網址。

**完成畫面的 QR code**（`src/ui/qr.ts`）：內容是這張島民證明掛上去的那一頁 `https://<SITE_DOMAIN>/hang/<島民編號>`（`design/copy/hang.md` 第 2 部分），在頁面上用 DOM 畫成 SVG，不向任何地方發請求。編碼器不是套件：照 Project Nayuki 的 QR Code generator library（MIT 授權，`NOTICE`）的做法，只留這一頁要的（位元組模式、錯誤更正等級 M、版本 1 到 10）。`test/qr.test.ts` 逐格比對那個函式庫（Python 版 qrcodegen 1.8.0）產生的標準答案 `test/fixtures/qr-vectors.json`，產生的指令寫在 `test/generate/qr-vectors.py`；寫的時候另外用讀碼程式（zbarimg）讀過頁面截圖上的 QR code。

每個畫面的頁首是記號、服務的名稱「島民證明」和網站的名字 `iamreal.tw`（`card-proof.json` 的 `common.service_name`、`common.site_name`），不是連結。網站的名字在測試網站的建置裡也是 `iamreal.tw`（`design/copy/test-site.md`），`test/build.test.ts` 只容許它用正式網站的網域。

**版面和字體**：第 1 到 5 步照 `design/screens/card-proof-web-*` 和 `design/DESIGN.md`；寫在 `:root` 的變數，數值照 `design/tokens.json`（`test/style.test.ts`）；畫布上的間距、小字級（13、15、16px）照截圖寫在各條規則裡。標題用 `design/fonts/` 的源流明體 TW 子集，建置時打包進頁面自己的檔案（後台送的 CSP 有 `font-src 'self'`）；內文和等寬字用系統的字體。

## 網址

過卡的頁面在 `/proof`，它的每個檔案在 `/proof/` 底下：程式和 worker（`/proof/assets/…`）、bb.js 的 WebAssembly（`/proof/bb/…`）、電路（`/proof/circuits/…`）、通用參數（`/proof/crs/…`）。網站的 `/` 是首頁，由後台產生（`worker/README.md`「頁面和檔案」）。四種頁面的建置（production、testsite、localcard、test）的 `base` 是 `/proof/`（`vite.config.ts`）；頁面自己寫的路徑從 `src/base.ts` 的 `BASE` 接上去（`import.meta.env.BASE_URL`，建置時寫死；Node 裡的測試沒有建置，是 `/`）。引擎自己的測試頁（mode engine，`pnpm test:e2e`）照舊在 `/`。API（`/api/v1/…`）的路徑不變。

### 資料網域

清冊存檔（`crl/index.jsonl`、`crl/<SHA-256>.crl`）不在後台，在資料網域（ADR-0027，`docs/api/card-proof.md`「Public files」）。資料網域是建置時定的一個值（`src/target.ts` 的 `DATA_ORIGIN`），不從伺服器的回應或網址來：

| 建置 | `DATA_ORIGIN` |
|---|---|
| 正式（production） | `https://data.iamreal.tw` |
| 測試網站（testsite） | `https://test-data.iamreal.tw` |
| 本機用真卡片（localcard） | 空字串：頁面自己的網域。本機的 Worker 在 `/crl/…` 提供清冊（`worker/local-build/`） |
| 測試（test，無頭瀏覽器的測試） | 空字串：頁面自己的網域。本機和 CI 沒有資料網域，後台（`worker/`）也沒有把清冊送給人的路由，所以測試在 Worker 前面起一個小服務扮演它：`/crl/…`、`/proof-log/…` 從 R2 的模擬讀（只讀），其他請求原樣交給 Worker（`test/e2e/worker-site.ts`） |

`test/build.test.ts` 檢查正式的建置含 `https://data.iamreal.tw`、測試網站的建置含 `https://test-data.iamreal.tw` 而不含正式的那一個、本機用真卡片的建置不含任何資料網域。頁面用 `src/api.ts` 的 `dataOriginFetch` 拿這個網域的檔案。

CSP 是送標頭的那一邊定的，不是建置定的：`worker/` 照證明紀錄的種類送各自的資料網域（`worker/src/headers.ts` 的 `proofPageHeaders`，寫進 `worker/site/_headers`），測試網站是 `https://test-data.iamreal.tw`，正式網站是 `https://data.iamreal.tw`（見「`Content-Security-Policy`」）；`pnpm local` 送的是測試網站的那一份。部署前的檢查核對放上測試網站的建置寫的資料網域就是標頭允許的那一個（`worker/scripts/proof-page.ts`）。

完成畫面的「打開你的島民證明」連到 `/p/<島民編號>`：路徑，不寫網域，過卡的頁面和島民證明在同一個網站。寫在畫面上的連結 `iamreal.tw/p/<島民編號>`、複製的 `https://iamreal.tw/p/<島民編號>` 和 QR code 的 `https://iamreal.tw/hang/<島民編號>` 是完整的網址，網域是建置的 `SITE_DOMAIN`。

## 每個平台不同的東西

公開的證明紀錄只有一個場合（ADR-0017），一次過卡處理這張卡片的整份帳號清單，沒有選平台的畫面。

- **場合字串**只有一個，寫死在 `protocol/src/scope.ts`：正式的建置是 `iamreal:public:0_______________`，測試的建置是 `iamreal-test:public:0__________`（`src/target.ts` 的 `PROOF_LOG`，測試的建置換成 `test/e2e/target.ts`）。**不從伺服器、平台表或網址來**（ADR-0016）。
- **有哪些平台、帳號名稱的格式**：從後台的平台表來（`GET /api/v1/config` 的 `platforms`，`src/api.ts` 的 `requestConfig`），讀取卡片時和清冊、電路檔一起拿，在第一次簽章之前。格式只收規格限定的那一種寫法 `[…]{m,n}`，由 `protocol/src/username-format.ts` 自己逐字解析，**不交給正規表示式引擎**（後台送任意的表示式，各家引擎的差異、故意寫得很慢的表示式都碰不到）。讀不懂的那一列，那個平台就是「裝置不認得的平台」；一列都讀不懂、沒有 `platforms`、平台代號重複或沒有照順序，整張表讀不懂，停在「連上島民證明的伺服器」（「伺服器的回應不正確……（代碼 malformed_response）」），不要 PIN。表裡的 `display_name` 照規則檢查讀不讀得懂，**不顯示**。
- **寫死在裝置上的每個平台的東西**（`src/platforms.ts`，每個平台一份在 `src/presentations/`）：名稱（Threads）、帳號前面的字（`@`）、輸入的整理（去掉一個前綴、ASCII 大寫改小寫）、格式不對時的提示（`card-proof.json` 的 `formats` 裡的鍵；沒有的平台用「帳號的格式不對。請照平台上顯示的帳號填。」）、帳號公開頁面的網址（`profileUrl`，沒有的平台就不顯示「預覽個人檔案」）。建置決定有哪幾份（`src/target.ts` 的 `PRESENTATIONS`）：正式的建置只有 Threads；測試的建置、測試網站的建置和本機用真卡片的建置多 `test-example`（`src/presentations/test-example.ts`，正式的建置不含，`test/build.test.ts` 檢查）。**一個平台可以編輯，要後台的表有它讀得懂的那一列，而且裝置有它自己的那一份**（`FlowDeps.knownPlatforms`）。
- **裝置不認得的平台**（後台的表沒有它讀得懂的那一列，或裝置沒有它自己的那一份）：卡片在那裡沒有帳號就不顯示；有帳號，第 4 步顯示成不能修改的一列（後台回的平台代號和帳號原樣，空白也照原樣顯示），下面一句「這一頁還不認得這個平台。……」，送出的清單原樣帶著它、照平台代號的位元組順序排進去：少了它就等於收回它。引擎只做每個帳號都滿足的最低限度的檢查（平台代號 1 到 21 個 `a-z0-9-`，帳號名稱是 1 個以上可印出的 ASCII、不含 `"` 和 `\`），不合就當成現況讀不懂。
- **平台表上有、這張卡片的現況裡沒有那一項的平台**：不提供（`docs/api/card-proof.md`）。

島民證明網站的網域是 target 的 `SITE_DOMAIN`（`src/platforms.ts` 從那裡拿）：`iamreal.tw`，測試網站的建置是 `test.iamreal.tw`（見「三種用真元件的建置」）。只用在完成畫面寫的連結 `iamreal.tw/p/<島民編號 10 個字元>`；頁面不連到它。

### 只有一個平台時

後台的平台表上裝置認得的平台只有一個、而且這張卡片在裝置不認得的平台上沒有帳號時（`src/ui/messages.ts` 的 `onePlatform`，看 `CardStatus.tablePlatforms` 和 `slots`），第 4 步的標題換成「你的 {平台名稱} 帳號」（頁面的 `<title>` 也是）、「填上你要宣告的帳號，……」換成「填上你要宣告的 {平台名稱} 帳號。」、「一張卡片在每個平台只能宣告一個帳號，……」換成「一張卡片只能宣告一個 {平台名稱} 帳號，……」，第 5 步「這些帳號會公開列在同一張島民證明上……」換成「這個 {平台名稱} 帳號會公開列在島民證明上。」、第一句換成「按下後，證明紀錄會公開記下這張卡片宣告的帳號：」、按鈕「宣告這份清單」換成「宣告這個帳號」（「再次過卡」「收回所有帳號」和清單變成空的時的第一句不變），第 6 步放連結的那一句換成「把下面的連結放在這個 {平台名稱} 帳號的個人檔案上。……」、證明紀錄記下的那一段的第一句換成「有一張有效的自然人憑證宣告了這個帳號：」、「越久沒過卡……」那一點換成「……建議每季回來過卡一次，更新這個帳號的日期。」。平台名稱是裝置自己那一份的（Threads），不是後台的 `display_name`。第 1 步還沒有平台表、也還不知道這張卡片的帳號，看的是建置認得幾個平台（`beforeView`，`src/target.ts` 的 `PRESENTATIONS`）：正式的建置只有 Threads，第一段寫「一張自然人憑證換一張島民證明，上面寫著這張卡片宣告的 Threads 帳號。」，「你宣告的帳號會公開列在……」不顯示；測試的建置和本機用真卡片的建置認得 `test-example` 和 `threads`，第 1 步照超過一個平台的寫法。

## 兩張清單和引擎的對應

讀取卡片（第 2 步）和進行中（第 5 步）逐項列出頁面正在做的事。引擎每做完一件事呼叫 `onProgress`（`src/flow.ts` 的 `Progress`），畫面把它對到清單的項目（`src/ui/messages.ts` 的 `READ_ITEMS`、`PROGRESS_ITEMS`）。事件只是回報，不改引擎檢查什麼、檢查的順序；流程停下之後不再有事件。

| 清單的項目 | 哪些事件都到了才算完成 | 引擎實際做的事 | 停在這裡的原因（`Stop`） |
|---|---|---|---|
| 連上內政部的元件 | `component` | 元件的視窗說準備好了（`hipki.ts`） | `card` `component_unreachable` |
| 找到讀卡機和卡片 | `certificates` | `GetUserCert` 回了憑證 | `card` `no_reader`、`no_card` |
| 讀取卡片上的憑證 | `certificates` | 同上 | `certificate` `no_certificate`；`card` `card_error`、`card_locked` |
| 檢查憑證 | `certificate` | `selectCertificate`：照電路的走法預先檢查、選出那一張 | `certificate` 的其他原因（含 `ambiguous_certificate`：兩張都通過） |
| 連上島民證明的伺服器 | `config`、`circuit`、`engine` | `GET /api/v1/config`（清冊可以多舊、平台表）；電路檔的 SHA-256；證明引擎啟動（含通用參數的 SHA-256） | `server`（讀設定時，含平台表讀不懂）、`artifact`、`engine` |
| 下載內政部的廢止清冊，確認憑證沒有被廢止 | `crl`、`tree` | 清冊下載並驗過；建樹，序號不在樹裡 | `revocation`、`revoked` |
| （進行中）連上島民證明的伺服器 | `challenge` | 要題目、檢查題目；憑證和清冊用當下的日期再檢查 | `challenge_not_today`、`challenge_malformed`、`server`（要題目時）、`certificate` `expired`、`revocation` `crl_stale` |
| 卡片簽章 | `signed` | 卡片簽宣告碼，用憑證驗過 | `card`、`card_signature` |
| 正在這台裝置計算，產生零知識證明，大約 10 到 30 秒 | `proved` | 算證明，公開輸入和裝置重建的相同 | `engine`、`proof_check` |
| 送出 | （完成的畫面） | `POST /api/v1/records` | `server` 的送出錯誤 |

讀卡之後，設定、電路檔、證明引擎、清冊、建樹同時進行，事件的先後不定；清單照上表的順序顯示：一項的事件都到了，而且它上面每一項都完成，才顯示「完成」；第一個還沒完成的那項顯示「進行中……」。停下來時：讀取卡片照上表把原因寫在對應的那一項下面（表上沒有的原因寫在第一個還沒完成的項目下）；進行中是依序做的，寫在第一個還沒完成的項目下面。停住的那項上面還沒完成的項目（例如清冊先出錯時，伺服器那一項還沒完成）不顯示狀態，下面的也不顯示。完成的項目前面是墨色的勾（`style.css` 畫的，不是圖示）；完成的畫面沒有勾。

## 預覽個人檔案

第 4 步每一列有帳號公開頁面的平台（現在是 Threads）有「預覽個人檔案」：那一列的帳號格式對的時候，用 `window.open(平台的帳號網址, "_blank", "noopener,noreferrer")` 在新分頁開平台上這個帳號的頁面（Threads 是 `https://www.threads.com/@帳號`）；格式不對時不開，在那一列下面顯示格式的提示。**這是這一頁唯一會帶人到別的網域的地方**：新分頁只拿到網址裡的帳號名稱，不帶任何過卡的資料（沒有開啟者：`noopener`；沒有 `Referer`：`noreferrer`；網址只有平台的帳號網址加上輸入的帳號）。過卡的頁面不嵌入、不 `fetch`、不載入平台的任何東西。CSP 不管 `window.open`，`Cross-Origin-Opener-Policy: same-origin-allow-popups` 允許頁面開新視窗，所以不用改任何標頭；`test/e2e/ui.ts` 在這兩個標頭之下點了預覽：頁面呼叫的正是 `window.open(平台的帳號網址, "_blank", "noopener,noreferrer")`、瀏覽器開出一個新分頁而且新分頁拿不到這一頁（`canAccessOpener` 是 `false`）、這一頁自己沒有對別處發請求、沒有違反 CSP；頁面呼叫的 `window.open` 只有元件的視窗和這一個。新分頁在無頭測試裡沒有開始載入（測試用 DevTools 把每個新分頁停住，`noopener` 的分頁即使是本機的網址也沒有放行，試過），所以「平台的頁面在新分頁裡打開」沒有在自動測試裡看到，要用有畫面的瀏覽器自己點一次看；測試的瀏覽器也不解析 localhost 以外的名稱，不會連出去。

## 流程

先確認卡片，再改這張卡片的帳號清單，最後才宣告（`design/copy/card-proof.md`）。一次過卡處理整份清單：什麼都不改是再次過卡，填上空白的是新宣告，改掉已有的是更換，清空是收回（ADR-0017）。沒有選平台的畫面。三次點擊，每次開一次元件的視窗。

| `card-proof.md` | 畫面 | 點擊 | 引擎（`src/flow.ts`） |
|---|---|---|---|
| 1. 開始之前 | 卡片和讀卡機準備好之後大約 3 分鐘；準備實體卡片、只收國民正卡；「一張自然人憑證換一張島民證明……」「你宣告的帳號會公開列在同一張島民證明上……」兩段和上面兩行一樣顯眼，不收進可以展開的問題；裝置認得的平台只有一個時（見「只有一個平台時」），第一段換成寫出那個平台名稱的那一句，第二段不顯示；只有「下一步」（第一個畫面沒有「上一步」，app 推出之前沒有選裝置的按鈕），下面是兩個可以展開的問題。5 分鐘到時回到這裡，最上面是那一句 | | |
| 2. 讀取卡片 | 六項的清單（見「兩張清單和引擎的對應」）；全部完成後「讀取卡片」換成「下一步」；停住時原因寫在那一項下面，「讀取卡片」換成「再讀一次卡片」（新的一次過卡）。不顯示姓名 | 讀取卡片（開視窗） | `readCard()`：讀憑證、預先檢查；開始不需要簽章的檢查（設定和平台表、清冊、建樹、電路檔、通用參數）；`checksDone()` |
| 3. 輸入 PIN | 「已讀到卡片」、姓名、「（姓名只顯示在這裡，不會送出。）」；PIN 欄位，下面是三件事；按下後「卡片簽章中，接著查……」，到這一步結束（換到第 4 步，或停下、可以再試）之前，PIN 欄位、按鈕和「上一步」都不能用（「上一步」會開新的一次過卡，卡片還在簽章時開出第二個視窗）。PIN 錯、視窗被擋可以在同一步再試；其他停住（鎖卡、讀卡錯誤、伺服器、現況讀不懂）原因寫在 PIN 欄位下面，「確認卡片」不能再按，「上一步」回到讀取卡片 | 確認卡片（開視窗） | `confirmCard(pin)`：卡片簽場合字串、算匿名編號、查現況；這張卡片的清單、每一列的次數、還可以更換幾次（紀錄規則的 5 次）、今天改掉算不算更換、今天是不是已經有 3 筆有效紀錄（`CardStatus`）。「上一步」：`cancel()`，回到第 2 步，重新讀一次（新的流程物件，PIN 欄位清空） |
| 4. 你的帳號 | 上方一或兩行（還沒宣告過；目前宣告的和上次過卡；全部收回過）；平台表上每個平台一列（顯示名稱、帳號欄位、有公開頁面的平台有「預覽個人檔案」），下面是那一列現在的次數和能不能改；裝置不認得的平台上有帳號時，多一列不能修改的（平台代號和帳號原樣）；清單下面講怎麼改、一張卡終身最多更換 5 次、預覽；「下一步」；系統無法確認帳號是誰的，過卡完成後會建議帳號主人把連結放在個人檔案上（只有一個平台時寫出平台名稱）；「取消」。沒有「還有平台沒填」這類提示。格式不對寫在那一列下面；清單是空的而這張卡片沒有帳號時「請至少填一個帳號。」。今天已經過卡 3 次時，清單照樣顯示但不能改、每一列下面的那一行不顯示，下面是「這張卡片今天已經過卡 3 次，明天才能再過卡。」和「回到開頭」（和「取消」一樣丟掉 PIN）。「取消」回到第 1 步 | 不碰卡片 | `choose(每個平台輸入的帳號)`：建清單（裝置不認得的平台上的帳號原樣放回去、照平台代號的位元組順序），算出每個平台會發生什麼（`Consequence`）。帳號格式不對、被擋下的更換（規則的 5 次）、空清單、今天 3 筆，引擎自己拒絕（`FlowStop`，流程不結束） |
| 5. 確認 | 證明紀錄會公開記下的那一句；要簽的整份清單，每一列寫平台名稱和平台代號、帳號、會發生什麼（不變、新宣告、再次宣告不算更換、更換原本是誰、收回），更換時接用掉幾次或不算一次；會被收回的帳號也列出來；日期、島民編號開頭；有收回時「收回之後，證明紀錄裡原本的紀錄還在……」；清單不是空的時「這些帳號會公開列在同一張島民證明上……」（只有一個平台時「這個 Threads 帳號會公開列在島民證明上。」），在按鈕上方；兩點；「上一步」回到第 4 步（輸入的照樣留著）；「取消」 | 再次過卡／宣告這份清單（只有一個平台時「宣告這個帳號」）／收回所有帳號（開視窗） | `back()` 回到現況，不重新簽章、不重新查；`proceed(清單)`：用當下的日期再算一次、和畫面說的相同才往下；要題目、檢查、卡片簽宣告碼、丟掉 PIN、算證明、送出 |
| 5. 進行中 | 四項的清單；計算那一項寫它產生零知識證明、大約多久，清單下面沒有別的句子。停住時原因寫在那一項下面，下面是「回到上一步」（PIN 還在時）或「再讀一次卡片」（PIN 已經丟掉時），送不出去時多一個「再試一次」（只重做送出）。確認之後日期換了一天、這份清單在新的一天結果不同（例如更正變成更換）時，停在「連上島民證明的伺服器」，「日期換了一天，……請回到開頭重新過卡。」，按鈕只有「回到開頭」 | | `proceed()` 在要題目之前、拿到題目確認日期之後，各用當下的日期再算一次每一列會發生什麼，和畫面說的不同就停（`date_changed`），卡片不簽；`resubmit()`：送不出去時原封不動再送；再送得到 `challenge_used` 時查一次現況（見下面） |
| 6. 完成 | 後台記下的和第 5 步說的不同時，最上面「證明紀錄記下的，和你確認時畫面說的不同。……」；記號的動畫（`prefers-reduced-motion` 時不動）、標題（依這次的結果）、島民證明（這次之後的清單、日期、島民編號、手寫的兩行）、「接下來：把它掛出來」、放連結的那一句（只有一個平台時寫出那個平台的名稱）、連結和「複製連結」、第一筆紀錄時換卡的提醒、有收回時連結可以拿掉、「打開這張島民證明」、證明紀錄記下的那一筆（每個平台這次發生的事）、別的卡片也宣告了同一個帳號、三點（過卡頻率的建議、改了帳號名稱要回來更換、怎麼驗證島民證明）、「現在可以拔出卡片。」、「回到開頭」。清單變成空的時沒有動畫、島民證明、連結那一段、過卡頻率的建議和改名稱的那一點 | | 回應的 `kinds` 和第 5 步說的逐個平台比（`Done.mismatches`） |

第 4、5 步之間可以來回。從第一次簽章完成起 5 分鐘（`IDLE_MS`）內沒有完成第二次簽章，引擎丟掉 PIN、憑證和簽章，流程停下（`idle`），畫面回到第 1 步、顯示「超過 5 分鐘沒有完成，……請再讀一次卡片。」。這在兩次簽章之間的每一步都成立，包括等後台回答現況、等題目的時候：伺服器不回答，也拖不過這 5 分鐘。第 4、5 步的「取消」、第 4 步滿 3 筆時的「回到開頭」、第 6 步的「回到開頭」都回到第 1 步：`cancel()` 丟掉 PIN、憑證和簽章（流程物件手上的那一份清成 0，見「已知的限制」）、停掉 5 分鐘的計時器，不顯示任何句子。`cancel()`、5 分鐘到了、任何停下之後，還在等待中的那一步（等卡片、等後台、等算證明）等到之後什麼都不寫回流程物件、不再發任何請求：每一步在每個 `await` 之後都先看流程是不是已經停了。一步還在進行中又被呼叫一次（`readCard`、`confirmCard` 在進行中時不離開自己的階段），和在不對的階段呼叫一樣丟出 `state`：不碰卡片、不發請求，進行中的那一次照常走完。5 分鐘的計時器最多一個：開始前先取消舊的。之後再按「讀取卡片」是新的一次過卡，用進頁面時啟動的同一個證明引擎（ADR-0013），不重新整理頁面。

**進行中停住之後的按鈕**（`src/ui/messages.ts` 的 `progressButtons`，看引擎停住後的 `phase`）：PIN 還在引擎裡的時候（`chosen`：第二次簽章的視窗被瀏覽器擋下，什麼都沒送到卡片），按鈕是「回到上一步」，回到第 5 步，同一個按鈕再按一次。其他停住時引擎都已經丟掉 PIN（流程結束；或者第二次簽章已經完成，PIN 在那時就丟了，送不出去、題目過期 `challenge_unknown` 都是這種），按鈕是「再讀一次卡片」：回到第 2 步，在同一次點擊裡重新讀卡（新的一次過卡，要重新輸入 PIN）。送不出去時多一個「再試一次」，只重做送出。按下最後一個按鈕時視窗就被擋，畫面不會到進行中，停在第 5 步、顯示被擋的那一句；橋接在進行中才回報被擋（`popup_blocked`）的情況，從畫面上走不到（點擊時開得出視窗，送請求時就一定有那個視窗）。

**送出逾時、其實後台收下了**：第一次送出沒有回答（逾時、連線中斷），後台可能已經寫入。按「再試一次」原封不動再送，後台回 `challenge_used`（這個題目已經有一筆被接受，題目只有這次過卡有）時，引擎再查一次這張卡片的現況（`POST /api/v1/card-state`，帶的匿名編號就是送出的那筆紀錄裡的）：這張卡片現在的清單（裝置認得的每個平台的 `current`，加上原樣保留的帳號）就是送出的那份清單，而且 `last_card_proof` 是這筆紀錄的日期（題目的日期），就當成完成，到第 6 步。這時沒有 `seq`，也不知道後台在每個平台記成什麼（`kinds`）：標題是「證明紀錄已經記下這次過卡」，證明紀錄記下的那一段只有日期和「這一頁讀不出伺服器回報每個帳號記成什麼。……」，島民證明列的是送出的清單。不相符時停在「這次過卡沒有被接受（代碼 challenge_used）」；這時現況讀不懂或沒有回答，停在那個原因（「伺服器的回應不正確……」），不說證明紀錄沒有變動。只在 `resubmit()` 之後這樣做：第一次送出就得到 `challenge_used` 照舊停下。

**完成畫面**：連結固定是這張卡片的島民證明的網址，`iamreal.tw/p/` 加 10 個字元的島民編號，所有平台用同一個，不看回應。「複製連結」把 `https://` 開頭的完整網址寫進剪貼簿（`navigator.clipboard.writeText`），成功後按鈕寫「已複製」。島民證明上列的是送出的清單（卡片簽的就是它，後台改不了）；「證明紀錄記下了這一筆」那一段列的是回應的 `kinds`：每個平台一列，句子和第 5 步每一列的第一句相同（`refresh` 依簽之前那一列有沒有帳號，寫「不變」或「再次宣告，不算更換」），被收回的帳號也列在那裡。回應的每一項有 `account_cards`（套用這筆之後宣告這個帳號的卡片數）：清單上的帳號大於 1 時，那一段下面多一句「還有別的卡片也宣告了 @alice。……」；某一項的 `account_cards` 沒有、或不是非負整數時，只當成那個帳號的數字不知道，不寫那一句。`kinds` 讀不懂（不是非空的清單、某一項讀不懂、種類不認得、沒有照平台的順序）時，紀錄已經在證明紀錄裡了：標題是「證明紀錄已經記下這次過卡」，證明紀錄記下的那一段只有日期和「這一頁讀不出伺服器回報每個帳號記成什麼。……」（`seq`、`record_hash` 照舊嚴格讀）。

**送出後比對**（`Done.mismatches`）：引擎把回應的 `kinds` 和第 5 步說的（`Consequence.rows`）逐個平台比，種類不同、帳號不同、或一邊有那個平台另一邊沒有，都算不同。後台謊報現況（例如把 `correction_date` 說成今天，畫面就說這次改掉不算更換）時，證明紀錄記下的是更換，次數不會恢復（漏洞 M9）。完成畫面最上面（標題之前）是「證明紀錄記下的，和你確認時畫面說的不同。請看下面標出來的地方。」；不同的那一列寫後台記下的種類，下面是「確認時畫面說的是：」接第 5 步那一列的句子（第 5 步沒有這個平台時是「沒有這個平台」），後台記成更換而第 5 步說的不是更換時再加「這次用掉了一次更換。」，最後是代碼 `kind_mismatch`。

**後台回 `201` 但內容讀不懂**（不是 JSON 物件、`seq` 或 `record_hash` 讀不懂）：`201` 表示紀錄已經在證明紀錄裡，所以不是「現在不能過卡」，是完成：標題「證明紀錄已經記下這次過卡」，證明紀錄記下的那一段只有日期和「這一頁讀不出伺服器回報每個帳號記成什麼。……」。

## PIN 經過哪些程式

1. 第 3 步（輸入 PIN）的欄位（`src/ui/app.ts` 的 `pin`）：`type="password"`、`autocomplete="off"`、沒有 `name`、不在 `<form>` 裡。按「確認卡片」時讀一次欄位的值，**欄位立刻清空**，值只交給 `flow.confirmCard(pin)`。欄位是空的時候按鈕不能按，所以不會送出沒有 PIN 的請求。按下之後到這一步結束，欄位和按鈕都不能用，所以卡片不會因為再輸入、再按一次而多簽一次。
2. 引擎（`src/flow.ts`）：第一次簽章成功後存在記憶體裡（PIN 錯、視窗被擋時不留），到第二次簽章完成、流程停下、持卡人按「取消」、或第一次簽章後 5 分鐘（`IDLE_MS`）為止，交給卡片兩次。5 分鐘由計時器（`setTimeout`）觸發，在兩次簽章之間的每一步都會動作，包括等後台回答現況和題目的時候；分頁在背景、電腦睡眠時瀏覽器可能把計時器延後（延多久沒有量），所以 `choose`、`back`、`proceed` 也各自先看時鐘，`proceed` 在拿到題目之後、讓卡片簽第二次之前再看一次，過了就不用它、直接停下。PIN 交給元件做第二次簽章之後，計時器就不再動作：這時 PIN 已經在送往卡片的請求裡，那一步由橋接自己的上限結束（視窗 8 秒內沒準備好、送出後 30 秒沒有回應），結束時引擎丟掉 PIN。持卡人在第 4、5 步來回、改清單、看後果的這段時間，PIN 一直在這裡。
3. 橋接（`src/card/hipki.ts` 的 `sign`）：放進一個請求字串，用 `postMessage` 送到元件的來源（`targetOrigin` 寫死），然後丟掉；這個物件沒有任何欄位存它。PIN 是空的、或含 `+`、`%`、可見的 ASCII 以外的字元時不送（見下面）；後兩種畫面在 PIN 欄位下面顯示「這一頁不支援含有 +、% 或非英數符號的 PIN。……」，流程結束，「上一步」回到讀取卡片。
4. 元件的視窗，再到卡片。

沒有任何儲存空間、網址、紀錄、全域變數、DOM 的屬性存過它：`test/e2e/ui.ts` 在每次用過 PIN 之後，檢查欄位、整份 HTML、網址、`localStorage`、`sessionStorage`、`window` 上的每個值都沒有它。JavaScript 的字串不能清成 0，做得到的是不再持有它的參照。

PIN 錯（元件回 `ret_code` `0x76100006`、`last_error` `0xA0`）時，畫面顯示「PIN 不正確。……」、欄位是空的，持卡人重新輸入、再按一次才會再送；任何不成功的回應都不會自己重送。按「確認卡片」時視窗被擋，PIN 照樣在按下時從欄位清掉、沒有交給引擎：允許視窗之後重新輸入、再按一次。按最後一個按鈕時視窗被擋，PIN 留在引擎裡（本來就在兩次簽章之間），5 分鐘的上限照算。

## 元件的橋接信任什麼

`src/card/hipki.ts`。元件沒有 CORS 標頭，頁面不能用 `fetch` 呼叫它；它提供一頁 `/popupForm`，頁面用 `window.open` 開成視窗，視窗準備好時對開它的頁面送 `{"func":"getTbs"}`，頁面送一個請求，視窗做完把回應送回來、自己關掉。照 PSE 範例（`hipki-popup.ts`、`hipki-client.ts`）和 `web-isolation-bench` 量測頁的做法自己寫，沒有複製。

- **網址寫死**：`http://localhost:61161`（`src/target.ts`），不從伺服器的回應或網址參數來。測試的建置換成假元件的網址；`test/build.test.ts` 檢查正式的建置只有這個網址、沒有任何測試的東西。
- **只收元件來源的訊息**：`MessageEvent.origin` 不是 `http://localhost:61161`、或內容不是字串的訊息一律忽略（例如擴充功能送進來的）。送出時 `targetOrigin` 也寫死，視窗被導到別的網址就收不到請求（包括 PIN）。
- **一次點擊一個視窗**：瀏覽器一次點擊只讓開一個視窗。畫面在點擊的處理程式裡、還沒有任何 `await` 之前呼叫 `open()`，接下來的讀憑證或簽章用這個視窗；沒用到就關掉（例如題目的日期不對，第二次簽章前就停了）。**關了之後再看一次**：Chrome 有時關不掉剛開出來幾毫秒的視窗（第一個頁面還在另一個行程裡載入；這一頁有 `Document-Isolation-Policy`，元件的視窗一定在別的行程），`closed` 先變成 `true`、又變回 `false`，視窗留在畫面上。所以每次關視窗之後，100、300、1000 毫秒各再看一次，還開著就再關（`CLOSE_AGAIN_MS`；`test/hipki.test.ts` 用第一次關不掉的假視窗測）。
- **每個視窗一個新的名稱**：`window.open` 的視窗名稱是 `iamreal-` 加 128 位元的亂數，每次不同。名稱固定的話，用 `window.open` 開了這一頁的別的網站，可以用同一個名稱把元件的視窗導到別處（2026-11-16 在 Chrome 157 實測過）。上一個視窗關了才開下一個：請求結束時視窗就關，`open()` 也先關掉沒用到的那一個。頁面的 `Cross-Origin-Opener-Policy` 另外切斷開啟者和這一頁的關係（見「頁面需要的標頭」）。
- **視窗被擋時什麼都不送**：`open()` 回傳視窗有沒有開成。沒開成時畫面顯示「瀏覽器擋下了內政部元件的視窗。……」，不叫引擎往下做，同一個按鈕允許之後再按一次就繼續；流程不結束。萬一引擎還是叫了卡片，橋接回 `popup_blocked`，請求沒有離開頁面，引擎也當成可以重試的同一步。
- **回應嚴格讀**：憑證只交給引擎自己檢查；簽章的回應附的憑證（`certb64`）交給引擎，和讀卡時選出的那一張不同就停（`card_error`、代碼 `certificate_mismatch`）。回應沒有附憑證也停（`no_certificate_in_reply`）。
- **只送簽得對的內容**：要簽的字是 31 個 `[A-Za-z0-9:_.-]` 的字元（場合字串和宣告碼都是），以文字送出（2026-11-11 實測元件簽的是文字的位元組）。PIN 含 `+` 或 `%` 時不送：中華電信的程式庫送出前把 `+` 改寫成 `%2B`，看起來元件會像網址一樣解碼請求，這種 PIN 可能變成別的字送到卡片、用掉一次錯誤次數。

| 情況 | 引擎的停止原因 | 怎麼得知 |
|---|---|---|
| 視窗被擋（`window.open` 回 `null` 或丟出例外） | `card` `popup_blocked`（流程不結束，同一步再按一次） | 程式的行為；`test/e2e/ui.ts` 用沒有使用者動作的點擊讓無頭 Chrome 真的擋下 |
| 視窗 8 秒內沒有說準備好（元件沒裝、沒啟動） | `card` `component_unreachable` | 實測（`ui.ts` 的假元件）；真元件沒啟動時的樣子沒有實測 |
| 準備好之後 30 秒沒有回應 | `card` `card_error`，代碼 `timeout` | 程式的行為 |
| 視窗被持卡人關掉 | 還沒準備好：`component_unreachable`；準備好之後：`card_error`，代碼 `popup_closed` | 程式的行為 |
| `GetUserCert` 列出讀卡機、但沒有任何一台有卡片，或 `ret_code` 是 `0x76000006`（未插入IC卡） | `card` `no_card` | 讀程式（中華電信的程式庫、PSE 範例、量測頁）；沒有實測 |
| `GetUserCert` 一台讀卡機都沒列出（`slots` 是空的），或 `ret_code` 是 `0x76100003`（無可用讀卡機） | `card` `no_reader` | 讀程式；沒有實測（這台電腦沒有讀卡機時元件回什麼，沒有看過） |
| `MakeSignature` 回 `0x76100006`（IC卡登入失敗）且 `last_error` 是 `0xA0`（PIN碼錯誤）、`0xA2`（PIN碼長度錯誤）、`0x80000001`／`0x80000002`（還剩一或兩次） | `card` `pin_incorrect` | 讀程式；**沒有實測**（沒有用錯的 PIN 試） |
| `0x76100006` 且 `last_error` 是 `0xA4`（已鎖卡） | `card` `card_locked` | 讀程式；沒有實測 |
| `0x76100006` 但 `last_error` 是 0（程式庫的註解：可能是鎖卡等） | `card_error`，代碼 `76100006`，不猜 | 讀程式 |
| 其他非 0 的 `ret_code`（例如 `0x7600000F` 禁止存取的網域） | `card_error`，代碼是十六進位的 `ret_code`（和 `last_error`） | 讀程式 |

## 每個值從哪裡來、送到哪裡去

| 值 | 從哪裡來 | 送到哪裡 |
|---|---|---|
| 憑證（含姓名、序號、公鑰） | 卡片（`Card.readCertificates`，不用 PIN） | 不送出。姓名只回給呼叫的程式顯示；序號只進建樹的 worker；整張憑證只進證明的私有輸入。沒被選上的那張（加密用，同樣有姓名）選完就清成 0；元件每次簽章附回來的副本比對完就清成 0；流程物件手上的那一份在送出後、取消、流程停下時清成 0。其他副本見「已知的限制」 |
| PIN | 呼叫的程式（`confirmCard(pin)`） | 只交給卡片。存在記憶體裡到第二次簽章完成、流程停下、或第一次簽章後 5 分鐘為止。JavaScript 的字串不能清成 0，做得到的是不再持有它的參照 |
| 卡片的兩個簽章 | 卡片（`Card.sign`） | 只進證明的私有輸入。場合字串的簽章在裝置上算成匿名編號。流程物件手上的那一份在送出後、取消、流程停下時清成 0；交給電路的輸入在算完證明後覆寫掉（見「已知的限制」） |
| 帳號清單 | 這張卡片的現況（`card-state`），持卡人在第 4 步改；裝置不認得的平台上的帳號原樣保留 | 宣告碼、紀錄（送出時）；按「預覽個人檔案」時，只有那一列的帳號放進平台帳號頁面的網址，在新分頁開（見「預覽個人檔案」） |
| 平台表（有哪些平台、帳號名稱的格式） | 後台（`GET /api/v1/config`） | 只用來決定提供哪些平台和檢查輸入的帳號；不決定場合字串；顯示名稱不用 |
| 匿名編號 | 裝置自己算（`protocol/src/scoped-id.ts`） | `POST /api/v1/card-state` 的內容（不放網址）；紀錄 |
| 場合字串 | 寫死的公開的證明紀錄的那一個（`protocol/src/scope.ts`，哪一份證明紀錄由建置決定：`src/target.ts` 的 `PROOF_LOG`） | 卡片簽；紀錄 |
| `current_time` | 裝置的時鐘，絕對時間換成 UTC+8 的日期（`protocol/src/date.ts`），不用裝置設定的時區 | 證明的公開輸入 |
| 失敗的原因 | 裝置自己的檢查 | 只回給呼叫的程式（`FlowStop`）。沒有任何請求帶著它，也不寫進任何紀錄（`test/flow.test.ts` 每一個失敗的測試都檢查） |

## 從伺服器拿到的值，裝置怎麼檢查（ADR-0016 落到程式上）

| 值 | 從哪裡拿 | 裝置怎麼檢查 | 程式 |
|---|---|---|---|
| 題目 | `POST /api/v1/challenges` | 整個字串符合唯一寫法（格式、字母表、最後一個字的補位是 0、日期存在、年份 2000 到 2049）；日期是裝置時鐘的台灣今天，否則停下，卡片不簽第二次。`current_time` 用裝置自己的日期 | `protocol/src/challenge.ts`、`src/flow.ts` 的 `proceed` |
| 清冊可以多舊 `crl_max_age_days` | `GET /api/v1/config` | 非負整數；`L` = 它和內建的 7 取小（伺服器回 365 也只用 7）；讀不懂就停 | `src/api.ts` 的 `requestConfig`、`src/crl/revocation.ts` 的 `crlMaxAge` |
| 存檔索引 | 資料網域的 `/crl/index.jsonl` | 只用來找檔案：自己那把發證金鑰、可用、`crl_number` 最高的那一行的 `sha256`。樹根、日期等其他欄位都不讀。編號最高的有兩個不同檔案時停下 | `src/crl/revocation.ts` 的 `chooseFromIndex` |
| 廢止清冊 | 資料網域的 `/crl/<SHA-256>.crl` | 檔案的 SHA-256 等於檔名；嚴格的 DER；用寫死的發證金鑰（WebCrypto）驗內政部的章；「Which CRLs」的每一條，原因代碼和順序和 `crl/` 相同；編號不低於這台裝置記住的最高編號；台灣今天減清冊日期不超過 `L` 天；樹自己建 | `src/crl/crl.ts`、`src/crl/revocation.ts`、`src/crl/tree.ts` |
| 平台表 | `GET /api/v1/config` 的 `platforms` | 是清單；寫了平台代號的每一項要照代號嚴格遞增（重複就是兩個答案，整張表讀不懂）；一列要讀得懂：平台代號 1 到 21 個 `a-z0-9-`、顯示名稱是 1 到 100 個字元且沒有控制字元、格式是 `[…]{m,n}` 那一種寫法（自己逐字解析：類別裡 `x-y` 是範圍、其他字元照字面；含 `"`、`\`、控制字元、空白、非 ASCII、`[`、開頭的 `^` 的類別不讀；`1 ≤ m ≤ n`、不帶前導零）。讀不懂的一列是裝置不認得的平台；一列都讀不懂就停（`malformed_response`），在第一次簽章之前。**不從這張表拿場合字串，也不顯示它的 `display_name`**：平台的名稱寫死在裝置上（漏洞 M10 的「給錯的顯示名稱」因此不成立；第 5 步仍在名稱旁邊寫出平台代號）。裝置沒有自己那一份的平台，即使這一列讀得懂，也是裝置不認得的平台 | `src/api.ts` 的 `requestConfig`、`protocol/src/username-format.ts` |
| 這張卡片的現況 | `POST /api/v1/card-state` | 格式：`last_card_proof`（日期或 null）、`proofs_on_last_date`（整數）、`platforms`（物件）、`count`；平台表上每個有一項的平台，那一項要讀得懂：`current`、`last_declared` 是 null 或合那個平台的格式，`switch_count` 是 0 到 5 的整數，`correction_date` 是日期或 null。裝置不認得的平台那一項：`current` 是 null 就忽略；有帳號就原樣保留，但平台代號和帳號要過最低限度的檢查；那一項不是物件、沒有 `current` 都當成讀不懂。紀錄規則產生不出來的組合當成讀不懂的回應（`malformed_response`）：有 `current` 而 `last_declared` 不同；`last_declared` 和 `correction_date` 只有一個有值；沒有帳號卻有更換次數；有帳號而沒有 `last_card_proof`；`correction_date` 晚於 `last_card_proof`；任何日期晚於今天加 3 天（`spec/record-rules.md`「How far dates are trusted」）；`proofs_on_last_date` 沒有 `last_card_proof` 時不是 0、有的時候不在 1 到 3 之間（`protocol/src/record-rules.ts` 的 `possibleSlot`、`possibleCard`）。每個平台會是哪一種（`first`、`refresh`、`correction`、`switch`、`withdraw`，或擋下）、還可以更換幾次（規則是 5 減掉次數）、今天改掉算不算更換（`correction_date` 是不是裝置自己的台灣今天）、今天是不是已經有 3 筆（`last_card_proof` 是今天而且 `proofs_on_last_date` 是 3），由裝置從這些事實和今天的日期自己算。一張卡片的日期不往回（`spec/record-rules.md` 檢查 4）：`last_card_proof` 早於今天時，今天是 0 筆；晚於今天時，日期是今天的紀錄是 `date_order`，裝置不先擋，由後台的規則決定（送出時回 `date_order`）：裝置呼叫的是紀錄規則的後半段 `applyList`（檢查 5、6 和之後的狀態，`applyRecord` 自己也呼叫它），不算檢查 1 到 4。不能做的清單引擎在 `choose` 拒絕，`proceed` 簽之前用當下的日期再算一次，和畫面說的不同就停。事實本身沒辦法檢查，見「已知的限制」 | `src/api.ts` 的 `requestCardState`、`protocol/src/record-rules.ts`、`src/flow.ts` 的 `confirmCard`、`consequenceOf`、`proceed` |
| 清單裡沒有輸入的帳號 | 上一列（現在宣告的、原樣保留的） | 持卡人什麼都不改時，清單裡的帳號由伺服器的回答決定；清空一列時，被收回的帳號也是。伺服器謊報認不出持卡人（它已經知道這個匿名編號），只能讓清單少了帳號或多了帳號：第 5 步列出整份要簽的清單和每一列會發生什麼，**包含會被收回的**（漏洞 L2），持卡人看得到；`proceed(清單)` 要呼叫的程式傳回畫面上顯示、持卡人確認過的清單，和引擎算的不同就停，卡片不簽第二次 | `src/flow.ts` 的 `consequenceOf`、`proceed` |
| 什麼時候向後台查現況 | （裝置決定） | 不需要簽章就能做的檢查全部通過之後，卡片才簽第一次、裝置才帶著匿名編號查現況：憑證的預先檢查、清冊下載並驗過、樹建完、序號不在樹裡、電路檔和通用參數的雜湊對。否則後台會看到「這個匿名編號查過現況、之後沒有下文」，能和它的鏡像給的清冊對起來（ADR-0015、ADR-0016）。檢查還沒完成時 `phase` 是 `checking`，畫面不顯示 PIN 欄位；`checksDone()` 通過後是 `ready_for_pin`。`confirmCard` 自己也先等這些檢查 | `src/flow.ts` 的 `startBackground`、`checksDone`、`confirmCard` |
| 電路 | `/proof/circuits/card_proof_rs2048.json`、`card_proof_rs4096.json` | SHA-256 寫死（`circuits/README.md`）；不同就停，在卡片簽章之前 | `src/prover/artifacts.ts` |
| 通用參數 | `/proof/crs/bn254_g1_compressed_2p18.dat`、`/proof/crs/bn254_g2.dat` | SHA-256 寫死；核對過才交給 bb.js | `src/prover/artifacts.ts`、`src/prover/engine.ts` |
| 送出的結果 | `POST /api/v1/records` | 狀態碼 `201` 就是記下了：`seq`、`record_hash` 讀不懂、或內容根本不是 JSON 物件，當成「記下了、讀不出每個平台記成什麼」；`kinds` 讀不懂也一樣；讀得懂就和第 5 步說的逐個平台比（「送出後比對」）；只顯示 | `src/api.ts` 的 `submitRecord`、`src/flow.ts` 的 `done` |
| 什麼時候回答 | 每個請求 | 每個請求有時間上限，連回應的內容一起算；到了就中斷請求，當成沒有回應（`network`），和連不上走同一條路。設定、現況、題目、送出 30 秒（`API_TIMEOUT_MS`：都是小的 JSON，後台從記憶體回答或驗一份證明）；清冊的索引和清冊、電路檔、通用參數 5 分鐘（`FILE_TIMEOUT_MS`：讀卡時一起下載的 G2 清冊 16.9 MB、通用參數 8 MiB、電路檔 0.8 MB 約 26 MB，5 分鐘容得下約 0.7 Mbit/s；都在第一次簽章之前，沒有任何祕密在等它們）。兩次簽章之間的 5 分鐘不靠這些上限，見「PIN 經過哪些程式」 | `src/api.ts` 的 `withTimeout` |
| 錯誤代碼 | 每個介面 | 只收 `[a-z_]{1,40}`，其他寫成 `http_狀態碼`；只回給呼叫的程式。送出時，沒有回應、`429`、`crl_stale` 以外的 5xx（`internal`）可以用 `resubmit()` 原封不動再送；其他代碼（包括 `503` `crl_stale`）結束流程 | `src/api.ts`、`src/flow.ts` 的 `submit` |

**寫死在頁面裡的**：場合字串（`protocol/src/scope.ts`）和建置用的證明紀錄（`src/target.ts` 的 `PROOF_LOG`：正式的建置是 `production`，測試的建置、測試網站的建置、本機用真卡片的建置是 `test`）、每個平台的名稱和寫法（`src/presentations/`，建置決定有哪幾份）、G2 和 G3 的發證金鑰（`src/issuers.ts`，和 `spec/vectors/issuers.json`、`crl/` 的憑證檔比對過）、資料網域（`src/target.ts` 的 `DATA_ORIGIN`）、電路和通用參數的 SHA-256、內建的 7 天、證明的設定（零知識、`noir-recursive`，`src/prover/prover.ts`）、證明的執行緒上限。

**頁面本身**（HTML、JavaScript、bb.js 和 Noir 的 WebAssembly）和 API 從同一台伺服器來。只有電路檔和通用參數有寫死的 SHA-256；頁面的指令碼（`index.html` 的 `<script>` 沒有 `integrity`）、bb.js 的 WebAssembly（`/proof/bb/barretenberg*.wasm.gz`，bb.js 自己用網址抓）、Noir 的兩個 WebAssembly（`/proof/assets/acvm_js_bg-*.wasm`、`/proof/assets/noirc_abi_wasm_bg-*.wasm`）都**沒有核對雜湊**。頁面和這些檔案由同一個來源提供時，這不多一個對手：能換掉 WebAssembly 的人也能換掉頁面本身，ADR-0016 的「代價」寫明了這個前提（用的頁面就是公開的這一份）。**頁面和靜態檔分開放時要補**（部署時要做的事）：放靜態檔的那一邊換掉 WebAssembly，就看得到證明的全部私有輸入，而換電路檔反而會被擋下。

## 停止的原因

流程停下來時丟出 `FlowStop`，`stop` 是下表的一種（`src/flow.ts` 的 `Stop`）。畫面照 `src/ui/messages.ts` 顯示 `design/copy/card-proof.md` 的一句話；「代碼」是那句話裡的 `X`。後台的錯誤另外在那句話的下一行顯示「回報問題時請附上這個編號：」和回應標頭 `X-Request-Id` 的值（持卡人回報問題時說得出是哪一次）。這些原因都只給呼叫的程式，不送給伺服器。`flow.stop` 是 `null` 的（PIN 錯、視窗被擋、選了不能做的事或格式不對的帳號、送出時的暫時失敗）可以重試同一步，其他的結束這次流程；讀取卡片（第 2 步）停下時，原因寫在停住的那一項下面，「讀取卡片」換成「再讀一次卡片」，按下去是新的一次過卡（讀卡不用 PIN）；輸入 PIN（第 3 步）停下時，原因寫在 PIN 欄位下面，「上一步」回到讀取卡片；進行中（第 5 步）停下時，原因寫在停住的那一項下面（見「流程」）。下表最後一欄是 `card-proof.md` 的第幾步、哪一列；寫在清單的哪一項下面見「兩張清單和引擎的對應」。

| `code` | 細項 | 什麼情況 | `design/copy/card-proof.md` 的哪一列 |
|---|---|---|---|
| `card` | `component_unreachable` | 連不上內政部的元件 | 2.「連不上元件」，附「過卡需要什麼」 |
| `card` | `no_reader` | 元件找不到讀卡機 | 2.「找不到讀卡機」 |
| `card` | `no_card` | 讀卡機裡沒有卡片 | 2.「沒有卡片」 |
| `card` | `pin_incorrect` | PIN 錯（可以重試） | 3.「PIN 不正確」 |
| `card` | `popup_blocked` | 瀏覽器擋了元件的視窗（可以重試；什麼都沒送） | 「每一步都有的」：「瀏覽器擋下了元件的視窗」 |
| `card` | `card_locked` | 卡片鎖住了 | 2.「卡片鎖住了」 |
| `card` | `card_error`（附代碼，見上面橋接的表） | 卡片或元件回了其他錯誤 | 2.「讀卡或簽章時的其他錯誤」 |
| `card` | `card_error`，代碼 `pin_characters` | PIN 含 `+`、`%` 或可見的 ASCII 以外的字元，橋接不送 | 3.「PIN 含有 +、% 或英數符號以外的字元」 |
| `certificate` | `no_certificate` | 卡片沒有回任何憑證 | 2.「卡片上讀不到憑證」 |
| `certificate` | `expired`（附 `notAfter`，台灣日期） | 憑證在今天之前到期。讀卡時檢查；`proceed` 在要題目之前、讓卡片簽第二次之前用當下的日期再檢查一次（過卡跨過午夜、憑證效期的最後一天） | 2.「憑證過期」 |
| `certificate` | `not_yet_valid`（附 `notBefore`，台灣日期） | 憑證還沒生效 | 2.「憑證還沒生效」 |
| `certificate` | `not_citizen_primary` | 憑證政策或主體目錄屬性不是國民正卡的（外來人口、附卡、行動自然人憑證、政策不同） | 2.「不是國民的正卡」 |
| `certificate` | `unsupported_format` | 電路的走法在其他地方不過 | 2.「憑證的格式電路不接受」 |
| `certificate` | `unknown_issuer` | 不是 G2、G3 簽發的 | 2.「憑證不是內政部簽發的」 |
| `certificate` | `ambiguous_certificate` | 卡片上有兩張不同的憑證都通過（兩台讀卡機各插一張卡也是） | 2.「讀到兩張都通過檢查的憑證」 |
| `revocation` | `crl_stale`（附天數、`L`） | 清冊比 `L` 天舊。和憑證的效期一樣，`proceed` 用當下的日期再檢查一次 | 2.「廢止清冊太舊」 |
| `revocation` | `crl_unavailable`、`crl_hash`、`crl_unusable` | 索引或清冊拿不到；索引沒有可用的行；編號最高的有兩個不同檔案；清冊的 SHA-256 不是檔名；清冊不可用 | 2.「拿不到可用的廢止清冊」，代碼是這三個之一 |
| `revocation` | `crl_rollback` | 清冊編號比這台裝置用過的低 | 2.「拿到的廢止清冊比這台電腦上次用過的舊」 |
| `revoked` | | 序號在清冊上（廢止或暫時停用） | 2.「在廢止清冊上」 |
| `artifact` | 檔案路徑 | 電路檔或通用參數拿不到，或 SHA-256 不對 | 2.「電路檔或參數檔下載失敗，或內容和預期的不同」 |
| `engine` | | 證明引擎無法啟動（讀卡時）或算不出證明 | 2.「這台裝置啟動不了算證明的程式」、5.「這台裝置算不出證明」，同一句 |
| `card_signature` | | 卡片回的簽章用憑證的公鑰驗不過 | 5.「卡片回的簽章用憑證驗不過，或簽章時的其他錯誤」，代碼 `card_signature` |
| `challenge_malformed` | | 題目不是唯一寫法 | 5.「伺服器沒有回應，或回應讀不懂」，代碼 `challenge_malformed` |
| `challenge_not_today` | 題目的日期、今天 | 題目的日期不是裝置的台灣今天 | 5.「電腦的日期和題目的日期不同」 |
| `blocked` | `switch_limit`（附平台） | 清單在那個平台換成別的帳號，但那個平台的 5 次更換用完、今天也不是更正（可以改清單） | 那一列下面本來就寫「已經更換 5 次，這個平台不能再更換。」「這一列不能改成別的帳號，可以清空。」；照樣輸入別的帳號按「下一步」時，引擎的 `choose` 拒絕，那一列下面是「這一列不能改成別的帳號。請填回原本的帳號，或清空。」 |
| `blocked` | `empty` | 清單是空的，而這張卡片目前沒有宣告任何帳號（可以改清單） | 4.「請至少填一個帳號。」 |
| `blocked` | `daily_limit` | 這張卡片今天已經有 3 筆有效紀錄，任何清單都不能送 | 畫面不讓改（4.「今天已經過卡 3 次」，清單照樣顯示，只有「回到開頭」）；引擎的 `choose` 也拒絕，句子相同。和紀錄規則的順序相同，更換、空清單先回那幾個原因 |
| `idle` | | 第一次簽章後 5 分鐘沒有完成第二次簽章（包括在等後台回答現況、題目的時候）：PIN、憑證、簽章都丟掉 | 1.「超過 5 分鐘沒有完成而回到這個畫面時」；畫面回到第 1 步 |
| `proof_check` | | 證明不是 14,656 個位元組，或公開輸入和裝置重建的不同 | 5.「算出的證明沒有通過這一頁自己的檢查」 |
| `server` | `network`、`internal`、其他 5xx、`rate_limited`（送出時，可以重試） | 送出沒有到達、30 秒內沒有回答，或後台暫時失敗 | 5.「送不出去」，附「再試一次」 |
| `server` | `challenge_unknown` | 題目過期或不是這台後台發的 | 5.「停太久，題目過期」 |
| `server` | `crl_stale`（`503`） | 後台手上這張卡片那把發證金鑰的最新清冊超過 3 天（或還沒有），不接受那一把發證金鑰的過卡；另一把的照常（`docs/api/card-proof.md`） | 5.「後台回報內政部的廢止清冊太舊」 |
| `server` | `daily_limit` | 送出時，這張卡片這一天已經有 3 筆有效紀錄（查現況時還沒滿，或現況的日期不是今天） | 5.「後台回報這張卡片今天已經過卡 3 次」 |
| `server` | `switch_limit` | 送出時，紀錄規則擋下清單裡一個平台的更換（查現況之後次數變了，或現況少報了次數） | 5.「後台回報有一個平台不能再更換」 |
| `server` | `empty` | 送出時，清單是空的而這張卡片沒有宣告任何帳號（查現況之後帳號已經被收回） | 5.「後台回報清單是空的……」 |
| `server` | `scope`、`platform`、`malformed`、`challenge_used`、`challenge_attempts`、`proof`、`root`、`date_order` | 後台沒有接受這份清單 | 5.「後台沒有接受」，代碼是後台的代碼 |
| `server` | `switch_restricted` | 紀錄規則接受、後台的營運政策不接受的更換（預設沒有這樣的政策；後台開了 `-restrict-late-switches` 時是第 4、5 次） | 5.「後台依營運政策不接受這次的更換」 |
| `server` | 要題目、查現況、讀設定時的任何代碼；`network`（包括超過時間上限）；`malformed_response`（包括紀錄規則產生不出來的現況）；`not_found`、`method_not_allowed`；`http_狀態碼` | 後台沒有回答，或回答讀不懂 | 2.（讀設定時）、3.（查現況時）或 5.（要題目時）「伺服器沒有回應，或回應讀不懂」，代碼是後台的代碼 |
| `username`（附平台） | | 那一列輸入的帳號不符合那個平台的格式（可以重新輸入） | 4.「帳號的格式不對」，寫在那一列下面，句子是那個平台的格式提示（畫面先擋下，按「預覽個人檔案」時也是；引擎的 `choose` 也拒絕）；文件沒有提示的平台是「帳號的格式不對。請照平台上顯示的帳號填。」 |
| `date_changed` | | 確認之後日期換了一天，這份清單在新的一天每一列會發生的事和畫面說的不同（例如今天才宣告的帳號改掉，過了午夜就是更換）：按下時已經換了一天，或題目在路上時過了午夜。卡片不簽第二次 | 5.「日期換了一天，這次改動的結果會和剛才畫面說的不同，……請回到開頭重新過卡。」，寫在「連上島民證明的伺服器」下面，按鈕只有「回到開頭」 |
| `state` | | 呼叫的程式步驟順序錯，或 `proceed` 傳的清單不是引擎算的那一份；`cancel()` 之後，當時還在等待的那一步也以它結束（畫面那時已經回到第 1 步，不顯示） | 文件沒有這句；只顯示代碼 `state`（程式錯誤） |


### 文件沒有句子、或句子不完整的地方

| 在哪裡 | 情況 | 畫面現在 |
|---|---|---|
| 第 4 步 | 「上次過卡是 N 天前」：後台回的上次過卡日比裝置的今天晚（規則允許最多晚 3 天） | 天數是負的（已知，還沒修） |
| 第 4 步，那一列下面 | 今天才宣告、又收回、現在空白的那一列（今天之內填別的帳號算更正） | 沒有「今天才宣告的帳號……」那一行（已知，還沒修） |
| 第 6 步，證明紀錄記下的那一列最後 | 送出後比對不同 | 句子之外，那一列最後還有代碼 `kind_mismatch`（回報問題時用） |

## 唯一存進瀏覽器的東西

每把發證金鑰用過的最高清冊編號：`localStorage` 的 `iamreal.highest_crl_number.G2`、`iamreal.highest_crl_number.G3`，值是十進位的編號（`src/storage.ts`）。憑證、簽章、PIN、匿名編號、帳號名稱都不存。

bb.js 平常會把通用參數存在 IndexedDB；這裡不用 bb.js 自己的下載（`skipSrsInit`），所以它不會存。無頭瀏覽器的測試在流程跑完後檢查：`localStorage` 只有清冊編號，`sessionStorage`、IndexedDB、Cache Storage、cookie 都是空的。

## 頁面需要的標頭

伺服器對 `web/` 的每個檔案（`/proof` 和 `/proof/` 底下，見「網址」）送三個標頭（`worker/` 定義在 `worker/src/headers.ts` 的 `proofPageHeaders`，寫進 `worker/site/_headers`，由 Cloudflare 的 Static Assets 直接加在檔案上，不經過 Worker 的程式，見 `worker/README.md`「Static Assets」；`worker/` 的測試檢查這份 README 引用的和它一字不差）：下面的 `Content-Security-Policy`、`Document-Isolation-Policy: isolate-and-credentialless`、`Cross-Origin-Opener-Policy: same-origin-allow-popups`。

### `Content-Security-Policy`

頁面自己只連到自己的網域和資料網域（下面），不連到別處（測試實測：頁面和它的 worker 的每個請求都在自己的網域，元件的視窗除外；測試的建置從自己的網域拿清冊，見「資料網域」）。下面第一份是正式網站送的，第二份是測試網站送的，只差資料網域。這份政策在這之上擋住頁面裡的程式用 `fetch`、圖片、WebSocket、表單、iframe、別的來源的指令碼和 worker 把東西送到別處。

**它擋不住的**（2026-11-16 在 Chrome 157 實測，正式的建置、這份標頭，在頁面裡執行指令碼把字串送到另一個來源）：整頁的導覽（`location.assign("http://別處/?d=…")`）、點擊裡的 `window.open`、WebRTC（`RTCPeerConnection` 的 `iceServers` 指到別處，加上 `webrtc 'block'` 也一樣）都送得出去；`<link rel=preconnect>` 會對別處開連線（沒有資料，但用網域名稱帶資料出去沒有測）。CSP 不管頂層的導覽和 `window.open`，頁面自己就是靠這一點開元件的視窗。所以**這份政策不是「套件被動了手腳也送不出去」的保證**：bb.js、noir_js 和它們的依賴打包在頁面的主執行緒，和 PIN、憑證、簽章在同一個執行環境，見證也在主執行緒算。對「套件被動手腳」這件事，靠的是：執行時的套件釘死版本、鎖檔有完整性雜湊（`pnpm-lock.yaml`）、安裝時不執行套件的指令碼（pnpm 預設）、不安裝發布未滿 7 天的版本；之後再加上可重現的建置。worker 裡沒有導覽和 `RTCPeerConnection`，所以 worker 裡的程式確實只連得到自己的網域。

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' https://data.iamreal.tw; img-src 'self'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

測試網站（`test.iamreal.tw`）送的只差資料網域，是測試的證明紀錄的那一個：

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' https://test-data.iamreal.tw; img-src 'self'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

- `'wasm-unsafe-eval'`：bb.js 和 Noir 要編譯 WebAssembly。
- `worker-src 'self'`：建樹的 worker 和 bb.js 自己的 worker 都是同一個網域的檔案。
- bb.js 原本把 WebAssembly 包成 `data:` 網址、把通用參數從 Aztec 的 CDN 下載。建置時把 WebAssembly 寫成檔案（`vite.config.ts`），通用參數改從自己的網域拿，所以 `connect-src` 只要 `'self'`，加上資料網域。
- `connect-src` 的 `https://data.iamreal.tw`（測試網站是 `https://test-data.iamreal.tw`）：頁面從自己那份證明紀錄的資料網域下載清冊存檔（ADR-0027，見「資料網域」）。只多這一個網域；頁面對它只送 `GET`，網址是清冊存檔的索引和那一份清冊檔，不帶 cookie、`Referer` 或別的東西（`src/api.ts` 的 `dataOriginFetch`）。
- 畫面的樣式是同一個網域的 CSS 檔（`style-src 'self'`）；畫面不用 `style` 屬性，也沒有內嵌的 `<script>`。
- 標題的字型是建置打包進來的檔案，從同一個網域載入（`font-src 'self'`）：`design/fonts/` 的源流明體 TW 子集，`src/ui/style.css` 引用它（`design/fonts/README.md`）。不用 Google Fonts 這類第三方的字型。
- **元件的視窗不需要多開任何東西。** `window.open` 開 `http://localhost:61161/popupForm`（頂層的導覽）和 `postMessage` 都不受 CSP 管；頁面本身不對 `localhost:61161` 發任何請求，那些請求是元件的頁面自己發的。`test/e2e/ui.ts` 在這份標頭之下跑完整條流程，沒有任何違反。

無頭瀏覽器的測試在這兩份標頭之下跑完整條流程，並檢查沒有任何違反，頁面和它的 worker 沒有連到自己的網域以外的地方。`test/e2e/run.ts` 自己送正式的那一份，並檢查這份 README 引用的和測試用的一字不差（`test/e2e/headers.ts`）；`test/e2e/ui.ts` 的頁面由本機的 Worker 送出，它是測試網站的設定，測試檢查它實際送的就是這份 README 引用的測試網站那一份。

### `Document-Isolation-Policy: isolate-and-credentialless`

多執行緒要頁面是跨來源隔離的。這個標頭讓 Chromium 系的桌機版隔離頁面，同時頁面還能和元件的視窗來回；`Cross-Origin-Opener-Policy: same-origin`（另一種隔離的做法）會讓元件的視窗沒有開啟者，回應送不回來。其他瀏覽器忽略它，證明用 1 個執行緒。

### `Cross-Origin-Opener-Policy: same-origin-allow-popups`

別的網站用 `window.open` 開這一頁時，沒有這個標頭的話，開啟者手上一直留著這一頁的參照：它能把整個分頁換成別的網址（例如長得一樣的假頁面），也能用元件視窗的名稱把那個視窗導到別處。這個值讓這一頁和開它的頁面分開（這一頁的 `window.opener` 是 `null`，開啟者手上的參照變成已關閉），而這一頁自己開的視窗（元件的）照樣有開啟者，元件的回應送得回來。它不讓頁面跨來源隔離，也不妨礙 `Document-Isolation-Policy` 的隔離。

`test/e2e/ui.ts` 在無頭的 Chrome、假元件之下檢查：讓另一個來源的頁面用 `window.open` 開這一頁，這一頁仍然是跨來源隔離的、`window.opener` 是 `null`、開啟者手上的參照是關閉的；這一頁讀卡時，開啟者用元件視窗的名稱 `window.open` 別的網址，元件的視窗不受影響、讀卡照常完成；開啟者改 `w.location`，這一頁不動。真的元件之下、Edge、Firefox、Safari 沒有測過。

## 怎麼單獨執行和測試

需要 Node 22（22.6 以上）、pnpm 10。

```
pnpm install --frozen-lockfile     # 在根目錄：pnpm workspace，web/ 和 protocol/ 一起裝
cd web
pnpm fetch-crs        # 下載通用參數到 crs/（不進版控），核對 SHA-256
pnpm typecheck
pnpm test             # Node 裡的測試，約 20 秒（含一次正式的建置）
IAMREAL_BB=/path/to/bb pnpm test:e2e     # 引擎對本機的 Worker，無頭的 Chrome，約 3 分鐘
IAMREAL_BB=/path/to/bb pnpm test:ui      # 畫面、橋接對本機的 Worker，無頭的 Chrome，約 6 分鐘（要 Go：建置 iamreal-verify）
pnpm test:worker      # 過卡之後訪客的頁面，對本機的 Worker，無頭的 Chrome，約 40 秒
pnpm build            # 正式的建置，到 dist/
IAMREAL_TEST_PROOF_LOG_CLEARED_ON=2026-11-19 pnpm build:test-site   # 測試網站的建置，到 dist/
```

- `pnpm fetch-crs` 是這個目錄的程式唯一對外的連線（`worker/` 的 `pnpm local` 另外讓後台的清冊鏡像抓內政部的清冊）：從 `https://crs.aztec-cdn.foundation/` 下載 2^18 個點的 `g1_compressed.dat` 開頭 8 MiB（SHA-256 `5107a7926d504236331b4872b7218a1ca18921b5358d894822576e1aeb684934`）和 `g2.dat`（128 個位元組，`01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f`）。G1 的雜湊和 `bb` 自己下載、檢查過的兩份副本相同；G2 從 Aztec 的兩個網域下載的相同。頁面執行時從自己的網域拿這兩個檔案。
- `IAMREAL_BB` 是 `bb` 6.0.0（取得方式見 `verifier/README.md`）。`CHROME` 可以指定 Chrome 的路徑，預設是 macOS 的 Google Chrome。
- 三套無頭瀏覽器的測試都對本機 workerd 裡的 Worker 跑（`worker/` 測試專用的建置，`worker/README.md`「測試的工具」），它們共用假元件的固定埠 61171 和 `worker/` 的建置目錄，一次跑一套。上面的時間是 2026-11-21 在一台同時跑著別的測試的 M1 Max 上量的。
- `pnpm test:e2e` 後面可以接設定，例如 `G3-dip G3-none G2-dip G3-dip-t4`：發證金鑰的大小、頁面是否跨來源隔離、證明的執行緒上限。

### Node 裡的測試（`pnpm test`）

| 檔案 | 測什麼 |
|---|---|
| `test/tables.test.ts` | 寫死在頁面裡的表對 `spec/`：`issuers.json`（G2、G3 的發證金鑰，加上 `crl/` 的兩張發證憑證）；Threads 的輸入整理只把 ASCII 改小寫，整理後的帳號照 `spec/scope.md` 平台表的格式檢查；`test-example` 照輸入原樣、沒有前綴。規格裡的算法對 `spec/vectors/` 的測試在 `protocol/`（見 `protocol/README.md`），只有頁面自己做的在這裡（`test/list-consequence.test.ts`） |
| `test/list-consequence.test.ts` | `spec/vectors/list-consequence.json` 的每一案：`requestConfig` 讀平台表、`requestCardState` 讀現況（只留頁面有自己那一份的平台）、`consequenceOfChoice`（`src/flow.ts`）算清單在每個平台上的後果，和標準答案相同。`device-core/` 讀同一份 |
| `test/card-status.test.ts` | `spec/vectors/card-status.json` 的每一案：同樣讀平台表和現況，`statusOf`（`src/flow.ts`）算出「你的帳號」那個畫面要的現況（今天是不是已經 3 筆、每一列還剩幾次、今天改是不是更正、原樣保留的帳號），上次過卡到今天幾天用 `daysBetween`（`src/ui/messages.ts`），和標準答案相同。`device-core/` 讀同一份 |
| `test/records-response.test.ts` | `spec/vectors/records-response.json` 的每一案：`submitRecord`（`src/api.ts`）讀送出後後台回的 201（`seq`、`record_hash`、`kinds`、`account_cards`），`mismatchesOf`（`src/flow.ts`）比對確認畫面那幾列，和標準答案相同。`device-core/` 讀同一份 |
| `test/crl.test.ts` | `spec/vectors/poseidon2.json`（`hash_2`、`hash_3`、匿名編號、廢止清冊的樹和「不在樹裡」的證明，分 1、2、4 份建）；`spec/vectors/revocation-tree.json`（整份清冊可用、樹根，清冊裡每個序號的路徑或「在樹裡」，分 1、2、4 份建）；`crl/testdata/` 的每一份清冊，可不可用、原因代碼、編號、清冊日期、樹根都和 `crl/testdata/expected.json`（Go 的結果）相同；`crl/testdata/times/` 的每一份（時間的各種寫法），哪些收、哪些是 `not_usable_der`，收的 `thisUpdate` 和清冊日期和 `times/expected.json` 相同；分份建樹和一次建的結果相同 |
| `test/device-checks.test.ts` | `spec/vectors/device-checks.json`（`spec/device-checks.md`）：選憑證和檢查憑證（`src/certificate.ts` 的 `selectCertificate`），每一案的結果是選出的憑證和讀到的值，或原因；`crl_max_age_days` 哪些值讀得懂、清冊多舊算過期的 `L`、從索引選哪個檔、鏡像給的清冊用不用（`src/api.ts` 的 `requestConfig`，`src/crl/revocation.ts` 的 `crlMaxAge`、`chooseFromIndex`、`loadCrl`），每一案的結果是用的清冊或原因，和之後記住的編號。標準答案由 `test/generate/device-checks.ts` 用 `test/fixtures/` 產生，每一案的結果手寫在產生器裡（見 `spec/device-checks.md`「Test vectors」） |
| `test/circuit-inputs.test.ts` | `spec/vectors/circuit-inputs.json`：每一案的憑證通過檢查、選到的電路，電路的輸入（`src/prover/inputs.ts`）和預期的公開輸入都和標準答案相同。標準答案由 `test/generate/circuit-inputs.ts` 從 `test/fixtures/` 產生，產生時讓電路執行過每一案 |
| `test/certificate.test.ts` | 照電路的走法預先檢查憑證時，每一次讀取都在 TBS 裡面（標準答案表達不了的部分） |
| `test/copy.test.ts` | `design/copy/card-proof.json` 和 `card-proof.md` 的句子兩個方向都相同（Markdown 的每個程式碼區塊和表格裡畫面的那幾欄；剩下的只能是照原樣顯示的值和畫按鈕、清單的符號，見「畫面和引擎怎麼分層」）；app 的句子（`app_` 開頭的組）不寫「這台裝置」「這台電腦」；`src/ui/` 和 HTML 裡沒有中日韓文字 |
| `test/ui.test.ts` | 每個平台的寫法（Threads 的前綴、格式的提示、帳號的網址；沒有寫法的平台沒有前綴、提示、預覽）、場合字串；每一種停止原因的句子和它寫在讀取卡片清單的哪一項下面（包括 `no_reader`、兩張憑證都通過、後台的 `daily_limit`、`switch_limit`、`empty`、`switch_restricted`、`platform`，沒有提示的平台的格式）；清單每一項的狀態（由上到下、同時做完的照順序顯示、停住的那項、上面沒完成的不顯示）；進行中停住後的按鈕（PIN 還在是「回到上一步」，丟掉了是「再讀一次卡片」，送不出去多「再試一次」）；第 4 步（還沒宣告過、宣告過、全部收回過的上方幾行和下方的說明；上次過卡是今天；每一列下面的那一行的每一種：沒宣告過、更換 0 到 5 次、今天才宣告的、收回過、不能再更換時可以清空或只能填回、次數用完但今天才宣告的；裝置不認得的平台那一列；今天已經 3 筆）；第 5 步（每一列的名稱、代號、帳號、會發生什麼和更換後的那一句的每一種；三種按鈕；有收回時；全部收回時；只有一個平台時那一句）；只有一個平台的條件（後台的表上裝置認得的平台數、不認得的平台上有帳號時當成超過一個）和第 1 步看建置認得幾個平台；第 6 步（五種標題、只有一個平台時放連結的那一句、島民證明的清單、卡片頁的連結、第一筆紀錄的換卡提醒、收回後連結可以拿掉、別的卡片也宣告了、`kinds` 讀不懂、後台記下的和第 5 步說的不同時那一列加代碼）（`src/ui/messages.ts`）；後台的錯誤帶請求編號；畫面用頁面自己的平台名稱，不用後台的；後台記下的和第 5 步說的不同時最上面那一句、那一列下面的「確認時畫面說的是：……」和「這次用掉了一次更換。」；`201` 讀不懂的標題；不認得的平台上的帳號照原樣（含空白）；日期換了一天時只有「回到開頭」 |
| `test/hipki.test.ts` | 元件的回應怎麼讀：沒有讀卡機（`no_reader`）、讀卡機沒有卡片（`no_card`）、憑證、簽章和附的憑證；PIN 錯、鎖卡、其他代碼（照讀程式得知的格式，見「元件的橋接信任什麼」）。元件的視窗每次一個新的亂數名稱，上一個關了才開下一個；第一次關不掉的視窗，再看一次時關掉，關掉了就不再關 |
| `test/api.test.ts` | 請求的時間上限（換掉 `setTimeout`）：現況不回答，30 秒到時當成沒有回應、請求被中斷；`fetch` 不理會中斷也一樣；回應的標頭來了、內容不來，當成沒有回應而不是讀不懂；靜態檔 30 秒時還在等、5 分鐘到時停；`requestConfig` 讀得懂哪幾列、整張表讀不懂的 9 種 |
| `test/build.test.ts` | 正式的建置有內政部的發證金鑰、`http://localhost:61161`、公開的證明紀錄的場合字串，沒有假卡片、測試的發證金鑰、假元件、`test-example` 的那一份，`localhost` 以外的本機網址一個都沒有；本機用真卡片的建置（`localcard`）一樣有內政部的金鑰和元件、沒有任何測試的東西，但簽的是測試的證明紀錄的場合字串、認得 `test-example`；測試網站的建置（`testsite`）和本機用真卡片的相同，另外只寫了 `https://test-data.iamreal.tw` 這一個資料網域（沒有正式的那一個，也沒有這個專案的其他網址），連結的網域是 `test.iamreal.tw`，有測試的證明紀錄的標示（一段 JSON：句子、建置時給的日期、測試的證明紀錄的場合字串），頁面載入它；正式的建置沒有標示的檔和字，只有一個 HTML（沒有說明頁）；其他建置沒有標示；沒給日期、或日期不在日曆上，測試網站的建置做不出來 |
| `test/flow.test.ts` | 伺服器或鏡像給了不該接受的值，每一個都停下來，之後沒有請求，沒有請求帶著原因：日期不是今天的題目、寫法不唯一的題目（6 種）、章不對的清冊、舊於 `L` 天的清冊、`/api/v1/config` 回 365、編號比記住的低的清冊、分段的清冊、索引指到不存在的檔案、內容和檔名的雜湊不符的清冊、雜湊不對的電路檔、序號在清冊上。平台表讀不懂（8 種：不是清單、一列都讀不懂、代號重複或沒照順序等）時停在讀卡，不簽章、沒有 `card-state`；格式不是 `[…]{m,n}`、顯示名稱有控制字元的那一列是裝置不認得的平台。現況讀不懂（45 種：結構不對、紀錄規則產生不出來的名額和卡片、裝置不認得的平台上不合最低限度檢查的帳號）停在 `malformed_response`，規則產生得出來的照常。卡片簽的場合字串只有公開的證明紀錄的那一個；裝置不認得的平台上的帳號原樣保留、照位元組順序排進清單、簽進宣告碼、送出；平台表上有、現況裡沒有那一項的平台不提供。每個平台的種類（`first`、`refresh`、收回後的 `refresh`、`correction`、`switch`、`withdraw`）；當天更正在更換 0、3、5 次時都可以；第 4、第 5 次照常是更換，5 次之後是 `switch_limit`，流程不結束，清空或不改那一列照常；空清單是 `empty`；今天 3 筆是 `daily_limit`，在更換的原因之後。帳號用了別的平台的格式、帳號沒有剛好涵蓋提供的平台，引擎拒絕；`proceed` 傳的清單不是引擎算的那一份（4 種）時不簽第二次；更正跨過午夜變成更換時停在 `state`、不要題目。送出的內容（鍵的順序、`accounts`）。回應的 `kinds` 讀不懂（9 種）時是 `null`、照樣完成；`account_cards` 讀不懂只有那一項是 `null`；`seq`、`record_hash` 不對照舊是 `malformed_response`。送出後比對：畫面說更正、記下的是更換（漏洞 M9）、別的帳號、少一個平台、多一個平台、收回而不是不變。再送得到 `challenge_used`（假的後台）：整份清單和 `last_card_proof` 相符時完成（`kinds` 是 `null`）；不相符（7 種，含多一個帳號、少一項）停在 `challenge_used`；現況讀不懂時停在那個原因；第一次送出就得到 `challenge_used` 時不查現況。另外，和改之前相同的：過期的憑證在任何請求之前停下；PIN 錯可以重試、PIN 不留；第 4、5 步來回不簽章、不發請求；PIN 最多等 5 分鐘（換掉時鐘和計時器）；`cancel()` 在每一種等待中；三次點擊各被擋一次；序號在清冊上、清冊不可用、電路檔或通用參數雜湊不對時卡片沒有被要求簽章、沒有 `card-state`；`crl_stale` 結束流程、`internal` 可以原封不動再送；讀卡機說簽章的憑證不是選出的那一張；伺服器拖住回答；過卡跨過午夜；清掉的憑證、簽章和電路的輸入；一步進行中又被呼叫；給畫面的事件；沒有讀卡機、兩張都通過的憑證；確認之後過了午夜（按下之前、題目在路上時）：每一列的結果和畫面說的不同就停在 `date_changed`、不簽第二次、不送出，相同就照常；`201` 的內容讀不懂（`seq`、`record_hash` 讀不懂、不是 JSON、是清單、空的）：完成，`kinds` 是 `null`；後台的表有、頁面沒有自己那一份的平台：有帳號就原樣保留、不能改，沒有就不顯示；PIN 在算證明時已經不在（第二次簽章後就丟），送不出去時也不在。`src/flow.ts` 清 PIN 的每一處，拿掉任何一處都有測試變紅 |

### 標準答案的產生器

`test/generate/list-consequence.ts` 寫出 `spec/vectors/list-consequence.json`（`spec/list-consequence.md`）。每一案的結果手寫在產生器裡；這個目錄的程式算出來的不同，就停下、不寫檔。改了讀平台表、讀現況或算後果的程式，或要加案例時，在這個目錄跑：

```
node --experimental-strip-types test/generate/list-consequence.ts
```

`test/generate/card-status.ts` 同樣寫出 `spec/vectors/card-status.json`（`spec/list-consequence.md` 的「The card's state, as shown」）：

```
node --experimental-strip-types test/generate/card-status.ts
```

`test/generate/records-response.ts` 同樣寫出 `spec/vectors/records-response.json`（`spec/records-response.md`）：

```
node --experimental-strip-types test/generate/records-response.ts
```

### 無頭瀏覽器的測試（`pnpm test:e2e`）

`test/e2e/run.ts` 用 Vite 建置測試頁（`test/e2e/`），在本機的 Worker（`worker/` 測試專用的建置）前面起一個小服務（`test/e2e/worker-site.ts`）：測試頁和它的檔案由這個服務帶著上面的 CSP 提供，清冊存檔從 R2 的模擬讀出來（扮演資料網域），`/api/…` 原樣交給 Worker。清冊由 Worker 自己的排程從假的內政部鏡像進來，是自製的，大小接近內政部的（G3 176,000 筆、G2 340,000 筆）。開無頭的 Chrome、全新的設定檔，用假卡片跑兩次過卡（同一次頁面載入、同一個證明引擎；證明紀錄在 Worker 裡，第二次看得到第一次：第一次宣告 `test-example` 和 `threads` 兩個帳號，第二次收回 `test-example`、`threads` 不變）。跑完檢查：

- 兩次都送出了：Worker 用部署的那一個驗證器驗過證明、寫進證明紀錄，證明紀錄裡的那一行就是頁面回報的紀錄，清單照平台代號排、每一次的種類和簽之前畫面說的相同；
- 從紀錄的欄位（宣告碼由整份清單算）重建公開輸入，用原生的 `bb verify -t noir-recursive` 和 `verifier/vk/` 的驗證金鑰也驗得過；改一個公開輸入就驗不過；
- `crossOriginIsolated`、引擎的執行緒數和 bb.js 自己說開的相同；
- 沒有違反 CSP，沒有測試頁的服務和 Worker 都答不出來的請求；
- 瀏覽器的儲存空間只有清冊編號。

發證金鑰是測試當場產生的，不是內政部的；Worker 測試專用的建置認的也是這兩把。從畫面上走的每一種情況在 `pnpm test:ui`。

### 畫面、橋接和後台（`pnpm test:ui`）

`test/e2e/ui.ts`：

1. 產生拋棄式的發證金鑰（G2、G3）、卡片和清冊（`test/fixtures/`）。
2. 在本機的 workerd 啟動 Worker 測試專用的建置（`test/e2e/worker-site.ts`，用 `worker/test/harness.ts`）：這兩把金鑰、一個假的內政部（給鏡像抓清冊）、測試的證明紀錄（平台表是 `test-example` 和 `threads`）、可以調的時鐘；頁面用 `vite build --mode test` 建置（`test/e2e/target.ts` 換掉 `src/target.ts`：測試的證明紀錄、測試的發證金鑰、假元件在 `http://localhost:61171`、PIN 等第二次簽章的上限 25 秒），放進 Worker 的 Static Assets，在 `/proof`，帶測試網站的標頭。Worker 前面的小服務扮演資料網域（`/crl/…` 從 R2 的模擬讀，只讀）。不建置也不啟動 Go 的舊後台；唯一建置的 Go 程式是 `iamreal-verify`（第 5 項）。
3. 假元件（`test/e2e/fake-component.ts`）照真元件的訊息來回，用測試金鑰的卡片回答 `GetUserCert` 和 `MakeSignature`，PIN 錯、鎖卡回中華電信程式庫寫的代碼，並記下每一個請求。
4. 用無頭 Chrome（`test/e2e/cdp.ts`，Chrome DevTools Protocol，不用套件）從畫面上點，滑鼠事件是真的（瀏覽器當成持卡人的點擊）。瀏覽器不解析 `localhost`、`127.0.0.1` 以外的名稱（`--host-resolver-rules`），預覽開的平台分頁連不出去。一張卡片一天最多 3 筆有效紀錄、更換一天算一次（同一天再改是更正），所以同一張卡片的紀錄分在九天：後台的時鐘（Worker 測試專用建置的時鐘，小服務在每個請求之前把它設成這台電腦的時間加上撥的天數）和頁面的時鐘（測試把頁面的 `Date.now` 換掉）一起往後撥整天，假的內政部每天發一份當天的清冊，測試讓 Worker 的排程跑一次把它鏡像進來。每次過卡都從第 1 步開始：第 1 步（兩段和上面兩行一樣顯眼的提醒、兩個問題、只有「下一步」）、第 2 步的六項由上到下一項一項完成（記下清單的每一個樣子：完成的在上、最多一項進行中、下面的沒有狀態）、不顯示姓名、第 3 步的姓名和三件事、「卡片簽章中……」、第一次簽章簽的是測試的證明紀錄的公開場合字串、每一步上方的「第 n 步，共 6 步」。每一次都檢查第 4 步每一列（名稱、欄位裡的帳號、下面的那一行、有沒有預覽）和上下的句子、第 5 步要簽的整份清單（每一列的名稱、平台代號、帳號、會發生什麼）、按鈕、清單下面的句子、第 6 步的標題、島民證明的清單、卡片頁的連結、證明紀錄記下的每一列、換卡的提醒、收回的連結、別的卡片也宣告了。
   - 第 0 天：第一次宣告一個平台（先輸入一次錯的 PIN；三次點擊各先被瀏覽器擋一次；什麼都沒填按「下一步」是「請至少填一個帳號。」；格式不對的帳號按「預覽個人檔案」：那一列下面是格式的提示、沒有開分頁；`@Alice` 按預覽：頁面呼叫 `window.open("https://www.threads.com/@alice", "_blank", "noopener,noreferrer")`，開出一個拿不到這一頁的新分頁，這一頁自己沒有對別處發請求；`test-example` 格式不對時那一列下面是「帳號的格式不對。請照平台上顯示的帳號填。」；「複製連結」把 `https://iamreal.tw/p/<島民編號>` 寫進剪貼簿；完成畫面的每個連結都在新分頁開；小卡上記號的動畫；QR code 是頁面上畫的 SVG，內容是 `https://iamreal.tw/hang/<島民編號>`）、再次過卡什麼都不改（後台的表把顯示名稱都改掉，畫面照樣寫頁面自己的名稱；第一次送出被丟掉，「再試一次」完成）、當天更正（「今天才宣告的帳號，這次改掉不另外算一次更換。」，證明紀錄記下 `correction`）、今天已經 3 筆（清單照樣顯示、不能改，只有「回到開頭」，沒有第二次簽章）。
   - 第 1 天：加第二個平台（中間「上一步」來回：輸入的照樣留著，沒有簽章、沒有查現況、沒有要題目）、更換、清空一列（收回，「收回之後……」、完成時「已經收回的帳號……」）、把現況的回答改成今天 2 筆再送（同一天的第 4 筆，後台回 `daily_limit`：句子和請求編號在「送出」下面，畫面上的請求編號就是 Worker 回 `daily_limit` 的那個回應的，證明紀錄沒有多一筆；「再讀一次卡片」在同一次點擊裡讀卡，上一次的 PIN、姓名、憑證、簽章都不在頁面上）。
   - 第 2 天：全部收回（「按下後，證明紀錄會公開記下這張卡片不再宣告任何帳號：」、「收回所有帳號」、完成時沒有動畫、島民證明、連結）、沒有帳號時送空清單是「請至少填一個帳號。」、兩個平台都宣告回去（「再次宣告，不算更換」）。
   - 第 3 天：把現況的 `correction_date` 改成今天：畫面說是更正、不算更換，證明紀錄記下的是更換，完成的那一列下面是代碼 `kind_mismatch`（送出後比對）；完成畫面最上面是「證明紀錄記下的，和你確認時畫面說的不同。……」，那一列下面是「確認時畫面說的是：……」和「這次用掉了一次更換。」。
   - 第 4 天：第 3 次更換（「這次之後，目前不能再更換。」）。
   - 第 5 天：更換過 3 次的那一列是「更換過 3 次，還可以更換 2 次。」；第 5 步的「取消」；第 4 次更換（Worker 一開始就帶更換政策的設定 `RESTRICT_LATE_SWITCHES` 啟動，回 `403` `switch_restricted`：「這個平台目前不接受更多次更換。」和請求編號，證明紀錄沒有多一筆）；把後台的平台表拿掉 `test-example`：那一列變成不能修改的「test-example a-b」和「這一頁還不認得這個平台。……」，第 5 步寫「不變」，送出的清單原樣帶著它、照位元組順序；之後同一次頁面載入裡：「回到開頭」、第 4 步的「取消」、第 3 步的「上一步」（回到第 2 步、沒有讀過的樣子；再讀一次卡片，卡片只被讀、沒有簽章；PIN 欄位是空的）、PIN 等太久（回到第 1 步、顯示那一句、沒有第二次簽章）、再次過卡（每次回到第 1、2 步都檢查：上一次的 PIN、姓名、兩張憑證、卡片的簽章都不在頁面上；這段通用參數只下載一次、證明引擎只啟動一次）。
   - 整個 Worker 連同證明紀錄的 Durable Object 重新啟動，回到預設、沒有更換政策（存著的證明紀錄和儲存桶的檔案留著，同一個網址）。第 6、7 天：第 4、第 5 次更換在網頁上照常做（第 5 步是「之後還可以更換 1 次」和「用掉最後一次更換。……」），都被接受。第 8 天：第 4 步那一列是「已經更換 5 次，這個平台不能再更換。」「這一列不能改成別的帳號，可以清空。」；照樣輸入別的帳號，引擎拒絕、那一列下面是「這一列不能改成別的帳號。請填回原本的帳號，或清空。」、卡片沒簽、沒要題目；把現況的次數改成 2 再換，後台回 `switch_limit`（紀錄規則）：「清單裡有一個平台不能再更換，……」。之後把現況的 `correction_date` 改成今天（第 5 步說是更正），停在第 5 步時撥過午夜再按：「日期換了一天，……」寫在「連上島民證明的伺服器」下面，只有「回到開頭」，卡片沒簽、沒要題目。
   - 之後：鎖卡（句子在 PIN 欄位下面，「確認卡片」不能按，「上一步」可以）；PIN 含 `+`、`%`、全形數字（畫面的那一句、元件沒收到簽章的請求）；現況的回答沒有 `platforms`（PIN 欄位下面「伺服器的回應不正確……（代碼 malformed_response）」，沒有清單）；題目的日期不是今天（「連上島民證明的伺服器」停住，只有「再讀一次卡片」）；送出時後台說題目過期（`challenge_unknown`，只有「再讀一次卡片」，PIN 要重新輸入）；按「確認卡片」後拖住現況的回答，期間 PIN 欄位、「確認卡片」、「上一步」都不能按，再輸入、再按一次，卡片只簽一次、只有一個 `card-state`；每一種在輸入 PIN 之前停下的情況，各自的句子寫在清單的哪一項下面：元件不回應（句子後面唯一的連結是「過卡需要什麼」，在新分頁開 `/prepare`）、沒有讀卡機、沒有卡片、卡片沒有憑證、過期、還沒生效、不是國民正卡、格式不支援、兩張憑證都通過、不是內政部簽發、電路檔內容不符、後台不回應、平台表讀不懂（每一列的格式都不是 `[…]{m,n}`）、在清冊上、清冊 5 天沒更新、鏡像沒有可用的清冊、清冊比這台電腦用過的舊。每一種都檢查那一項寫「停在這裡」、下面的項目沒有狀態、沒有 PIN 欄位、卡片沒有簽、沒有 `card-state` 請求、「再讀一次卡片」可以按。
   - 證明紀錄公布、重驗之後，另外兩張卡片：一張宣告 `@zoe`、另一張也宣告 `@zoe`（`account_cards` 2：「還有別的卡片也宣告了 @zoe。……」）；第二張再次過卡時把回應的 `kinds` 換成一個不認得的種類（「證明紀錄已經記下這次過卡」和「這一頁讀不出伺服器回報每個帳號記成什麼。……」，島民證明照樣顯示）；第二張再過一次卡時把回應換成讀不懂的 `201`（同樣是「證明紀錄已經記下這次過卡」，不是失敗）；第一張再次過卡時讓第一次送出到達後台、把回答丟掉，按「再試一次」：後台回 `challenge_used`，頁面再查一次現況、清單相符，到完成的畫面（「證明紀錄已經記下這次過卡」），證明紀錄只多一筆。
   - 再一張新的卡片，後台的平台表只留 Threads：第 4 步只有 Threads 一列，標題是「你的 Threads 帳號」、上方是「填上你要宣告的 Threads 帳號。」、下方是「一張卡片只能宣告一個 Threads 帳號，……」，第 5 步是「按下後，證明紀錄會公開記下這張卡片宣告的帳號：」、「這個 Threads 帳號會公開列在島民證明上。」（沒有「這些帳號會公開列在……」）、按鈕「宣告這個帳號」，第 6 步是「把下面的連結放在這個 Threads 帳號的個人檔案上。……」、「有一張有效的自然人憑證宣告了這個帳號：」和「……更新這個帳號的日期。」。（後台的表少了 `test-example`、卡片在那裡有帳號的那一案，照超過一個平台的寫法。）每一次完成都檢查第 6 步下面的三點（清單變成空的時只有「你不需要相信我們……」）。
   - 正式的建置（`vite build --mode production`）用一個本機的小伺服器帶著頁面的標頭在 `/proof` 提供，只開到第 1 步、什麼都不按：寫出 Threads 的那一句，沒有「你宣告的帳號會公開列在……」；對元件的網址（`localhost:61161`）的請求一律擋下並計數，應該是 0。
   - 最後，測試網站的建置（`vite build --mode testsite`）放進另一個 Worker 的 Static Assets，和部署出去的一樣由它送出，只開到第 1 步、什麼都不按：頁面最上面是測試的證明紀錄的標示，句子和日期跟 Worker 自己產生的首頁上的那一行相同，日期在自己的 `<time>` 裡；頁面說它讓卡片簽的是測試的證明紀錄的場合字串；送給頁面的程式寫連結用的是 `test.iamreal.tw`、不是 `iamreal.tw`（`iamreal.tw` 只出現在頁首網站的名字 `common.site_name`）（完成畫面要過卡才到得了，這份建置只認真卡片，所以是讀程式）；說明頁的舊網址 `/proof/help.html` 轉到 `/prepare`；標頭是測試網站的那一組（CSP 的資料網域是 `test-data.iamreal.tw`、`X-Robots-Tag: noindex`）；頁面是跨來源隔離的、只連自己的網域、沒有違反 CSP；對元件的請求是 0。截圖是 `testsite-1-before.png` 和手機寬度的 `testsite-1-before-phone.png`。
5. Worker 照換日時的做法公布證明紀錄（最後一檔和雜湊清單、卡片狀態檔、指紋檔的一行），測試把它寫進 R2 的模擬的每個檔複製出來，用 `iamreal-verify` 照預設的讀法（`-data`）重驗，證明是真的：證明紀錄成立，每一筆有效，十四筆每個平台的種類和畫面第 6 步顯示的相同，最後的現況（這張卡片的清單 `test-example:a-b`、`threads:frank`，上次過卡是第 7 天）和畫面最後顯示的相同，畫面上的島民編號是這張卡片的。

6. 頁面的標頭（含 `Cross-Origin-Opener-Policy`）、跨來源隔離、多執行緒；沒有違反 CSP；頁面和它的 worker 只連到自己的網域、元件的視窗只連到元件；在自己的網域上只拿 `/proof`、`/proof/` 底下的檔案（程式、電路、通用參數、WebAssembly 都在那裡）、`/api/` 和 `/crl/`；一次元件的請求一個視窗（被擋的點擊沒有開出視窗；PIN 不送時，點擊開的視窗沒用就關掉），上一個視窗關了才開下一個；沒有不帶 PIN 的簽章請求；用過 PIN 之後、PIN 等太久之後頁面上找不到它；姓名在第 3 步之後不在頁面上；瀏覽器的儲存空間只有清冊編號。

截圖在 `test-output/ui/screens/`，重驗的輸出在 `test-output/ui/verify.json`，Worker 寫的紀錄在 `test-output/ui/worker.log`。

### 過卡之後訪客的頁面（`pnpm test:worker`）

`test/worker-card-proof.ts`：同樣的 Worker 和小服務，從畫面走完六步宣告 `@alice`，然後打開 `/p/<短編號>` 和首頁，比對 `design/copy/` 的句子和測試的證明紀錄的標示，各拍桌機和手機寬度的截圖（`test-output/worker/screens/`）。

### 其他的小程式（不在測試裡）

| 指令 | 做什麼 |
|---|---|
| `node --experimental-strip-types test/e2e/check-component.ts` | 對**真的**元件只送 `CheckEnvir`（環境檢查，不讀憑證、不簽章），頁面在 `http://localhost:<埠>`、帶後台的兩個標頭：看頁面是不是跨來源隔離、元件能不能來回 |
| `node --experimental-strip-types test/e2e/smoke.ts <網址>` | 對跑著的頁面（例如 `pnpm local`）開到第一個畫面為止，不碰元件 |
| `node --experimental-strip-types test/e2e/background.ts [次數]` | 量分頁在背景時過卡的時間（見「時間」） |

### 假卡片

`src/card/fake.ts`：測試金鑰簽發的憑證（簽章用和加密用各一張，結構和國民正卡相同，做法照電路測試的 `cert.mjs`，在 `test/fixtures/certs.ts`）和對應的私鑰。`src/index.ts` 不匯出它，正式的建置不含它（`test/build.test.ts`）。畫面的測試不用它：卡片在假元件裡（`test/e2e/fake-component.ts`），頁面走的是真的橋接。

## 時間

M1 Max（10 核）、Chrome 157 無頭模式，`pnpm test:e2e` 量的（2026-11-16）。「建樹」是 4 個 worker 從清冊的鍵建到自己的路徑；「證明」是見證加 UltraHonk 證明。同一次載入的第一次和第二次過卡用斜線分開。

| | 引擎初始化 | 建樹 | 證明 | 整次過卡（假卡片，不含人） |
|---|---|---|---|---|
| G3，跨來源隔離，8 個執行緒（上限） | 1.7 到 1.8 秒 | 2.8 / 2.5 秒 | 2.9 / 2.4 秒 | 6.4 / 5.3 秒 |
| G3，跨來源隔離，10 個執行緒 | 1.8 秒 | 2.9 / 2.5 秒 | 3.2 / 2.6 秒 | 6.7 / 5.6 秒 |
| G3，跨來源隔離，4 個執行緒 | 1.9 秒 | 2.6 / 2.5 秒 | 3.8 / 3.4 秒 | 7.0 / 6.3 秒 |
| G3，沒有隔離（1 個執行緒） | 4.1 到 4.5 秒 | 2.5 / 2.5 秒 | 9.3 / 9.0 秒 | 13.9 / 11.9 秒 |
| G2，跨來源隔離，8 個執行緒（上限） | 2.1 秒 | 5.1 / 4.7 秒 | 2.4 / 2.0 秒 | 8.6 / 7.6 秒 |
| G2，沒有隔離（1 個執行緒） | 4.2 到 5.0 秒 | 4.8 / 4.8 秒 | 8.0 / 7.7 秒 | 13.9 / 13.3 秒 |

- 引擎初始化從頁面開始算，大部分是把壓縮的通用參數展開（單執行緒約 3.9 秒）。它在進頁面時就開始，和讀卡、建樹同時進行。展開後的參數不存起來（見上面「唯一存進瀏覽器的東西」），所以每次載入都重做。
- 證明的執行緒上限是 8（`MAX_PROOF_THREADS`，`src/prover/engine.ts`）：這台電腦上多於 8 個沒有更快，少於 8 個變慢。每一格只量一次，只有這一台電腦。
- **分頁在背景時慢很多。** `test/e2e/background.ts`（2026-11-16，同一台電腦、Chrome 157 無頭模式，G3、自製的 176,000 筆清冊，每格兩次頁面載入、每次兩次過卡）：另一個分頁在前景、這一頁從載入到算完都在背景（`document.visibilityState` 是 `hidden`）時，跨來源隔離（8 個執行緒）的證明從 2.6 到 3.5 秒變成 28.6 到 32.5 秒，建樹從 2.5 到 2.9 秒變成 20.6 到 31.1 秒，引擎初始化從 1.8 到 1.9 秒變成 13.5 到 19.4 秒，整次過卡從 6.2 到 7.1 秒變成 56.5 到 66.8 秒；沒有隔離（1 個執行緒）的證明從 9.2 到 9.6 秒變成 60.3 到 65.2 秒，整次過卡從 12.4 到 14.4 秒變成 92.5 到 96.5 秒。原因沒有查（推測是 Chrome 降低背景分頁行程的優先順序）；有畫面的 Chrome 沒有量。
- 頁面不是跨來源隔離時 bb.js 不報錯、安靜地用 1 個執行緒；引擎自己看 `crossOriginIsolated` 和 `SharedArrayBuffer` 決定，並把 bb.js 自己說開的執行緒數一起告訴呼叫的程式（`ThreadMode`）。

## 檔案

| 檔案 | 內容 |
|---|---|
| `index.html` | 過卡的頁面 |
| `src/ui/` | 畫面：`main.ts`（進頁面就啟動引擎）、`app.ts`（`card-proof.md` 的六步）、`messages.ts`（停止原因、清單每一項的狀態、第 4 步的清單和每一列的那一行、第 5 步要簽的清單、完成的畫面對到哪一句）、`copy.ts`（讀 `design/copy/card-proof.json`）、`dom.ts`、`frame.ts`（六步共用的頁首和欄）、`qr.ts`（完成畫面的 QR code）、`test-proof-log.ts` 和 `test-proof-log.css`（測試的證明紀錄的標示，只有測試網站的建置有）、`logo.ts`（記號，用 DOM 畫的 SVG；台灣的輪廓取自 Natural Earth 的公有領域地圖資料）、`style.css`（顏色、版面、清單的勾和轉圈、完成的動畫；不載入字體檔） |
| `src/platforms.ts`、`src/presentations/` | 寫死在裝置上的每個平台的名稱和寫法（每個平台一份）、卡片頁的路徑（網域在 target）（見「每個平台不同的東西」） |
| `src/index.ts` | 引擎的入口：`startEngine()`（進頁面呼叫一次）、`createCardProof()`（每次過卡，用同一個引擎）。證明紀錄（`src/target.ts`）、同網域的 fetch、資料網域的 fetch、時鐘、儲存 |
| `src/base.ts` | 頁面和它的檔案放在哪個路徑底下（建置的 `base`，見「網址」） |
| `src/target.ts`、`src/target-test-site.ts`、`src/target-local.ts` | 證明紀錄（場合字串由它決定）、裝置認得的平台、發證金鑰、元件的網址、資料網域、連結寫的網域、PIN 等第二次簽章的上限；測試的建置換成 `test/e2e/target.ts`，測試網站的建置（`testsite`）換成 `src/target-test-site.ts`，本機用真卡片的建置（`localcard`）換成 `src/target-local.ts`（見「三種用真元件的建置」） |
| `src/flow.ts` | 過卡的狀態機：`readCard` → `checksDone` → `confirmCard(pin)` → `choose(每個平台輸入的帳號)`（↔ `back()`）→ `proceed(清單)` → 完成；`resubmit`、`cancel`；`phase` 說現在在哪一步；PIN 等第二次簽章的上限 `IDLE_MS`；送出後比對 |
| `protocol/`（另一個目錄） | 規格裡的算法：base32、題目、日期、場合字串、帳號名稱的格式和平台代號（`username-format.ts`）、宣告碼（整份清單）、匿名編號和 10 個字元的短編號、紀錄規則（不保管狀態的函式 `applyRecord`；流程用它的後半段 `applyList` 算一份清單會發生什麼；今天是否已經 3 筆；規則產生不出來的狀態）、位元組的小工具。`web/` 用 workspace 的方式引用它（`iamreal-protocol/…`），見 `protocol/README.md` |
| `src/certificate.ts`、`src/der.ts` | 讀憑證、照電路的走法預先檢查、選出要用的那一張、驗發證金鑰的章 |
| `src/issuers.ts` | G2、G3 的發證金鑰，WebCrypto 的 RSA 驗章 |
| `src/crl/` | 讀清冊並判斷可不可用、從鏡像找清冊並檢查、樹、建樹的 worker |
| `src/prover/` | 證明引擎（bb.js、Noir）、電路的輸入、電路和通用參數的雜湊 |
| `src/api.ts` | 和後台之間的請求，嚴格讀回應 |
| `src/card/` | 卡片的介面、元件的橋接（`hipki.ts`）、假卡片 |
| `src/storage.ts` | 唯一的儲存：清冊編號 |
| `circuits/` | 編譯好的電路，見裡面的 `README.md` |
| `scripts/` | 下載通用參數、從 `nargo` 的輸出寫出 `circuits/` 的檔案、在本機整條跑（`local.ts`） |
| `test/` | 測試；`test/fixtures/` 是測試金鑰做的憑證、清冊和假伺服器（Node 裡的測試用）；`test/generate/` 從它們產生 `spec/vectors/` 的標準答案（不是測試，`pnpm test` 不跑）；`test/e2e/` 是無頭瀏覽器的測試、假元件、Worker 前面扮演資料網域的小服務（`worker-site.ts`）、量測。無頭瀏覽器的測試引用 `worker/test/` 的測試工具來啟動 Worker |

執行時的外部依賴只有 `@aztec-foundation/bb.js` 6.0.0 和 `@noir-lang/noir_js` 1.0.0（和 `circuits/` 釘的相同），另外引用這個程式庫的 `protocol/`（workspace，沒有外部依賴）。開發用的只有 Vite、TypeScript 和 `@types/node`。全部是精確版本，根目錄的 `pnpm-workspace.yaml` 設了不安裝發布未滿 7 天的版本，鎖檔是根目錄的 `pnpm-lock.yaml`。沒有介面框架；DER 自己解析。

## 已知的限制

- **證明紀錄裡的現況照後台說的顯示，不檢查。** 要擋得下載整份證明紀錄自己算，太重。後台從這裡查不出持卡人是誰，謊報會被證明紀錄裡的紀錄揭穿。裝置只擋紀錄規則產生不出來的組合（見「從伺服器拿到的值」的表）；規則產生得出來的謊報擋不了：
  - 少報一個帳號：持卡人加一個新帳號送出，原本的帳號就被收回（漏洞 L2）。第 5 步列出整份要簽的清單和會被收回的帳號，持卡人看得到；可以再送一次宣告回來（不算更換），代價是當天的筆數。
  - 把 `correction_date` 說成今天：畫面說這次改掉不算更換，證明紀錄記下的是更換，次數不會恢復（漏洞 M9）。第 6 步把後台回報的種類和第 5 步說的比對，不同時那一列加代碼 `kind_mismatch`（文件還沒有句子）；後台在回應裡也一起說謊的話，比對抓不到。
  - 少報更換次數：網頁照樣做，第 5 步說的剩餘次數不對；紀錄規則擋第 6 次（`switch_limit`）。
- **平台表由後台給**（漏洞 M10）：給證明紀錄不收的平台、比較寬的格式，會讓持卡人白做一次過卡（後台自己會拒絕，代碼 `platform`、`malformed`，或寫進去後整份證明紀錄不成立）；把裝置認得的平台從表裡拿掉，持卡人在這一頁就改不了那一列。認不出持卡人。顯示名稱寫死在裝置上，後台給錯的名稱不會顯示；第 5 步每一列在名稱旁邊寫出平台代號。場合字串不從這張表來。
- **裝置不認得的平台上的帳號原樣保留**（漏洞 M11）：後台可以在現況裡編一筆不在平台表上的帳號，裝置會把它放進清單讓卡片簽；那一列顯示在第 4、5 步。後台把證明紀錄收的平台故意不放進平台表，持卡人在這一頁就改不了那一列。
- **CSP 不是「套件被動了手腳也送不出去」的保證。** 頁面裡的程式能用整頁的導覽、點擊裡的 `window.open`、WebRTC 把資料帶出去（見「頁面需要的標頭」）。被動了手腳的套件在主執行緒拿得到 PIN、整張憑證、場合字串的簽章。這一層靠的是版本釘死、鎖檔的完整性雜湊、安裝時不執行指令碼，之後的可重現建置。
- **bb.js 和 Noir 的 WebAssembly、頁面的指令碼沒有核對雜湊**（見「從伺服器拿到的值」下面的「頁面本身」）。頁面和靜態檔分開放時要補。
- **「清成 0」只清得到流程物件手上的那幾份。** 流程結束或取消時，引擎也丟掉這張卡片的匿名編號、現況、清單和紀錄（不是祕密，只是不留）。引擎清掉：流程物件的憑證和兩個簽章（送出後、取消、流程停下時）、讀卡時沒被選上的憑證（選完就清）、元件每次簽章附回來的憑證副本（比對完就清）、交給電路的輸入裡的數字陣列（算完證明就寫成 0，十六進位字串的陣列換成 `"0x0"`）。清不到、只是不再參照，留到被回收或分頁關掉的：證明引擎和 Noir 的 WebAssembly 記憶體、bb.js 的 worker 裡的見證（引擎整頁共用、不重啟）；交給電路的十六進位字串本身（JavaScript 的字串不能清成 0）、從簽章算出的大整數；元件回應的整個字串（含簽章和憑證的 base64）；姓名的字串。沒有到記憶體裡找過這些。
- **鏡像探得出這個瀏覽器記住的清冊編號。** 給一份編號 N 的清冊，裝置停不停下來，看它記住的編號比不比 N 大（`crl_rollback`）。編號每天增加，所以探得出這個瀏覽器上次過卡大約是哪一天。後台從證明紀錄本來就知道每個匿名編號上次過卡的日期，多知道的很少。
- **兩次簽章之間換了卡，會對另一張卡用掉一次 PIN 的錯誤次數。** 第二次簽章用的是留著的 PIN，送給當時在讀卡機裡的卡；PIN 錯，流程結束，不會重送。
- **5 分鐘的上限管到 PIN 交給元件為止。** 讓卡片簽第二次之前引擎最後看一次時鐘；交給元件之後，那一步由橋接的上限結束（8 秒內沒準備好、30 秒內沒有回應），最晚約在 5 分鐘再加 38 秒。
- **清掉瀏覽器資料後，清冊編號的保護退回「清冊不能舊於 `L` 天」。** 換一個瀏覽器、無痕視窗也一樣。
- **頁面和 API 從同一台伺服器來時，這些檢查擋不住營運者本人**：改過的頁面可以不做這些檢查（ADR-0016）。
- PIN 是 JavaScript 的字串，沒辦法清成 0；做得到的是第二次簽章後（或流程停下、等了 5 分鐘時）不再持有它。
- **PIN 在兩次簽章之間留得比較久**：持卡人看現況、選、看後果的這段時間都在記憶體裡，最多 5 分鐘。分頁在背景、計時器被瀏覽器延後時，實際丟掉的時間可能晚一點（沒有量）；這段時間引擎不會再用它（每一步先看時鐘）。不想繼續的人按第 4、5 步的「取消」，PIN 立刻丟掉。
- **瀏覽器的密碼管理員會不會提議記住 PIN，沒有實測。** 欄位是 `autocomplete="off"`、沒有名稱、不在表單裡，但 Chrome 對密碼欄位不一定照 `autocomplete="off"`。無頭的 Chrome 沒有密碼管理員的提示可看。
- **元件的錯誤格式是讀程式得知的**（見「元件的橋接信任什麼」的表）。PIN 錯、鎖卡、沒有卡片的真實回應沒有實測；不認得的回應一律停下、顯示代碼，不猜、不重送。
- 只在 macOS 上的 Chrome 測過。Safari、Firefox、手機沒有跑過這裡的測試。`Cross-Origin-Opener-Policy: same-origin-allow-popups` 之下的元件視窗，只在無頭的 Chrome 和假元件之下測過。

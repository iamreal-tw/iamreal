# server

過卡的後台：發題目、回答一張卡片的現況、收證明並寫入名冊、鏡像內政部的廢止清冊、每天出快照，加上訪客看的頁面（首頁、常見問題、怎麼驗證、掛上去、島民證明、查詢頁、名冊頁，見「訪客看的頁面」），並在 `/proof` 提供過卡的頁面（`web/` 建置出來的檔案）。介面照 [`docs/api/card-proof.md`](../docs/api/card-proof.md)。

**這個目錄讓人檢查的事：規則有照做。** 名冊規則只有一份，在 `roster/`；這裡不重寫任何一條。現況、「這一筆寫進去會不會有效」都由 `roster.Rules` 回答，每一行紀錄的寫法、`seq` 由 `roster.ReadLine` 檢查，證明由 `verifier/` 驗，清冊由 `crl/` 讀。這裡只多了名冊規則以外、只有後台能做的幾件事：題目（發、10 分鐘、最多送 5 次、只能接受一次）、只收最新兩份清冊的樹根、清冊太舊時停止接受。

只引用 `verifier/`、`roster/`、`crl/`，和 SQLite 的驅動。

## 怎麼單獨執行

需要 Go 1.26、`bb` 6.0.0 和通用參數檔 `bn254_g1.dat`（取得方式見 `verifier/README.md`）。在程式庫的根目錄：

```
go build -o iamreal-server ./server

./iamreal-server serve    -data DATA -bb <bb> -crs <通用參數目錄> [-addr 127.0.0.1:8080] [-web <靜態檔目錄>] [-roster test|production] [-mirror=false]
./iamreal-server mirror   -data DATA
./iamreal-server snapshot -data DATA -bb <bb> -crs <通用參數目錄> [-out <目錄>] [-roster test|production]
```

| 子指令 | 做什麼 |
|---|---|
| `serve` | 跑後台。開機時從資料庫讀出全部紀錄重算現況（見「開機」）；之後每分鐘刪掉過期的題目；`-mirror` 開著時（預設）一開始和之後每小時抓一次內政部的清冊 |
| `mirror` | 抓一次內政部的清冊就結束。任何一份抓不到時結束碼是 1 |
| `snapshot` | 每日快照（見「每日快照」）。可以在 `serve` 跑著的時候執行：它用唯讀的方式開資料庫 |

| 選項 | 預設 | 說明 |
|---|---|---|
| `-data` | （必填） | 資料目錄，見「資料放在哪裡」 |
| `-bb`、`-crs` | （必填，`mirror` 不用） | `bb` 6.0.0 的路徑、放 `bn254_g1.dat` 的目錄。版本或 SHA-256 不對就不啟動 |
| `-roster` | `test` | 照哪一份名冊的表（接受的場合和平台）：`test`（測試名冊，`threads` 和 `test-example`）或 `production`（正式名冊，`threads`） |
| `-addr` | `127.0.0.1:8080` | `serve` 聽的位址 |
| `-web` | （無） | `serve` 在 `/proof` 一起提供的靜態檔目錄（`web/` 建置出來的檔案：`index.html` 是 `/proof`，其他檔案在 `/proof/` 底下）。沒給時 `/proof` 是 404，其他頁面照常 |
| `-mirror` | 開 | `serve` 要不要自己跑清冊鏡像 |
| `-restrict-late-switches` | 關 | `serve` 拒絕用到一個名額第 4、第 5 次更換的紀錄（`switch_restricted`，見「送出一筆的檢查順序」第 6 步）。關著時照名冊規則接受 |
| `-rebuild-views` | 關 | `serve` 開機前先清掉頁面用的衍生表，再從全部紀錄重建（見「頁面用的衍生表」） |
| `-out` | `DATA/roster` | `snapshot` 寫到哪個目錄 |

發證金鑰（驗證明、驗清冊）和內政部清冊的網址編在程式裡，沒有選項能換。**只有**用建置標籤 `iamrealtest` 建置的執行檔（`go build -tags iamrealtest ./server`，`testissuers.go`），三個子指令多三個選項：`-test-issuers <目錄>`（放 `issuer-G2.der`、`issuer-G3.der`，拋棄式的測試金鑰，取代內政部的）、`-test-moica <網址>`（假的內政部，提供 `G2.crl`、`G3.crl`）、`-test-clock <檔案>`（檔案裡寫一個整數，時鐘比這台機器的快幾天；每次讀時鐘都重讀這個檔案）。給 `web/` 的端到端測試（`web/test/e2e/ui.ts`）用：頁面算的假卡片的證明，由真的後台驗證、寫入；同一張卡片的過卡分到不同的日期（一張卡片一天最多 3 筆有效紀錄）。照這份 README 建置的執行檔沒有這三個選項。

## 資料放在哪裡

```
DATA/iamreal.sqlite   名冊的紀錄、發出去還沒刪掉的題目
DATA/crl/             清冊鏡像：每份清冊的原始位元組（SHA256.crl）、索引 index.jsonl；在 /crl/ 提供
DATA/roster/          公布的名冊：名冊目錄（每 1,000 筆一檔）、雜湊清單 hashes/、指紋檔 fingerprints.jsonl；在 /roster/ 提供
```

**SQLite 的表**（`store/sqlite.go`、`store/sqlite_view.go`）：

| 表 | 欄位 | 說明 |
|---|---|---|
| `records` | `seq` 和紀錄的其他八個欄位，寫法和名冊的那一行相同；另外留著一欄 `prev`（ADR-0021 之前的紀錄有這個欄位），寫入時是空字串、不讀，讓之前的資料檔照常打開；`accounts` 存清單從 `[` 到 `]` 的那一段文字，讀出時只接受這一種寫法（`verifier.ReadAccountsText`） | 只增不改。紀錄雜湊不存，從欄位算 |
| `challenges` | 題目、發出的時間、送出的次數、是否已接受 | 發出後存起來；過期（10 分鐘）後由 `serve` 每分鐘刪一次 |
| `view_state`、`view_cards`、`view_slots`、`view_history` | 頁面用的衍生表，見「頁面用的衍生表」 | 從 `records` 算出來，可以清掉重建 |

後台其他地方不碰 SQL，只經過 `store.Store` 這個介面：寫入一筆（`Append`，同一個交易裡把題目標成已接受、更新衍生表，而且 `seq` 必須接得上）、讀某一段（`Records`）、讀筆數（`Count`）、題目的三個動作，加上衍生表的維護（`ViewSeq`、`AddViews`、`ResetViews`）和頁面的五個查詢。之後證明搬到物件儲存、資料庫換掉，都只動 `store/`。

資料庫用 WAL 模式（快照可以邊讀）、`synchronous(FULL)`（寫入完成的紀錄斷電也不會掉）、一個連線（一個程式裡的讀寫一次一個）。

## 頁面用的衍生表

訪客看的頁面（島民證明、查詢頁、名冊頁）要的資料放在資料庫的衍生表裡，不靠記憶體裡的現況，也不靠開機時的重放回答每一次查詢。**紀錄才是依據**：衍生表是紀錄算出來的，`view_state` 記著它反映到第幾筆（`ViewSeq`），它就是第 1 筆到那一筆紀錄算出來的樣子，不多不少。

衍生表不自己判斷任何一筆是哪一種：每一筆在每個平台的種類由 `roster.Rules` 回答，前後的帳號、更換次數從規則的現況（`Rules.Card`、`Rules.CheckWithCard`）拿，`store.NewView` 把這些整理成一筆要寫的內容。

| 表 | 一列是 | 存什麼 |
|---|---|---|
| `view_state` | 只有一列 | `seq`：衍生表反映到第幾筆 |
| `view_cards` | 一張有有效紀錄的卡片（場合、匿名編號） | 短編號（匿名編號的前 10 個字元）、有效紀錄裡最早的日期（「第一次過卡」，也就是歷程最下面那一列的日期；一張卡片的日期不往回，所以就是照 `seq` 的第一筆有效紀錄的日期）、`last_card_proof`、有效紀錄的筆數 |
| `view_slots` | 一個用過的名額（卡片、平台） | 現在的帳號（或沒有）、從哪一天起和那一筆的 `seq`（新宣告、更換、更正、收回之後再次宣告時換成這一筆；再次過卡不動；收回時清掉）、更換次數、卡片的 `last_card_proof`（給數字用） |
| `view_history` | 一筆有效紀錄在一個有結果的平台 | 日期、規則的種類、這個名額在這一筆之前是不是收回的狀態、之前上次宣告的帳號、之後的帳號 |

`store.SlotChange.Event` 把規則的種類和「之前是不是收回的狀態」合起來，分成頁面要的幾種：新宣告、再次過卡、更換、更正、收回、收回之後宣告回同一個帳號、收回之後宣告別的帳號（分成更換和更正兩種）。

頁面的五個查詢，每一個都指定索引（`INDEXED BY`），只讀一段索引、不排序（`store/sqlite_view_test.go` 檢查查詢計畫）：

| 查詢 | 回答 | 索引 |
|---|---|---|
| `Cards(場合, 短編號)` | 對到的每張卡片的摘要和各平台現況，照匿名編號排 | `view_cards_short_id`；各平台用 `view_slots` 的主鍵 |
| `History(場合, 匿名編號)` | 這張卡片的有效紀錄，日期新的在前，同一天照 `seq` 新的在前 | `view_history_card` |
| `AccountCards(場合, 平台, 帳號名稱)` | 現在把名額給這個帳號的卡片，照「從哪一天起」早的在前，同一天照 `seq` | `view_slots_account` |
| `Recent(場合, 平台, before, n)` | 現在有帳號的名額，照「從哪一天起」的日期新的在前，同一天照那一筆的 `seq` 新的在前（和 `design/copy/roster-page.md` 相同），最多 `n` 筆；`before` 給上一頁最後一筆的位置（日期, `seq`）就接著拿 | `view_slots_latest` |
| `Counts(場合, 平台, 今天)` | 現在有帳號的卡片幾張；其中 `last_card_proof` 在今天往回 90 天以內（含第 90 天）的幾張。今天由呼叫的人給 | `view_slots_recency` |

`Counts` 只讀索引，但讀的是這個平台所有有帳號的名額，時間和張數成正比：一萬張約 1 毫秒、十萬張約 14 毫秒（`store/views_measure_test.go`）。之後要固定成本，可以加一張依 `last_card_proof` 日期分桶的計數表：每筆寫入時舊日期的桶減一、新日期的桶加一，查詢只讀最近九十幾個桶。

`Counts` 和 `Recent` 都是一個平台一個平台問。現在只有 Threads，「不分平台」的數字和清單（`design/copy/home.md` 第 2 段、`roster-page.md`）就是 Threads 的。有第二個平台時，「至少在一個平台有帳號的卡片」這一組查詢（張數、其中最近過卡的張數、跨平台的最近清單）要另外加。

**寫入**：送出一筆時，紀錄、題目標成已接受、衍生表的更新在同一個交易裡（`Append`）。任何一步失敗，三者都不變。衍生表沒有反映到前一筆時（見下面），帶著衍生表的寫入會被拒絕（`ErrViewsBehind`），什麼都不寫。後台寫的每一筆都帶衍生表；`Append` 不帶衍生表（`nil`）只有測試會用，用來繞過後台寫紀錄，這樣落後的部分在下次開機時補齊。

**開機時補齊**：開機時本來就會把全部紀錄重放一遍；`ViewSeq` 之後的每一筆，重放時順便算出衍生表要寫的內容，每 1,000 筆一個交易寫進去（`AddViews`）。這次升級之後第一次啟動，就是從第 1 筆整份建起來。開機的那一行紀錄的 `views_written_from` 是從第幾筆開始補（`0` 是不用補）。

**整份重建**（例如規則的顯示方式改了以後）：停掉 `serve`，用 `-rebuild-views` 啟動一次：

```
./iamreal-server serve -data DATA -bb <bb> -crs <通用參數目錄> -rebuild-views
```

開機前在一個交易裡清掉所有衍生表（`ResetViews`，`ViewSeq` 變回 0），接著照上面的方式從第 1 筆建起來。紀錄不動。建好之後照常提供服務，之後再重開不用帶這個選項。`serve` 跑著的時候不要用別的程式清衍生表：寫入會因為 `ErrViewsBehind` 失敗。

## 訪客看的頁面（`visitor.go`、`pages/`）

這些頁面由後台產生成完整的 HTML，沒有行內的樣式。**除了 `/verify` 和 `/hang/<短編號>`，頁面上沒有任何程式**（沒有 `<script>`、沒有 `on…=` 屬性）；那兩頁只載入一支自己網域的小程式 `/copy.js`（見下面「複製的按鈕」）。用到名冊的頁面每次打開都從衍生表查（`Cards`、`History`、`AccountCards`、`Recent`、`Counts`），不讀記憶體裡的名冊規則；寫入一筆之後，下一次打開就看得到。畫面上的每一句照 `design/copy/` 的文字檔（`home.md`、`faq.md`、`verify.md`、`hang.md`、`proof-page.md`、`account-page.md`、`roster-page.md`），寫在 `pages/templates/` 的樣板裡。天數照台灣的日期算（`clock.go`）。

| 路徑 | 內容 |
|---|---|
| `GET /` | 首頁（`home.md` 的導覽列、第 1 到 9 段）。只有 `/` 本身；`/index.html` 之類的路徑是 404 |
| `GET /faq` | 常見問題（`faq.md`）。每一題是小標、答案直接顯示，每一題有 `faq.md` 寫的 `id`（`/faq#security` 連到那一題） |
| `GET /verify` | 怎麼驗證（`verify.md`）。提示詞照原樣放在 `<pre>` 裡，載入 `/copy.js` |
| `GET /hang` | 把島民證明掛到個人檔案，沒有帶著島民證明的版本（`hang.md`「從首頁點進來時」）。沒有程式 |
| `GET /hang/<短編號>` | 帶著一張島民證明的版本（`hang.md` 第 2 部分和第 3 部分的兩行），載入 `/copy.js`。短編號的讀法和轉址照 `/p/`（不是標準寫法時 `301`）；對到剛好一張、而且它在 Threads 有帳號時顯示那個帳號；讀不出來、對不到、對到兩張以上、全部收回，都 `302` 轉到 `/hang` |
| `GET /p/<短編號>` | 島民證明。對到一張：`proof-page.md` 第 1 到 5a 段，或第 6 段（全部收回）；對到兩張以上：第 7 段；對不到：第 9 段，`404`。短編號照 `spec/scoped-id.md`「Short ID」的寬鬆讀法（不分大小寫、`O` 讀成 `0`、`I` 和 `L` 讀成 `1`），不是標準寫法時 `301` 轉到標準寫法；讀不出來（長度不對、有別的字元）也是第 9 段、`404`，頁面寫出訪客打開的那一段 |
| `GET /threads/@<名稱>` | 查詢頁（`account-page.md`），一張都沒有時也是 `200`。名稱有大寫時 `301` 轉到小寫；不合 Threads 的格式時 `404`，是自己的一頁（`account-page.md` 第 4 段，不寫出那個名稱）；沒有 `@` 時 `404` |
| `GET /roster` | 名冊頁（`roster-page.md`），一次 50 筆。`?after=<日期>.<seq>`（例如 `2026-11-17.123`）接著列這個位置之後的，「更多」就是這樣的一般連結；讀不出來的位置從頭列 |
| `GET /roster?q=<輸入>` | 查詢框（一般的 GET 表單）。去掉前後的空白和開頭的一個 `@`、把 A 到 Z 轉成小寫後合 Threads 的格式，就 `303` 轉到 `/threads/@<名稱>`；去掉之後是空的，就是一般的名冊頁；不合格式就顯示名冊頁，查詢框裡留著訪客打的字，下面多一行 |
| `GET /pages.css` | 這些頁面共用的樣式表，編在執行檔裡，帶 `ETag` |
| `GET /copy.js` | `/verify` 和 `/hang/<短編號>` 的複製按鈕，編在執行檔裡，帶 `ETag` |

- 頁面、樣式表和 `/copy.js` 只接受 `GET`、`HEAD`，其他方法 `405`（帶 `Allow: GET, HEAD`）。
- `/roster`（沒有結尾的斜線）是頁面，`/roster/` 底下仍然是公布的名冊檔案，兩者互不影響。
- 頁面用後台啟動時那一份名冊（`-roster`）開著的場合字串；測試名冊的每一頁最上面有一行「測試名冊」。
- 每一頁的頁首是 `home.md` 的導覽列（記號和「島民證明」連到首頁；「怎麼驗證」「名冊」「常見問題」「GitHub」；「我要換島民證明」連到 `/proof`），頁尾是 `home.md` 第 9 段（「怎麼準備」連到過卡頁面的說明頁 `/proof/help.html?topic=prepare`）。窄的螢幕上，四個連結排到記號和按鈕下面的第二列，不靠程式、不藏任何連結。
- 每一頁的 `<title>` 是預覽的標題後面加「｜島民證明」，首頁是「島民證明｜iamreal.tw」；除了名稱不合格式的查詢頁，每一頁都寫 `og:title` 和 `og:site_name`，只有首頁寫摘要（`og:description`），都不放圖（各頁文字檔的「連結被貼出去時的預覽」）。
- 首頁的兩個數字和名冊頁的是同一份（`Counts`，同一份最多 60 秒的暫存）。
- 首頁的常見問題和常見問題頁的答案是同一段樣板（`pages/templates/faq-answers.html`），文字只寫一次；首頁的七題用 `<details>` 折起來。
- 〈需要什麼〉（`home.md`）在樣板裡只寫一次（`parts.html` 的 `needs`），首頁第 1、8 段和島民證明第 5a 段都用它。
- 首頁縮小的島民證明是例子（`@alice`、`12 天前`、`7K2Q9FM4XD`），不是連結，也沒有「點進去看看 →」（範例頁還沒有，`home.md`「還沒定的」）。
- 「打開 Threads」連到 `https://www.threads.com/@<名稱>`（沒有帶著島民證明時 `https://www.threads.com/`），開新分頁，`rel="noopener noreferrer"`。帳號名稱放進網址和頁面之前一定是驗證過格式的小寫名稱，由樣板跳脫。

**複製的按鈕**（`pages/copy.js`）：不用任何套件、不連到任何地方，只做一件事：把按鈕的 `data-copy-text`，或 `data-copy` 指到的元素的文字，用 `navigator.clipboard.writeText` 寫進剪貼簿，成功之後按鈕的字換成 `data-copied`（「已複製」，`verify.md`、`hang.md` 寫的，和 `card-proof.json` 的相同）。`/verify` 的「複製」複製整段提示詞（`data-copy`）；`/hang/<短編號>` 的「複製連結」複製島民證明的完整網址 `https://iamreal.tw/p/<短編號>`（`data-copy-text`），頁面上標題下面、按鈕上面寫的是不帶 `https://` 的 `iamreal.tw/p/<短編號>`，和島民證明頁面的寫法相同。按鈕在 HTML 裡是 `hidden`，由這支程式打開：程式沒有執行時（被擋、舊的瀏覽器、沒有剪貼簿的介面）不會有按了沒反應的按鈕，提示詞和連結照樣在頁面上、選得起來。
- 島民證明第一屏的帳號超過 18 個字元時小一級（`pages.LongAccount`）。
- 第一版只有 Threads：頁面只列 Threads 的名額。測試名冊裡 `test-example` 的帳號不顯示。
- 首頁和名冊頁的兩個數字（`Counts`）在後台記住最多 60 秒（`countsMaxAge`，兩頁共用一份），台灣的日期換了就重算；清單和其他頁不暫存。
- Threads 的個人檔案用直接寫的 `<iframe>` 嵌入，不載入 `embed.js`：`sandbox="allow-popups allow-popups-to-escape-sandbox"`（框裡 Threads 的程式不執行，連結可以在新分頁打開）、`referrerpolicy="no-referrer"`、`credentialless`。高度固定（360，窄螢幕 380），框內可以捲動；框自己有一條線、圓角和白底，整個看起來是一個白色方塊。帳號名稱放進網址之前一定是驗證過格式的小寫名稱，由樣板跳脫。
- 頁面出錯（資料庫讀不到）時回 `500` 和一行純文字，錯誤記在紀錄裡（寫哪一種頁面，不寫網址裡的短編號或帳號）。頁面的請求不記連線紀錄，和靜態檔相同。

### 頁面的標頭

這些頁面、樣式表和 `/copy.js` 送自己的一組（`visitor.go` 的 `visitorHeaders`），和過卡頁面的 `pageHeaders` 分開，過卡頁面的不變：

```
Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self'; frame-src https://www.threads.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Cross-Origin-Opener-Policy: same-origin
Cache-Control: no-cache
```

`/verify` 和 `/hang/<短編號>` 載入 `/copy.js`，送的是同一組，只有 `Content-Security-Policy` 多一項 `script-src 'self'`（`scriptPageHeaders`）：

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; frame-src https://www.threads.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

- **`Content-Security-Policy`**：除了那兩頁，頁面沒有程式，所以完全不開 `script-src`；那兩頁只開自己網域的程式（就是 `/copy.js` 這一支），行內的 `<script>` 和 `on…=` 都不能執行。樣式只有自己的 `/pages.css`（行內的 `style` 屬性和 `<style>` 都不能用，記號是行內的 SVG，顏色靠樣式表的 class）；`frame-src` 只開 Threads，是為了嵌入個人檔案，其他網站的框都擋；`form-action 'self'` 讓查詢框送回自己；`frame-ancestors 'none'`：這幾頁不能被別的網站放進框裡。
- **沒有嵌入框的頁面也送 `frame-src https://www.threads.com`**（首頁、常見問題、怎麼驗證、掛上去、名冊頁）：沒有程式的頁面自己做不出框，這一項在那裡什麼都不放行；兩頁有程式，`/copy.js` 也不做框，最多能放進來的是 Threads 的頁面，那兩頁上沒有任何持卡人的資料。所有訪客的頁面維持同一組（加上 `script-src` 的那一個變化），比每一頁各自一組容易檢查。要拿掉也只是在 `visitor.go` 再分一組。
- **`Referrer-Policy: no-referrer`**：點出去的連結和嵌入框的請求都不帶這一頁的網址（嵌入框本身也加了 `referrerpolicy`）。
- **`Cross-Origin-Opener-Policy: same-origin`**：用 `window.open` 開了這一頁的別的網站碰不到它。這幾頁不用開內政部元件的視窗，所以不需要過卡頁面的 `same-origin-allow-popups`。
- **`Cache-Control: no-cache`**：每次都回來確認，寫入一筆之後不會看到舊的頁面；樣式表和 `/copy.js` 帶 `ETag`，沒變就是 `304`。
- **不送** `Cross-Origin-Embedder-Policy`、`Document-Isolation-Policy`：送了 `require-corp`，瀏覽器會擋掉 Threads 的嵌入框（Threads 的回應帶 `Cross-Origin-Resource-Policy: same-origin`）。這幾頁不需要跨來源隔離。

## 介面

照 `docs/api/card-proof.md`，欄位、狀態碼、錯誤代碼一字不差。所有回應是 JSON，帶 `Cache-Control: no-store` 和 `X-Request-Id`（這個請求在紀錄裡的請求編號，持卡人回報問題時說得出來）；不設 cookie，不送 CORS 標頭。

文件沒有列、這裡另外用到的三個錯誤代碼：

| 狀態 | 代碼 | 什麼時候 |
|---|---|---|
| `404` | `not_found` | `/api/` 底下沒有這個路徑 |
| `405` | `method_not_allowed` | 方法不對（例如 `GET /api/v1/records`），帶 `Allow` 標頭 |
| `500` | `internal` | 後台自己出錯（資料庫、`bb` 跑不起來、亂數來源）；原因記在紀錄裡，附請求編號 |

`429` `rate_limited` 的代碼留著，這一段沒有做限流。

請求的內容最多 64 KB。內容必須剛好是文件列的那幾個鍵、每個一次、值都是字串（`records` 的 `accounts` 除外，它是清單）；多一個鍵、少一個鍵、同一個鍵兩次、鍵的大小寫不同、值不是字串、物件後面還有東西，都是 `malformed`（`request.go`）。這一層的問題在檢查場合之前就回 `malformed`，和改清單之前的做法相同。

`card-state` 的回應照介面文件：卡片層級的 `last_card_proof`、`proofs_on_last_date`，加上 `platforms`，這份名冊平台表上的每個平台一項（`current`、`last_declared`、`switch_count`、`correction_date`），卡片在那個平台有沒有帳號都列；`platforms` 裡的順序沒有意思（照代號排）。後台只送事實，今天剩幾筆、剩幾次更換、今天換帳號計不計次由裝置自己算。

`config` 回 `crl_max_age_days` 和 `platforms`：這份名冊的平台表（`verifier.Platforms`），照代號排，每一列是 `platform`、`display_name`、`username_format`（格式的字串，和規格的表一字不差）。`api_test.go` 用不靠正規表示式的讀法讀每個格式字串（裝置會這樣讀），確認它接受的和 `verifier` 的檢查函式完全相同。

### 送出一筆的檢查順序（`submit.go`）

照介面文件的順序，第一個不通過的決定錯誤代碼：

1. **每個欄位的格式。** 場合不是這份名冊接受的是 `scope`；`accounts` 是清單、每一項剛好是 `platform` 和 `username` 兩個鍵（各一次、都是字串），而其中一個平台不在這份名冊的平台表裡，是 `platform`；其他（`accounts` 不是清單、某一項不是這個形狀、平台重複、順序不對、帳號名稱不合它平台的格式、其他欄位）是 `malformed`。清單照送來的樣子用：不排序、不和卡片現在的清單合併、不補任何東西；照平台排好的同一份清單才是卡片簽的那一份，別的順序是 `malformed`。帳號的兩個鍵哪個先寫、有沒有空白都可以：紀錄的那一行由後台照樣板寫。
2. **題目**：沒發過或已經過了 10 分鐘（剛好 10 分鐘就算過期）是 `challenge_unknown`；已經接受過一筆是 `challenge_used`；這次是第 6 次以上送出是 `challenge_attempts`。走到這一步就算一次送出，之後的檢查失敗，題目仍然可以再用，最多 5 次。
3. **驗證證明**（`verifier/`，`bb` 在子行程裡跑）：不通過是 `proof`。
4. **清冊的樹根**：這把發證金鑰在鏡像裡最新的清冊（照清冊編號，只算可用的）超過 3 天（今天的台灣日期 − 清冊日期 > 3）或一份都沒有，是 `503` `crl_stale`；樹根不是最新兩份之一的，是 `root`。
5. **名冊規則**（`roster.Rules.Check`）：`root`、`date_order`、`empty`、`switch_limit`、`daily_limit`。`switch_limit` 不說是哪個平台；整份清單都不寫入。
6. **後台自己的更換政策**（預設沒有）：開了 `Config.RestrictLateSwitches`（`serve` 的 `-restrict-late-switches`）時，規則接受的紀錄，只要有一個平台的種類是 `switch`、而那個名額寫入後的更換次數是 4 或 5，就是 `403` `switch_restricted`，整份清單不寫入。這是後台的規則，不是名冊的（`spec/roster-rules.md`「Not part of these rules」）。預設關著，規則接受的都接受。沒有 `switch` 的紀錄、更換都在前 3 次的紀錄、`correction`，不會因為這一條被拒絕。

全部通過才寫入，寫入、題目標成已接受和衍生表的更新在同一個交易裡，再用 `roster.Rules.Apply` 更新記憶體裡的現況。第 5 步用的是 `roster.Rules.CheckWithCard`：和 `Check` 相同的答案，加上這張卡片寫入後的狀態，衍生表要的前後帳號和更換次數從這裡拿。回應的 `kinds` 是這筆紀錄在每個有結果的平台的種類，照平台排，每一項有 `platform`、`kind`、`username`（清單裡那個平台的帳號；收回時是被收回的那個）和 `account_cards`：套用後這個場合裡目前在那個平台宣告這個帳號的卡片數，由 `roster.Rules.AccountCards` 從同一份現況算（`server/` 不重寫規則），也在那把鎖裡。步驟 4、5 和寫入在同一把鎖裡做，一次一筆：兩個請求同時送出時，`seq` 連續，鏈不斷；同一個題目同時送兩次，只有一次被接受，另一次是 `challenge_used`。

### 時間

所有日期都是台灣日期（UTC+8，固定時差，不讀機器的時區設定）。題目的日期是發出那一刻的台灣日期，所以 23:59:59 發的是當天，00:00:00 發的是隔天。時鐘在測試裡可以換掉（`Config.Now`）。

## 開機

`serve` 開機時從資料庫一筆一筆讀出全部紀錄，每一筆：

- 用 `roster.ReadLine` 檢查這一行的寫法、`seq`（和重驗的人一樣）；
- 用 `roster.Rules.Apply` 套用規則。證明不重驗（寫入時驗過了，每日快照會全部重驗）；清冊的樹根照樣檢查，用鏡像的索引 `index.jsonl`；
- 這一筆在 `ViewSeq` 之後時，算出它在衍生表要寫的內容，每 1,000 筆寫一次（見「頁面用的衍生表」）。

任何一筆寫法錯、`seq` 接不上、無效（包括它用的清冊不在鏡像裡了），就不啟動，印出是第幾筆、哪個代碼。衍生表反映到的筆數比紀錄多時也不啟動。

## 清冊鏡像（`mirror.go`）

內政部的兩個網址寫在 `mirror.go` 的 `moicaCRLs`（G2：`http://moica.nat.gov.tw/repository/MOICA/CRL2/complete.crl`，G3：`http://crl-moica.moi.gov.tw/crl/MOICA-G3-complete.crl`，和 `crl/README.md` 寫的相同）。清冊有內政部的簽章，用 HTTP 抓也能檢查。

- 每小時對每個網址送一次條件請求（`If-None-Match`、`If-Modified-Since`，用上一次回應的 `ETag`、`Last-Modified`）。`304` 就什麼都不做。這兩個值只放在記憶體：程式重開後第一次會整份下載，內容看過就不再存。
- 內容的 SHA-256 在索引裡已經有，就不存。沒有的話存成 `SHA256.crl`（64 個小寫十六進位數字），再用 `crl.IndexFile` 算出這一行，加進 `index.jsonl`、照規格排序。可用不可用都存、都列一行（規格「Archive index」）。
- 先寫成 `.` 開頭的暫存檔再改名，所以後台和下載的人不會讀到寫一半的檔案；`.` 開頭的檔案不算存檔的一部分，也不提供下載。
- `User-Agent` 是 Go 預設的 `Go-http-client/1.1`，不帶專案或個人資訊。

## 每日快照（`snapshot.go`）

一個子指令，排程每天跑一次。

1. 讀出全部紀錄，接成名冊檔案。
2. 用 `crl.RebuildArchive` 從清冊檔案重建索引（重新驗章、建樹）。和 `index.jsonl` 有任何不同就不發布。
3. 用 `roster.Check` 完整重算：每一份證明都用 `bb` 重驗。名冊不成立、或有任何無效的紀錄，就不發布，印出是哪一筆、哪個代碼（ADR-0014）。
4. 已經公布的檔案必須是現在名冊的開頭：寫滿的檔和雜湊清單位元組相同，最後一個檔和它的清單是現在那一份的開頭；`fingerprints.jsonl` 的每一行都要是這份名冊在那個筆數的名冊指紋。不是的話不發布。
5. 寫名冊目錄和雜湊清單（`roster.DirectoryFiles`：每 1,000 筆一檔，檔名是這一檔之前的筆數寫成 16 位數字），**寫滿的檔和清單不重寫**；再寫今天的卡片狀態檔 `card-state/<日期>.jsonl`（`spec/roster-rules.md`「The card state file」，內容是第 3 步重算出來的每張卡片的狀態；`iamreal-verify` 對指紋檔最後一行那天沒有卡片狀態檔的目錄會報問題）；最後在 `fingerprints.jsonl` 加今天（台灣日期）一行。

結束碼：`0` 發布了（或今天已經發布過同一個名冊指紋，什麼都不用做）；`1` 有東西不對，什麼都沒寫；`2` 沒辦法檢查（讀不到檔案、`bb` 不對）。同一天第二次跑、但名冊多了紀錄時，因為一個日期只能有一行，結束碼是 `1`。

## 連線紀錄記了什麼（`log.go`）

`/api/` 的每一個請求一行 JSON，寫到標準錯誤，**只有**：時間、請求編號（每次隨機產生）、方法、路徑（不是五個介面之一時寫 `other`）、狀態碼、錯誤代碼、程式版本（建置時的 git 提交）。

**不記**：IP 位址和連接埠（連 `X-Forwarded-For` 之類的標頭也不讀）、任何標頭、請求的內容：匿名編號、帳號名稱、題目都不記。要題目的請求不記題目本身。五個介面用同一條規則，所以沒有哪一個會記錯。`net/http` 自己的錯誤訊息可能含有對方的位址，所以只記「出了錯」，不記內容。靜態檔（`/crl/`、`/roster/`、網頁）不記。

後台自己出錯時另記一行，附請求編號和出錯的地方，不附請求的內容。

## 回應標頭

所有回應都送的標頭寫在 `headers.go` 的 `responseHeaders`：`X-Content-Type-Options: nosniff`。訪客看的頁面、樣式表和 `/copy.js` 另外送 `visitorHeaders`（見「頁面的標頭」）。`-web` 目錄的每個檔案（`/proof` 的頁面，和 `/proof/` 底下它的程式和 worker、電路、通用參數、說明頁；`/proof/` 轉到 `/proof` 的那一個轉址也是）另外送 `pageHeaders`，和過卡頁面搬到 `/proof` 之前在 `/` 送的相同；`/proof` 以外的路徑都不送：`web/README.md` 寫的 `Content-Security-Policy`、`Document-Isolation-Policy: isolate-and-credentialless`（多執行緒的證明，同時保留和內政部元件視窗的來往）和 `Cross-Origin-Opener-Policy: same-origin-allow-popups`（用 `window.open` 開了這一頁的別的網站，碰不到這一頁和它開的元件視窗）。理由在 `web/README.md`「頁面需要的標頭」；`server_test.go` 檢查那裡引用的和這裡一字不差。清冊鏡像和名冊不送這三個。

過卡的頁面只有一個網址 `/proof`（`web/` 建置時的 `base` 是 `/proof/`，頁面裡的每個路徑都從網站的根目錄算起：`/proof/assets/…`、`/proof/circuits/…`、`/proof/crs/…`、`/proof/bb/…`、`/proof/help.html`）。`/proof/` 是 `301` 轉到 `/proof`；`/proof/index.html` 照 `net/http` 的做法轉到 `/proof/`，再轉到 `/proof`。API（`/api/`）、清冊鏡像（`/crl/`）、名冊（`/roster/`）的路徑不變，頁面照舊從那裡拿。

靜態檔：`.crl` 是 `application/pkix-crl`，`.jsonl` 是 `application/jsonl`。不列目錄，`.` 開頭的檔案不提供。

## 測試

```
go test ./server/...
IAMREAL_BB=/path/to/bb go test -tags iamrealtest ./server    # 加上真證明的端到端測試
go test -race ./server/...
```

| 檔案 | 測什麼 |
|---|---|
| `store/sqlite_test.go` | `seq` 接不上（跳號、重號）就不寫；題目沒發過或已接受就不寫紀錄；送出次數；刪過期題目；重開、唯讀 |
| `store/sqlite_view_test.go` | 衍生表，用和後台相同的寫法（`CheckWithCard`、`NewView`、`Append`、`Apply`）一筆一筆寫，每個查詢的結果都和名冊規則的現況比對（另外由測試自己從規則的現況記下「從哪一天起」、第一次過卡、筆數、歷程，不靠衍生表）：一張卡片走過每一種（新宣告、更正、再次過卡、更換、全部收回、收回後宣告回同一個、收回後宣告別的（更換、當天的更正）；往前一天的日期是 `date_order`，不寫入），歷程的順序、前後帳號、從哪一天起、更換次數；一筆改兩個平台；同一個帳號的好幾張卡片照從哪一天起、同一天照 `seq`，再次過卡不動、換回來重新起算、收回就不列、別的平台同名是別的帳號；短編號相同的兩張照匿名編號排、對不到的（小寫、9 個和 11 個字元、別的場合）；數字的第 90 天算、第 91 天不算、全部收回的不算；第一次過卡是最早的日期，等於歷程最下面那一列；往前兩天的紀錄是 `date_order`，不寫入；最近的清單照日期再照 `seq`（往回一天的那一筆排在它的日期）、一頁一頁接著拿、從同一天的中間接著拿、剛好拿完、再次過卡不會回到最上面；`spec/vectors/roster-rules.json` 的每個案例（只寫有效的紀錄，並確認少了無效的紀錄結果不變）。每個情況都清掉衍生表、從紀錄重建（一次 1 筆、3 筆、1,000 筆），逐列和一筆一筆寫的相同。交易：寫到一半失敗（第二個平台的歷程寫不進去）、衍生表不是這一筆的、題目已用過，紀錄、衍生表、題目都沒變；衍生表落後時帶衍生表的寫入被拒絕，`AddViews` 跳號、對不上紀錄、中途失敗時都不寫，補齊之後和重建的相同。查詢計畫：每個查詢只讀一段索引、不排序 |
| `store/views_measure_test.go` | 量測（平常略過，`IAMREAL_VIEW_MEASURE=<卡片數> go test -run TestMeasureViews -v ./server/store`）：假資料建名冊、重建衍生表的時間、`synchronous(FULL)` 下寫入一筆帶和不帶衍生表的時間、每個查詢的時間 |
| `api_test.go` | 每個介面每個錯誤代碼：題目的日期在台灣午夜前後；`config` 的平台表（兩份名冊；格式字串和檢查函式一致）；`card-state` 的形狀（每個平台一項、沒用過的名額、收回後保留上次宣告的帳號、`switch_count`、`correction_date`）、每一種 `malformed`，回應的欄位順序；正式名冊的後台只列 `threads`、測試平台是 `platform`；`records` 的每一種 `malformed`（清單：不是清單、`null`、某一項的鍵不對、平台重複、順序相反、帳號名稱是別的平台的格式；帳號的鍵換順序和空白照常接受）、`scope`（比 `platform`、`malformed` 先）、`platform`（比帳號名稱的格式先；不算進 5 次）、`challenge_unknown`（沒發過；剛好 10 分鐘；差 1 奈秒仍可用，跨過午夜）、`challenge_used`、`challenge_attempts`（失敗 4 次後第 5 次仍可成功；失敗 5 次後第 6 次被擋）、`proof`、`root`（第三新的清冊、別把金鑰的樹根、不存在的樹根）、`crl_stale`（清冊日期後第 3 天 23:59:59 可以、第 4 天 00:00:00 不行；新清冊進來後恢復；這把金鑰沒有清冊）、`date_order`、`empty`（沒有帳號的卡片送空清單；收回全部之後再送一次）、`switch_limit`（第 6 次更換，整筆不寫入，另一個平台也沒變；那個平台不動時另一個平台照常可以改；第 5 次之後當天的 `correction` 照常可以）、`switch_restricted`（預設和開了 `-restrict-late-switches` 兩種狀態：第 4、第 5 次更換被接受或被拒，前 3 次、`correction`、沒有更換的紀錄都不受影響，被拒時不寫入、題目仍可用，規則的代碼優先）、`daily_limit`（同一張卡片同一天第 4 筆被擋、不寫入，不管改哪個平台，被別的規則擋下的不算，別張卡片不受影響，隔天又可以；午夜前發的題目過了午夜送出，仍算前一天）；送出成功時的 `kinds`（每個平台一項、照平台排、收回時帶被收回的帳號；`account_cards` 只算同一個平台的同一個帳號名稱；欄位的順序；錯誤時沒有這個欄位）；`404`、`405` |
| `views_test.go` | 送出成功就更新衍生表，內容和記憶體裡規則的現況相同；清掉衍生表後重開，重建的和一筆一筆寫的相同；衍生表是最新的時候重開不用補；繞過後台寫進去的 1,001 筆（超過一批）在開機時補齊 |
| `server_test.go` | 20 個請求同時送出時 `seq` 連續、`head` 是存著的紀錄的名冊指紋，同一個題目同時送兩次只接受一次；重開後現況相同；有無效紀錄、清冊不見、索引寫錯、名冊屬於另一份時不啟動並指出第幾筆；紀錄裡沒有對方的位址、匿名編號、帳號、題目，只有該有的欄位；每個 API 回應的 `X-Request-Id` 和那一行紀錄的請求編號相同，靜態檔沒有；靜態檔，頁面的標頭只在網頁目錄的檔案上（`/proof` 和 `/proof/` 底下）；`web/README.md` 引用的 CSP 和這裡的相同 |
| `mirror_test.go` | 假的內政部伺服器：第一次下載並建索引（和 `crl.BuildIndex` 相同）、之後送條件請求、新清冊加一行、同樣的內容換了 `ETag` 不重存、不是清冊的檔案也存並列為不可用、錯誤狀態不存；索引寫錯時不動存檔 |
| `snapshot_test.go` | 空名冊、1,001 筆切成兩個檔和兩份雜湊清單（第二份的第一行是前 1,000 筆的名冊指紋）、同一天再跑什麼都不做、隔天寫滿的檔和清單不重寫；有無效的紀錄、證明驗不過、清冊索引和檔案不同、已公布的檔或雜湊清單被改過、`fingerprints.jsonl` 不是這份名冊的或寫法不對時，都不發布 |
| `visitor_test.go` | 訪客看的頁面，經過後台的路由：每一種情況的頁面包含文字檔裡那一種情況的每一句，照順序（直接讀 `design/copy/` 的程式碼區塊和 `proof-page.md` 第 4 段的表，把例子的值換成測試資料的值，空白不計；第 5a 段的最後一行讀 `home.md` 的〈需要什麼〉）。島民證明：文字檔例子的那張卡片（更換過 1 次）、更換 0 次、上次過卡是今天、「全部紀錄」的每一種列（含收回之後宣告回同一個、宣告別的帳號的更換和更正）、全部收回（帳號取歷程裡最後一筆收回）、短編號對到兩張（照匿名編號排、寫到分得開的長度、第 5 段只出現一次）、對不到和讀不出來（`404`）、寬鬆的寫法轉址、超過 18 個字元的帳號小一級；`<title>`、`og:title`、`og:site_name`。查詢頁：一張、兩張（照從哪一天起，不照上次過卡）、上次過卡是今天、零張（`200`）、短編號相同的兩張、大寫轉址、格式不對是第 4 段的那一頁（`404`）；預覽。名冊頁：有資料（數字、順序、過了三個月的照算、全部收回的不列）、沒有資料（那一句，沒有清單上方的說明和「更多」）、50 筆和「更多」、讀不出來的位置、查詢框的正常、帶 `@`、大寫和前後空白、空的（一般的名冊頁）、格式不對（保留打的字）；預覽。每一頁（這裡和 `site_test.go` 打開的每一頁都檢查）：沒有 `<script>`（`/verify`、`/hang/<短編號>` 只有 `/copy.js` 那一支）、沒有 `on…=`、沒有行內樣式、沒有 `description` 和 `og:image`（`og:description` 只在首頁）；頁首（`home.md` 的導覽列）、頁尾（`home.md` 第 9 段）一字不差；「測試名冊」只在測試名冊；嵌入框的寫法。網址裡的 HTML 和 `javascript:` 被跳脫。標頭：每一頁、樣式表和 `/copy.js` 送的正是那一組（那兩頁多 `script-src 'self'`），沒有別的標頭，過卡頁面和 `/roster/` 底下的檔案沒有它；`HEAD` 可以、其他方法 `405`；樣式表的 `304`。寫入一筆之後頁面馬上反映，名冊頁的數字最多晚 60 秒 |
| `site_test.go` | 首頁、常見問題、怎麼驗證、掛上去，和過卡頁面搬到 `/proof`，文字的比法和 `visitor_test.go` 相同。首頁：導覽列、第 1 到 9 段的每一句照順序（第 6 段每一題後面接 `faq.md` 同一題的答案），連結（看已經換出的島民證明、掛到個人檔案、零知識證明、更多常見問題，兩個「我要換島民證明」都到 `/proof`），七題各是一個 `<details>`，縮小的島民證明不是連結、沒有「點進去看看」；`<title>`、`og:title`、`og:site_name`、`og:description`（等於第一屏的兩行）；〈需要什麼〉在首頁兩次、島民證明一次，都是 `home.md` 那一句；數字跟著名冊變，60 秒內不變、到了就變，名冊頁和首頁共用同一份。常見問題：標題、四類、每一題和答案照順序，最後一題之後直接是頁尾；22 題，每一題是帶著 `faq.md` 寫的 `id` 的小標，頁面上的 `id` 不重複；`design/copy/` 每一份文字檔裡寫的 `/faq#…` 都在頁面上；答案不折起來；「了解更多」連到「這個技術安全嗎？」、「完整的說明」連到 ADR-0004（檔案存在）、GitHub、粗體的「注意：」；首頁七題的答案和常見問題頁的 HTML 相同；預覽。怎麼驗證：四塊的每一句，提示詞在 `<pre>` 裡和 `verify.md` 一字不差（含換行和空白），「複製」按鈕和「已複製」（`verify.md` 寫的，和 `card-proof.json` 的相同），`cmd/iamreal-verify` 的連結（檔案存在）；預覽。掛上去：帶著島民證明的版本（第 2 部分和第 3 部分的每一句、寫出的連結（不帶 `https://`）、「複製連結」複製帶 `https://` 的完整網址、「打開 Threads」連到那個帳號、新分頁和 `noopener noreferrer`、「打開你的島民證明」連到 `/p/…`，沒有「還沒有島民證明？」）；沒有帶著的版本（那一段的每一句、「打開 Threads」連到 `https://www.threads.com/`、「我要換島民證明」，沒有任何按鈕、沒有第 3 部分）；`/hang/<短編號>` 的每一種：一張而且有帳號是 `200`，對不到、對到兩張、全部收回、讀不出來（太短、太長、別的字元、空的、斜線、HTML）是 `302` 到 `/hang`，寬鬆的寫法 `301` 到標準寫法；預覽。`/copy.js`：內容、標頭、`ETag`，裡面沒有任何連出去的東西。搬到 `/proof`：`/proof`（帶查詢字串也是）、`/proof/help.html`、`/proof/assets/…` 是 `200`，送的標頭剛好是 `pageHeaders` 和 `X-Content-Type-Options`（加上檔案本身的），沒有別的；`/proof/` 轉到 `/proof`；`/proof/index.html` 不是頁面；`POST` 是 `405`；`/` 是首頁；`/index.html`、`/help.html`、`/assets/…` 是 `404`、沒有過卡頁面的標頭；沒有網頁目錄時 `/proof` 是 `404`，其他頁面照常 |
| `preview_test.go` | 不是測試：在本機看訪客的頁面用（平常略過）。`IAMREAL_PAGES_PREVIEW=127.0.0.1:8090 IAMREAL_PAGES_PREVIEW_ACCOUNTS=<a>,<b>,<c>,<不存在的名稱> go test -run TestPagesPreview -timeout 0 ./server`：用假紀錄建一份測試名冊，聽在那個位址直到停掉，開頭印出每一種情況的網址。頁面會真的嵌入那幾個帳號的 Threads 個人檔案，所以只填大型機構或政府單位的帳號，不填個人的。`IAMREAL_PAGES_PREVIEW_EMPTY=1` 是空的名冊；`IAMREAL_PAGES_PREVIEW_WEB=<web 的建置目錄>` 在 `/proof` 一起提供過卡的頁面（只看得到畫面：這個預覽沒有內政部的清冊，過不了卡） |
| `pages/pages_test.go` | 不開伺服器，直接用資料產生頁面：沒有程式和行內樣式（怎麼驗證和帶著島民證明的掛上去只有 `/copy.js`）、網址來的字跳脫、不合格式的帳號和不認得的紀錄種類不產生頁面（掛上去也不收不合格式的帳號、不是標準寫法的短編號）；數字的千分位、分得開的長度、「更多」的位置的寫法和讀法 |
| `e2e_test.go` | 建置標籤 `iamrealtest`、需要 `bb`：用 `testdata/` 的真證明（見那裡的 `README.md`）從假的內政部抓清冊，跑兩個平台的清單：宣告、當天更正（`correction`）、再次過卡、更換、第 4 次更換被開了 `-restrict-late-switches` 的後台拒絕（`403` `switch_restricted`，證明驗得過）、漏掉一個帳號就是收回、空的清單收回全部、沒有帳號時的空清單（`empty`）、同一張卡片同一天第 4 筆（`daily_limit`）；每一筆成功的之前，同一份證明配上改了一個帳號、少一個帳號的清單都是 `proof`，順序對調的清單是 `malformed`；出快照（每份證明用 `bb` 重驗），用 `go build -tags iamrealtest` 建出的 `iamreal-verify` 重驗那個目錄，結果和後台的現況相同；換成內政部的金鑰時快照拒絕發布 |

## 檔案

| 檔案 | 內容 |
|---|---|
| `main.go` | 三個子指令和選項 |
| `server.go` | `Config`、開機時重算現況 |
| `api.go` | 路由、回應、`challenges`、`card-state`、`config`、`head`（`head` 欄位現在是名冊指紋：存著的全部紀錄的名冊指紋，不是最近一次公布的） |
| `submit.go` | `records`：送出一筆的檢查和寫入 |
| `request.go` | 嚴格讀請求的 JSON |
| `crls.go` | 鏡像的索引：名冊規則的 `CRLArchive`、最新兩份和 3 天的檢查 |
| `clock.go` | 台灣日期、10 分鐘、5 次、3 天 |
| `mirror.go` | 清冊鏡像 |
| `snapshot.go` | 每日快照 |
| `log.go` | 連線紀錄、程式版本 |
| `headers.go` | 路由、回應標頭、過卡頁面的標頭、靜態檔 |
| `visitor.go` | 訪客看的頁面：讀網址、查衍生表、轉址和狀態碼、頁面的標頭、首頁和名冊頁數字的暫存 |
| `pages/` | 頁面的樣板（`templates/`；常見問題的題目和答案在 `faq-answers.html`，首頁和常見問題頁共用）、樣式表（`style.css`）和複製按鈕的程式（`copy.js`），用 `embed` 編進執行檔；把資料變成 HTML 的函式，不碰 HTTP |
| `testissuers.go` | 只在建置標籤 `iamrealtest` 下：測試金鑰、假內政部和時鐘的選項 |
| `store/` | 名冊、題目和頁面用的衍生表的儲存：介面和 SQLite 的實作（`view.go` 是衍生表的型別和 `NewView`，`sqlite_view.go` 是它的表和查詢） |
| `testdata/` | 端到端測試的資料 |

## 第三方套件

- `modernc.org/sqlite` v1.62.0：SQLite 的驅動，純 Go，不需要 cgo。只有 `store/` 引用它。

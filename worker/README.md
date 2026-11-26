# worker/：後台

**這個目錄讓人檢查的事：規則有照做。** 這裡是 Cloudflare 上的後台（ADR-0023），一個 Worker 專案。紀錄規則、場合字串這些算法在 [`protocol/`](../protocol)，這裡只引用它，不引用這個程式庫的其他目錄。

## 現在有什麼

還沒做完：清冊鏡像、過卡的四個介面（發題目、卡片現況、送出一筆、設定）、每一種訪客頁面、過卡的頁面有了，寫滿的紀錄檔會搬到 R2，證明紀錄每天換日公布一次；限流有了照 IP 的那一層、全站的總量上限和 Durable Object 撐不住時的 `busy`。Go 的舊後台 `server/` 逐案比對完，2026-11-22 刪掉了（[#74](https://github.com/iamreal-tw/iamreal/issues/74)）；它的每個測試檔的案例在這裡的哪一組測試，列在那張票的 PR 說明。

| 有 | 還沒有 |
|---|---|
| 清冊鏡像（[排程做什麼](#排程做什麼)）：每小時抓內政部的兩份廢止清冊，原始位元組存進 R2 的 `crl/<SHA-256>.crl`，驗章、建樹，寫清冊存檔的索引 `crl/index.jsonl`。`crl/testdata/` 的每一案和 Go 的 `crl/` 比對過 | |
| 證明紀錄的 Durable Object：題目表、紀錄、卡片狀態表、證明紀錄的一列（[題目、卡片現況、設定](#題目卡片現況設定)、[送出一筆](#送出一筆)），和每把發證金鑰最新兩份可用清冊的樹根、編號、日期 | |
| 限流（[限流](#限流)）：照 IP 的上限，題目、卡片現況、送出、公開的讀取、計數、頁面六類分開算，IPv4 照單一位址、IPv6 照 /64，超過回 `429` 和 `Retry-After`，訪客頁面回一頁說明；全站的總量上限，只數開始過卡的那一次 `config?start`；Durable Object 撐不住時介面回 `503` `busy`、頁面回人太多的那一頁 | 兩個 app 對 `429`、`busy` 的處理；WAF 的那一條規則和挑戰頁還沒有在測試網站設過 |
| 收計數（[計數](#計數)，ADR-0032、ADR-0039）：`POST /api/v1/counts` 照 `spec/counts.md` 的表收，不合的整筆丟掉；收下的交給專門收計數的 Durable Object，每分鐘寫成不公開的儲存桶裡 `count-events/` 底下的一個檔，裡面沒有 IP，留 31 天；每分鐘的明細有上限；每小時公布最舊一檔的日期。送計數的客戶端現在只有網頁版的過卡 | 加總（[#435](https://github.com/iamreal-tw/iamreal/issues/435)）、營運者看數字的那一頁（[#436](https://github.com/iamreal-tw/iamreal/issues/436)）、訪客頁面和兩個 app 送計數（[#275](https://github.com/iamreal-tw/iamreal/issues/275)、[#433](https://github.com/iamreal-tw/iamreal/issues/433)、[#434](https://github.com/iamreal-tw/iamreal/issues/434)）；讀最舊日期的外部檢查還沒打開；這個物件一秒收得了多少還沒量 |
| 連線紀錄（[連線紀錄](#連線紀錄)）：被算了一次的送出一筆各記一個 R2 物件（請求編號、時間、結果、IP、國家代碼、網路業者的編號、過卡裝置編號；成功的加第幾筆，沒成功的加錯誤代碼和內文），留 31 天，靠儲存桶的生命週期規則；每小時公布最舊一筆的日期，讓外面看得出規則有沒有在刪。其他的請求不記。營運者查詢的指令和收到查詢、刪除請求時的做法（[查連線紀錄](#查連線紀錄)） | 讀那個日期的外部檢查（[#53](https://github.com/iamreal-tw/iamreal/issues/53)）；帶過卡裝置編號的客戶端現在只有網頁版，兩個 app 還沒有 |
| API 的七個介面：`POST /api/v1/challenges`、`POST /api/v1/card-state`、`POST /api/v1/records`、`GET /api/v1/config`、`GET /api/v1/fingerprint`、`GET /api/v1/rebuild`、`POST /api/v1/counts`；存著的規則版本和程式不同時、營運者停止收過卡時（[停止和恢復收過卡](#停止和恢復收過卡)），`challenges` 和 `records` 回 `paused` | 限流見上面那一列 |
| 寫滿 1,000 筆的紀錄檔和它的雜湊清單搬到 R2，讀回來核對過才刪掉 Durable Object 裡的那 1,000 筆（[寫滿的紀錄檔搬到 R2](#寫滿的紀錄檔搬到-r2)） | |
| 每天台灣時間換日公布證明紀錄：還沒寫滿的最後一檔和它的雜湊清單、當天的卡片狀態檔、指紋檔多一行（[每天換日公布證明紀錄](#每天換日公布證明紀錄)）。Go 的 `iamreal-verify` 用預設的讀法重驗寫出來的整個資料網域，通過。測試網站第一次公布是 2026-11-21（空的證明紀錄），重驗通過（[部署後要營運者做的](#每天換日公布證明紀錄)）；清空之後，2026-11-22 公布了營運者用真卡片過卡的那一筆，重驗通過（[#71](https://github.com/iamreal-tw/iamreal/issues/71)） | |
| 驗證證明和 Poseidon2 的雜湊（[驗證證明](#驗證證明)），在本機的 workerd 裡逐案和原生的 `bb verify` 比對過；送出一筆時用它驗證 | |
| 每一種訪客頁面：首頁 `/`、島民證明 `/p/<短編號>`、查詢頁、證明紀錄頁、常見問題、如何驗證證明紀錄、過卡需要什麼、掛上去、複製按鈕的程式，過卡的頁面 `/proof`，和頁面用的衍生表（[頁面和檔案](#頁面和檔案)） | |
| 測試專用的建置和測試的工具；本機用真卡片過卡的指令（[在本機用真卡片過卡](#在本機用真卡片過卡)） | |
| 部署測試環境的指令。2026-11-19 用它第一次部署到 `test.iamreal.tw`（[第一次部署量到的](#第一次部署量到的)） | 推版本標籤時部署正式環境的工作流程 |
| 合併到 `main` 時部署測試環境的工作流程（[從 GitHub Actions 部署](#從-github-actions-部署)） | |
| 清空測試的證明紀錄的步驟（[清空測試的證明紀錄](#清空測試的證明紀錄)），在本機照著做過；部署之後不插卡的檢查（[部署之後不插卡的檢查](#部署之後不插卡的檢查)）；營運者手動設的東西的清單（[營運者在 Cloudflare 和 GitHub 上設的](#營運者在-cloudflare-和-github-上設的)）。2026-11-21 在測試網站上清空過一次（[#37](https://github.com/iamreal-tw/iamreal/issues/37)） | |

## 單獨執行

需要 Node 22 和 pnpm。不需要 Cloudflare 的帳號。有些測試另外要 Go：和原生 `bb` 逐案比對（`test/compare.test.ts`，另要 `IAMREAL_BB`，見「和原生的 `bb verify` 逐案比對」），`test/workflows.test.ts` 裡檢查 `web/` 瀏覽器測試的 `paths` 清單的那一項（`.github/README.md`），紀錄規則跟 Go 的 `prooflog/` 逐筆比對（`test/sequence.test.ts`，見「紀錄規則和 Go 的 `prooflog/` 逐筆比對」），和 Go 的 `iamreal-verify` 讀 Worker 寫出來的紀錄目錄（`test/proof-log-files.test.ts`，見「寫滿的紀錄檔搬到 R2」）。第一項沒設 `IAMREAL_BB` 時跳過；後三項沒有 `go` 時跳過，但設了 `CI` 或 `IAMREAL_BB` 時沒有 `go` 是失敗（GitHub Actions 會設 `CI`），這樣 CI 上不會悄悄跳過。在程式庫的根目錄 `pnpm install`，然後在這個目錄：

```sh
pnpm dev         # 在本機的 workerd 啟動 Worker
pnpm test        # 測試
pnpm typecheck   # 型別檢查
```

`pnpm dev` 啟動的是測試專用的建置，旁邊有一個假的內政部（本機的伺服器），所以不會對內政部送請求。它印出 Worker 的網址；按 Enter 跑一次排程，印出排程寫的紀錄和 R2 的模擬裡的檔案。R2 的模擬每次啟動都是空的。

## 在本機用真卡片過卡

```sh
pnpm local                       # 可加 --port 8080、--data <目錄>
```

要讀卡機和內政部的元件（`http://localhost:61161`）；不要 Cloudflare 的帳號、`go`、`bb`。[`scripts/local.ts`](scripts/local.ts) 依序：

1. 通用參數不在就下載（`web/scripts/fetch-crs.mjs`）
2. 建置本機用真卡片的頁面（`web/` 的 `vite build --mode localcard`，`web/README.md`「三種用真元件的建置」）：內政部的發證金鑰、真的元件，簽測試的證明紀錄的場合字串
3. 在本機的 workerd 啟動 Worker：部署的那一份程式（內政部的發證金鑰和清冊網址、Worker 裡的驗證器），`wrangler.jsonc` 的測試環境的設定，所以是測試的證明紀錄。入口是 [`local-build/index.ts`](local-build/index.ts)：部署的 Worker 前面多一件事，`GET`、`HEAD` 的 `/crl/…`、`/proof-log/…` 從儲存桶送出檔案。Cloudflare 上那是資料網域做的事，Worker 沒有這條路（ADR-0027）；本機沒有資料網域，這個建置的頁面從自己的網域拿清冊存檔。部署的建置不含這個入口（`test/bundle.test.ts`）
4. 跑一次清冊鏡像，抓內政部真的 G2、G3 清冊。之後不會自己再跑：要新的清冊就重新啟動
5. 跑[部署之後不插卡的檢查](#部署之後不插卡的檢查)（`local`：資料網域是網站自己的網域，不看 CORS 和每天的公布），印出幾項過了

頁面在 `http://localhost:8080/proof`，首頁和其他訪客的頁面在 `http://localhost:8080/`。按 Ctrl-C 停止。證明紀錄（Durable Object）、儲存桶、頁面在 `local/`（不進版控）；刪掉這個目錄就從空的證明紀錄重來。證明紀錄在指令開著的時候跨過台灣的午夜才公布。Go 的舊後台用的 `web/local/` 不讀也不寫。

對外的連線只有下載通用參數（缺的時候）和清冊鏡像抓內政部的兩份清冊；啟動時不對元件送任何請求，也不開瀏覽器。

## 題目、卡片現況、設定

介面的格式在 [`docs/api/card-proof.md`](../docs/api/card-proof.md)。這一節寫這個後台怎麼做。程式在 [`src/api.ts`](src/api.ts)、[`src/proof-log.ts`](src/proof-log.ts)、[`src/card-table.ts`](src/card-table.ts)、[`src/json.ts`](src/json.ts)；測試在 [`test/api.test.ts`](test/api.test.ts)，案例是從 Go 舊後台的 `api_test.go` 搬過來的。

### `/api/` 底下每個回應

- 都是 JSON，帶 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff` 和自己的 `X-Request-Id`（8 個隨機位元組的十六進位）。不設 cookie，不送 CORS 標頭。收計數的那一個（[計數](#計數)）回 `204`，沒有內容，也就沒有 `Content-Type`。
- 不是介面的路徑回 `404` `not_found`；方法不對回 `405` `method_not_allowed`，帶 `Allow`。
- **後台只替一種請求存連線紀錄**（ADR-0022，[連線紀錄](#連線紀錄)）：帶著後台發過的題目、被算了一次的送出一筆。其他的請求後台不寫任何東西。後台自己出錯（回 `500` `internal`）時另外寫一行，只在即時的輸出看得到，沒有開保存：

  ```
  {"event":"internal_error","id":"<請求編號>","endpoint":"/api/v1/challenges","where":"proof_log","error":"Error"}
  ```

  `endpoint` 只會是介面自己的路徑，`error` 是例外的類別名稱，`where` 是程式裡寫死的四個值之一：

  | `where` | 意思 |
  |---|---|
  | `settings` | 設定不對：`PROOF_LOG_KIND` 不是 `test` 也不是 `production`，或它和 `PROOF_LOG_OBJECT_NAME` 對不上（見[證明紀錄和物件的名稱要對得上](#證明紀錄和物件的名稱要對得上)） |
  | `schema` | 證明紀錄的 Durable Object 裡的表是另一版建的（見[兩個版本號](#兩個版本號)） |
  | `proof_log` | Durable Object 裡其他的錯，包括存著的卡片狀態壞了（見[讀卡片狀態時的檢查](#讀卡片狀態時的檢查)） |
  | `handler` | 其他地方 |

  例外的訊息不寫：訊息可能引用請求的內容。這一行沒有題目、匿名編號、帳號、對方的位址。
- 介面會讀的請求內容最多 64 KB（65,536 個位元組），超過就是 `malformed`，多的部分不讀。`challenges` 不讀內容，送什麼、多長都不看。巢狀超過 16 層的 JSON 也是 `malformed`。
- 讀 JSON 用自己寫的讀法（`src/json.ts`）：`JSON.parse` 遇到重複的鍵會留下後面那個而不報錯，這裡重複的鍵一律拒絕（ADR-0014）。多一個鍵、少一個鍵、鍵的大小寫不同、值不是字串、物件後面還有東西、不是 UTF-8、開頭有位元組順序記號，都是 `malformed`。

### 五個介面

| 介面 | 誰回答 | 做法 |
|---|---|---|
| `POST /api/v1/challenges` | Durable Object | 日期是發出那一刻的台灣日期，加 16 個隨機位元組；先存進題目表再回。請求的內容不讀。存著的規則版本和程式的不同時不發，回 `503` `paused` |
| `POST /api/v1/records` | Worker 和 Durable Object 各兩段 | 見[送出一筆](#送出一筆) |
| `POST /api/v1/card-state` | Worker 檢查格式，Durable Object 讀卡片狀態表 | 場合字串不是這份證明紀錄的、匿名編號不是它唯一的寫法，都是 `malformed`，不問 Durable Object。平台表的每個平台一項；存著的狀態沒有某個平台的名額時，那一項是沒用過的名額。回應沒有 `head` |
| `GET /api/v1/config` | Worker 自己 | `crl_max_age_days` 是 3；`platforms` 是這份證明紀錄的平台表；`min_app` 是這份證明紀錄的最低版本 |
| `POST /api/v1/counts` | Worker 檢查，收計數的 Durable Object 收 | 見[計數](#計數)。不問證明紀錄的 Durable Object |
| `GET /api/v1/fingerprint` | Durable Object | 最近一次公布的那一行：`date`、`count`、`fingerprint`。回的是物件記著自己已經寫進指紋檔、讀回核對過的最後一行，不去讀儲存桶（[每天換日公布證明紀錄](#每天換日公布證明紀錄)）。還沒公布過時 `date` 是 `null`、`count` 是 0、`fingerprint` 是 64 個 0。`paused` 時照常回答。舊後台叫 `head` 的那個介面，Worker 沒有 |

**平台表**寫在 [`protocol/src/platforms.ts`](../protocol/src/platforms.ts)，照證明紀錄分兩張，內容和 `spec/scope.md` 的表一字不差（`protocol/` 的測試拿規格的 Markdown 核對）。後台只從 [`src/settings.ts`](src/settings.ts) 的 `proofLogSettingsOf` 一個地方取得它：`config` 送給裝置的、`card-state` 列的、檢查存著的卡片狀態用的是同一張。這個環境用哪一份證明紀錄，是設定 `PROOF_LOG_KIND`（見[設定檔](#設定檔)）；設定只說是哪一份，表的內容不在設定裡。

**最低版本**（`min_app`，`spec/min-app.md`、ADR-0035）寫在 [`src/min-app.ts`](src/min-app.ts)，正式的證明紀錄和測試的證明紀錄各一組，同樣照 `PROOF_LOG_KIND` 選，從 `proofLogSettingsOf` 取得。現在兩組的 `build` 都是最小的 1，不擋任何一版 app。調高時改這個檔和 `test/api.test.ts` 裡逐字比對的 `config`，一次一個 PR，說明裡寫理由。後台收證明時不看 app 的版本；`test/api.test.ts` 確認兩份證明紀錄送出的值兩個 app 都讀得懂（`protocol/src/min-app.ts`）。

**教操作的示範**（`design/motion/`，[#369](https://github.com/iamreal-tw/iamreal/issues/369)）的算法寫在 [`src/teaching-animation.ts`](src/teaching-animation.ts)：給時間表、平台和秒數，算出那一刻的狀態。後台自己不執行它；它是網站的播放程式（`site/demo.js`）帶到瀏覽器的那一份，所以不引用任何檔。`test/teaching-animation.test.ts` 檢查兩份時間表自己說得通，並拿 `spec/vectors/teaching-animation.json` 的每一個答案比對。答案由 `test/generate/teaching-animation.ts` 寫出（在這個目錄跑 `node --experimental-strip-types test/generate/teaching-animation.ts`）：每一個答案手寫在裡面，寫檔前用 `src/teaching-animation.ts` 算一次，有一個不同就不寫。

### 證明紀錄和物件的名稱要對得上

**命名規則：測試的證明紀錄的 Durable Object 名稱（`PROOF_LOG_OBJECT_NAME`）一律以 `test-` 開頭；正式的證明紀錄的不可以以 `test-` 開頭。** 所以從名稱就看得出一個物件裡是哪一份證明紀錄，設定錯了有兩層擋：

| | 擋什麼 | 怎麼擋 |
|---|---|---|
| 合併之前 | 經過 PR 的設定錯誤 | [`test/environments.test.ts`](test/environments.test.ts) 用 wrangler 的讀法讀 `wrangler.jsonc`：`test` 環境的 `PROOF_LOG_KIND` 必須是 `test`、`PROOF_LOG_OBJECT_NAME` 必須以 `test-` 開頭、R2 的儲存桶必須是 `iamreal-test-data`。PR 的檢查會跑它。之後加正式環境時，這個測試要加對應的一段 |
| 執行時 | 不經過 PR 的：從本機用改過的設定檔部署 | 後台取得設定的那一處（`src/settings.ts` 的 `proofLogSettingsOf`）每次都檢查 `PROOF_LOG_KIND` 合法、而且和 `PROOF_LOG_OBJECT_NAME` 相符：`test` 配 `test-` 開頭的名稱，`production` 配不是 `test-` 開頭的名稱 |

執行時不符的話：

- 五個介面（`challenges`、`card-state`、`records`、`config`、`fingerprint`）一律回 `500`，寫一行 `where` 是 `settings` 的紀錄。每個介面都是先讀設定才做別的事。
- Worker 不去問 Durable Object。Durable Object 自己啟動時也讀同一處，設定不對就不啟動，不建表、不讀不寫。
- 設定改對之後照常，物件裡原有的東西都還在。

之後的介面（頁面）只要經過 `proofLogSettingsOf` 取得設定，就有同樣的檢查。

### 讀卡片狀態時的檢查

`src/card-table.ts` 的 `readCard` 讀出一列之後，照 `spec/record-rules.md`「State」和這份證明紀錄的平台表檢查，不合就丟例外，`card-state` 回 `500`；壞掉的狀態不交給任何人：

- `last_card_proof` 是日期；`proofs_on_last_date` 是 1 到 3；`last_seq` 至少是 1
- 每個名額的平台在平台表裡
- `switch_count` 是 0 到 5；日期是日期；名額的各項彼此說得通，也和上次過卡日說得通（`protocol/` 的 `possibleSlot`：例如 `current` 有值時等於 `last_declared`、`correction_date` 不晚於上次過卡日）
- `current` 和 `last_declared` 合那個平台的帳號格式

3 和 5 這兩個上限用的是 `protocol/src/record-rules.ts` 的常數。`writeCard` 寫入時不做這些檢查：它寫的是規則的函式交出來的狀態。

### Durable Object 裡存的

建表的程式在 `src/proof-log.ts` 的 `TABLES` 和 `src/card-table.ts` 的 `CARD_TABLE`，物件每次啟動時執行（`CREATE TABLE IF NOT EXISTS`）。

| 表 | 一列是什麼 | 欄位 |
|---|---|---|
| `challenges` | 一個發出、還沒過期的題目 | `challenge`、`issued_ms`（發出的時間）、`submissions`（送出的次數）、`accepted`（是否已接受） |
| `records` | 一筆還沒搬到 R2 的紀錄：還沒寫滿的最後一檔的每一筆，和寫滿了、還沒搬完的那一檔 | `seq`、`line`（它在紀錄檔裡的那一行，含結尾的換行；照序號接起來就是紀錄檔）、`record_hash`、`fingerprint`（加上這一筆之後的指紋） |
| `published` | 指紋檔的一行：證明紀錄公布過的一天 | `date`（台灣日期）、`count`（那一刻的筆數）、`fingerprint`（那一刻的指紋）、`in_bucket`（這一行是不是已經在儲存桶的指紋檔裡） |
| `first_day` | 只有一列：證明紀錄從哪一天之後開始公布 | `date`（物件第一次用會公布的程式啟動那一天的台灣日期） |
| `rebuild_state` | 只有一列：上一次從證明紀錄重建是哪一次、做到哪裡（[從證明紀錄重建](#從證明紀錄重建)） | `token`（營運者取的名稱）、`status`（`running`、`swapped`、`refused`）、`source`（從物件自己記的讀，還是只從儲存桶讀）、`records` 和 `fingerprint`（做到第幾筆、那時的指紋）、`published_count`、`published_fingerprint`、`published_date`（要對上的那一行）、`reason`（沒換的原因）。重建進行中另有一組 `rebuild_` 開頭的暫存表，做完就刪 |
| `full_files` | 一個已經搬到 R2 的寫滿的紀錄檔 | `records_before`（這一檔之前的筆數，就是檔名裡的數字）、`fingerprint_after`（這一檔結尾的指紋）、`file_sha256`（寫進 R2、讀回來核對過的那一檔的 SHA-256） |
| `cards` | 一張有過有效紀錄的卡片 | `scope_string`、`scoped_id`、`last_card_proof`、`proofs_on_last_date`、`slots`、`last_seq`（這張卡片最後一筆有效紀錄的序號） |
| `cards_copy` | 公布途中才有：卡片狀態表在公布那一刻的複本，欄位和 `cards` 相同 | 同 `cards` |
| `proof_log` | 整份證明紀錄，只有一列 | `count`（筆數）、`fingerprint`（指紋）、`latest_valid_date`（證明紀錄裡最晚的有效日期）、`rules_version`（卡片狀態是照哪一版規則算的）、`schema_version`（這些表是照哪一版建的） |

- `cards` 的欄位就是 `spec/record-rules.md`「State」的項目，加上 `last_seq`。`slots` 是一個 JSON 物件，鍵是平台代號，每個值恰好是 `current`、`last_declared`、`switch_count`、`correction_date`，名稱和寫法跟 `card-state` 回應的 `platforms` 相同。只存事實（更換過幾次），不存結論（還能不能換）。沒有有效紀錄的卡片沒有列。
- 這張表只放紀錄規則的狀態，和頁面用的衍生表（`view_` 開頭的五張，見[頁面用的衍生表](#頁面用的衍生表)）分開：衍生表可以整份重建，規則的狀態錯了會收下拿不掉的紀錄。
- `records` 是送出一筆（[#67](https://github.com/iamreal-tw/iamreal/issues/67)）加的新表，表的版本沒有變；在它之前建的物件下一次啟動時補上這張表。`fingerprint` 每一筆都存，切檔時最後一筆的那個值記進 `full_files`，下一檔的雜湊清單第一行就是它（`spec/record.md`「Record hash lists」），不必從頭重算。
- `full_files` 是搬檔（[#149](https://github.com/iamreal-tw/iamreal/issues/149)）加的新表，表的版本也沒有變。一檔的 1,000 筆從 `records` 刪掉和這張表多一列是同一個交易，所以每一筆紀錄不是還在 `records`，就是它那一檔列在這裡（[寫滿的紀錄檔搬到 R2](#寫滿的紀錄檔搬到-r2)）。列是連續的：`records_before` 是 0、1000、2000……，`records` 的第一筆緊接在最後一列那一檔之後。
- `published` 和 `first_day` 是每天公布（[#70](https://github.com/iamreal-tw/iamreal/issues/70)）加的新表，表的版本沒有變。`published` 的列寫了就不改、不刪：一個日期的那一行不會變。它是指紋檔的正本，儲存桶裡的檔每次整個從它寫出來，寫之前先看儲存桶現有的是不是它的開頭（[每天換日公布證明紀錄](#每天換日公布證明紀錄)）。
- `cards_copy` 是換日公布寫卡片狀態檔用的（[#183](https://github.com/iamreal-tw/iamreal/issues/183)），不是一直在的表：公布那一刻建、公布結束就刪，表的版本沒有變（[每天換日公布證明紀錄](#每天換日公布證明紀錄)「同一刻」）。除了公布，沒有程式讀它。
- `retries` 是失敗後等多久再試（[#181](https://github.com/iamreal-tw/iamreal/issues/181)）加的新表，表的版本沒有變；在它之前建的物件下一次啟動時補上一張空表，等於沒有失敗過。一件定時工作（重建衍生表、搬檔、每天公布）上一次失敗時有一列：連續失敗了幾次、下一次什麼時候試；成功就刪掉那一列（[過期的題目怎麼刪](#過期的題目怎麼刪)的「失敗後多久再試」）。
- `rules_version` 在物件第一次啟動時記下當時程式的版本號；和程式的不同時不收過卡（見下面）。

### 兩個版本號

`proof_log` 那一列記著兩個版本號，都是物件第一次啟動時寫入當時程式的常數。那一列用 `INSERT OR IGNORE` 建，已經有了就不動：沒有任何程式會把存著的版本號改成新的。

| | 規則的版本 `rules_version` | 表的版本 `schema_version` |
|---|---|---|
| 程式裡的常數 | `protocol/` 的 `RULES_VERSION` | `src/proof-log.ts` 的 `SCHEMA_VERSION`，現在是 1 |
| 什麼時候加一號 | 紀錄規則改了、存著的卡片狀態因此失效（`spec/record-rules.md`「The version number」） | **改到任何一張已經存在的表**：加欄位、拿掉欄位、欄位的意思變了、改主鍵。只是多一張新的表、多一個索引不用加：建表的程式會在沒有它們的物件上補上 |
| 存著的和程式的不同時 | 不收過卡：`challenges` 和 `records` 回 `503` `paused`，不發題目、不計次、不寫入；`card-state` 和 `config` 照常。`records` 的請求本身讀不懂時（`malformed`、`scope`、`platform`）仍然先回那個代碼，那一段不問 Durable Object。這不是後台出錯，不寫那一行紀錄 | Durable Object 的每個方法都不讀不寫，丟錯誤；`challenges`、`card-state`、`records` 回 `500`，那一行紀錄的 `where` 是 `schema`。alarm 響了也什麼都不做 |
| 怎麼處理 | 重建狀態（[#51](https://github.com/iamreal-tw/iamreal/issues/51)） | 現在沒有搬移表的程式。處理的方法是清空測試的證明紀錄（[清空測試的證明紀錄](#清空測試的證明紀錄)）。真正的搬移留給 [#118](https://github.com/iamreal-tw/iamreal/issues/118)，封閉試用之前定 |

兩件事不共用代碼：`paused` 是規則的版本，`schema` 是表的版本。

表的版本為什麼要擋：表是用 `CREATE TABLE IF NOT EXISTS` 建的，已經存在的表不會跟著程式變，新的程式會照新的欄位去讀舊的表。

`config` 由 Worker 自己回答、不問 Durable Object，所以表的版本不同時它照常回 `200`；不是介面的路徑（`404`）、方法不對（`405`）也照常。

### 過期的題目怎麼刪

題目發出後不到 10 分鐘可以用；剛好 10 分鐘就是過期。Durable Object 用自己的 alarm 刪。

一個 Durable Object 同一時間只能排一個 alarm，再呼叫 `setAlarm` 會蓋掉原來的（[Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)：「Each Durable Object is able to schedule a single alarm at a time by calling `setAlarm()`」「If you call `setAlarm` when there is already one scheduled, it will override the existing alarm」，2026-11-20 讀的）。所以定時的工作不各自設 alarm，而是照同一個形狀寫（`src/proof-log.ts` 的 `TimedWork`）：

- 每一件工作回答兩件事：自己下一次什麼時候到期（沒事可做就說沒有）、到期時做什麼。它不知道別的工作。
- 物件的 alarm 不晚於所有工作裡最早到期的那一個；都沒事可做就沒有 alarm。任何一件工作的到期時間可能變了（例如發了一個題目），就看一次要不要重設（`setAlarmForTimedWork`）。
- **已經有一個不晚於要設的時間的 alarm 時，不重設。** 每次設都至少設在 1 秒後（免得一件一直到期的工作讓 alarm 空轉），而每發一個題目就會看一次：如果每次都重設，題目發得比一秒一個密的時候，alarm 會一直被往後推、永遠不響，到期的工作（搬檔、之後的換日）就一直不做。留下來的 alarm 可能比需要的早（例如到期時間後來往後了），那一次響了沒有工作到期，再設成對的時間，只是多醒一次。響過的那個 alarm 在它的處理函式執行時已經不算設著（同一頁：「If `getAlarm` is called while an `alarm` is already running, it returns `null` unless `setAlarm` has also been called since the alarm handler started running」），而處理函式最後一定會看一次要不要設，所以處理函式結束時，一定留著一個不晚於需要的 alarm：最後那一次設的，或處理函式執行途中設的、更早的一個（例如等 R2 的時候有人來拿題目）。alarm 自己響、之後沒有任何請求時下一個 alarm 有設好，測試看過（`test/api.test.ts`）。
- alarm 響的時候，到期的工作各做一次，沒到期的不做，然後重設。

現在有四件：

- 刪過期的題目，到期時間是最舊那個題目發出後 10 分鐘。所以題目表裡只有最近 10 分鐘左右發的題目。
- 衍生表重建失敗之後再試一次（[頁面用的衍生表](#頁面用的衍生表)）：失敗後等一段時間到期（下面「失敗後多久再試」）；沒有失敗過就沒有這件事。
- 把寫滿的紀錄檔搬到 R2（[寫滿的紀錄檔搬到 R2](#寫滿的紀錄檔搬到-r2)）：物件裡有寫滿的檔就到期；搬不成時，等一段時間才到期。
- 每天公布證明紀錄（[每天換日公布證明紀錄](#每天換日公布證明紀錄)）：上一次公布的日期的隔天，台灣時間零點到期；公布不成時，等一段時間才到期。`paused` 時沒有這件事。

每天公布永遠有下一次，所以物件啟動過之後通常一直有 alarm，最晚是下一個台灣午夜。三種時候沒有：`paused` 時沒有每天公布這件事，別的工作也都沒事時就沒有 alarm；表的版本和程式不同時物件什麼都不做，也不設 alarm；清空測試的證明紀錄之後被換掉的那個物件不做任何定時的工作，啟動時就把 alarm 刪掉（[清空測試的證明紀錄](#清空測試的證明紀錄)）。物件啟動時（建構子跑完之後）自己設一次 alarm，不等有人來拿題目；之後每一次 alarm 響完都會設下一個。物件平常不會整天沒人叫醒：清冊鏡像每小時把最新的清冊交給它一次（[排程做什麼](#排程做什麼)）。

一件工作占著 alarm 不會讓別的晚做，一件工作失敗也不會讓排在它後面的不做，題目每 300 毫秒發一個時到期的工作照樣在幾秒內做：測試用測試專用的建置多塞一件假的工作來確認（`test/api.test.ts`），搬檔本身也測一次（`test/proof-log-files.test.ts`）。過期的題目有沒有被刪，從介面看不出來（過期的題目不管刪了沒有都是不認得），所以這一點是用那件假的工作確認的。

**失敗後多久再試**（`src/proof-log.ts` 的 `Retries`）。重建衍生表、搬檔、每天公布這三件，失敗後等的時間照同一個規則，各算各的：第一次失敗等 1 分鐘，之後每連續再失敗一次，等的時間加倍，到那一件的上限為止，一直試下去，不停下來等人。成功一次，下一次失敗又從 1 分鐘算起。

| 工作 | 上限 | 連續失敗時等的時間 | 從第一次失敗算起，嘗試在第幾分鐘 | 要有人處理的失敗，一天最多試幾次 |
|---|---|---|---|---|
| 搬檔、每天公布 | 1 小時 | 1、2、4、8、16、32 分鐘，然後每次 1 小時 | 1、3、7、15、31、63，之後每小時 | 約 24 次 |
| 重建衍生表 | 5 分鐘 | 1、2、4 分鐘，然後每次 5 分鐘 | 1、3、7、12，之後每 5 分鐘 | 約 288 次 |

- **衍生表的上限比較短**：衍生表沒跟上的時候，首頁、島民證明和送出都回 `500`（[頁面用的衍生表](#頁面用的衍生表)），而營運者排除原因之後，手上沒有辦法叫它馬上再試。上限就是排除原因之後最長還要等多久：衍生表 5 分鐘，搬檔和每天公布 1 小時（這兩件晚一點沒有人看得到）。代價是要有人處理的失敗一天約 288 次嘗試、288 行 `views_not_filled`，每一次都從 R2 重讀到失敗的那一檔為止。

- 第一次等 1 分鐘，是為了避開 R2 一秒只能寫同一個物件一次的限制（[寫滿的紀錄檔搬到 R2](#寫滿的紀錄檔搬到-r2)）。
- 會自己好的失敗（R2 逾時、暫時的錯誤）幾分鐘內就恢復，不必重啟物件：原因持續了 2 分鐘的，第 3 分鐘那一次就成功；持續了 10 分鐘的，第 15 分鐘那一次。在等的時間到上限之前，原因消失之後最晚再等大約它已經持續的那麼久。
- 要有人處理的失敗（R2 上的紀錄檔不見或被改過、這一版讀不懂的一筆、儲存桶的指紋檔不是物件的）不會每分鐘整個重做一次：搬檔和每天公布約一小時之後變成每小時一次，衍生表約十分鐘之後變成每 5 分鐘一次，每次照樣寫一行即時輸出（`views_not_filled`、`full_file_not_moved`、`proof_log_not_published`、`fingerprint_file_differs`）。這些失敗後台不另外往外送（[#413](https://github.com/iamreal-tw/iamreal/issues/413)「通知」）：公布不成的後果是資料網域上沒有今天的那一行和卡片狀態檔，[從外面定時檢查](../.github/README.md#從外面定時檢查53)每小時看一次，沒有就失敗，營運者收到 GitHub 的通知信（[#53](https://github.com/iamreal-tw/iamreal/issues/53)）。衍生表、搬檔的失敗，這個檢查看不到，只有這一行即時輸出。
- **失敗的次數和下一次的時間存在物件的儲存裡**（`retries` 表），不是記憶體：Cloudflare 上的物件沒事做大約 10 秒就休眠，記憶體裡的東西丟掉，alarm 響時建構子重跑（[Lifecycle of a Durable Object](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)：「After 10 seconds of no incoming request or event, and all the above conditions satisfied, the Durable Object will transition into the hibernated state」「When hibernated, the in-memory state is discarded, so ensure you persist all important information in the Durable Object's storage」，2026-11-21 讀的）。等的時間最短 1 分鐘，記在記憶體的話，沒人用的物件每一次失敗都會是第一次。所以物件重新啟動（休眠後被叫醒、部署、被換掉）之後，照存著的時間繼續等，不會馬上再試；衍生表的重建也一樣，啟動時還沒到時間就不在啟動當下做，等 alarm（[頁面用的衍生表](#頁面用的衍生表)）。測試的 workerd 不會讓物件休眠，所以測試用「兩次嘗試之間讓物件重啟」代替（`test/publication.test.ts`、`test/proof-log-files.test.ts`）。
- 代價：原因排除後（例如把 R2 的檔放回去、部署了讀得懂那一筆的程式），重新部署也不會讓它馬上再試，最晚要等到下一次的時間：衍生表最長 5 分鐘，搬檔和每天公布最長 1 小時。
- **存著的時間不會比「現在加上限」更晚**：時鐘曾經跑快時存下的時間，讀的時候拉回到現在加上限，也照這樣存回去；不會卡到時鐘走到那個時間才再試。
- **`paused` 期間不累計**：`paused` 時不重建衍生表、不公布，物件以 `paused` 啟動時刪掉這兩件的那一列；恢復之後的第一次失敗等 1 分鐘，不接著舊的次數算。搬檔 `paused` 時照搬，那一列照常。
- 1 小時對每天公布也夠短：一天裡還有二十幾次機會；錯過的日子本來就不補（[每天換日公布證明紀錄](#每天換日公布證明紀錄)）。

alarm 的處理函式丟例外時 Cloudflare 會重試，但最多 6 次（上面那一頁，2026-11-20 讀的：「Retries are performed using exponential backoff starting at a 2 second delay from the first failure with up to 6 retries allowed」，並建議「catch any exceptions inside your `alarm()` handler and schedule a new alarm before returning」）。所以會失敗的工作自己接住例外、自己定下一次的時間，不靠那 6 次。

## 送出一筆

`POST /api/v1/records`：一次過卡，帶這張卡片的整份帳號清單。檢查的順序照 [`docs/api/card-proof.md`](../docs/api/card-proof.md)，第一個不過的就是回應的代碼。Worker 和證明紀錄的 Durable Object 之間分四段：

| | 誰 | 做什麼 | 停在這裡的代碼 |
|---|---|---|---|
| 1 | Worker（`src/submission.ts`） | 讀請求、檢查每個欄位的格式。不問 Durable Object，不算一次送出 | `malformed`、`scope`、`platform` |
| 2 | Durable Object（`beginSubmission`） | 檢查題目，算一次送出 | `paused`、`challenge_unknown`、`challenge_used`、`challenge_attempts` |
| 3 | Worker（`src/record-proof.ts`） | 從紀錄的欄位重建公開輸入，驗證證明。在 Durable Object 外面做，驗證的時候證明紀錄不被佔住 | `proof` |
| 4 | Durable Object（`accept`） | 再看一次題目；檢查清冊；套紀錄規則；套後台自己的更換政策；寫入 | `challenge_unknown`、`challenge_used`、`crl_stale`、`root`、`date_order`、`empty`、`switch_limit`、`daily_limit`、`switch_restricted` |

- **後台自己不判斷一筆紀錄有效或無效。** 第 4 段把存著的卡片狀態、證明紀錄裡最晚的有效日期、樹根對到的清冊日期交給 `protocol/` 的 `applyRecord`，照它的結果回。這個檔自己決定的只有後台自己的事：題目、今天收哪些樹根、更換政策。
- **題目**：發出滿 10 分鐘就是不認得（剛好 10 分鐘也是）。已經寫入過一筆的題目是 `challenge_used`，不計次。第 6 次送出起是 `challenge_attempts`：第 2 段每通過一次就加一，不管後來停在哪一段，第 4 段再看題目時擋下的（`challenge_used`、`challenge_unknown`）和回 `500` 的（驗證器跑不起來、第 4 段出錯）也算。第 1 段擋下的、`paused` 的、第 2 段就是 `challenge_unknown` 或 `challenge_used` 的不計次；計次的那一次寫入自己失敗（`500`）也沒有計到。
- **第 4 段為什麼再看一次題目**：驗證證明的那段時間，同一個題目可能已經被另一個請求寫入（回 `challenge_used`），也可能剛好過期（回 `challenge_unknown`）。同一個題目同時送兩次，只有一次寫入。過期是照寫入那一刻的時鐘看的：第 2 段時還差 1 毫秒到 10 分鐘、驗證完已經滿 10 分鐘的那一次，回 `challenge_unknown`、不寫入、已經算一次。這一點比 Go 的舊後台嚴，是有意的：它只在第一次看題目時看過期，寫入時只看題目是不是已經用過。
- **清冊**：`issuer` 那把發證金鑰在鏡像裡沒有可用的清冊，或最新一份的清冊日期加 3 天早於今天（台灣日期），是 `crl_stale`；`smt_root` 不是最新兩份其中一份的樹根，是 `root`。紀錄規則的檢查 3 拿到的清冊日期，是這兩份裡樹根相同的那幾份的日期。重驗的人用的是整份清冊存檔，日期只會更多，所以後台收下的紀錄重驗時這一項一定過。
- **更換政策**（`switch_restricted`）：預設沒有。環境變數 `RESTRICT_LATE_SWITCHES` 是 `"true"` 時，紀錄規則接受、但其中有一個更換是那個名額的第 4 次或第 5 次的紀錄，回 `403`。`wrangler.jsonc` 沒有設這個值；要開的話在設定檔加一行，並把它加進 `scripts/deploy-build-checks.ts` 允許的清單。這個值只寫在 `wrangler.jsonc`，不用 `wrangler secret` 設：部署前的檢查讀的是設定檔和 wrangler 列出的 binding，看不到另外設在 Worker 上的 secret，用 secret 開的政策就沒有人在 PR 裡看過。值不是 `"true"` 也不是 `"false"` 時每個介面都回 `500`。
- **驗證器跑不起來**（`EngineError`，見[驗證證明](#驗證證明)）不是拒絕也不是通過：回 `500`，那一行紀錄的 `where` 是 `verifier`，不問 Durable Object 寫任何東西。這一次送出已經在第 2 段算了一次。

### 寫入是一個交易

第 4 段每一項都過了之後，在一個交易裡（`transactionSync`）寫五樣，寫完才回應：

1. 紀錄：序號、它在紀錄檔裡的那一行（`protocol/` 的 `recordLine`）、紀錄雜湊、加上它之後的指紋
2. 這張卡片的狀態，和它最後一筆有效紀錄的序號
3. 證明紀錄的那一列：筆數、指紋、證明紀錄裡最晚的有效日期
4. 頁面用的衍生表（[頁面用的衍生表](#頁面用的衍生表)）
5. 題目標成已接受

任何一步丟例外，五樣都不留下，回 `500`；[`test/records-storage.test.ts`](test/records-storage.test.ts) 和 [`test/views.test.ts`](test/views.test.ts) 讓每一步各失敗一次來確認（衍生表的五張各一次），後者另外確認衍生表的每一列和頁面都沒變。寫入之前，那一行先照 `spec/record.md`「Check a line」讀一次（`readRecordLine`），讀不過就不寫。

**交易提交之後沒有會丟例外的程式。** `201` 的回答（這張卡片的順序號碼、每個平台是哪個帳號、有幾張卡片宣告它）在交易結束前就做好：帳號在交易之前取，讀號碼和數卡片在交易裡、寫完衍生表之後做。所以不會出現「紀錄寫進去了、題目標成用過了，裝置卻拿到 `500`」。

**數卡片查的是衍生表，不讀卡片狀態表。** `account_cards` 是 `view_slots` 裡同一個場合、同一個平台、現在的帳號相同的列數，走一個索引（`src/views.ts` 的 `accountCards`）。[#67](https://github.com/iamreal-tw/iamreal/issues/67) 的做法是每寫一筆掃同一個場合每張卡片存著的 `slots`，其中一列壞掉，那個場合的每一筆送出都回 `500`。現在：

- 一張卡片存著的狀態壞掉，別的卡片照常送出、照常寫入
- 數出來的數字照樣算到那張卡片：衍生表是每一筆紀錄寫進去的，不是從卡片狀態表讀來的，所以不會因為有一列讀不出來就少數
- 那張卡片自己的送出回 `500`、什麼都不寫：紀錄規則要讀它的狀態，讀不出來就不套規則（`src/card-table.ts` 的 `readCard`）。它的島民證明照常打得開，頁面不讀卡片狀態表

[`test/views.test.ts`](test/views.test.ts) 把一張卡片存著的名額改成不是 JSON 的字來確認這三件事。

**序號**是寫入那一刻的筆數加一。紀錄雜湊要用到序號，而算雜湊（WebCrypto）是非同步的，所以做法是：先照現在的筆數算好雜湊和指紋，接著從檢查到寫入一口氣做完、中間不等任何東西，而且一開始先確認筆數沒有變；變了就重算。所以不會有兩筆拿到同一個序號，每一筆都是照前一筆留下的狀態檢查的。本機的 workerd 裡算雜湊不會讓別的請求插進來（20 個請求同時送，筆數也不會在這中間改變），所以測試專用的建置可以讓 Durable Object 在算雜湊之前先等幾毫秒（`PUT /__test/proof-log/hash-delay`；`src/proof-log.ts` 的 `hashOf` 就是為了這個拆出來的，只有測試專用的建置覆寫它）：等的時候別的請求會插進來，20 個同時送的請求就會拿著同一個筆數算雜湊。測試確認這時 20 筆仍然各拿到一個序號、存下來的紀錄檔驗得過，而且有紀錄重算過。拿掉確認筆數的那一行，這個測試會看到 `500`（序號重複的那一筆因為主鍵寫不進去）。

紀錄寫進 Durable Object 的 `records` 表；一檔寫滿 1,000 筆之後搬到 R2（[寫滿的紀錄檔搬到 R2](#寫滿的紀錄檔搬到-r2)），還沒寫滿的最後一檔留在表裡，每天換日時照那一刻的內容公布一次（[每天換日公布證明紀錄](#每天換日公布證明紀錄)）。存著的那一行、每一筆的紀錄雜湊和指紋、證明紀錄那一列的筆數和指紋，部署的後台沒有任何介面讀得到。測試從兩個地方拿整份證明紀錄：搬走的檔從 R2 的模擬讀，還留著的從測試專用建置的 `GET /__test/proof-log/stored` 讀。[`test/records.ts`](test/records.ts) 的 `checkProofLog` 只拿每一行，用 `protocol/` 照 `spec/record.md` 重算：留著的紀錄緊接在搬走的檔之後、搬走的每一檔在 R2 裡剛好 1,000 行；每一行讀得過（「Check a line」）、序號從 1 連續；R2 裡每一份雜湊清單的每一行、存著的紀錄雜湊和每一筆之後的指紋都對；證明紀錄那一列的筆數和指紋是最後一筆的。它對應 Go 舊後台測試裡檢查證明紀錄的那一段（它的 `harness_test.go`），用在同時送出、`empty` 和 `switch_limit`、`switch_restricted`、`daily_limit` 的案例。

### 寫滿的紀錄檔搬到 R2

證明紀錄每 1,000 筆切一檔（`spec/record.md`「The published proof log」）。一檔寫滿之後，證明紀錄的 Durable Object 把它和它的雜湊清單寫進資料儲存桶（ADR-0027），讀回來核對過，才刪掉自己存的那 1,000 筆。程式在 [`src/proof-log.ts`](src/proof-log.ts) 的 `#moveFile` 和 [`src/proof-log-files.ts`](src/proof-log-files.ts)；檔名和雜湊清單的寫法在 `protocol/`（`proofLogFileName`、`hashListName`、`hashList`），拿 `spec/vectors/record.json` 的紀錄目錄核對。測試在 [`test/proof-log-files.test.ts`](test/proof-log-files.test.ts)。

| R2 的物件 | 內容 | `Cache-Control` | `Content-Type` |
|---|---|---|---|
| `proof-log/0000000000000000.jsonl`、`proof-log/0000000000001000.jsonl`…… | 寫滿的紀錄檔：1,000 筆紀錄的那一行，照序號接起來 | `public, max-age=31536000, immutable` | `application/x-ndjson` |
| `proof-log/hashes/0000000000000000.txt`…… | 那一檔的雜湊清單：第一行是前一檔結尾的指紋（第一檔是 64 個 0），之後每筆紀錄的雜湊一行 | `public, max-age=31536000, immutable` | `text/plain; charset=utf-8` |

寫滿的檔和它的清單之後不會再變，所以標一年；資料網域的快取只照物件上的標頭，沒標的不快取。唯一會讓同一個網址換內容的是清空測試的證明紀錄，那時要另外清快取（[清空測試的證明紀錄](#清空測試的證明紀錄)第 4 步、「清不到的快取」）。

`Content-Type` 寫入時一起設（營運者 2026-11-20 決定，[#149](https://github.com/iamreal-tw/iamreal/issues/149)），兩個字串定義在 `src/proof-log-files.ts` 一處，之後紀錄目錄裡其他 `.jsonl` 的檔用同一個：

- 雜湊清單是給人拿來核對的文字，標 `text/plain; charset=utf-8`，瀏覽器點開就直接顯示。
- 紀錄檔標 `application/x-ndjson`。這不是 IANA 註冊的型別，只是這種一行一個 JSON 的檔常見的寫法；`iamreal-verify` 和照規格讀證明紀錄的人都不看它。
- 清冊存檔（`crl/` 底下）的物件寫入時沒有設 `Content-Type`，已經寫出去的不動，所以兩邊不同。

還沒寫滿的最後一檔、指紋檔、卡片狀態檔是每天換日時寫的，標 60 秒（[每天換日公布證明紀錄](#每天換日公布證明紀錄)）。

**寫入第 1,000 筆的回應不等 R2。** 紀錄在寫入的交易提交時就算寫入了（[寫入是一個交易](#寫入是一個交易)），搬檔是之後的事：寫滿一檔的那一筆只多做一件事，把物件的 alarm 設好（約 1 秒後響），alarm 設不成也不影響那一筆的 `201`：那時寫一行 `{"event":"alarm_not_set","error":"Error"}`，下一次發題目時會再設。搬檔是 `timedWork()` 的一件（[過期的題目怎麼刪](#過期的題目怎麼刪)），alarm 響的時候做。寫 R2 是非同步的，放不進寫入一筆的那個 SQLite 交易；等 R2 的時候，物件照常收別的請求，新的紀錄屬於下一檔，搬檔不讀它們。

搬一檔的步驟，照順序：

1. 從存著的 1,000 筆組出紀錄檔和雜湊清單的位元組。只用存著的東西，所以重做一次組出來的位元組相同
2. 寫紀錄檔，連同它的 SHA-256 一起交給 R2；讀回來，逐位元組比對，`Cache-Control` 和 `Content-Type` 也比對
3. 寫雜湊清單，讀回來，同樣比對
4. 一個交易裡：`full_files` 記下這一檔（它之前的筆數、結尾的指紋、檔案的 SHA-256），刪掉 `records` 裡的那 1,000 筆

- **先寫紀錄檔，再寫清單。** 規格說沒有紀錄檔的雜湊清單是一個問題（「There is no list without a log file」），所以任何時刻儲存桶裡不會有清單而沒有它的紀錄檔。兩步之間有紀錄檔而沒有清單的那一段，那一檔還沒被任何一行指紋檔涵蓋：指紋檔的那一行要等兩個物件都寫好才會有（每天公布的那一步，還沒做）。
- **任何一步失敗，紀錄不刪。** 寫不進去、R2 收到的位元組和 SHA-256 不符、讀不回來、讀回來的位元組或標頭不同，都停在那一步，寫一行 `{"event":"full_file_not_moved","error":"Error"}`（`error` 是例外的類別名稱），一分鐘後重做，連續失敗時等得更久（[過期的題目怎麼刪](#過期的題目怎麼刪)的「失敗後多久再試」）。重做是整個再來一次：兩個物件都重寫，位元組和沒失敗時相同。第一次只等一分鐘也不更短，是為了避開 R2 的限制：同一個物件一秒最多寫一次，超過回 `429`（[R2 limits](https://developers.cloudflare.com/r2/platform/limits/)：「Maximum concurrent writes to the same object name (key)：1 per second」，2026-11-20 讀的）。
- **寫完 R2、還沒刪就重啟**：物件重新啟動後紀錄還在，照上面重做一次，兩個物件被同樣的位元組重寫，然後才刪。重啟之後照存著的下一次的時間做（[過期的題目怎麼刪](#過期的題目怎麼刪)的「失敗後多久再試」）。
- **寫入時帶著 SHA-256**（`put` 的 `sha256` 選項）。只靠讀回來核對的話，錯的位元組要等寫進去之後才看得出來，那時它已經帶著一年的快取標頭在公開的網址上，至少留到一分鐘後重寫。R2 的文件寫這個選項是「A SHA-256 hash to use to check the received object's integrity」（[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)，2026-11-20 讀的），沒有寫不符時會怎樣。**不符時的行為是在本機的 workerd 上看到的，Cloudflare 上還沒確認**：`put` 丟例外（「The SHA-256 checksum you specified did not match what we received」），物件沒有被寫入。所以讀回來核對照樣留著：它不靠這個選項，也管得到「R2 存下來的和它收到的不同」和標頭。
- **讀回來核對靠得住的理由**：R2 的寫入是強一致的，寫入成功之後的讀取一定看得到新的物件（[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)：「R2 writes are strongly consistent. Once the Promise resolves, all subsequent read operations will see this key value pair globally」，2026-11-20 讀的）。
- **同時只有一次搬檔。** 物件在記憶體裡記著正在進行的那一次；搬檔還沒結束時再被觸發（測試直接跑 alarm 時會發生），等的是同一次。一次搬檔把物件裡寫滿的檔由前往後都搬完。
- **失敗不影響別的。** 搬不成時紀錄照常寫入、題目照常過期、頁面照常：頁面只讀衍生表。物件裡會多留紀錄，直到搬成。
- **`paused` 時照樣搬**：搬檔不套紀錄規則，只搬已經寫入的那幾行。

**和每天公布的關係**：指紋檔的一行要涵蓋的紀錄，在寫那一行之前都要下載得到，所以每天公布先確定寫滿的檔都搬完了（`#moveFullFiles`），再寫最後一檔。最後一檔的雜湊清單第一行，是 `full_files` 最後一列的 `fingerprint_after`。最後一檔寫滿之後，同一個檔名會被搬檔蓋成 1,000 行、標一年的那一份。**最後一檔和寫滿的檔同名，所以最後一檔只能從 alarm 的定時工作裡寫**：定時工作在一次 alarm 裡一件做完才做下一件，寫最後一檔就不會落在搬檔「讀回來核對過」和「刪掉紀錄」之間；從別的地方寫，可能把剛核對過的 1,000 行蓋成比較短的舊檔，而物件接著就刪了那 1,000 筆。

**記憶體**：一檔約 20 MB（一筆約 20 KB，幾乎都是證明）。搬檔時各行直接寫進一塊緩衝區，寫入後讀回來是邊讀邊比，不另外存一份。重建衍生表的那條路不一樣：一次讀一檔，但那一檔同時有位元組、解出來的字串和切好的 1,000 行在記憶體裡，另外有一張每張卡片一項的表（規則的狀態），隨卡片數變大、沒有上限。都沒有量過。

**只在本機的 workerd 上跑過，Cloudflare 上還沒看過的**：一次寫一個 20 MB 的物件、讀回來要多久；搬檔時物件的記憶體高點；R2 寫入失敗時實際丟的是什麼。測試的證明紀錄現在不到 1,000 筆，第一次寫滿時要看 `wrangler tail` 有沒有 `full_file_not_moved`，和 `test-data.iamreal.tw/proof-log/0000000000000000.jsonl` 的回應標頭。

**Go 讀得懂**：`test/proof-log-files.test.ts` 寫入 2,001 筆，把 R2 的模擬裡的紀錄目錄抄到一個目錄，跑 `go test -run '^TestWorkerDirectory$' ./cmd/iamreal-verify`（環境變數 `IAMREAL_WORKER_DIRECTORY` 指到那個目錄；[`cmd/iamreal-verify/worker_directory_test.go`](../cmd/iamreal-verify/worker_directory_test.go)）。那個測試用 `iamreal-verify` 讀紀錄目錄的同一段程式，配它自己測試用的假驗證器和假清冊存檔（證明是佔位的位元組）：兩檔 2,000 筆讀得過、每一筆有效、指紋和這裡算的相同、兩份雜湊清單和它從紀錄重寫的逐位元組相同、一張有四筆紀錄的卡片算出來的現況和 `card-state` 相同。它唯一報的問題是少了 `fingerprints.jsonl`。要有 `go`；沒有時跳過，設了 `CI` 或 `IAMREAL_BB` 時沒有 `go` 是失敗。用真的 `bb`、真的清冊存檔、指紋檔、卡片狀態檔走完整條路的比對，等每天公布做好。

### 每天換日公布證明紀錄

證明紀錄每天公布一次（ADR-0027「每天換日時」；`spec/record.md`「What is published when」）：台灣的日期換了之後，物件的 alarm 第一次響的時候。程式在 [`src/proof-log.ts`](src/proof-log.ts) 的 `#dailyPublication`、`#publish`、`#publicationMoment`、`#writeLastFile`、`#writeCardStateFile`、`#fingerprintFileToWrite`、`#writeFingerprintFile`，卡片狀態表的複本在 [`src/card-table.ts`](src/card-table.ts)；指紋檔那一行的寫法在 `protocol/`（`fingerprintLine`），卡片狀態檔的寫法也是（一次寫一列的 `cardStateFileWriter`，`spec/record-rules.md`「The card state file」）。測試在 [`test/publication.test.ts`](test/publication.test.ts)、[`test/publication-verify.test.ts`](test/publication-verify.test.ts)。

一次公布照順序做：

0. 把寫滿的紀錄檔都搬完（[寫滿的紀錄檔搬到 R2](#寫滿的紀錄檔搬到-r2)）
1. 還沒寫滿的最後一檔和它的雜湊清單，蓋掉前一天的
2. 當天的卡片狀態檔 `proof-log/card-state/<日期>.jsonl`
3. 指紋檔 `proof-log/fingerprints.jsonl` 多一行

| R2 的物件 | 內容 | `Cache-Control` | `Content-Type` |
|---|---|---|---|
| `proof-log/<筆數>.jsonl`（最後一檔） | 最後一檔在那一刻的每一行，1 到 999 行 | `public, max-age=60` | `application/x-ndjson` |
| `proof-log/hashes/<筆數>.txt` | 它的雜湊清單 | `public, max-age=60` | `text/plain; charset=utf-8` |
| `proof-log/card-state/<日期>.jsonl` | 那一刻每張有過有效紀錄的卡片一列 | `public, max-age=60` | `application/x-ndjson` |
| `proof-log/fingerprints.jsonl` | 每個公布過的日期一行：日期、筆數、指紋 | `public, max-age=60` | `application/x-ndjson` |

最後一檔、雜湊清單、指紋檔都和搬檔一樣寫：帶 SHA-256、讀回來逐位元組和標頭都核對。卡片狀態檔用串流寫（[大小的上限](#每天換日公布證明紀錄)那一段）：一樣帶 SHA-256，讀回來比長度、SHA-256 和標頭。

- **同一刻。** 日期、筆數、指紋和卡片狀態表的複本，是在同一段不等任何東西的程式裡取的（`#publicationMoment`，中間沒有 `await`）。複本是用 SQLite 把卡片狀態表整張複製成另一張表 `cards_copy`，資料不經過 JavaScript。之後的讀和寫都可以等：最後一檔用 `seq` 不超過那一刻筆數的紀錄組成（紀錄只往後加，那些不會變，所以不需要複本），卡片狀態檔只從複本讀。所以卡片狀態檔就是那一行 `count` 筆之後的狀態，這是它的格式要的。寫 R2 的那段時間照常收紀錄，那些紀錄等下一次公布。測試讓最後一檔的寫入慢下來、中間寫入一筆，又讓卡片狀態檔的寫入慢下來、中間寫入兩筆（改一張檔裡有的卡片、一張新卡片），確認都不在當天公布的東西裡；後面那一種也在 `test/publication-verify.test.ts` 交給 `iamreal-verify` 重驗。
- **複本用完就刪。** 那一列寫進 `published` 之後馬上刪掉；公布中斷時也刪。物件在公布途中停掉留下的複本不拿來用：下一次公布先刪掉再複製。複本只有公布讀，查卡片、過卡讀的都是 `cards`。
- **沒有最後一檔可寫的時候不寫。** 筆數剛好是 1,000 的倍數時，每一檔都寫滿、都搬走了；筆數是 0 時一檔都沒有（規格：沒有空的紀錄檔）。卡片狀態檔和指紋檔的那一行照寫，空的證明紀錄是一個 0 位元組的卡片狀態檔和「筆數 0、64 個 0」的一行。
- **那一行最後寫，前面有一步沒成就不寫。** 指紋檔的一行涵蓋的每一筆紀錄，在那一行出現時都下載得到。
- **一個日期的那一行，由物件裡的一列決定**（`published` 表）。第 3 步分兩下：先寫那一列，再把指紋檔寫出去。
  - 那一列還沒寫之前失敗（第 0、1、2 步，或寫那一列本身）：一分鐘後整個重做，照重做那一刻的證明紀錄，三步都重寫，筆數可能比上一次試的時候多。
  - 那一列寫了之後：這個日期就算公布了，當天不再公布任何東西，那一行不再變。同一天後來又有紀錄，也等隔天（`spec/record.md`：同一個日期只公布一次）。
  - 那一列寫了、指紋檔沒寫成：一分鐘後只重寫指紋檔，內容是那一列記的（公布那一刻的筆數和指紋），最後一檔和卡片狀態檔不重寫。`GET /api/v1/fingerprint` 在指紋檔寫成之前回的還是前一行。
- **後台不刪、不改任何一行已經公開的指紋。** 指紋檔每次整個從 `published` 表寫出來，但寫之前先讀儲存桶裡現有的那一份：現有的內容必須是要寫的內容的開頭。
  - 是開頭的（檔不存在、是空的、少了後面幾行、斷在一行中間）：照表整個寫，少的行補回來。**補回來的時間是下一次公布**，通常是隔天的台灣午夜：物件只在有一行還沒寫進檔的時候才寫指紋檔，每一行都寫過之後，同一天的 alarm 和物件重啟都不會去看儲存桶。所以儲存桶裡的指紋檔被刪掉的話，最長約一天公開的指紋檔不在，那段時間 `iamreal-verify` 拿不到指紋檔；`GET /api/v1/fingerprint` 照常回答。
  - 不是的（有一行表裡沒有、或某一行和表裡的不同）：**這一次公布整個不做**，在寫任何東西之前就停：最後一檔、卡片狀態檔、那一列、指紋檔都不寫。寫一行 `{"event":"fingerprint_file_differs","error":"Error"}`（不含檔的內容），一分鐘後再看一次，直到有人處理；一直不是的話，看的間隔拉長到每小時一次（[過期的題目怎麼刪](#過期的題目怎麼刪)的「失敗後多久再試」）。`GET /api/v1/fingerprint` 維持原樣。
  - 為什麼整個不做、不是只跳過第 3 步：儲存桶裡的指紋檔不是這個物件的，最可能的原因是整個紀錄目錄是另一個物件寫的；那時連最後一檔和卡片狀態檔也不該蓋。
  - 那一列寫了、指紋檔還沒寫成的時候（上一條）也是同一個檢查：儲存桶的檔不是開頭就不寫，每次嘗試一行。
  - **只蓋掉剛看過的那一份。** 看完到寫入之間儲存桶的檔如果又變了，寫入不會發生：寫入帶著條件，只有儲存桶裡還是剛才讀到的那一版（照 ETag），或讀的時候沒有、現在也還沒有，才寫得進去（[R2 的條件式操作](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations)，同一頁 `put` 的說明：「In the event that a precondition specified in `options` fails, `put()` returns `null`, and the object will not be stored.」，2026-11-20 讀的；清冊鏡像寫索引用的是同一個做法）。沒寫成算一般的失敗（`proof_log_not_published`），一分鐘後重新讀、重新比：是開頭就補，不是就 `fingerprint_file_differs`。本機 workerd 的 R2 模擬上，「有檔、ETag 不同了」「讀的時候有、現在沒有」「讀的時候沒有、現在有」三種都不會寫入（`test/publication.test.ts`）；Cloudflare 上沒有另外確認。
  - **會碰到的兩種情況，和營運者要做的**：(1) 清空測試的證明紀錄時換了 `PROOF_LOG_OBJECT_NAME`、沒有清空儲存桶：新的物件表是空的，儲存桶裡還有舊的證明紀錄的指紋檔。照清空的步驟把儲存桶的 `proof-log/` 清掉（[清空測試的證明紀錄](#清空測試的證明紀錄)第 3 步），下一次重試就會公布。(2) 之後從證明紀錄重建物件（ADR-0033）：重建出來的物件要先把 `published` 表從公開的指紋檔灌回來，不然它的表比公開的檔短，會停在這裡。正式的證明紀錄裡看到這一行事件，表示公開的指紋檔和物件記的不一樣，要先查出是哪一邊，不要為了讓它公布而刪掉儲存桶的檔。
  - 這個檢查擋的只有每天公布寫的四樣。寫滿的紀錄檔照搬：換了物件名稱沒清儲存桶時，新的證明紀錄寫滿的檔會蓋掉舊的證明紀錄同名的檔。
- **寫入那一行之前再看一次日期**：寫 R2 的時候剛好跨過午夜的話，這一次不算，一分鐘後照新的日期重做。一行的日期是它寫入那天的台灣日期。
- **失敗**：寫一行 `{"event":"proof_log_not_published","error":"Error"}`（儲存桶的指紋檔不是物件的那一種是 `fingerprint_file_differs`，見上面），一分鐘後重做；連續失敗時等得更久，兩種失敗算在一起（[過期的題目怎麼刪](#過期的題目怎麼刪)的「失敗後多久再試」）。一件失敗不擋別的定時工作，各自算各自的等待（[過期的題目怎麼刪](#過期的題目怎麼刪)）。上面寫「一分鐘後」的地方，都是指連續失敗的第一次。
- **有一張卡片存著的狀態寫不成一列時，整個公布不成**（例如存著的名額不是 JSON、平台不在平台表裡）：那一天沒有新的一行，每次嘗試一行 `proof_log_not_published`（間隔照上一條拉長）。每一列在寫的時候檢查格式、而且卡片比前一列大（`cardStateFileWriter`）；複本讀第一遍時就全部檢查過，有一列不對就在寫出卡片狀態檔的任何位元組之前停。那時最後一檔和雜湊清單已經寫了，下一次公布會蓋掉。狀態只是不合規則、但寫得成一列的，照寫出去：卡片狀態檔就是要讓重驗的人看到錯的狀態。營運者知道「今天沒有公布」，是靠[從外面定時檢查](../.github/README.md#從外面定時檢查53)：台灣時間 01:00 之後，資料網域的指紋檔沒有今天那一行、或沒有今天的卡片狀態檔，那一個整點後的檢查就失敗，GitHub 寄通知信（[#53](https://github.com/iamreal-tw/iamreal/issues/53)）。

**什麼時候公布**

- 到期的時間是「上一次公布的日期」隔天的台灣時間零點（UTC 16:00）；用的是物件的時鐘。alarm 設在那個時間，實際在它響的時候做。
- **第一次**：物件第一次用這一版程式啟動的那一天不公布（`first_day` 表記著那一天），從隔天零點開始。所以部署之後的第一行，是部署後第一個台灣午夜那一天的。
- **alarm 晚響、或一整天都沒公布成**（一直失敗）：不補。下一次公布成的那一行寫的是那一天的日期，中間的日期沒有行。規格只要求日期一行比一行晚。
- **`paused`**（存著的規則版本和程式的不同）：不公布，寫滿的檔照搬。那時存著的卡片狀態是另一版規則算的，公布出去會被當成這一版的。恢復之後照常：下一次 alarm 就公布當天的。
- 最後一檔和寫滿之後的那一檔同名，所以最後一檔只在這件定時工作裡寫：一次 alarm 裡的工作一件做完才做下一件，不會落在搬檔「核對過」和「刪掉紀錄」之間（[寫滿的紀錄檔搬到 R2](#寫滿的紀錄檔搬到-r2)）。公布和搬檔會在不同時候寫同一個檔名，兩者的先後靠的就是這一點，程式裡沒有另外的鎖：一個物件的 alarm 不會同時跑兩個（[Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)：「Only one instance of `alarm()` will ever run at a given time per Durable Object instance.」，2026-11-20 讀的），而一次 alarm 裡的定時工作是依序做的。公布寫了最後一檔之後不到一秒，那一檔剛好寫滿、搬檔寫同一個檔名的話，會碰到 R2 一秒一次的限制：搬檔那一次失敗，一分鐘後重做。

**大小的上限**（在本機的 workerd 上量過；Cloudflare 上還沒量，[#196](https://github.com/iamreal-tw/iamreal/issues/196)）

一次公布在記憶體裡握著的東西不隨卡片數長大：

- **卡片狀態檔**從複本一批 1,000 列讀、一批寫（`#cardStateChunks`），同時在記憶體裡的只有一批的列、文字和位元組，一批幾百 KB。每一批是一次獨立的查詢，讀完才交出去，等 R2 的時候沒有開著的查詢。每一批之間等一個 0 毫秒的計時器，讓物件收這段時間進來的請求：沒有它的話，第一遍只等每一批的雜湊，整遍讀完之前一個請求都進不來。
  - 複本讀兩遍：第一遍算長度和 SHA-256（`crypto.DigestStream`），第二遍當串流寫給 R2（`writeStreamAndReadBack`）。R2 只收知道長度的串流，所以串流接過一個給定長度的 `FixedLengthStream`；R2 照樣收到 SHA-256，收到的不是那些位元組就不存，串流給的位元組數不對也不存。讀回來時一樣邊讀邊算 SHA-256，比長度、SHA-256 和標頭，不握著寫出去的位元組。
  - 這幾件在本機的 workerd 上試過（2026-11-21）：給長度的串流 `put` 寫得進去，邊讀邊算的 SHA-256 和整塊算的相同；SHA-256 給錯、長度不符時 `put` 失敗，儲存桶裡沒有那個物件；沒給長度的串流 `put` 直接被拒。
- **最後一檔**最多 999 行，和搬檔一樣直接寫進一塊緩衝區（`#storedFile`），只有一份位元組，快寫滿時約 20 MB；它和雜湊清單寫完、放掉之後才開始寫卡片狀態檔。
- 複本在 SQLite 裡複製，不經過 JavaScript。SQLite 複製時用的記憶體算不算在 isolate 的 128 MB 裡（[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)：「Each isolate can consume up to 128 MB of memory, including the JavaScript heap and WebAssembly allocations」，2026-11-20 讀的），還沒量（#196）。

**本機 workerd 上量到的**（2026-11-21，Apple Silicon 的 Mac）：

- 量法：[`test/publication-size.ts`](test/publication-size.ts)，`node --experimental-strip-types test/publication-size.ts [卡片數]`。它不是 `pnpm test` 的一部分。它透過測試建置的門把假卡片直接寫進測試的證明紀錄物件的卡片狀態表（證明紀錄沒有紀錄，所以公布不寫最後一檔），從 Node 這邊計時：單獨複製卡片狀態表、刪掉複本各三次，和台灣午夜的一次 alarm（整次公布）；公布期間每 10 ms 對物件送一個請求，記最久等了多久。最後比 R2 裡的卡片狀態檔和 `cardStateFile` 對同樣的卡片一次組出來的。
- 20 萬張卡片（每張一個 Threads 名額，三張有一張另有 test-example 名額；卡片狀態檔 68.7 MB），跑兩輪：
  - 複製卡片狀態表 371 到 1,100 ms（六次，每輪第一次最久），刪掉複本 17 到 32 ms
  - 整次公布 5.4 秒、7.5 秒
  - 公布期間一個請求最久等了 388 ms、547 ms，和複製那一段差不多：複製是在一段不等任何東西的程式裡做的（同一刻要的就是這個），這段時間過卡的請求在等。其他時候物件照常收請求。
  - R2 裡的卡片狀態檔逐位元組等於 `cardStateFile` 一次組出來的；公布完物件的資料庫裡沒有複本
- 本機的 workerd 上，物件在等 R2 寫入、讀回的時候不收請求（一次組出整個檔的舊做法在 2 萬張卡片時，一個請求等到寫完 R2：整次 363 ms 裡等了 347 ms）。現在每一批之間有計時器，所以不受這個影響。Cloudflare 上是不是這樣，和上面的數字一起要在 #196 量。

**撞到上限時會怎樣**（照程式和文件推的，沒有試過）：不會寫出截斷的檔。卡片狀態檔寫到一半斷掉時，R2 收到的位元組數或 SHA-256 不對，不存（測試讓寫入在串流中間斷掉，儲存桶裡沒有那個檔、指紋檔沒有那一行、複本沒有留下，重做時照重做那一刻的證明紀錄）；其他物件先在記憶體裡組好、算好 SHA-256 才交給 R2。指紋檔的那一行排在最後。同一頁文件寫超過記憶體上限時「the Workers runtime lets in-flight requests complete and creates a new isolate for subsequent requests」：物件換了 isolate 的話，下一次再試的時間和失敗的次數存在物件的儲存裡，照樣在，等的時間照樣拉長（[過期的題目怎麼刪](#過期的題目怎麼刪)的「失敗後多久再試」）。

- **指紋檔**一天多一行，一行 110 個位元組上下：一年約 40 KB，一次公布讀它三次（開始前看一次、寫之前再看一次、寫完讀回核對一次）、整個重寫一次。

**部署後要營運者做的**

- 儲存桶的生命週期規則：刪掉 `proof-log/card-state/` 底下超過 7 天的物件（ADR-0027「留多久」）。這是儲存桶的設定，程式不刪卡片狀態檔；沒設的話每天多一個檔，一直留著。測試的儲存桶 `iamreal-test-data` 已經有這條規則：名稱 `card-state-7-days`，物件建立 7 天後刪除（2026-11-20 在儀表板確認，[#185](https://github.com/iamreal-tw/iamreal/issues/185)）；它的前綴當時是改名之前的目錄，[#277](https://github.com/iamreal-tw/iamreal/issues/277) 部署之後由營運者改成 `proof-log/card-state/`。正式的儲存桶建立時同樣要設（[#111](https://github.com/iamreal-tw/iamreal/issues/111)）。
- 部署後第一個台灣午夜過後，看 `https://test-data.iamreal.tw/proof-log/fingerprints.jsonl` 有沒有那一天的一行、`proof-log/card-state/<那一天>.jsonl` 在不在、兩個的 `Cache-Control` 是不是 `public, max-age=60`；`wrangler tail` 有沒有 `proof_log_not_published`。然後用 `iamreal-verify -proof-log test -data https://test-data.iamreal.tw/` 重驗一次。
- **第一次公布看過了**（2026-11-21 03:30 UTC 看的；這一版是 2026-11-20 13:40 UTC 前後部署的）：
  - 指紋檔在 2026-11-20 16:00:03 UTC 寫出（`Last-Modified`），一行：`{"date":"2026-11-21","count":0,"fingerprint":"000…0"}`（64 個 0）。`GET /api/v1/fingerprint` 回同一行。
  - 卡片狀態檔 `card-state/2026-11-21.jsonl` 在（當時證明紀錄的檔在改名之前的目錄，[#277](https://github.com/iamreal-tw/iamreal/issues/277) 改成 `proof-log/`），0 位元組（`Last-Modified` 16:00:02 UTC）。兩個物件都是 `Cache-Control: public, max-age=60`、`Content-Type: application/x-ndjson`。
  - `main`（`ea18b94`）建出來的 `iamreal-verify` 讀測試的證明紀錄（`-data https://test-data.iamreal.tw/`，旗標和輸出的字是改名之前的，#277 之後旗標是 `-proof-log test`）：紀錄檔合格、`records: 0`、`fingerprints.jsonl` 1 行而且每一行的指紋都對、`card-state/2026-11-21.jsonl` 0 張相同、0 張跳過，結束碼 0。
  - **那時測試的證明紀錄是 0 筆，所以看到的只有空的證明紀錄的公布。** 還沒在 Cloudflare 上看過的：最後一檔和它的雜湊清單（0 筆時沒有這兩個物件，第一檔 `0000000000000000.jsonl` 是 `404`）、有內容的卡片狀態檔、指紋檔第二行之後的條件式寫入（第一次是「讀的時候沒有、現在也還沒有」那一種）。測試的證明紀錄有紀錄之後的下一個台灣午夜要再看一次。

**整條路的比對**（[#70](https://github.com/iamreal-tw/iamreal/issues/70) 的驗收條件），兩個測試，都要有 `go`：

| | [`test/publication-verify.test.ts`](test/publication-verify.test.ts) | [`test/records-real.test.ts`](test/records-real.test.ts) 的第二項 |
|---|---|---|
| 證明紀錄 | 假卡片 2,005 筆，三天：第一天 998 筆；第二天再 2 筆，剛好寫滿第一檔（那一次公布沒有最後一檔可寫）；第三天到 2,003 筆；之後 2 筆沒有任何一行涵蓋，是在最後一次公布寫卡片狀態檔的途中寫進來的（改一張檔裡有的卡片、一張新卡片）。有更正、更換、收回、兩個平台 | `cmd/iamreal-verify/testdata/card-proofs/` 的 11 筆，五天，最後一天之後公布一次（前面幾天物件自己的 alarm 剛好響了的話，那幾天也各有一行） |
| 證明 | 佔位的位元組；後台用替身驗證器，Go 用它測試的假驗證器 | 真的證明；後台用部署的驗證器，Go 用原生的 `bb`（要設 `IAMREAL_BB`） |
| 清冊存檔 | 後台的鏡像從假的內政部抓來寫進 R2 的；Go 用測試的發證金鑰重新驗章、建樹 | 同左，發證金鑰是 `cmd/iamreal-verify/testdata/card-proofs/` 的 |
| Go 怎麼跑 | `go test -run '^TestWorkerData$' ./cmd/iamreal-verify`：指令的 `run`，只給 `-proof-log test -data <R2 的模擬抄下來的目錄>` | `go build -tags iamrealtest` 建出來的執行檔，`-data` 加測試建置才有的 `-test-issuers` |
| 結果 | 結束碼 0；2,003 筆每一筆有效、指紋相同；指紋檔三行、三份雜湊清單都對；卡片狀態檔 1,998 張都是相同、沒有跳過；清冊存檔的索引和重建的相同；三張改過清單的卡片的現況和 `card-state` 相同 | 結束碼 0；11 筆每一筆有效；指紋檔的每一行、一份雜湊清單都對；卡片狀態檔 2 張都是相同 |

兩個測試都把整個 R2 的模擬抄成一個目錄交給 Go，Go 那邊讀的是預設的讀法會讀的每一樣：指紋檔、它最後一行筆數以內的紀錄檔和雜湊清單、最後一行那天的卡片狀態檔、清冊存檔的索引和每一份清冊。假卡片的那一個比不到的只有證明；真的證明的那一個只有 11 筆，沒有跨過 1,000 筆。

### 紀錄規則和 Go 的 `prooflog/` 逐筆比對

刪掉舊的後台之前，要確定這裡的每一筆判斷都和 Go 的 `prooflog/` 相同（[#9](https://github.com/iamreal-tw/iamreal/issues/9) 結論第 8 項）。分三層，三層都過才算：

| | 比什麼 | 在哪裡 |
|---|---|---|
| 1 | `spec/vectors/record-rules.json` 的每一案，配 Durable Object 的儲存，每筆之間重啟 | `test/records-storage.test.ts` |
| 2 | 一串固定種子產生的長序列，`protocol/` 的規則配記憶體（`MemoryRules`），以 Go 的 `prooflog/` 當答案 | `test/sequence.test.ts` |
| 3 | 同一串，配 Durable Object 的儲存，每一筆之間重啟證明紀錄的 Durable Object | `test/sequence.test.ts` |

第 2、3 層（[#73](https://github.com/iamreal-tw/iamreal/issues/73)）在同一個檔。第 2 層在 `pnpm test` 裡，改到 `typescript` 清單的 PR 和合併佇列都跑（不到 1 秒；清單見 `.github/README.md`「必要檢查在 PR 階段照路徑跳過」，`worker/` 整個在裡面）。第 3 層約 107 秒，幾乎是這個檔全部的時間，只在設了 `IAMREAL_SEQUENCE_STORAGE=1` 時跑，沒設時測試的輸出列它為跳過並寫明原因。在這個目錄：

```sh
node --experimental-strip-types --test test/sequence.test.ts                             # 第 2 層
IAMREAL_SEQUENCE_STORAGE=1 node --experimental-strip-types --test test/sequence.test.ts  # 第 2、3 層
```

**什麼時候要跑第 3 層**：改到紀錄規則的狀態怎麼存、怎麼讀的時候，也就是 `src/proof-log.ts` 的 `ruleState`、`keepRuleState`、`accountCards`，`src/card-table.ts`，數卡片查的衍生表（`src/views.ts` 的 `viewOf`、`writeView`、`accountCards`），和這些表的結構；刪掉舊的後台之前也要跑一次。PR 的說明寫跑的結果。為什麼不是每個 PR 都跑：規則本身的不同由第 2 層擋著，存了再讀的不同由第 1 層擋著（標準答案的每一案，每筆之間重啟），兩層都在改到 `typescript` 清單的 PR 和合併佇列跑；第 3 層多守的是長序列累積出來的狀態存了再讀，只有上面那幾處會改變它，而每個 PR 多跑約 2 分鐘（維護者 2026-11-20 決定）。CI 上不在這些路徑有改時自動跑。這是 [#69](https://github.com/iamreal-tw/iamreal/issues/69) 施工時定的（那張票把這個問題留給施工的人），不是量過之後的結論，維護者可以改。理由：`checks.yml` 的工作固定是四個必要檢查，要照路徑多跑一項就得多一個工作流程檔和它在 `test/workflows.ts` 的一份白名單，換來的只是上面那幾處有改時少一個手動的步驟。所以改到上面那幾處、或要刪掉舊的後台時，在這個目錄手動跑 `IAMREAL_SEQUENCE_STORAGE=1 node --experimental-strip-types --test test/sequence.test.ts`，PR 的說明寫結果；沒改到的 PR 寫明沒改到。

要有 `go`：沒有時跳過，但設了 `CI` 或 `IAMREAL_BB` 時沒有 `go` 是失敗，和 `test/workflows.test.ts` 相同。

做的事：

1. **產生一串紀錄。** [`test/sequence.ts`](test/sequence.ts) 的 `generateSequence` 從種子（現在是 1）產生 10,000 筆測試的證明紀錄（兩個平台）的事件。它不知道規則，只記得每張卡片在每個平台想宣告哪個帳號，讓規則的各種情況常常發生：160 張卡片，同一時間只有 8 張在送、每 64 筆換一張，偶爾是剛離開的卡片回來送一筆、日期是 4 天前；每個平台 4 個帳號名稱；一天約 18 筆，日期大多是當天，常常是前一天（午夜前拿的題目），有時往回 2 到 8 天（沒超過和超過檢查 4 的 4 天）、有時往後 1 到 3 天；有時是空的清單、重送最近 30 筆之一的題目、證明不過、沒有一份清冊的日期對得上（含差一天就對得上的）。亂數是自己寫的 mulberry32，只用 32 位元的整數運算，不用 Node 內建的，所以同一個種子產生的序列不隨 Node 的版本改變；同一個種子長一點的序列，開頭就是短的那一串。
2. **Go 算答案。** 測試把序列寫進 `worker/test-output/sequence-…/events.json`，跑 `go test -count=1 -run '^TestSequenceAnswers$' ./prooflog`，環境變數 `IAMREAL_PROOF_LOG_SEQUENCE` 指到那個目錄。`prooflog/sequence_test.go` 用 `prooflog.Rules` 一筆一筆套用，寫同一個目錄的 `answers.json`。兩個檔的格式見下面「交換的檔」。`test-output/` 不進版控（`worker/.gitignore`）：每一項都過時刪掉這個目錄；有任何一項失敗（包括 Go 那邊失敗、最後的現況不同）時留著，失敗的訊息寫著路徑。
3. **比每一筆。** 每一筆的結果（有效或無效、代碼、每個平台的種類）和那張卡片在這一筆之後的狀態（`last_card_proof`、`proofs_on_last_date`、每個名額的 `current`、`last_declared`、`switch_count`、`correction_date`；沒有有效紀錄的卡片是空的狀態）。
   - 記憶體那一次另外每一筆比證明紀錄裡最晚的有效日期，每 100 筆比一次每個帳號底下的卡片數（`account_cards`），最後比整個現況（每張卡片的清單，每個帳號底下的卡片）。
   - Durable Object 那一次，每一筆走測試專用建置的 `POST /__test/proof-log/rule-event`，接著重啟證明紀錄的 Durable Object，再從 `POST /api/v1/card-state` 讀那張卡片。`rule-event` 對有效的一筆除了寫卡片的狀態，也照送出一筆的同一段程式寫衍生表（`viewOf`、`writeView`）：數卡片查的是衍生表。這個入口不存紀錄，所以寫完把衍生表記的筆數放回證明紀錄的筆數，物件重啟時才不會當成衍生表沒跟上、拿不存在的紀錄去重建。每 100 筆（共 100 次，最後一筆也是）再從 `POST /__test/proof-log/rule-state` 讀證明紀錄裡最晚的有效日期（`ruleState` 讀出來給規則的那一個）和每個帳號底下的卡片數（部署的 `accountCards` 那一句查詢數的，就是 `201` 回應裡的 `account_cards`：查衍生表 `view_slots`，不讀卡片狀態表；有哪些帳號則是從卡片狀態表列出來的，所以這一步同時比了兩張表對不對得上），和 Go 的比。
4. **遇到第一筆不同就停**，訊息寫第幾筆、哪張卡片、哪個欄位、兩邊的值，例如（把 `accountCards` 的查詢故意改成最多回 1 時）：

   ```
   record 100 of 10000 (seq 100), card 52BSJ2X5Y0JK8VWSEYGDKTAPYQ6GHCSF333XYD5WCR8C8ZYWNW00, accounts[0].account_cards: Go 3, Durable Object 1. The events and Go's answers are kept in /…/worker/test-output/sequence-…
   ```

   Durable Object 讀不出那張卡片時（存著的狀態不合規則，`card-state` 回 `500`，見[讀卡片狀態時的檢查](#讀卡片狀態時的檢查)），訊息寫第幾筆、哪張卡片。
5. **印出統計，設下限。** 每個代碼、每個平台的每個種類都要至少 100 次。另外數下面幾種情境，下限約是種子 1 實際次數的四分之三，換了種子或改了產生器時確認序列還涵蓋它們。情境從事件和 Go 的答案數，不用 `protocol/`（`test/sequence.ts` 的 `scenarios`）。

**交換的檔**是這兩個測試檔之間的約定（`prooflog/sequence_test.go`、`test/sequence.ts`），不在 `spec/` 裡。它們以 `spec/vectors/record-rules.json` 一個案例的樣子為底，因為 Go 和 TypeScript 互不引用、只共用 `spec/`，這是兩邊本來都讀的格式；找到不一致時，最小的重現案例可以直接寫成標準答案的一案。多出來的欄位：

| 檔 | 和標準答案的案例相同的 | 多出來的 |
|---|---|---|
| `events.json` | `name`、`proof_log`、`events`（事件的欄位相同） | `checkpoint_every`：每幾筆列一次帳號 |
| `answers.json` | 上面三項、`results`、`state`（最後的現況，寫法相同） | `rules_version`；每一筆一項的 `cards`（這一筆之後那張卡片的狀態，寫法和標準答案的 `slots` 相同）和 `latest_valid_dates`（到這一筆為止有效紀錄最晚的日期；`prooflog.Rules` 沒有匯出它，由 Go 的測試照規格的定義從 `Rules` 判為有效的紀錄的日期取）；`checkpoints`（每 `checkpoint_every` 筆和最後一筆之後，每個有卡片宣告的帳號和 `AccountCards` 數的卡片數） |

**這一層測不到搬檔。** 長序列走 `rule-event`，不寫 `records`，所以 10,000 筆裡沒有一檔會寫滿。它確認的是卡片狀態存了再讀沒有被改壞；寫滿的檔搬到 R2 之後證明紀錄、卡片現況、衍生表還對，是 [`test/proof-log-files.test.ts`](test/proof-log-files.test.ts) 負責的（`checkProofLog`、`card-state`、頁面、衍生表逐列比對）。

**這一層沒比到的。** `rule-event` 和真的送出一筆共用的只有讀狀態、寫狀態那兩段（`src/proof-log.ts` 的 `ruleState`、`keepRuleState`）、寫衍生表的那兩段（`src/views.ts` 的 `viewOf`、`writeView`）和 `protocol/` 的 `applyRecord`。送出一筆的第 4 段（`#acceptAt`）其餘的部分這裡都沒走到：

- 題目表：`challenge_unknown`、`challenge_used`、計次。用過的題目記在測試專用建置自己的表（`test_used_challenges`），`challenge_reused` 比的是那張表配規則的檢查 2
- 清冊的政策：`crl_stale`、只認最新兩份清冊的樹根
- 更換政策 `switch_restricted`
- 寫 `records`、證明紀錄那一列的 `count`、`fingerprint` 的交易
- 數 `account_cards` 的查詢在寫入的交易裡跑的那一次（這裡比的是同一句查詢，在交易外面另外叫）

`proof` 和 `root` 兩邊都照事件的旗標回答（`verifies`、`crl_dates`），不驗證證明，也不讀清冊，所以比到的是檢查的先後和檢查 3 的日期範圍（清冊日期的前 1 天到後 3 天），不是驗證器和清冊存檔。這些由 `test/records.test.ts`（每個錯誤代碼和先後順序、題目、清冊、午夜、`201` 的內容）、`test/records-real.test.ts`（真的證明和鏡像抓的清冊）和 `test/records-storage.test.ts`（同時送出、寫到一半失敗、`paused`）守著。

2026-11-20 跑的結果（種子 1，10,000 筆）：Go、記憶體、Durable Object 三邊**沒有一筆不同**，100 次的證明紀錄最晚有效日期和帳號的卡片數也相同，最後的現況也相同。有效 4,766 筆、無效 5,234 筆：

| 代碼 | 筆數 | | 種類 | 次數（`test-example`／`threads`） |
|---|---|---|---|---|
| `proof` | 313 | | `first` | 320（160／160） |
| `challenge_reused` | 279 | | `refresh` | 5,014（2,534／2,480） |
| `root` | 292 | | `correction` | 255（127／128） |
| `date_order` | 1,611 | | `switch` | 1,420（699／721） |
| `empty` | 233 | | `withdraw` | 929（457／472） |
| `switch_limit` | 1,311 | | | |
| `daily_limit` | 1,195 | | | |

| 情境 | 怎麼數 | 次數 | 下限 |
|---|---|---|---|
| 跨午夜 | 有效，日期是證明紀錄裡最晚有效日期的前一天 | 842 | 630 |
| 日期往回超過 4 天 | `date_order`，日期早於證明紀錄裡最晚有效日期超過 4 天 | 408 | 300 |
| 剛好往回 4 天而有效 | 有效，日期剛好是證明紀錄裡最晚有效日期的 4 天前 | 79 | 60 |
| 第 5 次更換 | 一個 `switch` 讓那個名額的 `switch_count` 變成 5 | 223 | 165 |
| 第 6 次被擋 | `switch_limit` | 1,311 | 980 |
| 當天更正 | `correction`，任何平台 | 255 | 190 |
| 全部收回後再宣告 | 有效、清單不是空的，那張卡片之前有有效紀錄、一個帳號都沒宣告 | 307 | 230 |
| 帳號被兩張以上的卡宣告 | 有效，之後清單裡有一個帳號被兩張以上的卡宣告 | 4,414 | 3,300 |

量到的時間（Apple Silicon，本機的 workerd 1.20261110.1）：單獨跑這個檔約 107 秒。Go 算答案（含編譯測試）約 0.7 秒，記憶體 0.07 秒，Durable Object 約 106 秒（含啟動 Worker）：每一筆約 10 ms，是套用、重啟、讀 `card-state` 三次往返，加上 100 次讀 `rule-state`。

## 頁面和檔案

`/api/` 以外的網址分兩種：頁面由 Worker 產生（[`src/visitor.ts`](src/visitor.ts)），檔案由 Cloudflare 的 Static Assets 直接送，不跑 Worker（[Static Assets](#static-assets)）。

| 網址 | 內容 | 從哪裡來 |
|---|---|---|
| `/` | 首頁（`design/copy/home.md`） | Worker 產生，兩個數字問證明紀錄 |
| `/p/<短編號>` | 島民證明（`design/copy/proof-page.md`） | Worker 產生，問證明紀錄 |
| `/threads/@<名稱>` | 查詢頁（`design/copy/account-page.md`） | Worker 產生，名稱合 Threads 的格式才問證明紀錄 |
| `/proof-log` | 證明紀錄頁（`design/copy/proof-log-page.md`）：`?q=` 是查詢框，`?after=` 是「更多」 | Worker 產生，兩個數字和清單一次問證明紀錄；查詢框轉到查詢頁時不問 |
| `/faq` | 常見問題（`design/copy/faq.md`） | Worker 產生，不問證明紀錄 |
| `/verify` | 如何驗證證明紀錄（`design/copy/verify.md`） | Worker 產生，不問證明紀錄 |
| `/check` | 如何檢查 Threads 帳號的島民證明（`design/copy/check.md`） | Worker 產生，不問證明紀錄 |
| `/prepare` | 過卡需要什麼（`design/copy/prepare.md`） | Worker 產生，不問證明紀錄 |
| `/privacy` | 隱私權說明（`design/copy/privacy.md`）；每一頁的頁尾和兩個 app 的設定頁連到這裡 | Worker 產生，不問證明紀錄 |
| `/hang` | 掛上去，從首頁點進來時（`design/copy/hang.md`） | Worker 產生，不問證明紀錄 |
| `/hang/<短編號>` | 掛上去，帶著一張島民證明（`design/copy/hang.md`） | Worker 產生，短編號讀得成才問證明紀錄 |
| `/copy.js` | 複製按鈕的程式，只有 `/faq`、`/verify` 和 `/hang/<短編號>` 載入；在常見問題上也展開網址指到的那一題 | Static Assets 直接送 `site/copy.js`，不跑 Worker |
| `/demo.js` | 掛上去的示範的播放程式（`design/copy/hang.md`「示範」），只有 `/hang` 和 `/hang/<短編號>` 載入 | Static Assets 直接送 `site/demo.js`，不跑 Worker |
| `/pages.css` | 訪客頁面的樣式表 | Static Assets 直接送 `site/pages.css`，不跑 Worker |
| `/og-image.png` | 連結預覽圖（`design/copy/proof-page.md` 第 8 段「預覽圖」） | Static Assets 直接送 `site/og-image.png`，不跑 Worker |
| `/favicon.ico` | 網站的圖示：每一頁的 `<link rel="icon">` 指到這裡，瀏覽器和連結預覽也會自己來要（[#356](https://github.com/iamreal-tw/iamreal/issues/356)） | Static Assets 直接送 `site/favicon.ico`，不跑 Worker |
| `/proof` | 過卡的頁面：`web/` 建置的 `index.html`；`/proof/` 和 `/proof/index.html` 轉（`301`）到 `/proof` | Static Assets 直接送 `site/proof/` 的檔，不跑 Worker |
| `/proof/…` | 那份建置的其他檔案 | 同上 |
| 其他網址 | 「找不到這一頁」（`design/copy/not-found.md`），`404` | Worker 產生，不問證明紀錄 |

**連結預覽圖每一頁都是同一張。** 有連結預覽（`og:title`）的每一頁，`<head>` 都多五行：`og:image` 是 `https://<網站的網域>/og-image.png`（測試的證明紀錄是 `test.iamreal.tw`，正式的是 `iamreal.tw`，`src/settings.ts` 的 `SITE_HOSTS`），加上 `og:image:type`、`og:image:width`、`og:image:height`（`image/png`、1200、630）和替代文字 `og:image:alt`（逐字照 `design/copy/proof-page.md` 第 8 段）。圖是 `design/screens/og-image.png` 的拷貝，上面沒有帳號名稱、日期、島民編號，不隨頁面改變。沒有連結預覽的頁面（查詢頁打了不合 Threads 格式的名稱）也沒有圖。過卡的頁面 `/proof` 是 `web/` 的建置，沒有連結預覽，也沒有圖。`test/pages.ts` 的 `getPage` 對每一頁檢查這五行。

**圖示每一頁都是同一個。** 每一頁的 `<head>` 都有 `<link rel="icon" href="/favicon.ico">`（`src/pages/layout.ts` 的 `FAVICON_PATH`；過卡的頁面 `/proof` 也是，`web/index.html`），指到 Static Assets 送的 `site/favicon.ico`：瀏覽器和 Threads 這類連結預覽不看那一行、直接要 `/favicon.ico` 的，拿到的也是同一個檔（Threads 怎麼取圖示還不知道，兩種都放）。圖案是頁首的記號（`LOGO`），顏色照 `design/tokens.json`，16、32、48 像素三張 PNG 包在一個 ICO 裡，由 `scripts/favicon.ts` 用這台電腦的 Chrome 畫（改了記號時手動跑；部署和建置都不跑）。和 `pages.css`、`copy.js` 一樣在版控裡，帶訪客頁面的標頭、`Cache-Control: no-cache` 和 `ETag`；`Content-Type` 是 Static Assets 照副檔名給的。正式的圖示在 [#154](https://github.com/iamreal-tw/iamreal/issues/154) 定，到時候換掉這個檔。

「找不到這一頁」和其他頁面一樣有導覽列、頁尾，測試的證明紀錄時有標示和 `noindex`，快取 60 秒；舊後台對這種網址回的是純文字。`/api/` 底下不認得的路徑不是這一頁，是介面自己的 `404`（JSON）。資料網域上紀錄檔的路徑 `/proof-log/…`（舊後台把紀錄檔放在這個網域，現在只在資料網域）和沒有 `@` 的 `/threads/<名稱>` 也是這一頁。

首頁、島民證明、導覽列、頁尾和其他每一頁上連到這個網站的連結都回 `200`，不轉址（`test/site-pages.test.ts` 逐一打開；`/proof` 用一份代替 `web/` 建置的檔）。

**`/copy.js` 是檔案，和樣式表一樣由 Static Assets 送**：`site/copy.js` 是從舊後台逐位元組搬過來的，之後加了常見問題展開網址指到的那一題的幾行（[#343](https://github.com/iamreal-tw/iamreal/issues/343)），帶訪客頁面的標頭、`Cache-Control: no-cache` 和 `ETag`，帶著 `If-None-Match` 再要一次時回 `304`。和舊後台不同的地方：`ETag` 的值是 Static Assets 給的（舊後台是 SHA-256 的前 8 個位元組）；其他方法的 `405` 沒有 `Allow`；設定讀不出來時照常送。`Content-Type` 本機是 `text/javascript; charset=utf-8`，和舊後台相同；Cloudflare 上是 `text/javascript`，不帶 `charset`（樣式表線上也是 `text/css`，不帶；見 [Static Assets](#static-assets)「Cloudflare 上看過的」）。這對 `copy.js` 沒有影響：檔裡 ASCII 以外的字只在開頭的註解（兩行，`LC_ALL=C grep -n '[^ -~]' site/copy.js`），程式本身全是 ASCII，照哪一種編碼讀都一樣。之後要在這個檔的程式裡寫 ASCII 以外的字時再看：沒有 `charset` 時瀏覽器用載入它的頁面的編碼來讀（HTML 標準的 [fetch a classic script](https://html.spec.whatwg.org/multipage/webappapis.html#fetch-a-classic-script) 把頁面的編碼當成後備），而這裡的頁面都是 `text/html; charset=utf-8`。

- **樣板和複製按鈕的程式是舊後台的，樣式表照新的設計。** `src/pages/` 的 HTML 照舊後台的樣板逐段搬過來，`site/copy.js` 是舊後台的那一支（後來多了常見問題的幾行）；舊後台刪掉之前，測試核對過 `copy.js` 和當時的 `site/pages.css` 和舊後台的逐位元組相同。之後導覽列、頁尾和整站的外觀換成 `design/DESIGN.md` 的（[#283](https://github.com/iamreal-tw/iamreal/issues/283)）：`site/pages.css` 的 `:root` 每一個值和 `design/tokens.json` 同名的相同，顏色只從那裡來，`760px` 以下換成手機的排法（`test/style-sheet.test.ts`）；各頁自己的排法等各頁的票：首頁、島民證明頁、查詢頁、過卡需要什麼（`/prepare`）、常見問題（`/faq`）、如何驗證證明紀錄（`/verify`）、如何檢查 Threads 帳號的島民證明（`/check`）、掛上去（`/hang`）已經照 `design/DESIGN.md` 排，其他頁現在仍是一欄。畫面上的每一句寫在樣板裡，逐字照 `design/copy/`；測試（[`test/pages.test.ts`](test/pages.test.ts)、[`test/copy.ts`](test/copy.ts)）直接讀 `design/copy/` 的每一段，確認那一種情況的每一句都在頁面上、順序相同。
- **放進 HTML 的值一律跳脫。** 樣板是 `src/pages/html.ts` 的 `html` 標籤：放進去的字串全部跳脫，只有這個標籤自己產生的片段不跳脫。訪客打的網址、證明紀錄裡的帳號都走這一條。
- **頁面預設沒有程式**：沒有 `<script>`、沒有行內樣式、沒有事件屬性，不設 cookie。例外只有四頁：常見問題、如何驗證證明紀錄和帶著島民證明的掛上去各載入一支自己網域的程式 `/copy.js`（`<script src="/copy.js" defer>`），掛上去的兩頁（`/hang`、`/hang/<短編號>`）載入示範的播放程式 `/demo.js`（下一點），沒有行內的程式；這四頁的 CSP 多一項 `script-src 'self'`（[頁面送的標頭](#頁面送的標頭)）。程式只讓「複製」的按鈕出現、按了複製；沒有程式時按鈕藏著，要複製的字照樣在頁面上選得起來。常見問題上，程式只做一件事：網址指到某一題（`/faq#<id>`）時，打開那一題的 `<details>`（頁面打開時，和 `#` 後面改變時）。每一題本身是 `<details>`，瀏覽器捲到它但不會打開它（瀏覽器只打開包著目標的 `<details>`）；沒有程式時題目照樣點得開，連到某一題時捲到那一題的題目，只是不自動展開。只收 `GET` 和 `HEAD`，其他方法回 `405`。產生頁面時只讀請求的方法和路徑，證明紀錄頁另外讀網址的查詢（`q`、`after`）。
- **頁面的請求不進連線紀錄**（[連線紀錄](#連線紀錄)只記送出一筆的請求），回答了就不寫任何東西。後台自己出錯時回 `500`（純文字），寫一行：`{event: "internal_error", page, where, error}`，`page` 是哪一種頁面（`home`、`card`、`account`、`proof_log`、`hang`、`faq`、`verify`、`check`、`prepare`、`none`），不含短編號、帳號和網址的任何部分。檔案的請求不跑 Worker，後台的程式對它們什麼都不寫。

### 讀證明紀錄經過一個介面

頁面要的資料只從 [`src/page-data.ts`](src/page-data.ts) 的 `PageData` 拿（ADR-0026）：首頁的兩個數字、一個短編號對到的卡片、把名額給了一個帳號的卡片、證明紀錄頁的兩個數字和一段紀錄（同一次讀）。現在的實作 `pageDataOfProofLog` 問證明紀錄的 Durable Object；用哪一個實作只寫在 `src/index.ts` 一處。之後讀取要搬出 Durable Object（ADR-0026 的 Consequences），換的是這一塊，頁面的程式不動。

- **格式不對的短編號不問 Durable Object**：照 `spec/scoped-id.md` 的寬鬆讀法（`protocol/` 的 `readShortIdInUrl`，讀 `spec/vectors/scoped-id.json`）讀不成 10 個字元的，直接回「找不到這張島民證明」那一頁，`404`。讀得成、但寫法不是標準的那一種（小寫、`O`、`I`、`L`），`301` 轉到標準寫法，也不問。掛上去的 `/hang/<短編號>` 讀法相同，讀不成的 `302` 到 `/hang`，也不問。
- **格式不對的帳號不問 Durable Object**：查詢頁的名稱先把 A–Z 轉成小寫，不合平台表裡 Threads 的格式就直接回「Threads 沒有這樣的帳號名稱」那一頁，`404`；有大寫的 `301` 轉到小寫。證明紀錄頁的查詢框是 Threads 的名稱時 `303` 轉到查詢頁，也不問。測試把 Durable Object 弄成什麼都不答來確認這幾種照樣回答。
- **查詢框去掉前後的空白，照舊後台的 `strings.TrimSpace`**：Go 的空白（`unicode.IsSpace`）和 JavaScript 的 `trim` 差兩個字元：U+0085 Go 算空白，U+FEFF 不算。這裡照 Go。
- **掛上去的示範**（`/hang`、`/hang/<短編號>`，`design/copy/hang.md`「示範」，[#371](https://github.com/iamreal-tw/iamreal/issues/371)、[#372](https://github.com/iamreal-tw/iamreal/issues/372)）：頁面裡多一個送出時隱藏的區塊（五個示意畫面，寫著這張卡片的帳號和網址，`/hang` 寫固定的例子）和一個資料區塊 `<script type="application/json">`，內容是 `design/motion/hang.json`；瀏覽器不執行它。播放程式 `/demo.js` 載入後才顯示示範、隱藏四張靜態圖和結果圖；沒有載入時頁面和原本相同。`/hang/<短編號>` 原本就准本站的程式（`script-src 'self'`）；`/hang` 原本完全不准程式，為了示範改成相同（[#369](https://github.com/iamreal-tw/iamreal/issues/369)，維護者 2026-11-26 同意），它只載入 `/demo.js`，不載入 `/copy.js`（那一頁沒有複製的按鈕）。
  - **示範有兩個版本**（回到「連結」那一頁後，iPhone 按右上角的「完成」，Android 按左上角的 ✕）：頁面同時帶著兩個版本要按的那一顆，由播放程式在瀏覽器裡看 `navigator.userAgent` 選（有 `Android` 的是 Android 的版本，其餘是 iPhone 的）。後台送給每一種裝置的頁面相同，不讀 `User-Agent`，回應不帶 `Vary`，頁面的快取不受影響。規格（[#369](https://github.com/iamreal-tw/iamreal/issues/369)）原本寫伺服器選；改成瀏覽器選的理由在那張票 2026-11-26 的最後一則留言
  - `site/demo.js` 由 `scripts/site-files.ts` 從兩個檔寫出，提交進版控：`src/teaching-animation.ts`（算狀態的函式，去掉型別）和 `demo/player.js`（畫的部分）。`test/demo.test.ts` 檢查版控裡的那一份就是這兩個檔寫出來的，而且它算的狀態和 `spec/vectors/teaching-animation.json` 的答案相同
  - 播放程式不向任何地方要資料、不寫 cookie、不改網址，也不在元素上寫樣式：會動的部分是它把時間表每一秒六十個時刻的狀態交給瀏覽器的 `Element.animate`。`test/site-pages.test.ts` 檢查程式裡沒有那些字
  - 後台的程式不引用 `worker/`、`protocol/` 以外的檔，所以時間表有一份拷貝 `src/pages/hang-timeline.ts`，同一支腳本寫出，同一個測試核對
  - 在瀏覽器裡的行為（播到最後一格、停止、再看一次、標出現在的一步、沒有程式時是靜態圖）由 `web/test/worker-card-proof.ts` 檢查
- **快取**：Worker 產生的每一頁都帶 `Cache-Control: public, max-age=60`，查不到的 `404` 和轉址（`301`、`302`、`303`）也一樣（ADR-0026：沒帶的話，Workers 前面的快取會把 `404` 放更久）；常見問題、如何驗證證明紀錄、`/hang` 不問證明紀錄，也用同一個值，不分兩種。所以一筆紀錄寫入後，頁面最慢 60 秒後跟上；Worker 自己不另外存一份，每個跑到 Worker 的請求都問當下的證明紀錄。舊後台把證明紀錄頁的兩個數字在記憶體裡留 60 秒、頁面帶 `no-cache`；這裡數字每次都問，快取靠回應的標頭。樣式表和 `/copy.js` 帶 `no-cache`，靠 `ETag` 重新確認（寫在 `site/_headers`）。`/api/` 的回應是 `no-store`，`405` 和 `500` 也是。
- **首頁的兩個數字**：現在把 Threads 的名額給了某個帳號的卡片有幾張；其中上次過卡日在今天往回 90 天以內（含第 90 天）的有幾張，今天照台灣的日期。一個查詢、一個索引（`src/views.ts` 的 `counts`）。
- **頁面只列 Threads**（`src/pages/proof.ts` 的 `PLATFORM`）：測試的證明紀錄另一個平台 `test-example` 的帳號不出現在頁面上。

### 頁面用的衍生表

證明紀錄的 Durable Object 裡 `view_` 開頭的五張表（[`src/views.ts`](src/views.ts)）。前四張的內容和舊後台的四張相同，`view_ordinals` 是順序號碼（[#299](https://github.com/iamreal-tw/iamreal/issues/299)）加的：

| 表 | 一列是什麼 |
|---|---|
| `view_state` | 只有一列：衍生表反映到第幾筆紀錄 |
| `view_cards` | 一張有過有效紀錄的卡片：短編號、第一次過卡日、上次過卡日、過卡幾次 |
| `view_slots` | 一張卡片在一個平台的名額：現在的帳號、從哪一天哪一筆開始、更換過幾次、上次過卡日 |
| `view_history` | 一筆有效紀錄在一個平台做了什麼：種類、是不是收回之後、之前和之後的帳號 |
| `view_ordinals` | 一張有過有效紀錄的卡片的順序號碼（`spec/record-rules.md`「The ordinal」）：卡片第一筆有效紀錄寫入時給下一個號碼，之後不變（`view_ordinals_card` 是一張卡片一列的唯一索引）。`test/views.test.ts` 拿標準答案的 `ordinals` 逐案比對。不分場合字串，整份證明紀錄一起數；每個網站照自己的證明紀錄數，測試網站的號碼和正式網站的無關。島民證明頁「第 N 張島民證明」和送出一筆的 `201` 回應的 `ordinal`（分享的預填文字用，[#300](https://github.com/iamreal-tw/iamreal/issues/300)）讀它 |

- **和紀錄在同一個交易寫**（[寫入是一個交易](#寫入是一個交易)）。寫進去的是紀錄規則算出來的種類和前後的狀態，這裡不判斷任何一筆是哪一種。
- **可以整份重建。** 物件啟動時，衍生表反映到的筆數和證明紀錄的筆數不同就清掉重寫（`src/proof-log.ts` 的 `#fillViews`；上一次重建失敗、等的時間還沒到時例外，見下面「重建失敗會自己再試」）：照序號讀每一行，用 `protocol/` 的 `applyList`（紀錄規則的檢查 5、6 和之後的狀態）從空的狀態一筆一筆重算。紀錄都是寫入時過了檢查 1 到 4 的，所以只重算後半。重建會發生在三種時候：物件是這幾張表出現之前建的（表的版本沒有變，`CREATE TABLE IF NOT EXISTS` 補上空表），衍生表被清掉，或衍生表是 `view_ordinals` 出現之前填好的：`view_cards` 有卡片、`view_ordinals` 是空的（`ordinalsOwed`），反映到的筆數雖然對，物件啟動時也整份重建；`paused` 時不重建，其他頁面照常，只有島民證明回 `500`（它要寫號碼）。順序號碼只在衍生表裡，不在卡片狀態表、不進卡片狀態檔：它不影響任何一筆紀錄有效或無效，重算得出來；`test/sequence.test.ts`、`test/proof-log-files.test.ts` 確認和 Go 算的相同。測試確認重建的結果逐列和一筆一筆寫的相同，頁面也相同。重建讀紀錄的地方有兩個，做法因此分兩種：
  - **紀錄都還在物件裡**（還沒有任何一檔搬到 R2）：一個交易做完，在物件啟動的當下，第一個請求之前。哪一筆讀不懂或規則不接受，整個重建就不算數，衍生表維持原樣。「失敗就維持原樣」只在這一種成立。
  - **有紀錄檔已經搬到 R2**：先清空，再一檔一檔從 R2 讀（每一檔核對 SHA-256 是 `full_files` 記的那一個、剛好 1,000 行），一檔一個交易寫進衍生表，最後寫物件裡還留著的紀錄。讀 R2 是非同步的，所以這一種不在啟動的當下做完：物件先啟動、照常回答，重建在背景進行，做完之前衍生表算沒跟上（見下面）。中途失敗時衍生表停在做到的那一檔（不是維持原樣：開頭就清空了），仍然算沒跟上，之後從頭再來。沒有用 `blockConcurrencyWhile` 把請求擋到重建做完：它有 30 秒的上限，超過物件會被重設（[Durable Object State](https://developers.cloudflare.com/durable-objects/api/state/)：「there is a 30 second timeout applied when executing the callback. If this timeout is exceeded, the Durable Object will be reset」，2026-11-20 讀的），而重建的時間隨證明紀錄的檔數變長。重建進行中不搬檔。
- **`paused` 時不重建**：存著的規則版本和程式的不同時，那些紀錄不是這一版規則收下的，不拿這一版去重算種類。衍生表本來就跟到最後一筆的話，頁面照常。
- **重建失敗會自己再試。** 失敗後一分鐘再做一次（`timedWork()` 的一件），連續失敗時等得更久，最長 5 分鐘（[過期的題目怎麼刪](#過期的題目怎麼刪)的「失敗後多久再試」）。物件啟動時也做一次，但上一次失敗後等的時間還沒到時不做，等 alarm：Cloudflare 上物件沒事做幾秒就休眠、被叫醒時重新啟動，每次啟動都重建的話，等的時間就沒有意義。成功的那一刻頁面和送出就恢復，不必重啟物件。讀 R2 的失敗有會自己好的（逾時、暫時的錯誤），所以要再試。資料或程式造成的失敗（R2 裡的檔不見或被改過、這一版讀不懂的一行、規則不接受的一筆）再試也不會好：**每次嘗試寫一行 `views_not_filled`**，約十分鐘之後是每 5 分鐘一行，直到原因排除。每一次重試做的事照上面兩種：紀錄都還在物件裡時，失敗的那個交易整個退回，衍生表維持原樣；有檔在 R2 時，先清空，重讀前面的每一檔、重寫它們的每一筆，停在失敗的那一檔。
- **衍生表沒跟上時**（物件啟動時決定；重建做完的那一刻改成跟上）：衍生表反映到的筆數和證明紀錄的筆數不同，而且重建失敗、從 R2 的重建還沒做完，或正在 `paused` 不能重建。這時候物件照樣啟動，但不用衍生表：
  - 首頁和島民證明回 `500`（純文字，`no-store`）。不拿沒跟上的衍生表出頁面：那會是「現在有 0 張」，或把一張存在的島民證明說成找不到，還被快取 60 秒。格式不對的短編號和「找不到這一頁」不問證明紀錄，照常。
  - 送出一筆（`POST /api/v1/records`）回 `500` `internal`，和後台自己出錯時相同（`docs/api/card-proof.md`），什麼都不寫，題目不算用過、也不算送過一次。`paused` 時照舊是 `503` `paused`。
  - 拿題目、讀卡片現況、清冊鏡像照常：它們不讀衍生表。
  - 重建失敗時寫一行 `{event: "views_not_filled", error}`。之後照上一條再試，物件啟動時等的時間已經到了也試；原因排除後（例如把 R2 的那一檔放回去、部署了讀得懂那一筆的程式），下一次嘗試就補上。
  - **營運上的後果**：一筆這一版程式讀不懂、或規則不接受的紀錄，或 R2 裡少了一個紀錄檔、內容和寫入時不同，會讓頁面和送出都停在 `500`，直到換上處理得了它的程式、或把那一檔放回去（ADR-0033 的副本）；衍生表本來就跟上的物件不讀 R2 的紀錄檔，不受影響；但已經過卡的人查得到現況，證明紀錄本身（紀錄、卡片狀態、指紋）沒有被動到。後台自己不會寫出這樣的列；會碰到的情況是紀錄規則改了、舊的紀錄照新規則不接受，那照 ADR-0030、ADR-0031 本來就要先處理。
- **重建多久沒有量過。** 一檔要讀 20 MB、讀 1,000 行、套 1,000 次規則。證明紀錄長到幾十檔時，重建的那段時間頁面和送出都是 `500`。頁面的讀取之後要搬出 Durable Object（ADR-0026），到時候這個重建也要跟著重想。
- 日期存成天數（`protocol/` 的 `Day`），頁面的每個查詢各走一個索引：島民證明 `view_cards_short_id`，每張卡片的順序號碼另一個查詢走 `view_ordinals_card`；查詢頁 `view_slots_account`（`cardsOfAccount`，照「從哪一天起」、同一天照那一筆的序號；送出一筆時數卡片也用這個索引，`accountCards`，[寫入是一個交易](#寫入是一個交易)）；證明紀錄頁的清單 `view_history_log`（`logRows`，照序號倒著讀 `view_history` 裡 Threads 的列，一筆有效的紀錄一列，再次過卡、收回都在裡面）；兩個數字 `view_slots_recency`。`test/views.test.ts` 確認每個查詢都只讀一個索引的一段、不另外排序。
- **證明紀錄頁的「更多」是序號**：`?after=53` 列序號小於 53 的紀錄。序號是紀錄在證明紀錄裡的位置，寫入之後不變，所以上一頁打開之後才寫進來的紀錄排在最上面，不會讓下一頁重複或漏掉。寫法是不是 0、沒有正負號和開頭的 0 的十進位，最大 2⁵³ − 1；讀不成的從最新的開始列。舊的清單照「從哪一天起」排、寫成 `2026-10-01.3`（[#287](https://github.com/iamreal-tw/iamreal/issues/287) 之前），這種網址現在讀不成，從最新的開始列。
- 舊的清單用的索引 `view_slots_latest` 由建表的程式拿掉（`DROP INDEX IF EXISTS`），新的索引補上；表沒有改，`SCHEMA_VERSION` 不變（[兩個版本號](#兩個版本號)）。

### 測試的證明紀錄的標示

`PROOF_LOG_KIND` 是 `test` 時，每一頁最上面有一行 `測試的證明紀錄　不定期清空，上次清空：<日期>`（`design/copy/test-site.md`，[#59](https://github.com/iamreal-tw/iamreal/issues/59) 定的字），`404` 的頁面也有；日期是設定值 `TEST_PROOF_LOG_CLEARED_ON`，寫在 `<time>` 裡，樣式表讓它不折行：手機寬度下整行放不下時，斷在日期之前，不斷在日期中間的連字號。每一頁的 `<head>` 有 `<meta name="robots" content="noindex">`，而且 `/api/` 以外的每個回應都帶 `X-Robots-Tag: noindex`（ADR-0028）：Worker 產生的每一頁（包括「找不到這一頁」、`405`、`500`）由 Worker 加，樣式表、`/copy.js` 和 `/proof` 底下的每個回應由 `site/_headers` 加。正式的證明紀錄都沒有。

- **檔案的 `X-Robots-Tag` 不是 Worker 加的**，是 `site/_headers` 寫的，上傳時就定了，不跟著 `PROOF_LOG_KIND` 變。所以 `_headers` 照證明紀錄的種類各有一份（[`scripts/site-files.ts`](scripts/site-files.ts) 的 `siteHeaders`），版控裡的是測試的證明紀錄的；部署前的檢查核對每個環境的 `_headers` 是它那一種證明紀錄的那一份（[Static Assets](#static-assets)）。
- `TEST_PROOF_LOG_CLEARED_ON` 不是日期時，測試環境的介面和 Worker 產生的頁面都回 `500`（設定在同一處讀，`src/settings.ts`）：寧可不出頁面，也不出一行沒有日期的標示。樣式表、`/copy.js` 和 `/proof` 的檔案不跑 Worker，照常送。`wrangler.jsonc` 裡的這個值在部署前就核對過是日曆上有的日期（`checkClearedOn`，`2026-11-31` 過不了），所以這種情況只會出在沒經過檢查的設定。
- **島民證明上寫的網址用測試網站的網域。** 個人檔案上要有的連結那一行、和短編號對不到時的那一句，測試的證明紀錄寫 `test.iamreal.tw/p/<短編號>`，正式的證明紀錄寫 `iamreal.tw/p/<短編號>`（`design/copy/test-site.md`「寫出島民證明網址的地方」）。掛上去的 `/hang/<短編號>` 寫的連結、「複製連結」複製的和示意圖裡的網址也是同一個網域（`/hang` 的示意圖寫例子的短編號，網域一樣）：`design/copy/hang.md` 第 2 部分說那一行「和島民證明頁面上的寫法相同」。舊後台沒有測試網站，那裡一律寫 `iamreal.tw`。網域跟著 `PROOF_LOG_KIND` 走，寫在 `src/settings.ts` 的 `SITE_HOSTS`（ADR-0028 定的兩個網域），不是另一個設定值，也不從請求的 `Host` 取：`Host` 是訪客的瀏覽器送的。導覽列、頁尾、分頁標題、連結預覽裡的 `iamreal.tw` 不變。
- **過卡的頁面上的這一行不是 Worker 加的。** `/proof` 是 `web/` 建置出來的檔案，原樣送出，只有標頭是另外加的；標示由 `web/` 測試網站的建置自己寫在頁面最上面（`web/README.md`「三種用真元件的建置」），句子同樣來自 `design/copy/test-site.md`，日期是建置時從 `wrangler.jsonc` 的 `TEST_PROOF_LOG_CLEARED_ON` 帶進去的。所以改這個日期要重新部署才會兩邊一致；部署前的檢查核對頁面裡的日期就是設定裡的那一個（`scripts/proof-page.ts`）。`web/test/e2e/ui.ts` 在本機的 workerd 上比過：過卡頁面上的那一行和 Worker 產生的首頁上的相同。
- **清空測試的證明紀錄時**一起改 `PROOF_LOG_OBJECT_NAME` 和 `TEST_PROOF_LOG_CLEARED_ON`，部署之後營運者刪掉測試的儲存桶裡的 `proof-log/`。順序和每一步之後怎麼確認在[清空測試的證明紀錄](#清空測試的證明紀錄)。過卡的頁面上的日期是建置時從 `wrangler.jsonc` 讀的，所以同一次部署就跟著變。

### 頁面送的標頭

定義在 [`src/headers.ts`](src/headers.ts) 一處，和舊後台送的那一組相同。測試對每一種回應核對整組標頭：多一個、少一個、值不同都不過。

送出去的地方有兩個，值都從那一處來：

- Worker 產生的頁面，由 `src/visitor.ts` 加上。
- 樣式表、`/copy.js`、`/demo.js`、圖示（`/favicon.ico`）、字型（`/fonts/…`）、連結預覽圖和 `/proof` 的檔案不跑 Worker，標頭寫在 [`site/_headers`](site/_headers)，由 Static Assets 加上。這個檔是 [`scripts/site-files.ts`](scripts/site-files.ts) 從 `src/headers.ts` 的值寫出來的，不手改；`src/headers.ts` 改了之後在這個目錄跑 `node --experimental-strip-types scripts/site-files.ts` 重寫。測試和部署前的檢查都核對版控裡的 `_headers` 和重寫出來的逐字相同。

每個回應：

| 標頭 | 值 | 理由 |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | 瀏覽器照 `Content-Type` 處理內容，不自己猜 |

訪客的頁面、樣式表、`/copy.js`、`/demo.js` 和字型（程式自己的 CSP 不決定什麼能執行，決定的是載入它的頁面的 CSP）：

| 標頭 | 值 | 理由 |
|---|---|---|
| `Content-Security-Policy` | `default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; frame-src https://www.threads.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` | 頁面上任何程式都不執行（沒有 `script-src`）；樣式表、字型和圖片只收自己網域的（字型是 `site/fonts/` 那一份，不經過第三方，`design/fonts/README.md`）；只能嵌 Threads 的框（島民證明上的個人檔案）；表單只能送回自己的網域（證明紀錄頁的查詢欄）；頁面不能被別的網站嵌進框裡 |
| `Referrer-Policy` | `no-referrer` | 從頁面點出去的連結、嵌進來的 Threads 個人檔案，都拿不到這一頁的網址（網址裡有短編號） |
| `Cross-Origin-Opener-Policy` | `same-origin` | 開啟這一頁的別的網站，和這一頁開出去的視窗，彼此拿不到對方 |
| （沒有 `Cross-Origin-Embedder-Policy`、`Document-Isolation-Policy`） | | 送了的話 Threads 的框會被擋 |

載入本站程式的四頁（常見問題、如何驗證證明紀錄、掛上去的兩頁）的 `200`：上面那一組，`Content-Security-Policy` 換成多一項 `script-src 'self'` 的 `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; frame-src https://www.threads.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`，和舊後台的 `scriptPageHeaders` 相同：只跑自己網域的程式，沒有行內的程式、沒有別的網站的。同一個網址的轉址、`405`、`500` 不載入程式，用上面那一組；舊後台是照路徑給，如何驗證證明紀錄和掛上去這兩個網址的每一種回應都帶 `script-src 'self'`（舊後台的常見問題沒有程式）。

過卡的頁面和它的每個檔案（`/proof`、`/proof/…`）：`Content-Security-Policy`、`Document-Isolation-Policy: isolate-and-credentialless`、`Cross-Origin-Opener-Policy: same-origin-allow-popups` 三個，值和每一項的理由寫在 [`web/README.md`](../web/README.md)「頁面需要的標頭」。[`test/proof-files.test.ts`](test/proof-files.test.ts) 從那份 README 讀出這三個值，確認它們和 `src/headers.ts` 的相同，本機的 workerd 對 `/proof` 的每一種回應（檔案、`301`、`404`、`405`、`304`）送的也一字不差。`connect-src` 裡的資料網域照證明紀錄的種類（`src/headers.ts` 的 `DATA_ORIGINS`、`proofPageHeaders`）：測試的證明紀錄的網站是 `https://test-data.iamreal.tw`，正式的證明紀錄的是 `https://data.iamreal.tw`（舊後台只有後面這一份）。兩份 `web/README.md` 都引用了，測試各比一次。

測試的證明紀錄另外加 `X-Robots-Tag: noindex`（上一節）。

### Static Assets

`wrangler.jsonc` 最上層的 `assets` 指到 [`site/`](site)。這些檔案由 Cloudflare 直接送，**檔案的請求不跑 Worker**（ADR-0023「靜態檔」：這些下載不經過後台的程式）。要保住的是：持卡人拿到的過卡頁面就是建置出來的那些檔，後台沒有一段程式能對不同的人送不同的內容。這件事靠兩樣：這幾個路徑先找檔案、找到就直接送；Worker 沒有 binding，讀不到檔。下面寫的行為是在本機的 workerd 上看到的；其中沒有建置時的那些，Cloudflare 上也看過了，結果相同。看過的和還沒確認的列在這一節後面。

| `site/` 裡的 | 是什麼 |
|---|---|
| `pages.css` | 訪客頁面的樣式表，在版控裡 |
| `copy.js` | 複製按鈕的程式，在版控裡 |
| `demo.js` | 掛上去的示範的播放程式，在版控裡，由 `scripts/site-files.ts` 從 `src/teaching-animation.ts` 和 `demo/player.js` 寫出 |
| `fonts/GenRyuMin2TW-B.woff2` | 標題的字型：`design/fonts/` 那份子集的拷貝，在版控裡，由 `scripts/site-files.ts` 拷過來；`test/font.test.ts` 檢查兩份逐位元組相同 |
| `og-image.png` | 連結預覽圖：`design/screens/og-image.png` 的拷貝，在版控裡，由 `scripts/site-files.ts` 拷過來；`test/pages.test.ts` 和部署前的檢查核對兩份逐位元組相同 |
| `favicon.ico` | 網站的圖示：頁首的記號，16、32、48 像素，在版控裡，由 `scripts/favicon.ts` 畫出來；`test/favicon.test.ts` 檢查三張都是那個大小的 PNG，部署前的檢查核對它是 HEAD 的那一份 |
| `proof/` | 過卡的頁面：`web/` 測試網站的建置（`web/README.md`「三種用真元件的建置」），部署時才建置出來，不進版控 |
| `_headers` | 這些檔案的標頭，在版控裡，由 `scripts/site-files.ts` 寫出來（[頁面送的標頭](#頁面送的標頭)） |
| `_redirects` | `/proof` 的三條規則，在版控裡，內容是 `scripts/site-files.ts` 的 `SITE_REDIRECTS` |

`_headers` 和 `_redirects` 是給 Static Assets 讀的規則，本身不會被送出去。

**部署時 `site/proof/` 裡是 `web/` 測試網站的建置**（[#69](https://github.com/iamreal-tw/iamreal/issues/69)）。[`scripts/deploy.ts`](scripts/deploy.ts) 的 `buildSite` 在打包 Worker 之前做三件事，本機的 `pnpm run deploy:test` 和 GitHub Actions 的 `build` 工作都經過它：

1. **通用參數**（[`scripts/proof-page.ts`](scripts/proof-page.ts) 的 `fetchCrs`）：跑 `web/scripts/fetch-crs.mjs`，核對 `web/crs/` 兩個檔的 SHA-256，沒有或不符就從 Aztec 的 CDN 下載再核對（`web/README.md`）。本機和 GitHub Actions 都走這一步；已經有而且相符時不送任何請求。
2. **建置**（`buildProofPage`）：在 `web/` 跑它自己的建置 `vite build --mode testsite`，輸出到 `site/proof/`（先清空，電腦上原本留在那裡的東西不會被帶上去）。標示旁的日期是 `wrangler.jsonc` 的 `TEST_PROOF_LOG_CLEARED_ON`，用環境變數交給建置。`web/` 的建置自己會擋一件事：`web/src/target-test-site.ts` 讓卡片簽的不是測試的證明紀錄的場合字串，就不建置。`worker/` 沒有引用 `web/` 的程式，只是執行它的建置指令。
3. **檢查**（`checkProofPage`）：
   - 檔案恰好是頁面的那些：`index.html`、`bb/` 的兩個 WASM、`circuits/` 的兩個電路檔、`crs/` 的兩個通用參數檔（都不是空的），和 `assets/` 底下的 `.js`、`.css`、`.wasm`、`.woff2`（標題的字型，`design/fonts/` 的子集）；多一個別的檔（例如 `_headers`、別的目錄、拿掉了的說明頁 `help.html`）不過，少一個也不過
   - 程式裡有內政部元件的網址 `http://localhost:61161` 和 `spec/vectors/issuers.json` 的兩把發證金鑰
   - 沒有假卡片、測試的發證金鑰、假元件的痕跡（和 `web/test/build.test.ts` 同一份清單）
   - 寫到這台電腦或這個專案的網址只有元件的和 `https://test-data.iamreal.tw`：正式的建置（寫的是 `data.iamreal.tw`）、本機真卡片的建置（沒有資料網域）、測試的建置（假元件在別的埠）都不過
   - 有測試的證明紀錄的標示。標示在建置裡是一段 JSON（`web/src/ui/test-proof-log.ts`），恰好一段，裡面的日期就是 `TEST_PROOF_LOG_CLEARED_ON`，場合字串是測試的證明紀錄的 `iamreal-test:public:0__________`：那是建置時從它用的 target 算出來寫進去的。把 `target-test-site.ts` 的證明紀錄改成正式的再建置，建置就停；連建置的那一道也拿掉，這裡擋下（兩種都實際改過、跑過）
   - 完成畫面寫連結用的網域是 `test.iamreal.tw`，沒有 `iamreal.tw`（頁首網站的名字 `common.site_name` 在每個網站都是 `iamreal.tw`，只容許那一個鍵）
   - 沒有建置（`site/proof/` 是空的或不存在）不過：部署出去的 `/proof` 會是 `404`

   這些檢查找的是「放錯了哪一種建置」的幾種已知情況，不是頁面的程式做了什麼；兩種證明紀錄的場合字串都在 `protocol/` 的表裡、每一種建置都有，光找字串分不出簽的是哪一個，所以看的是標示裡那段 JSON 寫的場合字串；它是建置時寫的，不是從打包好的過卡流程讀出來的（`web/test/e2e/ui.ts` 在瀏覽器裡另外看頁面自己說的場合字串）。檔案沒有逐檔的清單和雜湊：`assets/` 多一支或少一支程式、某一支被改過，這裡看不出來。兩個入口每次都清空重建，所以那要建置本身出錯才會發生，結果是測試網站壞掉。電路檔和通用參數的內容這裡不比：頁面自己在用之前核對它們的 SHA-256（`web/README.md`「從伺服器拿到的值」）。正式的證明紀錄的環境這裡一律不過：它要另一種建置和自己的檢查，等有正式環境時再加。

`site/` 裡 `proof/` 以外的檔案照舊由 `checkSiteFiles` 核對：恰好是 `scripts/site-files.ts` 的 `SITE_FILES` 列的那八個；`pages.css`、`copy.js`、`demo.js` 和 `favicon.ico` 要和目前 checkout 的 commit（`HEAD`）裡的那一份逐位元組相同（`git show HEAD:./pages.css`，`deploy-build-checks.ts` 的 `sha256InHead`）。所以部署上傳的是提交過的那一份（GitHub Actions 上就是 `main` 審查過的那一份）：本機 `pnpm run deploy:test` 時這兩個檔有還沒提交的改動、或建置過程改到它們，都過不了；`HEAD` 裡讀不到那一份（不在 git 的 checkout 裡、檔案沒進版控）也不過，不會跳過。改這兩個檔時不用改別的檔；`test/environments.test.ts` 也拿真的設定跑這項檢查，所以改了之前先提交，再跑測試、再部署。

- 本機的 `pnpm run deploy:test` 結束時（不論有沒有上傳）刪掉 `site/proof/`。單獨跑 `scripts/build-deploy.ts`（GitHub Actions 的做法）會把它留著，因為下一個工作要從那裡拿；留著不影響測試（`checkSiteFiles` 和測試的工具都不看 `proof/`），下一次部署的建置會先清空它。
- GitHub Actions 上，`build` 工作在自己的 checkout 裡建置、檢查，把 `worker/site/proof/` 交成第二個 artifact（`proof-page`）；`deploy` 工作把它下載到自己 checkout 的同一個位置，wrangler 上傳時和版控裡的八個檔一起讀到（[從 GitHub Actions 部署](#從-github-actions-部署)）。
- 帶著這份建置的第一次部署是 2026-11-21（`main` 的 `1400e11`，GitHub Actions）。線上看到的在下面「Cloudflare 上看過的」。

設定的每一項：

- **`run_worker_first` 是 `["/*", "!/copy.js", "!/demo.js", "!/favicon.ico", "!/fonts/*", "!/og-image.png", "!/pages.css", "!/proof", "!/proof/*"]`**：這幾個路徑以外的請求先跑 Worker。`!` 開頭的是排除，排除優先；排除的路徑先找檔案，檔案在就直接送。本機的 workerd 上，排除的路徑不論檔案在不在都不跑 Worker：不在就由 Static Assets 自己回 `404`（空的內容）。Cloudflare 上檔案不在時也是這樣；檔案在的時候還沒看過（線上還沒有 `/proof` 的檔）。測試專用的建置記下每一個跑到 Worker 的請求（`GET /__test/seen`），`test/proof-files.test.ts` 用它確認 `/proof` 的檔案、轉址、`404`、`405` 沒有一個跑到 Worker；`test/pages.test.ts`、`test/site-pages.test.ts` 對樣式表、`/copy.js` 和字型也確認一次，`test/pages.test.ts` 對連結預覽圖也是。
- **沒有 `binding`**：Worker 沒有 `ASSETS`，讀不到這些檔，也就沒辦法自己送。部署前的檢查核對 wrangler 列出的 binding 裡沒有它。
- **`html_handling` 和 `not_found_handling` 都是 `none`**：一個路徑要嘛就是那個檔案，要嘛 `404`；不替目錄找 `index.html`、不把 `.html` 拿掉、沒有替代的頁面。
- **`_redirects`**：`/proof` 送 `proof/index.html` 的內容（`200`，網址不變）；`/proof/` 和 `/proof/index.html` 轉（`301`）到 `/proof`，和舊後台相同。過卡的說明頁拿掉了（#292），它的網址 `/proof/help.html` 轉（`301`）到 `/prepare`：Android、iOS 的 app 改版之前還連到那裡（「了解更多」「怎麼驗證島民證明」）。查詢字串照樣帶過去（`/proof/help.html?topic=more` 到 `/prepare?topic=more`），`/prepare` 不看它。
- **`_headers`**：`/proof`、`/proof/*`、`/pages.css`、`/copy.js`、`/demo.js`、`/favicon.ico`、`/fonts/*`、`/og-image.png` 八條規則。本機的 workerd 上規則照路徑套用，不看檔案在不在，所以 `/proof` 底下的 `301`、`404`、`405` 也帶同一組標頭；Cloudflare 的文件只說規則套在靜態檔的回應上；線上 `301` 和 `404` 都帶；`405` 線上有了（`POST /copy.js`），它帶不帶這一組標頭還沒看。樣式表、程式、圖示、字型和連結預覽圖的規則先拿掉 Static Assets 預設的 `Cache-Control` 再設 `no-cache`（同一個標頭設兩次會被接成一個值）：每次用都憑 ETag 再問一次，改了字重新產生子集之後，頁面不會拿到舊的字型。

沒有用 `html_handling: "drop-trailing-slash"`（它也能讓 `/proof` 送 `index.html`）：它會把每個 `.html` 的網址轉走（例如當時的說明頁 `/proof/help.html` 變成 `307` 到 `/proof/help`），連到它們的每個連結都多轉一次。

和 Worker 自己送的時候不同的地方（本機的 workerd 上量的，[`test/proof-files.test.ts`](test/proof-files.test.ts)）：

| 請求 | 現在 | 之前 |
|---|---|---|
| `/proof/index.html` | `301` 到 `/proof` | `200`，同一個檔兩個網址 |
| `/proof//index.html`、`/proof/%69ndex.html`、`/proof/assets%2findex.js` | `307` 到那個檔自己的路徑 | `200` |
| `/proof` 底下不存在的檔 | `404`，內容是空的 | `404`，`not found` |
| `/proof` 和它的檔用 `POST` 等其他方法 | `405`，沒有 `Allow` | `405`，`Allow: GET, HEAD` |
| `/proof/` 用 `POST` 等其他方法 | `301` 到 `/proof`（轉址不分方法） | `405` |
| 設定讀不出來時（`PROOF_LOG_KIND` 不對等） | 檔案照常送 | `500` |
| `/proof/` 的 `301` | 沒有 `Cache-Control` | 沒有 `Cache-Control` |

`/proof/../pages.css` 這種路徑在送到 Static Assets 之前就被正規化成 `/pages.css`，拿到的是樣式表和樣式表的標頭；`/proof/..%2fpages.css` 是 `404`。兩種寫法都拿不到 `site/` 以外的檔。

檔案預設帶 `Cache-Control: public, max-age=0, must-revalidate` 和 `ETag`：瀏覽器每次用之前重新確認，沒變就回 `304`。`/proof` 的檔案用這個預設值，通用參數那個 8 MB 的檔也是。

**這個做法依據的 Cloudflare 文件**（2026-11-20 讀的）：

- [Headers](https://developers.cloudflare.com/workers/static-assets/headers/)：`_headers` 的格式；不套用在 Worker 產生的回應上；最多 100 條規則、每行 2,000 個字元；`! 名稱` 拿掉先前的標頭；同一個標頭設兩次會用逗號接起來；預設的 `Cache-Control` 和 `ETag`。文件的例子裡有 `Content-Security-Policy` 和 `X-Robots-Tag`，沒有提到 `Document-Isolation-Policy` 和 `Cross-Origin-Opener-Policy`。
- [Redirects](https://developers.cloudflare.com/workers/static-assets/redirects/)：`_redirects` 的格式；`200` 是送另一個路徑的內容而網址不變（文件叫 proxying），只能指到自己網站的路徑；轉址在標頭之前處理。
- [Configuration and Bindings](https://developers.cloudflare.com/workers/static-assets/binding/)：`run_worker_first` 可以是路徑樣式的清單，`!` 開頭的是排除、排除優先，最多 100 條；`binding` 可以不設。
- [HTML handling](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/)：`none` 時只有檔案自己的路徑送得出檔案；其他三種會用 `307` 轉走 `.html` 和 `index.html`。
- [Billing and Limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)：對靜態檔的請求免費、不限次數；排除的樣式把請求導向檔案，不執行 Worker。

**Cloudflare 上看過的**（2026-11-20，[#142](https://github.com/iamreal-tw/iamreal/pull/142) 合併後的第一次部署，`test.iamreal.tw`；線上的檔案只有 `pages.css`，`site/proof/` 是空的）：

| 請求 | 線上回的 | 和本機 |
|---|---|---|
| 部署 | 成功：只能部署 `iamreal-test` 的那把權杖可以上傳 Static Assets 的檔案 | |
| `GET /pages.css` | `200`；`Content-Security-Policy`、`Cross-Origin-Opener-Policy: same-origin`、`Referrer-Policy`、`X-Content-Type-Options`、`X-Robots-Tag: noindex` 都有；`Cache-Control` 只有 `no-cache` | 標頭相同。`Content-Type` 線上是 `text/css`，本機是 `text/css; charset=utf-8` |
| `GET /proof`、`GET /proof/nothing.js` | 空的 `404`，帶 `/proof` 的那一組標頭（`Document-Isolation-Policy` 在裡面）。是 Static Assets 回的：Worker 的「找不到這一頁」有內容、帶訪客頁面的標頭和 `Cache-Control` | 相同 |
| `GET /proof/`、`GET /proof/index.html`（不跟著轉） | `301` 到 `/proof`，帶 `/proof` 的那一組標頭 | 相同 |
| `POST /proof`、`POST /proof/nothing.js` | 空的 `404`，帶 `/proof` 的那一組標頭 | 相同（檔案不在時，其他方法也是 `404`） |
| `POST /proof/`（不跟著轉） | `301` 到 `/proof` | 相同 |

2026-11-21，[#231](https://github.com/iamreal-tw/iamreal/pull/231) 合併（`f0ca916`）部署之後，用 `curl` 看的（線上的檔案是 `pages.css`、`copy.js`，`site/proof/` 還是空的）：

| 請求 | 線上回的 | 和本機 |
|---|---|---|
| `GET /copy.js` | `200`；`Cache-Control: no-cache`，有 `ETag`，帶 `X-Robots-Tag: noindex` 和 `_headers` 那一組 CSP；內容的 SHA-256 和 `site/copy.js` 相同 | 標頭相同。`Content-Type` 線上是 `text/javascript`，本機是 `text/javascript; charset=utf-8` |
| `POST /copy.js` | `405` | 相同：檔案存在時，其他方法是 `405` |
| `GET /pages.css` | `Content-Type` 是 `text/css`，沒有 `charset` | 和 2026-11-20 看到的相同 |
| `GET /proof-log`、`/faq`、`/verify`、`/hang`、`/threads/@alice` | `200`，`Cache-Control: public, max-age=60` | 相同 |
| `GET /hang/7K2Q9FM4XD`（證明紀錄裡沒有這個短編號） | `302` | 相同 |
| `GET /privacy` | `404`（這一頁還沒有） | 相同 |

所以：

- **檔案存在時，其他方法是 `405`**，線上和本機相同（之前線上沒有存在的檔可以試）。`/proof` 底下的檔要等帶著頁面的部署才看得到。
- **Static Assets 在線上送的 `Content-Type` 不帶 `charset`**，樣式表和程式都是；本機的 workerd 會帶。`copy.js` 的程式全是 ASCII，不受影響（[頁面和檔案](#頁面和檔案)講 `copy.js` 的那一段）。`pages.css` 有一個 ASCII 以外的字在值裡（清單記號的 `·`，`list-style-type` 那一行）：沒有 `charset`、檔裡也沒有 `@charset` 時，樣式表照引用它的頁面的編碼讀（CSS Syntax 的 [input byte stream](https://www.w3.org/TR/css-syntax-3/#input-byte-stream) 的後備順序），這裡的頁面都是 UTF-8，所以讀得對；這一點是照規格推的，線上那個記號畫出來的樣子沒有另外看。
- `Document-Isolation-Policy` 和 `Cross-Origin-Opener-Policy` 寫在 `_headers` 裡，線上照樣送出。
- **排除的路徑上檔案不存在時，線上是 Static Assets 回 `404`，不轉給 Worker。** Cloudflare 的文件有三句，讀起來不完全一致；線上的行為是第一句和第三句照字面、而「asset-first」裡沒有第二句說的那一步：
  - 排除的路徑「will follow the default asset-first routing behavior」（[Configuration and Bindings](https://developers.cloudflare.com/workers/static-assets/binding/)）。
  - 預設的行為是「If no asset matches, Cloudflare invokes that version's `fetch()` handler. … A missing asset does not automatically produce a `404` response.」（[Worker script](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)）。
  - 排除的樣式「will continue to serve assets correctly, as requests are directed to assets, without invoking your Worker script」（[Billing and Limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)，講的是超過免費額度時）。

  這是看到的行為，文件沒有保證；部署前後的檢查沒有一項會發現它變了。它變了的話，檔案不存在的 `/proof` 網址會由 Worker 回「找不到這一頁」；Worker 仍然送不出檔案（沒有 binding），也改不了一個存在的檔。
- `_headers` 的規則套在不是檔案的回應上：`301` 和不存在的檔的 `404` 都帶。

2026-11-21，[#235](https://github.com/iamreal-tw/iamreal/pull/235) 合併（`1400e11`）由 GitHub Actions 部署之後，用 `curl` 看的。這是第一次帶著 `web/` 的建置（`site/proof/` 有檔）。只送了 `GET`、`HEAD`，和為了看 `405` 對 `/proof` 底下的檔送的 `POST`、`DELETE`：

| 請求 | 線上回的 | 和本機 |
|---|---|---|
| 部署 | 成功：只能部署 `iamreal-test` 的那把權杖（GitHub Actions 用的那一把）上傳得了整份建置。最大的檔 `crs/bn254_g1_compressed_2p18.dat` 下載回來是 8,388,608 位元組，`bb/barretenberg-threads.wasm.gz` 是 4,071,596 位元組 | |
| `GET /proof` | `200`，`text/html`，495 位元組，內容是 `web/` 建置的那種 `index.html`（引用 `/proof/assets/` 底下的一支程式和標示的樣式表）；帶 `/proof` 的那一組標頭：`Content-Security-Policy`（`connect-src 'self' https://test-data.iamreal.tw`）、`Document-Isolation-Policy: isolate-and-credentialless`、`Cross-Origin-Opener-Policy: same-origin-allow-popups`、`X-Content-Type-Options`、`X-Robots-Tag: noindex`。所以 `_redirects` 的 `200` 送 `index.html` 時，`_headers` 的 `/proof` 那一條有套上 | 標頭相同 |
| `GET /proof/help.html`、`GET /proof/assets/<程式>.js` | `200`，同一組標頭；`Content-Type` 是 `text/html`、`text/javascript`，不帶 `charset` | 標頭相同 |
| `/proof` 和它的檔的 `Cache-Control`、`ETag` | `Cache-Control: public, max-age=0, must-revalidate`，有 `ETag`；帶 `If-None-Match` 再要一次是 `304`，標頭照樣帶 | |
| `GET /proof/`、`GET /proof/index.html`（不跟著轉） | `301` 到 `/proof`，帶同一組標頭，沒有 `Cache-Control` | 相同 |
| `GET /proof//index.html`、`/proof/%69ndex.html`、`/proof/assets%2f<程式>.js` | `307` 到那個檔自己的路徑，帶同一組標頭 | 相同 |
| `GET /proof/nothing.js`、`GET /proof/crs/` | 空的 `404`，帶同一組標頭 | 相同 |
| `GET /proof/..%2fpages.css` | 空的 `404` | 相同 |
| `GET /proof/../pages.css`（`curl --path-as-is`，路徑原樣送出） | `200`，是樣式表和樣式表的標頭 | 相同 |
| `POST /proof`、`POST` 和 `DELETE /proof/assets/<程式>.js` | `405`，內容是空的，沒有 `Allow`，帶 `/proof` 的那一組標頭 | 相同 |
| `POST /proof/`（不跟著轉） | `301` 到 `/proof` | 相同 |
| `POST /proof/nothing.js` | 空的 `404` | 相同 |
| `POST /api/v1/challenges` | `200`（經營運者同意送的一次）：證明紀錄不是 `paused` | |

所以上面那張「和 Worker 自己送的時候不同的地方」的表，除了「設定讀不出來時」那一列（線上的設定是對的，看不到），每一列線上都和本機相同；`_headers` 的規則在 `200`、`301`、`304`、`307`、`404`、`405` 上都有套。

**線上的頁面被 Cloudflare 加了一個別的網域的 `<script>`**（2026-11-21 看到的，當天營運者關掉了：[#240](https://github.com/iamreal-tw/iamreal/issues/240)）。

- **看到什麼**：請求帶 `Accept: text/html` 時（瀏覽器都帶），Worker 產生的每一種頁面和 `/proof`、`/proof/help.html` 回來的 HTML 都多一個 `<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/…" integrity="…" data-cf-beacon="…">`。不帶這個標頭（`curl` 和 Node 的 `fetch` 的預設）就沒有，所以上面用 `curl` 看到的 `/proof` 還是 495 位元組。
- **怎麼重現**：`curl -s --compressed -H 'Accept: text/html' https://test.iamreal.tw/faq | grep -c cloudflareinsights` 印 1，拿掉 `-H` 印 0；或跑 `test/site-check.ts`（[部署之後不插卡的檢查](#部署之後不插卡的檢查)），「沒有一頁有不是自己網站的 script」那一項不過。
- **不是這個程式庫加的**：Worker 的頁面沒有這一段，`web/` 的建置也沒有；是 Cloudflare 在回應送出去的路上加的。
- **瀏覽器沒有執行它**：兩種頁面的 CSP 都不准它載入（訪客的頁面是 `default-src 'none'`，過卡的頁面是 `script-src 'self' 'wasm-unsafe-eval'`）。過卡的頁面上，無頭的 Chrome 記了一筆 CSP 違規、沒有載入它；訪客的頁面沒有另外用瀏覽器看。但送到瀏覽器的頁面因此不是建置出來的那一份，訪客的頁面也不再是沒有 `<script>`。
- **是什麼**：Cloudflare 的 Real User Measurements（RUM，儀表板上的標題是 Web Analytics）。這個 zone 的 RUM 從來沒有設定過，頁面裡就已經被加了它。Cloudflare 的文件寫，經過 Cloudflare 的網站加進 Web Analytics 之後「is now using Web Analytics through the automatic setup, which is enabled by default」（[Get started](https://developers.cloudflare.com/web-analytics/get-started/)「Sites proxied through Cloudflare」）；自動安裝「will inject the JS snippet on all pages (sub-domains) under the zone」、加的 `<script>` 帶 `type="module"` 和 `integrity`（[FAQ](https://developers.cloudflare.com/web-analytics/faq/)）。都是 2026-11-21 讀的。
- **怎麼關的**：文件寫的是在 Web Analytics 那個網站的 **Manage site** 把自動安裝改成 **Disable**，但帳號層的 Web Analytics 清單裡沒有 `iamreal.tw`，沒有那個 Manage site。實際關的地方在 zone：`iamreal.tw` → Speed → Real user monitoring（網址結尾 `/iamreal.tw/speed/rum`）。畫面有 Enable Globally、Exclude EU 兩個按鈕和一行 Disable completely；按 Disable completely，確認視窗按 Disable RUM，之後畫面寫「RUM is currently disabled for this zone.」。只有營運者能做（[營運者在 Cloudflare 和 GitHub 上設的](#營運者在-cloudflare-和-github-上設的)）。這和 ADR-0032「沒有第三方的程式」有關：不關的話，要靠每一頁的 CSP 一直擋著它。
- **關掉之後**（等過訪客頁面 60 秒的快取）：上面的 `curl` 帶 `-H` 也印 0，`test/site-check.ts` 21 項全過。

**Cloudflare 上還沒確認的**：

- 檔案存在時直接送、不跑 Worker。線上沒有 `GET /__test/seen` 這種入口，從外面分不出一個回應有沒有經過 Worker；本機的 workerd 上是不跑。
- 真的瀏覽器打開 `https://test.iamreal.tw/proof`、從 `https` 的網域開內政部元件的視窗、用真卡片走完六步：等 [#71](https://github.com/iamreal-tw/iamreal/issues/71)。無頭的 Chrome 開到第一個畫面為止（不按「讀取卡片」，元件沒有收到請求）看過一次，2026-11-21，`web/test/e2e/smoke.ts`：頁面是跨來源隔離的、證明引擎啟動（3.5 秒）、畫面是第 1 步、`Document-Isolation-Policy` 和 `Cross-Origin-Opener-Policy` 對。那時有三項不過：連到別的網域和 CSP 違規，都是上面那個被加進來的 script；`Content-Security-Policy` 那一項是 `smoke.ts` 比的是正式的證明紀錄的那一份。`smoke.ts` 改成照網址比該有的那一份之後（[#241](https://github.com/iamreal-tw/iamreal/issues/241)），2026-11-26 再跑一次，八項都過：`Content-Security-Policy` 是測試網站的（`connect-src` 是 `test-data.iamreal.tw`），沒有連到別的網域，沒有 CSP 違規。

**加正式環境時**：`assets` 在最上層，每個環境共用同一個 `site/`，而 `_headers` 只有一份。正式的證明紀錄的 `_headers` 沒有 `X-Robots-Tag`，所以兩個環境不能用同一個目錄；部署前的檢查（`checkSiteFiles`）會擋下來。到時候給正式環境自己的目錄，或在上傳之前照環境寫出 `_headers`。

測試的工具把 `wrangler.jsonc` 原樣複製到每個測試自己的目錄再啟動 Worker，`./site` 就是那個測試自己的：設定和部署的是同一份，同時跑的測試不共用過卡頁面的檔案。`startWorker({ proofFiles })` 給一個目錄當 `site/proof/`；用正式的證明紀錄啟動時，工具把 `_headers` 換成正式的證明紀錄的那一份。

### 用假卡片走完一次

`web/` 的三套無頭瀏覽器的測試都對本機 workerd 裡的 Worker 跑（[#69](https://github.com/iamreal-tw/iamreal/issues/69)；`web/README.md`「怎麼單獨執行和測試」），用的是這裡的測試工具 `startWorker({ proofFiles, issuers })`：`web/` 測試的建置放進 Static Assets，Worker 用部署的那一個驗證器驗假卡片的證明、寫入。

| 在 `web/` 跑 | 做什麼 |
|---|---|
| `pnpm test:e2e` | 引擎：三種設定各過卡兩次，Worker 驗證、寫入，再用原生的 `bb` 驗一次 |
| `pnpm test:ui` | 畫面：`design/copy/card-proof.md` 的每一步、每一種停止原因、跨午夜、同一天第 4 筆、更換的上限和更換政策、Worker 重啟；最後 Worker 公布證明紀錄，Go 的 `iamreal-verify` 照預設的讀法重驗寫出來的每個檔（證明是真的） |
| `pnpm test:worker` | [`web/test/worker-card-proof.ts`](../web/test/worker-card-proof.ts)：過卡之後打開 `/p/<短編號>` 和首頁，比對 `design/copy/` 的句子，各拍桌機和手機寬度的截圖（`web/test-output/worker/screens/`） |

- 清冊由 Worker 的排程從假的內政部鏡像進 R2 的模擬。測試的建置從自己的網域拿清冊，而 Worker 沒有把清冊送給人的路由，所以測試在 Worker 前面起一個小的服務扮演資料網域（[`web/test/e2e/worker-site.ts`](../web/test/e2e/worker-site.ts)）：`/crl/…`、`/proof-log/…` 從 R2 的模擬讀（只讀），其他請求原樣交給 Worker。
- Worker 測試專用建置的時鐘設了就不走。要讓後台的時鐘和頁面的一起走時，那個小服務在每個交給 Worker 的請求之前把它設成這台電腦的時間加上一段固定的時間（`setClockAhead`）。
- 它們用固定的埠 61171（假的元件），一次只能跑一套。
- 三套都在 CI 的 `browser` 工作裡（`.github/workflows/checks-browser.yml`），`worker/` 有改的 PR 會跑；前兩套在 `CONTRIBUTING.md`「完成的定義」的清單上。

## 三樣不是設定值的東西

後台認哪些發證金鑰、去哪裡抓內政部的清冊、現在幾點，都寫在程式裡，不是設定值（ADR-0028）：設定寫錯，不會讓後台收下假卡片簽的東西。

- [`src/target.ts`](src/target.ts) 是部署用的那一份：內政部的兩把發證金鑰（[`src/issuers.ts`](src/issuers.ts)，測試拿 `spec/vectors/issuers.json` 核對）、內政部的兩個清冊網址（和 [`crl/README.md`](../crl/README.md) 寫的相同）、真的時鐘。其他程式用 `#target` 這個名字引用它（`package.json` 的 `imports`）。
- [`test-build/`](test-build) 是測試專用的建置換上的那一份：`target.ts` 是測試當場產生的發證金鑰、假的內政部的網址、可以調的時鐘；`index.ts` 是進入點，在 Worker 前面多一個調時鐘的開關 `PUT /__test/clock`，和三個常設的入口，各測一件 `records` 看不到或到不了的事：
  - `POST /__test/verify` 讓測試直接呼叫驗證證明，呼叫的就是 `src/in-worker.ts` 的 `proofVerifier`，沒有換掉任何一部分。`records` 到不了的：和原生的 `bb verify` 逐案比對的 1,128 案，大多是任何一筆紀錄都帶不出來的公開輸入。
  - `GET /__test/newest-crls` 讓測試看得到證明紀錄的 Durable Object 存著的最新清冊，呼叫的就是 `src/proof-log.ts` 的 `newestCrls`。`records` 看不到的：清冊鏡像的測試比的是 Durable Object 拿到哪幾份的編號和日期，`records` 只回收或不收。
  - `PUT /__test/proof-log/card` 照給的內容寫卡片狀態表的一列。`records` 寫不出來的：紀錄規則不會留下的狀態。只用來寫這種狀態：壞掉的（`card-state` 要回 `500`），和少了平台表裡某個平台的名額的（平台加進表之前寫的）。唯一的例外是壞掉的那些案例的起點：每個壞掉的狀態都是從同一個好的狀態改一項來的，那個好的狀態也用這個入口寫一次，確認它本身讀得過。其他規則會留下的狀態，測試一律用真的送出（`POST /api/v1/records`）寫。
  - `PUT /__test/verifier` 選 `records` 用哪一個驗證器。預設是 `real`，就是部署的那一個；用真的證明的測試（[`test/records-real.test.ts`](test/records-real.test.ts)）用它。`stand-in` 只看證明的第一個位元組：0 通過、1 拒絕、2 是驗證器跑不起來、3 是先把測試的時鐘往後撥 1 毫秒再通過（驗證花了時間，用來測題目在驗證時過期）。做一份真的證明要卡片的金鑰和幾秒鐘，所以測題目、清冊、紀錄規則、寫入的那些案例用它，和 Go 舊後台的測試相同（它的 `harness_test.go` 的 `fakeProofs`）。它接在 `src/index.ts` 指定驗證器的同一個介面後面（`ApiParts`）。
  - `index.ts` 另外有通到證明紀錄那個 Durable Object 的入口，`/__test/proof-log/…`。測試專用建置的 Durable Object 是部署的那一個類別（`src/proof-log.ts`）加上只給測試用的方法：現在就跑一次 alarm、讀 alarm 設在什麼時候（這兩個加 `?object=<名稱>` 時問的是那個名稱的物件，不是設定指的那一個：清空之後被換掉的物件只有這樣叫得到）；多塞一件假的定時工作、讀那件工作什麼時候跑過；指定下一個題目的 16 個位元組（測試才拿得到證明當初用的那個題目）；把存著的表的版本、規則的版本改成另一個數字；照給的內容寫卡片狀態表的一列（上面的 `PUT /__test/proof-log/card`），或一次寫一批（`PUT /__test/proof-log/cards`，只給量測用，見[每天換日公布證明紀錄](#每天換日公布證明紀錄)「大小的上限」）；單獨複製卡片狀態表或刪掉複本（`POST /__test/proof-log/cards-copy`，也只給量測用）；列出物件資料庫裡的表（`GET /__test/proof-log/tables`，看公布完沒有留下複本）；把題目表和卡片狀態表丟掉、把一張卡片存著的名額改成不是 JSON 的字再改回來、或讓某一張表的每次寫入都失敗（看後台自己出錯時回什麼、寫到一半失敗留下什麼）；把最新清冊的那張表丟掉；拿 `spec/vectors/record-rules.json` 的一筆事件（或長序列的一筆，寫法相同），對存著的狀態跑一次紀錄規則（讀狀態、寫狀態用的是送出一筆的同一段程式；無效的紀錄後台不會寫，所以要有這個入口）；讀證明紀錄裡最晚的有效日期和每個帳號底下的卡片數，讀法和數法是部署的那一段（`POST /__test/proof-log/rule-state`，見[紀錄規則和 Go 的 `prooflog/` 逐筆比對](#紀錄規則和-go-的-prooflog-逐筆比對)）；讀出存著的紀錄和證明紀錄那一列（`GET /__test/proof-log/stored`，部署的後台沒有介面讀得到它們；搬到 R2 的檔不在裡面，測試從 R2 的模擬讀）；只讀物件裡留著幾筆、從哪一筆到哪一筆（`GET /__test/proof-log/kept`）；讓物件對資料儲存桶某一個物件的寫入或讀取出錯（`PUT /__test/proof-log/bucket-fault`：寫不進去、寫到串流中間斷掉、送出去或存下來的位元組不同、標頭不同、寫進去了但回應丟了、讀不出來；物件經過 `src/proof-log.ts` 的 `bucket()` 拿儲存桶，只有測試專用的建置覆寫它）；等物件把衍生表重建完或放棄（`POST /__test/proof-log/views-filled`）；算一筆紀錄的雜湊之前先等幾毫秒、讀它算過幾次雜湊（`/__test/proof-log/hash-delay`，見[寫入是一個交易](#寫入是一個交易)）。部署的那一包沒有這些方法。
  - `PUT /__test/settings` 換掉環境的設定（`PROOF_LOG_KIND`、`PROOF_LOG_OBJECT_NAME`、`RESTRICT_LATE_SWITCHES`、`CARD_PROOFS_PAUSED`、`REBUILD_PROOF_LOG`、`TEST_PROOF_LOG_CLEARED_ON`）：換上的值只放在測試專用建置的記憶體裡，蓋在 Worker 和 Durable Object 拿到的環境上。`wrangler.jsonc` 沒有動，部署的建置讀的是設定檔裡的值。正式的證明紀錄的案例、設定寫錯的案例、更換政策的案例用它測。
- 測試的發證金鑰每個測試的程序產生一次（[`test/crls.ts`](test/crls.ts)）。私鑰留在那個程序的記憶體裡，用來簽測試的清冊；不寫進任何檔案，也不進任何建置。和 `crl/testdata/` 比對的那個測試，G2 換成簽 `crl/testdata/` 的那一把（只有公鑰）。
- 怎麼換：[`test/build.ts`](test/build.ts) 經由 [`scripts/deploy.ts`](scripts/deploy.ts) 的 `bundleWorker` 跑 `wrangler deploy --dry-run`，用 `--alias` 把 `#target` 指到 `test-build/target.ts`，進入點換成 `test-build/index.ts`，金鑰和網址用 `--define` 帶進去。wrangler 的設定檔和部署的指令裡沒有這些參數，所以部署的建置拿到的一定是 `src/target.ts`。
- 部署的那一包在上傳之前一定經過 [`scripts/deploy-build-checks.ts`](scripts/deploy-build-checks.ts) 的檢查（本機的 `pnpm run deploy:test` 和 GitHub Actions 的 `build` 工作都是，見「[部署測試環境](#部署測試環境)」）：
  - JavaScript 裡的網址只有內政部的兩個，加上頁面和標頭裡寫的那幾個（`PAGE_ADDRESSES`：公開的程式庫、它的一個檔（`cmd/iamreal-verify/README.md`）和討論區、維護者的部落格（常見問題「誰在做島民證明？」）、Threads、掛上去複製的島民證明網址）。後面這幾個只是寫在頁面和標頭裡的字，Worker 自己發出的請求仍然只有內政部的兩份清冊。過卡頁面的 CSP 裡的資料網域不在這一包裡：那一組標頭寫在 `site/_headers`
  - JavaScript 裡長到可能是 RSA 金鑰的字串，恰好是 `spec/vectors/issuers.json` 的兩個模數，加上 Barretenberg 通用參數的那一個點（128 個位元組寫成十六進位，用它的 SHA-256 認，要恰好出現一次）。找得到的寫法是十六進位、十進位、base64、PEM；拆成數字陣列或執行時才拼起來的金鑰，這個檢查看不到
  - 沒有假的內政部、時鐘的開關和測試專用建置的其他痕跡
  - wrangler 列出的 binding 只有 `PROOF_LOG`、`DATA`、`PROOF_LOG_OBJECT_NAME`、`PROOF_LOG_KIND`、`TEST_PROOF_LOG_CLEARED_ON`，所以金鑰、網址、時鐘沒有設定值可以讀，Worker 也沒有 `ASSETS` 可以讀 Static Assets 的檔。用 `wrangler secret` 另外設在 Worker 上的密鑰不在設定檔裡，這個檢查看不到
  - 不是 JavaScript 的模組恰好是 WASM 檔和兩把驗證金鑰，SHA-256 是核對過的那三個
  - `wrangler.jsonc` 每一個環境的 `limits.cpu_ms` 都是鏡像一輪假設自己拿得到的 CPU 時間（`src/round-budget.ts` 的 `ROUND_CPU_MS`，300,000 毫秒）。設定檔裡有幾個環境就讀幾次，每個照 wrangler 讀 `--env <名稱>` 的方式讀；有一個環境沒有設、或是別的數字就不過。這一項用 wrangler 的函式庫在跑檢查的那個程序裡讀設定檔，不另外起指令，也不送請求
  - `wrangler.jsonc` 裡用測試的證明紀錄的環境，`TEST_PROOF_LOG_CLEARED_ON` 是日曆上有的日期，讀法和 Worker 執行時相同（`checkClearedOn`）。寫錯的話部署出去的測試網站全部回 `500`，這一項讓它在部署前就被擋下
  - `wrangler.jsonc` 每一個環境的 Static Assets（`checkSiteFiles`，讀法同上一項）：`run_worker_first` 是把 `/copy.js`、`/demo.js`、`/favicon.ico`、`/fonts/*`、`/og-image.png`、`/pages.css`、`/proof`、`/proof/*` 排除在外的那一份，沒有 `binding`，`html_handling` 和 `not_found_handling` 是 `none`；那個環境的 `site/_headers` 和 `scripts/site-files.ts` 照它的 `PROOF_LOG_KIND` 寫出來的逐字相同，`site/_redirects` 也是；`site/` 裡 `proof/` 以外的檔案恰好是 `pages.css`、`copy.js`、`fonts/GenRyuMin2TW-B.woff2`、`og-image.png`、`_headers`、`_redirects`，`pages.css` 和 `copy.js` 和 `HEAD` 裡的那一份逐位元組相同，字型和 `design/fonts/` 的子集逐位元組相同。所以把設定改回「每個請求先跑 Worker」、手改一個標頭、測試網站的 `_headers` 少了 `noindex`、`site/` 多了別的檔、或 `pages.css`、`copy.js` 有還沒提交的改動，都過不了
  - `site/proof/` 裡的過卡頁面另外檢查（`checkProofPages`，[Static Assets](#static-assets) 列了每一項）。它不在 `checkDeployBuild` 裡，因為要先建置頁面；兩種部署的入口（`scripts/build-deploy.ts`、`scripts/deploy-test.ts`）都先呼叫 `buildSite`，建置完就檢查。`test/deploy.test.ts` 讀這兩支腳本，釘住 `buildSite` 在打包、讀權杖、上傳之前
- [`test/bundle.test.ts`](test/bundle.test.ts) 對新打的部署那一包逐項跑這些檢查，也把測試專用的建置打出來，確認同樣的檢查在那一包會失敗（找得到測試的金鑰、假的內政部和時鐘的開關）。

**驗證證明的程式兩種建置相同，測試專用的建置預設用的也是真的那一個；它另外能在測試明確要求時（`PUT /__test/verifier`）把 `records` 用的驗證器換成替身，替身進不了部署的那一包。** 測試專用的建置換掉的只有 `#target` 和進入點；驗證證明和 Poseidon2 的六個檔（`src/in-worker.ts` 和它引用的 `src/verify.ts`、`src/poseidon2.ts`、`src/engine.ts`、`src/barretenberg.ts`、`src/circuits.ts`）不引用 `#target`，也不引用 `src/` 裡這六個以外的檔（[`test/layout.test.ts`](test/layout.test.ts) 檢查）。兩包裡不是 JavaScript 的模組都恰好是 WASM 檔和兩把驗證金鑰，SHA-256 是核對過的那三個：部署的那一包由 `scripts/deploy-build-checks.ts` 的 `checkEngineFiles` 檢查，少一個、多一個、內容不同都不過。部署的那一包從清冊鏡像開始含這三個檔：鏡像引用 `src/in-worker.ts` 的 `poseidon2Hash`，驗證金鑰跟著同一個檔進來，送出一筆時呼叫驗證的也是它的 `proofVerifier`。測試專用的建置可以把 `records` 用的驗證器換成只看第一個位元組的那一個（上面的 `PUT /__test/verifier`），預設不換，重啟整個 Worker 之後也變回真的（[`test/records.test.ts`](test/records.test.ts) 有這兩個案例）；換上的那一個在 `test-build/index.ts`，不在這六個檔裡。部署的那一包沒有它：進入點是 `src/index.ts`，`scripts/deploy-build-checks.ts` 的 `checkNothingOfTheTestBuild` 不准那一包裡有 `/__test/`、`test-build` 這些字。找網址和金鑰長度的字串只掃 JavaScript，不掃這三個檔（它們的內容由 SHA-256 定死）。

`target.ts` 還有兩樣時間，也是測試專用的建置會換的：等內政部一份清冊最久等多久（部署的是 5 分鐘，測試換成一兩秒，測逾時才不用等幾分鐘），和一輪鏡像補之前留下的檔最久補多久（部署的是 2.5 分鐘，寫在 [`src/round-budget.ts`](src/round-budget.ts)，`target.ts` 引用它；測試可以設成別的數字來測這條界線）。

Worker 載入時檢查發證金鑰是一把 2048 位元的 G2 和一把 4096 位元的 G3，不是就不啟動。

## 驗證證明

照 ADR-0023 和 [#16](https://github.com/iamreal-tw/iamreal/issues/16) 的結論，在 Worker 裡用 Barretenberg 的 WASM 驗（[`spec/proof-verification.md`](../spec/proof-verification.md)）。

### 介面

[`src/verify.ts`](src/verify.ts) 的 `ProofVerifier`，後台只經過它驗證：

```ts
interface ProofVerifier {
  verify(circuit: string, proof: Uint8Array, publicInputs: readonly Uint8Array[]): Promise<boolean>;
}
```

- `circuit` 是電路的名稱，`card_proof_rs2048` 或 `card_proof_rs4096`；`publicInputs` 每個值是 32 個位元組、大端序，照電路的順序。
- 回 `true` 是通過，`false` 是拒絕。請求本身有任何不對都是拒絕，不丟例外：不認得的名稱、長度不對的證明、個數或大小不對的公開輸入、不小於模數的值、驗不過的證明、讓 Barretenberg 丟例外的證明。
- **跑不起來不是拒絕，也不是通過。** 驗證器自己跑不起來（WASM 實例化失敗、載入通用參數失敗）時 `verify` 丟例外（`EngineError`，`notStarted` 是 `true`），不回任何結果；那和證明無關，沒有任何輸入會造成它。呼叫的人不可以把它當成通過：送出一筆時這一筆不接受、不寫入，回 `500`（見[送出一筆](#送出一筆)），是後台自己的錯誤，不是 `proof` 這個拒絕代碼。下一次呼叫會重新試著實例化。[`test/engine.test.ts`](test/engine.test.ts) 確認這條路不會回 `true`，也不會回 `false`。
- Barretenberg 回的不是預期的那一種答覆、或答覆裡沒有結果時，算拒絕，並丟掉那個實例。
- 在 Worker 裡驗的那一個是 [`src/in-worker.ts`](src/in-worker.ts) 的 `proofVerifier`。之後改走 Containers 跑原生的 `bb`，換掉的是它，其他程式不動。

### 呼叫 WASM 之前的檢查

和 Go 的 [`verifier/verify.go`](../verifier/verify.go) 在呼叫 `bb` 之前做的相同，不通過就不問 WASM：

1. 證明剛好 14,656 個位元組
2. 公開輸入的個數是這個電路的個數（23 或 40），每個值剛好 32 個位元組
3. 每個值小於模數 `p`

在這幾種輸入上，WASM 和原生的 `bb` 出錯的方式不同（#16），所以兩邊都不問。

### 丟例外就換實例

WASM 丟出任何例外都算拒絕，並丟掉那個實例，下一筆重新實例化（[`src/engine.ts`](src/engine.ts)）。同一個實例一直吃例外會漏記憶體，到大約第 335 次之後連正確的證明都驗不過（#16）；[`test/verify.test.ts`](test/verify.test.ts) 有連續 500 個丟例外的證明之後再驗正確證明的案例，拿掉「丟掉實例」那一行它會失敗。測試沒辦法讓真的 WASM 回形狀不對的答覆或不啟動，這幾種情況在 [`test/engine.test.ts`](test/engine.test.ts) 用一個頂替 Barretenberg 實例的假物件測，在 Node 裡跑。

一個實例的記憶體上限設在 16 MiB（驗一筆用到 2.6 MiB）。Barretenberg 自己印的訊息不留：裡面可能帶著正在驗的內容。

### WASM 檔和驗證金鑰從哪裡來

每一次建置（測試的、`pnpm dev` 的、部署的）都先跑 [`scripts/engine-files.ts`](scripts/engine-files.ts)，核對下面三個檔的 SHA-256，寫進 `generated/`（不進版控）；任何一個不對，建置就停在這裡，不呼叫 wrangler。

| 檔案 | 來源 | SHA-256 |
|---|---|---|
| `barretenberg.wasm`（18,278,515 個位元組） | `@aztec-foundation/bb.js` 6.0.0 的 `dest/browser/barretenberg_wasm/fetch_code/browser/barretenberg.js`：單執行緒的 WASM 以 gzip 加 base64 寫在這個檔裡，取出來解壓縮 | `88c435ec45998ad74b51b25659b37e59b4beea256073138415547f8153f9ead9` |
| `card_proof_rs2048.vk.bin` | [`verifier/vk/card_proof_rs2048.vk`](../verifier/vk)，Go 的驗證器編進去的同一個檔 | `816406c75c5422cefab5acd70276f3dc8ce5d269736aefd9795e230569bd3ac8` |
| `card_proof_rs4096.vk.bin` | [`verifier/vk/card_proof_rs4096.vk`](../verifier/vk) | `bed43ed823a5273292150785bce9a24a24162711a25e8c3a4337a61bdc9f38c2` |

- 驗證金鑰在程式庫裡只有 `verifier/vk/` 那一份；`generated/` 裡的是每次建置時抄的，檔名加 `.bin` 是為了讓 wrangler 照預設的規則把它當成位元組載入，設定檔不用改。兩個 SHA-256 和 `spec/proof-verification.md` 的表相同（[`test/engine-files.test.ts`](test/engine-files.test.ts) 核對）。
- 自己核對 WASM 的 SHA-256：在這個目錄 `node --experimental-strip-types -e 'import("./scripts/engine-files.ts").then((m) => m.prepareEngineFiles())' && shasum -a 256 generated/barretenberg.wasm`。
- bb.js 只用到這一個檔，它的程式沒有進 Worker。載入程式是自己寫的（[`src/barretenberg.ts`](src/barretenberg.ts)）：bb.js 是抓位元組來編譯（`WebAssembly.compile`），Workers 不允許：Cloudflare 的文件把 `WebAssembly.compile`、`WebAssembly.compileStreaming`、收位元組的 `WebAssembly.instantiate`、`WebAssembly.instantiateStreaming` 和 `eval()`、`new Function` 列在一起，寫「For security reasons, the following are not allowed」（[JavaScript and web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)，2026-11-20 讀的）。這裡是把 WASM 當模組引用，執行環境給的是編好的模組（[WebAssembly in JavaScript](https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/)）。提供給 WASM 的是 1 塊記憶體和 5 個函式，用和 bb.js 相同的 msgpack 格式（`msgpackr`）呼叫 `bbapi` 的 `SrsInitSrs`、`CircuitVerify`、`Poseidon2Hash`；`CircuitVerify` 的設定是 `noir-recursive`，沒有別的。
- 通用參數不下載：G1 的第一個點 `(1, 2)` 和 G2 的那一個點寫在載入程式裡。G2 那 128 個位元組和 `https://crs.aztec-cdn.foundation/g2.dat` 相同（bb.js 6.0.0 的 `src/crs/net_crs.ts` 下載的網址；2026-11-20 抓下來逐位元組對過，SHA-256 `01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f`）。WASM 自己核對這兩個點，不對就中止（#16），所以寫錯的後果是什麼都驗不過，不是驗錯。
- 直接跑 `wrangler deploy` 不會經過這個核對，用的是 `generated/` 裡現有的檔；部署一律用 `pnpm run deploy:test`。

### Poseidon2

[`src/in-worker.ts`](src/in-worker.ts) 的 `poseidon2Hash(inputs: readonly Uint8Array[]): Uint8Array`（型別 `Poseidon2Hash` 在 [`src/poseidon2.ts`](src/poseidon2.ts)）：輸入和輸出都是 32 個位元組、大端序的體元素，同步，用驗證證明的同一個 WASM 實例。清冊鏡像建樹用它（[`src/crl-tree.ts`](src/crl-tree.ts)），Worker 裡沒有另一份 Poseidon2。不是 32 個位元組或不小於 `p` 的輸入丟 `RangeError`，不問 WASM。Barretenberg 跑不起來、丟例外、或回的不是雜湊時丟 `EngineError`，並丟掉那個實例（跑不起來時沒有實例可丟）；下一次呼叫用新的實例。[`test/poseidon2.test.ts`](test/poseidon2.test.ts) 拿 `spec/vectors/poseidon2.json`（Go 的 `crl/poseidon2` 讀的同一份）核對：`hash_2`、`hash_3`、`scoped_id` 每一案在 Node 裡直接呼叫這個函式（Worker 沒有只算雜湊的入口）；`revocation_tree` 每一案的樹根在本機的 workerd 裡經過清冊鏡像核對。

### 和原生的 `bb verify` 逐案比對

```sh
IAMREAL_BB=/path/to/bb pnpm test                                                          # 全部的測試，包含比對
IAMREAL_BB=/path/to/bb node --experimental-strip-types --test test/compare.test.ts        # 只跑比對
```

`IAMREAL_BB` 指到 `bb` 6.0.0（和 Go 的測試同一個變數），另外要有 `go`；沒設就跳過。約 80 秒。GitHub Actions 上，`typescript` 工作（`.github/workflows/checks.yml`；改到它的清單的 PR 和合併佇列都跑）設了兩樣，會跑到它；`web/` 的兩套瀏覽器測試在另一個工作流程，只在它們用到的檔改了才跑（`.github/README.md`）。[`test/compare.test.ts`](test/compare.test.ts) 做的事：

1. 用一個頂替 `bb` 的腳本跑 `go test ./verifier`，留下每次交給 `bb verify` 的驗證金鑰、證明、公開輸入，再把同樣的參數交給真的 `bb`。內容相同的算一案。Go 的測試裡有亂數的證明，所以每次跑的案例不完全相同。
2. 加上 Go 在呼叫 `bb` 之前就擋掉、所以腳本看不到的那幾種，每個電路 16 案：公開輸入加上 `p`、等於 `p`、`2^256 − 1`、個數多一個少一個、沒有、少一個位元組；證明是空的、多或少一個位元組、多或少一個值、非零知識的證明；別的電路的驗證金鑰（配原本的公開輸入、配那個電路的公開輸入）。
3. 每一案各問一次原生的 `bb verify -t noir-recursive`（結束代碼 0 是通過，其他都是拒絕）和本機 workerd 裡的 Worker，通過或拒絕要相同。全部比完之後，兩個電路正確的證明還要驗得過。

2026-11-20 跑的結果（原生 `bb` 6.0.0，macOS arm64；workerd 1.20261110.1）：Go 的測試呼叫 `bb verify` 1,109 次，內容不同的 1,096 案，加上第 2 項的 32 案，共 1,128 案；原生通過 2 案、拒絕 1,126 案，**沒有一案不同**。

比不到的：驗證金鑰本身被改過的情況（#16 試過少一個位元組的驗證金鑰）。這個介面不收驗證金鑰，金鑰是建置時核對過 SHA-256 的那兩把。

### 量到的

2026-11-20，Apple Silicon，本機的 workerd（1.20261110.1），從測試的程序經 HTTP 量，各 200 次的中位數。本機的 workerd 不限 CPU 和記憶體，這些數字只說明量級。

| | 往返一次 |
|---|---|
| 不存在的網址（只有 HTTP 的往返） | 2.6 ms |
| 驗證的入口，在呼叫 WASM 之前就拒絕（往返加上讀請求） | 3.9 ms |
| 驗一筆 `card_proof_rs2048` | 18.5 ms |
| 驗一筆 `card_proof_rs4096` | 18.7 ms |
| 前一筆丟了例外之後驗一筆（多一次實例化） | 20.3 ms |

- 扣掉往返，驗一筆約 15 ms，實例化約 2 ms。Worker 啟動後的第一筆（第一次實例化加驗證）往返 84 ms。
- 在 Node 22 裡直接跑載入程式一次：實例化加載入通用參數 10 ms，第一筆驗證 26 ms，第二筆 13 ms；WASM 的記憶體實例化後是 2.5 MiB，驗完兩筆是 2.6 MiB。
- 打包後的大小（部署的那一包，`wrangler deploy --dry-run` 印的）：17,999 KiB，gzip 後 4,034 KiB，幾乎都是 WASM。清冊鏡像做好之前，部署的那一包是 23 KiB（gzip 後 8.4 KiB）；**這個大小的一包還沒有上傳到 Cloudflare 過**。

## 設定檔

[`wrangler.jsonc`](wrangler.jsonc)。最上層是每個環境都一樣的：進入點、相容日期、Durable Object 的 migration、不送使用統計給 Cloudflare、一次呼叫的 CPU 時間上限（`limits.cpu_ms`，見這一節最後）。沒有 `build.command`，部署時不會執行任何自訂的指令。

每個環境一段，寫在 `env` 底下。現在只有測試環境 `env.test`（ADR-0028）：

| 欄位 | 值 | 說明 |
|---|---|---|
| `name` | `iamreal-test` | Worker 的名稱。部署的權杖只能部署這一個 |
| `workers_dev`、`preview_urls` | `false` | 不開 `workers.dev` 的網址，只走自訂網域 `test.iamreal.tw`。自訂網域在儀表板上設，不在這裡（ADR-0029） |
| `triggers.crons` | `0 * * * *` | 每小時整點跑一次排程 |
| `durable_objects` | `PROOF_LOG` → 類別 `ProofLog`；`COUNTS` → 類別 `Counts`；`STARTS` → 類別 `Starts` | 一份證明紀錄一個 Durable Object；收計數的是另一個（[計數](#計數)），最上層的 migration `v3` 建它的類別；數開始過卡的又是另一個（[全站的總量上限](#全站的總量上限)），migration `v4` 建它的類別 |
| `ratelimits` | `RATE_CHALLENGES` 等六個 | 照 IP 的上限，一類一個（[限流](#限流)） |
| `vars.COUNT_EVENTS_PER_MINUTE` | `600` | 一分鐘的計數明細最多留幾筆（[計數](#計數)）。0 到 100000 的整數；不是的話收計數的介面回 `500` |
| `vars.CARD_PROOF_STARTS_PER_MINUTE` | `60` | 全站每分鐘最多幾次開始過卡（[全站的總量上限](#全站的總量上限)）。0 到 100000 的整數；不是的話不擋，即時的輸出寫一行 |
| `r2_buckets` | `DATA` → `iamreal-test-data` | 公開的檔案，經 `test-data.iamreal.tw` 下載（ADR-0027） |
| `vars.PROOF_LOG_OBJECT_NAME` | `test-3` | 證明紀錄那個 Durable Object 的名稱。清空測試的證明紀錄時換成下一個號碼，用過的名稱不再用（[清空測試的證明紀錄](#清空測試的證明紀錄)）；維持 `test-` 開頭（[證明紀錄和物件的名稱要對得上](#證明紀錄和物件的名稱要對得上)） |
| `vars.PROOF_LOG_KIND` | `test` | 這個環境用哪一份證明紀錄，`test` 或 `production`。它決定接受哪個場合字串、平台表是哪一張（ADR-0028）；兩者的內容寫在 `protocol/`，不在設定裡。不是這兩個值、或和 `PROOF_LOG_OBJECT_NAME` 對不上時，五個介面和 Worker 產生的每個頁面都回 `500`（Static Assets 的檔案不跑 Worker，照常送） |
| `vars.TEST_PROOF_LOG_CLEARED_ON` | `2026-11-23` | 測試的證明紀錄上次清空的日期，每一頁的標示旁寫它（[測試的證明紀錄的標示](#測試的證明紀錄的標示)）。第一次清空是 2026-11-21（紀錄規則的版本從 1 加到 2，[#120](https://github.com/iamreal-tw/iamreal/issues/120)）；第二次是 2026-11-23（Durable Object 的類別改名，migration `v2` 刪掉舊的類別，[#277](https://github.com/iamreal-tw/iamreal/issues/277)）；在那之前寫的是測試網站第一次部署的日期 2026-11-19。清空時和 `PROOF_LOG_OBJECT_NAME` 一起改（[清空測試的證明紀錄](#清空測試的證明紀錄)） |
| `vars.CARD_PROOFS_PAUSED` | `false` | `"true"` 停止收過卡，`"false"` 收（[停止和恢復收過卡](#停止和恢復收過卡)）。營運者在儀表板改；下一次部署寫回這裡的值。不是這兩個值時，API 回 `500` |
| `vars.REBUILD_PROOF_LOG` | 空字串 | 營運者要的一次重建的名稱，空字串是沒有（[從證明紀錄重建](#從證明紀錄重建)）。1 到 40 個 `A-Za-z0-9._-`；不是的話 API 回 `500`。營運者在儀表板改；下一次部署寫回這裡的值 |
| `assets`（最上層，每個環境共用） | `./site`，沒有 binding | 樣式表、複製按鈕的程式和過卡頁面的檔案，Cloudflare 直接送，不跑 Worker（[Static Assets](#static-assets)） |

**`limits.cpu_ms` 是 `300000`，寫在最上層。** 一次呼叫最多用多少 CPU 時間：300,000 毫秒是能設的最大值，沒有設是 30 秒（[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)「CPU time」，2026-11-20 讀的），一棵樹都建不完（[Cloudflare 上第一次建樹](#cloudflare-上第一次建樹)）。

- **為什麼在最上層**：鏡像的一輪照這個數字留餘裕（`src/round-budget.ts` 的 `ROUND_CPU_MS`），那是程式裡的常數，每個環境都一樣。wrangler 4.160.1 讀設定時，`limits` 是環境沒寫就沿用最上層的那一種欄位（`wrangler-dist/cli.js` 的 `normalizeAndValidateLimits` 呼叫 `inheritable`：先拿環境自己的，沒有才拿最上層的），所以之後加的環境不用再寫一次就有。[`test/environments.test.ts`](test/environments.test.ts) 釘住最上層是 300,000、環境自己沒有另外寫、每個環境照 wrangler 的讀法讀到的都是 300,000；部署前的檢查對每個環境再核對一次。
- **它不只管排程。** 這是每一次呼叫的上限：每個 HTTP 請求一樣是 300,000 毫秒；證明紀錄的 Durable Object 也是，它的每次呼叫和 alarm 用同一個設定（[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)：「Durable Objects are Worker scripts, and have the same per invocation CPU limits as any Workers do」，2026-11-20 讀的）。所以一個請求能讓後台算多久，現在是程式擋，不是這個上限擋。
- **現在可以接受的理由**：請求的內容最多讀 64 KiB（`src/api.ts` 的 `MAX_BODY_BYTES`），超過就拒絕；五個介面做的事和內容的大小無關或只和這 64 KiB 有關。送出一筆（[送出一筆](#送出一筆)）每次驗一筆證明，工作量是固定的，本機約 15 ms（[量到的](#量到的)），而且一個題目最多驗 5 次。Durable Object 裡沒有照請求內容放大的計算：寫入一筆和頁面的每個查詢各走索引；一個短編號對到的卡片通常只有一張，島民證明要讀的是那張卡片的全部紀錄，一張卡片一天最多 3 筆。頁面只收 `GET`，不讀請求的內容。之後加的介面要守住這一點：有哪個請求能讓後台算上幾秒，這個上限就不再是它的保護。

之後加正式環境，是在 `env` 底下多一段；Worker 的程式不用改，但 Static Assets 的檔案要分開：兩種證明紀錄的 `_headers` 不同，共用同一個 `site/` 過不了部署前的檢查（[Static Assets](#static-assets)「加正式環境時」），`test/environments.test.ts` 也要加對應的一段。正式的儲存桶要有和測試的同樣的生命週期規則（[每天換日公布證明紀錄](#每天換日公布證明紀錄)「部署後要營運者做的」）。最上層沒有 `name`，也沒有 binding：指令沒帶 `--env` 時，wrangler 拿套件名稱 `iamreal-worker` 當 Worker 的名稱，不會是 `iamreal-test`。

## 排程做什麼

每小時一次。先公布連線紀錄最舊一筆的日期（[連線紀錄](#連線紀錄)）和計數明細最舊一檔的日期（[計數](#計數)），兩件各做各的，和下面的鏡像也互不影響；再做一輪清冊鏡像（[`src/mirror.ts`](src/mirror.ts)），照 [`spec/revocation-tree.md`](../spec/revocation-tree.md)。鏡像三步：

**一、抓和存。**

1. 同時抓 G2、G3 的清冊，兩份互不等待。每一份從送出請求到收完最多等 5 分鐘：G2 的清冊約 17 MB，每秒 0.5 Mbit 也收得完；排程一次的牆上時間最多 15 分鐘（[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)「Wall time limits by invocation type」），等回應的時間不算 CPU 時間（同一頁「CPU time」）。
2. 收到完整的 `200` 時，算內容的 SHA-256。R2 裡已經有 `crl/<SHA-256>.crl` 就不重存；沒有才寫入。
3. **請求帶條件**（[#266](https://github.com/iamreal-tw/iamreal/issues/266)）。內政部一天簽 4 份清冊，鏡像一天問 24 次，大約 20 次是同一份。寫入一份新的檔時，把內政部那一次回應的 `ETag`、`Last-Modified` 和問的網址記在那個 R2 物件的自訂中繼資料（`source`、`etag`、`last-modified`）。下一輪先列出 `crl/`，每個網址找它最後存進來、帶著這些標頭、而且索引裡是可用清冊（驗過內政部的簽章）的那個檔：有 `ETag` 就帶 `If-None-Match`，沒有 `ETag` 才帶 `If-Modified-Since`，只帶一個。內政部回 `304` 時不下載、不存，那一輪這一份的結果是 `not_modified`，寫出條件所指的那個檔的 SHA-256；那個檔索引裡已經有行就不建樹，還沒有行的（上一輪中斷）照第二步補上。回 `304` 時那個檔要還在儲存桶裡，不在就算失敗
   - 標頭跟著檔走：檔被刪掉，它的條件也跟著沒有。下一輪用的是同一個網址更早的那個檔的標頭（內政部已經不是那一份，所以整份下載）；那個網址一個帶標頭的檔都沒有時不帶條件
   - 整份下載回來、發現儲存桶已經有同樣內容的檔時（`already_stored`），如果內政部這一次說的標頭和那個檔記的不同，把檔連同新的標頭重寫一次，下一輪就用新的。少了這一步，內政部把同一份內容重新放上去（`ETag` 變了）之後，到下一份清冊之前每一輪都會整份下載
   - 不記的：回應沒有 `Content-Length` 的（可能是截斷的，見下面）、標頭不是可見的 ASCII 或超過 256 個字元的。這一版之前存的檔沒有標頭：部署後第一輪照舊整份下載，照上一點把標頭補記上去，第二輪開始帶條件
   - **只拿驗過章的檔當條件**：內政部的兩個網址是明文 HTTP，路上的人可以回一次假的內容、配上內政部真的 `ETag`。那個檔會被存下來（索引裡是不可用的一行），但不會被拿來當條件，下一輪照樣問到真的那一份。拿它當條件的話，內政部自己會一直回 `304`，到下一份清冊之前鏡像都拿不到真的
   - 沒有 `ETag`、只有 `Last-Modified` 時，條件是「在那之後有沒有改」：內政部換回比較舊的檔時會回 `304`。現在兩個網址都給 `ETag`，不走這一條
   - 內政部兩個標頭都不給時，每一輪照舊整份下載、比 SHA-256
   - 沒帶條件卻收到 `304` 算失敗
4. 下面的情況算失敗，那一份不存任何檔，另一份照常：
   - 狀態不是 `200`（帶了條件的 `304` 除外）、連不上、超過 5 分鐘
   - 執行環境回報連線中斷
   - 收到的長度和回應的 `Content-Length` 不同
   - 內容是 0 個位元組
   - 內容超過 32 MiB（33,554,432 個位元組）。回應有 `Content-Length` 時看它，不讀內容；沒有時邊讀邊數，超過就停

**二、補索引。** 列出儲存桶裡 `crl/` 底下的清冊檔，讀 `crl/index.jsonl`；有檔案、索引裡沒有行的，一個一個讀出來：

1. 核對內容的 SHA-256 和檔名相同。
2. 讀清冊、驗章（[`src/crl.ts`](src/crl.ts)）：可不可用、原因代碼和它們的順序，和 Go 的 [`crl/`](../crl) 相同。簽章用兩把發證金鑰各試一次，哪一把驗得過，`issuer` 就是哪一把。
3. 可用的建樹（[`src/crl-tree.ts`](src/crl-tree.ts)），得到樹根。
4. 這個檔的行加進索引，整份索引重寫一次。
5. 把索引現在列著的最新清冊告訴證明紀錄的 Durable Object（第三步）。

所以：

- **可用不可用都存、都有一行。** 內政部的伺服器回一頁 HTML 的錯誤訊息，也會存起來，索引裡是 `-not_usable_der`。
- **索引裡已經有的檔不再讀、不再建樹。** 內政部沒有換清冊的那幾個小時，這一步只列一次儲存桶、讀一次索引，索引不重寫。
- **寫到一半失敗，下一輪補得回來。** 補的依據是儲存桶裡有什麼，不是這一輪抓到什麼：上一輪存了檔、還沒寫行就結束，這一輪補上那一行，內政部那時已經換了清冊也一樣。索引是一個物件，每次整份換掉，不會有人讀到半份。讀到的索引有寫法不合規格的行、重複的行、對不到檔案的行時，那些行不算數，從檔案重來。
- **一個檔拿不到行，只是那個檔的事。** 內容和檔名不符、讀不出來、建樹時 Barretenberg 出錯：那個檔記一行 `failed`，其他檔照做，Durable Object 照樣被告知，下一輪再試那個檔。這一次排程最後以例外結束。
- **這一輪抓到的檔先做，一定做。** 之前留下、還沒有行的檔接著做，照寫進儲存桶的時間，新的先做（過卡要用的是最新的清冊）；但這一輪開始補索引滿 2.5 分鐘之後就不再開始新的一份，留給下一輪。一輪假設自己拿得到 300,000 毫秒的 CPU 時間（`wrangler.jsonc` 的 `limits.cpu_ms` 設的數字；排程實際拿到的是不是這個數字還沒量到，見 [Cloudflare 上第一次建樹](#cloudflare-上第一次建樹)），留下的 2.5 分鐘給最後開始的那一份建樹：最大的一份（G2）在本機要 27 到 29 秒，留的是本機的 5 倍；Cloudflare 上量到的是四棵樹約 157 秒，不到本機的 2 倍。Worker 裡讀不到自己用了多少 CPU 時間，所以用牆上時間算；補索引這一段不是在算就是在等儲存桶，用掉的 CPU 時間不會比牆上時間多。**這個算法靠時鐘是新的，而 Cloudflare 上的時鐘只在 I/O 之後才前進**：程式在算的時候 `Date.now()` 停在上一次 I/O 的時間（[Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/)：「only advance or increment after I/O occurs」；[Security model](https://developers.cloudflare.com/workers/reference/security-model/)：「`Date.now()` returns the time of the last I/O. It does not advance during code execution」；2026-11-20 讀的）。一棵樹是幾十秒沒有 I/O 的計算，所以每次要不要再起一份之前，先對儲存桶問一次索引在不在（`head`），問完才讀時鐘（`src/mirror.ts` 的 `elapsedMs`）；前一份失敗、後面沒有任何 I/O 的時候也一樣。把讀時鐘挪到別的地方，這條界線在線上會無聲地失效，而本機的 workerd 時鐘照常前進（同一頁：「In local development, however, timers will increment regardless of whether I/O happens or not」），測試看不出來。整份索引不見時，要分好幾輪才補得完，每一輪寫的行都留著。
- **一輪做到一半被停掉，寫好的行留著。** 用完 CPU 時間的那一次呼叫會被 Cloudflare 停掉。索引每做完一個檔就寫一次、寫完就告訴 Durable Object，所以停在第二份的建樹時，第一份的行已經在索引裡、Durable Object 也知道；第二份的檔已經存著，之後的某一輪補它的行。這一輪抓到的兩份不看時間、一定做：兩份加起來超過一次呼叫的上限時，沒有哪一輪做得完，那是把鏡像搬出 Worker 的時候（ADR-0023）。
- **兩輪同時跑，不會蓋掉對方的行。** 索引用條件式寫入：只有儲存桶裡的索引還是這一輪讀到的那一份（照 ETag），或讀的時候沒有、現在也還沒有，才寫得進去（[R2 的條件式操作](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations)）。寫不進去就重讀索引、把自己的行加到新的那一份上再寫，最多試 5 次。Durable Object 那邊沒有同樣的保護：`setNewestCrls` 整份換掉、不比新舊，所以兩輪同時跑時，比較晚讀索引的那一輪第一次交，可能把 Durable Object 換回比較舊的兩份，到它下一次交（寫完下一行，或下一輪開始）才又是最新的。排程一小時一次、一輪不到一分鐘，兩輪重疊要有一輪跑超過一小時或被手動觸發。
- **讀一個檔花的時間和記憶體不超過它大小的線性倍數。** 清冊編號最多 20 個位元組、延伸欄位最多 16 個是規格的規定（[#120](https://github.com/iamreal-tw/iamreal/issues/120)）：超過的清冊不可用，讀的時候先看長度、只數個數，不轉成數字、不留下來。16 個以內的延伸欄位兩兩比有沒有重複。見[量到的](#清冊鏡像量到的)「故意做來拖時間的檔」。
- **不替每一筆廢止建物件**（[#26](https://github.com/iamreal-tw/iamreal/issues/26)）：在原始位元組上逐筆走，簽章驗得過之後再走一遍，每個序號的鍵直接寫進一個 `Uint32Array`，重複的序號和最低 127 位元相同的鍵用排序找。沒有簽章的檔不配置鍵的陣列。讀完之後檔案的位元組就放掉，建樹時只留著鍵。
- **建樹時讓出執行緒。** 樹切成最多 4,096 塊（樹根往下 12 層的子樹），每做完約 256 個鍵就等一次 `setTimeout(0)`，同一個實例裡等著的請求在這時候被處理。

**三、告訴證明紀錄的 Durable Object。** 從索引取每把發證金鑰最新兩份可用的清冊（照清冊編號，和裝置選清冊的方法相同；不可用的不算），把樹根、編號、清冊日期交給證明紀錄的 Durable Object，它整份換掉自己存的（[`src/proof-log.ts`](src/proof-log.ts) 的 `setNewestCrls`）。每一輪一開始讀完索引就交一次，不管有沒有新的清冊；之後每寫完一次索引再交一次，所以 G2 的新清冊不用等 G3 的樹建完。

要守住的只有一條：**鏡像交給 Durable Object 的樹根，交的那一刻已經列在儲存桶的索引裡。** 交出去的是從剛寫成功、或剛讀到的那一份索引算的。寫索引時丟例外的話，那次寫入可能其實做了，所以先重讀索引才決定交什麼；重讀也失敗，就在讀到之前都不交（[`test/mirror-invariant.test.ts`](test/mirror-invariant.test.ts) 用一個寫入會出錯的假儲存桶，在每一次交的當下核對）。

這一條講的是每一次交的當下，不是 Durable Object 任何時刻存著的東西：見下面「兩輪同時跑」。

```ts
interface KnownCrl {
  root: string;      // 樹根，64 個小寫十六進位數字，和紀錄的 smt_root 同一種寫法
  crlNumber: string; // 清冊編號，十進位
  crlDate: string;   // 清冊日期：thisUpdate 的台灣日期，YYYY-MM-DD
}
type NewestCrls = { G2: KnownCrl[]; G3: KnownCrl[] }; // 每把最多兩份，最新的在前
```

Durable Object 用 `newestCrls()` 讀出來。送出一筆時的兩個檢查（樹根是不是這兩份之一、最新那一份是不是太舊）用的就是它（見[送出一筆](#送出一筆)）。

只要有一份清冊沒抓到、有一個檔沒補上行、索引沒寫成、或沒交給 Durable Object，這一次排程就以例外結束，在 Cloudflare 的紀錄上是失敗的一次；做得到的部分照樣做完。

寫進資料儲存桶的每個物件都設 `Cache-Control`：資料網域的快取規則是「有就照它，沒有就不快取」。

| 物件 | `Cache-Control` | 理由 |
|---|---|---|
| `crl/<SHA-256>.crl` | `public, max-age=31536000, immutable` | 檔名就是內容的雜湊，內容不會變 |
| `crl/index.jsonl` | `public, max-age=60` | 內政部簽發新的清冊就會變 |

**鏡像在一個換得掉的介面後面**（ADR-0023）：`src/mirror.ts` 的 `CrlMirror`，只有一個方法 `round()`，回傳這一輪做了什麼、哪裡出錯，不丟例外。現在的實作 `crlMirrorInWorker` 全部在 Worker 裡做，要的東西（來源、儲存桶、發證金鑰、雜湊、兩個時間、告訴 Durable Object 的函式 `tell`）由 `src/index.ts` 交給它；超過 Workers 的限制時換掉它（例如在 Containers 跑 Go 的 `crl/`），`src/index.ts` 只改建立它的那幾行。

**有一種截斷在抓的時候擋不住。** 回應沒有 `Content-Length`（chunked）、連線在最後一塊之前斷掉時，本機的 workerd（1.20261110.1）不回報錯誤，收到的那一段看起來就是完整的回應，會被存起來。它不是內政部簽的清冊，索引裡是不可用的一行。回應有 `Content-Length`、連線提早斷掉時，本機的 workerd 既不報錯也不結束，所以是等到逾時才算失敗。這兩件事在 Cloudflare 上是不是一樣，還沒有在部署的環境看過。

排程寫的紀錄只在即時的輸出看得到（`wrangler tail` 或儀表板的即時紀錄），沒有開保存。每一份來源一行，每一個補上行的檔一行：

```
{"event":"crl_mirror","at":"2026-11-20T08:00:00.123Z","issuer":"G3","result":"stored","sha256":"…"}
{"event":"crl_index","at":"2026-11-20T08:00:00.123Z","result":"indexed","sha256":"…","issuer":"G3","crl_number":"2026112016","crl_date":"2026-11-20","root":"…","entries":178020,"keys":178020,"hashes":434659,"read_ms":113,"tree_ms":15657}
```

- `crl_mirror` 的 `result` 是 `stored`（新的一份）、`already_stored`（整份下載了，已經有）、`not_modified`（內政部回 `304`，沒有下載；`sha256` 是鏡像手上的那一份）、`failed`（附 `error`）。
- `crl_index` 的 `result` 是 `indexed` 或 `failed`（附 `error`）。`entries` 是廢止的筆數，`keys` 是樹裡的鍵數，`hashes` 是建樹算了幾次 Poseidon2；`read_ms` 是從儲存桶讀出來到驗完章，`tree_ms` 是建樹，都是毫秒。**`read_ms` 和 `tree_ms` 只有在本機是準的**：Cloudflare 上時鐘在計算時不前進（見上面「這一輪抓到的檔先做」），這兩個數字都是算完才讀時鐘，中間沒有 I/O，線上會偏小，可能是 0。線上用了多少 CPU 時間看儀表板的 Metrics。

### 和 Go 的 `crl/` 逐案比對

[`test/crl-testdata.test.ts`](test/crl-testdata.test.ts)，在 `pnpm test` 裡。每一份清冊當成假的內政部的回應，經過本機 workerd 裡的整個 Worker，看儲存桶裡的索引。

1. `crl/testdata/` 的 61 份自製清冊：每一份的可用不可用、原因代碼、樹根、編號、時間、清冊日期，和 `crl/testdata/expected.json`（Go、`web/`、`device-core/` 的測試讀的同一份）相同。包括清冊編號剛好 20 和 21 個位元組、清冊和一筆的延伸欄位剛好 16 和 17 個。
2. `crl/testdata/times/` 的 75 份（最後十六份不是時間：九份是延伸欄位的 OID，一個數字剛好是 2^31−1 和 2^31、不是最短寫法、沒寫完、空的，規格「Object identifiers」；七份是元素後面多了東西）：`thisUpdate`、`nextUpdate`、一筆的 `revocationDate` 用各種寫法（沒有秒的 UTCTime、帶時差、有小數、`Z` 後面還有字元、西元 0 年和 9999 年、不存在的日期……）。每一份在索引裡的那一行，和 `crl/testdata/times/expected.json` 寫的逐字相同；Go、`web/`、`device-core/` 的測試讀同一份。時間只收 RFC 5280 的兩種寫法（規格「Times」）：`Z` 結尾、有秒的 UTCTime 和 GeneralizedTime，其他寫法的檔是 `-not_usable_der`。線上的清冊每個時間都是 12 位數字加 `Z` 的 UTCTime。
3. 把儲存桶裡的清冊檔寫到一個目錄，跑 Go 的 `iamreal-crl index`，印出來的索引和儲存桶裡的 `crl/index.jsonl` 逐位元組相同。除了上面 136 份，還有 3 個不是清冊的檔和 1 份測試金鑰簽的清冊。**這一項要有 `go`，沒有就跳過；前兩項不用。**

2026-11-21 跑的結果（#120 之後，那時是 106 份）：三項都過，共 110 個檔，索引 110 行，沒有一行不同。

### 清冊鏡像量到的

2026-11-20，Apple Silicon。清冊是測試網站 2026-11-19 鏡像下來的兩份（[第一次部署量到的](#第一次部署量到的)那兩個 SHA-256），從 `test-data.iamreal.tw` 下載，沒有對內政部送請求。**本機的 workerd 不限 CPU 和記憶體，這些數字只說明量級；Cloudflare 上量到的在 [Cloudflare 上第一次建樹](#cloudflare-上第一次建樹)：30 秒的 CPU 時間不夠建完 G2 的樹，設成 300,000 毫秒之後一輪建四棵樹約 157 秒。**

本機的 workerd（1.20261110.1），整個 Worker，發證金鑰換成內政部的兩把，假的內政部送出那兩份檔，跑一次排程：

| | G2 | G3 |
|---|---|---|
| 大小 | 16,893,934 位元組 | 8,818,913 位元組 |
| 廢止的筆數、樹裡的鍵數 | 341,055 | 178,020 |
| 從儲存桶讀出來、算 SHA-256、讀清冊、驗章、排序 | 200 ms | 113 ms |
| 建樹 | 29.2 秒 | 15.7 秒 |
| Poseidon2 算了幾次 | 833,443 | 434,659 |
| 樹根 | `08aca62b…e1f9` | `04c63283…ffdd` |

- 整次排程 45.4 秒，幾乎都是 Poseidon2：每次約 35 µs，包含 msgpack 的編碼和解碼。`limits.cpu_ms` 設的 300,000 毫秒是這個數字的 6 倍多；沒有設的時候排程約 30 秒被停，比這個數字少。
- 兩個樹根和 Go 的 `iamreal-crl check` 對同一份檔案算的相同。
- 接著再跑一次排程（兩份都已經在索引裡）：48 ms。
- 建樹的時候每 100 ms 對同一個 Worker 送一個請求，共 314 個：往返的中位數 41 ms，第 95 百分位 64 ms，最久 339 ms。沒有鏡像在跑時是 2.6 ms。
- 在 Node 22 裡直接跑同一段程式，Poseidon2 每次約 30 µs，G2 建樹 25.7 秒、G3 13.5 秒。
- 審查後的修正（條件式寫入、每寫一次索引就告訴 Durable Object 一次）之後再跑一次：整次排程 42.5 秒，G2 建樹 27.5 秒、G3 14.4 秒，樹根相同；建樹時的請求往返中位數 38 ms。

記憶體，在 Node 22 裡量（workerd 裡量不到）。G2 那一份，和一份 Go 的 `crl/internal/crltest/makecrl` 做的同樣大小的自製清冊（16,937,158 位元組，342,152 筆），結果相同：

| | JavaScript 的記憶體（`heapUsed`） | `ArrayBuffer` |
|---|---|---|
| 讀完清冊（放掉檔案之前），沒有強制回收時看到的高點 | 25 MB | 30.5 MB：檔案 16.9 MB，加鍵的兩份陣列（排序前、排序後）各 6.5 MB |
| 讀完、檔案放掉、回收之後 | 8.6 MB | 6.5 MB：排序後的鍵 |
| 建完樹、回收之後 | 6 到 10 MB | 6.6 MB |

- 排序當下多一個 1.4 MB 的陣列，沒有取樣到，所以 `ArrayBuffer` 的高點約 32 MB。
- 自製的那一份在 JavaScript 的記憶體限制 24 MB（`--max-old-space-size=24`）下跑得完，樹根和 Go 算的相同。
- WASM 的線性記憶體另計，上限 16 MiB，建樹用到 2.5 MiB 上下（[#26](https://github.com/iamreal-tw/iamreal/issues/26)）。
- 抓和存的那一步，兩份清冊同時在記憶體裡，約 26 MB；補索引時一次只讀一份。兩份都剛好是上限 32 MiB 時，這一步是 64 MiB；沒有 `Content-Length` 的回應在接起來的那一刻多佔一倍。

**故意做來拖時間的檔。** 這種檔不需要簽章就會被存下來：內政部的網址是 `http://`，路上的人可以換掉回應；存下來之後，每一個重驗的人都要讀它。[#120](https://github.com/iamreal-tw/iamreal/issues/120) 之前，清冊編號沒有長度上限、延伸欄位沒有個數上限，第二輪審查 2026-11-20 在 Node 裡量到：清冊編號 1 MB 的檔讀一次記憶體的高點多 97 MiB，4 MB 多 339 MiB，32 MiB 多 2.7 GiB；280 萬個清冊層級延伸欄位的檔多 623 MiB；Go 讀 16 MB 的清冊編號要 44.4 秒。現在規格給了上限（[`spec/revocation-tree.md`](../spec/revocation-tree.md)「Which CRLs」）：清冊編號最多 20 個位元組，超過的先看長度就停，不轉成數字；清冊和每一筆的延伸欄位最多 16 個，超過的只數、不留。

照下載上限 32 MiB（33,554,432 個位元組）之內能造的最壞情況重量，每一種一個檔。檔案由 [`crl/internal/crltest/makelarge`](../crl/internal/crltest/makelarge) 寫（`go run ./crl/internal/crltest/makelarge -out DIR`），用一把當場產生、沒有人信任的金鑰簽，所以都是 `-not_usable_signature`。量法是 [`test/crl-size.ts`](test/crl-size.ts)（`node --experimental-strip-types test/crl-size.ts DIR [INDEX]`，不是 `pnpm test` 的一部分）：每個檔一個 Node 的程序，從讀檔前到 `readCrl` 回來，程序的最高常駐記憶體（`maxRSS`）多了多少。

2026-11-21，Node 22.23.4，Apple Silicon（M1 Max），同一份量兩次，數字差不到 10%，表裡是第一次的：

| 檔案 | 大小 | `readCrl` | 記憶體高點多用 | 其中檔案本身 |
|---|---|---|---|---|
| 清冊編號 1,000,000 個位元組 | 1,000,482 | 3 ms | 2.7 MiB | 1.0 MiB |
| 清冊編號 4,000,000 個位元組 | 4,000,482 | 4 ms | 6.4 MiB | 0.7 MiB |
| 清冊編號約 33,553,000 個位元組（上限之內最長） | 33,553,490 | 23 ms | 66.0 MiB | 32.1 MiB |
| 3,050,361 個不同的清冊層級延伸欄位 | 33,554,428 | 113 ms | 68.4 MiB | 32.1 MiB |
| 一筆帶 3,050,356 個不同的延伸欄位 | 33,554,423 | 112 ms | 68.0 MiB | 32.1 MiB |
| 1,677,697 筆廢止（一個位元組的序號，沒有延伸欄位） | 33,554,417 | 147 ms | 68.6 MiB | 32.1 MiB |
| 一筆的序號約 33,553,000 個位元組 | 33,553,505 | 23 ms | 66.0 MiB | 32.2 MiB |
| 發證者名稱約 33,553,000 個位元組 | 33,553,457 | 23 ms | 66.0 MiB | 32.1 MiB |
| 一個延伸欄位的 OID 約 3,355 萬節 | 33,553,505 | 90 ms | 66.1 MiB | 32.1 MiB |
| 16 個延伸欄位，其中 15 個的 OID 各約 224 萬節、只差最後一節 | 33,554,176 | 441 ms | 66.1 MiB | 32.2 MiB |
| 一個清冊延伸欄位，OID 後面 16,776,000 個 NULL（2026-11-26 加量的四個檔，[#410](https://github.com/iamreal-tw/iamreal/issues/410)；不是 DER） | 33,552,489 | 1 ms | 32.5 MiB | 32.2 MiB |
| 一筆廢止，日期後面 16,776,000 個 NULL（不是 DER） | 33,552,501 | 0 ms | 32.4 MiB | 32.1 MiB |
| `tbsCertList` 最後面 16,776,000 個 NULL（不是 DER） | 33,552,471 | 2 ms | 37.1 MiB | 36.8 MiB |
| 1,118,000 筆廢止，每筆一個延伸欄位 | 33,540,477 | 241 ms | 69.0 MiB | 32.1 MiB |
| 對照：線上的 G2（2026-11-21 05 時，340,633 筆，可用） | 16,873,034 | 229 ms | 59.3 MiB | 16.2 MiB |

- 小的檔「其中檔案本身」比檔案小：讀檔用到的是程序原本就有、還沒算進高點的記憶體。
- **記憶體的高點約是檔案的兩倍，不管內容是什麼。** 多出來的那一份是驗章：Node 的 `crypto.subtle.verify` 把要驗的內容複製一份（另外量過：驗一段 32 MiB 的內容，高點多 32.9 MiB），驗完放掉。鍵的陣列（每筆 20 個位元組，排序時再兩份）只在簽章驗得過之後才配置，所以沒有簽章的檔用不到它；上表最後一列可用的 G2 有。上限之內最大的檔，讀的這一步約 66 到 69 MiB，離每個實例的 128 MB（約 122 MiB）有約 50 MiB；實例本身另外用的（JavaScript 的程式、WASM 的 16 MiB 上限）沒有量進來。
- **時間和大小成線性。** 最慢的是 15 個長得幾乎一樣的 OID，0.44 秒（Spec 審查用 16 個各 1.9 MB 的量到 0.58 秒）：找重複的延伸欄位是兩兩比（最多 16 個，120 次），每一對都要比到最後一節，比的位元組總數最多是檔案大小的 15 倍左右。其次是 168 萬筆，0.15 秒。找重複不再用集合，也不替 OID 建字串。
- **其他沒有給上限的，和為什麼不用：** 筆數、序號的長度、發證者名稱的長度、OID 的長度，上表各有一列，都在檔案大小的兩倍之內；序號超過 20 個位元組的先看長度就不讀。巢狀沒有列：讀的程式只走固定的幾層（`CertificateList`、`tbsCertList`、每一筆、延伸欄位），發證者名稱和延伸欄位的內容不往下讀（清冊編號除外，它是一個 INTEGER），所以裡面巢狀再深也只是一段位元組。
- **Go 的 `iamreal-crl index` 對這 10 個檔寫出的索引，和 `test/crl-size.ts` 用 `src/crl-index.ts` 寫的逐位元組相同。** Go 讀完 10 個檔共 1.5 秒，程序的最高常駐記憶體 702 MB：Go 的 `crl.Parse` 把 OID 的每一節存成一個 `int`，每一筆存成一個結構。Go 的程式是重驗的人在自己的電腦上跑的，不在 Worker 裡。
- **數字只說明量級。** 是在 Node 裡量的，不是在 workerd 裡；本機的 workerd 不限記憶體，量不到。workerd 的 `crypto.subtle.verify` 會不會也複製一份沒有查。Cloudflare 上超過記憶體上限時實際會怎樣也沒有試過。
- **這種檔不再讓每一輪停在它。** 它照樣存進儲存桶、照樣有一行（`-not_usable_signature` 或更前面的原因），之後每一輪讀到它的時間和記憶體都在上表之內，排在它後面的檔照常補。索引的那一行不會變長：超過 20 個位元組的清冊編號寫 `-`。

**部署之後要看的**（第一項有答案了，其餘還沒有）：

- Cloudflare 上一次排程真的 CPU 時間：看儀表板的 Metrics。`wrangler tail` 的 `crl_index` 那幾行的 `tree_ms` 在線上不可靠（時鐘在計算時不前進，見「排程做什麼」），不能拿來當建樹的時間。第一次只知道超過 30 秒；`limits.cpu_ms` 設成 300,000 之後的第一輪約 157 秒，建了四棵樹（[Cloudflare 上第一次建樹](#cloudflare-上第一次建樹)）
- 18 MB（gzip 後 4 MB）的一包上傳得上去、啟動得了
- 編好的 WASM 機器碼算不算進每個實例 128 MB 的記憶體上限。Cloudflare 的文件寫的是「Each isolate can consume up to 128 MB of memory, including the JavaScript heap and WebAssembly allocations」（[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)，2026-11-20 讀的），沒有講機器碼
- 第一次排程要補的檔：儲存桶裡從 2026-11-19 起每小時鏡像下來的清冊都還沒有行，有幾份沒有查過。一輪補不完時分幾輪補，補齊之前索引只列一部分

### Cloudflare 上第一次建樹

2026-11-20，時間都是 UTC（[#128](https://github.com/iamreal-tw/iamreal/issues/128)）。

- 04:12 部署了會驗章、建樹的鏡像。05:00 的排程在 05:00:25 把 `crl/index.jsonl` 寫成空檔（`200`、0 個位元組），之後索引沒有再變：一行都沒有寫出來。
- Cloudflare 儀表板上 `iamreal-test` 的 Metrics，「Errors by invocation status」：Exceeded CPU Time Limits 1 次，Exceeded Memory、Uncaught Exception、Internal 都是 0。那一次的 CPU 時間約 32 秒，牆上時間約 47 秒，記憶體高點約 50 MB。
- 那時 `wrangler.jsonc` 沒有 `limits`，儀表板上這個 Worker 的 CPU Time Limit 是空的。
- Workers Logs 沒有開，所以看不到 `crl_mirror`、`crl_index` 那幾行。

原因和 Cloudflare 文件寫的對得上的部分：付費方案每次呼叫的 CPU 時間預設 30 秒，用 `limits.cpu_ms` 最多調到 300,000 毫秒（[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)「CPU time」，2026-11-20 讀的）。G2 那一棵樹在本機要 27 到 29 秒，一份檔要建完樹才有索引的那一行，所以 30 秒內連這一輪抓到的第一份都做不完。

對不上的部分：同一頁的 CPU 表寫間隔一小時以上的排程有 15 分鐘的 CPU 時間；這裡每小時一次的排程是約 32 秒就被停。同一頁另外兩處的 15 分鐘（「Duration」、「Wall time limits by invocation type」）講的是排程一次的牆上時間。

之後的做法：`limits.cpu_ms` 設成 300,000（[設定檔](#設定檔)）；一輪補之前留下的檔時，留 2.5 分鐘給最大的一份（[排程做什麼](#排程做什麼)）。

**設了 `limits.cpu_ms` 之後的第一輪**（06:06 部署，07:00 的排程）：

- 索引在 07:01:43 有兩行（這一輪抓到的 G2、G3，清冊編號都是 `2026112010`），07:03:08 有四行（補了之前留下的兩份，編號 `2026112005`）。之後照 2.5 分鐘的界線停下來，剩下的留給後面幾輪。
- 儀表板 Metrics 上那一次：CPU 時間約 157 秒，牆上時間約 176 秒（圖上的數字只到千毫秒），沒有 Exceeded CPU Time Limits。「Errors by invocation status」過去 24 小時的 Exceeded CPU Time Limits 共 2 次，是 05:00 和 06:00 那兩輪，都在這次部署之前。
- 四棵樹（G2、G3 各兩份）約 157 秒，一對約 78 秒，是本機（42 到 45 秒）的不到 2 倍。單獨一棵樹在線上要多久沒有量到。
- 四行的樹根和 Go 的 `iamreal-crl check` 對同一份檔（從 `test-data.iamreal.tw/crl/<sha256>.crl` 下載，SHA-256 和索引的相同）算的相同。

**還沒量的**：每小時的排程拿到的上限是設的 300,000 毫秒，還是那張表寫的 15 分鐘（這一輪用了約 157 秒，兩個都沒碰到）。一輪用掉的 CPU 時間接近 5 分鐘時，另外開票（建樹跨輪接續，或把鏡像搬出 Worker）。

### 內政部看得到什麼

- `User-Agent` 是一般的 `Mozilla/5.0 (compatible)`，不帶專案名稱。
- `If-None-Match` 或 `If-Modified-Since`：值是內政部自己上一次回的 `ETag` 或 `Last-Modified`（[排程做什麼](#排程做什麼)）。
- Cloudflare 會在 Worker 送出的每個請求加上 `CF-Worker` 標頭，值是這個 Worker 所在 zone 的名稱（[Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)），照這份文件會是 `iamreal.tw`；沒有實際看過送到內政部的請求。這一項不是程式決定的；營運者知道並接受，`CONTRIBUTING.md`「工作時對外的請求」把它列為例外。本機的 workerd 會模仿它，值是 Worker 的名稱加 `.example.com`。

## 測試的工具

[`test/harness.ts`](test/harness.ts) 的 `startWorker()`：打出測試專用的建置，在本機的 workerd 啟動整個 Worker（用 wrangler 的 `createTestHarness`），旁邊開一個假的內政部。之後每一張後台的票都用它。

| 測試要做的事 | 用法 |
|---|---|
| 送 HTTP 請求 | `worker.fetch("/路徑")`，或對 `worker.url` 用一般的 `fetch` |
| 觸發排程 | `worker.runSchedule()`，回傳 `outcome`（`ok` 或 `exception`） |
| 讀 R2 的模擬裡寫出來的檔案 | `worker.files("crl/")`：檔名、內容、`Cache-Control`、寫入時間 |
| 調時鐘 | `worker.setClock(new Date("…"))` |
| 假的內政部 | `worker.moica.serve("G2", 位元組)`、`.fail("G3", 503)`、`.cutOff(…)`（送到一半斷線）、`.stall(…)`（不回應或送到一半停住）、`.requests` |
| 縮短等內政部的上限 | `startWorker({ crlTimeoutMs: 1500 })`，預設 2 秒 |
| Worker 寫的紀錄 | `worker.logLines()` |
| 驗一份證明 | `worker.verify(電路名稱, 證明, 公開輸入)`，回 `true` 或 `false` |
| 做一份測試金鑰簽的清冊 | [`test/crls.ts`](test/crls.ts) 的 `makeCrl({ issuer, number, thisUpdate, serials })`，交給 `worker.moica.serve` |
| 證明紀錄的 Durable Object 知道的最新清冊 | `worker.newestCrls()` |
| 把儲存桶弄成上一輪做到一半的樣子 | `worker.putFile(檔名, 內容)`、`worker.deleteFile(檔名)`；`worker.putFile(檔名, 內容, Cache-Control, Content-Type)` 連標頭一起放 |
| 假的內政部不帶 `Content-Length` | `worker.moica.serve("G2", 位元組, "chunked")` |
| 改一輪補舊檔的界線 | `startWorker({ crlCatchUpMs: 0 })`，預設是部署的 2.5 分鐘 |
| 重啟整個 Worker（連同 Durable Object） | `worker.restart()`：儲存的東西和儲存桶的檔案留著，記憶體裡的（包括調過的時鐘）不見 |
| 換發證金鑰 | `startWorker({ issuers: [G2, G3] })`，預設是測試自己的兩把 |
| 重啟證明紀錄的 Durable Object | `worker.proofLog.restart()`：記憶體裡的東西丟掉，存著的留著 |
| 清空測試的證明紀錄之後，被換掉的那個物件 | `worker.clearedProofLog(原本的名稱)`：`.restart()` 讓它重新啟動（部署會做的事），`.runAlarm()` 讓它的 alarm 響，`.hasAlarm()` 看它還有沒有設 alarm。`worker.proofLog` 的每一項問的都是設定現在指的那個物件 |
| 跑 Durable Object 的 alarm、看它設在多久之後 | `worker.proofLog.runAlarm()`、`worker.proofLog.alarmInMs()` |
| 要一個題目 | `worker.issueChallenge()`；`worker.issueChallenge(十六進位的 16 個位元組)` 指定題目的亂數那一段 |
| 換 `records` 用的驗證器 | `worker.setVerifier("stand-in")`、`("real")` |
| 送出一筆、看卡片現況、發一份清冊、換一份空的證明紀錄 | [`test/records.ts`](test/records.ts) 的 `sub`、`submit`、`mustSubmit`、`wantError`、`cardState`、`publishCrl`、`day`、`freshProofLog` |
| 寫卡片狀態表的一列 | `worker.proofLog.writeCard({…})`，寫法和 `card-state` 的回應相同。只用在紀錄規則不會留下的狀態（壞掉的、少了某個平台的名額的）和那些壞掉的案例的起點；其他規則會留下的狀態用 `sub`、`mustSubmit` 真的送出 |
| 後台還認得哪些題目 | `worker.proofLog.knownChallenges()`：問 `records`，回 `challenge_unknown` 的就是不認得。問一次算一次送出 |
| 讓某一張表的寫入失敗 | `worker.proofLog.failWritesTo("cards")`，`(null)` 恢復 |
| 把存著的規則版本改成另一個數字、改回來 | `worker.proofLog.setStoredRulesVersion("another")`、`("the build's")`，之後 `worker.proofLog.restart()` |
| 對存著的狀態跑一筆標準答案的事件 | `worker.proofLog.applyRuleEvent(事件)` |
| 讀證明紀錄裡最晚的有效日期、每個帳號底下的卡片數 | `worker.proofLog.ruleState(場合字串, 匿名編號)` |
| 讓後台自己出錯 | `worker.proofLog.breakTables()` |
| 把一張卡片存著的名額弄壞 | `worker.proofLog.breakCard(匿名編號)`：改成不是 JSON 的字，讀到那一列的都會丟例外；`worker.proofLog.mendCard(匿名編號)` 改回原樣 |
| 讀存著的紀錄和證明紀錄那一列、照規格重算整份證明紀錄 | `worker.proofLog.stored()` 讀出物件裡還留著的；`test/records.ts` 的 `checkProofLog(worker)` 連同 R2 裡寫滿的紀錄檔和雜湊清單，重算每一行、紀錄雜湊、指紋，回傳每一筆紀錄 |
| 讓搬紀錄檔的某一步出錯 | `worker.proofLog.setBucketFault({ key, how })`，`(null)` 恢復；`how` 是 `put fails`、`put sends other bytes`（送給儲存桶的位元組少一個，SHA-256 照原樣帶）、`put writes other bytes`（儲存桶存下的位元組少一個）、`put writes another Cache-Control`、`put writes another Content-Type`、`put loses its answer`、`put takes a while`（等 600 毫秒才寫，這段時間物件照常收別的請求）、`get fails`。記在記憶體裡，物件重啟就沒有了 |
| 物件裡還留著幾筆紀錄、從哪一筆到哪一筆 | `worker.proofLog.kept()`。`stored()` 把每一行都傳回來，一行約 20 KB，留著約 1,600 筆以上時拿不到。Cloudflare 的文件寫呼叫物件方法的上限是「The maximum serialized RPC limit is 32 MiB.」（[Workers RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/)「Limitations」，2026-11-20 讀的），沒有寫算的是送過去的、回傳的，還是兩者；回傳的超過就回 `500` 是在本機的 workerd 上看到的（1,500 筆、30 MB 回得來，1,700 筆是 `500`），Cloudflare 上沒有確認。物件裡卡著兩檔以上時用 `kept()` |
| 等衍生表從 R2 重建完 | `worker.proofLog.viewsFilled()` |
| 頁面的每個讀取跑的每一句 SQL 和它的查詢計畫 | `worker.proofLog.pagePlans({ platform, short_id, username, after })`：照頁面和送出一筆那樣呼叫部署的物件的讀取（首頁的兩個數字、島民證明、查詢頁、證明紀錄頁從最新的和 `after` 之後、數一個帳號底下的卡片），每一句先問 `EXPLAIN QUERY PLAN`，回傳哪個讀取、那一句、計畫的每一行 |
| 讓同時送出的請求真的交錯 | `worker.proofLog.setHashDelay(毫秒)`：算紀錄雜湊之前先等；`worker.proofLog.hashes()` 是算過幾次 |
| 驗證花了時間的證明 | `test/records.ts` 的 `SLOW_PROOF`（替身驗證器）：通過，但時鐘往後 1 毫秒 |
| 把存著的表的版本改成另一個數字、改回來 | `worker.proofLog.setStoredSchemaVersion("another")`、`("the build's")`，之後 `worker.proofLog.restart()` |
| 多塞一件定時的工作、看它什麼時候跑過 | `worker.proofLog.setExtraWork(到期的時間, 間隔)`、`worker.proofLog.extraWorkRuns()` |
| 換掉環境的設定 | `startWorker({ settings: { PROOF_LOG_KIND: "production", PROOF_LOG_OBJECT_NAME: "…" } })`，或啟動後 `worker.setSettings({…})`；已經在跑的 Durable Object 要 `worker.proofLog.restart()` 才讀到新的 |
| 換成另一個物件的證明紀錄，照部署做的那樣 | `worker.switchProofLog({…})`：`setSettings` 之後，原本的物件（和之前的 `setSettings` 換掉、還沒重新啟動過的）重新啟動、讓它的 alarm 響一次，它就知道自己被換掉，之後不再設 alarm。`freshProofLog` 用這個，而且先換物件才清空儲存桶。換成物件啟動不了的設定（Worker 回 `500`）時，原本的物件只停掉，等下一次換成啟動得了的設定時才重新啟動 |
| 比對「接下來只多這幾行紀錄」之前，確認 alarm 不會在中間響 | `test/records.ts` 的 `wantNoAlarmSoon(worker)`：alarm 沒設，或在 30 秒以後 |

**測試裡證明紀錄也會自己公布。** 測試把時鐘撥到隔天之後，只要有任何請求讓物件重設 alarm（例如拿題目），alarm 約 1 秒後就會自己響、公布當天的證明紀錄（[每天換日公布證明紀錄](#每天換日公布證明紀錄)），不必等測試去跑 alarm。所以跨日的測試不要斷言 `proof-log/` 底下恰好有哪些檔、或指紋檔恰好幾行，除非它自己控制公布（撥時鐘之後馬上 `runAlarm()`）。同樣的，比對一段時間內寫的全部紀錄行時，那段時間裡 alarm 不能響：它公布、刪過期的題目，失敗時多寫一行，處理函式執行的那段時間 `alarmInMs()` 讀到 `null`（[#232](https://github.com/iamreal-tw/iamreal/issues/232)、[#255](https://github.com/iamreal-tw/iamreal/issues/255)）。要比對前先 `wantNoAlarmSoon(worker)`。`test/pages.ts` 的 `pagesWorld` 最後跑一次 alarm，把到「今天」為止該做的公布和刪題目做完，下一次到期至少在 10 分鐘以後（有一筆是「今天」的話，是刪那個題目；沒有的話是隔天的公布）。

**前一個測試的物件也可能公布。**只用 `setSettings` 換物件的名稱時，原本的物件還在記憶體裡，用它啟動時的設定，仍然以為自己是證明紀錄的物件，alarm 一響就把它的證明紀錄公布到新的證明紀錄用的儲存桶（`fingerprint_file_differs` 就是這樣來的）。Cloudflare 上換名稱要部署，物件下一次啟動就讀到新的設定：沒在跑的物件下一次被叫醒時，還在跑的最晚 5 分鐘後（[Durable Objects code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/)：「By default, Durable Objects defer code updates for up to 300 seconds (5 minutes).」「If the object is still active when `max_delay` is reached, it resets and adopts the new code.」，2026-11-23 讀的）。本機的 workerd 不會讓物件休眠（[過期的題目怎麼刪](#過期的題目怎麼刪)的「失敗後多久再試」最後一句），沒有人讓它重新啟動，它就一直用舊的設定。所以測試要換物件時用 `switchProofLog`。測試專用建置的 alarm 一次只跑一個：`runAlarm()` 和物件自己響的那一次排隊做，不會同時跑（`test-build/index.ts` 覆寫了 `alarm()`）。部署的程式沒有這個排隊，靠的是一個物件的 alarm 本來就不會同時跑兩個（[每天換日公布證明紀錄](#每天換日公布證明紀錄)「什麼時候公布」最後一條引了文件的那一句）、定時的工作一件做完才做下一件。

測試不對內政部送請求。測試用 Node 內建的 test runner，和 `protocol/`、`web/` 相同。

## 型別檢查

Workers 執行環境的型別（`R2Bucket`、`DurableObject`……）和 `Env` 由 `wrangler types` 從設定檔和本機的 workerd 產生，寫到 `worker-configuration.d.ts`；這個檔不進版控，`pnpm typecheck` 每次重新產生。沒有另外裝型別的套件。

型別檢查分兩份設定，因為兩邊的全域型別不同：

- `tsconfig.json`：在 Worker 裡執行的程式（`src/`、`test-build/`），用上面產生的型別，沒有 Node 也沒有 DOM 的型別
- `test/tsconfig.json`：在 Node 裡執行的測試和指令（`test/`、`scripts/`）。它另外帶 DOM 的型別：測試在 Node 裡直接載入 WASM 檔（`test/poseidon2.test.ts`），`WebAssembly` 的型別在那裡

## 部署測試環境

```sh
pnpm run deploy:test
```

部署分三段，本機和 GitHub Actions 走同一段程式（[`scripts/deploy.ts`](scripts/deploy.ts)）：

1. **過卡的頁面**（`buildSite`）：核對通用參數（沒有就下載），把 `web/` 測試網站的建置做到 `site/proof/`，檢查它（[Static Assets](#static-assets)）。不帶權杖；下載通用參數是唯一可能送出的請求。
2. **打包**（`buildDeploy`）：先核對 WASM 檔和驗證金鑰的 SHA-256（[WASM 檔和驗證金鑰從哪裡來](#wasm-檔和驗證金鑰從哪裡來)），不對就停；再用 `wrangler deploy --dry-run --outdir <目錄>` 打包，不帶權杖；最後跑部署那一包的檢查（[三樣不是設定值的東西](#三樣不是設定值的東西)）；其中核對 `limits.cpu_ms` 的那一項不是起 wrangler 的指令，是在跑檢查的這個程序裡用 wrangler 的函式庫讀 `wrangler.jsonc`。打包唯一的入口是 `bundleWorker`，測試專用的建置也經過它：打包之前要做的事只寫在那裡。
3. **上傳**（`uploadArgs`）：`wrangler deploy <目錄>/index.js --no-bundle`，把那一包程式原樣上傳，旁邊的 WASM 檔和驗證金鑰照 wrangler 的副檔名規則一起帶上（`test/bundle.test.ts` 用 `--dry-run` 確認），binding 照 `wrangler.jsonc`。只有這一段的 wrangler 指令帶權杖。
   **Static Assets 的檔案不在那一包裡**：wrangler 上傳時照 `wrangler.jsonc` 的 `assets.directory` 讀工作目錄裡的 `site/`，一起上傳。在 GitHub Actions 上，那是 `deploy` 工作自己 checkout 出來的 `worker/site/`（版控裡的 `pages.css`、`copy.js`、`favicon.ico`、`fonts/`、`og-image.png`、`_headers`、`_redirects`），加上 `build` 工作交出來的過卡頁面（artifact `proof-page`，下載到 `worker/site/proof/`）。兩個工作 checkout 的是同一個 commit；`build` 工作的檢查核對過那個 commit 的 `_headers`、`_redirects` 和設定（`checkSiteFiles`）、它交出去的頁面（`checkProofPages`），`pages.css`、`copy.js` 和 `favicon.ico` 是那個 commit 裡的那一份、字型和 `design/fonts/` 相同，也核對過。

打包和上傳這兩段的 wrangler 指令共用的參數：

- `--config wrangler.jsonc`：只讀這個設定檔，不會被 `.wrangler/deploy/config.json` 轉到別的檔。
- `--env test`：環境固定是測試環境。
- `--experimental-provision=false`：wrangler 不問 Cloudflare 儲存桶在不在；為什麼要帶，見[下一節](#第一次部署量到的)。
- `--env-file=/dev/null`：wrangler 4.160.1 啟動時會把工作目錄的 `.env`、`.env.local`、`.env.test`、`.env.test.local` 讀進自己的環境變數，除非 `--env-file` 指定別的檔（`wrangler-dist/cli.js`：`args["env-file"] ?? getDefaultEnvFiles(args.env)`，再交給 `loadDotEnv`）。這樣的檔可以設 `CLOUDFLARE_API_BASE_URL`，把權杖送到別的主機（用假權杖和本機監聽的伺服器試過，請求帶著 `Authorization: Bearer <權杖>` 送到了那裡）。指到 `/dev/null` 就一個也不讀（`test/deploy.test.ts`）。

本機：[`scripts/deploy-test.ts`](scripts/deploy-test.ts) 先建置頁面、打包到暫存目錄、跑完檢查，才讀程式庫根目錄的 `.env.local` 裡的兩行，`CLOUDFLARE_API_TOKEN_TEST` 和 `CLOUDFLARE_ACCOUNT_ID`，再上傳。那把權杖只能部署 `iamreal-test`（ADR-0029）。不用 `wrangler login`。shell 裡原有的 `CLOUDFLARE_*`、`CF_*`、`WRANGLER_*` 變數都不會傳給 wrangler 的指令（打包和上傳各起一個子程序，環境是濾過的），所以別的權杖或別的 API 網址不會被用到。這句話只對子程序成立：檢查裡讀設定檔的那一步在 `deploy-test.ts` 自己的程序裡用 wrangler 的函式庫做，那個程序的環境就是 shell 的；它只讀 `wrangler.jsonc`、不送請求，而且在讀 `.env.local` 之前就做完，權杖讀進來之後只放在交給上傳那個子程序的環境裡，不放進這個程序自己的環境變數。唯一接受的參數是 `--dry-run`：三段都做，不上傳。正式環境只從 GitHub Actions 部署，這裡沒有它的指令。

### 從 GitHub Actions 部署

合併到 `main` 時，[`.github/workflows/deploy-test.yml`](../.github/workflows/deploy-test.yml) 部署測試環境（ADR-0029）。兩個工作：

1. `build`：沒有權杖。跑 [`scripts/build-deploy.ts`](scripts/build-deploy.ts)，就是上面的第 1 段和第 2 段：下載通用參數並核對 SHA-256（從 Aztec 的 CDN，`web/README.md`）、建置並檢查過卡的頁面、打包並檢查 Worker，交成兩個 artifact（`worker-build`、`proof-page`）。
2. `deploy`：在 `build` 之後。依序：裝 Node、用 npm 從 `https://registry.npmjs.org/` 裝 pnpm（這時還沒 checkout，程式庫裡的 `.npmrc` 不在）、checkout、用 pnpm 照 lockfile 裝 `worker/` 的套件（`--ignore-scripts`：不跑任何安裝腳本；`--ignore-pnpmfile`：不跑 `.pnpmfile.cjs`，`--ignore-scripts` 擋不住它，pnpm 10.16.1 試過；`--registry`：不照 `.npmrc` 換來源）、拿回那兩包（頁面放到 `worker/site/proof/`），最後一步上傳。之前沒有一步跑這個程式庫的程式。

權杖只在最後一步的環境裡：程式庫的 Actions secrets `CLOUDFLARE_API_TOKEN_TEST`、`CLOUDFLARE_ACCOUNT_ID`，交給 wrangler 時的名稱是 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。

**上傳的那一步還信任的東西**（改到它們的 PR 要逐行看，`CONTRIBUTING.md`「部署會執行到的東西」）：

- 釘在 commit 上的五個 action（清單在 [`test/workflows.ts`](test/workflows.ts) 的 `ACTIONS`）
- npm 上的 pnpm 10.16.1：沒有核對雜湊
- `pnpm-lock.yaml` 裡的套件，包括 wrangler：pnpm 核對 lockfile 記的雜湊，所以換來源換不了內容，但 lockfile 本身就是提交的一部分
- `pnpm-workspace.yaml`：安裝時一定會讀，設定能改裝進來的套件（例如 `patchedDependencies` 加一個 `patches/` 的修補，在 `--ignore-scripts --ignore-pnpmfile` 之下照樣套到 wrangler 上，試過）。`test/workflows.test.ts` 確認它只有現在的三個鍵、lockfile 沒有 `patchedDependencies` 這類段落、程式庫沒有追蹤 `.npmrc`、`.pnpmfile.cjs`、`patches/`、`worker/` 底下的 `.env*`
- `worker/site/`：Static Assets 的檔案。`pages.css`、`copy.js`、`demo.js`、`favicon.ico`、`fonts/`、`og-image.png`、`_headers`、`_redirects` 不在 `build` 工作交出來的東西裡，是 `deploy` 工作從自己的 checkout 上傳的；`_headers` 和 `_redirects` 決定這些檔案帶什麼標頭、哪些網址轉到哪裡。`build` 工作的檢查核對過同一個 commit 的這八個檔（`checkSiteFiles`）。`proof/` 底下的過卡頁面是 `build` 工作建置、檢查過再交過來的（`checkProofPages`）
- `build` 工作建置過卡頁面時用到的東西，它們決定持卡人在測試網站拿到的頁面：`web/` 和 `protocol/` 的程式、`design/copy/`、lockfile 裡 `web/` 的套件（Vite、bb.js、noir_js），和 `web/scripts/fetch-crs.mjs` 從 Aztec 的 CDN 下載的通用參數（核對 SHA-256）。`build` 工作沒有權杖；它交出去的頁面由部署前的檢查看過幾種已知的錯法，看不到頁面的程式做了什麼
- `wrangler.jsonc`：上傳時 wrangler 讀它。它不能有 `build.command`：wrangler 在上傳之前會執行它，加了 `--no-bundle` 也一樣（Cloudflare 的文件寫它「will be run as part of `wrangler dev` and `npx wrangler deploy`」，[custom builds](https://developers.cloudflare.com/workers/wrangler/custom-builds/)；wrangler 4.160.1 的 `getEntry`（`src/deployment-bundle/entry.ts`）不看 `--no-bundle` 就呼叫 `runCustomBuild`；用 `--no-bundle --dry-run` 試過，指令跑了）。`test/workflows.test.ts` 檢查設定檔沒有它

[`test/workflows.ts`](test/workflows.ts) 是工作流程的白名單：`deploy-test.yml` 的兩個工作必須逐字是那裡寫的（上傳那一行由 `uploadArgs` 組出來），PR 的四個檢查工作流程 `checks.yml`、`checks-browser.yml`、`checks-ios.yml`、`checks-circuits.yml` 的每個鍵、action、`with`、`env`、`working-directory` 都要在清單裡，觸發條件逐字照寫（`paths` 只准在 `checks-browser.yml`、`checks-ios.yml`、`checks-circuits.yml`，內容逐字等於 `BROWSER_PATHS`、`IOS_PATHS`、`CIRCUITS_PATHS`；`merge_group` 只准在 `checks.yml`），`checks-ios.yml` 的 runner 和 Xcode 逐字是 `IOS_RUNNER`、`IOS_DEVELOPER_DIR`，`checks-circuits.yml` 唯一的工作逐字是 `CIRCUITS_JOB_STEPS`，`concurrency` 的群組各自不同，`checks.yml` 的工作恰好是 `main` 的 ruleset 要求的四個必要檢查 `go`、`typescript`、`device-core`、`android`（`REQUIRED_CHECKS`），而且都不設 `name`：必要檢查照工作的名稱比對，改了 id 或設了 `name`，合併佇列就等不到它要的檢查（#180，`.github/README.md`「合併佇列」），每個工作流程最上面的 `cache-mode` 逐字照寫（`cache.yml` 是 `write`，`checks.yml` 是 `read`，其他和新的工作流程是 `none`），工作層級不准設；存快取的 `cache.yml` 只在推到 `main` 時觸發、工作逐字是那裡寫的（#203，`.github/README.md`「快取」），整個 `.github/workflows/` 有 `secrets` 這個字的行（註解也算）恰好是上傳那一步的兩行。檔案用一個只讀 YAML 一小部分的讀法讀，那部分以外的寫法都算問題；檔裡只准可列印的 ASCII 和換行，註解也一樣，空白只認 ASCII 的空格（不然 U+00A0 這類空白開頭、接著 `#` 的一行，這裡當成註解，libyaml 這類照 YAML 規格只認 ASCII 空白的解析器卻會把它接到上一行的值後面，折進 `run`（#39 第二輪審查用 libyaml 實測））。它防手誤和明顯的改動，不能代替逐行看；它看不到什麼，寫在那個檔的開頭。

## 第一次部署量到的

2026-11-19，從營運者的電腦用 `.env.local` 那把只有 `iamreal-test` 的 `Editor` 的權杖部署（wrangler 4.160.1），版本 `12ae49e5-228c-4122-b1e7-335e47392499`。時間都是 UTC。經過記在 [#63](https://github.com/iamreal-tw/iamreal/issues/63)。這一節是 [#26](https://github.com/iamreal-tw/iamreal/issues/26) 和 ADR-0029 留下「部署時確認」的那兩件事的出處。

### 只有 `Editor` 權限的權杖也跑得了 Durable Object 的 migration

14:30 的部署上傳了帶 migration `v1`（`new_sqlite_classes: ["Proof log"]`）的 Worker，沒有用別的權杖。部署後用同一把權杖讀 Worker 的設定（`GET …/workers/scripts/iamreal-test/settings`），`PROOF_LOG` 這個 binding 帶著 Durable Object 的 `namespace_id`。只看過建立類別的這一種 migration；改名、刪除類別的沒有試過。

這把權杖做得到和做不到的：

| 做的事 | 結果 |
|---|---|
| 上傳 Worker，連同 Durable Object 的 migration | 做得到 |
| 設排程 `0 * * * *` | 做得到 |
| `workers_dev: false`、`preview_urls: false` | 做得到。部署後用同一把權杖 `GET …/workers/scripts/iamreal-test/subdomain`，回 `enabled: false`、`previews_enabled: false` |
| `wrangler tail --env test`，讀即時的紀錄 | 做得到 |
| 讀 R2 儲存桶的資料（`GET …/r2/buckets/iamreal-test-data`，wrangler 部署時自己送的） | 做不到：`Authentication error [code: 10000]`。wrangler 寫在本機的紀錄檔記這個回應是 `Unauthorized 401` |
| 列出帳號的 Durable Object namespace（`GET …/workers/durable_objects/namespaces`）、列出自訂網域（`GET …/workers/domains`） | 做不到：部署後用同一把權杖各送一次，都回 `403` 和同一個錯誤代碼 |

**第一次試沒有部署成功。** 14:29 跑 `pnpm run deploy:test`，那時它給 wrangler 的參數是 `deploy --env test`。wrangler 在上傳之前問 Cloudflare 儲存桶 `iamreal-test-data` 在不在（它會自動建不存在的資源），權杖讀不了 R2，wrangler 就停在這裡，什麼都沒上傳：

```
✘ [ERROR] A request to the Cloudflare API (/accounts/<帳號編號>/r2/buckets/iamreal-test-data) failed.

  Authentication error [code: 10000]
```

指令加上 `--experimental-provision=false` 之後 wrangler 不問這一題，部署成功。權杖沒有換，也沒有加權限。

關於這個參數：

- 它是 wrangler 4.160.1 的隱藏參數，每個指令都收，`wrangler deploy --help` 不列；預設是 `true`，別名 `x-provision`。升級 wrangler 時要確認它還在。
- 設成 `false` 只是跳過「資源在不在、要不要建」那一步，上傳的內容不變。
- 什麼時候非帶不可：Worker 上還沒有這個 binding 的時候，也就是第一次部署和之後新增 binding。照 wrangler 的程式讀，已部署的 Worker 上有同名、同 `bucket_name` 的 binding 時它不會去問 R2，所以之後不帶應該也過；這一點沒有試過。
- 儲存桶是營運者在儀表板建的（ADR-0029），部署不該建任何資源，所以指令一律帶著。

部署沒有動到儀表板上設的自訂網域。從本機 `curl` `https://test.iamreal.tw/`：部署前（14:29）回 `200`、`content-length: 12`，是部署前就在那個 Worker 上的程式；部署後（14:30）每個網址都回 `404`、沒有內容，就是骨架那時的行為。

部署時 wrangler 印一則警告：設定檔最上層沒有 `name`。那是故意的（見「設定檔」）；有警告時 wrangler 會問 npm 有沒有新版（見「套件」）。

### 從 Cloudflare 抓得到內政部的兩個清冊網址

排程第一次在 Cloudflare 上跑，是 15:00 那一次：排定的時間 15:00:12.752，13,261 毫秒跑完，CPU 時間 72 毫秒，結果是 `ok`。兩份都抓到、都存進 R2：

| | G2 | G3 |
|---|---|---|
| 網址 | `http://moica.nat.gov.tw/repository/MOICA/CRL2/complete.crl` | `http://crl-moica.moi.gov.tw/crl/MOICA-G3-complete.crl` |
| 排程印的 `result` | `stored` | `stored` |
| 大小 | 16,893,934 位元組 | 8,818,913 位元組 |
| SHA-256 | `9f7785eca72a4e94d0418345e7961d5376cc44bb8831b3e6f748df375a712a19` | `ebd20bbd621375da8bd7b75fabcc309ebd0db4ad12ce1289e4e80752a9e0c18f` |
| R2 記的寫入時間 | 15:00:19 | 15:00:26 |
| 清冊的 `thisUpdate`、cRLNumber | 09:11:05、2026111917 | 09:11:54、2026111917 |

- **狀態碼**：排程的紀錄不印狀態碼。`stored` 只有在收到完整的 `200` 時才會出現（見「排程做什麼」），所以兩個都是 `200`。
- **花的時間**：排程的紀錄也不印每一份花多久。兩份同時開始抓；從排程開始（15:00:13.551）到 R2 記的寫入時間，G2 約 6 秒，G3 約 13 秒，包含抓、算 SHA-256、寫入。R2 的時間只到秒。離每一份 5 分鐘的上限很遠。
- **下載得到**：`https://test-data.iamreal.tw/crl/<SHA-256>.crl` 兩個都回 `200`，`Content-Length` 和上表相同，`Cache-Control` 是 `public, max-age=31536000, immutable`；下載回來重算的 SHA-256 和檔名相同，`openssl crl` 讀得出兩份都是內政部憑證管理中心簽發的清冊。回應沒有 `Content-Type`：鏡像寫入時沒有設。
- 這些數字來自 `wrangler tail --env test --format json`（同一把權杖）和資料網域的回應標頭。只看了這一次排程，沒有從別的地方對內政部的網址送請求。

還沒看過的：內政部回錯誤、斷線、逾時的時候，Cloudflare 上的行為和本機的 workerd 是不是一樣（「排程做什麼」最後一段寫的那兩件事）。

#### 內政部對條件式請求怎麼回

2026-11-26 19:36（台灣時間）從開發用的電腦對兩個網址各問了三次，都沒有下載內容（[#266](https://github.com/iamreal-tw/iamreal/issues/266)）：

| | G2（`moica.nat.gov.tw`，前面有 CDN：回應帶 `X-CDN: Imperva`） | G3（`crl-moica.moi.gov.tw`） |
|---|---|---|
| `HEAD`，不帶條件 | `200`，`ETag: "100cdf3-6612bc6704b40"`，`Last-Modified: Thu, 26 Nov 2026 10:55:01 GMT`，`Content-Length: 16829939`，`Cache-Control: public,max-age=300` | `200`，`ETag: "884f83-6612bc6704b40"`，`Last-Modified` 相同，`Content-Length: 8933251`，`Cache-Control: public,max-age=300` |
| `HEAD`，同時帶 `If-None-Match` 和 `If-Modified-Since` | `200` | `200` |
| `GET`，只帶 `If-None-Match` | `304` | `304` |

- 兩個網址都給 `ETag` 和 `Last-Modified`，`GET` 帶 `If-None-Match` 時回 `304`。鏡像送的就是這一種。
- `HEAD` 同時帶兩個條件時回的是 `200`。是 `HEAD` 的關係還是同時帶兩個的關係，沒有再問；鏡像不走這兩條路。只帶 `If-Modified-Since` 的 `GET` 也沒有問過（鏡像只在沒有 `ETag` 時才這樣問）。
- 兩個 `ETag` 的後半相同，`Last-Modified` 也相同（18:55 台灣時間），比清冊的 `this_update`（約 17:11）晚：看起來是檔案放上伺服器的時間。
- **還沒看過的**：從 Cloudflare 問時是不是一樣回 `304`。部署後的第二輪排程起（第一輪補記標頭），看 `crl_mirror` 是不是 `not_modified`。

## 限流

ADR-0026 的三層裡，這裡做的是第三層：Worker 裡照 IP 算的上限（[#418](https://github.com/iamreal-tw/iamreal/issues/418)）。第一層（Cloudflare 自動的防護）不用設定；第二層（WAF 的一條限流規則）和緊急時的挑戰頁由營運者在儀表板設，見下面「營運者的說明」。全站的總量上限和 Durable Object 撐不住時的 `busy` 在這一節的後面（[#32](https://github.com/iamreal-tw/iamreal/issues/32)）。

程式在 [`src/rate-limit.ts`](src/rate-limit.ts)，用的是 Workers 的 [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。

**六類分開算**，一類一個綁定，上限寫在 [`wrangler.jsonc`](wrangler.jsonc) 的 `ratelimits`：

| 類 | 綁定 | 哪些請求 | 每分鐘（起始值，待維護者定） |
|---|---|---|---|
| 題目 | `RATE_CHALLENGES` | `POST /api/v1/challenges` | 30 |
| 卡片現況 | `RATE_CARD_STATE` | `POST /api/v1/card-state` | 30 |
| 送出 | `RATE_RECORDS` | `POST /api/v1/records` | 30 |
| 公開的讀取 | `RATE_PUBLIC_READS` | `GET /api/v1/config`、`fingerprint`、`rebuild`，三個合起來 | 180 |
| 計數 | `RATE_COUNTS` | `POST /api/v1/counts`（[計數](#計數)） | 120 |
| 頁面 | `RATE_PAGES` | 每一個跑到 Worker 的頁面請求（`GET`、`HEAD`），找不到的網址也算 | 300 |

全站的總量上限不照 IP，也不是綁定，見[下面](#全站的總量上限)。

- **擋得住的是在同一條連線上連發的來源**：綁定的計數在 Cloudflare 的每台機器各一份（下面「這個綁定的性質」）。每次開新連線的來源，請求散到很多台機器，每一台都沒到上限，這一層擋不住，要靠第二層的 WAF 規則（[營運者的說明](#營運者的說明)）。

- **一類被擋不影響另一類**：看了很多頁面的網路，過卡的三個介面照樣回答。
- **不算的**：Static Assets 直接送的檔（過卡的頁面 `/proof`、樣式、字型，不跑 Worker）；方法不對的請求（`405`）；`/api/` 底下不是介面的路徑（`404`）。這幾種都不問 Durable Object。
- **`config` 放在公開的讀取**：規格說不帶記號的 `config` 只受照 IP 的上限，沒有說哪一類。它不問 Durable Object；和 `fingerprint`、`rebuild` 放在一起是因為都是誰都能隨時問的讀取。一次過卡現在問 `config` 兩次（網頁版）或更多次（app 打開、回到前景、三次感應之前，算 6 次），所以這一類的上限是題目那一類的 6 倍：題目的上限還沒到之前，`config` 不會先被擋。網頁版過卡途中問的 `config`（不帶記號）被限流時不停下，用開始時拿到的那一份；兩個 app 還沒有，那裡 `config` 回 `429` 仍會讓那一次過卡停在讀卡之前。

**計次的鍵**由一個函式產生（`rateKey`）：類別加上來源的網路。

- IPv4 照單一位址
- IPv6 照 /64：取前 64 個位元，不管位址怎麼寫（大小寫、補零、`::`、後面接 IPv4 的寫法）都算成同一個鍵
- 寫成 IPv6 的 IPv4（`::ffff:192.0.2.1`）就是那個 IPv4
- 來源是 Cloudflare 給的 `CF-Connecting-IP`。沒有這個標頭、或它不是一個位址的請求不算：不拿別人編得出來的字當鍵。在 Cloudflare 上每個請求都有
- **本機的位址（`127.0.0.0/8`、`::1`）不算**：本機的 workerd 會替沒帶標頭的請求補上它連進來的本機位址，所以 `pnpm dev`、`pnpm local`（用真卡片過卡）和其他測試都不受上限影響。Cloudflare 上不會出現這種來源

**被擋的請求**在讀內文、問 Durable Object 之前就回答：

- 介面：`429`，`{"error":"rate_limited"}`，`Retry-After: 60`
- 頁面：`429`，一頁 HTML（[`design/copy/too-many-requests.md`](../design/copy/too-many-requests.md)），`Retry-After: 60`，`Cache-Control: no-store`。頁面上不寫位址，也不把訪客要的網址寫回來
- 不算進題目的 5 次，不寫連線紀錄（[連線紀錄](#連線紀錄)），即時的輸出也不寫任何一行
- `Retry-After` 固定是 60：綁定只回答過或不過，不說還剩幾次、什麼時候重新算（文件裡 `limit()` 的回應只有 `success`）；計次的期間是 60 秒，所以 60 秒是最長要等的時間
- 綁定本身出錯、或環境沒有那個綁定時放行（問不到上限，不能把所有人都擋下），即時的輸出寫一行 `{"event":"rate_limit_unavailable","class":"pages","error":"TypeError"}`，裡面沒有請求的內容。新開一個環境（正式的）時要在它底下另外寫 `ratelimits`：綁定不會從別的環境繼承

**這個綁定的性質**（[文件](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)，2026-11-26 讀的）：

- 期間只能是 10 或 60 秒（「Must be either 10 or 60」）
- 「Rate limits are approximate and apply separately in each Cloudflare location.」文件說每個機房各算各的，是近似值。**實際量到的是每台機器各一份**（2026-11-27，[#466](https://github.com/iamreal-tw/iamreal/issues/466)，測試網站，連線都進 SJC）：同一條連線連送 50 次 `POST /api/v1/challenges`，29 次 `200`、21 次 `429`；每次開新連線平行送 100 次，3 秒內全部 `200`；緊接著再用新連線送 40 次，只有 4 次 `429`，是落到剛才那台機器的。文件寫的「Cloudflare updates shared counts in the background within the same Cloudflare location」在一分鐘內看不出效果
- 文件寫「It is not recommended to use IP addresses or locations (regions or countries)」當鍵，理由是很多人可能共用一個 IP。這裡照 ADR-0026 用 IP：上限訂成共用 IP 的家庭或辦公室也用不完的量，擋的是單一來源的大量請求；之後查詢介面發金鑰時，帶金鑰的請求改用金鑰當鍵
- `namespace_id` 是帳號裡自己取的正整數，「unique within your Cloudflare account」：兩個綁定用同一個就會算在一起。測試環境用 1001 到 1006；正式環境要另外六個。1007 用過（2026-11-26 到 11-27 的全站總量上限），不再用

**改上限**：改 `wrangler.jsonc` 那一行的 `limit`，合併到 `main`，部署後生效。這是「部署會執行到的東西」，營運者看過才合併（`CONTRIBUTING.md`）。照 Cloudflare 的分析裡被擋的量調；被擋的請求後台自己不留紀錄。

**本機的 workerd 模擬得了這個綁定**（[bindings per environment](https://developers.cloudflare.com/workers/development-testing/bindings-per-env/) 的表：Rate Limiting，local simulations ✅），所以測試直接用它，沒有另外做假的計次。[`test/rate-limit.test.ts`](test/rate-limit.test.ts) 啟動一個上限只有幾次的 Worker（測試工具把設定檔的副本裡那幾個數字換掉，`startWorker` 的 `rateLimits`），來源用 `CF-Connecting-IP` 標頭給。

### 全站的總量上限

ADR-0026 的「全站的總量上限」：不照 IP，數的是**每分鐘開始過卡的次數**（`src/rate-limit.ts` 的 `withinStarts`，起始值每分鐘 60 次，設定是 `wrangler.jsonc` 的 `CARD_PROOF_STARTS_PER_MINUTE`，正式上線前照量測重定，[#52](https://github.com/iamreal-tw/iamreal/issues/52)）。

- **只算帶記號的那一次 `config`**：持卡人按下「開始過卡」時，客戶端問 `GET /api/v1/config?start`（`docs/api/card-proof.md`）。其他時候問的 `config` 不帶記號，不算進這裡，只受上面照 IP 的上限。
- **超過時**回 `503`，`{"error":"busy"}`，`Retry-After: 60`。網頁版在讀卡之前就停下，說現在人太多，不開內政部元件的視窗。
- 先過照 IP 的上限才算這裡：被照 IP 擋下的請求不佔全站的名額。被這裡擋下的也不算：一分鐘裡被擋的再多，下一分鐘照樣有 60 個名額。
- 沒有來源位址的請求（本機）也算：沒有網路可以不算。上限遠比一個人在本機過卡的次數大。
- **誰在數**：一個專用的 Durable Object（[`src/starts.ts`](src/starts.ts)，綁定 `STARTS`，類別 `Starts`，名稱固定是 `starts`）。整個網站只有一份計數，不分機房。分鐘照時鐘（UTC）算；計數只放在記憶體，什麼都不存（每次開始過卡都寫一次，成本比計數本身值得的多）。閒置 10 秒的物件會被移出記憶體，計時器還沒跑完的不會（[計數](#計數)也是這樣做）：有人開始過卡的那一分鐘，物件留一個到這一分鐘結束才跑完的計時器，所以一陣請求之後靜 10 秒，這一分鐘不會從零重算。物件還是被停下時（部署、Cloudflare 搬它），這一分鐘從零重算：只會多放人，不會多擋人。
- **為什麼是另一個物件**：不是證明紀錄的物件，也不是收計數的物件（[計數](#計數)）。計數只受照 IP 的上限，很多網路一起送計數時那個物件可能撐不住，開始過卡不該跟著停；證明紀錄的物件撐不住時，照下一節回 `busy`。
- **為什麼不用綁定**：原本用的是 Rate Limiting binding，整個網站一個鍵（綁定 `RATE_STARTS`）。綁定的計數在每台機器各一份，實際的上限是 60 乘上收到請求的機器數：測試網站上 2 秒內 80 次 `config?start` 全部回 `200`（2026-11-27，[#466](https://github.com/iamreal-tw/iamreal/issues/466)）。
- 物件出錯或不在、或設定不是 0 到 100000 的整數時放行，即時的輸出寫一行 `{"event":"rate_limit_unavailable","class":"starts",…}`，和每一類被綁定放行時相同。物件撐不住（`overloaded`）也一樣放行：接著問的證明紀錄的物件撐不住時，自己會回 `busy`。
- **改上限**：改 `wrangler.jsonc` 的 `CARD_PROOF_STARTS_PER_MINUTE`，合併到 `main`，部署後生效。這是「部署會執行到的東西」，營運者看過才合併（`CONTRIBUTING.md`）。

### Durable Object 撐不住時

Durable Object 回 `overloaded`（錯誤帶著 `overloaded: true`，文件說不要馬上重試，[error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)）時：

- **介面**回 `503`，`{"error":"busy"}`，`Retry-After: 60`，即時的輸出寫 `{"event":"proof_log_overloaded","id":…,"endpoint":…}`。客戶端的畫面和被限流時相同。已經被算了一次、之後才撐不住的那一筆送出，照連線紀錄的規則記下（`error` 是 `busy`）。
- **頁面**（要讀它的首頁、島民證明、查詢頁、證明紀錄頁、掛上去）回 `503`，一頁「現在人太多」（[`design/copy/too-many-requests.md`](../design/copy/too-many-requests.md)「人太多的時候」），`Retry-After: 60`，`Cache-Control: no-store`。
- 不問 Durable Object 的（`config`、常見問題這類頁面）照常回答。
- 本機測不到真的 `overloaded`：測試用的建置有一個開關（`PUT /__test/proof-log-overloaded`），打開後每一次問證明紀錄的物件都照 Cloudflare 的樣子失敗（[`test/busy.test.ts`](test/busy.test.ts)）。

### 營運者的說明

第二層和緊急時的挑戰頁都在 Cloudflare 的儀表板設（ADR-0029：後台以外的設定由營運者做）。**這兩樣還沒有在測試網站設過**；下面是照 ADR-0026 和 Cloudflare 的文件寫的步驟，上線前在測試網站各做一次、實際打一次，把看到的補回這一節。

**一、WAF 的那一條限流規則（平時開著）**

- 在哪裡：zone `iamreal.tw` → Security → WAF → Rate limiting rules → Create rule（[rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/)）。Free 方案只有 1 條、計數期間 10 秒
- 比對哪些請求：會跑到 Worker、打得到 Durable Object 的路徑合起來。用運算式寫：主機是 `test.iamreal.tw`（正式上線後加 `iamreal.tw`），而且路徑不是 Static Assets 直接送的那幾種（`/proof` 和它底下的檔、`/pages.css`、`/copy.js`、`/demo.js`、`/fonts/`、`/favicon.ico`、`/og-image.png`）
- 照什麼算：IP（這一層只能照完整的位址，IPv6 的 /64 由 Worker 那一層管）
- 上限：訂得比 Worker 裡各類的上限合起來寬很多。這一層擋的是單一來源的洪水；細的分法在 Worker。**起始值待定**：WAF 的規則會不會連快取命中的請求一起算，還沒有在測試網站看過（ADR-0026 的 Consequences），看過再定
- 動作：Block，期間 10 秒（Free 方案的選項）
- 打開和關掉：規則列表上的開關。關掉之後只剩 Worker 裡的那一層，而那一層擋不住每次開新連線的來源（上面「這個綁定的性質」）：**每次開新連線的洪水只有這一條擋得住**，上線前一定要設好
- 被這一條擋下的請求不會跑到 Worker，後台什麼都不知道；看 Security → Events
- **上限要訂多少要重新想**：上面寫「寬很多」，是以為 Worker 那一層擋得住單一來源的洪水。現在每次開新連線的洪水只有這一條擋得住，它的上限就是那種洪水能送多少；Worker 裡六類合起來每分鐘約 690 次，約每 10 秒 115 次，比那個寬很多的上限擋不了什麼。由維護者定（[#466](https://github.com/iamreal-tw/iamreal/issues/466)）
- 設好之後驗一次：從一台電腦每次開新連線，在 10 秒內平行送比規則的上限多的 `POST /api/v1/challenges`（下面的 `N`），看有沒有被擋下的（被 WAF 擋下的是 Cloudflare 的回應，不是 Worker 的 `429` `rate_limited`）：
  ```sh
  seq 1 N | xargs -P 20 -I{} curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' --data '{}' https://test.iamreal.tw/api/v1/challenges | sort | uniq -c
  ```

**二、緊急時的挑戰頁（平時關著）**

- 事先做好一條自訂規則：Security → WAF → Custom rules → Create rule（[custom rules](https://developers.cloudflare.com/waf/custom-rules/)），動作選 Managed Challenge，存成**關著**的
- 只套在訪客的頁面：首頁 `/`、島民證明 `/p/…`、查詢頁 `/threads/…`、證明紀錄頁 `/proof-log`。**不套**在 `/api/`、`/proof` 和它底下的檔、資料網域（`data.iamreal.tw`、`test-data.iamreal.tw`）：挑戰頁回的是一整頁 HTML，頁面裡的 `fetch()` 會直接失敗，過卡和重驗的工具都會壞（ADR-0026「緊急時的挑戰頁」）
- 不用整站的 I'm Under Attack 模式
- 什麼時候打開：限流和總量上限都開著，頁面還是撐不住
- 打開：規則列表上把那一條打開。關掉：同一個開關。事後公告開了多久
- 開著的期間：訪客要先過一次檢查，通過後 Cloudflare 放一個 `cf_clearance` cookie（預設 30 分鐘）；用程式讀頁面會被擋；平台抓連結預覽的程式過不了，那段時間貼出去的島民證明連結可能沒有預覽
- 上線前在測試網站演練一次：打開、用瀏覽器和 `curl` 各開一頁島民證明、確認 `/api/v1/config` 和 `/proof` 不受影響、關掉

**三、上線後要看、再補回這裡的**（ADR-0026 列的）：WAF 的限流規則算不算快取命中的請求；各類被擋的量（Cloudflare 的分析），起始值要不要調。（Rate Limiting binding 的計數放在哪裡已經量過：每台機器各一份，見上面「這個綁定的性質」。）

## 連線紀錄

後台替送出一筆（`POST /api/v1/records`）的請求記一筆連線紀錄，其他的請求不記（ADR-0022，[#20](https://github.com/iamreal-tw/iamreal/issues/20)）。這是後台唯一存 IP 的地方。程式在 [`src/connection-log.ts`](src/connection-log.ts)，一個不引用別的模組的檔。

**記哪些請求**：被 Durable Object 算了一次的送出（[送出一筆](#送出一筆)的第 2 段通過），不管後來停在哪一段。這樣定的理由是量有上限：一個題目最多算 5 次，所以一個題目最多 5 筆（第 5 次成功的話就是那 5 筆之一）。不記的：

- 看頁面、靜態檔、`config`、拿題目、查卡片現況、`fingerprint`、`rebuild`
- 第 1 段擋下的送出（`malformed`、`scope`、`platform`）
- 第 2 段擋下的送出：題目不是後台發的或已經過期（`challenge_unknown`）、這個題目已經寫過一筆（`challenge_used`）、第 6 次起（`challenge_attempts`）、停止收過卡（`paused`）。這幾種誰都能無限次送。第 4 段再看題目時才擋下的 `challenge_used`、`challenge_unknown` 不同：那一次已經算了，照記，有內文
- 被限流擋下的請求（[限流](#限流)）：在讀內文、問 Durable Object 之前就回 `429`，沒有被算，走不到這裡

**一筆記什麼**。一筆一個 JSON 物件，欄位就是下面這些，沒有別的（`test/connection-log.test.ts` 逐一比對物件的鍵）：

| 欄位 | 成功寫入的送出 | 沒有寫入的送出 |
|---|---|---|
| `request_id` | 回應的 `X-Request-Id` | 同左 |
| `time` | 後台的時鐘，UTC，ISO 8601 | 同左 |
| `result` | 回應的狀態碼，`201` | `400`、`403`、`503`、`500` |
| `error` | 沒有這個欄位 | 回應的錯誤代碼 |
| `ip` | Cloudflare 給的 `CF-Connecting-IP` | 同左 |
| `country`、`asn` | Cloudflare 給的國家代碼和網路業者的編號（`request.cf`） | 同左 |
| `device_id` | 請求帶的過卡裝置編號（ADR-0039），沒帶是 `null` | 同左 |
| `seq` | 寫成了第幾筆 | 沒有這個欄位 |
| `body` | 沒有這個欄位：內文在證明紀錄裡 | 請求的內文原樣（匿名編號、帳號、題目、證明），最多 64 KiB |

沒有放計數內容的欄位：計數不進連線紀錄（ADR-0032）。

**過卡裝置編號**（`device_id`）是送出一筆的請求多的一個欄位，可以不帶：32 個小寫十六進位數字。`src/submission.ts` 讀出來之後只交給連線紀錄；交給 Durable Object、寫進證明紀錄的是紀錄的欄位，裡面沒有它。格式不對的（任何型別）當成沒帶：過卡照常處理，那一筆的 `device_id` 是 `null`，送來的值不存；這個欄位只進連線紀錄，不因為它擋住一次已經輸過 PIN 的過卡。沒成功的送出內文是原樣存的，所以那種請求送來的值會在 `body` 裡。客戶端現在都還沒有帶（計數的規格做）。

**存在哪裡**：R2 的儲存桶 `iamreal-test-logs`（綁定 `CONNECTION_LOG`），和公開資料的 `iamreal-test-data` 分開，沒有公開網域。鍵是 `connection/<日期>/<時間>-<請求編號>.json`，日期和時間是 UTC。之後別的東西（計數的明細）可以放在同一個儲存桶的別的目錄，各自有自己的生命週期規則。只有營運者讀得到，靠的是 Cloudflare 帳號只有營運者一個成員（ADR-0029）；後台沒有讀它的介面。

**留 31 天，靠儲存桶的生命週期規則**：前綴 `connection/`，物件建立 31 天後刪除。程式自己不刪。文件寫到期的物件「Objects will typically be removed from a bucket within 24 hours of the `x-amz-expiration` value」（[Object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)，2026-11-26 讀的），所以實際是 31 到 32 天。

**規則有沒有在刪，從外面看得到**。後台不在部署前讀回這條規則：讀儲存桶的設定要一把有「Workers R2 Storage: Read」的權杖，而這個權限同時讀得到、列得出帳號裡每個儲存桶的物件，連線紀錄本身也在內；Cloudflare 沒有只讀設定、或只限一個儲存桶又讀得到設定的權限。把這樣一把權杖放進 Actions，等於多一個讀得到 IP 的地方。改成看結果：

- 每小時的排程（和清冊鏡像同一次，在它之前、各做各的）用 `CONNECTION_LOG` 的綁定列出 `connection/` 底下的第一個鍵。鍵以日期開頭，儲存桶照順序列，所以第一個就是最舊的一筆；不管裡面有多少筆，都是一個請求（`src/connection-log.ts` 的 `oldestDay`）
- 把結果寫成公開資料的一個檔，`connection-log/oldest.json`（`Cache-Control: public, max-age=60`）：

  ```
  {"checked":"2026-11-26T12:00:07.123Z","oldest":"2026-10-27"}
  ```

  `checked` 是這一次看的時間，`oldest` 是最舊一筆的日期（UTC），一筆都沒有時是 `null`
- **這個檔為什麼可以公開**：裡面只有這兩個時間。沒有筆數、沒有鍵、沒有任何一筆紀錄的內容（請求編號、IP、過卡裝置編號、內文都沒有）。長期看這個檔的人看得出的是：哪幾天有被算了一次的送出。成功的那些天從證明紀錄本來就看得出來；多出來的是只有失敗的送出的日子
- 判斷留給外面的檢查（[#53](https://github.com/iamreal-tw/iamreal/issues/53)）：`oldest` 比今天早超過 33 天，就是規則沒有在刪（31 天，加上文件寫的 24 小時內移除，加上日期是 UTC 的進位）；`checked` 超過兩小時沒變，就是後台沒有在看（排程沒跑、儲存桶列不出來、或這個檔寫不進去）。外面的檢查照這個檔自己算。後台看到 `oldest` 超過 33 天時，另外在即時的輸出寫一行 `{"event":"connection_log_overdue","oldest":"2026-10-17"}`（沒有開保存，要當下在看才看得到）
- 列不出來、第一個鍵不是日期開頭、或檔寫不進去時，這個檔留著上一次的時間，即時的輸出多一行 `{"event":"connection_log_oldest_not_published","error":"Error"}`；清冊鏡像照常做
- 規則本身由營運者在儲存桶上設（[營運者在 Cloudflare 和 GitHub 上設的](#營運者在-cloudflare-和-github-上設的)）：`connection-31-days`，前綴 `connection/`，31 天後刪除。新的儲存桶在第一筆滿 31 天之前，這個檢查看不出規則設錯；營運者設的時候看一次

**刪掉的物件救不救得回來**。規格要求確認 R2 沒有把刪掉的物件救回來的機制（救得回來的話，對外說的 31 天就不成立）。2026-11-26 讀 Cloudflare 的文件，結果是「文件上沒有這種機制」，不是「文件保證沒有」：

- S3 相容的介面把 `GetBucketVersioning`、`PutBucketVersioning` 列在沒有實作的操作（[S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)）：沒有物件的版本
- 「Durability does not prevent intentional or accidental deletion of data.」（[Durability](https://developers.cloudflare.com/r2/reference/durability/)）
- Bucket locks 是擋刪除和覆寫的，沒有開；開了的話「Bucket lock rules take precedence over lifecycle rules」（[Bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)），生命週期規則就刪不掉：這個儲存桶不能設
- 文件沒有任何一頁提到軟刪除、回收桶、還原到某個時間點，也沒有說刪掉的資料實體上多久清掉

**寫不進去的時候**。寫入不經過證明紀錄的 Durable Object，請求也不等它（`waitUntil`）。儲存桶寫不進去時，回應和寫得進去時相同，即時的輸出多一行，沒有開保存，裡面沒有請求的任何內容：

```
{"event":"connection_log_not_written","id":"<請求編號>","error":"Error"}
```

那一筆連線紀錄就是沒有了，不會補寫。

**還有兩種時候，算了一次的送出沒有紀錄**：Durable Object 已經把次數加上去、回應卻沒有回到 Worker（那個請求回 `500`）；Worker 這一次執行在算了之後被平台結束（例如用完 CPU 時間）。後一種為了不讓「送出後馬上斷線」躲掉紀錄，寫入是在算了一次的那一刻就向執行環境登記的（`waitUntil`），不是等回應準備好才登記；客戶端斷線後請求是不是照樣跑完，沒有在 Cloudflare 上看過。

**還沒在 Cloudflare 上看過的**：`CF-Connecting-IP`、`request.cf` 的 `country` 和 `asn` 實際的值（本機的 workerd 裡 IP 是測試自己帶的標頭）；滿 32 天後 `oldest.json` 的日期有沒有跟著往後移。

### 查連線紀錄

營運者在自己的電腦上查，後台沒有讀連線紀錄的介面（[#417](https://github.com/iamreal-tw/iamreal/issues/417)、[#413](https://github.com/iamreal-tw/iamreal/issues/413)）。指令是 [`scripts/connection-log.ts`](scripts/connection-log.ts)：給一段 UTC 的日期，下載那幾天的每一筆，印出符合條件的，一筆一行 JSON，舊的在前。

```sh
cd worker
node --experimental-strip-types scripts/connection-log.ts --from 2026-11-20 --to 2026-11-21 [條件…]
```

| 條件 | 意思 |
|---|---|
| `--after <時間>`、`--before <時間>` | 這段時間裡的（含 `--after`，不含 `--before`）。ISO 8601，要寫時區：`2026-11-20T08:00:00Z`，或台灣時間 `2026-11-20T16:00:00+08:00` |
| `--result <結果>` | `accepted`（寫成了一筆）、`refused`（沒有）、一個狀態碼（`409`），或一個錯誤代碼（`challenge_used`）。錯誤代碼拼錯的話只會查不到，不會報錯 |
| `--ip <位址>` | 正好是這個 IP 位址的，IPv4 或 IPv6，不比對開頭。IPv6 的大小寫、省略的寫法不同也對得上（`2001:DB8::42` 和 `2001:db8:0::42` 是同一個） |
| `--device <過卡裝置編號>` | 這台裝置的送出（ADR-0039）：每一筆的時間、結果、IP，成功的那幾筆有 `seq`，是證明紀錄的第幾筆 |
| `--body` | 沒有成功的那幾筆連內文一起印（預設不印：一份完整的送出） |

- `--from`、`--to` 一定要給，是 UTC 的日期，最長 33 天。台灣時間比 UTC 早 8 小時：台灣時間 11 月 21 日早上 8 點以前的請求，在 UTC 的 11 月 20 日那一天。
- 印出來的有 IP 位址，當成敏感的東西：查完不要留著輸出的檔，不要貼到 issue、聊天或任何公開的地方。

#### 讀儲存桶的權杖：要查的時候才建，查完刪掉

指令用 R2 的 S3 相容介面讀 `iamreal-test-logs`，只做兩件事：列出一天的鍵（`ListObjectsV2`）和讀一筆（`GetObject`）。它要一把**只能讀、只限這一個儲存桶**的 R2 權杖。

**不要用**讀得到整個帳號的權杖：`Workers R2 Storage Read`、Admin 的兩種權限，都讀得到每一個儲存桶。理由見上面「規則有沒有在刪，從外面看得到」。

權杖平常不存在。營運者要查的時候：

1. **建權杖。** 在 Cloudflare 的儀表板，R2 → 管理 R2 的 API 權杖 → 建一把新的（儀表板上的字可能改過，照下面的意思找）：
   - 權限選 **Object Read only**。文件寫這種權限「Allows the ability to read and list objects in specific buckets」（[R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/)，2026-11-26 讀）。
   - 儲存桶選**只限指定的儲存桶**，只勾 `iamreal-test-logs`（「you can scope your token to a set of buckets」，同一頁）。
   - 有到期的選項就設一天。
   - 建好後頁面上會有 Access Key ID、Secret Access Key 和 S3 的端點 `https://<帳號編號>.r2.cloudflarestorage.com`。這幾個值只顯示這一次。
2. **寫進金鑰檔** `~/.config/iamreal/connection-log.env`，只有自己讀得到：

   ```sh
   mkdir -p ~/.config/iamreal
   (umask 077 && cat > ~/.config/iamreal/connection-log.env)   # 貼上下面三行，按 Ctrl-D
   chmod 600 ~/.config/iamreal/connection-log.env
   ```

   ```
   R2_ACCOUNT_ID=<端點裡的帳號編號>
   R2_ACCESS_KEY_ID=<Access Key ID>
   R2_SECRET_ACCESS_KEY=<Secret Access Key>
   ```

   - 這個檔不在程式庫裡，不要放進任何程式庫。
   - 指令找不到這個檔時，會說去看這一節。檔讓別的使用者讀得到時，指令不讀它，要你先 `chmod 600`。
   - 錯誤訊息不會印出檔裡的任何值。
3. **跑上面的指令。**
4. **查完刪掉：** 在儀表板的 R2 權杖列表刪掉這一把，再刪掉金鑰檔：`rm ~/.config/iamreal/connection-log.env`。

**這把權杖讀得到 IP 位址**：它讀得到 31 天內每一筆被算過的送出（ADR-0022）的 IP、過卡裝置編號，和沒有成功的送出的內文。所以要當成敏感的東西保管：只放在營運者自己的電腦，不傳給別人，不放進 GitHub 的 secret，不在別的機器上建。

正式網站有了之後，它的連線紀錄在另一個儲存桶，要另建一把只限那一個的權杖。指令的 `BUCKET` 到時候一起改。

### 收到查詢或刪除連線紀錄的請求時

隱私權說明寫了：想查連線紀錄裡和自己有關的部分，或依法要求刪除，請寫信給營運者，營運者個別處理（`design/copy/privacy.md` 第 14 段）。這一節是營運者收到信之後怎麼做。

**對出是哪幾筆。** 連線紀錄裡沒有姓名、沒有卡片，對得上請求的人的只有：

- **時間：** 請請求的人說大約是哪一天、幾點送出的（台灣時間），換成 UTC 給 `--from`、`--to`、`--after`、`--before`。
- **IP 位址：** 請請求的人說那時候用的網路的對外 IP（家裡、公司的固定 IP 較好對；手機網路的 IP 常常換，對不準）。給 `--ip`。

只有時間沒有 IP 的話，那段時間裡別人的送出也會列出來：不要把別人的那幾筆給請求的人。

**查詢的請求。** 用上面的指令查出符合的那幾筆，確認時間和 IP 都對得上，再照下面「待定」那幾項回覆。

**刪除的請求。** 先照上面對出是哪幾筆，記下每一筆的鍵：`connection/<UTC 的日期>/<time>-<request_id>.json`，兩個值都在印出來的那一行裡。然後：

1. 在 Cloudflare 的儀表板，R2 → `iamreal-test-logs` → 物件，搜尋 `connection/<日期>/`，找到那幾個鍵，刪除。
   - 不用另建能寫的權杖：刪除只在儀表板上做。
2. 再跑一次同樣的查詢，確認那幾筆不在了。
3. 刪了之後，Cloudflare 的文件上沒有把它救回來的機制（見上面「刪掉的物件救不救得回來」：文件上沒有，不是文件保證沒有）。不刪，它們也會在寫入 31 天後由生命週期規則刪掉；請求的時間如果已經接近 31 天，回覆時可以說明。

連線紀錄刪了，證明紀錄不變：成功的送出寫進證明紀錄的那一筆，照 ADR-0005 不能刪，只能收回（隱私權說明第 10 段）。

**待維護者定**（這張票不定）：

- 對外怎麼回覆：查詢的結果給請求的人哪些欄位（IP、國家、網路業者的編號、過卡裝置編號、內文）、用什麼格式，刪除完成時寫什麼。
- 多久內回。
- 怎麼確認寫信來的人就是那些送出的人。只有時間和 IP，任何知道某人 IP 的人都能來問。
- 收到的請求和處理的經過要不要留紀錄、留在哪裡、留多久（信本身在營運者的信箱裡，隱私權說明第 12 段）。
- 對不出來（沒有 IP、時間太模糊、已經超過 31 天）時怎麼回覆。

## 計數

客戶端在幾個固定的地方回報「發生了哪一件事」，後台收下來（ADR-0032、ADR-0039；規格 [#431](https://github.com/iamreal-tw/iamreal/issues/431)，這一段是 [#54](https://github.com/iamreal-tw/iamreal/issues/54)）。一筆計數能帶什麼，寫死在一張表：[`spec/counts.md`](../spec/counts.md)，TypeScript 的那一份是 [`protocol/src/counts.ts`](../protocol/src/counts.ts)，後台和網頁版的過卡用同一份，標準答案在 `spec/vectors/counts.json`。後台的程式在 [`src/counts.ts`](src/counts.ts) 和 `src/api.ts` 的 `postCount`。

**收**（`POST /api/v1/counts`）：

- 內容最多 2,048 個位元組。照表讀（`readCount`）：有一個值不在表上、多一個或少一個成員、編號或版本號或讀卡機名稱的格式不對、不是 JSON，整筆丟掉，什麼都不留
- 收下和丟掉回的都是 `204`，沒有內容。客戶端不看回應
- 限流另算一類（[限流](#限流)的 `RATE_COUNTS`），照 IP 算。**IP 只用在這裡**：交給 Durable Object 的是讀表時照表重新組出來的那一筆，沒有請求的任何東西（位址、標頭、請求編號）
- 計數不寫連線紀錄；即時的輸出不寫計數的任何內容。後台自己出錯時才有一行：交不到收計數的物件是 `{"event":"count_not_kept","error":"Error"}`；設定不對（`PROOF_LOG_KIND` 等，和每個介面一樣先讀，或 `COUNT_EVENTS_PER_MINUTE` 不是數字）回 `500`，寫 `internal_error` 那一行
- 不問證明紀錄的 Durable Object：Worker 檢查完交給另一個物件（綁定 `COUNTS`，類別 `Counts`，名稱固定是 `counts`）。看頁面的量比過卡多得多，不讓它和寫證明紀錄的搶同一個寫入者（ADR-0023）

**存**：

- 那個物件把這一分鐘收到的計數放在記憶體裡。分鐘照收到的時間（UTC），計數自己沒有時刻
- 一分鐘結束後寫成一個檔，放進不公開的儲存桶 `iamreal-test-logs`（和連線紀錄同一個，綁定也是 `CONNECTION_LOG`）：

  ```
  count-events/2026-11-26/2026-11-26T14:05Z.json
  {"minute":"2026-11-26T14:05Z","counts":[{"client":"web","event":"step","step":"read","device_id":"…","attempt_id":"…","browser":"chrome","os":"windows"}],"dropped":0}
  ```

  `counts` 照收到的順序，每一筆的成員照 `spec/counts.md` 的順序。沒有收下任何一筆的那一分鐘不寫檔
- 寫檔靠物件裡的一個計時器（`setTimeout`，設在這一分鐘結束後一秒）。用計時器是為了讓物件留在記憶體：Cloudflare 會把閒置的 Durable Object 收掉，能休眠的 10 秒就收，記憶體裡的東西跟著沒了；還有計時器沒跑完的物件不會被收（[Lifecycle of a Durable Object](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)，2026-11-26 讀的：休眠的條件之一是「No setTimeout/setInterval scheduled callbacks are set」）。另外設一個 alarm（存在物件的儲存裡）當備用；下一分鐘第一筆計數進來時，上一分鐘還沒寫也會先寫掉
- **每分鐘最多留 `COUNT_EVENTS_PER_MINUTE` 筆**（[設定檔](#設定檔)，現在 600）。超過的不留，只在那個檔的 `dropped` 記這一分鐘另外來了幾筆：明細的量不由送的人決定。這個數字由 Worker 每次帶給物件，物件自己不讀設定
- 寫檔失敗時，即時的輸出寫一行 `{"event":"count_events_not_written","minute":"…","error":"Error"}`，那一分鐘的計數就沒了。物件被重啟或換版（部署）時，還在記憶體裡的那一分鐘也沒了。計數只供營運者參考，不補
- 儲存桶裡三個前綴互不重疊：`connection/`（連線紀錄）、`count-events/`（計數的明細，31 天）、`count-totals/`（加總，永久，[#435](https://github.com/iamreal-tw/iamreal/issues/435)，還沒有）

**31 天後刪除**靠儲存桶的生命週期規則（[營運者在 Cloudflare 和 GitHub 上設的](#營運者在-cloudflare-和-github-上設的)），程式不刪。規則有沒有在刪，和連線紀錄同一種看法（[連線紀錄](#連線紀錄)）：每小時的排程用後台自己的綁定列出 `count-events/` 底下的第一個鍵，把它的日期寫成公開資料的 `count-events/oldest.json`（`{"checked":"<UTC 的時間>","oldest":"<UTC 的日期>"}`，一檔都沒有時 `oldest` 是 `null`）。比今天早超過 33 天時，即時的輸出寫一行 `count_events_overdue`，外部的檢查（`test/outside-check.ts`）也會失敗。不在部署前讀回規則，不用讀 R2 的權杖。外部檢查的那一行現在關著（`COUNT_EVENTS_CHECKED`），等這一版部署、檔案出現之後在另一個 PR 打開。

**測試**：[`test/counts.test.ts`](test/counts.test.ts) 對本機 workerd 上的整個 Worker 送請求，移動時鐘、讓物件的 alarm 響一次，讀 R2 模擬裡的檔。`spec/vectors/counts.json` 的每一案都送一次，檔裡只有表收的那些；檔裡沒有 IP、標頭、請求編號；沒有多出連線紀錄；超過每分鐘上限時明細停在上限、多的記成次數；證明紀錄的 Durable Object 什麼都不回答時計數照收；放一個 34 天前的檔，公布的日期、即時的輸出和外部檢查都看得到。超過照 IP 的上限回 `429` 在 `test/rate-limit.test.ts`。

**還沒在 Cloudflare 上看過的**：

- 這個物件一秒收得了多少（和 [#52](https://github.com/iamreal-tw/iamreal/issues/52) 的量測一起量）
- 計時器是不是真的讓物件留到那一分鐘寫出來（照文件會；本機的 workerd 不會收掉物件，測不到）
- 生命週期規則真的刪掉 `count-events/` 的檔：滿 32 天後營運者看一次

## 停止和恢復收過卡

營運者改 Worker 的一個設定值 `CARD_PROOFS_PAUSED`，就停止或恢復收過卡（ADR-0033，[#105](https://github.com/iamreal-tw/iamreal/issues/105)）：`"true"` 停止，`"false"` 收。在 Cloudflare 的儀表板改，不經過 Actions；Worker 沒有營運者專用的入口。

停止的時候：

- `GET /api/v1/config` 回 `"paused": true`。過卡的頁面第 1 步一打開就問，在讀卡之前講「現在暫停收過卡。……」，沒有「下一步」（`design/copy/card-proof.md` 第 1 步「停止收過卡時」）。第 1 步之後才停的，停在「連上島民證明的伺服器」或「送出」下面：「現在暫停收過卡，證明紀錄沒有變動。請晚點再來。」。第 2 步停下時按鈕照舊是「再讀一次卡片」（和第 2 步其他停下的一樣）；第 5 步停下時只有「回到開頭」，不給「再試一次」
- `POST /api/v1/challenges` 和 `POST /api/v1/records` 回 `503` `paused`（`docs/api/card-proof.md`）。Worker 在問證明紀錄的物件之前就回：題目不發，送出不計次（同一個題目恢復後照樣能送），證明紀錄不多任何一筆。格式讀不懂的送出照樣是 `400`
- 卡片現況、指紋、每一種訪客頁面、儲存桶裡的檔案（證明紀錄、清冊存檔）照常。每天換日的那一次照常寫（最後一檔、卡片狀態檔、指紋檔的那一行）：證明紀錄的物件不知道停止了，它的 alarm 照常響。清冊鏡像照常
- 值不是 `"true"` 也不是 `"false"` 時，API 回 `500`，Worker 產生的頁面也是（和 `PROOF_LOG_KIND` 一樣，不猜）

`test/pause.test.ts` 在本機的 Worker 上核對上面每一項，和恢復之後照常收。

### 怎麼停、怎麼恢復

1. Cloudflare 的儀表板：Workers & Pages → `iamreal-test` → Settings → Variables and Secrets，把 `CARD_PROOFS_PAUSED` 改成 `true`（純文字），按 Deploy。存下去就是 Worker 的一個新版本
2. 確認停了：`curl -s https://test.iamreal.tw/api/v1/config` 的 `paused` 是 `true`；`curl -s -X POST https://test.iamreal.tw/api/v1/challenges` 回 `{"error":"paused"}`。打開 `https://test.iamreal.tw/proof`，第 1 步是停止的那一句
3. 恢復：同一個地方改回 `false`，按 Deploy，再看一次 `config` 的 `paused` 是 `false`

**部署會把值寫回設定檔的。** `wrangler deploy` 照 `wrangler.jsonc` 的 `vars` 寫整份設定，儀表板上改的值會被設定檔裡的 `false` 蓋掉（沒有用 `keep_vars`：設定值的來源只有這個檔）。測試網站每一次合併到 `main` 就部署一次（[從 GitHub Actions 部署](#從-github-actions-部署)），所以停止期間有 PR 合併，就會恢復收過卡。要停得久、或停止期間要部署：開一個 PR 把 `wrangler.jsonc` 的 `CARD_PROOFS_PAUSED` 改成 `"true"`，和要部署的東西一起合併；恢復時同樣開 PR 改回 `"false"`。正式網站從推版本標籤部署時（還沒有），同樣是設定檔的值算數。


## 從證明紀錄重建

把 Durable Object 裡所有從證明紀錄算得出來的東西重算一遍（ADR-0033「從證明紀錄重建」，[#107](https://github.com/iamreal-tw/iamreal/issues/107)）：每張卡片的狀態和最晚的有效日期、頁面的衍生表、用過的題目、筆數和指紋。卡片狀態檔和 Go 的重驗比出不同、紀錄規則的版本號加了一號、物件的資料沒了，都走這一條；沒有只重建其中一樣的做法。程式在 [`src/rebuild.ts`](src/rebuild.ts)，什麼時候開始、什麼時候做下一步在 `src/proof-log.ts`。

**怎麼開始。** 營運者先停止收過卡（[停止和恢復收過卡](#停止和恢復收過卡)），再把設定值 `REBUILD_PROOF_LOG` 改成一個自己取的名稱（例如 `2026-11-27-1`），做法和改 `CARD_PROOFS_PAUSED` 相同：在儀表板改，存下去就是 Worker 的一個新版本，物件下一次啟動時帶著新的值。

- 物件啟動時看：有名稱、正在停止收過卡、這個名稱它還沒做過，就開始。沒有停止收過卡時不開始，寫一行 `{event: "rebuild_not_begun", reason: "card proofs are not stopped"}`。
- **一個名稱只做一次**，不論結果是換了還是沒換；要再做一次就換一個名稱。物件沒事做幾秒就休眠、被叫醒時重新啟動，所以不能是「設定值在就做」。
- 名稱會出現在即時輸出和 `GET /api/v1/rebuild` 的回應裡，不要拿不能公開的字當名稱。
- 和 `CARD_PROOFS_PAUSED` 一樣，下一次部署會把設定檔裡的值（空字串）寫回去；已經做完的那一次不受影響。
- **重建完不會自己恢復收過卡**：營運者照 ADR-0033 的兩個條件確認後，自己把 `CARD_PROOFS_PAUSED` 改回 `false`。

**怎麼做。**

- 照序號讀每一筆紀錄：先是物件搬到 R2 的每一個寫滿的檔（每一檔核對 SHA-256 是物件當初寫的那一個），最後是物件自己還留著的紀錄。每一筆用 `protocol/` 的規則（`applyList`）套在重算出來的那張卡片的狀態上，和重建衍生表相同（[頁面用的衍生表](#頁面用的衍生表)）。
- **一次 alarm 做一檔**（是 `timedWork()` 的一件），做到第幾筆存在物件裡（`rebuild_state` 表），所以物件重啟、部署、中斷之後，下一次 alarm 接著做，不用從頭來。一步是一個交易。
- **先算進另一組表**：和卡片狀態表、五張衍生表同樣的表，名字前面加 `rebuild_`。`card-table.ts`、`views.ts` 的讀寫照舊，由 `rebuild.ts` 把它們的 SQL 換成這一組表的名字再執行，並擋下任何沒有換到的表名。重建期間，頁面、`card-state`、每天的公布讀的都是原本的表。
- **全部算完才換**，在一個交易裡：卡片狀態、衍生表、`proof_log` 那一列（筆數、指紋、最晚的有效日期，`rules_version` 寫成這一版的）、用過的題目。之後暫存的表刪掉。
- **換之前核對**，有一項不對就不換、寫下原因，原本的表沒有動：
  - 每一行都是格式正確的一筆，序號接得上
  - 物件記著的每一個寫滿的檔結尾的指紋、自己留著的最後一筆的指紋，和重算的相同
  - 算到指紋檔最後一行的筆數那一刻，指紋和那一行相同；紀錄的總數不少於那個筆數
  - 沒有一筆是這一版規則對那張卡片的狀態不接受的（空的清單、更換超過上限、同一天超過上限：`applyList` 的檢查 5、6）。遇到的話停在那裡，原因裡寫第幾筆和規則的代碼；不把它當成無效的紀錄跳過。證明、題目、清冊、日期先後那四項檢查（1 到 4）這裡不重做，和重建衍生表相同：那是寫入時過了的，重做要清冊存檔；整份從第 1 筆重驗是 Go 的 `iamreal-verify` 的事。後台只寫入規則接受的紀錄，所以會遇到只有兩種情況：規則改得比原本嚴（ADR-0031 說這時要照日期切換版本，那段程式第一次需要時才加），或紀錄檔不是後台寫的那一份
- **重建期間不發題目、不收紀錄**（回 `paused`）：營運者已經停止收過卡，這是物件自己多擋的一層。
- **重建期間不公布證明紀錄**：換日時那一天的那一行和卡片狀態檔等重建做完才寫，不從快要被換掉的表寫。寫滿的檔照常搬到 R2。重建也不會在一次公布進行到一半時開始。
- **套用紀錄時出的錯一律算沒換**（`refused`），原因裡只寫錯誤的種類：那一段不等任何東西，同樣的錯每次都會再發生，不讓重建一直停在進行中、擋著收過卡。只有 R2 沒有回應會等一下再試。
- **題目**：還沒用掉的題目全部丟掉，持卡人重拿一個。用過的題目只留日期是今天和昨天的紀錄的（題目十分鐘就過期，再早的不可能還有效），再送一次照舊是 `challenge_used`。
- **換完立刻重寫卡片狀態檔**：寫的是指紋檔最後一行那一天的檔（`proof-log/card-state/<那一天>.jsonl`），內容是重算到那一行的筆數那一刻的每張卡片，不是重算到最後一筆的。這樣 Go 的重驗照規格比得起來（`spec/record-rules.md`「The card state file」：一張卡片的 `last_seq` 大於那一行的筆數算不同）。沒有公布過的證明紀錄沒有這個檔可寫，等下一次每天的公布。寫檔失敗不影響已經換好的表：寫一行 `rebuild_card_state_file_not_written`，那一刻的狀態留在物件裡（`rebuilt_cards_at_published` 表），一分鐘後再寫，物件中途重啟也接著寫，寫成了才刪。

**物件是空的時候**（資料沒了，或搬到新的地方：`PROOF_LOG_OBJECT_NAME` 換了一個新的名稱，R2 上還是原本的檔）走同一條，只是讀的地方不同。物件沒有任何紀錄、沒有搬過檔、沒有公布過時：

- 從 R2 的 `proof-log/` 照檔名一檔一檔讀，讀到沒有下一檔或讀到一個沒寫滿的檔為止；指紋檔也從 R2 讀
- 核對的是 R2 的指紋檔最後一行。R2 上有紀錄檔卻沒有指紋檔時不換：沒有東西能說這些檔就是那份證明紀錄
- 換的時候多補三樣：最後一檔的紀錄（放回物件）、寫滿的檔的清單（每一檔的 SHA-256 和結尾的指紋）、公布過的每一行
- **最後一次公布之後的紀錄不在 R2 上，補不回來**（ADR-0033 的 Consequences）
- 重建完，物件要等清冊鏡像下一輪（每小時）告訴它最新的清冊，在那之前 `records` 回 `crl_stale`：最新的清冊不是從證明紀錄算得出來的

**看進度和結果。** `GET /api/v1/rebuild`（`docs/api/card-proof.md`）：名稱、狀態（`running`、`swapped`、`refused`）、做到第幾筆、沒換的原因。它是公開的，沒有營運者專用的入口；每一種裝置都不讀它。它每次都問物件（讀 `rebuild_state` 的那一列），回應和 API 的其他回應一樣帶 `Cache-Control: no-store`，沒有快取：和 `GET /api/v1/fingerprint` 是同一種請求，物件做的事是讀一列。ADR-0026 的 60 秒快取是訪客頁面的；會打到物件的 API 路徑靠的是那份 ADR 的限流（WAF 那一條規則把這些路徑合起來算，Worker 裡的 Rate Limiting binding），照 IP 的那一層有了（[限流](#限流)）：這個路徑和 `fingerprint`、`config` 算在同一類。沒有替它另外加快取：營運者要看的是當下做到第幾筆，而且重建進行中的回應每一步都在變。即時輸出（`wrangler tail` 或儀表板的即時紀錄，沒有開保存）每一步一行：

| 事件 | 什麼時候 |
|---|---|
| `rebuild_begun` | 開始 |
| `rebuild_step` | 做完一檔，`records` 是做到第幾筆 |
| `rebuild_swapped` | 換了 |
| `rebuild_refused` | 沒換，`reason` 是原因 |
| `rebuild_step_failed` | 這一步沒做成但重建還在（R2 沒有回應；檔案不在、不是物件寫的那一份則是 `rebuild_refused`）：等一分鐘再試，連續失敗時等得更久，最長一小時（[過期的題目怎麼刪](#過期的題目怎麼刪)的「失敗後多久再試」） |
| `rebuild_not_begun` | 有名稱但沒有開始：沒有停止收過卡，或開始時出錯 |

**之後營運者要做的**（ADR-0033）：看 `GET /api/v1/rebuild` 是 `swapped`；手動觸發一次重驗的工作流程，Go 逐張比過卡片狀態檔；兩個都過才恢復收過卡。完整的步驟寫成 playbook 是 [#109](https://github.com/iamreal-tw/iamreal/issues/109)。

**沒有做、沒有量的：**

- **多久沒有量過**，要在測試網站量，寫到 [#52](https://github.com/iamreal-tw/iamreal/issues/52)。一步要從 R2 讀一個約 20 MB 的檔、算 1,000 筆的雜湊、套 1,000 次規則。最後一步另外在一個交易裡把卡片狀態表和五張衍生表整份換掉，表越大越久；大到一次 alarm 做不完時，那一步會一直重來，換不過去。這個上限在哪裡也還沒有量。
- **指紋檔最後一行之後的紀錄**只用規則重算，沒有東西可以對：它們要到下一次每天的公布、下一次重驗才被比到。
- **清空測試的證明紀錄時**不要留著 `REBUILD_PROOF_LOG` 的名稱和停止收過卡：新的空物件會把儲存桶裡還沒清掉的舊檔讀進來（[清空測試的證明紀錄](#清空測試的證明紀錄)的步驟本來就先清儲存桶）。
- **沒有另外留一份每筆紀錄的精簡內容**（#107 的留言提過）：先只做從紀錄檔讀的這一條，物件的資料沒了時本來就只能這樣讀；太慢再加。
- **沒有在 Cloudflare 上跑過**：本機的 workerd 測過的寫在 `test/rebuild.test.ts`；在測試網站從儀表板觸發一次是營運者做的（[#110](https://github.com/iamreal-tw/iamreal/issues/110)）。
- **照日期切換規則版本**（ADR-0031）還沒有：現在只有一版規則在用。

## 清空測試的證明紀錄

測試的證明紀錄不定期清空（ADR-0028）：規則或紀錄的格式改了、測試的證明紀錄裡舊的紀錄照新規則讀不懂的時候，或要從空的證明紀錄試某種狀況的時候。這份說明裡碰到這兩種情況要清空的地方：存著的規則版本和程式的不同（`paused`）、表的版本和程式的不同（[兩個版本號](#兩個版本號)）。只有營運者能清；Worker 裡沒有任何清空證明紀錄的介面，正式網站上也就沒有這樣的程式。

**清空是換一個物件，不是刪掉資料。** `PROOF_LOG_OBJECT_NAME` 換成新的名稱之後，後台問的是一個新的、空的 Durable Object；資料儲存桶裡 `proof-log/` 底下的檔由營運者刪掉。原本的那個物件還在 Cloudflare 上，連同它存的紀錄；這些步驟不刪它，之後也沒有請求會到它那裡。

- **被換掉的物件不再做任何定時的工作。** 物件啟動時比對自己是不是設定指的那一個（`ctx.id.equals(env.PROOF_LOG.idFromName(env.PROOF_LOG_OBJECT_NAME))`，[Durable Object ID](https://developers.cloudflare.com/durable-objects/api/id/)：「`equals` is used to compare equality between two instances of `DurableObjectId`」，2026-11-21 讀的）；不是的話，alarm 響了什麼都不做，也不再設下一次（`src/proof-log.ts` 的 `#replaced`）。沒有這一條的話，它的 alarm 是還當著證明紀錄的時候設的，下一個台灣午夜照樣會響，把舊的證明紀錄的最後一檔、雜湊清單、卡片狀態檔和整份舊的指紋檔寫回同一個儲存桶：在本機照下面的步驟做的時候看到的就是這樣（`test/clearing.test.ts`，拿掉這一條就不過）。那之後新的物件要公布時，儲存桶裡的指紋檔不是它的，照[每天換日公布證明紀錄](#每天換日公布證明紀錄)會停在 `fingerprint_file_differs`。這個比對在 Cloudflare 上還沒看過：下面第 5 步的確認就是在看它。
- **被換掉的物件每次啟動寫一行即時輸出** `{"event":"proof_log_object_replaced","object":"<它的名稱>"}`（`wrangler tail` 或儀表板的即時紀錄，沒有開保存；名稱是 `ctx.id.name`，拿不到時是 `null`）。真的被換掉的物件最多寫一次：部署之後它的 alarm 響的那一次，啟動時就把 alarm 刪了，之後沒有東西會再叫醒它。兩種例外：部署傳到每個地方的那幾秒，還跑著舊設定的 Worker 可能再問到它，每叫醒它一次多一行；被換掉時本來就沒有 alarm 的物件（表的版本和程式不同的那種）不會被叫醒，一行都不寫。**現任的物件不該寫這一行**；每隔一陣子就看到它，表示比對把現任的物件當成被換掉的了，那時不公布、不搬寫滿的檔、不刪過期的題目，而過卡照收。不看即時輸出也看得出來：指紋檔不再每天多一行，`test/site-check.ts` 有一項看這個（[部署之後不插卡的檢查](#部署之後不插卡的檢查)）。
- **名稱不重複使用。** 把名稱改回用過的，後台問的就是那個舊物件，它存的紀錄都還在，也會重新開始公布。新的名稱用下一個號碼（`test-1` 之後是 `test-2`），維持 `test-` 開頭（[證明紀錄和物件的名稱要對得上](#證明紀錄和物件的名稱要對得上)）。
- **營運者刪儲存桶的檔，依據是 ADR-0028 和 ADR-0029。** 儲存桶只有 Worker 透過 binding 寫（ADR-0027、ADR-0029），例外有兩個，都寫在 ADR-0029：從副本換回一個檔（ADR-0033），和清空測試的證明紀錄時營運者在儀表板刪掉測試的儲存桶裡證明紀錄的目錄（ADR-0028「清空」）。正式的儲存桶沒有後面這個步驟。
- **`crl/` 不清。** 清冊存檔和證明紀錄無關，檔名是內容的雜湊。留著的話，過卡的頁面一直下載得到清冊，鏡像也不必重抓、重建每一棵樹。

### 步驟

照順序做。第 1、2 步 agent 可以做到開 PR 為止；第 3、4 步只有營運者能做。

1. **改設定，開 PR。** `wrangler.jsonc` 的 `env.test.vars`：
   - `PROOF_LOG_OBJECT_NAME`：下一個號碼
   - `TEST_PROOF_LOG_CLEARED_ON`：部署那一天的台灣日期，`YYYY-MM-DD`

   [設定檔](#設定檔)表格裡的這兩個值跟著改。要改的只有這兩個檔：測試的工具從 `wrangler.jsonc` 讀物件的名稱，看頁面上日期的測試各自設自己的日期，沒有測試寫死這兩個值（把這兩個值換成 `test-2`、`2026-11-20` 跑過 `worker/` 整套，都過）。
   - 測試擋得到的：名稱是 `test-` 開頭、日期是日曆上有的日期（[`test/environments.test.ts`](test/environments.test.ts)）；日期不在今天（台灣日期）之後（[`test/clearing.test.ts`](test/clearing.test.ts)）。
   - **測試擋不到的：只改了名稱、忘了改日期，或日期填成更早的某一天。** 兩個值各自都合法，測試看不到上一次的值。看 PR 的人要看這兩行是不是一起改的；部署之後首頁最上面那一行的日期是另一次機會。`wrangler.jsonc` 是「部署會執行到的東西」（`CONTRIBUTING.md`），這個 PR 由營運者看過才合併。清空是因為程式改了的時候（規則的版本加了一號），這兩行和那個修改放在同一個 PR，或緊接著合併：改名稱的部署先出去的話，新的物件第一次啟動時記下的是舊程式的版本號，程式一換又是 `paused`。
2. **部署。** 合併到 `main`，由 GitHub Actions 部署（[從 GitHub Actions 部署](#從-github-actions-部署)）；或營運者在自己的電腦上 `pnpm run deploy:test`。部署完成之後：
   - `curl -s https://test.iamreal.tw/api/v1/fingerprint` 回 `{"date":null,"count":0,"fingerprint":"000…0"}`（64 個 0）：後台問的是新的物件，它還沒公布過
   - 首頁最上面那一行的日期是新的日期，兩個數字都是 0。頁面最多被快取 60 秒，剛部署完看到舊的，過一兩分鐘再看
   - **從這時候到鏡像的下一輪（整點，最長一小時），過卡送出會回 `crl_stale`**：新的物件不知道任何一份清冊，鏡像每一輪一開始把索引列著的最新清冊交給證明紀錄的物件（[排程做什麼](#排程做什麼)第三步）。發題目、查卡片現況照常
3. **營運者清空儲存桶的 `proof-log/`。** 在 Cloudflare 的儀表板：R2 → `iamreal-test-data` → 勾「View prefixes as directories」→ 選 `proof-log/` 這個目錄 → Delete（[Delete objects](https://developers.cloudflare.com/r2/objects/delete-objects/)：「Select the objects or folders you want to delete」，2026-11-21 讀的）。`crl/` 不要選。部署的權杖做不到這一步：它沒有 R2 的權限，連讀儲存桶的資料都被拒絕（[第一次部署量到的](#第一次部署量到的)），這個專案也沒有 R2 的 API 權杖（ADR-0029）。
   - **在部署之後做，不要在之前。** 部署之前，舊的物件還是證明紀錄的物件：台灣午夜一到它會把剛刪掉的檔再寫出來。
   - **在部署後的第一個台灣午夜之前做完最好。** 新的物件在它第一次啟動那天不公布，隔天的台灣午夜才第一次公布。那時 `proof-log/fingerprints.jsonl` 還是舊的證明紀錄的那一份的話，這一次公布整個不做（`fingerprint_file_differs`），之後每隔一段時間再看一次（最長一小時），到 `proof-log/` 清掉為止；清掉之後的下一次嘗試就公布，不用再部署（`test/clearing.test.ts` 的第二項）。舊的證明紀錄從來沒有公布過（沒有指紋檔）的話不會停，但舊的卡片狀態檔會留到生命週期規則刪掉它。
   - 清完之後：`curl -sI https://test-data.iamreal.tw/proof-log/fingerprints.jsonl` 回 `404`。`-I` 送的是 `HEAD`，這個網域上 `HEAD` 不經過 Cloudflare 的快取（回應是 `cf-cache-status: DYNAMIC`，2026-11-21 看到的），所以刪了馬上就是 `404`；用 `GET` 下載的人最多 60 秒內還會拿到快取著的舊檔
4. **營運者清資料網域上 `proof-log/` 的快取。** 舊的證明紀錄有寫滿的紀錄檔（滿 1,000 筆）時才需要；沒有的話 `proof-log/` 底下每個檔都只快取 60 秒，等一分鐘就好，做了也無妨。在 Cloudflare 的儀表板：`iamreal.tw` 這個 zone → Caching → Configuration → Purge Cache → Custom Purge → Purge by 選 Prefix → 填 `test-data.iamreal.tw/proof-log` → Purge（[Purge cache by prefix](https://developers.cloudflare.com/cache/how-to/purge-cache/purge_by_prefix/)，2026-11-21 讀的；每一種方案都能用，[Purge cache](https://developers.cloudflare.com/cache/how-to/purge-cache/)「Availability and limits」）。部署的權杖只有一個 Worker 的權限（ADR-0029），做不到這一步。
   - **為什麼要清**：寫滿的紀錄檔和它的雜湊清單標的是 `public, max-age=31536000, immutable`（[寫滿的紀錄檔搬到 R2](#寫滿的紀錄檔搬到-r2)），那是照「同一個網址的內容不會再變」標的。清空之後新的證明紀錄從 0 筆開始，寫滿第一檔時用的是同一個網址 `proof-log/0000000000000000.jsonl`，內容不同。不清的話，Cloudflare 上快取著舊檔的地方最長一年照樣送舊檔。
   - **在第 3 步之後做。** 先清快取、後刪檔的話，中間有人下載，舊檔又被快取一年。
   - **用 Prefix，不用 Single-file（URL）。** 資料網域的回應帶 `Vary: Origin`（2026-11-21 線上看到的）；Cloudflare 的文件寫，從儀表板照網址清，清不掉請求帶 `Origin` 的那一份（[Purge by single-file](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-single-file/)「Resources with special headers」：「A single-file purge performed through your Cloudflare dashboard does not clear objects that contain any of the following: Origin header…」，2026-11-21 讀的）。照前綴清的文件寫的是那個目錄底下的每一個網址都清（Purge cache by prefix：「any URI for a resource within the purged directory is purged」），沒有另外講帶 `Origin` 的那一份，所以下面確認時兩種都問。
   - **清完之後確認，用 `GET`**：舊的證明紀錄每一個寫滿的檔（檔名 0、1000、2000……小於舊的證明紀錄筆數的每一個）和它的雜湊清單，帶和不帶 `Origin` 各下載一次，都要是 `404`，而且不是 `cf-cache-status: HIT`（文件：「To verify a purge, request the asset after purging and confirm that `CF-Cache-Status` is no longer `HIT`」，[Purge cache](https://developers.cloudflare.com/cache/how-to/purge-cache/)）。回 `200`、`HIT` 就是快取裡還有舊檔。

     ```sh
     for f in proof-log/0000000000000000.jsonl proof-log/hashes/0000000000000000.txt; do
       curl -s -o /dev/null -D - "https://test-data.iamreal.tw/$f" | grep -i -e '^HTTP' -e '^cf-cache-status' -e '^age'
       curl -s -o /dev/null -D - -H 'Origin: https://test.iamreal.tw' "https://test-data.iamreal.tw/$f" | grep -i -e '^HTTP' -e '^cf-cache-status' -e '^age'
     done
     ```

     - **不能用 `curl -I`。** `-I` 送的是 `HEAD`，這個網域上 `HEAD` 不經過快取、直接問儲存桶：第 3 步刪了檔之後，不管快取清了沒有都是 `404`。2026-11-21 對一份標一年的清冊檔（`crl/<SHA-256>.crl`）看到的：`GET` 是 `cf-cache-status: HIT`、帶著 `age`，同一個網址的 `HEAD` 是 `DYNAMIC`。
     - **帶和不帶 `Origin` 是兩份快取，兩種都要問。** 同一天對同一個檔：不帶 `Origin` 的 `GET` 是 `HIT`、`age` 約 144,000 秒；帶 `Origin: https://test.iamreal.tw` 的是另一份（第一次 `MISS`，接著 `HIT`、`age` 幾十秒，帶 `Access-Control-Allow-Origin`）。過卡的頁面在瀏覽器裡下載時帶的是後面那一種。
     - **每個來源各有一份，指令問不完。** 2026-11-21 對指紋檔 `fingerprints.jsonl`（當時在改名之前的目錄）用 `GET` 看到的：不帶 `Origin` 的第二次是 `HIT`；帶 `Origin: https://test.iamreal.tw` 的第一次 `MISS`、第二次 `HIT`，多 `Access-Control-Allow-Origin`；帶別的來源的又是它自己的一份，第一次 `MISS`、第二次 `HIT`，沒有那個標頭。所以任何一個網站的頁面下載過舊檔，快取裡就多一份帶它那個來源的。照前綴清會不會把這些都清掉，文件沒有講；測試的證明紀錄還沒有寫滿的檔，現在也驗不到。上面的指令只問得到不帶來源和帶測試網站來源的這兩份。
     - 不存在的檔不會被快取（`404` 的回應是 `cf-cache-status: BYPASS`，同一天看到的），所以清乾淨之後這兩行都是 `404`，不會因為問過一次就留下東西。
     - 新的證明紀錄已經公布過才做這一步的話，`proof-log/0000000000000000.jsonl` 可能是新的證明紀錄還沒寫滿的最後一檔：`200`，`Cache-Control` 是 `public, max-age=60`，不是一年的那一種。
     - 這個指令問到的應該只是回答這一次請求的那個 Cloudflare 機房：這是從文件推的，沒有實測。文件寫清掉的檔之後是在「the specific Cloudflare data center that served the request」重新放進快取（[Purge by single-file](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-single-file/)），也就是每個機房各有自己的一份；其他機房沒辦法從外面一個一個問。
5. **確認。**
   - `node --experimental-strip-types test/site-check.ts`（[部署之後不插卡的檢查](#部署之後不插卡的檢查)）全過。新的證明紀錄還沒公布過，所以指紋檔那兩項比的是「沒有檔、介面回的日期是 `null`」。**它全過不表示可以過卡**：它只送 `GET`，看不到證明紀錄是不是 `paused`，也看不到新的物件知不知道清冊，這兩種狀態下每個 `GET` 的回答都和平常一樣
   - **證明紀錄收不收過卡**：送一次 `curl -s -X POST https://test.iamreal.tw/api/v1/challenges`。這是唯一會寫入的確認：後台存一個題目，10 分鐘後不認得，之後定時刪掉（[過期的題目怎麼刪](#過期的題目怎麼刪)），證明紀錄裡不留任何東西。agent 送之前要營運者同意。

     | 回應 | 意思 |
     |---|---|
     | `200`、`{"challenge":"<今天的台灣日期>.…"}` | 收。存著的規則版本和程式的相同 |
     | `503`、`{"error":"paused"}` | 不收：物件存著的規則版本和程式的不同（[兩個版本號](#兩個版本號)）。剛清空就看到這個，表示後台問的還是舊的物件（設定沒有部署出去），或新的物件是在程式換掉之前第一次啟動的（第 1 步講的順序） |
     | `500` | 設定對不上（`PROOF_LOG_KIND` 和名稱、`TEST_PROOF_LOG_CLEARED_ON` 不是日期），或表的版本和程式的不同 |

   - **新的物件知不知道清冊，沒有不過卡就能確認的方法。** 發題目不看清冊，`200` 不表示送出不會回 `crl_stale`。靠的是時間：部署後的第一個整點那一輪鏡像交給它（第 2 步）。那一輪有沒有成功，看儀表板上排程的那一次是不是成功的，或 `wrangler tail` 那一輪沒有以例外結束（[排程做什麼](#排程做什麼)：沒交給 Durable Object 的一輪以例外結束）。整點過後第一次真的過卡（營運者用真卡片）才是最後的確認
   - 部署後的第一個台灣午夜過後：`https://test-data.iamreal.tw/proof-log/fingerprints.jsonl` 恰好一行，日期是那一天，筆數是新的證明紀錄的筆數；`proof-log/card-state/` 只有那一天的檔。這一行多於一行、或筆數是舊的證明紀錄的筆數，表示被換掉的物件還在寫（上面「被換掉的物件」那一條在 Cloudflare 上沒有成立），那時回報，不要再刪一次了事
   - 然後 `iamreal-verify -proof-log test -data https://test-data.iamreal.tw/` 重驗一次（[`cmd/iamreal-verify/README.md`](../cmd/iamreal-verify/README.md)）

### 做到一半停下來時

| 停在 | 測試網站的狀態 | 接下來 |
|---|---|---|
| 第 1 步的 PR 還沒合併 | 沒有變。清空是因為 `paused` 的話，照舊不收過卡，頁面照常 | 合併 |
| 部署沒有成功 | 用 `GET /api/v1/fingerprint` 看：回的還是舊的證明紀錄的那一行，就是沒有換 | 修好再部署 |
| 部署了，`proof-log/` 還沒清 | 後台和頁面已經是空的證明紀錄；資料網域上還是舊的證明紀錄的檔，`iamreal-verify` 重驗資料網域看到的是舊的證明紀錄。隔天起不公布，每次嘗試一行 `fingerprint_file_differs` | 做第 3 步 |
| `proof-log/` 清了，快取還沒清 | 舊的證明紀錄有寫滿的檔時，那幾個網址在快取著它的地方還是舊檔（最長一年）；其餘同下一列 | 做第 4 步 |
| `proof-log/` 和快取都清了，還沒到午夜 | 資料網域上沒有證明紀錄的檔（`404`），`iamreal-verify` 當成公布了 0 筆、報少了指紋檔 | 等午夜，做第 5 步 |

清空之後，測試網站上原本的島民證明連結都是「找不到」，頁面上的清空日期說明原因（ADR-0028）。別人下載過的舊的證明紀錄收不回來（`design/copy/privacy.md`）。

### 清不到的快取

第 4 步清的只有 Cloudflare 自己的快取。清不到的：

- **瀏覽器的快取。** 用瀏覽器打開過舊的證明紀錄寫滿的檔的人，瀏覽器在一年內可以直接用存著的那一份，重新整理也不必再問（`immutable`：「The user should not send a conditional revalidation request … to check for updates, even when the user explicitly refreshes the page」，[Cloudflare 的 Cache-Control 說明](https://developers.cloudflare.com/cache/concepts/cache-control/)，2026-11-21 讀的）。清掉瀏覽器自己的快取才會拿到新的。
- **Cloudflare 以外的快取。** 回應標的是 `public`，下載的人和 Cloudflare 之間的代理伺服器可以存一年。
- **已經下載到自己電腦上的檔。**

`iamreal-verify` 自己沒有快取，但它送的是一般的 `GET`，一樣經過 Cloudflare 的快取：它拿到的是回答它的那個機房存著的、不帶 `Origin` 的那一份。所以第 4 步清到了，它拿到的才是新的；第 4 步沒做或沒清到，它也會拿到舊檔。它不受影響的只有瀏覽器的快取那一層。過卡的頁面只從資料網域拿 `crl/`，不拿 `proof-log/`，不受影響。

**重驗的人拿到舊檔時會看到什麼。** 舊的證明紀錄的檔本身是一份完整的紀錄檔，每一行都讀得懂，所以不會是「讀不懂」；對不上的是它和每天重寫的那幾樣（指紋檔、還沒寫滿的最後一檔的雜湊清單、卡片狀態檔，都只快取 60 秒）：

- 紀錄檔是舊的、指紋檔是新的：指紋檔的行對不上證明紀錄，`iamreal-verify` 每一行印 `fingerprints.jsonl line <行號>: fingerprint … is not the proof log fingerprint of the first <筆數> records, …`，或筆數超過時 `count <筆數>, but the proof log has <筆數> records`
- 紀錄檔和雜湊清單一新一舊：`<檔名> is not the record hash list of the proof log`
- 卡片狀態檔和從舊紀錄算出來的卡片逐張不同

這幾種結束碼都是 1（[`cmd/iamreal-verify/README.md`](../cmd/iamreal-verify/README.md)「紀錄目錄」）。在測試的證明紀錄裡看到這些，先看拿到的紀錄檔是不是清空之前的：頁面最上面寫著上次清空的日期，紀錄檔裡的紀錄比它早就是。那時先分是哪一層的快取：檔是用瀏覽器下載的，清掉瀏覽器的快取，或改讓 `iamreal-verify` 自己下載（`-data https://test-data.iamreal.tw/`），就不經過瀏覽器的那一層；`iamreal-verify` 自己下載的還是舊檔，最可能是 Cloudflare 的快取沒清到（第 4 步沒做，或回答你的那個機房還留著），也可能是你和 Cloudflare 之間的代理存著舊檔；從外面分不出是哪一種。換一個網路再下載一次；還是舊檔就在這個程式庫開 issue，請營運者再做一次第 4 步。正式的證明紀錄不清空，同一個網址的內容不會變，沒有這個問題。

### 在本機照著做

[`test/clearing.test.ts`](test/clearing.test.ts) 在本機的 workerd 上照上面的步驟做一次：一份有紀錄、公布過的測試的證明紀錄；換物件的名稱和日期、所有物件重新啟動（部署）；刪掉儲存桶的 `proof-log/`；鏡像跑一輪；寫入新的一筆；過兩個台灣午夜，舊的物件的 alarm 各響一次。它確認每一步之後這裡寫的狀態，被換掉的物件寫了一行 `proof_log_object_replaced`、沒有設 alarm，和兩個午夜之後儲存桶裡只有新的證明紀錄的檔、沒有 `fingerprint_file_differs`。第二項是晚了才清儲存桶的情況：午夜時不公布、寫一行 `fingerprint_file_differs`、舊的證明紀錄的檔原樣留著，清掉之後的下一次 alarm 就公布。儀表板上的那兩個動作（選目錄、刪除）本機做不到，用測試的工具刪檔代替。

## 部署之後不插卡的檢查

```sh
node --experimental-strip-types test/site-check.ts
node --experimental-strip-types test/site-check.ts https://test.iamreal.tw https://test-data.iamreal.tw   # 同上，寫明兩個網址
node --experimental-strip-types test/site-check.ts http://localhost:8080 http://localhost:8080             # pnpm local 的本機 Worker
```

兩個網址同一個來源時，當成 `pnpm local` 的本機 Worker（[在本機用真卡片過卡](#在本機用真卡片過卡)；`pnpm local` 啟動時自己跑一次）：不看資料網域的 CORS（頁面從自己的網域讀），也不看每天的公布（本機的證明紀錄只在指令開著跨過午夜時公布），其他各項照樣。

[`test/site-check.ts`](test/site-check.ts) 對部署好的測試網站和它的資料網域只送 `GET`，每檢查一樣印一行（`ok` 或 `FAIL`），有一項不過結束碼是 1。不用卡片、不開瀏覽器、不用權杖，不會對內政部的元件送任何請求，可以隨時重跑。它檢查：

- Worker 產生的每一種頁面（首頁、島民證明的「找不到」、查詢頁、證明紀錄頁、常見問題、如何驗證證明紀錄、如何檢查 Threads 帳號的島民證明、過卡需要什麼、隱私權說明、掛上去、「找不到這一頁」）：狀態碼、[頁面送的標頭](#頁面送的標頭)的每一項、不設 cookie、頁面上有測試的證明紀錄的標示和 `noindex`，標示旁的日期是這個 checkout 的 `wrangler.jsonc` 寫的 `TEST_PROOF_LOG_CLEARED_ON`。島民證明用範例的短編號 `7K2Q9FM4XD`，要回 `404`
- 沒有一頁有不是自己網站的 script：Worker 產生的頁面和 `/proof` 都看。頁面裡每一個 `<script>` 都要有 `src`、而且指到自己網站的路徑；別的網域的、寫在頁面裡的都不過（這個程式庫的頁面沒有寫在頁面裡的 script）
- 每個請求都照瀏覽器的送法：頁面帶 `Accept: text/html`，其餘帶 `Accept: */*`。Worker 和訪客之間的東西（Cloudflare 的功能）可能只在這種請求上改頁面：2026-11-21 就是這樣，不帶這個標頭的 `curl` 看不到被加進去的 script
- 樣式表、複製按鈕的程式、圖示、字型、連結預覽圖、過卡的頁面 `/proof` 在不在，和它們帶的 `noindex`、`nosniff`；說明頁的舊網址 `/proof/help.html` 是 `301` 到 `/prepare`
- `GET /api/v1/config`、`GET /api/v1/fingerprint` 的狀態碼和標頭；`config` 是測試的證明紀錄的平台表，`crl_max_age_days` 是 3
- 資料網域的 `crl/index.jsonl`：兩把發證金鑰各有一份可用的清冊，清冊日期不早於今天（台灣日期）往前 3 天
- 資料網域的 `proof-log/fingerprints.jsonl` 最後一行就是 `GET /api/v1/fingerprint` 回的那一行；證明紀錄還沒公布過時（沒有檔），介面回的日期要是 `null`
- 證明紀錄每天有在公布：`GET /api/v1/fingerprint` 回的日期是今天或昨天（台灣日期）。公布在台灣午夜之後 alarm 響的時候做，所以午夜剛過、還沒公布時最後一行是昨天的，照樣過；要到整整一天沒有公布才不過。`paused` 的證明紀錄不公布，隔一天起這一項不過，那是對的。日期是 `null`（還沒公布過）只在今天不晚於 `wrangler.jsonc` 的上次清空日期加 2 天時算過：清空當天物件第一次啟動，隔天午夜公布第一行；部署剛好壓在午夜前、物件隔天才第一次啟動的話再晚一天。過了這兩天還是 `null`，就是新的物件沒有在公布（啟動時就是 `paused`，或把自己當成被換掉的），不過
- 資料網域的 CORS：帶 `Origin: https://test.iamreal.tw` 問 `crl/index.jsonl`，回應的 `Access-Control-Allow-Origin` 是它；帶別的來源問，沒有這個標頭。過卡的頁面在瀏覽器裡下載清冊存檔靠的是這個（ADR-0027）

[`test/site-check.test.ts`](test/site-check.test.ts) 在本機的 Worker 上跑同一段檢查：照部署的樣子全過（隔天、午夜的 alarm 還沒響時也過）；下面每一樣各自只讓它的那一行不過：清冊舊於 3 天、少一把發證金鑰的清冊；一頁的狀態碼不對、少一個標頭、設了 cookie、頁面裡沒有 `noindex`、標示旁的日期不對；沒有過卡的頁面、樣式表的 `Cache-Control` 不對；頁面在送給瀏覽器的路上被加了別的網域的 script 或寫在頁面裡的 script；`config` 的平台表不是測試的證明紀錄的、`crl_max_age_days` 不是 3、回應可以被快取；指紋檔最後一行和介面回的不同、介面說公布過卻沒有指紋檔；最後一行的日期比昨天早、清空超過兩天還沒公布過；過卡的頁面被加了 script、不在，說明頁的舊網址還回 `200`；資料網域不讓測試網站讀、或讓別的網站讀。資料網域在測試裡是儲存桶的模擬加上營運者設的那條 CORS 規則。`local` 時少那兩行，資料網域沒有 CORS 的標頭、清空很久還沒公布過也全過，清冊太舊照樣不過。

**它只送 `GET`，所以回答不了「現在能不能過卡」。** 證明紀錄 `paused`（存著的規則版本和程式的不同）時、清空之後新的物件還不知道清冊時（送出回 `503` `crl_stale`），每個 `GET` 的回答都和平常一樣，這支程式照樣全過。要知道證明紀錄收不收過卡，送一次 `POST /api/v1/challenges`（[清空測試的證明紀錄](#清空測試的證明紀錄)第 5 步有每一種回應的意思）；那是寫入的請求，不在這支程式裡。

**它不開瀏覽器，所以過卡的頁面只看在不在。** 頁面在瀏覽器裡的那一半（標頭、跨來源隔離、證明引擎啟動、沒有違反 CSP、沒有連到別的網域，開到第一個畫面為止、不按「讀取卡片」）是 `web/` 的 [`test/e2e/smoke.ts`](../web/test/e2e/smoke.ts)（`web/README.md`）；它對線上跑的結果在 [Static Assets](#static-assets)「Cloudflare 上還沒確認的」。

**2026-11-21 對 `main` 的 `1400e11` 部署出去的版本**：21 項過 20 項。不過的是「沒有一頁有不是自己網站的 script」，十個頁面都列在那一行：Cloudflare 在每一個 HTML 頁面加了一個別的網域的 script（[Static Assets](#static-assets)「Cloudflare 上看過的」最後一段），營運者當天關掉（[#240](https://github.com/iamreal-tw/iamreal/issues/240)）之後重跑，21 項全過。改成照瀏覽器的送法之後，其他各項的結果沒有變。

## 營運者在 Cloudflare 和 GitHub 上設的

部署的權杖做不到、由營運者在儀表板手動做的事（ADR-0029）。測試網站的這幾項是 2026-11-19 做的（[#58](https://github.com/iamreal-tw/iamreal/issues/58)，那裡有做的時候和原本計畫不同的地方）；之後加正式環境時照同一份做，名稱換成正式的。程式和部署靠的是右邊那一欄。

| 在哪裡 | 設了什麼 | 程式和部署靠它的地方 |
|---|---|---|
| Cloudflare 的 DNS | `iamreal.tw` 的名稱伺服器在 Cloudflare | 兩個自訂網域要這個 zone 在 Cloudflare 上 |
| Cloudflare 的帳號 | Workers 的付費方案 | 驗一筆證明、建一棵樹的 CPU 時間（ADR-0023；[設定檔](#設定檔)的 `limits.cpu_ms`） |
| Workers | Worker `iamreal-test`，從 Hello World 範本建的（儀表板不能建空的）；自訂網域 `test.iamreal.tw` | 部署的權杖建不了 Worker、改不了自訂網域。`workers.dev` 的網址由 `wrangler.jsonc` 的 `workers_dev: false` 關掉 |
| R2 | 儲存桶 `iamreal-test-data`，位置 Automatic、存放等級 Standard；自訂網域 `test-data.iamreal.tw` | `wrangler.jsonc` 的 `r2_buckets`；部署不建任何資源（`--experimental-provision=false`，[第一次部署量到的](#第一次部署量到的)） |
| R2 儲存桶的 CORS | 只允許 `https://test.iamreal.tw` 用 `GET` | 過卡的頁面從資料網域下載清冊存檔（ADR-0027） |
| R2 儲存桶的生命週期規則 | `card-state-7-days`：前綴 `proof-log/card-state/`（[#277](https://github.com/iamreal-tw/iamreal/issues/277) 之前是改名之前的目錄），物件建立 7 天後刪除（[#185](https://github.com/iamreal-tw/iamreal/issues/185)） | 程式不刪卡片狀態檔（[每天換日公布證明紀錄](#每天換日公布證明紀錄)「部署後要營運者做的」） |
| 連線紀錄的儲存桶 `iamreal-test-logs`（[#415](https://github.com/iamreal-tw/iamreal/issues/415)） | Public Access 關著，沒有網域、沒有 CORS。生命週期規則 `connection-31-days`：前綴 `connection/`，物件建立 31 天後刪除。計數的明細在同一個儲存桶：規則 `count-events-31-days`，前綴 `count-events/`，31 天後刪除（2026-11-26，[#54](https://github.com/iamreal-tw/iamreal/issues/54)）；`count-totals/` 不設規則（[計數](#計數)）。不設 bucket lock | 後台存 IP 的地方，留 31 天（ADR-0022，[連線紀錄](#連線紀錄)）。規則沒有在刪時，公開的 `connection-log/oldest.json` 看得出來 |
| `test-data.iamreal.tw` 的快取規則 | 可以快取；Edge TTL 選「有 `Cache-Control` 就照它，沒有就不快取」，Browser TTL 照物件的標頭。儀表板沒有「沒有就用 60 秒」這個選項 | 所以後台寫進儲存桶的每個物件都自己設 `Cache-Control`：會變的 60 秒，不會變的一年（[排程做什麼](#排程做什麼)、[寫滿的紀錄檔搬到 R2](#寫滿的紀錄檔搬到-r2)、[每天換日公布證明紀錄](#每天換日公布證明紀錄)）；沒設的物件不會被快取 |
| Real User Measurements（Web Analytics） | `iamreal.tw` → Speed → Real user monitoring 選 **Disable completely**（2026-11-21，[#240](https://github.com/iamreal-tw/iamreal/issues/240)）。沒設定過時是開著的：每個 HTML 頁面會被加一個 `static.cloudflareinsights.com` 的 `<script>`（[Static Assets](#static-assets)「Cloudflare 上看過的」最後一段）。正式的網域在第一次部署之前同樣關掉 | 頁面只載入自己網域的資源（`CONTRIBUTING.md`「頁面」）、沒有第三方的程式（ADR-0032）。`test/site-check.ts` 的「沒有一頁有不是自己網站的 script」檢查它 |
| `iamreal.tw` 這個 zone | 新增網域時關掉「Bot Preference Sync」：它會在網站的 `robots.txt` 前面插入 Cloudflare 的設定；AI 爬蟲的政策留預設 | `robots.txt` 由程式決定 |
| Cloudflare 的 API 權杖 | 兩把 Account API token：範圍「Specified Workers → `iamreal-test`」，權限「Individual Workers: Editor」。`iamreal-test-ci` 放在程式庫的 Actions secrets（`CLOUDFLARE_API_TOKEN_TEST`，帳號編號是 `CLOUDFLARE_ACCOUNT_ID`），`iamreal-test-local` 放在營運者電腦的 `.env.local`，同樣兩個名稱 | [部署測試環境](#部署測試環境)。這把權杖做得到和做不到的事在[第一次部署量到的](#第一次部署量到的) |
| GitHub 組織的 Actions 設定 | 所有外部貢獻者的工作流程都要先核准才跑 | ADR-0029「外人的 PR」 |

平常要營運者動手的只有三件：看過並合併動到「部署會執行到的東西」的 PR（`CONTRIBUTING.md`）、清空測試的證明紀錄時清儲存桶和資料網域的快取（[清空測試的證明紀錄](#清空測試的證明紀錄)第 3、4 步）、用真卡片過卡。從營運者的電腦部署測試網站是 `pnpm run deploy:test`（[部署測試環境](#部署測試環境)）。

## 套件

都釘精確版本。

在 Worker 裡執行的套件只有一個：

- `msgpackr` 1.12.1：呼叫 Barretenberg 的 WASM 用的編碼，和 bb.js 6.0.0 用的是同一版（[#59](https://github.com/iamreal-tw/iamreal/issues/59)）。只有 [`src/barretenberg.ts`](src/barretenberg.ts) 引用它

四個開發用的套件：

- `wrangler`（連帶 `miniflare`、`workerd`、`esbuild`）：在本機跑 Worker、打包、部署
- `typescript`、`@types/node`：型別檢查，版本和 `protocol/`、`web/` 相同
- `@aztec-foundation/bb.js` 6.0.0：只在建置時讀它裡面的 WASM 檔（[驗證證明](#wasm-檔和驗證金鑰從哪裡來)），它的程式不進 Worker。`web/` 用的是同一版，lockfile 裡本來就有

部署出去的程式裡的外部套件就是 `msgpackr`，另外帶 WASM 檔和兩把驗證金鑰：清冊鏡像用 Poseidon2 建樹，它們跟著進了部署的那一包。

沒有任何套件的安裝腳本會執行。有安裝腳本的三個套件列在根目錄 `pnpm-workspace.yaml` 的 `ignoredBuiltDependencies`：`workerd` 和 `esbuild` 的執行檔是各自平台的套件直接帶的，安裝腳本沒跑也能用；`msgpackr-extract` 是 `web/` 那邊的。

wrangler 執行時對外送的東西：使用統計關掉了（設定檔的 `send_metrics`，指令再加 `WRANGLER_SEND_METRICS=false`）。它印開頭那一行時會問 npm 有沒有新版，測試和部署的指令用 `WRANGLER_HIDE_BANNER=true` 關掉那一行；設定檔有警告或 wrangler 自己出錯時，它還是會問。

## 檔案

| 檔案 | 內容 |
|---|---|
| `wrangler.jsonc` | Worker 專案的設定 |
| `src/index.ts` | 進入點：HTTP（`/api/` 交給 `src/api.ts`，其他交給 `src/visitor.ts`）和排程 |
| `src/visitor.ts` | `/api/` 以外的網址：每一種訪客頁面和複製按鈕的程式；方法、轉址、`404`、快取、出錯時的那一行 |
| `src/headers.ts` | 頁面和檔案送的標頭，只定義在這裡 |
| `src/page-data.ts` | 頁面讀證明紀錄的介面 `PageData`，和問 Durable Object 的那一個實作 |
| `src/views.ts` | 頁面用的衍生表：建表、一筆紀錄寫什麼、清空和照一串紀錄重寫、頁面的查詢、數有幾張卡片宣告同一個帳號 |
| `src/pages/` | 把資料變成 HTML：`html.ts`（跳脫）、`layout.ts`（每一頁的外框、導覽列、頁尾、測試的證明紀錄的標示、程式的 `<script>`）、`home.ts`、`proof.ts`（島民證明）、`account.ts`（查詢頁）、`proof-log-page.ts`（證明紀錄頁和 `?after=` 的讀法）、`record-words.ts`（一筆紀錄做了什麼的寫法，島民證明頁的「全部紀錄」和證明紀錄頁共用）、`faq.ts`（常見問題，首頁的八題也讀它）、`verify.ts`、`hang.ts`、`not-found.ts`（找不到這一頁） |
| `demo/` | 掛上去的示範的播放程式的原始檔 `player.js`；送出去的是 `site/demo.js` |
| `site/` | Static Assets 的檔案，Cloudflare 直接送：`pages.css`、`copy.js`、`demo.js`、`favicon.ico`、`fonts/`、`og-image.png`、`_headers`、`_redirects` 在版控裡，`proof/` 放 `web/` 的建置 |
| `src/api.ts` | `/api/` 底下的介面：路徑和方法、每個回應的標頭、每個介面、後台自己出錯時的那一行 |
| `src/counts.ts` | 收計數的 Durable Object：一分鐘的計數放在記憶體、寫成 `count-events/` 底下的一個檔、每分鐘的上限（[計數](#計數)） |
| `src/submission.ts` | 讀 `records` 的請求：`malformed`、`scope`、`platform` 各是哪一種 |
| `src/record-proof.ts` | 從一筆紀錄的欄位重建公開輸入、交給驗證器 |
| `src/json.ts` | 讀請求的 JSON，鍵重複就拒絕 |
| `src/mirror.ts` | 清冊鏡像：介面 `CrlMirror` 和在 Worker 裡做的那一個 |
| `src/crl.ts`、`src/crl-time.ts` | 讀一份清冊：可不可用、原因代碼、索引那一行的欄位、樹的鍵 |
| `src/crl-tree.ts` | 從鍵算樹根 |
| `src/crl-index.ts` | 索引的寫法和順序、最新兩份可用的清冊 |
| `src/proof-log.ts` | 證明紀錄的 Durable Object：建表、發題目、算送出的次數、寫入一筆、讀卡片現況、刪過期的題目、把寫滿的紀錄檔搬到 R2、重建衍生表、存鏡像交給它的最新清冊 |
| `src/proof-log-files.ts` | 紀錄目錄在資料儲存桶裡的位置、`Cache-Control` 和 `Content-Type`；寫一個物件並讀回來核對；讀回一個寫滿的紀錄檔 |
| `src/card-table.ts` | 卡片狀態表：建表的程式，讀（連同檢查）和寫一張卡片的狀態 |
| `src/slot-json.ts` | 一個名額寫成 JSON 的那一種寫法：`card-state` 的回應和卡片狀態表共用 |
| `src/settings.ts` | 環境的設定：這個環境用哪一份證明紀錄、它的平台表、有沒有更換政策 |
| `src/target.ts`、`src/issuers.ts` | 部署用的發證金鑰、清冊網址、時鐘、等清冊的上限、補舊檔的界線 |
| `src/round-budget.ts` | 鏡像一輪假設自己拿得到的 CPU 時間（和 `wrangler.jsonc` 的 `limits.cpu_ms` 相同）、留給最大一份清冊的時間、補舊檔的界線 |
| `src/in-worker.ts` | 在 Worker 裡用的 `proofVerifier` 和 `poseidon2Hash`：把下面幾個檔和 WASM 檔、驗證金鑰接起來，只有它引用 `generated/` |
| `src/verify.ts` | 驗證證明的介面 `ProofVerifier`、呼叫 Barretenberg 之前的檢查 |
| `src/poseidon2.ts` | Poseidon2 的雜湊 |
| `src/circuits.ts` | 接受的電路：名稱、哪一把發證金鑰、公開輸入的個數、驗證金鑰的 SHA-256。`worker/` 裡電路的清單只有這一份 |
| `src/engine.ts`、`src/barretenberg.ts` | Barretenberg 的實例（丟例外或答覆不對就換）、WASM 的載入程式 |
| `scripts/engine-files.ts` | 建置的第一步：核對 WASM 檔和驗證金鑰的 SHA-256，寫進 `generated/` |
| `test-build/` | 測試專用的建置換上的那一份 |
| `test/harness.ts`、`test/build.ts`、`test/proofs.ts` | 測試的工具、兩種建置、`verifier/testdata/` 的測試證明和驗證的測試共用的小工具 |
| `test/clearing.test.ts` | 清空測試的證明紀錄，照[清空測試的證明紀錄](#清空測試的證明紀錄)的步驟在本機做一次：新的證明紀錄是空的、鏡像下一輪之後收得下紀錄、隔天公布的只有新的證明紀錄；被換掉的物件啟動時寫一行、不再設 alarm、alarm 響了什麼都不寫；晚了才清儲存桶時清掉就恢復；`wrangler.jsonc` 的清空日期不在今天之後 |
| `test/site-check.ts`、`test/site-check.test.ts` | 部署之後不插卡的檢查（[部署之後不插卡的檢查](#部署之後不插卡的檢查)），和在本機的 Worker 上確認它每一項都擋得到的測試 |
| `test/crls.ts` | 測試的發證金鑰、用它們簽的清冊 |
| `test/crl-testdata.test.ts` | 清冊鏡像和 Go 的 `crl/` 逐案比對（第三項要有 `go`） |
| `test/mirror-invariant.test.ts` | 寫索引出錯時，鏡像交給 Durable Object 的樹根仍然都列在索引裡（在 Node 裡，用假的儲存桶和假的雜湊） |
| `test/mirror-faults.test.ts` | 清冊鏡像出錯和遇到大東西的時候：拿不到行的檔、拖時間的檔、太大的回應、超過一頁的儲存桶、之前留下的檔和補它們的界線、建樹到一半被停掉的一輪、兩輪同時寫索引 |
| `test/api.test.ts` | `challenges`、`card-state`、`config` 和 `/api/` 的外框，整個 Worker 在本機的 workerd 裡 |
| `test/records.test.ts`、`test/records.ts` | `records` 的每個錯誤代碼和先後順序、題目、清冊、午夜、`201` 的內容（Go 的舊後台的 `api_test.go` 的案例），用只看第一個位元組的驗證器 |
| `test/records-real.test.ts` | `cmd/iamreal-verify/testdata/card-proofs/` 的十四份真的證明，從鏡像抓清冊、發題目走到寫入，用部署的那一個驗證器；寫出來的證明紀錄公布之後，Go 建出來的 `iamreal-verify` 配原生的 `bb` 重驗通過（這一項要設 `IAMREAL_BB`、要有 `go`） |
| `test/records-storage.test.ts` | 同時送出時序號連續、每筆之間重啟、寫到一半失敗、`paused`、`spec/vectors/record-rules.json` 配 Durable Object 的儲存 |
| `test/rebuild.test.ts` | 從證明紀錄重建：重算的和原本的相同、改壞的一列修回來、跨 1,000 筆中斷後接著做、R2 的檔被改過或不是指紋檔那一行的證明紀錄時不換表、空的物件從 R2 重建、換完重寫卡片狀態檔、用設定值觸發而且只在停止收過卡時；`test/publication-verify.test.ts` 在 Go 重驗之前也重建一次 |
| `test/teaching-animation.test.ts`、`test/demo.test.ts` | 教操作的示範：時間表自己說得通、算法對 `spec/vectors/teaching-animation.json`；`site/demo.js` 和 `src/pages/hang-timeline.ts` 是 `scripts/site-files.ts` 寫出來的那一份，`site/demo.js` 算的狀態和答案相同 |
| `test/pages.test.ts`、`test/pages.ts`、`test/copy.ts` | 首頁和島民證明的每一種情況：`design/copy/` 的每一句和順序、標頭、轉址、`404`；每一頁共同的：跳脫、方法、正式的證明紀錄、測試的證明紀錄的標示、找不到這一頁；讀 `design/copy/` 的工具 |
| `test/lookup-pages.test.ts` | 查詢頁和證明紀錄頁的每一種情況：`design/copy/` 的每一句和順序、轉址、`404`、查詢框的每一種輸入、證明紀錄頁一頁一頁接著拿、寫入後下一頁就跟上（Go 的舊後台的 `visitor_test.go` 的案例） |
| `test/site-pages.test.ts` | 常見問題、如何驗證證明紀錄、如何檢查 Threads 帳號的島民證明、過卡需要什麼、掛上去的每一種情況、`/copy.js`（Static Assets 送、不跑 Worker）（Go 的舊後台的 `site_test.go` 的案例）；每一頁上連到這個網站的連結都回 `200` |
| `test/proof-files.test.ts` | `/proof` 和它的檔案：標頭和 `web/README.md` 引用的一字不差、`/proof/` 的轉址、沒有建置時是 `404` |
| `test/views.test.ts` | 衍生表和紀錄同一個交易、從紀錄重建逐列相同、數卡片不受壞掉的卡片狀態影響；一筆在 `test-example` 收回、在 `threads` 更換的紀錄，四張表逐列和預期的相同；`spec/vectors/record-rules.json` 的每一案，有效的每一筆寫進衍生表的列和從紀錄規則前後的狀態算出來的相同；頁面的每個讀取跑的每一句只讀一個索引（或主鍵）的一段、不排序，用的是 `src/views.ts` 給每個讀取寫的那幾個索引（Go 的舊後台的 `sqlite_view_test.go` 的 `TestViewsTwoPlatforms`、`TestViewsMatchVectors`、`TestViewQueriesUseIndexes`） |
| `test/page-refusals.test.ts` | 頁面的程式拒絕畫出的：不合 Threads 格式的帳號（查詢頁、掛上去、島民證明的每一張卡片）、全部紀錄裡沒有寫法的一列（不認得的種類，或少了要寫的帳號）、沒有卡片的島民證明；在 Node 裡直接呼叫 `src/pages/`，因為 Worker 不會交給頁面這樣的資料（Go 的舊後台的 `pages_test.go` 的 `TestRenderAlone` 後半） |
| `test/publication.test.ts` | 每天換日公布：空的證明紀錄、每一天的四個物件和標頭、沒有新紀錄的一天、沒響的那一天不補、同一刻、每一步失敗和重做、連續失敗時等 1、2、4 … 分鐘到每次一小時、成功之後又從一分鐘算起、兩次嘗試之間物件重啟也照樣等、時鐘跑快時存下的時間最多等一小時、`paused` 之前的失敗不接著算、那一行寫了就不變、儲存桶的指紋檔少了行會補回來、有物件沒有的行就不公布（開始前和寫之前各看一次；自己寫了但沒收到回應的那一行不算別人的）、寫的時候跨過午夜、`paused` 不公布、`GET /api/v1/fingerprint`、Worker 沒有送這些檔的網址 |
| `test/publication-verify.test.ts` | 整條路的比對：假卡片寫三天 2,005 筆，Go 的 `iamreal-verify` 用預設的讀法重驗後台寫出來的整個資料網域（要有 `go`） |
| `test/proof-log-files.test.ts` | 寫滿 1,000 筆的紀錄檔和雜湊清單搬到 R2：位元組、標頭、物件裡不再留那 1,000 筆、卡片現況和頁面不變；每一步失敗時紀錄不刪、重做的位元組相同；第一檔搬不成時第二檔寫滿；題目發得密時照樣搬；衍生表從 R2 重建（每一種紀錄跨過檔的邊界）、連續失敗時等 1、2、4 分鐘然後每次 5 分鐘、物件重啟時還沒到時間不重建、到時間由 alarm 叫醒時只有一次重建、成功之後又從一分鐘算起；搬不成時連續失敗的間隔加倍到一小時、重啟之後照樣等、由每天公布搬成也算成功（下一檔寫滿就馬上搬）；Worker 沒有送紀錄檔的網址；Go 的 `iamreal-verify` 讀得懂寫出來的目錄（最後一項要有 `go`） |
| `test/sequence.test.ts`、`test/sequence.ts` | 固定種子的長序列：產生器，Go 的 `prooflog/` 算的答案，配記憶體和配 Durable Object 的儲存逐筆比對（要有 `go`） |
| `test/environments.test.ts` | `wrangler.jsonc` 裡每個環境的證明紀錄、物件名稱、儲存桶對得上；每個環境的 `limits.cpu_ms` 和鏡像假設的 CPU 時間相同 |
| `test/engine.test.ts` | Barretenberg 丟例外、答覆不對、跑不起來時的行為（在 Node 裡，用假的實例） |
| `test/compare.test.ts` | 和原生的 `bb verify` 逐案比對（要設 `IAMREAL_BB`） |
| `test/*.test.ts` | 測試 |
| `scripts/dev.ts` | `pnpm dev` |
| `scripts/deploy.ts` | 部署的三段：過卡頁面的建置和檢查 `buildSite`、打包唯一的入口 `bundleWorker` 和 `buildDeploy`、上傳的參數 `uploadArgs`；怎麼讀權杖、給 wrangler 的環境 |
| `scripts/deploy-build-checks.ts` | 部署那一包上傳之前的檢查 |
| `scripts/site-files.ts` | 寫出 `site/_headers`（從 `src/headers.ts`，照證明紀錄的種類）和 `site/_redirects`；部署前的檢查和測試拿它核對版控裡的那兩個檔 |
| `scripts/favicon.ts` | 把頁首的記號畫成 `site/favicon.ico`（16、32、48 像素，用這台電腦的 Chrome）；記號改了時手動跑，部署和建置都不跑 |
| `scripts/proof-page.ts` | 過卡的頁面：核對通用參數、建置 `web/` 的測試網站模式、上傳之前檢查那份建置（[Static Assets](#static-assets)） |
| `scripts/issuers-in-spec.ts` | 從 `spec/vectors/issuers.json` 讀內政部的兩把發證金鑰，給部署前的兩種檢查比對 |
| `scripts/build-deploy.ts` | GitHub Actions 的 `build` 工作跑的：建置並檢查過卡的頁面、打包並檢查 Worker |
| `scripts/deploy-test.ts` | `pnpm run deploy:test` |
| `test/workflows.ts` | 工作流程的白名單和讀它們的程式 |

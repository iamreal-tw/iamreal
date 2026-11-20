# worker/：後台

**這個目錄讓人檢查的事：規則有照做。** 這裡是 Cloudflare 上的後台（ADR-0023），一個 Worker 專案。名冊規則、場合字串這些算法在 [`protocol/`](../protocol)，這裡只引用它，不引用這個程式庫的其他目錄。

## 現在有什麼

還沒做完：清冊鏡像、過卡的四個介面（發題目、卡片現況、送出一筆、設定）、首頁、島民證明、過卡的頁面有了，其餘的訪客頁面和公布名冊還沒有。舊的後台 [`server/`](../server)（Go）還在，還是對照。

| 有 | 還沒有 |
|---|---|
| 清冊鏡像（[排程做什麼](#排程做什麼)）：每小時抓內政部的兩份廢止清冊，原始位元組存進 R2 的 `crl/<SHA-256>.crl`，驗章、建樹，寫清冊存檔的索引 `crl/index.jsonl`。`crl/testdata/` 的每一案和 Go 的 `crl/` 比對過 | 在 Cloudflare 上跑過的紀錄：這一版還沒部署 |
| 名冊的 Durable Object：題目表、紀錄、卡片狀態表、名冊的一列（[題目、卡片現況、設定](#題目卡片現況設定)、[送出一筆](#送出一筆)），和每把發證金鑰最新兩份可用清冊的樹根、編號、日期 | 把紀錄搬到 R2、每天公布名冊（[#70](https://github.com/iamreal-tw/iamreal/issues/70)）：紀錄現在全部留在 Durable Object |
| API 的四個介面：`POST /api/v1/challenges`、`POST /api/v1/card-state`、`POST /api/v1/records`、`GET /api/v1/config`；存著的規則版本和程式不同時 `challenges` 和 `records` 回 `paused` | `GET /api/v1/fingerprint`；限流 |
| 驗證證明和 Poseidon2 的雜湊（[驗證證明](#驗證證明)），在本機的 workerd 裡逐案和原生的 `bb verify` 比對過；送出一筆時用它驗證 | 其餘的訪客頁面：查詢頁、名冊頁、常見問題、怎麼驗證、掛上去（[#72](https://github.com/iamreal-tw/iamreal/issues/72)）。首頁上連到它們的連結現在是 `404` |
| 首頁 `/`、島民證明 `/p/<短編號>`、過卡的頁面 `/proof`，和頁面用的衍生表（[頁面和檔案](#頁面和檔案)） | 部署時把 `web/` 的建置放進 Static Assets：測試網站的建置模式在 [#69](https://github.com/iamreal-tw/iamreal/issues/69)，在那之前部署出去的 `/proof` 是 `404` |
| 測試專用的建置和測試的工具 | |
| 部署測試環境的指令。2026-11-19 用它第一次部署到 `test.iamreal.tw`（[第一次部署量到的](#第一次部署量到的)） | 推版本標籤時部署正式環境的工作流程 |
| 合併到 `main` 時部署測試環境的工作流程（[從 GitHub Actions 部署](#從-github-actions-部署)） | |

## 單獨執行

需要 Node 22 和 pnpm。不需要 Cloudflare 的帳號。有些測試另外要 Go：和原生 `bb` 逐案比對（`test/compare.test.ts`，另要 `IAMREAL_BB`，見「和原生的 `bb verify` 逐案比對」），`test/workflows.test.ts` 裡檢查 `web/` 瀏覽器測試的 `paths` 清單的那一項（`.github/README.md`），和名冊規則跟 Go 的 `roster/` 逐筆比對（`test/sequence.test.ts`，見「名冊規則和 Go 的 `roster/` 逐筆比對」）。第一項沒設 `IAMREAL_BB` 時跳過；後兩項沒有 `go` 時跳過，但設了 `CI` 或 `IAMREAL_BB` 時沒有 `go` 是失敗（GitHub Actions 會設 `CI`），這樣 CI 上不會悄悄跳過。在程式庫的根目錄 `pnpm install`，然後在這個目錄：

```sh
pnpm dev         # 在本機的 workerd 啟動 Worker
pnpm test        # 測試
pnpm typecheck   # 型別檢查
```

`pnpm dev` 啟動的是測試專用的建置，旁邊有一個假的內政部（本機的伺服器），所以不會對內政部送請求。它印出 Worker 的網址；按 Enter 跑一次排程，印出排程寫的紀錄和 R2 的模擬裡的檔案。R2 的模擬每次啟動都是空的。

## 題目、卡片現況、設定

介面的格式在 [`docs/api/card-proof.md`](../docs/api/card-proof.md)。這一節寫這個後台怎麼做。程式在 [`src/api.ts`](src/api.ts)、[`src/roster.ts`](src/roster.ts)、[`src/card-table.ts`](src/card-table.ts)、[`src/json.ts`](src/json.ts)；測試在 [`test/api.test.ts`](test/api.test.ts)，案例是從舊後台的 `server/api_test.go` 搬過來的。

### `/api/` 底下每個回應

- 都是 JSON，帶 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff` 和自己的 `X-Request-Id`（8 個隨機位元組的十六進位）。不設 cookie，不送 CORS 標頭。
- 不是介面的路徑回 `404` `not_found`；方法不對回 `405` `method_not_allowed`，帶 `Allow`。
- **後台不存連線紀錄，也不為收到的請求寫任何一行。** 只有後台自己出錯（回 `500` `internal`）時寫一行，只在即時的輸出看得到，沒有開保存：

  ```
  {"event":"internal_error","id":"<請求編號>","endpoint":"/api/v1/challenges","where":"roster","error":"Error"}
  ```

  `endpoint` 只會是介面自己的路徑，`error` 是例外的類別名稱，`where` 是程式裡寫死的四個值之一：

  | `where` | 意思 |
  |---|---|
  | `settings` | 設定不對：`ROSTER_KIND` 不是 `test` 也不是 `production`，或它和 `ROSTER_OBJECT_NAME` 對不上（見[名冊和物件的名稱要對得上](#名冊和物件的名稱要對得上)） |
  | `schema` | 名冊的 Durable Object 裡的表是另一版建的（見[兩個版本號](#兩個版本號)） |
  | `roster` | Durable Object 裡其他的錯，包括存著的卡片狀態壞了（見[讀卡片狀態時的檢查](#讀卡片狀態時的檢查)） |
  | `handler` | 其他地方 |

  例外的訊息不寫：訊息可能引用請求的內容。這一行沒有題目、匿名編號、帳號、對方的位址。
- 介面會讀的請求內容最多 64 KB（65,536 個位元組），超過就是 `malformed`，多的部分不讀。`challenges` 不讀內容，送什麼、多長都不看。巢狀超過 16 層的 JSON 也是 `malformed`。
- 讀 JSON 用自己寫的讀法（`src/json.ts`）：`JSON.parse` 遇到重複的鍵會留下後面那個而不報錯，這裡重複的鍵一律拒絕（ADR-0014）。多一個鍵、少一個鍵、鍵的大小寫不同、值不是字串、物件後面還有東西、不是 UTF-8、開頭有位元組順序記號，都是 `malformed`。

### 四個介面

| 介面 | 誰回答 | 做法 |
|---|---|---|
| `POST /api/v1/challenges` | Durable Object | 日期是發出那一刻的台灣日期，加 16 個隨機位元組；先存進題目表再回。請求的內容不讀。存著的規則版本和程式的不同時不發，回 `503` `paused` |
| `POST /api/v1/records` | Worker 和 Durable Object 各兩段 | 見[送出一筆](#送出一筆) |
| `POST /api/v1/card-state` | Worker 檢查格式，Durable Object 讀卡片狀態表 | 場合字串不是這份名冊的、匿名編號不是它唯一的寫法，都是 `malformed`，不問 Durable Object。平台表的每個平台一項；存著的狀態沒有某個平台的名額時，那一項是沒用過的名額。回應沒有 `head` |
| `GET /api/v1/config` | Worker 自己 | `crl_max_age_days` 是 3；`platforms` 是這份名冊的平台表 |

**平台表**寫在 [`protocol/src/platforms.ts`](../protocol/src/platforms.ts)，照名冊分兩張，內容和 `spec/scope.md` 的表一字不差（`protocol/` 的測試拿規格的 Markdown 核對）。後台只從 [`src/settings.ts`](src/settings.ts) 的 `rosterSettingsOf` 一個地方取得它：`config` 送給裝置的、`card-state` 列的、檢查存著的卡片狀態用的是同一張。這個環境用哪一份名冊，是設定 `ROSTER_KIND`（見[設定檔](#設定檔)）；設定只說是哪一份，表的內容不在設定裡。

### 名冊和物件的名稱要對得上

**命名規則：測試名冊的 Durable Object 名稱（`ROSTER_OBJECT_NAME`）一律以 `test-` 開頭；正式名冊的不可以以 `test-` 開頭。** 所以從名稱就看得出一個物件裡是哪一份名冊，設定錯了有兩層擋：

| | 擋什麼 | 怎麼擋 |
|---|---|---|
| 合併之前 | 經過 PR 的設定錯誤 | [`test/environments.test.ts`](test/environments.test.ts) 用 wrangler 的讀法讀 `wrangler.jsonc`：`test` 環境的 `ROSTER_KIND` 必須是 `test`、`ROSTER_OBJECT_NAME` 必須以 `test-` 開頭、R2 的儲存桶必須是 `iamreal-test-data`。PR 的檢查會跑它。之後加正式環境時，這個測試要加對應的一段 |
| 執行時 | 不經過 PR 的：從本機用改過的設定檔部署 | 後台取得設定的那一處（`src/settings.ts` 的 `rosterSettingsOf`）每次都檢查 `ROSTER_KIND` 合法、而且和 `ROSTER_OBJECT_NAME` 相符：`test` 配 `test-` 開頭的名稱，`production` 配不是 `test-` 開頭的名稱 |

執行時不符的話：

- 四個介面（`challenges`、`card-state`、`records`、`config`）一律回 `500`，寫一行 `where` 是 `settings` 的紀錄。每個介面都是先讀設定才做別的事。
- Worker 不去問 Durable Object。Durable Object 自己啟動時也讀同一處，設定不對就不啟動，不建表、不讀不寫。
- 設定改對之後照常，物件裡原有的東西都還在。

之後的介面（頁面）只要經過 `rosterSettingsOf` 取得設定，就有同樣的檢查。

### 讀卡片狀態時的檢查

`src/card-table.ts` 的 `readCard` 讀出一列之後，照 `spec/roster-rules.md`「State」和這份名冊的平台表檢查，不合就丟例外，`card-state` 回 `500`；壞掉的狀態不交給任何人：

- `last_card_proof` 是日期；`proofs_on_last_date` 是 1 到 3；`last_seq` 至少是 1
- 每個名額的平台在平台表裡
- `switch_count` 是 0 到 5；日期是日期；名額的各項彼此說得通，也和上次過卡日說得通（`protocol/` 的 `possibleSlot`：例如 `current` 有值時等於 `last_declared`、`correction_date` 不晚於上次過卡日）
- `current` 和 `last_declared` 合那個平台的帳號格式

3 和 5 這兩個上限用的是 `protocol/src/roster-rules.ts` 的常數。`writeCard` 寫入時不做這些檢查：它寫的是規則的函式交出來的狀態。

### Durable Object 裡存的

建表的程式在 `src/roster.ts` 的 `TABLES` 和 `src/card-table.ts` 的 `CARD_TABLE`，物件每次啟動時執行（`CREATE TABLE IF NOT EXISTS`）。

| 表 | 一列是什麼 | 欄位 |
|---|---|---|
| `challenges` | 一個發出、還沒過期的題目 | `challenge`、`issued_ms`（發出的時間）、`submissions`（送出的次數）、`accepted`（是否已接受） |
| `records` | 一筆紀錄 | `seq`、`line`（它在名冊檔裡的那一行，含結尾的換行；照序號接起來就是名冊檔）、`record_hash`、`fingerprint`（加上這一筆之後的名冊指紋） |
| `cards` | 一張有過有效紀錄的卡片 | `scope_string`、`scoped_id`、`last_card_proof`、`proofs_on_last_date`、`slots`、`last_seq`（這張卡片最後一筆有效紀錄的序號） |
| `roster` | 整份名冊，只有一列 | `count`（筆數）、`fingerprint`（名冊指紋）、`latest_valid_date`（名冊上最晚的有效日期）、`rules_version`（卡片狀態是照哪一版規則算的）、`schema_version`（這些表是照哪一版建的） |

- `cards` 的欄位就是 `spec/roster-rules.md`「State」的項目，加上 `last_seq`。`slots` 是一個 JSON 物件，鍵是平台代號，每個值恰好是 `current`、`last_declared`、`switch_count`、`correction_date`，名稱和寫法跟 `card-state` 回應的 `platforms` 相同。只存事實（更換過幾次），不存結論（還能不能換）。沒有有效紀錄的卡片沒有列。
- 這張表只放名冊規則的狀態，和頁面用的衍生表（`view_` 開頭的四張，見[頁面用的衍生表](#頁面用的衍生表)）分開：衍生表可以整份重建，規則的狀態錯了會收下拿不掉的紀錄。
- `records` 是送出一筆（[#67](https://github.com/iamreal-tw/iamreal/issues/67)）加的新表，表的版本沒有變；在它之前建的物件下一次啟動時補上這張表。`fingerprint` 每一筆都存，是為了之後切檔時拿得到每一檔開頭的名冊指紋（`spec/record.md`「Record hash lists」），不必從頭重算。
- `rules_version` 在物件第一次啟動時記下當時程式的版本號；和程式的不同時不收過卡（見下面）。

### 兩個版本號

`roster` 那一列記著兩個版本號，都是物件第一次啟動時寫入當時程式的常數。那一列用 `INSERT OR IGNORE` 建，已經有了就不動：沒有任何程式會把存著的版本號改成新的。

| | 規則的版本 `rules_version` | 表的版本 `schema_version` |
|---|---|---|
| 程式裡的常數 | `protocol/` 的 `RULES_VERSION` | `src/roster.ts` 的 `SCHEMA_VERSION`，現在是 1 |
| 什麼時候加一號 | 名冊規則改了、存著的卡片狀態因此失效（`spec/roster-rules.md`「The version number」） | **改到任何一張已經存在的表**：加欄位、拿掉欄位、欄位的意思變了、改主鍵。只是多一張新的表、多一個索引不用加：建表的程式會在沒有它們的物件上補上 |
| 存著的和程式的不同時 | 不收過卡：`challenges` 和 `records` 回 `503` `paused`，不發題目、不計次、不寫入；`card-state` 和 `config` 照常。`records` 的請求本身讀不懂時（`malformed`、`scope`、`platform`）仍然先回那個代碼，那一段不問 Durable Object。這不是後台出錯，不寫那一行紀錄 | Durable Object 的每個方法都不讀不寫，丟錯誤；`challenges`、`card-state`、`records` 回 `500`，那一行紀錄的 `where` 是 `schema`。alarm 響了也什麼都不做 |
| 怎麼處理 | 重建狀態（[#51](https://github.com/iamreal-tw/iamreal/issues/51)） | 現在沒有搬移表的程式。處理的方法是清空測試名冊：換一個 `ROSTER_OBJECT_NAME`（維持 `test-` 開頭）。真正的搬移留給 [#118](https://github.com/iamreal-tw/iamreal/issues/118)，封閉試用之前定 |

兩件事不共用代碼：`paused` 是規則的版本，`schema` 是表的版本。

表的版本為什麼要擋：表是用 `CREATE TABLE IF NOT EXISTS` 建的，已經存在的表不會跟著程式變，新的程式會照新的欄位去讀舊的表。

`config` 由 Worker 自己回答、不問 Durable Object，所以表的版本不同時它照常回 `200`；不是介面的路徑（`404`）、方法不對（`405`）也照常。

### 過期的題目怎麼刪

題目發出後不到 10 分鐘可以用；剛好 10 分鐘就是過期。Durable Object 用自己的 alarm 刪。

一個 Durable Object 同一時間只能排一個 alarm，再呼叫 `setAlarm` 會蓋掉原來的（[Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)：「Each Durable Object is able to schedule a single alarm at a time by calling `setAlarm()`」「If you call `setAlarm` when there is already one scheduled, it will override the existing alarm」，2026-11-20 讀的）。所以定時的工作不各自設 alarm，而是照同一個形狀寫（`src/roster.ts` 的 `TimedWork`）：

- 每一件工作回答兩件事：自己下一次什麼時候到期（沒事可做就說沒有）、到期時做什麼。它不知道別的工作。
- 物件的 alarm 永遠設在所有工作裡最早到期的那一個；都沒事可做就沒有 alarm。任何一件工作的到期時間可能變了（例如發了一個題目），就重設一次。
- alarm 響的時候，到期的工作各做一次，沒到期的不做，然後重設。

現在只有一件：刪過期的題目，到期時間是最舊那個題目發出後 10 分鐘。之後每天換日的工作（[#70](https://github.com/iamreal-tw/iamreal/issues/70)）是在 `timedWork()` 多列一件；它占著 alarm 不會讓題目晚刪。測試用測試專用的建置多塞一件假的工作來確認這一點（`test/api.test.ts`）。所以題目表裡只有最近 10 分鐘左右發的題目。

## 送出一筆

`POST /api/v1/records`：一次過卡，帶這張卡片的整份帳號清單。檢查的順序照 [`docs/api/card-proof.md`](../docs/api/card-proof.md)，第一個不過的就是回應的代碼。Worker 和名冊的 Durable Object 之間分四段：

| | 誰 | 做什麼 | 停在這裡的代碼 |
|---|---|---|---|
| 1 | Worker（`src/submission.ts`） | 讀請求、檢查每個欄位的格式。不問 Durable Object，不算一次送出 | `malformed`、`scope`、`platform` |
| 2 | Durable Object（`beginSubmission`） | 檢查題目，算一次送出 | `paused`、`challenge_unknown`、`challenge_used`、`challenge_attempts` |
| 3 | Worker（`src/record-proof.ts`） | 從紀錄的欄位重建公開輸入，驗證證明。在 Durable Object 外面做，驗證的時候名冊不被佔住 | `proof` |
| 4 | Durable Object（`accept`） | 再看一次題目；檢查清冊；套名冊規則；套後台自己的更換政策；寫入 | `challenge_unknown`、`challenge_used`、`crl_stale`、`root`、`date_order`、`empty`、`switch_limit`、`daily_limit`、`switch_restricted` |

- **後台自己不判斷一筆紀錄有效或無效。** 第 4 段把存著的卡片狀態、名冊上最晚的有效日期、樹根對到的清冊日期交給 `protocol/` 的 `applyRecord`，照它的結果回。這個檔自己決定的只有後台自己的事：題目、今天收哪些樹根、更換政策。
- **題目**：發出滿 10 分鐘就是不認得（剛好 10 分鐘也是）。已經寫入過一筆的題目是 `challenge_used`，不計次。第 6 次送出起是 `challenge_attempts`：第 2 段每通過一次就加一，不管後來停在哪一段，第 4 段再看題目時擋下的（`challenge_used`、`challenge_unknown`）和回 `500` 的（驗證器跑不起來、第 4 段出錯）也算。第 1 段擋下的、`paused` 的、第 2 段就是 `challenge_unknown` 或 `challenge_used` 的不計次；計次的那一次寫入自己失敗（`500`）也沒有計到。
- **第 4 段為什麼再看一次題目**：驗證證明的那段時間，同一個題目可能已經被另一個請求寫入（回 `challenge_used`），也可能剛好過期（回 `challenge_unknown`）。同一個題目同時送兩次，只有一次寫入。過期是照寫入那一刻的時鐘看的：第 2 段時還差 1 毫秒到 10 分鐘、驗證完已經滿 10 分鐘的那一次，回 `challenge_unknown`、不寫入、已經算一次。這一點比 Go 的舊後台嚴，是有意的：`server/submit.go` 只在第一次看題目時看過期，寫入時只看題目是不是已經用過。
- **清冊**：`issuer` 那把發證金鑰在鏡像裡沒有可用的清冊，或最新一份的清冊日期加 3 天早於今天（台灣日期），是 `crl_stale`；`smt_root` 不是最新兩份其中一份的樹根，是 `root`。名冊規則的檢查 3 拿到的清冊日期，是這兩份裡樹根相同的那幾份的日期。重驗的人用的是整份清冊存檔，日期只會更多，所以後台收下的紀錄重驗時這一項一定過。
- **更換政策**（`switch_restricted`）：預設沒有。環境變數 `RESTRICT_LATE_SWITCHES` 是 `"true"` 時，名冊規則接受、但其中有一個更換是那個名額的第 4 次或第 5 次的紀錄，回 `403`。`wrangler.jsonc` 沒有設這個值；要開的話在設定檔加一行，並把它加進 `scripts/deploy-build-checks.ts` 允許的清單。這個值只寫在 `wrangler.jsonc`，不用 `wrangler secret` 設：部署前的檢查讀的是設定檔和 wrangler 列出的 binding，看不到另外設在 Worker 上的 secret，用 secret 開的政策就沒有人在 PR 裡看過。值不是 `"true"` 也不是 `"false"` 時每個介面都回 `500`。
- **驗證器跑不起來**（`EngineError`，見[驗證證明](#驗證證明)）不是拒絕也不是通過：回 `500`，那一行紀錄的 `where` 是 `verifier`，不問 Durable Object 寫任何東西。這一次送出已經在第 2 段算了一次。

### 寫入是一個交易

第 4 段每一項都過了之後，在一個交易裡（`transactionSync`）寫五樣，寫完才回應：

1. 紀錄：序號、它在名冊檔裡的那一行（`protocol/` 的 `recordLine`）、紀錄雜湊、加上它之後的名冊指紋
2. 這張卡片的狀態，和它最後一筆有效紀錄的序號
3. 名冊的那一列：筆數、名冊指紋、名冊上最晚的有效日期
4. 頁面用的衍生表（[頁面用的衍生表](#頁面用的衍生表)）
5. 題目標成已接受

任何一步丟例外，五樣都不留下，回 `500`；[`test/records-storage.test.ts`](test/records-storage.test.ts) 和 [`test/views.test.ts`](test/views.test.ts) 讓每一步各失敗一次來確認（衍生表的四張各一次），後者另外確認衍生表的每一列和頁面都沒變。寫入之前，那一行先照 `spec/record.md`「Check a line」讀一次（`readRecordLine`），讀不過就不寫。

**交易提交之後沒有會丟例外的程式。** `201` 的回答（每個平台是哪個帳號、有幾張卡片宣告它）在交易結束前就做好：帳號在交易之前取，數卡片在交易裡、寫完衍生表之後做。所以不會出現「紀錄寫進去了、題目標成用過了，裝置卻拿到 `500`」。

**數卡片查的是衍生表，不讀卡片狀態表。** `account_cards` 是 `view_slots` 裡同一個場合、同一個平台、現在的帳號相同的列數，走一個索引（`src/views.ts` 的 `accountCards`）。[#67](https://github.com/iamreal-tw/iamreal/issues/67) 的做法是每寫一筆掃同一個場合每張卡片存著的 `slots`，其中一列壞掉，那個場合的每一筆送出都回 `500`。現在：

- 一張卡片存著的狀態壞掉，別的卡片照常送出、照常寫入
- 數出來的數字照樣算到那張卡片：衍生表是每一筆紀錄寫進去的，不是從卡片狀態表讀來的，所以不會因為有一列讀不出來就少數
- 那張卡片自己的送出回 `500`、什麼都不寫：名冊規則要讀它的狀態，讀不出來就不套規則（`src/card-table.ts` 的 `readCard`）。它的島民證明照常打得開，頁面不讀卡片狀態表

[`test/views.test.ts`](test/views.test.ts) 把一張卡片存著的名額改成不是 JSON 的字來確認這三件事。

**序號**是寫入那一刻的筆數加一。紀錄雜湊要用到序號，而算雜湊（WebCrypto）是非同步的，所以做法是：先照現在的筆數算好雜湊和名冊指紋，接著從檢查到寫入一口氣做完、中間不等任何東西，而且一開始先確認筆數沒有變；變了就重算。所以不會有兩筆拿到同一個序號，每一筆都是照前一筆留下的狀態檢查的。本機的 workerd 裡算雜湊不會讓別的請求插進來（20 個請求同時送，筆數也不會在這中間改變），所以測試專用的建置可以讓 Durable Object 在算雜湊之前先等幾毫秒（`PUT /__test/roster/hash-delay`；`src/roster.ts` 的 `hashOf` 就是為了這個拆出來的，只有測試專用的建置覆寫它）：等的時候別的請求會插進來，20 個同時送的請求就會拿著同一個筆數算雜湊。測試確認這時 20 筆仍然各拿到一個序號、存下來的名冊檔驗得過，而且有紀錄重算過。拿掉確認筆數的那一行，這個測試會看到 `500`（序號重複的那一筆因為主鍵寫不進去）。

紀錄現在全部留在 Durable Object 的 `records` 表；寫滿 1,000 筆搬到 R2、每天公布，是 [#70](https://github.com/iamreal-tw/iamreal/issues/70)。在那之前，寫進去的那一行、每一筆的紀錄雜湊和名冊指紋、名冊那一列的筆數和名冊指紋，部署的後台沒有任何介面讀得到。測試從測試專用建置的 `GET /__test/roster/stored` 讀出來，[`test/records.ts`](test/records.ts) 的 `checkRoster` 只拿存著的每一行，用 `protocol/` 照 `spec/record.md` 重算：每一行讀得過（「Check a line」）、序號從 1 連續、紀錄雜湊和每一筆之後的名冊指紋都對、名冊那一列的筆數和指紋是最後一筆的。它對應 Go 舊後台測試的 `checkRoster`（`server/harness_test.go`），用在同時送出、`empty` 和 `switch_limit`、`switch_restricted`、`daily_limit` 的案例。

### 名冊規則和 Go 的 `roster/` 逐筆比對

刪掉舊的後台之前，要確定這裡的每一筆判斷都和 Go 的 `roster/` 相同（[#9](https://github.com/iamreal-tw/iamreal/issues/9) 結論第 8 項）。分三層，三層都過才算：

| | 比什麼 | 在哪裡 |
|---|---|---|
| 1 | `spec/vectors/roster-rules.json` 的每一案，配 Durable Object 的儲存，每筆之間重啟 | `test/records-storage.test.ts` |
| 2 | 一串固定種子產生的長序列，`protocol/` 的規則配記憶體（`MemoryRules`），以 Go 的 `roster/` 當答案 | `test/sequence.test.ts` |
| 3 | 同一串，配 Durable Object 的儲存，每一筆之間重啟名冊的 Durable Object | `test/sequence.test.ts` |

第 2、3 層（[#73](https://github.com/iamreal-tw/iamreal/issues/73)）在同一個檔。第 2 層在 `pnpm test` 裡，每個 PR 都跑（不到 1 秒）。第 3 層約 107 秒，幾乎是這個檔全部的時間，只在設了 `IAMREAL_SEQUENCE_STORAGE=1` 時跑，沒設時測試的輸出列它為跳過並寫明原因。在這個目錄：

```sh
node --experimental-strip-types --test test/sequence.test.ts                             # 第 2 層
IAMREAL_SEQUENCE_STORAGE=1 node --experimental-strip-types --test test/sequence.test.ts  # 第 2、3 層
```

**什麼時候要跑第 3 層**：改到名冊規則的狀態怎麼存、怎麼讀的時候，也就是 `src/roster.ts` 的 `ruleState`、`keepRuleState`、`accountCards`，`src/card-table.ts`，數卡片查的衍生表（`src/views.ts` 的 `viewOf`、`writeView`、`accountCards`），和這些表的結構；刪掉舊的後台之前也要跑一次。PR 的說明寫跑的結果。為什麼不是每個 PR 都跑：規則本身的不同由第 2 層每個 PR 擋著，存了再讀的不同由第 1 層每個 PR 擋著（標準答案的每一案，每筆之間重啟）；第 3 層多守的是長序列累積出來的狀態存了再讀，只有上面那幾處會改變它，而每個 PR 多跑約 2 分鐘（維護者 2026-11-20 決定）。CI 上要不要在這些路徑有改時自動跑，留給 [#69](https://github.com/iamreal-tw/iamreal/issues/69)。

要有 `go`：沒有時跳過，但設了 `CI` 或 `IAMREAL_BB` 時沒有 `go` 是失敗，和 `test/workflows.test.ts` 相同。

做的事：

1. **產生一串紀錄。** [`test/sequence.ts`](test/sequence.ts) 的 `generateSequence` 從種子（現在是 1）產生 10,000 筆測試名冊（兩個平台）的事件。它不知道規則，只記得每張卡片在每個平台想宣告哪個帳號，讓規則的各種情況常常發生：160 張卡片，同一時間只有 8 張在送、每 64 筆換一張，偶爾是剛離開的卡片回來送一筆、日期是 4 天前；每個平台 4 個帳號名稱；一天約 18 筆，日期大多是當天，常常是前一天（午夜前拿的題目），有時往回 2 到 8 天（沒超過和超過檢查 4 的 4 天）、有時往後 1 到 3 天；有時是空的清單、重送最近 30 筆之一的題目、證明不過、沒有一份清冊的日期對得上（含差一天就對得上的）。亂數是自己寫的 mulberry32，只用 32 位元的整數運算，不用 Node 內建的，所以同一個種子產生的序列不隨 Node 的版本改變；同一個種子長一點的序列，開頭就是短的那一串。
2. **Go 算答案。** 測試把序列寫進 `worker/test-output/sequence-…/events.json`，跑 `go test -count=1 -run '^TestSequenceAnswers$' ./roster`，環境變數 `IAMREAL_ROSTER_SEQUENCE` 指到那個目錄。`roster/sequence_test.go` 用 `roster.Rules` 一筆一筆套用，寫同一個目錄的 `answers.json`。兩個檔的格式見下面「交換的檔」。`test-output/` 不進版控（`worker/.gitignore`）：每一項都過時刪掉這個目錄；有任何一項失敗（包括 Go 那邊失敗、最後的現況不同）時留著，失敗的訊息寫著路徑。
3. **比每一筆。** 每一筆的結果（有效或無效、代碼、每個平台的種類）和那張卡片在這一筆之後的狀態（`last_card_proof`、`proofs_on_last_date`、每個名額的 `current`、`last_declared`、`switch_count`、`correction_date`；沒有有效紀錄的卡片是空的狀態）。
   - 記憶體那一次另外每一筆比名冊上最晚的有效日期，每 100 筆比一次每個帳號底下的卡片數（`account_cards`），最後比整個現況（每張卡片的清單，每個帳號底下的卡片）。
   - Durable Object 那一次，每一筆走測試專用建置的 `POST /__test/roster/rule-event`，接著重啟名冊的 Durable Object，再從 `POST /api/v1/card-state` 讀那張卡片。`rule-event` 對有效的一筆除了寫卡片的狀態，也照送出一筆的同一段程式寫衍生表（`viewOf`、`writeView`）：數卡片查的是衍生表。這個入口不存紀錄，所以寫完把衍生表記的筆數放回名冊的筆數，物件重啟時才不會當成衍生表沒跟上、拿不存在的紀錄去重建。每 100 筆（共 100 次，最後一筆也是）再從 `POST /__test/roster/rule-state` 讀名冊上最晚的有效日期（`ruleState` 讀出來給規則的那一個）和每個帳號底下的卡片數（部署的 `accountCards` 那一句查詢數的，就是 `201` 回應裡的 `account_cards`：查衍生表 `view_slots`，不讀卡片狀態表；有哪些帳號則是從卡片狀態表列出來的，所以這一步同時比了兩張表對不對得上），和 Go 的比。
4. **遇到第一筆不同就停**，訊息寫第幾筆、哪張卡片、哪個欄位、兩邊的值，例如（把 `accountCards` 的查詢故意改成最多回 1 時）：

   ```
   record 100 of 10000 (seq 100), card 52BSJ2X5Y0JK8VWSEYGDKTAPYQ6GHCSF333XYD5WCR8C8ZYWNW00, accounts[0].account_cards: Go 3, Durable Object 1. The events and Go's answers are kept in /…/worker/test-output/sequence-…
   ```

   Durable Object 讀不出那張卡片時（存著的狀態不合規則，`card-state` 回 `500`，見[讀卡片狀態時的檢查](#讀卡片狀態時的檢查)），訊息寫第幾筆、哪張卡片。
5. **印出統計，設下限。** 每個代碼、每個平台的每個種類都要至少 100 次。另外數下面幾種情境，下限約是種子 1 實際次數的四分之三，換了種子或改了產生器時確認序列還涵蓋它們。情境從事件和 Go 的答案數，不用 `protocol/`（`test/sequence.ts` 的 `scenarios`）。

**交換的檔**是這兩個測試檔之間的約定（`roster/sequence_test.go`、`test/sequence.ts`），不在 `spec/` 裡。它們以 `spec/vectors/roster-rules.json` 一個案例的樣子為底，因為 Go 和 TypeScript 互不引用、只共用 `spec/`，這是兩邊本來都讀的格式；找到不一致時，最小的重現案例可以直接寫成標準答案的一案。多出來的欄位：

| 檔 | 和標準答案的案例相同的 | 多出來的 |
|---|---|---|
| `events.json` | `name`、`roster`、`events`（事件的欄位相同） | `checkpoint_every`：每幾筆列一次帳號 |
| `answers.json` | 上面三項、`results`、`state`（最後的現況，寫法相同） | `rules_version`；每一筆一項的 `cards`（這一筆之後那張卡片的狀態，寫法和標準答案的 `slots` 相同）和 `latest_valid_dates`（到這一筆為止有效紀錄最晚的日期；`roster.Rules` 沒有匯出它，由 Go 的測試照規格的定義從 `Rules` 判為有效的紀錄的日期取）；`checkpoints`（每 `checkpoint_every` 筆和最後一筆之後，每個有卡片宣告的帳號和 `AccountCards` 數的卡片數） |

**這一層沒比到的。** `rule-event` 和真的送出一筆共用的只有讀狀態、寫狀態那兩段（`src/roster.ts` 的 `ruleState`、`keepRuleState`）、寫衍生表的那兩段（`src/views.ts` 的 `viewOf`、`writeView`）和 `protocol/` 的 `applyRecord`。送出一筆的第 4 段（`#acceptAt`）其餘的部分這裡都沒走到：

- 題目表：`challenge_unknown`、`challenge_used`、計次。用過的題目記在測試專用建置自己的表（`test_used_challenges`），`challenge_reused` 比的是那張表配規則的檢查 2
- 清冊的政策：`crl_stale`、只認最新兩份清冊的樹根
- 更換政策 `switch_restricted`
- 寫 `records`、名冊那一列的 `count`、`fingerprint` 的交易
- 數 `account_cards` 的查詢在寫入的交易裡跑的那一次（這裡比的是同一句查詢，在交易外面另外叫）

`proof` 和 `root` 兩邊都照事件的旗標回答（`verifies`、`crl_dates`），不驗證證明，也不讀清冊，所以比到的是檢查的先後和檢查 3 的日期範圍（清冊日期的前 1 天到後 3 天），不是驗證器和清冊存檔。這些由 `test/records.test.ts`（每個錯誤代碼和先後順序、題目、清冊、午夜、`201` 的內容）、`test/records-real.test.ts`（真的證明和鏡像抓的清冊）和 `test/records-storage.test.ts`（同時送出、寫到一半失敗、`paused`）守著。

2026-11-20 跑的結果（種子 1，10,000 筆）：Go、記憶體、Durable Object 三邊**沒有一筆不同**，100 次的名冊最晚有效日期和帳號的卡片數也相同，最後的現況也相同。有效 4,766 筆、無效 5,234 筆：

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
| 跨午夜 | 有效，日期是名冊上最晚有效日期的前一天 | 842 | 630 |
| 日期往回超過 4 天 | `date_order`，日期早於名冊上最晚有效日期超過 4 天 | 408 | 300 |
| 剛好往回 4 天而有效 | 有效，日期剛好是名冊上最晚有效日期的 4 天前 | 79 | 60 |
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
| `/` | 首頁（`design/copy/home.md`） | Worker 產生，兩個數字問名冊 |
| `/p/<短編號>` | 島民證明（`design/copy/proof-page.md`） | Worker 產生，問名冊 |
| `/pages.css` | 訪客頁面的樣式表 | Static Assets 直接送 `site/pages.css`，不跑 Worker |
| `/proof` | 過卡的頁面：`web/` 建置的 `index.html`；`/proof/` 和 `/proof/index.html` 轉（`301`）到 `/proof` | Static Assets 直接送 `site/proof/` 的檔，不跑 Worker |
| `/proof/…` | 那份建置的其他檔案 | 同上 |
| 其他網址 | 「找不到這一頁」（`design/copy/not-found.md`），`404` | Worker 產生，不問名冊 |

「找不到這一頁」和其他頁面一樣有導覽列、頁尾，測試名冊時有標示和 `noindex`，快取 60 秒；舊後台對這種網址回的是純文字。`/api/` 底下不認得的路徑不是這一頁，是介面自己的 `404`（JSON）。首頁上連到查詢頁、名冊頁、常見問題、怎麼驗證、掛上去的連結照樣留著，那些頁面在 [#72](https://github.com/iamreal-tw/iamreal/issues/72)。

- **樣板、樣式表是舊後台的。** `src/pages/` 的 HTML 照 `server/pages/templates/` 逐段搬過來，`site/pages.css` 是 `server/pages/style.css` 加一條規則（測試名冊標示裡的日期不折行，見[測試名冊的標示](#測試名冊的標示)）；測試核對拿掉那一條之後兩個檔逐位元組相同。畫面上的每一句寫在樣板裡，逐字照 `design/copy/`；測試（[`test/pages.test.ts`](test/pages.test.ts)、[`test/copy.ts`](test/copy.ts)）直接讀 `design/copy/` 的每一段，確認那一種情況的每一句都在頁面上、順序相同。
- **放進 HTML 的值一律跳脫。** 樣板是 `src/pages/html.ts` 的 `html` 標籤：放進去的字串全部跳脫，只有這個標籤自己產生的片段不跳脫。訪客打的網址、名冊上的帳號都走這一條。
- **頁面預設沒有程式**：沒有 `<script>`、沒有行內樣式、沒有事件屬性，不設 cookie。只收 `GET` 和 `HEAD`，其他方法回 `405`。產生頁面時只讀請求的方法和路徑。
- **後台不存連線紀錄。** 頁面的請求也一樣，回答了就不寫任何東西。後台自己出錯時回 `500`（純文字），寫一行：`{event: "internal_error", page, where, error}`，`page` 是哪一種頁面（`home`、`card`、`none`），不含短編號和網址的任何部分。檔案的請求不跑 Worker，後台的程式對它們什麼都不寫。

### 讀名冊經過一個介面

頁面要的資料只從 [`src/page-data.ts`](src/page-data.ts) 的 `PageData` 拿（ADR-0026）：首頁的兩個數字、一個短編號對到的卡片。現在的實作 `pageDataOfRoster` 問名冊的 Durable Object；用哪一個實作只寫在 `src/index.ts` 一處。之後讀取要搬出 Durable Object（ADR-0026 的 Consequences），換的是這一塊，頁面的程式不動。

- **格式不對的短編號不問 Durable Object**：照 `spec/scoped-id.md` 的寬鬆讀法（`protocol/` 的 `readShortIdInUrl`，讀 `spec/vectors/scoped-id.json`）讀不成 10 個字元的，直接回「找不到這張島民證明」那一頁，`404`。讀得成、但寫法不是標準的那一種（小寫、`O`、`I`、`L`），`301` 轉到標準寫法，也不問。測試把 Durable Object 弄成什麼都不答來確認這兩種照樣回答。
- **快取**：首頁和島民證明的回應帶 `Cache-Control: public, max-age=60`，查不到的 `404` 和轉址也一樣（ADR-0026：沒帶的話，Workers 前面的快取會把 `404` 放更久）。所以一筆紀錄寫入後，頁面最慢 60 秒後跟上；Worker 自己不另外存一份，每個跑到 Worker 的請求都問當下的名冊。樣式表帶 `no-cache`，靠 `ETag` 重新確認（寫在 `site/_headers`）。`/api/` 的回應是 `no-store`，`405` 和 `500` 也是。
- **首頁的兩個數字**：現在把 Threads 的名額給了某個帳號的卡片有幾張；其中上次過卡日在今天往回 90 天以內（含第 90 天）的有幾張，今天照台灣的日期。一個查詢、一個索引（`src/views.ts` 的 `counts`）。
- **頁面只列 Threads**（`src/pages/proof.ts` 的 `PLATFORM`）：測試名冊另一個平台 `test-example` 的帳號不出現在頁面上。

### 頁面用的衍生表

名冊的 Durable Object 裡 `view_` 開頭的四張表（[`src/views.ts`](src/views.ts)），內容和舊後台的四張相同（`server/store/sqlite_view.go`）：

| 表 | 一列是什麼 |
|---|---|
| `view_state` | 只有一列：衍生表反映到第幾筆紀錄 |
| `view_cards` | 一張有過有效紀錄的卡片：短編號、第一次過卡日、上次過卡日、過卡幾次 |
| `view_slots` | 一張卡片在一個平台的名額：現在的帳號、從哪一天哪一筆開始、更換過幾次、上次過卡日 |
| `view_history` | 一筆有效紀錄在一個平台做了什麼：種類、是不是收回之後、之前和之後的帳號 |

- **和紀錄在同一個交易寫**（[寫入是一個交易](#寫入是一個交易)）。寫進去的是名冊規則算出來的種類和前後的狀態，這裡不判斷任何一筆是哪一種。
- **可以整份重建。** 物件啟動時，衍生表反映到的筆數和名冊的筆數不同就清掉重寫（`rebuildViews`）：照序號讀存著的每一行，用 `protocol/` 的 `applyList`（名冊規則的檢查 5、6 和之後的狀態）從空的狀態一筆一筆重算。存著的紀錄都是寫入時過了檢查 1 到 4 的，所以只重算後半；哪一筆讀不懂或規則不接受，整個重建就不算數，衍生表維持原樣（見下面「衍生表沒跟上時」）。重建會發生在兩種時候：物件是這幾張表出現之前建的（表的版本沒有變，`CREATE TABLE IF NOT EXISTS` 補上空表），或衍生表被清掉。測試確認重建的結果逐列和一筆一筆寫的相同，頁面也相同。
- **`paused` 時不重建**：存著的規則版本和程式的不同時，那些紀錄不是這一版規則收下的，不拿這一版去重算種類。衍生表本來就跟到最後一筆的話，頁面照常。
- **衍生表沒跟上時**（物件啟動時決定一次）：衍生表反映到的筆數和名冊的筆數不同，而且重建失敗，或正在 `paused` 不能重建。這時候物件照樣啟動，但不用衍生表：
  - 首頁和島民證明回 `500`（純文字，`no-store`）。不拿沒跟上的衍生表出頁面：那會是「現在有 0 張」，或把一張存在的島民證明說成找不到，還被快取 60 秒。格式不對的短編號和「找不到這一頁」不問名冊，照常。
  - 送出一筆（`POST /api/v1/records`）回 `500` `internal`，和後台自己出錯時相同（`docs/api/card-proof.md`），什麼都不寫，題目不算用過、也不算送過一次。`paused` 時照舊是 `503` `paused`。
  - 拿題目、讀卡片現況、清冊鏡像照常：它們不讀衍生表。
  - 重建失敗時寫一行 `{event: "views_not_filled", error}`。物件每次啟動都再試一次；原因排除後（例如部署了讀得懂那一筆的程式），下一次啟動就補上。
  - **營運上的後果**：一筆這一版程式讀不懂、或規則不接受的 `records` 列，會讓頁面和送出都停在 `500`，直到換上處理得了它的程式；但已經過卡的人查得到現況，名冊本身（紀錄、卡片狀態、名冊指紋）沒有被動到。後台自己不會寫出這樣的列；會碰到的情況是名冊規則改了、舊的紀錄照新規則不接受，那照 ADR-0030、ADR-0031 本來就要先處理。
- **紀錄搬到 R2 之後**（[#70](https://github.com/iamreal-tw/iamreal/issues/70)）Durable Object 裡不再有全部的紀錄，這個重建要改成也讀 R2 的名冊檔；在那之前紀錄都在 `records` 表。
- 日期存成天數（`protocol/` 的 `Day`），頁面的每個查詢各走一個索引。這張票只做了首頁和島民證明要的查詢；`view_slots_account` 現在是數卡片在用（`accountCards`，[寫入是一個交易](#寫入是一個交易)），查詢頁之後也用它；名冊頁要的 `view_slots_latest` 已經建了，還沒有查詢用到。

### 測試名冊的標示

`ROSTER_KIND` 是 `test` 時，每一頁最上面有一行 `測試名冊　不定期清空，上次清空：<日期>`（`design/copy/test-site.md`，[#59](https://github.com/iamreal-tw/iamreal/issues/59) 定的字），`404` 的頁面也有；日期是設定值 `TEST_ROSTER_CLEARED_ON`，寫在 `<time>` 裡，樣式表讓它不折行：手機寬度下整行放不下時，斷在日期之前，不斷在日期中間的連字號。每一頁的 `<head>` 有 `<meta name="robots" content="noindex">`，而且 `/api/` 以外的每個回應都帶 `X-Robots-Tag: noindex`（ADR-0028）：Worker 產生的每一頁（包括「找不到這一頁」、`405`、`500`）由 Worker 加，樣式表和 `/proof` 底下的每個回應由 `site/_headers` 加。正式名冊都沒有。

- **檔案的 `X-Robots-Tag` 不是 Worker 加的**，是 `site/_headers` 寫的，上傳時就定了，不跟著 `ROSTER_KIND` 變。所以 `_headers` 照名冊的種類各有一份（[`scripts/site-files.ts`](scripts/site-files.ts) 的 `siteHeaders`），版控裡的是測試名冊的；部署前的檢查核對每個環境的 `_headers` 是它那一種名冊的那一份（[Static Assets](#static-assets)）。
- `TEST_ROSTER_CLEARED_ON` 不是日期時，測試環境的介面和 Worker 產生的頁面都回 `500`（設定在同一處讀，`src/settings.ts`）：寧可不出頁面，也不出一行沒有日期的標示。樣式表和 `/proof` 的檔案不跑 Worker，照常送。`wrangler.jsonc` 裡的這個值在部署前就核對過是日曆上有的日期（`checkClearedOn`，`2026-11-31` 過不了），所以這種情況只會出在沒經過檢查的設定。
- **島民證明上寫的網址用測試網站的網域。** 個人檔案上要有的連結那一行、和短編號對不到時的那一句，測試名冊寫 `test.iamreal.tw/p/<短編號>`，正式名冊寫 `iamreal.tw/p/<短編號>`（`design/copy/test-site.md`「島民證明上寫的網址」）。網域跟著 `ROSTER_KIND` 走，寫在 `src/settings.ts` 的 `SITE_HOSTS`（ADR-0028 定的兩個網域），不是另一個設定值，也不從請求的 `Host` 取：`Host` 是訪客的瀏覽器送的。頁尾、分頁標題、連結預覽裡的 `iamreal.tw` 不變。
- **過卡的頁面自己沒有這一行。** `/proof` 是 `web/` 建置出來的檔案，原樣送出，只有標頭是另外加的；頁面上的標示要由 `web/` 測試網站的建置寫進去（[#69](https://github.com/iamreal-tw/iamreal/issues/69)），現在沒有。
- **清空測試名冊時**一起改三樣：`ROSTER_OBJECT_NAME`、清空測試的儲存桶、`TEST_ROSTER_CLEARED_ON`。

### 頁面送的標頭

定義在 [`src/headers.ts`](src/headers.ts) 一處，和舊後台送的那一組相同（`server/headers.go`、`server/visitor.go`）。測試對每一種回應核對整組標頭：多一個、少一個、值不同都不過。

送出去的地方有兩個，值都從那一處來：

- Worker 產生的頁面，由 `src/visitor.ts` 加上。
- 樣式表和 `/proof` 的檔案不跑 Worker，標頭寫在 [`site/_headers`](site/_headers)，由 Static Assets 加上。這個檔是 [`scripts/site-files.ts`](scripts/site-files.ts) 從 `src/headers.ts` 的值寫出來的，不手改；`src/headers.ts` 改了之後在這個目錄跑 `node --experimental-strip-types scripts/site-files.ts` 重寫。測試和部署前的檢查都核對版控裡的 `_headers` 和重寫出來的逐字相同。

每個回應：

| 標頭 | 值 | 理由 |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | 瀏覽器照 `Content-Type` 處理內容，不自己猜 |

訪客的頁面和樣式表：

| 標頭 | 值 | 理由 |
|---|---|---|
| `Content-Security-Policy` | `default-src 'none'; style-src 'self'; img-src 'self'; frame-src https://www.threads.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` | 頁面上任何程式都不執行（沒有 `script-src`）；樣式表和圖片只收自己網域的；只能嵌 Threads 的框（島民證明上的個人檔案）；表單只能送回自己的網域（名冊頁的查詢欄）；頁面不能被別的網站嵌進框裡 |
| `Referrer-Policy` | `no-referrer` | 從頁面點出去的連結、嵌進來的 Threads 個人檔案，都拿不到這一頁的網址（網址裡有短編號） |
| `Cross-Origin-Opener-Policy` | `same-origin` | 開啟這一頁的別的網站，和這一頁開出去的視窗，彼此拿不到對方 |
| （沒有 `Cross-Origin-Embedder-Policy`、`Document-Isolation-Policy`） | | 送了的話 Threads 的框會被擋 |

過卡的頁面和它的每個檔案（`/proof`、`/proof/…`）：`Content-Security-Policy`、`Document-Isolation-Policy: isolate-and-credentialless`、`Cross-Origin-Opener-Policy: same-origin-allow-popups` 三個，值和每一項的理由寫在 [`web/README.md`](../web/README.md)「頁面需要的標頭」。[`test/proof-files.test.ts`](test/proof-files.test.ts) 從那份 README 讀出這三個值，確認它們和 `src/headers.ts` 的相同，本機的 workerd 對 `/proof` 的每一種回應（檔案、`301`、`404`、`405`、`304`）送的也一字不差。`connect-src` 裡的資料網域寫的是 `https://data.iamreal.tw`，和舊後台相同；測試網站要的 `test-data.iamreal.tw` 在 [#69](https://github.com/iamreal-tw/iamreal/issues/69)。

測試名冊另外加 `X-Robots-Tag: noindex`（上一節）。

### Static Assets

`wrangler.jsonc` 最上層的 `assets` 指到 [`site/`](site)。這些檔案由 Cloudflare 直接送，**檔案的請求不跑 Worker**（ADR-0023「靜態檔」：這些下載不經過後台的程式）。要保住的是：持卡人拿到的過卡頁面就是建置出來的那些檔，後台沒有一段程式能對不同的人送不同的內容。這件事靠兩樣：這幾個路徑先找檔案、找到就直接送；Worker 沒有 binding，讀不到檔。下面寫的行為是在本機的 workerd 上看到的；其中沒有建置時的那些，Cloudflare 上也看過了，結果相同。看過的和還沒確認的列在這一節後面。

| `site/` 裡的 | 是什麼 |
|---|---|
| `pages.css` | 訪客頁面的樣式表，在版控裡 |
| `proof/` | 放 `web/` 建置的地方，不進版控 |
| `_headers` | 這些檔案的標頭，在版控裡，由 `scripts/site-files.ts` 寫出來（[頁面送的標頭](#頁面送的標頭)） |
| `_redirects` | `/proof` 的三條規則，在版控裡，內容是 `scripts/site-files.ts` 的 `SITE_REDIRECTS` |

`_headers` 和 `_redirects` 是給 Static Assets 讀的規則，本身不會被送出去。

**現在部署上去的檔案只有 `pages.css`、`_headers`、`_redirects`，`site/proof/` 是空的**：測試網站的建置模式還沒有（[#69](https://github.com/iamreal-tw/iamreal/issues/69)），正式的建置簽的是正式名冊的場合字串，不能放上測試網站。

- `site/proof/` 不進版控，所以一台電腦上的那個目錄裡可以有任何東西，而 wrangler 上傳的是它在 `site/` 找到的每個檔。部署前的檢查因此核對 `site/` 裡的檔案恰好是 `scripts/site-files.ts` 的 `SITE_FILES` 列的那三個，`pages.css` 的 SHA-256 是那裡寫的 `PAGES_CSS_SHA256`：`site/proof/` 有任何檔、多一個別的檔、樣式表被改過，本機的 `pnpm run deploy:test` 和 GitHub Actions 的 `build` 工作都停在檢查。改樣式表時連同那個 SHA-256 一起改（`shasum -a 256 site/pages.css`）。
- [#69](https://github.com/iamreal-tw/iamreal/issues/69) 把 `web/` 的建置放進來時，要改的就是 `SITE_FILES` 這一條（和工作流程）。
- 所以部署出去的 `/proof` 和它底下的網址沒有檔案可送，首頁的「我要換島民證明」點過去是 `404`。那是 Static Assets 回的空 `404`，帶 `/proof` 的那一組標頭，沒有跑 Worker；本機的 workerd 和 Cloudflare 上都是這樣（見下面「Cloudflare 上看過的」）。

設定的每一項：

- **`run_worker_first` 是 `["/*", "!/pages.css", "!/proof", "!/proof/*"]`**：這幾個路徑以外的請求先跑 Worker。`!` 開頭的是排除，排除優先；排除的路徑先找檔案，檔案在就直接送。本機的 workerd 上，排除的路徑不論檔案在不在都不跑 Worker：不在就由 Static Assets 自己回 `404`（空的內容）。Cloudflare 上檔案不在時也是這樣；檔案在的時候還沒看過（線上還沒有 `/proof` 的檔）。測試專用的建置記下每一個跑到 Worker 的請求（`GET /__test/seen`），`test/proof-files.test.ts` 用它確認 `/proof` 的檔案、轉址、`404`、`405` 沒有一個跑到 Worker。
- **沒有 `binding`**：Worker 沒有 `ASSETS`，讀不到這些檔，也就沒辦法自己送。部署前的檢查核對 wrangler 列出的 binding 裡沒有它。
- **`html_handling` 和 `not_found_handling` 都是 `none`**：一個路徑要嘛就是那個檔案，要嘛 `404`；不替目錄找 `index.html`、不把 `.html` 拿掉、沒有替代的頁面。
- **`_redirects`**：`/proof` 送 `proof/index.html` 的內容（`200`，網址不變）；`/proof/` 和 `/proof/index.html` 轉（`301`）到 `/proof`，和舊後台相同。說明頁留在 `/proof/help.html`。
- **`_headers`**：`/proof`、`/proof/*`、`/pages.css` 三條規則。本機的 workerd 上規則照路徑套用，不看檔案在不在，所以 `/proof` 底下的 `301`、`404`、`405` 也帶同一組標頭；Cloudflare 的文件只說規則套在靜態檔的回應上；線上 `301` 和 `404` 都帶，`405` 還沒看過（要有檔案才有 `405`）。樣式表的規則先拿掉 Static Assets 預設的 `Cache-Control` 再設 `no-cache`（同一個標頭設兩次會被接成一個值）。

沒有用 `html_handling: "drop-trailing-slash"`（它也能讓 `/proof` 送 `index.html`）：它會把每個 `.html` 的網址轉走，`/proof/help.html` 變成 `307` 到 `/proof/help`，首頁和過卡頁面連到說明頁的每個連結都多轉一次。

和 Worker 自己送的時候不同的地方（本機的 workerd 上量的，[`test/proof-files.test.ts`](test/proof-files.test.ts)）：

| 請求 | 現在 | 之前 |
|---|---|---|
| `/proof/index.html` | `301` 到 `/proof` | `200`，同一個檔兩個網址 |
| `/proof//index.html`、`/proof/%69ndex.html`、`/proof/assets%2findex.js` | `307` 到那個檔自己的路徑 | `200` |
| `/proof` 底下不存在的檔 | `404`，內容是空的 | `404`，`not found` |
| `/proof` 和它的檔用 `POST` 等其他方法 | `405`，沒有 `Allow` | `405`，`Allow: GET, HEAD` |
| `/proof/` 用 `POST` 等其他方法 | `301` 到 `/proof`（轉址不分方法） | `405` |
| 設定讀不出來時（`ROSTER_KIND` 不對等） | 檔案照常送 | `500` |
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

所以：

- `Document-Isolation-Policy` 和 `Cross-Origin-Opener-Policy` 寫在 `_headers` 裡，線上照樣送出。
- **排除的路徑上檔案不存在時，線上是 Static Assets 回 `404`，不轉給 Worker。** Cloudflare 的文件有三句，讀起來不完全一致；線上的行為是第一句和第三句照字面、而「asset-first」裡沒有第二句說的那一步：
  - 排除的路徑「will follow the default asset-first routing behavior」（[Configuration and Bindings](https://developers.cloudflare.com/workers/static-assets/binding/)）。
  - 預設的行為是「If no asset matches, Cloudflare invokes that version's `fetch()` handler. … A missing asset does not automatically produce a `404` response.」（[Worker script](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)）。
  - 排除的樣式「will continue to serve assets correctly, as requests are directed to assets, without invoking your Worker script」（[Billing and Limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)，講的是超過免費額度時）。

  這是看到的行為，文件沒有保證；部署前後的檢查沒有一項會發現它變了。它變了的話，檔案不存在的 `/proof` 網址會由 Worker 回「找不到這一頁」；Worker 仍然送不出檔案（沒有 binding），也改不了一個存在的檔。
- `_headers` 的規則套在不是檔案的回應上：`301` 和不存在的檔的 `404` 都帶。

**Cloudflare 上還沒確認的**（都要 `site/proof/` 有檔才看得到，[#69](https://github.com/iamreal-tw/iamreal/issues/69)）：

- 檔案存在時直接送、不跑 Worker。
- `/proof` 用 `_redirects` 的 `200` 送 `index.html` 時，`_headers` 的 `/proof` 那一條有沒有套上。本機有。
- 存在的檔用 `POST` 等其他方法是不是 `405`，帶不帶 `/proof` 的標頭。本機是、有帶。
- 上面「和 Worker 自己送的時候不同的地方」那張表裡 `307` 的那一列，和 `ETag`、`304`。

**加正式環境時**：`assets` 在最上層，每個環境共用同一個 `site/`，而 `_headers` 只有一份。正式名冊的 `_headers` 沒有 `X-Robots-Tag`，所以兩個環境不能用同一個目錄；部署前的檢查（`checkSiteFiles`）會擋下來。到時候給正式環境自己的目錄，或在上傳之前照環境寫出 `_headers`。

測試的工具把 `wrangler.jsonc` 原樣複製到每個測試自己的目錄再啟動 Worker，`./site` 就是那個測試自己的：設定和部署的是同一份，同時跑的測試不共用過卡頁面的檔案。`startWorker({ proofFiles })` 給一個目錄當 `site/proof/`；用正式名冊啟動時，工具把 `_headers` 換成正式名冊的那一份。

### 用假卡片走完一次

[`web/test/worker-card-proof.ts`](../web/test/worker-card-proof.ts)（在 `web/` 跑 `pnpm test:worker`，要先 `pnpm fetch-crs`）：`web/` 測試的建置放進 Worker 的 Static Assets，無頭的 Chrome 從畫面走完六步宣告 `@alice`；Worker 用部署的那一個驗證器驗假卡片的證明、寫入；然後打開 `/p/<短編號>` 和首頁，比對 `design/copy/` 的句子，各拍桌機和手機寬度的截圖（`web/test-output/worker/screens/`）。

- 清冊由 Worker 的排程從假的內政部鏡像進 R2 的模擬。測試的建置從自己的網域拿清冊，而 Worker 沒有把清冊送給人的路由，所以測試在 Worker 前面起一個小的服務扮演資料網域：`/crl/…` 從 R2 的模擬讀（只讀），其他請求原樣交給 Worker。
- 它用固定的埠 61171（假的元件），和 `web/` 的 `pnpm test:ui` 不能同時跑。
- 它現在不在 CI 裡，也不在 `CONTRIBUTING.md`「完成的定義」的清單上；`web/` 原有的兩套端到端測試改成對 Worker 跑是 [#69](https://github.com/iamreal-tw/iamreal/issues/69)。

## 三樣不是設定值的東西

後台認哪些發證金鑰、去哪裡抓內政部的清冊、現在幾點，都寫在程式裡，不是設定值（ADR-0028）：設定寫錯，不會讓後台收下假卡片簽的東西。

- [`src/target.ts`](src/target.ts) 是部署用的那一份：內政部的兩把發證金鑰（[`src/issuers.ts`](src/issuers.ts)，測試拿 `spec/vectors/issuers.json` 核對）、內政部的兩個清冊網址（和 [`crl/README.md`](../crl/README.md) 寫的相同）、真的時鐘。其他程式用 `#target` 這個名字引用它（`package.json` 的 `imports`）。
- [`test-build/`](test-build) 是測試專用的建置換上的那一份：`target.ts` 是測試當場產生的發證金鑰、假的內政部的網址、可以調的時鐘；`index.ts` 是進入點，在 Worker 前面多一個調時鐘的開關 `PUT /__test/clock`，和三個常設的入口，各測一件 `records` 看不到或到不了的事：
  - `POST /__test/verify` 讓測試直接呼叫驗證證明，呼叫的就是 `src/in-worker.ts` 的 `proofVerifier`，沒有換掉任何一部分。`records` 到不了的：和原生的 `bb verify` 逐案比對的 1,128 案，大多是任何一筆紀錄都帶不出來的公開輸入。
  - `GET /__test/newest-crls` 讓測試看得到名冊的 Durable Object 存著的最新清冊，呼叫的就是 `src/roster.ts` 的 `newestCrls`。`records` 看不到的：清冊鏡像的測試比的是 Durable Object 拿到哪幾份的編號和日期，`records` 只回收或不收。
  - `PUT /__test/roster/card` 照給的內容寫卡片狀態表的一列。`records` 寫不出來的：名冊規則不會留下的狀態。只用來寫這種狀態：壞掉的（`card-state` 要回 `500`），和少了平台表裡某個平台的名額的（平台加進表之前寫的）。唯一的例外是壞掉的那些案例的起點：每個壞掉的狀態都是從同一個好的狀態改一項來的，那個好的狀態也用這個入口寫一次，確認它本身讀得過。其他規則會留下的狀態，測試一律用真的送出（`POST /api/v1/records`）寫。
  - `PUT /__test/verifier` 選 `records` 用哪一個驗證器。預設是 `real`，就是部署的那一個；用真的證明的測試（[`test/records-real.test.ts`](test/records-real.test.ts)）用它。`stand-in` 只看證明的第一個位元組：0 通過、1 拒絕、2 是驗證器跑不起來、3 是先把測試的時鐘往後撥 1 毫秒再通過（驗證花了時間，用來測題目在驗證時過期）。做一份真的證明要卡片的金鑰和幾秒鐘，所以測題目、清冊、名冊規則、寫入的那些案例用它，和 Go 舊後台的測試相同（`server/harness_test.go` 的 `fakeProofs`）。它接在 `src/index.ts` 指定驗證器的同一個介面後面（`ApiParts`）。
  - `index.ts` 另外有通到名冊那個 Durable Object 的入口，`/__test/roster/…`。測試專用建置的 Durable Object 是部署的那一個類別（`src/roster.ts`）加上只給測試用的方法：現在就跑一次 alarm、讀 alarm 設在什麼時候；多塞一件假的定時工作、讀那件工作什麼時候跑過；指定下一個題目的 16 個位元組（測試才拿得到證明當初用的那個題目）；把存著的表的版本、規則的版本改成另一個數字；照給的內容寫卡片狀態表的一列（上面的 `PUT /__test/roster/card`）；把題目表和卡片狀態表丟掉、把一張卡片存著的名額改成不是 JSON 的字再改回來、或讓某一張表的每次寫入都失敗（看後台自己出錯時回什麼、寫到一半失敗留下什麼）；把最新清冊的那張表丟掉；拿 `spec/vectors/roster-rules.json` 的一筆事件（或長序列的一筆，寫法相同），對存著的狀態跑一次名冊規則（讀狀態、寫狀態用的是送出一筆的同一段程式；無效的紀錄後台不會寫，所以要有這個入口）；讀名冊上最晚的有效日期和每個帳號底下的卡片數，讀法和數法是部署的那一段（`POST /__test/roster/rule-state`，見[名冊規則和 Go 的 `roster/` 逐筆比對](#名冊規則和-go-的-roster-逐筆比對)）；讀出存著的紀錄和名冊那一列（`GET /__test/roster/stored`，部署的後台還沒有介面讀得到它們）；算一筆紀錄的雜湊之前先等幾毫秒、讀它算過幾次雜湊（`/__test/roster/hash-delay`，見[寫入是一個交易](#寫入是一個交易)）。部署的那一包沒有這些方法。
  - `PUT /__test/settings` 換掉環境的設定（`ROSTER_KIND`、`ROSTER_OBJECT_NAME`、`RESTRICT_LATE_SWITCHES`、`TEST_ROSTER_CLEARED_ON`）：換上的值只放在測試專用建置的記憶體裡，蓋在 Worker 和 Durable Object 拿到的環境上。`wrangler.jsonc` 沒有動，部署的建置讀的是設定檔裡的值。正式名冊的案例、設定寫錯的案例、更換政策的案例用它測。
- 測試的發證金鑰每個測試的程序產生一次（[`test/crls.ts`](test/crls.ts)）。私鑰留在那個程序的記憶體裡，用來簽測試的清冊；不寫進任何檔案，也不進任何建置。和 `crl/testdata/` 比對的那個測試，G2 換成簽 `crl/testdata/` 的那一把（只有公鑰）。
- 怎麼換：[`test/build.ts`](test/build.ts) 經由 [`scripts/deploy.ts`](scripts/deploy.ts) 的 `bundleWorker` 跑 `wrangler deploy --dry-run`，用 `--alias` 把 `#target` 指到 `test-build/target.ts`，進入點換成 `test-build/index.ts`，金鑰和網址用 `--define` 帶進去。wrangler 的設定檔和部署的指令裡沒有這些參數，所以部署的建置拿到的一定是 `src/target.ts`。
- 部署的那一包在上傳之前一定經過 [`scripts/deploy-build-checks.ts`](scripts/deploy-build-checks.ts) 的檢查（本機的 `pnpm run deploy:test` 和 GitHub Actions 的 `build` 工作都是，見「[部署測試環境](#部署測試環境)」）：
  - JavaScript 裡的網址只有內政部的兩個，加上頁面和標頭裡寫的那幾個（`PAGE_ADDRESSES`：公開的程式庫、Threads）。後面這幾個只是寫在頁面和標頭裡的字，Worker 自己發出的請求仍然只有內政部的兩份清冊。過卡頁面的 CSP 裡的資料網域不在這一包裡：那一組標頭寫在 `site/_headers`
  - JavaScript 裡長到可能是 RSA 金鑰的字串，恰好是 `spec/vectors/issuers.json` 的兩個模數，加上 Barretenberg 通用參數的那一個點（128 個位元組寫成十六進位，用它的 SHA-256 認，要恰好出現一次）。找得到的寫法是十六進位、十進位、base64、PEM；拆成數字陣列或執行時才拼起來的金鑰，這個檢查看不到
  - 沒有假的內政部、時鐘的開關和測試專用建置的其他痕跡
  - wrangler 列出的 binding 只有 `ROSTER`、`DATA`、`ROSTER_OBJECT_NAME`、`ROSTER_KIND`、`TEST_ROSTER_CLEARED_ON`，所以金鑰、網址、時鐘沒有設定值可以讀，Worker 也沒有 `ASSETS` 可以讀 Static Assets 的檔。用 `wrangler secret` 另外設在 Worker 上的密鑰不在設定檔裡，這個檢查看不到
  - 不是 JavaScript 的模組恰好是 WASM 檔和兩把驗證金鑰，SHA-256 是核對過的那三個
  - `wrangler.jsonc` 每一個環境的 `limits.cpu_ms` 都是鏡像一輪假設自己拿得到的 CPU 時間（`src/round-budget.ts` 的 `ROUND_CPU_MS`，300,000 毫秒）。設定檔裡有幾個環境就讀幾次，每個照 wrangler 讀 `--env <名稱>` 的方式讀；有一個環境沒有設、或是別的數字就不過。這一項用 wrangler 的函式庫在跑檢查的那個程序裡讀設定檔，不另外起指令，也不送請求
  - `wrangler.jsonc` 裡用測試名冊的環境，`TEST_ROSTER_CLEARED_ON` 是日曆上有的日期，讀法和 Worker 執行時相同（`checkClearedOn`）。寫錯的話部署出去的測試網站全部回 `500`，這一項讓它在部署前就被擋下
  - `wrangler.jsonc` 每一個環境的 Static Assets（`checkSiteFiles`，讀法同上一項）：`run_worker_first` 是把 `/pages.css`、`/proof`、`/proof/*` 排除在外的那一份，沒有 `binding`，`html_handling` 和 `not_found_handling` 是 `none`；那個環境的 `site/_headers` 和 `scripts/site-files.ts` 照它的 `ROSTER_KIND` 寫出來的逐字相同，`site/_redirects` 也是；`site/` 裡的檔案恰好是 `pages.css`、`_headers`、`_redirects`，`pages.css` 的 SHA-256 是 `scripts/site-files.ts` 寫的那一個。所以 `site/proof/` 裡留著東西、把設定改回「每個請求先跑 Worker」、手改一個標頭、或測試網站的 `_headers` 少了 `noindex`，都過不了
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

`IAMREAL_BB` 指到 `bb` 6.0.0（和 Go 的測試同一個變數），另外要有 `go`；沒設就跳過。約 80 秒。GitHub Actions 上，每個 PR 的 `typescript` 工作（`.github/workflows/checks.yml`）設了兩樣，會跑到它；`web/` 的兩套瀏覽器測試在另一個工作流程，只在它們用到的檔改了才跑（`.github/README.md`）。[`test/compare.test.ts`](test/compare.test.ts) 做的事：

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
| `durable_objects` | `ROSTER` → 類別 `Roster` | 一份名冊一個 Durable Object |
| `r2_buckets` | `DATA` → `iamreal-test-data` | 公開的檔案，經 `test-data.iamreal.tw` 下載（ADR-0027） |
| `vars.ROSTER_OBJECT_NAME` | `test-1` | 名冊那個 Durable Object 的名稱。清空測試名冊就是換一個名稱；換名稱時維持 `test-` 開頭（[名冊和物件的名稱要對得上](#名冊和物件的名稱要對得上)） |
| `vars.ROSTER_KIND` | `test` | 這個環境用哪一份名冊，`test` 或 `production`。它決定接受哪個場合字串、平台表是哪一張（ADR-0028）；兩者的內容寫在 `protocol/`，不在設定裡。不是這兩個值、或和 `ROSTER_OBJECT_NAME` 對不上時，四個介面和 Worker 產生的每個頁面都回 `500`（Static Assets 的檔案不跑 Worker，照常送） |
| `vars.TEST_ROSTER_CLEARED_ON` | `2026-11-19` | 測試名冊上次清空的日期，每一頁的標示旁寫它（[測試名冊的標示](#測試名冊的標示)）。還沒清空過，所以是測試網站第一次部署的日期（[第一次部署量到的](#第一次部署量到的)）。清空時和 `ROSTER_OBJECT_NAME` 一起改 |
| `assets`（最上層，每個環境共用） | `./site`，沒有 binding | 樣式表和過卡頁面的檔案，Cloudflare 直接送，不跑 Worker（[Static Assets](#static-assets)） |

**`limits.cpu_ms` 是 `300000`，寫在最上層。** 一次呼叫最多用多少 CPU 時間：300,000 毫秒是能設的最大值，沒有設是 30 秒（[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)「CPU time」，2026-11-20 讀的），一棵樹都建不完（[Cloudflare 上第一次建樹](#cloudflare-上第一次建樹)）。

- **為什麼在最上層**：鏡像的一輪照這個數字留餘裕（`src/round-budget.ts` 的 `ROUND_CPU_MS`），那是程式裡的常數，每個環境都一樣。wrangler 4.160.1 讀設定時，`limits` 是環境沒寫就沿用最上層的那一種欄位（`wrangler-dist/cli.js` 的 `normalizeAndValidateLimits` 呼叫 `inheritable`：先拿環境自己的，沒有才拿最上層的），所以之後加的環境不用再寫一次就有。[`test/environments.test.ts`](test/environments.test.ts) 釘住最上層是 300,000、環境自己沒有另外寫、每個環境照 wrangler 的讀法讀到的都是 300,000；部署前的檢查對每個環境再核對一次。
- **它不只管排程。** 這是每一次呼叫的上限：每個 HTTP 請求一樣是 300,000 毫秒；名冊的 Durable Object 也是，它的每次呼叫和 alarm 用同一個設定（[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)：「Durable Objects are Worker scripts, and have the same per invocation CPU limits as any Workers do」，2026-11-20 讀的）。所以一個請求能讓後台算多久，現在是程式擋，不是這個上限擋。
- **現在可以接受的理由**：請求的內容最多讀 64 KiB（`src/api.ts` 的 `MAX_BODY_BYTES`），超過就拒絕；四個介面做的事和內容的大小無關或只和這 64 KiB 有關。送出一筆（[送出一筆](#送出一筆)）每次驗一筆證明，工作量是固定的，本機約 15 ms（[量到的](#量到的)），而且一個題目最多驗 5 次。Durable Object 裡沒有照請求內容放大的計算：寫入一筆和頁面的每個查詢各走索引；一個短編號對到的卡片通常只有一張，島民證明要讀的是那張卡片的全部紀錄，一張卡片一天最多 3 筆。頁面只收 `GET`，不讀請求的內容。之後加的介面要守住這一點：有哪個請求能讓後台算上幾秒，這個上限就不再是它的保護。

之後加正式環境，是在 `env` 底下多一段；Worker 的程式不用改，但 Static Assets 的檔案要分開：兩種名冊的 `_headers` 不同，共用同一個 `site/` 過不了部署前的檢查（[Static Assets](#static-assets)「加正式環境時」），`test/environments.test.ts` 也要加對應的一段。最上層沒有 `name`，也沒有 binding：指令沒帶 `--env` 時，wrangler 拿套件名稱 `iamreal-worker` 當 Worker 的名稱，不會是 `iamreal-test`。

## 排程做什麼

每小時一次，一輪清冊鏡像（[`src/mirror.ts`](src/mirror.ts)），照 [`spec/revocation-tree.md`](../spec/revocation-tree.md)。三步：

**一、抓和存。**

1. 同時抓 G2、G3 的清冊，兩份互不等待。每一份從送出請求到收完最多等 5 分鐘：G2 的清冊約 17 MB，每秒 0.5 Mbit 也收得完；排程一次的牆上時間最多 15 分鐘（[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)「Wall time limits by invocation type」），等回應的時間不算 CPU 時間（同一頁「CPU time」）。
2. 收到完整的 `200` 時，算內容的 SHA-256。R2 裡已經有 `crl/<SHA-256>.crl` 就不重存；沒有才寫入。
3. 下面的情況算失敗，那一份不存任何檔，另一份照常：
   - 狀態不是 `200`、連不上、超過 5 分鐘
   - 執行環境回報連線中斷
   - 收到的長度和回應的 `Content-Length` 不同
   - 內容是 0 個位元組
   - 內容超過 32 MiB（33,554,432 個位元組）。回應有 `Content-Length` 時看它，不讀內容；沒有時邊讀邊數，超過就停

**二、補索引。** 列出儲存桶裡 `crl/` 底下的清冊檔，讀 `crl/index.jsonl`；有檔案、索引裡沒有行的，一個一個讀出來：

1. 核對內容的 SHA-256 和檔名相同。
2. 讀清冊、驗章（[`src/crl.ts`](src/crl.ts)）：可不可用、原因代碼和它們的順序，和 Go 的 [`crl/`](../crl) 相同。簽章用兩把發證金鑰各試一次，哪一把驗得過，`issuer` 就是哪一把。
3. 可用的建樹（[`src/crl-tree.ts`](src/crl-tree.ts)），得到樹根。
4. 這個檔的行加進索引，整份索引重寫一次。
5. 把索引現在列著的最新清冊告訴名冊的 Durable Object（第三步）。

所以：

- **可用不可用都存、都有一行。** 內政部的伺服器回一頁 HTML 的錯誤訊息，也會存起來，索引裡是 `-not_usable_der`。
- **索引裡已經有的檔不再讀、不再建樹。** 內政部沒有換清冊的那幾個小時，這一步只列一次儲存桶、讀一次索引，索引不重寫。
- **寫到一半失敗，下一輪補得回來。** 補的依據是儲存桶裡有什麼，不是這一輪抓到什麼：上一輪存了檔、還沒寫行就結束，這一輪補上那一行，內政部那時已經換了清冊也一樣。索引是一個物件，每次整份換掉，不會有人讀到半份。讀到的索引有寫法不合規格的行、重複的行、對不到檔案的行時，那些行不算數，從檔案重來。
- **一個檔拿不到行，只是那個檔的事。** 內容和檔名不符、讀不出來、建樹時 Barretenberg 出錯：那個檔記一行 `failed`，其他檔照做，Durable Object 照樣被告知，下一輪再試那個檔。這一次排程最後以例外結束。
- **這一輪抓到的檔先做，一定做。** 之前留下、還沒有行的檔接著做，照寫進儲存桶的時間，新的先做（過卡要用的是最新的清冊）；但這一輪開始補索引滿 2.5 分鐘之後就不再開始新的一份，留給下一輪。一輪假設自己拿得到 300,000 毫秒的 CPU 時間（`wrangler.jsonc` 的 `limits.cpu_ms` 設的數字；排程實際拿到的是不是這個數字還沒量到，見 [Cloudflare 上第一次建樹](#cloudflare-上第一次建樹)），留下的 2.5 分鐘給最後開始的那一份建樹：最大的一份（G2）在本機要 27 到 29 秒，留的是本機的 5 倍；Cloudflare 上量到的是四棵樹約 157 秒，不到本機的 2 倍。Worker 裡讀不到自己用了多少 CPU 時間，所以用牆上時間算；補索引這一段不是在算就是在等儲存桶，用掉的 CPU 時間不會比牆上時間多。**這個算法靠時鐘是新的，而 Cloudflare 上的時鐘只在 I/O 之後才前進**：程式在算的時候 `Date.now()` 停在上一次 I/O 的時間（[Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/)：「only advance or increment after I/O occurs」；[Security model](https://developers.cloudflare.com/workers/reference/security-model/)：「`Date.now()` returns the time of the last I/O. It does not advance during code execution」；2026-11-20 讀的）。一棵樹是幾十秒沒有 I/O 的計算，所以每次要不要再起一份之前，先對儲存桶問一次索引在不在（`head`），問完才讀時鐘（`src/mirror.ts` 的 `elapsedMs`）；前一份失敗、後面沒有任何 I/O 的時候也一樣。把讀時鐘挪到別的地方，這條界線在線上會無聲地失效，而本機的 workerd 時鐘照常前進（同一頁：「In local development, however, timers will increment regardless of whether I/O happens or not」），測試看不出來。整份索引不見時，要分好幾輪才補得完，每一輪寫的行都留著。
- **一輪做到一半被停掉，寫好的行留著。** 用完 CPU 時間的那一次呼叫會被 Cloudflare 停掉。索引每做完一個檔就寫一次、寫完就告訴 Durable Object，所以停在第二份的建樹時，第一份的行已經在索引裡、Durable Object 也知道；第二份的檔已經存著，之後的某一輪補它的行。這一輪抓到的兩份不看時間、一定做：兩份加起來超過一次呼叫的上限時，沒有哪一輪做得完，那是把鏡像搬出 Worker 的時候（ADR-0023）。
- **兩輪同時跑，不會蓋掉對方的行。** 索引用條件式寫入：只有儲存桶裡的索引還是這一輪讀到的那一份（照 ETag），或讀的時候沒有、現在也還沒有，才寫得進去（[R2 的條件式操作](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations)）。寫不進去就重讀索引、把自己的行加到新的那一份上再寫，最多試 5 次。Durable Object 那邊沒有同樣的保護：`setNewestCrls` 整份換掉、不比新舊，所以兩輪同時跑時，比較晚讀索引的那一輪第一次交，可能把 Durable Object 換回比較舊的兩份，到它下一次交（寫完下一行，或下一輪開始）才又是最新的。排程一小時一次、一輪不到一分鐘，兩輪重疊要有一輪跑超過一小時或被手動觸發。
- **讀一個檔花的時間不超過它大小的線性倍數，除了一處。** 延伸欄位有沒有重複用集合找，不是兩兩比。清冊編號沒有長度上限（和 Go 相同），位元組一次轉成整數；但把整數印成十進位是 JavaScript 引擎做的，比線性慢：見[量到的](#清冊鏡像量到的)。
- **不替每一筆廢止建物件**（[#26](https://github.com/iamreal-tw/iamreal/issues/26)）：在原始位元組上逐筆走，每個序號的鍵直接寫進一個 `Uint32Array`，重複的序號和最低 127 位元相同的鍵用排序找。讀完之後檔案的位元組就放掉，建樹時只留著鍵。
- **建樹時讓出執行緒。** 樹切成最多 4,096 塊（樹根往下 12 層的子樹），每做完約 256 個鍵就等一次 `setTimeout(0)`，同一個實例裡等著的請求在這時候被處理。

**三、告訴名冊的 Durable Object。** 從索引取每把發證金鑰最新兩份可用的清冊（照清冊編號，和裝置選清冊的方法相同；不可用的不算），把樹根、編號、清冊日期交給名冊的 Durable Object，它整份換掉自己存的（[`src/roster.ts`](src/roster.ts) 的 `setNewestCrls`）。每一輪一開始讀完索引就交一次，不管有沒有新的清冊；之後每寫完一次索引再交一次，所以 G2 的新清冊不用等 G3 的樹建完。

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

- `crl_mirror` 的 `result` 是 `stored`（新的一份）、`already_stored`（已經有）、`failed`（附 `error`）。
- `crl_index` 的 `result` 是 `indexed` 或 `failed`（附 `error`）。`entries` 是廢止的筆數，`keys` 是樹裡的鍵數，`hashes` 是建樹算了幾次 Poseidon2；`read_ms` 是從儲存桶讀出來到驗完章，`tree_ms` 是建樹，都是毫秒。**`read_ms` 和 `tree_ms` 只有在本機是準的**：Cloudflare 上時鐘在計算時不前進（見上面「這一輪抓到的檔先做」），這兩個數字都是算完才讀時鐘，中間沒有 I/O，線上會偏小，可能是 0。線上用了多少 CPU 時間看儀表板的 Metrics。

### 和 Go 的 `crl/` 逐案比對

[`test/crl-testdata.test.ts`](test/crl-testdata.test.ts)，在 `pnpm test` 裡。每一份清冊當成假的內政部的回應，經過本機 workerd 裡的整個 Worker，看儲存桶裡的索引。

1. `crl/testdata/` 的 37 份自製清冊：每一份的可用不可用、原因代碼、樹根、編號、時間、清冊日期，和 `crl/testdata/expected.json`（Go 的測試讀的同一份）相同。
2. `crl/testdata/times/` 的 48 份：`thisUpdate`、`nextUpdate` 用各種寫法（沒有秒的 UTCTime、帶時差、西元 0 年以前和 9999 年以後、不存在的日期……；線上那兩份清冊的時間都是 12 位數字加 `Z` 的 UTCTime）。每一份在索引裡的那一行，和 `crl/testdata/times/expected.json` 寫的逐字相同，Go 的測試讀同一份。這些案例記的是 Go 的 `crl/` 和這裡現在得到相同的結果，不是規格的標準答案。時間接受哪些寫法，規格還沒有定：[#120](https://github.com/iamreal-tw/iamreal/issues/120) 會收窄成 RFC 5280 的寫法，那時這些案例的答案會跟著改。`web/` 現在的讀法比這裡嚴（只收 `Z` 結尾、有秒的寫法），沒有讀這些案例。
3. 把儲存桶裡的清冊檔寫到一個目錄，跑 Go 的 `iamreal-crl index`，印出來的索引和儲存桶裡的 `crl/index.jsonl` 逐位元組相同。除了上面 85 份，還有 3 個不是清冊的檔和 1 份測試金鑰簽的清冊。**這一項要有 `go`，沒有就跳過；前兩項不用。**

2026-11-20 跑的結果：三項都過，共 89 個檔，索引 89 行，沒有一行不同。

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

**故意做來拖時間的檔**，在 Node 22 裡量讀一個檔（`readCrl`）的時間。這種檔不需要簽章就會被存下來：內政部的網址是 `http://`，路上的人可以換掉回應。

| 檔案 | 讀一次 | Go 的 `iamreal-crl check` |
|---|---|---|
| 清冊編號是 400,000 個位元組的整數 | 0.2 秒（修正前 26.3 秒） | 0.14 秒 |
| 清冊編號是 4,000,000 個位元組的整數 | 2.9 秒 | 5.0 秒 |
| 清冊編號是 16,000,000 個位元組的整數 | 14.9 秒 | 44.4 秒 |
| 30,000 個不同的延伸欄位（390 KB） | 12 ms（修正前 27.2 秒） | 沒量 |

- 清冊編號的時間幾乎都花在把整數印成十進位，這一步是一次同步的呼叫，中間不讓出執行緒；Go 也是這裡慢。
- **記憶體才是問題。** 第二輪審查 2026-11-20 在 Node 裡量讀這種檔時記憶體的高點多出多少：清冊編號 1 MB 時多 97 MiB，4 MB 時多 339 MiB，32 MiB（下載上限之內最大的）時多 2.7 GiB；280 萬個延伸欄位的檔多 623 MiB。把 JavaScript 的記憶體限在 100 MB，這兩種檔都讓程序當掉。這些數字不是這裡量的，也不是在 workerd 裡量的。
- **在 Cloudflare 上會怎樣沒有量過。** 每個實例的記憶體上限是 128 MB（[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)），照上面的數字，讀這種檔比較可能的結果是實例被終止，不是多等幾十秒。
- **這種檔會讓每一輪都停在它。** 它存進了儲存桶、沒有行，之後每一輪都會再讀它；讀它的那一輪如果被終止，排在它後面的檔和那一輪之後的事都做不到。下載上限 32 MiB 擋不住：上面最小的例子是 1 MB。
- 讀得完的時候，索引的那一行帶著整個十進位的編號：4 MB 的整數是 960 萬個數字的一行。清冊檔和它的行都不刪（ADR-0027），所以這一行會一直留在每台裝置過卡時都要下載的索引裡。
- 清冊編號和清冊層級延伸欄位的上限由 [#120](https://github.com/iamreal-tw/iamreal/issues/120) 在規格裡定，這一版沒有做。

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
| 名冊的 Durable Object 知道的最新清冊 | `worker.newestCrls()` |
| 把儲存桶弄成上一輪做到一半的樣子 | `worker.putFile(檔名, 內容)`、`worker.deleteFile(檔名)` |
| 假的內政部不帶 `Content-Length` | `worker.moica.serve("G2", 位元組, "chunked")` |
| 改一輪補舊檔的界線 | `startWorker({ crlCatchUpMs: 0 })`，預設是部署的 2.5 分鐘 |
| 重啟整個 Worker（連同 Durable Object） | `worker.restart()`：儲存的東西和儲存桶的檔案留著，記憶體裡的（包括調過的時鐘）不見 |
| 換發證金鑰 | `startWorker({ issuers: [G2, G3] })`，預設是測試自己的兩把 |
| 重啟名冊的 Durable Object | `worker.roster.restart()`：記憶體裡的東西丟掉，存著的留著 |
| 跑 Durable Object 的 alarm、看它設在多久之後 | `worker.roster.runAlarm()`、`worker.roster.alarmInMs()` |
| 要一個題目 | `worker.issueChallenge()`；`worker.issueChallenge(十六進位的 16 個位元組)` 指定題目的亂數那一段 |
| 換 `records` 用的驗證器 | `worker.setVerifier("stand-in")`、`("real")` |
| 送出一筆、看卡片現況、發一份清冊、換一份空的名冊 | [`test/records.ts`](test/records.ts) 的 `sub`、`submit`、`mustSubmit`、`wantError`、`cardState`、`publishCrl`、`day`、`freshRoster` |
| 寫卡片狀態表的一列 | `worker.roster.writeCard({…})`，寫法和 `card-state` 的回應相同。只用在名冊規則不會留下的狀態（壞掉的、少了某個平台的名額的）和那些壞掉的案例的起點；其他規則會留下的狀態用 `sub`、`mustSubmit` 真的送出 |
| 後台還認得哪些題目 | `worker.roster.knownChallenges()`：問 `records`，回 `challenge_unknown` 的就是不認得。問一次算一次送出 |
| 讓某一張表的寫入失敗 | `worker.roster.failWritesTo("cards")`，`(null)` 恢復 |
| 把存著的規則版本改成另一個數字、改回來 | `worker.roster.setStoredRulesVersion("another")`、`("the build's")`，之後 `worker.roster.restart()` |
| 對存著的狀態跑一筆標準答案的事件 | `worker.roster.applyRuleEvent(事件)` |
| 讀名冊上最晚的有效日期、每個帳號底下的卡片數 | `worker.roster.ruleState(場合字串, 匿名編號)` |
| 讓後台自己出錯 | `worker.roster.breakTables()` |
| 把一張卡片存著的名額弄壞 | `worker.roster.breakCard(匿名編號)`：改成不是 JSON 的字，讀到那一列的都會丟例外；`worker.roster.mendCard(匿名編號)` 改回原樣 |
| 讀存著的紀錄和名冊那一列、照規格重算 | `worker.roster.stored()` 讀出來；`test/records.ts` 的 `checkRoster(worker)` 重算每一行、紀錄雜湊、名冊指紋，回傳每一筆紀錄 |
| 讓同時送出的請求真的交錯 | `worker.roster.setHashDelay(毫秒)`：算紀錄雜湊之前先等；`worker.roster.hashes()` 是算過幾次 |
| 驗證花了時間的證明 | `test/records.ts` 的 `SLOW_PROOF`（替身驗證器）：通過，但時鐘往後 1 毫秒 |
| 把存著的表的版本改成另一個數字、改回來 | `worker.roster.setStoredSchemaVersion("another")`、`("the build's")`，之後 `worker.roster.restart()` |
| 多塞一件定時的工作、看它什麼時候跑過 | `worker.roster.setExtraWork(到期的時間, 間隔)`、`worker.roster.extraWorkRuns()` |
| 換掉環境的設定 | `startWorker({ settings: { ROSTER_KIND: "production", ROSTER_OBJECT_NAME: "…" } })`，或啟動後 `worker.setSettings({…})`；已經在跑的 Durable Object 要 `worker.roster.restart()` 才讀到新的 |

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

部署分兩段，本機和 GitHub Actions 走同一段程式（[`scripts/deploy.ts`](scripts/deploy.ts)）：

1. **打包**（`buildDeploy`）：先核對 WASM 檔和驗證金鑰的 SHA-256（[WASM 檔和驗證金鑰從哪裡來](#wasm-檔和驗證金鑰從哪裡來)），不對就停；再用 `wrangler deploy --dry-run --outdir <目錄>` 打包，不帶權杖；最後跑部署那一包的檢查（[三樣不是設定值的東西](#三樣不是設定值的東西)）；其中核對 `limits.cpu_ms` 的那一項不是起 wrangler 的指令，是在跑檢查的這個程序裡用 wrangler 的函式庫讀 `wrangler.jsonc`。打包唯一的入口是 `bundleWorker`，測試專用的建置也經過它：打包之前要做的事只寫在那裡。
2. **上傳**（`uploadArgs`）：`wrangler deploy <目錄>/index.js --no-bundle`，把那一包程式原樣上傳，旁邊的 WASM 檔和驗證金鑰照 wrangler 的副檔名規則一起帶上（`test/bundle.test.ts` 用 `--dry-run` 確認），binding 照 `wrangler.jsonc`。只有這一段的 wrangler 指令帶權杖。
   **Static Assets 的檔案不在那一包裡**：wrangler 上傳時照 `wrangler.jsonc` 的 `assets.directory` 讀工作目錄裡的 `site/`，一起上傳。在 GitHub Actions 上，那是 `deploy` 工作自己 checkout 出來的 `worker/site/`（版控裡的 `pages.css`、`_headers`、`_redirects`），不是 `build` 工作交出來的 artifact。兩個工作 checkout 的是同一個 commit；`build` 工作的檢查核對過那個 commit 的 `_headers`、`_redirects` 和設定（`checkSiteFiles`），`pages.css` 有測試和舊後台的樣式表比對。

兩段共用的參數：

- `--config wrangler.jsonc`：只讀這個設定檔，不會被 `.wrangler/deploy/config.json` 轉到別的檔。
- `--env test`：環境固定是測試環境。
- `--experimental-provision=false`：wrangler 不問 Cloudflare 儲存桶在不在；為什麼要帶，見[下一節](#第一次部署量到的)。
- `--env-file=/dev/null`：wrangler 4.160.1 啟動時會把工作目錄的 `.env`、`.env.local`、`.env.test`、`.env.test.local` 讀進自己的環境變數，除非 `--env-file` 指定別的檔（`wrangler-dist/cli.js`：`args["env-file"] ?? getDefaultEnvFiles(args.env)`，再交給 `loadDotEnv`）。這樣的檔可以設 `CLOUDFLARE_API_BASE_URL`，把權杖送到別的主機（用假權杖和本機監聽的伺服器試過，請求帶著 `Authorization: Bearer <權杖>` 送到了那裡）。指到 `/dev/null` 就一個也不讀（`test/deploy.test.ts`）。

本機：[`scripts/deploy-test.ts`](scripts/deploy-test.ts) 先打包到暫存目錄、跑完檢查，才讀程式庫根目錄的 `.env.local` 裡的兩行，`CLOUDFLARE_API_TOKEN_TEST` 和 `CLOUDFLARE_ACCOUNT_ID`，再上傳。那把權杖只能部署 `iamreal-test`（ADR-0029）。不用 `wrangler login`。shell 裡原有的 `CLOUDFLARE_*`、`CF_*`、`WRANGLER_*` 變數都不會傳給 wrangler 的指令（打包和上傳各起一個子程序，環境是濾過的），所以別的權杖或別的 API 網址不會被用到。這句話只對子程序成立：檢查裡讀設定檔的那一步在 `deploy-test.ts` 自己的程序裡用 wrangler 的函式庫做，那個程序的環境就是 shell 的；它只讀 `wrangler.jsonc`、不送請求，而且在讀 `.env.local` 之前就做完，權杖讀進來之後只放在交給上傳那個子程序的環境裡，不放進這個程序自己的環境變數。唯一接受的參數是 `--dry-run`：兩段都做，不上傳。正式環境只從 GitHub Actions 部署，這裡沒有它的指令。

### 從 GitHub Actions 部署

合併到 `main` 時，[`.github/workflows/deploy-test.yml`](../.github/workflows/deploy-test.yml) 部署測試環境（ADR-0029）。兩個工作：

1. `build`：沒有權杖。跑 [`scripts/build-deploy.ts`](scripts/build-deploy.ts)，就是上面的第一段，打包、檢查，交成 artifact。
2. `deploy`：在 `build` 之後。依序：裝 Node、用 npm 從 `https://registry.npmjs.org/` 裝 pnpm（這時還沒 checkout，程式庫裡的 `.npmrc` 不在）、checkout、用 pnpm 照 lockfile 裝 `worker/` 的套件（`--ignore-scripts`：不跑任何安裝腳本；`--ignore-pnpmfile`：不跑 `.pnpmfile.cjs`，`--ignore-scripts` 擋不住它，pnpm 10.16.1 試過；`--registry`：不照 `.npmrc` 換來源）、拿回那一包，最後一步上傳。之前沒有一步跑這個程式庫的程式。

權杖只在最後一步的環境裡：程式庫的 Actions secrets `CLOUDFLARE_API_TOKEN_TEST`、`CLOUDFLARE_ACCOUNT_ID`，交給 wrangler 時的名稱是 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。

**上傳的那一步還信任的東西**（改到它們的 PR 要逐行看，`CONTRIBUTING.md`「部署會執行到的東西」）：

- 釘在 commit 上的五個 action（清單在 [`test/workflows.ts`](test/workflows.ts) 的 `ACTIONS`）
- npm 上的 pnpm 10.16.1：沒有核對雜湊
- `pnpm-lock.yaml` 裡的套件，包括 wrangler：pnpm 核對 lockfile 記的雜湊，所以換來源換不了內容，但 lockfile 本身就是提交的一部分
- `pnpm-workspace.yaml`：安裝時一定會讀，設定能改裝進來的套件（例如 `patchedDependencies` 加一個 `patches/` 的修補，在 `--ignore-scripts --ignore-pnpmfile` 之下照樣套到 wrangler 上，試過）。`test/workflows.test.ts` 確認它只有現在的三個鍵、lockfile 沒有 `patchedDependencies` 這類段落、程式庫沒有追蹤 `.npmrc`、`.pnpmfile.cjs`、`patches/`、`worker/` 底下的 `.env*`
- `worker/site/`：Static Assets 的檔案（`pages.css`、`_headers`、`_redirects`）。它們不在 `build` 工作交出來的那一包裡，是 `deploy` 工作從自己的 checkout 上傳的；`_headers` 和 `_redirects` 決定這些檔案帶什麼標頭、哪些網址轉到哪裡。`build` 工作的檢查核對過同一個 commit 的這三個檔（`checkSiteFiles`）
- `wrangler.jsonc`：上傳時 wrangler 讀它。它不能有 `build.command`：wrangler 在上傳之前會執行它，加了 `--no-bundle` 也一樣（Cloudflare 的文件寫它「will be run as part of `wrangler dev` and `npx wrangler deploy`」，[custom builds](https://developers.cloudflare.com/workers/wrangler/custom-builds/)；wrangler 4.160.1 的 `getEntry`（`src/deployment-bundle/entry.ts`）不看 `--no-bundle` 就呼叫 `runCustomBuild`；用 `--no-bundle --dry-run` 試過，指令跑了）。`test/workflows.test.ts` 檢查設定檔沒有它

[`test/workflows.ts`](test/workflows.ts) 是工作流程的白名單：`deploy-test.yml` 的兩個工作必須逐字是那裡寫的（上傳那一行由 `uploadArgs` 組出來），PR 的兩個檢查工作流程 `checks.yml`、`checks-browser.yml` 的每個鍵、action、`with`、`env`、`working-directory` 都要在清單裡，觸發條件逐字照寫（`paths` 只准在 `checks-browser.yml`，內容逐字等於 `BROWSER_PATHS`），`concurrency` 的群組各自不同，整個 `.github/workflows/` 有 `secrets` 這個字的行（註解也算）恰好是上傳那一步的兩行。檔案用一個只讀 YAML 一小部分的讀法讀，那部分以外的寫法都算問題；檔裡只准可列印的 ASCII 和換行，註解也一樣，空白只認 ASCII 的空格（不然 U+00A0 這類空白開頭、接著 `#` 的一行，這裡當成註解，libyaml 這類照 YAML 規格只認 ASCII 空白的解析器卻會把它接到上一行的值後面，折進 `run`（#39 第二輪審查用 libyaml 實測））。它防手誤和明顯的改動，不能代替逐行看；它看不到什麼，寫在那個檔的開頭。

## 第一次部署量到的

2026-11-19，從營運者的電腦用 `.env.local` 那把只有 `iamreal-test` 的 `Editor` 的權杖部署（wrangler 4.160.1），版本 `12ae49e5-228c-4122-b1e7-335e47392499`。時間都是 UTC。經過記在 [#63](https://github.com/iamreal-tw/iamreal/issues/63)。這一節是 [#26](https://github.com/iamreal-tw/iamreal/issues/26) 和 ADR-0029 留下「部署時確認」的那兩件事的出處。

### 只有 `Editor` 權限的權杖也跑得了 Durable Object 的 migration

14:30 的部署上傳了帶 migration `v1`（`new_sqlite_classes: ["Roster"]`）的 Worker，沒有用別的權杖。部署後用同一把權杖讀 Worker 的設定（`GET …/workers/scripts/iamreal-test/settings`），`ROSTER` 這個 binding 帶著 Durable Object 的 `namespace_id`。只看過建立類別的這一種 migration；改名、刪除類別的沒有試過。

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
| `src/visitor.ts` | `/api/` 以外的網址：首頁、島民證明、樣式表、過卡的頁面和它的檔案；方法、轉址、`404`、快取、出錯時的那一行 |
| `src/headers.ts` | 頁面和檔案送的標頭，只定義在這裡 |
| `src/page-data.ts` | 頁面讀名冊的介面 `PageData`，和問 Durable Object 的那一個實作 |
| `src/views.ts` | 頁面用的衍生表：建表、一筆紀錄寫什麼、從紀錄重建、頁面的查詢、數有幾張卡片宣告同一個帳號 |
| `src/pages/` | 把資料變成 HTML：`html.ts`（跳脫）、`layout.ts`（每一頁的外框、導覽列、頁尾、測試名冊的標示）、`home.ts`、`proof.ts`、`not-found.ts`（找不到這一頁） |
| `site/` | Static Assets 的檔案，Cloudflare 直接送：`pages.css`、`_headers`、`_redirects` 在版控裡，`proof/` 放 `web/` 的建置 |
| `src/api.ts` | `/api/` 底下的介面：路徑和方法、每個回應的標頭、四個介面、後台自己出錯時的那一行 |
| `src/submission.ts` | 讀 `records` 的請求：`malformed`、`scope`、`platform` 各是哪一種 |
| `src/record-proof.ts` | 從一筆紀錄的欄位重建公開輸入、交給驗證器 |
| `src/json.ts` | 讀請求的 JSON，鍵重複就拒絕 |
| `src/mirror.ts` | 清冊鏡像：介面 `CrlMirror` 和在 Worker 裡做的那一個 |
| `src/crl.ts`、`src/crl-time.ts` | 讀一份清冊：可不可用、原因代碼、索引那一行的欄位、樹的鍵 |
| `src/crl-tree.ts` | 從鍵算樹根 |
| `src/crl-index.ts` | 索引的寫法和順序、最新兩份可用的清冊 |
| `src/roster.ts` | 名冊的 Durable Object：建表、發題目、算送出的次數、寫入一筆、讀卡片現況、刪過期的題目、存鏡像交給它的最新清冊 |
| `src/card-table.ts` | 卡片狀態表：建表的程式，讀（連同檢查）和寫一張卡片的狀態 |
| `src/slot-json.ts` | 一個名額寫成 JSON 的那一種寫法：`card-state` 的回應和卡片狀態表共用 |
| `src/settings.ts` | 環境的設定：這個環境用哪一份名冊、它的平台表、有沒有更換政策 |
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
| `test/crls.ts` | 測試的發證金鑰、用它們簽的清冊 |
| `test/crl-testdata.test.ts` | 清冊鏡像和 Go 的 `crl/` 逐案比對（第三項要有 `go`） |
| `test/mirror-invariant.test.ts` | 寫索引出錯時，鏡像交給 Durable Object 的樹根仍然都列在索引裡（在 Node 裡，用假的儲存桶和假的雜湊） |
| `test/mirror-faults.test.ts` | 清冊鏡像出錯和遇到大東西的時候：拿不到行的檔、拖時間的檔、太大的回應、超過一頁的儲存桶、之前留下的檔和補它們的界線、建樹到一半被停掉的一輪、兩輪同時寫索引 |
| `test/api.test.ts` | `challenges`、`card-state`、`config` 和 `/api/` 的外框，整個 Worker 在本機的 workerd 裡 |
| `test/records.test.ts`、`test/records.ts` | `records` 的每個錯誤代碼和先後順序、題目、清冊、午夜、`201` 的內容（Go 的 `server/api_test.go` 的案例），用只看第一個位元組的驗證器 |
| `test/records-real.test.ts` | `server/testdata/` 的十四份真的證明，從鏡像抓清冊、發題目走到寫入，用部署的那一個驗證器 |
| `test/records-storage.test.ts` | 同時送出時序號連續、每筆之間重啟、寫到一半失敗、`paused`、`spec/vectors/roster-rules.json` 配 Durable Object 的儲存 |
| `test/pages.test.ts`、`test/pages.ts`、`test/copy.ts` | 首頁和島民證明的每一種情況：`design/copy/` 的每一句和順序、標頭、轉址、`404`、跳脫、方法、測試名冊的標示；讀 `design/copy/` 的工具 |
| `test/proof-files.test.ts` | `/proof` 和它的檔案：標頭和 `web/README.md` 引用的一字不差、`/proof/` 的轉址、沒有建置時是 `404` |
| `test/views.test.ts` | 衍生表和紀錄同一個交易、從紀錄重建逐列相同、數卡片不受壞掉的卡片狀態影響 |
| `test/sequence.test.ts`、`test/sequence.ts` | 固定種子的長序列：產生器，Go 的 `roster/` 算的答案，配記憶體和配 Durable Object 的儲存逐筆比對（要有 `go`） |
| `test/environments.test.ts` | `wrangler.jsonc` 裡每個環境的名冊、物件名稱、儲存桶對得上；每個環境的 `limits.cpu_ms` 和鏡像假設的 CPU 時間相同 |
| `test/engine.test.ts` | Barretenberg 丟例外、答覆不對、跑不起來時的行為（在 Node 裡，用假的實例） |
| `test/compare.test.ts` | 和原生的 `bb verify` 逐案比對（要設 `IAMREAL_BB`） |
| `test/*.test.ts` | 測試 |
| `scripts/dev.ts` | `pnpm dev` |
| `scripts/deploy.ts` | 部署的兩段：打包唯一的入口 `bundleWorker`、`buildDeploy`、上傳的參數 `uploadArgs`；怎麼讀權杖、給 wrangler 的環境 |
| `scripts/deploy-build-checks.ts` | 部署那一包上傳之前的檢查 |
| `scripts/site-files.ts` | 寫出 `site/_headers`（從 `src/headers.ts`，照名冊的種類）和 `site/_redirects`；部署前的檢查和測試拿它核對版控裡的那兩個檔 |
| `scripts/build-deploy.ts` | GitHub Actions 的 `build` 工作跑的：打包、檢查 |
| `scripts/deploy-test.ts` | `pnpm run deploy:test` |
| `test/workflows.ts` | 工作流程的白名單和讀它們的程式 |

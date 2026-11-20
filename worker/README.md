# worker/：後台

**這個目錄讓人檢查的事：規則有照做。** 這裡是 Cloudflare 上的後台（ADR-0023），一個 Worker 專案。名冊規則、場合字串這些算法在 [`protocol/`](../protocol)，這裡只引用它，不引用這個程式庫的其他目錄。

## 現在有什麼

還沒做完：過卡前半段的三個介面有了，送出一筆和頁面還沒有。舊的後台 [`server/`](../server)（Go）還在，還是對照。

| 有 | 還沒有 |
|---|---|
| 每小時的排程：抓內政部的兩份廢止清冊，原始位元組存進 R2 的 `crl/<SHA-256>.crl` | 驗清冊的簽章、建樹、清冊存檔的索引 `crl/index.jsonl` |
| 名冊的 Durable Object：題目表、卡片狀態表、名冊的一列（[題目、卡片現況、設定](#題目卡片現況設定)） | 寫入紀錄：還沒有任何東西會寫卡片狀態表，所以每張卡片都是沒過過卡的樣子 |
| API 的三個介面：`POST /api/v1/challenges`、`POST /api/v1/card-state`、`GET /api/v1/config` | `POST /api/v1/records`、`GET /api/v1/fingerprint`；限流；存著的規則版本和程式不同時的 `paused` |
| 驗證證明和 Poseidon2 的雜湊（[驗證證明](#驗證證明)），在本機的 workerd 裡逐案和原生的 `bb verify` 比對過 | 呼叫它們的程式：送出一筆時驗證、清冊鏡像建樹。部署的那一包現在不含它們 |
| 測試專用的建置和測試的工具 | 任何頁面：`/api/` 以外的每個網址都回 `404` |
| 部署測試環境的指令。2026-11-19 用它第一次部署到 `test.iamreal.tw`（[第一次部署量到的](#第一次部署量到的)） | GitHub Actions 的工作流程 |

## 單獨執行

需要 Node 22 和 pnpm。不需要 Cloudflare 的帳號。在程式庫的根目錄 `pnpm install`，然後在這個目錄：

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
  | `settings` | 設定 `ROSTER_KIND` 不是 `test` 也不是 `production` |
  | `roster_kind` | 名冊的 Durable Object 存的是另一份名冊，和設定說的不同（見[物件記得自己是哪一份名冊](#物件記得自己是哪一份名冊)） |
  | `roster` | Durable Object 裡其他的錯，包括存著的卡片狀態壞了（見[讀卡片狀態時的檢查](#讀卡片狀態時的檢查)） |
  | `handler` | 其他地方 |

  例外的訊息不寫：訊息可能引用請求的內容。這一行沒有題目、匿名編號、帳號、對方的位址。
- 介面會讀的請求內容最多 64 KB（65,536 個位元組），超過就是 `malformed`，多的部分不讀。`challenges` 不讀內容，送什麼、多長都不看。巢狀超過 16 層的 JSON 也是 `malformed`。
- 讀 JSON 用自己寫的讀法（`src/json.ts`）：`JSON.parse` 遇到重複的鍵會留下後面那個而不報錯，這裡重複的鍵一律拒絕（ADR-0014）。多一個鍵、少一個鍵、鍵的大小寫不同、值不是字串、物件後面還有東西、不是 UTF-8、開頭有位元組順序記號，都是 `malformed`。

### 三個介面

| 介面 | 誰回答 | 做法 |
|---|---|---|
| `POST /api/v1/challenges` | Durable Object | 日期是發出那一刻的台灣日期，加 16 個隨機位元組；先存進題目表再回。請求的內容不讀 |
| `POST /api/v1/card-state` | Worker 檢查格式，Durable Object 讀卡片狀態表 | 場合字串不是這份名冊的、匿名編號不是它唯一的寫法，都是 `malformed`，不問 Durable Object。平台表的每個平台一項；存著的狀態沒有某個平台的名額時，那一項是沒用過的名額。回應沒有 `head` |
| `GET /api/v1/config` | Worker 自己 | `crl_max_age_days` 是 3；`platforms` 是這份名冊的平台表 |

**平台表**寫在 [`protocol/src/platforms.ts`](../protocol/src/platforms.ts)，照名冊分兩張，內容和 `spec/scope.md` 的表一字不差（`protocol/` 的測試拿規格的 Markdown 核對）。後台只從 [`src/settings.ts`](src/settings.ts) 的 `rosterSettingsOf` 一個地方取得它：`config` 送給裝置的、`card-state` 列的、檢查存著的卡片狀態用的是同一張。這個環境用哪一份名冊，是設定 `ROSTER_KIND`（見[設定檔](#設定檔)）；設定只說是哪一份，表的內容不在設定裡。**三個介面都先讀設定**：`ROSTER_KIND` 不是 `test` 也不是 `production` 時，三個都回 `500`。

### 物件記得自己是哪一份名冊

**這一段的行為是暫定的，等營運者確認。** `roster` 那一列有一欄 `kind`：Durable Object 第一次啟動時，把當時設定的 `ROSTER_KIND` 寫進去，之後不改。物件每次啟動時拿它和現在的設定比：

- 相同：照常。
- 不同（例如測試環境的設定被改成 `production`，物件卻是存著測試名冊的那一個）：`challenges` 和 `card-state` 回 `500`，寫一行 `where` 是 `roster_kind` 的紀錄。物件不發題目、不讀卡片狀態，alarm 響了也不刪任何東西。設定改回來、物件重新啟動之後照常，存著的東西都還在。
- **`config` 看不出這種不一致**：它由 Worker 自己回答、不問 Durable Object，所以照設定回那一份名冊的平台表。

要讓一個環境改用另一份名冊，是換一個 Durable Object 的名稱（`ROSTER_OBJECT_NAME`），不是只改 `ROSTER_KIND`。

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
| `cards` | 一張有過有效紀錄的卡片 | `scope_string`、`scoped_id`、`last_card_proof`、`proofs_on_last_date`、`slots`、`last_seq`（這張卡片最後一筆有效紀錄的序號） |
| `roster` | 整份名冊，只有一列 | `kind`（這個物件是哪一份名冊，`test` 或 `production`）、`count`（筆數）、`fingerprint`（名冊指紋）、`latest_valid_date`（名冊上最晚的有效日期）、`rules_version`（卡片狀態是照哪一版規則算的） |

- `cards` 的欄位就是 `spec/roster-rules.md`「State」的項目，加上 `last_seq`。`slots` 是一個 JSON 物件，鍵是平台代號，每個值恰好是 `current`、`last_declared`、`switch_count`、`correction_date`，名稱和寫法跟 `card-state` 回應的 `platforms` 相同。只存事實（更換過幾次），不存結論（還能不能換）。沒有有效紀錄的卡片沒有列。
- 這張表只放名冊規則的狀態，和之後頁面用的衍生表分開：衍生表可以整份重建，規則的狀態錯了會收下拿不掉的紀錄。
- `submissions`、`accepted`、`last_seq`、`fingerprint`、`latest_valid_date` 現在沒有程式會改：那是送出一筆（[#67](https://github.com/iamreal-tw/iamreal/issues/67)）的事。`rules_version` 在物件第一次啟動時記下當時程式的版本號；拿它和程式的版本比、不同就不收過卡，也是 #67 的事。

### 過期的題目怎麼刪

題目發出後不到 10 分鐘可以用；剛好 10 分鐘就是過期。Durable Object 用自己的 alarm 刪。

一個 Durable Object 同一時間只能排一個 alarm，再呼叫 `setAlarm` 會蓋掉原來的（[Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)：「Each Durable Object is able to schedule a single alarm at a time by calling `setAlarm()`」「If you call `setAlarm` when there is already one scheduled, it will override the existing alarm」，2026-11-20 讀的）。所以定時的工作不各自設 alarm，而是照同一個形狀寫（`src/roster.ts` 的 `TimedWork`）：

- 每一件工作回答兩件事：自己下一次什麼時候到期（沒事可做就說沒有）、到期時做什麼。它不知道別的工作。
- 物件的 alarm 永遠設在所有工作裡最早到期的那一個；都沒事可做就沒有 alarm。任何一件工作的到期時間可能變了（例如發了一個題目），就重設一次。
- alarm 響的時候，到期的工作各做一次，沒到期的不做，然後重設。

現在只有一件：刪過期的題目，到期時間是最舊那個題目發出後 10 分鐘。之後每天換日的工作（[#70](https://github.com/iamreal-tw/iamreal/issues/70)）是在 `timedWork()` 多列一件；它占著 alarm 不會讓題目晚刪。測試用測試專用的建置多塞一件假的工作來確認這一點（`test/api.test.ts`）。所以題目表裡只有最近 10 分鐘左右發的題目。

## 三樣不是設定值的東西

後台認哪些發證金鑰、去哪裡抓內政部的清冊、現在幾點，都寫在程式裡，不是設定值（ADR-0028）：設定寫錯，不會讓後台收下假卡片簽的東西。

- [`src/target.ts`](src/target.ts) 是部署用的那一份：內政部的兩把發證金鑰（[`src/issuers.ts`](src/issuers.ts)，測試拿 `spec/vectors/issuers.json` 核對）、內政部的兩個清冊網址（和 [`crl/README.md`](../crl/README.md) 寫的相同）、真的時鐘。其他程式用 `#target` 這個名字引用它（`package.json` 的 `imports`）。
- [`test-build/`](test-build) 是測試專用的建置換上的那一份：`target.ts` 是測試當場產生的發證金鑰（私鑰不留下）、假的內政部的網址、可以調的時鐘；`index.ts` 是進入點，在 Worker 前面多一個調時鐘的開關 `PUT /__test/clock`，和兩個讓測試呼叫得到驗證證明、Poseidon2 的入口 `POST /__test/verify`、`POST /__test/poseidon2`（這兩樣還沒有自己的 API）。入口呼叫的就是 `src/in-worker.ts` 的 `proofVerifier` 和 `poseidon2Hash`，沒有換掉任何一部分。**這兩個入口是暫時的**：送出一筆的介面（[#67](https://github.com/iamreal-tw/iamreal/issues/67)）接上驗證之後，測試改走真的介面，`/__test/verify` 拿掉；`/__test/poseidon2` 在清冊鏡像用 Poseidon2 建樹（[#65](https://github.com/iamreal-tw/iamreal/issues/65)）、測試看得到樹根之後拿掉。
  - `index.ts` 另外有通到名冊那個 Durable Object 的入口，`/__test/roster/…`。測試專用建置的 Durable Object 是部署的那一個類別（`src/roster.ts`）加上六個只給測試用的方法：現在就跑一次 alarm、讀 alarm 設在什麼時候、用 `src/card-table.ts` 的 `writeCard` 寫一張卡片的狀態、把題目表和卡片狀態表丟掉（看後台自己出錯時回什麼）、多塞一件假的定時工作、讀那件工作什麼時候跑過。**寫卡片狀態的入口是暫時的**：#67 之後卡片的狀態由送出一筆寫入，測試改走真的介面。部署的那一包沒有這六個方法，也沒有 `writeCard`（還沒有程式呼叫它）。
  - `PUT /__test/settings` 換掉環境的設定（`ROSTER_KIND`、`ROSTER_OBJECT_NAME`）：換上的值只放在測試專用建置的記憶體裡，蓋在 Worker 和 Durable Object 拿到的環境上。`wrangler.jsonc` 沒有動，部署的建置讀的是設定檔裡的值。正式名冊的案例、設定寫錯的案例用它測。
- 怎麼換：[`test/build.ts`](test/build.ts) 跑 `wrangler deploy --dry-run`，用 `--alias` 把 `#target` 指到 `test-build/target.ts`，進入點換成 `test-build/index.ts`，金鑰和網址用 `--define` 帶進去。wrangler 的設定檔和部署的指令裡沒有這些參數，所以部署的建置拿到的一定是 `src/target.ts`。
- [`test/bundle.test.ts`](test/bundle.test.ts) 用部署的指令自己的參數和環境（[`scripts/deploy.ts`](scripts/deploy.ts)，加 `--dry-run`）把要上傳的那一包打出來，檢查：
  - 裡面的網址只有內政部的兩個
  - 裡面長到可能是 RSA 金鑰的字串，恰好是 `spec/vectors/issuers.json` 的兩個模數。找得到的寫法是十六進位、十進位、base64、PEM；拆成數字陣列或執行時才拼起來的金鑰，這個檢查看不到
  - 沒有假的內政部、時鐘的開關和測試專用建置的其他痕跡
  - wrangler 列出的 binding 只有 `ROSTER`、`DATA`、`ROSTER_OBJECT_NAME`、`ROSTER_KIND`，所以金鑰、網址、時鐘沒有設定值可以讀。用 `wrangler secret` 另外設在 Worker 上的密鑰不在設定檔裡，這個檢查看不到
  - 把測試專用的建置也打出來，確認同樣的找法在那一包找得到測試的金鑰、假的內政部和時鐘的開關

**驗證證明的程式兩種建置相同。** 測試專用的建置換掉的只有 `#target` 和進入點；驗證證明和 Poseidon2 的六個檔（`src/in-worker.ts` 和它引用的 `src/verify.ts`、`src/poseidon2.ts`、`src/engine.ts`、`src/barretenberg.ts`、`src/circuits.ts`）不引用 `#target`，也不引用 `src/` 裡這六個以外的檔（[`test/layout.test.ts`](test/layout.test.ts) 檢查）。測試專用的那一包裡不是 JavaScript 的模組恰好是 WASM 檔和兩把驗證金鑰，SHA-256 是核對過的那三個（`test/bundle.test.ts`）。部署的那一包現在不含驗證的程式，所以「兩包裡的檔相同」這一項現在只檢查得到測試專用的那一包；`test/bundle.test.ts` 裡對部署那一包的檢查因此包在一個 `if` 裡，現在是空過的。**#67 把驗證接進部署的那一包時要拿掉那個 `if`**，之後部署的那一包的檔必須也是這三個。那時這個測試的其他檢查（找網址、找金鑰長度的字串）會把 WASM 檔當文字一起掃，可能要把不是 JavaScript 的模組分開處理。

`target.ts` 還有第四樣：等內政部一份清冊最久等多久。部署的是 5 分鐘，測試專用的建置換成一兩秒，測逾時才不用等幾分鐘。

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
- **跑不起來不是拒絕，也不是通過。** 驗證器自己跑不起來（WASM 實例化失敗、載入通用參數失敗）時 `verify` 丟例外（`EngineError`，`notStarted` 是 `true`），不回任何結果；那和證明無關，沒有任何輸入會造成它。呼叫的人不可以把它當成通過：#67 要把它處理成「這一筆不接受、不寫入」，是後台自己的錯誤，不是 `proof` 這個拒絕代碼。下一次呼叫會重新試著實例化。[`test/engine.test.ts`](test/engine.test.ts) 確認這條路不會回 `true`，也不會回 `false`。
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

[`src/in-worker.ts`](src/in-worker.ts) 的 `poseidon2Hash(inputs: readonly Uint8Array[]): Uint8Array`（型別 `Poseidon2Hash` 在 [`src/poseidon2.ts`](src/poseidon2.ts)）：輸入和輸出都是 32 個位元組、大端序的體元素，同步，用驗證證明的同一個 WASM 實例。清冊鏡像建樹用它，Worker 裡沒有另一份 Poseidon2。不是 32 個位元組或不小於 `p` 的輸入丟 `RangeError`，不問 WASM。Barretenberg 跑不起來、丟例外、或回的不是雜湊時丟 `EngineError`，並丟掉那個實例（跑不起來時沒有實例可丟）；下一次呼叫用新的實例。[`test/poseidon2.test.ts`](test/poseidon2.test.ts) 拿 `spec/vectors/poseidon2.json`（Go 的 `crl/poseidon2` 讀的同一份）的 `hash_2`、`hash_3`、`scoped_id` 每一案核對。

### 和原生的 `bb verify` 逐案比對

```sh
IAMREAL_BB=/path/to/bb pnpm test                                                          # 全部的測試，包含比對
IAMREAL_BB=/path/to/bb node --experimental-strip-types --test test/compare.test.ts        # 只跑比對
```

`IAMREAL_BB` 指到 `bb` 6.0.0（和 Go 的測試同一個變數），另外要有 `go`；沒設就跳過。約 80 秒。[`test/compare.test.ts`](test/compare.test.ts) 做的事：

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
- 打包後的大小（測試專用的建置，`wrangler deploy --dry-run` 印的）：17,949 KiB，gzip 後 4,019 KiB，幾乎都是 WASM。部署的那一包現在是 23 KiB（gzip 後 8.4 KiB，有了題目、卡片現況、設定三個介面之後）：還沒有程式呼叫驗證，打包時整個被略過；送出一筆的介面做好之後會和測試專用的那一包差不多大。

## 設定檔

[`wrangler.jsonc`](wrangler.jsonc)。最上層是每個環境都一樣的：進入點、相容日期、Durable Object 的 migration、不送使用統計給 Cloudflare。沒有 `build.command`，部署時不會執行任何自訂的指令。

每個環境一段，寫在 `env` 底下。現在只有測試環境 `env.test`（ADR-0028）：

| 欄位 | 值 | 說明 |
|---|---|---|
| `name` | `iamreal-test` | Worker 的名稱。部署的權杖只能部署這一個 |
| `workers_dev`、`preview_urls` | `false` | 不開 `workers.dev` 的網址，只走自訂網域 `test.iamreal.tw`。自訂網域在儀表板上設，不在這裡（ADR-0029） |
| `triggers.crons` | `0 * * * *` | 每小時整點跑一次排程 |
| `durable_objects` | `ROSTER` → 類別 `Roster` | 一份名冊一個 Durable Object |
| `r2_buckets` | `DATA` → `iamreal-test-data` | 公開的檔案，經 `test-data.iamreal.tw` 下載（ADR-0027） |
| `vars.ROSTER_OBJECT_NAME` | `test-1` | 名冊那個 Durable Object 的名稱。清空測試名冊就是換一個名稱 |
| `vars.ROSTER_KIND` | `test` | 這個環境用哪一份名冊，`test` 或 `production`。它決定接受哪個場合字串、平台表是哪一張（ADR-0028）；兩者的內容寫在 `protocol/`，不在設定裡。不是這兩個值時三個介面都回 `500`；和 Durable Object 第一次啟動時記下的那一份不同時，用到 Durable Object 的介面回 `500`（[物件記得自己是哪一份名冊](#物件記得自己是哪一份名冊)） |

之後加正式環境，是在 `env` 底下多一段，程式不用改。最上層沒有 `name`，也沒有 binding：指令沒帶 `--env` 時，wrangler 拿套件名稱 `iamreal-worker` 當 Worker 的名稱，不會是 `iamreal-test`。

## 排程做什麼

每小時一次（[`src/mirror.ts`](src/mirror.ts)）：

1. 同時抓 G2、G3 的清冊，兩份互不等待。每一份從送出請求到收完最多等 5 分鐘：G2 的清冊約 17 MB，每秒 0.5 Mbit 也收得完；排程一次最多能跑 15 分鐘（[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)）。
2. 收到完整的 `200` 時，算內容的 SHA-256。R2 裡已經有 `crl/<SHA-256>.crl` 就不重存；沒有才寫入，`Cache-Control` 是 `public, max-age=31536000, immutable`（檔名就是內容的雜湊，內容不會變）。
3. 下面的情況算失敗，那一份不存任何檔，另一份照常：
   - 狀態不是 `200`、連不上、超過 5 分鐘
   - 執行環境回報連線中斷
   - 收到的長度和回應的 `Content-Length` 不同
   - 內容是 0 個位元組
4. 只要有一份失敗，這一次排程就以例外結束，在 Cloudflare 的紀錄上是失敗的一次。

**存進去的不一定是清冊。** 完整的 `200` 不論內容都存，例如內政部的伺服器回一頁 HTML 的錯誤訊息也會存：規格是可用不可用都存，哪些可用，由之後寫索引的程式驗章決定。

**有一種截斷現在擋不住。** 回應沒有 `Content-Length`（chunked）、連線在最後一塊之前斷掉時，本機的 workerd（1.20261110.1）不回報錯誤，收到的那一段看起來就是完整的回應，會被存起來。這在 HTTP 這一層分不出來，要到驗清冊簽章的那一步才擋得住。回應有 `Content-Length`、連線提早斷掉時，本機的 workerd 既不報錯也不結束，所以是等到逾時才算失敗。這兩件事在 Cloudflare 上是不是一樣，還沒有在部署的環境看過。

寫進資料儲存桶的每個物件都要設 `Cache-Control`：資料網域的快取規則是「有就照它，沒有就不快取」。

每一份清冊寫一行紀錄，只在即時的輸出看得到（`wrangler tail` 或儀表板的即時紀錄），沒有開保存：

```
{"event":"crl_mirror","at":"2026-11-20T08:00:00.123Z","issuer":"G3","result":"stored","sha256":"…"}
```

`result` 是 `stored`（新的一份）、`already_stored`（已經有）、`failed`（附 `error`）。

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
| 算 Poseidon2 | `worker.poseidon2([十六進位的體元素, …])`，回十六進位的雜湊 |
| 重啟名冊的 Durable Object | `worker.roster.restart()`：記憶體裡的東西丟掉，存著的留著 |
| 跑 Durable Object 的 alarm、看它設在多久之後 | `worker.roster.runAlarm()`、`worker.roster.alarmInMs()` |
| 寫一張卡片的狀態 | `worker.roster.writeCard({…})`，寫法和 `card-state` 的回應相同。暫時的，到 #67 為止 |
| Durable Object 還留著哪些題目 | `worker.roster.storedChallenges()`，直接讀它的儲存。暫時的：現在沒有介面看得出一個題目還認不認得，#67 的 `challenge_unknown` 做好之後改問介面 |
| 讓後台自己出錯 | `worker.roster.breakTables()` |
| 多塞一件定時的工作、看它什麼時候跑過 | `worker.roster.setExtraWork(到期的時間, 間隔)`、`worker.roster.extraWorkRuns()` |
| 換掉環境的設定 | `startWorker({ settings: { ROSTER_KIND: "production", ROSTER_OBJECT_NAME: "…" } })`，或啟動後 `worker.setSettings({…})`；已經在跑的 Durable Object 要 `worker.roster.restart()` 才讀到新的 |

測試不對內政部送請求。測試用 Node 內建的 test runner，和 `protocol/`、`web/` 相同。

## 型別檢查

Workers 執行環境的型別（`R2Bucket`、`DurableObject`……）和 `Env` 由 `wrangler types` 從設定檔和本機的 workerd 產生，寫到 `worker-configuration.d.ts`；這個檔不進版控，`pnpm typecheck` 每次重新產生。沒有另外裝型別的套件。

型別檢查分兩份設定，因為兩邊的全域型別不同：

- `tsconfig.json`：在 Worker 裡執行的程式（`src/`、`test-build/`），用上面產生的型別，沒有 Node 也沒有 DOM 的型別
- `test/tsconfig.json`：在 Node 裡執行的測試和指令（`test/`、`scripts/`）

## 部署測試環境

```sh
pnpm run deploy:test
```

[`scripts/deploy-test.ts`](scripts/deploy-test.ts) 讀程式庫根目錄的 `.env.local` 裡的兩行，`CLOUDFLARE_API_TOKEN_TEST` 和 `CLOUDFLARE_ACCOUNT_ID`，交給 `wrangler deploy --env test --experimental-provision=false`。那把權杖只能部署 `iamreal-test`（ADR-0029）。不用 `wrangler login`。shell 裡原有的 `CLOUDFLARE_*`、`CF_*`、`WRANGLER_*` 變數都不會傳給 wrangler，所以別的權杖或別的 API 網址不會被用到。

- 環境固定是測試環境。唯一接受的參數是 `--dry-run`：只打包，不上傳。
- 呼叫 wrangler 之前先核對 WASM 檔和驗證金鑰的 SHA-256（[WASM 檔和驗證金鑰從哪裡來](#wasm-檔和驗證金鑰從哪裡來)），不對就不部署。
- `--experimental-provision=false` 讓 wrangler 不問 Cloudflare 儲存桶在不在；為什麼要帶，見[下一節](#第一次部署量到的)。
- 正式環境只從 GitHub Actions 部署，這裡沒有它的指令。

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

部署出去的程式現在還沒有任何外部套件：驗證證明的程式要到有程式呼叫它才會被打包進去，那時多的是 `msgpackr` 和 WASM 檔。

沒有任何套件的安裝腳本會執行。有安裝腳本的三個套件列在根目錄 `pnpm-workspace.yaml` 的 `ignoredBuiltDependencies`：`workerd` 和 `esbuild` 的執行檔是各自平台的套件直接帶的，安裝腳本沒跑也能用；`msgpackr-extract` 是 `web/` 那邊的。

wrangler 執行時對外送的東西：使用統計關掉了（設定檔的 `send_metrics`，指令再加 `WRANGLER_SEND_METRICS=false`）。它印開頭那一行時會問 npm 有沒有新版，測試和部署的指令用 `WRANGLER_HIDE_BANNER=true` 關掉那一行；設定檔有警告或 wrangler 自己出錯時，它還是會問。

## 檔案

| 檔案 | 內容 |
|---|---|
| `wrangler.jsonc` | Worker 專案的設定 |
| `src/index.ts` | 進入點：HTTP（`/api/` 交給 `src/api.ts`，其他回 `404`）和排程 |
| `src/api.ts` | `/api/` 底下的介面：路徑和方法、每個回應的標頭、三個介面、後台自己出錯時的那一行 |
| `src/json.ts` | 讀請求的 JSON，鍵重複就拒絕 |
| `src/mirror.ts` | 清冊鏡像 |
| `src/roster.ts` | 名冊的 Durable Object：建表、發題目、讀卡片現況、刪過期的題目 |
| `src/card-table.ts` | 卡片狀態表：建表的程式，讀（連同檢查）和寫一張卡片的狀態 |
| `src/slot-json.ts` | 一個名額寫成 JSON 的那一種寫法：`card-state` 的回應和卡片狀態表共用 |
| `src/settings.ts` | 環境的設定：這個環境用哪一份名冊、它的平台表 |
| `src/target.ts`、`src/issuers.ts` | 部署用的發證金鑰、清冊網址、時鐘、等清冊的上限 |
| `src/in-worker.ts` | 在 Worker 裡用的 `proofVerifier` 和 `poseidon2Hash`：把下面幾個檔和 WASM 檔、驗證金鑰接起來，只有它引用 `generated/` |
| `src/verify.ts` | 驗證證明的介面 `ProofVerifier`、呼叫 Barretenberg 之前的檢查 |
| `src/poseidon2.ts` | Poseidon2 的雜湊 |
| `src/circuits.ts` | 接受的電路：名稱、公開輸入的個數、驗證金鑰的 SHA-256。`worker/` 裡電路的清單只有這一份 |
| `src/engine.ts`、`src/barretenberg.ts` | Barretenberg 的實例（丟例外或答覆不對就換）、WASM 的載入程式 |
| `scripts/engine-files.ts` | 建置的第一步：核對 WASM 檔和驗證金鑰的 SHA-256，寫進 `generated/` |
| `test-build/` | 測試專用的建置換上的那一份 |
| `test/harness.ts`、`test/build.ts`、`test/proofs.ts` | 測試的工具、兩種建置、`verifier/testdata/` 的測試證明和驗證的測試共用的小工具 |
| `test/engine.test.ts` | Barretenberg 丟例外、答覆不對、跑不起來時的行為（在 Node 裡，用假的實例） |
| `test/compare.test.ts` | 和原生的 `bb verify` 逐案比對（要設 `IAMREAL_BB`） |
| `test/*.test.ts` | 測試 |
| `scripts/dev.ts` | `pnpm dev` |
| `scripts/deploy-test.ts`、`scripts/deploy.ts` | `pnpm run deploy:test`；它給 wrangler 的參數、怎麼讀權杖、給 wrangler 的環境 |

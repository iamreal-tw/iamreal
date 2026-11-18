# roster

名冊規則（`spec/roster-rules.md`）的參考實作：讀一份名冊檔案，檢查整份檔案，逐筆套用規則，算出每張卡片和每個帳號的現況。一筆紀錄是一張卡片的整份帳號清單（每個平台最多一個帳號）；規則對平台表上的每個平台都看一次，清單裡沒有的平台就是收回。

**這個目錄讓人檢查的事：拿快照重算，得到相同的現況。** 只引用 `verifier/`，不需要後台。

## 內容

| 檔案 | 內容 |
|---|---|
| `file.go` | `ReadFile`：整份檔案的檢查。逐行、照表格的順序（`line`、`seq`、`prev`），回報第一個失敗的行號和代碼；有效的檔案回傳紀錄和鏈尾雜湊。一行的檢查是 `ReadLine`，後台寫入每一筆之前也用它 |
| `rules.go` | `Rules`：一次套用一筆。`NewRules(roster, …)` 帶名冊的種類，因為事件規則要看平台表上的每個平台。每筆紀錄依序跑六項檢查（`proof`、`challenge_reused`、`root`、`date_order`、`empty`／`switch_limit`、`daily_limit`）。第 5 項對平台表上的每個平台（照代號排）拿清單裡那個平台的帳號和名額在這筆之前的狀態比，全部算在副本上：任何一個平台被擋下，整筆 `switch_limit`；每個平台都沒有結果，整筆 `empty`；否則有效，結果是每個平台的（平台、種類、帳號），種類照事件表第一個符合的列：`first`、`refresh`、`correction`（名額最後一次 `first` 或 `switch` 的日期就是這筆的日期時，換帳號不計次）、`switch`（每個平台終身 `MaxSwitches` = 5 次，沒有時間窗口）、擋下，清單裡沒有的平台是 `withdraw`。有效才一次寫回所有平台。`Check` 只回答「這一筆接在後面會怎樣」、不改狀態；`CheckWithCard` 是同一個答案，有效時再加上這張卡片套用後的狀態（和套用後 `Card` 回傳的相同），也不改狀態，後台寫衍生表用；`Apply` 套用；`Card` 回傳一張卡片的狀態（`last_card_proof`、那一天的有效紀錄筆數，和平台表上每個平台一個名額：現在的帳號、上次宣告的帳號、`switch_count`、`correction_date`）；`AccountCards(場合, 平台, 帳號名稱)` 回傳目前在那個平台宣告這個帳號的卡片數（後台送出成功的回應裡的 `account_cards`），從套用時維護的索引回答，不掃過所有卡片；`State` 輸出每張卡片（現在的清單）和每個帳號（平台、帳號名稱）的現況，排序一律照位元組。整份名冊的 `Apply` 就是對每一筆呼叫 `Rules.Apply`，`Check` 把檔案的檢查和規則接起來 |

**規則只有一份。** 後台（`server/`）不自己寫任何一條規則：開機時用 `Rules.Apply` 從頭重算，收到一筆時先用 `Rules.Check` 問會不會有效，寫進資料庫後再 `Rules.Apply`。重驗的人用 `Check`（整份檔案），走的是同一份程式。

## 兩個介面

規則本身不驗證明，也不讀廢止清冊，這兩件事各是一個介面：

- **`ProofVerifier`**（檢查 1）：`*verifier.Verifier` 就是一個。回傳 `*verifier.Rejection` 是不通過（代碼 `proof`）；其他錯誤代表沒辦法檢查，規則停下來，不替紀錄打代碼。
- **`CRLArchive`**（檢查 3）：`CRLDates(issuer, smtRoot)` 回傳這把發證金鑰簽的、樹根是 `smtRoot` 的每一份可用清冊的日期（`thisUpdate` 換成台灣的日期）。紀錄的日期 `d` 落在任一份的「清冊日期 − 1 天」到「清冊日期 + 3 天」之間，樹根就被承認。正式的實作是 `crl.Archive`（從存檔索引回答，見 `crl/README.md`「讀存檔」）；`roster/` 不能引用 `crl/`，兩者在 `cmd/iamreal-verify` 接起來。這裡的測試用假的實作。

## 怎麼單獨執行

```
go build ./roster
go test ./roster
```

**標準答案**（`vectors_test.go`）：

- `spec/vectors/record.json` 的 `files`：每份檔案照它的 `roster`（正式或測試名冊的表）是有效（鏈尾相同）或在哪一行、用哪個代碼失敗。
- `spec/vectors/roster-rules.json`：每個案例照它的 `roster` 用那份名冊的平台表；事件換成紀錄（先確認是那份名冊裡格式正確的紀錄），`verifies` 由假的 `ProofVerifier` 回答，`crl_dates` 由假的 `CRLArchive` 回答（每筆事件有自己的樹根）。比對每筆的結果（有效的比每個平台的種類）和最後的現況。現況裡每張卡片的 `proofs_on_last_date` 和 `slots` 是卡片的狀態，不在規則的輸出裡（`State` 沒有它們），這個測試不比，由 `incremental_test.go` 用 `Card` 比。

`incremental_test.go`：同一份 `roster-rules.json`，一筆一筆用 `Rules` 套用，每一筆先 `Check` 兩次（答案相同、狀態沒變）、`CheckWithCard`（答案和 `Check` 相同；有效時的卡片狀態和 `Apply` 之後的 `Card` 相同，無效時是空的）再 `Apply`（和 `Check` 的答案相同），結果、最後的現況（含 `proofs_on_last_date` 和每個名額的 `current`、`last_declared`、`switch_count`、`correction_date`）都和標準答案、整份的 `Apply` 相同；`AccountCards` 和輸出的每個帳號的卡片數一致，同一個帳號名稱在別的平台沒有卡片時是 0；`Card` 和輸出的每張卡片一致。`TestCard` 另測：沒有紀錄的卡片每個名額都沒用過；收回後保留上次宣告的帳號、更換次數和 `correction_date`；收回的種類帶著被收回的帳號；回傳的是副本。

`rules_test.go` 另外測：同一個樹根對應好幾份清冊時任一份符合就承認；驗證器或清冊存檔出錯時規則停下來。

用真的證明跑一份測試名冊的測試在 `verifier/proof_test.go`（`TestRealProofRoster`）。

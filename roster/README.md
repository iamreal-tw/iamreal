# roster

名冊規則（`spec/roster-rules.md`）的參考實作：讀一份名冊檔案，檢查整份檔案，逐筆套用規則，算出每張卡片和每個帳號的現況。

**這個目錄讓人檢查的事：拿快照重算，得到相同的現況。** 只引用 `verifier/`，不需要後台。

## 內容

| 檔案 | 內容 |
|---|---|
| `file.go` | `ReadFile`：整份檔案的檢查。逐行、照表格的順序（`line`、`seq`、`prev`），回報第一個失敗的行號和代碼；有效的檔案回傳紀錄和鏈尾雜湊。一行的檢查是 `ReadLine`，後台寫入每一筆之前也用它 |
| `rules.go` | `Rules`：一次套用一筆。每筆紀錄依序跑六項檢查（`proof`、`challenge_reused`、`root`、`date_order`、`not_current`／`switch_limit`、`daily_limit`），有效的給種類（`first`、`refresh`、`switch`、`withdraw`）。`Check` 只回答「這一筆接在後面會怎樣」、不改狀態；`Apply` 套用；`Card` 回傳一張卡片在一個場合的現況（含上次宣告的帳號、更換的日期、`last_card_proof` 那一天的有效紀錄筆數）；`AccountCards` 回傳一個場合裡目前宣告某個帳號的卡片數（後台送出成功的回應裡的 `account_cards`）；`State` 輸出每張卡片和每個帳號的現況，排序一律照位元組。整份名冊的 `Apply` 就是對每一筆呼叫 `Rules.Apply`，`Check` 把檔案的檢查和規則接起來 |

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

- `spec/vectors/record.json` 的 `files`：每份檔案是有效（鏈尾相同）或在哪一行、用哪個代碼失敗。
- `spec/vectors/roster-rules.json`：每個案例的事件換成紀錄，`verifies` 由假的 `ProofVerifier` 回答，`crl_dates` 由假的 `CRLArchive` 回答（每筆事件有自己的樹根）。比對每筆的結果和最後的現況。現況裡每張卡片的 `proofs_on_last_date` 不在規則的輸出裡（`State` 沒有它），這個測試不比，由 `incremental_test.go` 用 `Card` 比。

`incremental_test.go`：同一份 `roster-rules.json`，一筆一筆用 `Rules` 套用，每一筆先 `Check` 兩次（答案相同、狀態沒變）再 `Apply`（和 `Check` 的答案相同），結果、最後的現況都和標準答案、整份的 `Apply` 相同；`AccountCards` 和輸出的每個帳號的卡片數一致；`Card` 和輸出的每張卡片一致，`Card` 的 `ProofsOnLastDate` 和標準答案的 `proofs_on_last_date` 相同；另測收回後保留上次宣告的帳號和更換日期。

`rules_test.go` 另外測：同一個樹根對應好幾份清冊時任一份符合就承認；驗證器或清冊存檔出錯時規則停下來。

用真的證明跑一份測試名冊的測試在 `verifier/proof_test.go`（`TestRealProofRoster`）。

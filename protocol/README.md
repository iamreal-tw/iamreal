# protocol/：`spec/` 的 TypeScript 實作

**這個目錄讓人檢查的事：後台和裝置用的是同一份規則。** 名冊規則、場合字串、宣告碼、匿名編號、題目，照 `spec/` 寫成 TypeScript，過卡的頁面（`web/`）和之後的後台（`worker/`）都引用這一份，不各自再寫一次。Go 的另一份實作（`verifier/`、`roster/`）和這裡讀同一份標準答案（`spec/vectors/`），兩份的差異會在測試時出現。

- 沒有執行期的套件。開發用的只有 TypeScript 和 `@types/node`，版本和 `web/` 的相同
- 不引用 `web/`、`worker/`，也不引用這個程式庫的其他 TypeScript
- 不做 I/O：雜湊用 WebCrypto（瀏覽器、Node、Workers 都有）；匿名編號要的 Poseidon2 由呼叫的人傳進來（`scoped-id.ts` 的 `Hash2`），這裡不帶證明引擎

## 內容

| 檔案 | 規格 | 內容 |
|---|---|---|
| `roster-rules.ts` | `spec/roster-rules.md` | 名冊規則，一個不保管任何東西的函式 `applyRecord`：給它一筆紀錄、這張卡片之前的狀態、名冊上最晚的有效日期、這個題目有沒有用過、這筆紀錄的樹根對到的清冊日期，它回結果（有效或無效、代碼、每個平台的種類）和這張卡片之後的狀態。它不知道狀態存在哪裡。裝置在簽章之前只算檢查 5、6（`applyList`，`applyRecord` 的後半段）。另有規則的版本號（`RULES_VERSION`）、當天是否已經 3 筆（`dailyLimitReached`）、規則產生不出來的狀態（`possibleSlot`、`possibleCard`）、更換的次數上限 |
| `roster-memory.ts` | `spec/roster-rules.md` | `MemoryRoster`：把狀態放在記憶體裡、照順序一筆一筆呼叫 `applyRecord`，就是從第 1 筆重算整份名冊的寫法。它只保管每張卡片的狀態、名冊上最晚的有效日期、用過的題目；判斷全部在 `applyRecord` |
| `scope.ts` | `spec/scope.md` | 每份名冊的場合字串（公開名冊、測試名冊），寫死在這裡，不從後台或網址來（ADR-0016） |
| `username-format.ts` | `spec/scope.md`「Platforms」 | 帳號名稱的格式 `[…]{m,n}`，自己逐字解析，不交給正規表示式引擎；平台代號；裝置不認得的平台上帳號最低限度的檢查 |
| `declaration-code.ts` | `spec/declaration-code.md` | 整份帳號清單的原文和宣告碼 |
| `scoped-id.ts` | `spec/scoped-id.md` | 匿名編號、它的文字寫法和 10 個字元的短編號 |
| `challenge.ts` | `spec/challenge.md` | 題目的唯一寫法、它的日期、`current_time` |
| `date.ts` | | 日期換成天數、台灣的日期（UTC+8，不看裝置的時區） |
| `base32.ts` | | 題目和匿名編號用的 base32，只認一種寫法 |
| `field.ts` | `spec/scoped-id.md`、`spec/proof-verification.md` | BN254 的模數、公開輸入的 32 個位元組、31 個位元組打包成一個值 |
| `bytes.ts` | | 共用的位元組和整數小工具、SHA-256。不對應哪一份 `spec/`：上面幾個檔用到其中一部分，`wipe`、`equalBytes`、`concatBytes` 等只有 `web/` 用。從 `web/` 整個檔一起搬過來，是為了不留兩份 |

## 怎麼引用

這個目錄是根目錄 pnpm workspace 的一員（`pnpm-workspace.yaml`），套件名稱 `iamreal-protocol`。要用它的目錄在 `package.json` 的 `dependencies` 寫 `"iamreal-protocol": "workspace:*"`，照檔名引用：

```ts
import { scopeOf } from "iamreal-protocol/scope.ts";
```

引用的是原始的 `.ts` 檔，沒有建置的步驟。

## 怎麼單獨執行

需要 Node 22（22.6 以上）、pnpm 10。在根目錄裝一次套件：

```
pnpm install --frozen-lockfile
cd protocol
pnpm typecheck
pnpm test
```

`pnpm test` 讀 `spec/vectors/` 的標準答案，不複製。`test/spec.test.ts`：

- `challenge.json`：題目的唯一寫法、日期、`current_time` 和它的公開輸入、亂數的位元組
- `scope.json`：兩個場合字串和打包值；平台代號；帳號名稱照它的平台的格式（格式字串從 `spec/scope.md` 的平台表讀出來，交給 `username-format.ts` 自己解析，和標準答案逐案相同；格式字串不是那一種寫法時讀不懂）
- `declaration-code.json`：整份清單的原文、SHA-256、宣告碼、打包值
- `scoped-id.json`：匿名編號的文字寫法、短編號 10 個字元、讀不懂的寫法

`test/roster-rules.test.ts`：

- `roster-rules.json`：每個案例的事件照順序餵給 `MemoryRoster`，每一筆的結果（有效時每個平台的種類，無效時的代碼）和標準答案相同；無效的紀錄之後，那張卡片的狀態和名冊上最晚的有效日期都沒變；最後的現況（每張卡片的清單、`last_card_proof`、`proofs_on_last_date`、每個名額的四個項目，和每個帳號底下的卡片）和標準答案的 `state` 完全相同；規則產生得出來的每個狀態，裝置都讀得懂
- 規則的版本號：`RULES_VERSION` 等於 `spec/roster-rules.md` 寫的那一版，也等於 `roster-rules.json` 的 `rules_version`。Go 的 `roster/version_test.go` 拿 `roster.RulesVersion` 比同樣兩個地方
- `applyRecord` 本身：六個檢查的先後、檢查 3 和檢查 4 的邊界、無效的紀錄原樣交回收到的狀態、同樣的輸入算兩次結果相同而且輸入沒被改、狀態裡沒有的平台當成空的名額、平台表以外的平台是錯誤而不是代碼
- `applyList`：事件規則在一個名額上的每一種情況和之後的名額、被擋的平台、一天 3 筆

另外測台灣的日期（`test/spec.test.ts`）和規則產生不出來的狀態（`test/roster-rules.test.ts`）。

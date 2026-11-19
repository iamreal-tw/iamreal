# protocol/：`spec/` 的 TypeScript 實作

**這個目錄讓人檢查的事：後台和裝置用的是同一份規則。** 名冊規則、場合字串、宣告碼、匿名編號、題目，照 `spec/` 寫成 TypeScript，過卡的頁面（`web/`）和之後的後台（`worker/`）都引用這一份，不各自再寫一次。Go 的另一份實作（`verifier/`、`roster/`）和這裡讀同一份標準答案（`spec/vectors/`），兩份的差異會在測試時出現。

- 沒有執行期的套件。開發用的只有 TypeScript 和 `@types/node`，版本和 `web/` 的相同
- 不引用 `web/`、`worker/`，也不引用這個程式庫的其他 TypeScript
- 不做 I/O：雜湊用 WebCrypto（瀏覽器、Node、Workers 都有）；匿名編號要的 Poseidon2 由呼叫的人傳進來（`scoped-id.ts` 的 `Hash2`），這裡不帶證明引擎

## 內容

| 檔案 | 規格 | 內容 |
|---|---|---|
| `roster-rules.ts` | `spec/roster-rules.md` | 名冊規則的事先計算：每個名額的事件規則（`slotOutcome`、`applyKind`）、整份清單（`listOutcome`）、當天的筆數（`dailyLimitReached`）、規則產生不出來的狀態（`possibleSlot`、`possibleCard`）、更換的次數上限 |
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

`pnpm test`（`test/spec.test.ts`）讀 `spec/vectors/` 的標準答案，不複製：

- `challenge.json`：題目的唯一寫法、日期、`current_time` 和它的公開輸入、亂數的位元組
- `scope.json`：兩個場合字串和打包值；平台代號；帳號名稱照它的平台的格式（格式字串從 `spec/scope.md` 的平台表讀出來，交給 `username-format.ts` 自己解析，和標準答案逐案相同；格式字串不是那一種寫法時讀不懂）
- `declaration-code.json`：整份清單的原文、SHA-256、宣告碼、打包值
- `scoped-id.json`：匿名編號的文字寫法、短編號 10 個字元、讀不懂的寫法
- `roster-rules.json`：每個案例重播事件：每一筆清單算出的每個平台的種類和標準答案的 `kinds` 相同，`switch_limit`、`empty` 也相同；`daily_limit` 的紀錄，事件規則本身接受，日期是 `last_card_proof` 的時候算得出今天已經 3 筆；有效的紀錄從不擋；重播出的每張卡片的清單、`last_card_proof`、`proofs_on_last_date` 和每個名額的 `current`、`last_declared`、`switch_count`、`correction_date` 和標準答案相同；規則產生得出來的每個狀態都讀得懂

另外測台灣的日期、事件規則在一個名額上的每一種情況、一天 3 筆、規則產生不出來的狀態。

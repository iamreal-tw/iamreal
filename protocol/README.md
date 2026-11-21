# protocol/：`spec/` 的 TypeScript 實作

**這個目錄讓人檢查的事：後台和裝置用的是同一份規則。** 名冊規則、場合字串、宣告碼、匿名編號、題目，照 `spec/` 寫成 TypeScript，過卡的頁面（`web/`）和之後的後台（`worker/`）都引用這一份，不各自再寫一次。Go 的另一份實作（`verifier/`、`roster/`）和這裡讀同一份標準答案（`spec/vectors/`），兩份的差異會在測試時出現。

- 沒有執行期的套件。開發用的只有 TypeScript 和 `@types/node`，版本和 `web/` 的相同
- 不引用 `web/`、`worker/`，也不引用這個程式庫的其他 TypeScript
- 不做 I/O：雜湊用 WebCrypto（瀏覽器、Node、Workers 都有）；匿名編號要的 Poseidon2 由呼叫的人傳進來（`scoped-id.ts` 的 `Hash2`），這裡不帶證明引擎

## 內容

| 檔案 | 規格 | 內容 |
|---|---|---|
| `roster-rules.ts` | `spec/roster-rules.md` | 名冊規則，一個不保管任何東西的函式 `applyRecord`：給它一筆紀錄、這張卡片之前的狀態、名冊上最晚的有效日期、這個題目有沒有用過、這筆紀錄的樹根對到的清冊日期，它回結果（有效或無效、代碼、每個平台的種類）和這張卡片之後的狀態。它不知道狀態存在哪裡。裝置在簽章之前只算檢查 5、6（`applyList`，`applyRecord` 的後半段）。另有規則的版本號（`RULES_VERSION`）、當天是否已經 3 筆（`dailyLimitReached`）、規則產生不出來的狀態（`possibleSlot`、`possibleCard`）、更換的次數上限 |
| `platforms.ts` | `spec/scope.md`「Platforms」 | 每份名冊的平台表（`platformsOf`）：平台代號、顯示名稱、帳號名稱的格式，和 Go 的 `verifier/scope.go` 的 `Platforms` 相同。名冊規則收的平台表就是這種列（`PlatformRow`）；後台和從第 1 筆重算的人傳這裡的表，裝置傳後台 `config` 給它的表 |
| `rules-memory.ts` | `spec/roster-rules.md` | `MemoryRules`：把狀態放在記憶體裡、照順序一筆一筆呼叫 `applyRecord`，就是從第 1 筆重算整份名冊的寫法。它只保管每張卡片的狀態、名冊上最晚的有效日期、用過的題目；判斷全部在 `applyRecord` |
| `scope.ts` | `spec/scope.md` | 每份名冊的場合字串（公開名冊、測試名冊），寫死在這裡，不從後台或網址來（ADR-0016） |
| `username-format.ts` | `spec/scope.md`「Platforms」 | 帳號名稱的格式 `[…]{m,n}`，自己逐字解析，不交給正規表示式引擎；平台代號；裝置不認得的平台上帳號最低限度的檢查 |
| `declaration-code.ts` | `spec/declaration-code.md` | 整份帳號清單的原文和宣告碼 |
| `scoped-id.ts` | `spec/scoped-id.md` | 匿名編號、它的文字寫法和 10 個字元的短編號 |
| `challenge.ts` | `spec/challenge.md` | 題目的唯一寫法、它的日期、`current_time`；裝置收到題目時的檢查（`checkChallenge`） |
| `record.ts` | `spec/record.md` | 紀錄：每個欄位的格式（`fieldsProblem`、`accountsProblem`、`decodeProof`）、照樣板寫出名冊檔的那一行（`recordLine`）、紀錄雜湊（`recordHash`）、名冊指紋的下一步（`nextFingerprint`）、讀一行（`readRecordLine`：解析、檢查每個值、照樣板重寫一次比對位元組）；名冊目錄的切法（`LINES_PER_FILE`）、名冊檔和雜湊清單的檔名（`rosterFileName`、`hashListName`）、雜湊清單的寫法（`hashList`）；指紋檔的檔名和一行的寫法（`FINGERPRINT_FILE_NAME`、`fingerprintLine`）。後台寫入一筆、把寫滿的名冊檔搬到 R2、每天公布時用它 |
| `card-state-file.ts` | `spec/roster-rules.md`「The card state file」 | 卡片狀態檔：`cardStateFile` 收每張有過有效紀錄的卡片（狀態和它最後一筆有效紀錄的序號），照樣板寫出整個檔，卡片自己排序、初始狀態的名額不列；`readCardStateFile` 讀一個檔的位元組（`Uint8Array`，下載到什麼就給什麼，不先解碼：解碼會把位元組順序記號吃掉、把不是 UTF-8 的位元組換掉），每一列解析、檢查每個值、照樣板重寫一次比對，再檢查列的順序，回每一列，或第一個不對的行號和代碼（`line`、`order`）。`cardStateFile` 回的是字串，每個字都是 ASCII，檔案的位元組就是它的 UTF-8。只檢查每個值各自的格式，不判斷這一列是不是規則留得下來的狀態：這個檔是拿來讓人比出存錯的狀態的。`cardStateFileWriter` 是一次寫一列的寫法：卡片要照檔的順序給，每一列寫的時候檢查格式、而且卡片比上一列大，接起來和 `cardStateFile` 寫出的位元組相同。後台每天寫這個檔時用它，一邊讀卡片狀態表的複本一邊寫（`worker/README.md`「每天換日公布名冊」）；`cardStateFile` 留著當逐位元組的對照 |
| `min-app.ts` | `spec/min-app.md` | 最低版本：app 怎麼讀 `config` 的 `min_app`，這一版照常過卡、先提醒從哪天起不能過卡、還是停下來。網頁版不讀它；後台（`worker/`）的測試拿它讀自己送出的值 |
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

- `challenge.json`：題目的唯一寫法、日期、`current_time` 和它的公開輸入、亂數的位元組；`device` 的每一案（裝置的時鐘換成台灣的日期、收不收和原因代碼）
- `scope.json`：兩個場合字串和打包值；每份名冊的平台表（`platformsOf`）和標準答案、`spec/scope.md` 的表相同（代號、顯示名稱、格式）；平台代號；帳號名稱照它的平台的格式（格式字串從 `spec/scope.md` 的平台表讀出來，交給 `username-format.ts` 自己解析，和標準答案逐案相同；格式字串不是那一種寫法時讀不懂）
- `declaration-code.json`：整份清單的原文、SHA-256、宣告碼、打包值
- `scoped-id.json`：匿名編號的文字寫法、短編號 10 個字元、讀不懂的寫法
- `min-app.json`：每個案例的 `config`、平台、app 自己的版本、裝置時鐘的時間，讀出來的結果（照常、照常但先提醒起算日、停下來、讀不懂）和標準答案相同。這份標準答案由 `test/generate/min-app.ts` 寫出（在 `protocol/` 跑 `node --experimental-strip-types test/generate/min-app.ts`）：每一案的結果手寫在裡面，寫檔前先用 `src/min-app.ts` 讀一次，有一案不同就不寫

`test/roster-rules.test.ts`：

- `roster-rules.json`：每個案例的事件照順序餵給 `MemoryRules`，每一筆的結果（有效時每個平台的種類，無效時的代碼）和標準答案相同；無效的紀錄之後，那張卡片的狀態和名冊上最晚的有效日期都沒變；最後的現況（每張卡片的清單、`last_card_proof`、`proofs_on_last_date`、每個名額的四個項目，和每個帳號底下的卡片）和標準答案的 `state` 完全相同；規則產生得出來的每個狀態，裝置都讀得懂
- 規則的版本號：`RULES_VERSION` 等於 `spec/roster-rules.md` 寫的那一版，也等於 `roster-rules.json` 的 `rules_version`。Go 的 `roster/version_test.go` 拿 `roster.RulesVersion` 比同樣兩個地方
- `applyRecord` 本身：六個檢查的先後、檢查 3 和檢查 4 的邊界、無效的紀錄原樣交回收到的狀態、同樣的輸入算兩次結果相同而且輸入沒被改、狀態裡沒有的平台當成空的名額；清單裡有平台表以外的平台、同一個平台兩次、沒照平台排序、帳號不合它那個平台的格式，都在檢查 1 之前就是錯誤，不給代碼；一份清單錯了好幾處時，丟的是和 Go 的 `roster/` 相同的那一種
- `applyList`：事件規則在一個名額上的每一種情況和之後的名額、被擋的平台、一天 3 筆

`test/record.test.ts`：

- `record.json`：兩份名冊的每一筆紀錄，清單的寫法、名冊檔的那一行、紀錄雜湊、加上它之後的名冊指紋都和標準答案相同；每一行格式正確的都讀得出來，重寫一次位元組相同；71 種格式不對的行都讀不出來。`generated_roster` 的五個名冊目錄（0、1、1,000、1,001、2,001 筆）：每個名冊檔和每份雜湊清單的檔名、行數、第一行和最後一行、SHA-256 都和標準答案相同；兩份三筆的名冊的雜湊清單（`hash_list`）也是。指紋檔的一行（`fingerprintLine`）：五個名冊目錄的 `fingerprint_file` 和 `fingerprint_files` 裡每一份合格的指紋檔，每一行從日期、筆數、名冊指紋重寫出來位元組相同。名冊檔成立或不成立的案例和不合格的指紋檔（`files`、`fingerprint_files` 的其餘案例）這裡沒有讀：後台只寫指紋檔、不讀它，也不照「Check a file」檢查整份名冊檔（它重建衍生表時會把寫滿的檔整個讀回來，核對的是 SHA-256 和行數，再一行一行讀）；檢查這些的是 Go 的 `iamreal-verify`

`test/card-state-file.test.ts`：

- `card-state-file.json`：每個合格的檔，從狀態寫出來的位元組和標準答案相同（卡片倒著給、多帶初始狀態的名額也一樣；`cardStateFileWriter` 照檔的順序一次寫一列也一樣，格式錯、順序錯、同一張卡片兩次會丟錯），讀進來的每一列和標準答案相同；92 個不合格的檔都讀不出來，行號和代碼和標準答案相同（讀的是位元組；不是 UTF-8 的檔在標準答案裡寫成 `content_hex`）；前面多一個位元組順序記號的檔讀不出來；`rules_version` 等於 `roster-rules.json` 的和 `RULES_VERSION`；接著 `roster-rules.json` 某個案例的檔，拿那個案例最後的現況去掉初始狀態的名額、加上每張卡片最後一筆有效紀錄的序號，就是這個檔的卡片。`comparisons`（重驗的人怎麼逐張比）這裡不讀：比對在 Go 的重驗指令
- 寫不出來的：沒有有效紀錄的卡片、同一張卡片兩次、不是這份名冊的場合字串或平台、不合格式的帳號、序號和次數不是整數、日期不在寫得出來的年份

另外測台灣的日期（`test/spec.test.ts`）和規則產生不出來的狀態（`test/roster-rules.test.ts`）。

`test/generate/card-channel.ts` 寫出 `spec/vectors/card-channel.json`（`spec/card-channel.md`，在 `protocol/` 跑 `node --experimental-strip-types test/generate/card-channel.ts`）。讀它的是 `android/`、`ios/` 的測試，`src/` 裡沒有對應的程式。

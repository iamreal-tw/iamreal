# verifier

驗證一筆紀錄：檢查一行紀錄的寫法、算紀錄的雜湊、從紀錄的欄位重建證明的公開輸入，再用 `bb verify` 驗證明。

**這個目錄讓人檢查的事：任何人都能重驗一筆紀錄。** 照 `spec/` 實作，不需要後台。照紀錄規則算整份證明紀錄的程式在 `roster/`，把兩者接起來的指令在 `cmd/iamreal-verify/`。

## 內容

| 檔案 | 照哪份規格 | 內容 |
|---|---|---|
| `base32.go` | `spec/README.md` | Crockford base32，只有一種寫法的解碼 |
| `challenge.go` | `spec/challenge.md` | 題目的格式、日期、`current_time` |
| `scope.go` | `spec/scope.md` | 正式的證明紀錄和測試的證明紀錄各自接受的場合字串和平台（平台表、每個平台的帳號名稱格式）、打包 |
| `accounts.go` | `spec/record.md`「The account list」 | 帳號清單：照樣板寫出、對平台表檢查（平台在表裡、照平台代號嚴格遞增、帳號名稱合它自己平台的格式），不排序、不修補 |
| `declcode.go` | `spec/declaration-code.md` | 宣告碼（標籤、場合字串、每個帳號一行 `platform:username`、題目）和它的打包值 |
| `scopedid.go` | `spec/scoped-id.md` | 匿名編號的文字形式、短編號、網址裡的短編號 |
| `field.go` | `spec/scoped-id.md`、`spec/proof-verification.md` | 體的模數 `p`、32 位元組的公開輸入 |
| `record.go`、`jsonobj.go` | `spec/record.md` | 一筆紀錄的欄位、一行的檢查、紀錄雜湊 |
| `tables.go` | `spec/issuers.md`、`spec/record.md` | 發證金鑰表和接受的電路表，**編進程式** |
| `verify.go` | `spec/record.md`、`spec/proof-verification.md` | 重建公開輸入，`bb verify` 前後的檢查，用子行程呼叫 `bb` |
| `vk/` | `spec/record.md`「Accepted circuits」 | 兩把驗證金鑰，程式啟動時檢查 SHA-256 |
| `testdata/` | | 兩份真的證明（測試用的金鑰），見裡面的 `README.md` |

Poseidon2 和廢止清冊的樹不在這裡：驗證一筆紀錄不需要算它們（匿名編號和樹根都是證明的公開輸入，由電路檢查），它們屬於 `crl/`。

### 一行紀錄的檢查

`ParseLine` 照 `spec/record.md`「Check a line」做：用一個寬鬆的 JSON 讀法拿出各個值，逐一檢查格式，照樣板重寫，再和原本的位元組（含結尾的 `LF`）逐位元組比對。決定合不合格的是最後的比對，所以 JSON 讀法本身可以寬鬆。沒有用 `encoding/json` 解到結構體當作檢查：它不分鍵的大小寫、收重複的鍵。

`accounts` 也一樣：寬鬆的讀法照寫的順序讀出每個帳號（同一個鍵出現兩次時取第一個），`CheckAccounts` 檢查平台在這份證明紀錄的表裡、照平台代號嚴格遞增（所以不會重複）、每個帳號名稱合它自己平台的格式，再照樣板整行重寫比對。順序不對、平台重複、多一個鍵、鍵的順序不同、清單裡有空白，都讓這一行寫法錯；不排序、不挑第一個或最後一個。

### 發證金鑰和測試金鑰

正式的發證金鑰（`G2`、`G3` 的模數）和接受的電路寫死在 `tables.go`。**沒有任何設定能加入別的金鑰。** 測試用的金鑰只能經由 `NewWithIssuers` 注入，它只在兩種情況下存在：

- `export_test.go`：只在 `go test ./verifier` 時編譯，給這個目錄自己的測試用。
- `testissuers.go`：只在加了建置標籤 `iamrealtest` 時編譯，給其他目錄的測試用（`cmd/iamreal-verify` 的端到端測試，`go test -tags iamrealtest`）。

照 README 建置的執行檔不帶這個標籤，所以不含 `NewWithIssuers`，不認得測試金鑰。

### `bb verify` 前後

`VerifyRecord` 照 `spec/proof-verification.md`「Checks before and around `bb verify`」每一列做：

1. 驗證金鑰取自接受的電路表，SHA-256 等於紀錄的 `circuit`，而且這個電路屬於紀錄的 `issuer`。
2. 呼叫 `bb` 之前檢查證明剛好 14,656 個位元組、公開輸入剛好 23 或 40 個。
3. 呼叫 `bb` 之前檢查每個公開輸入小於 `p`。
4. 只跑 `bb verify -t noir-recursive`，不換設定重試。
5. `bb` 在子行程裡跑；非零結束、被訊號結束（當掉）、逾時都算拒絕。
6. 公開輸入全部從紀錄的欄位和固定的表重建，自己寫成二進位檔，不用任何隨證明附來的檔案。

每次驗證在新的暫存目錄裡寫 `vk`、`proof`、`public_inputs` 和通用參數檔，跑完刪掉。

## 需要的工具

### `bb` 6.0.0

| 平台 | 下載 | 壓縮檔的 SHA-256 |
|---|---|---|
| macOS arm64 | `https://github.com/AztecProtocol/aztec-packages/releases/download/v6.0.0/barretenberg-arm64-darwin.tar.gz` | `48bd18a7d53781a2820e7538dfd89584ca5b4d76c7908e8be4910ce994e7c35e` |

其他平台的壓縮檔在同一個發布頁，SHA-256 還沒有記錄。`New` 會跑 `bb --version`，不是 `6.0.0` 就拒絕啟動。

不另外下載也可以：`web/` 用的套件 `@aztec-foundation/bb.js` 6.0.0（`pnpm-lock.yaml`）附了四個平台的 `bb`，在根目錄 `pnpm install` 之後是 `web/node_modules/@aztec-foundation/bb.js/build/<平台>/bb`（`arm64-macos`、`amd64-macos`、`arm64-linux`、`amd64-linux`）。`arm64-macos` 那一個和上表壓縮檔裡的 `bb` 逐位元組相同（SHA-256 `f3af6634d08980744f6c9d18010f65b4fd2bbcf23f99e62fd81078ca9b35aa7e`）。GitHub Actions 上 PR 的檢查用 `amd64-linux` 那一個（`.github/workflows/checks.yml`、`checks-browser.yml`），每個工作用它之前核對它的 SHA-256：`5bbb64800d431c6760a70d8723be4eaf37ed10e8fbfe2842bb85b8436180c130`，是 `@aztec-foundation/bb.js` 6.0.0 的 `build/amd64-linux/bb`（`worker/test/workflows.test.ts` 拿裝下來的套件重算）。

### 通用參數

`bb verify` 只讀一個通用參數檔：

| 檔名 | 大小 | SHA-256 | 內容 |
|---|---|---|---|
| `bn254_g1.dat` | 64 個位元組 | `d6ba9329f8932c12192b37849f772104d20048f76434a3290512d9d814e4116f` | BN254 G1 的第一個點：`x = 1`、`y = 2`，各 32 個位元組，大端序 |

`New` 讀這個檔案、檢查 SHA-256，每次驗證把這份檢查過的內容寫進暫存目錄再交給 `bb`，所以 `bb` 不會讀到別的檔案，也不會自己下載。

兩種取得方式：

```
# 自己寫：64 個位元組
printf '%062d01%062d02' 0 0 | xxd -r -p > crs/bn254_g1.dat

# 或讓 bb 下載：-c 指向空目錄跑一次 bb verify
```

讓 `bb` 下載時，它從 `http://crs.aztec-cdn.foundation/g1_compressed.dat`（備用 `http://crs.aztec-labs.com/g1_compressed.dat`，都是 HTTP）抓第一段 4 MiB（`bn254_g1_compressed.dat`，SHA-256 `fad8203ae1fd103658d4bb33b2b4cf126a28352b5de4684737cff23cc15fb94b`），用它內建的雜湊檢查，再把第一個點寫成 `bn254_g1.dat`。兩種方式得到的 `bn254_g1.dat` 相同。

## 怎麼單獨執行

```
go build ./verifier
go test ./verifier                                   # 標準答案；沒有 bb 時，真證明的測試跳過
IAMREAL_BB=/path/to/bb go test ./verifier            # 加上真證明的測試
IAMREAL_BB=/path/to/bb IAMREAL_CRS=/path/to/crs go test ./verifier   # 用指定的通用參數目錄
```

沒給 `IAMREAL_CRS` 時，測試自己寫出 `bn254_g1.dat`（上面那 64 個位元組），`New` 照樣檢查 SHA-256。

**標準答案**（`vectors_test.go`）：`spec/vectors/` 的 `challenge.json`、`scope.json`、`declaration-code.json`、`scoped-id.json`、`issuers.json`、`record.json` 每一個案例各是一個子測試。`scope.json` 的場合、平台、帳號名稱各自也經過一行紀錄的檢查；`declaration-code.json` 比對原文、雜湊、宣告碼、打包值，以及從紀錄重建的最後一個公開輸入；`record.json` 的 `rosters`（正式的證明紀錄、測試的證明紀錄）比對清單的寫法、整行和紀錄的雜湊，每一行寫法錯的行都要被拒絕。`record.json` 的指紋、`files` 和公布的證明紀錄由 `roster/` 跑。

`internal_test.go` 另外測：平台表（代號的格式、不重複、正式的證明紀錄沒有 `test-` 開頭的、`Platforms` 照代號排序）；兩個帳號的一行，清單裡每一個位元組換成別的字元，要不是被拒絕，就是另一行照樣板寫出的紀錄。

`platforms_test.go`：兩份證明紀錄每個平台的格式字串，照裝置的讀法（不用正規表示式）讀出來，和檢查函式對每一個單一位元組、字母前後的每一個位元組、長度上限前後的字串答案相同。

**真的證明**（`proof_test.go`）：正確的證明通過、每一個公開輸入改一個值被拒絕、紀錄的每個欄位改掉被拒絕（帳號清單：改一個帳號名稱、帳號換平台、少一個、多一個、順序對調、空的清單）、證明少一個位元組、多一個位元組、改一個位元組被拒絕、非零知識的證明被拒絕、亂數的證明被拒絕、`bb` 當掉或逾時算拒絕，以及兩筆紀錄組成的測試的證明紀錄經過 `roster/` 的規則。

## 對外的函式

| 函式 | 做什麼 |
|---|---|
| `ParseLine(line, roster)` | 檢查一行（含 `LF`），回傳紀錄；錯誤代表這行格式錯誤 |
| `(*Record).Line()`、`Hash()`、`HashPreimage()`、`Date()`、`CheckValues(roster)`、`ProofBytes()`、`Equal(o)` | 照樣板寫回、紀錄雜湊、日期、逐欄檢查、解出證明、比較兩筆（`nil` 和空的清單相同） |
| `Account`、`AccountsText`、`CheckAccounts(roster, accounts)`、`ReadAccountsText`、`AccountOn` | 帳號清單：照樣板寫出、對平台表檢查、讀回只有一種寫法的清單（後台的資料庫用）、某個平台的帳號 |
| `New(Config)` | 用編進程式的發證金鑰建驗證器；檢查 `bb` 的版本和通用參數 |
| `(*Verifier).VerifyRecord(r)` | 驗證一筆格式正確的紀錄：`nil` 是通過，`*Rejection` 是不通過（紀錄規則的 `proof`），其他錯誤是驗證器自己跑不起來 |
| `PublicInputs(r)`、`EncodePublicInputs` | 從紀錄重建公開輸入、寫成 `bb` 讀的二進位格式 |
| `ParseChallenge`、`CurrentTime`、`ParseDate` | 題目和日期 |
| `LookupScope`、`Scopes`、`ScopePacked` | 場合 |
| `Platforms`、`LookupPlatform` | 平台表（照代號排序）：代號、顯示名稱、帳號名稱格式的字串（`UsernameFormat`，和規格的表一字不差，後台的 `config` 送出它）和檢查函式（`ValidUsername`；兩者一致由 `platforms_test.go` 檢查） |
| `DeclarationCode(scope, accounts, challenge)`、`DeclarationPreimage`、`DeclarationCodePacked` | 宣告碼 |
| `ParseScopedID`、`ScopedIDText`、`ShortID`、`ReadShortIDInURL` | 匿名編號 |
| `Issuers`、`AcceptedCircuits`、`LookupCircuit`、`ModulusLimbs` | 編進程式的表 |

# verifier

驗證一筆紀錄：檢查一行紀錄的寫法、算紀錄的雜湊、從紀錄的欄位重建證明的公開輸入，再用 `bb verify` 驗證明。

**這個目錄讓人檢查的事：任何人都能重驗一筆紀錄。** 照 `spec/` 實作，不需要後台，也不引用 `server/`。整份名冊的規則在 `roster/`，把兩者接起來的指令在 `cmd/iamreal-verify/`。

## 內容

| 檔案 | 照哪份規格 | 內容 |
|---|---|---|
| `base32.go` | `spec/README.md` | Crockford base32，只有一種寫法的解碼 |
| `challenge.go` | `spec/challenge.md` | 題目的格式、日期、`current_time` |
| `scope.go` | `spec/scope.md` | 正式名冊和測試名冊各自接受的場合字串、帳號名稱的格式、打包 |
| `declcode.go` | `spec/declaration-code.md` | 宣告碼和它的打包值 |
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

### 發證金鑰和測試金鑰

正式的發證金鑰（`G2`、`G3` 的模數）和接受的電路寫死在 `tables.go`。**沒有任何設定能加入別的金鑰。** 測試用的金鑰只能經由 `export_test.go` 的 `NewWithIssuers` 注入；這個檔案只在 `go test` 時編譯，任何執行檔都不含它。

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

**標準答案**（`vectors_test.go`）：`spec/vectors/` 的 `challenge.json`、`scope.json`、`declaration-code.json`、`scoped-id.json`、`issuers.json`、`record.json` 每一個案例各是一個子測試。`record.json` 的 `files` 由 `roster/` 跑。

**真的證明**（`proof_test.go`）：正確的證明通過、每一個公開輸入改一個值被拒絕、紀錄的每個欄位改掉被拒絕、證明少一個位元組、多一個位元組、改一個位元組被拒絕、非零知識的證明被拒絕、亂數的證明被拒絕、`bb` 當掉或逾時算拒絕，以及兩筆紀錄組成的測試名冊經過 `roster/` 的規則。

## 對外的函式

| 函式 | 做什麼 |
|---|---|
| `ParseLine(line, roster)` | 檢查一行（含 `LF`），回傳紀錄；錯誤代表這行格式錯誤 |
| `(*Record).Line()`、`Hash()`、`HashPreimage()`、`Date()`、`CheckValues(roster)`、`ProofBytes()` | 照樣板寫回、紀錄雜湊、日期、逐欄檢查、解出證明 |
| `New(Config)` | 用編進程式的發證金鑰建驗證器；檢查 `bb` 的版本和通用參數 |
| `(*Verifier).VerifyRecord(r)` | 驗證一筆格式正確的紀錄：`nil` 是通過，`*Rejection` 是不通過（名冊規則的 `proof`），其他錯誤是驗證器自己跑不起來 |
| `PublicInputs(r)`、`EncodePublicInputs` | 從紀錄重建公開輸入、寫成 `bb` 讀的二進位格式 |
| `ParseChallenge`、`CurrentTime`、`ParseDate` | 題目和日期 |
| `LookupScope`、`Scopes`、`ScopePacked` | 場合 |
| `DeclarationCode`、`DeclarationPreimage`、`DeclarationCodePacked` | 宣告碼 |
| `ParseScopedID`、`ScopedIDText`、`ShortID`、`ReadShortIDInURL` | 匿名編號 |
| `Issuers`、`AcceptedCircuits`、`LookupCircuit`、`ModulusLimbs` | 編進程式的表 |

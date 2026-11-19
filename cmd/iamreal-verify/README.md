# iamreal-verify

重驗一份名冊：整份名冊是否成立、每一筆的結果、最後每張卡片和每個帳號的現況。名冊可以是一個名冊檔案，也可以是公布的名冊目錄（每 1,000 筆一檔，加上每一檔的雜湊清單和指紋檔 `fingerprints.jsonl`）。把 `verifier/`（驗證每一筆的證明）、`roster/`（名冊規則）和 `crl/`（廢止清冊的存檔，回答樹根是否被承認）接起來。

## 安裝

需要 Go 1.26、`bb` 6.0.0 和通用參數檔 `bn254_g1.dat`，取得方式見 `verifier/README.md`；還有廢止清冊的存檔（清冊檔案加索引 `index.jsonl`，見 `crl/README.md`「存檔索引」）。

```
go build -o iamreal-verify ./cmd/iamreal-verify
```

## 用法

```
iamreal-verify -bb <bb 的路徑> -crs <通用參數目錄> -crl-archive <存檔目錄> [選項] <名冊檔案或名冊目錄>
```

名冊檔案寫 `-` 時從標準輸入讀。給的是目錄時，照下面「名冊目錄」讀。

| 選項 | 預設 | 說明 |
|---|---|---|
| `-bb` | （必填） | `bb` 6.0.0 的路徑。版本不對就不執行 |
| `-crs` | （必填） | 放 `bn254_g1.dat` 的目錄。SHA-256 不對就不執行 |
| `-roster` | `production` | 照哪一份名冊的表（接受的場合和平台）：`production`（正式名冊）或 `test`（測試名冊） |
| `-timeout` | `30s` | 一次 `bb verify` 最多跑多久，超過算證明不通過 |
| `-json` | 關 | 用 JSON 輸出 |
| `-crl-archive` | （無） | 廢止清冊存檔的目錄，裡面有清冊檔案和索引 `index.jsonl`。沒給時沒有任何樹根被承認（見下面） |
| `-crl-trust-index` | 關 | 只讀索引，不拿清冊檔案重算（見下面） |

發證金鑰和接受的電路編在程式裡，沒有選項能換；存檔裡的清冊也只用這兩把發證金鑰驗章。

### 存檔：完整重算或只信索引

第 3 項檢查（`root`）要知道每個樹根屬於哪些可用的清冊、清冊日期是哪天。這個答案從存檔來：

- **預設：完整重算。** 對目錄裡的每個清冊重新驗章、建樹，重建一份索引，和 `index.jsonl` 逐行比對。照規格「Re-verifying with the index」，**重建的索引才算數**：有不同時，每一個不同都在標準錯誤印一行，最後印一行共有幾個不同，然後照重建的索引繼續算，結果照樣印出；結束碼是 1，不會是 0。不同包括：沒有 `index.jsonl`（只報一次）、`index.jsonl` 沒辦法切成行（最後沒有 LF、開頭有 BOM；只報一次）、寫法不合規格或順序錯的行（每行一次，附行號）、索引列了但目錄裡沒有的檔案、索引沒列的檔案、同一個檔案的行不同。細節見 `crl/README.md` 的 `crl.RebuildArchive`。每個清冊開始時在標準錯誤印一行。內政部大小的清冊一份要 5 到 10 秒。
- **`-crl-trust-index`：只信索引。** 只讀 `index.jsonl` 並檢查每一行的寫法（包括樹根小於 BN254 純量體的模數 `p`），不讀清冊檔案，所以快；但索引寫錯的樹根不會被發現。標準錯誤會印一行提醒。沒有 `index.jsonl`、或任何一行寫法不對時，沒有別的東西能代替它，停下，結束碼 2。

### 名冊目錄

照規格 `spec/record.md`「The published roster」。目錄裡名字是 16 位數字加 `.jsonl` 的檔案是名冊檔案，照名字排序接起來就是整份名冊；其他檔案（`fingerprints.jsonl`、說明檔）不算在名冊裡；子目錄只讀放雜湊清單的 `hashes/`。

- **切法**：第 k 個檔（從 0 算）必須叫 `1000k`（這一檔之前的筆數）寫成 16 位數字，除了最後一個都剛好 1,000 行，最後一個 1 到 1,000 行，沒有空檔。行數照 LF 算，最後一個 LF 之後還有位元組時多算一行。不合的話整份名冊不成立，代碼是 `directory`，行號是出問題的檔案開始（或應該開始）的那一行：例如少了 `0000000000001000.jsonl` 時，報第 1001 行；檔名照舊寫第一筆的 `seq`（`0000000000000001.jsonl`）的目錄，在第 1 行報出來。規格說這種目錄「像寫法錯的行一樣」不成立，但沒有給它代碼，`directory` 是這個指令自己取的。
- 切法對了以後，接起來的檔案照名冊檔案的規則檢查（`line`、`seq`），行號是整份名冊的行號。
- **雜湊清單**：名冊成立時，每個名冊檔在 `hashes/` 裡要有一份雜湊清單（同樣的數字加 `.txt`），內容和從紀錄寫出來的逐位元組相同：第一行是這一檔之前的名冊指紋，之後每筆紀錄的雜湊一行。少了、內容不同、沒有對應的名冊檔，每一份在標準錯誤印一行，結束碼是 1；全部對時在標準錯誤印一行「every list is the roster's」。
- **指紋檔**：名冊成立時，檢查 `fingerprints.jsonl` 的每一行：照樣板只有一種寫法、日期一行比一行晚、筆數不減少、筆數不超過名冊的筆數、`fingerprint` 等於名冊前 `count` 筆紀錄的名冊指紋（筆數 0 時是 64 個 0）。每個問題在標準錯誤印一行（附行號），結束碼是 1；全部對時在標準錯誤印一行「every fingerprint is the roster's」。沒有 `fingerprints.jsonl` 也算一個問題。
- 名冊不成立時不檢查雜湊清單和指紋檔。目錄裡的紀錄全部都檢查，包括指紋檔最後一行的筆數之後、還沒公布的紀錄（規格說重驗的人只核對到那一行的筆數；這個指令還沒照這一點縮小範圍）。

**沒給 `-crl-archive` 時**沒有任何樹根被承認：每一筆證明通過、題目沒用過的紀錄都會是 `root`，標準錯誤印一行提醒。

## 輸出

文字輸出（`testdata/` 的測試名冊，`-roster test`）：

```
roster file: valid
records: 3
fingerprint: 93c61915a4e745806876dc676dcc88bb5a677507167fc746fcf9f5983afffd3e

records:
  1 valid threads first
  2 valid test-example first, threads first
  3 valid test-example withdraw, threads refresh

scope iamreal-test:public:0__________
  cards:
    FEYB7PB5GX6DR23VAG6TGWHGFWP99M4XR8KP0RTC3P7Q6DY488AG  last card proof 2026-11-16
      threads alice
    SA5G3V8XXE61EHNEJ8MACZF729GEJPPM2BMJV26N687TB9WPT000  last card proof 2026-11-24
      threads alice
  accounts:
    threads alice
      FEYB7PB5GX6DR23VAG6TGWHGFWP99M4XR8KP0RTC3P7Q6DY488AG  last card proof 2026-11-16
      SA5G3V8XXE61EHNEJ8MACZF729GEJPPM2BMJV26N687TB9WPT000  last card proof 2026-11-24
```

- 每一筆有效的紀錄列出它在每個平台的種類（`first`、`refresh`、`correction`、`switch`、`withdraw`），照平台代號排；無效的列出代碼，有說明時加在括號裡（例如 `switch_limit (platform threads)`、`daily_limit (3 valid records dated 2026-11-16)`；說明不是規則的輸出）。
- 每張卡片列出上次過卡日和現在的清單（每個平台一行，照平台排）；收回了全部帳號的卡片仍然列出，寫 `no account`。
- 每個帳號是（平台、帳號名稱），照平台再照帳號名稱排，底下是現在在那個平台宣告它的卡片。同一個帳號名稱在兩個平台是兩個帳號。

壞掉的檔案只印一行：`roster file: broken at line 3: line (…)`，不算現況。

`-json` 的形狀和 `spec/vectors/` 相同：有效的檔案是 `{"valid": true, "fingerprint": …, "results": [...], "state": [...]}`，`results` 和 `state` 同 `roster-rules.json`（有效的結果是 `kinds`，每一項 `platform`、`kind`；每張卡片是 `scoped_id`、`last_card_proof`、`accounts`；每個帳號是 `platform`、`username`、`cards`），只是卡片沒有 `proofs_on_last_date` 和 `slots`：那兩項是卡片的狀態，不是規則的輸出；壞掉的是 `{"valid": false, "line": 3, "code": "line"}`，同 `record.json` 的 `files`。

## 結束碼

| 碼 | 意思 |
|---|---|
| 0 | 檔案有效，每一筆都有效 |
| 1 | 名冊不成立（檔案或目錄壞掉）、有無效的紀錄、完整重算時清冊存檔的索引和清冊檔案不同（包括沒有索引、索引寫法不對；結果照重建的索引算），或名冊目錄的雜湊清單、`fingerprints.jsonl` 有問題 |
| 2 | 沒辦法檢查（選項錯誤、讀不到檔案、`bb` 或通用參數不對、驗證器出錯、`-crl-trust-index` 時沒有索引或索引寫法不對） |

## 測試

```
go test ./cmd/iamreal-verify
IAMREAL_BB=/path/to/bb go test -tags iamrealtest ./cmd/iamreal-verify   # 加上真證明的端到端測試
```

- `main_test.go`：假的驗證器和假的清冊存檔，跑 `spec/vectors/record.json` 的「three records」（一個帳號、空的清冊、一個帳號），檢查文字和 JSON 的輸出、壞掉的檔案、空的名冊、結束碼；同一張卡片同一天第 4 筆在兩種輸出都是 `daily_limit`；同一天換帳號在兩種輸出都是 `correction`、隔天是 `switch`。
- `archive_test.go`：`testdata/` 的測試名冊和清冊存檔（見 `testdata/README.md`），用真的存檔和假的驗證器：完整重算和只信索引都是全部有效；拿掉一份清冊（連同索引那一行），用它的紀錄變成 `root`；索引沒跟著改、多一個檔案、索引的樹根改過時，完整重算印出每一個不同、照重建的索引算出結果（結束碼 1），只信索引時照索引回答；沒有索引、索引寫法不對、索引最後沒有 LF 時，完整重算同樣報出不同、算出結果（結束碼 1），只信索引時結束碼 2。
- `directory_test.go`：2,001 筆的假名冊切成目錄：三個檔、一個檔 1 筆或 1,000 筆、沒有紀錄時都成立，輸出和同一份名冊當成一個檔案時相同；少了中間的檔、第一個檔不滿 1,000 行、最後一個超過 1,000 行、空檔、檔名照舊寫第一筆的 `seq`（第一個檔或第二個檔）時是 `directory`；檔案最後少了 LF、檔案長度對但紀錄排錯時，照名冊檔案的規則報 `line`、`seq`。雜湊清單：少了一份、全部沒有、多一份沒有名冊檔的、改了一個雜湊、第一行不是這一檔之前的名冊指紋、少了第一行、換成只有一筆的名冊的清單，每一種都報出來。`fingerprints.jsonl`：沒有、別份名冊的名冊指紋、最後一筆的紀錄雜湊（ADR-0021 之前的鏈尾）、鍵是 `head`、筆數超過、日期重複或倒退、筆數減少、別的寫法、日期不存在、最後沒有 LF，每一種都報出來並附行號，好幾行有問題時每一行都報。
- `vectors_test.go`：`spec/vectors/record.json` 的 `generated_roster`：照標準答案給的檔名、第一筆的 `seq` 和行數寫出 0、1、1,000、1,001、2,001 筆的名冊目錄（每個名冊檔和雜湊清單先比對 SHA-256），指令讀出來是有效的、名冊指紋和標準答案相同；`fingerprint_files`：每一份指紋檔配上它那份名冊，有效的沒有問題，無效的第一個報出的行號和標準答案相同。
- `e2e_test.go`：同樣的案例，換成真的驗證器和 `bb`（每一筆的種類見 `testdata/README.md`）。測試的證明是用拋棄式的發證金鑰做的，要經由 `verifier.NewWithIssuers` 注入，這個函式只在建置標籤 `iamrealtest` 下存在（見 `verifier/README.md`「發證金鑰和測試金鑰」），所以要加 `-tags iamrealtest`；沒設 `IAMREAL_BB` 時跳過。另外確認用編進程式的發證金鑰時，三筆都是 `proof`。

### 只在測試建置裡的選項 `-test-issuers`

加了建置標籤 `iamrealtest` 時（`testissuers.go`），多一個選項 `-test-issuers <目錄>`：目錄裡的 `issuer-G2.der`、`issuer-G3.der`（SubjectPublicKeyInfo）代替內政部的兩把發證金鑰，驗證明（經由 `verifier.NewWithIssuers`）和驗清冊都用它們。`server/` 的端到端測試用 `go build -tags iamrealtest` 建出這個指令，拿來重驗後台出的名冊目錄。照上面「安裝」建出來的執行檔沒有這個選項。

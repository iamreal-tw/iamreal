# iamreal-verify

重驗一份名冊檔案：整份檔案是否成立、每一筆的結果、最後每張卡片和每個帳號的現況。把 `verifier/`（驗證每一筆的證明）、`roster/`（名冊規則）和 `crl/`（廢止清冊的存檔，回答樹根是否被承認）接起來。

## 安裝

需要 Go 1.26、`bb` 6.0.0 和通用參數檔 `bn254_g1.dat`，取得方式見 `verifier/README.md`；還有廢止清冊的存檔（清冊檔案加索引 `index.jsonl`，見 `crl/README.md`「存檔索引」）。

```
go build -o iamreal-verify ./cmd/iamreal-verify
```

## 用法

```
iamreal-verify -bb <bb 的路徑> -crs <通用參數目錄> -crl-archive <存檔目錄> [選項] <名冊檔案>
```

名冊檔案寫 `-` 時從標準輸入讀。

| 選項 | 預設 | 說明 |
|---|---|---|
| `-bb` | （必填） | `bb` 6.0.0 的路徑。版本不對就不執行 |
| `-crs` | （必填） | 放 `bn254_g1.dat` 的目錄。SHA-256 不對就不執行 |
| `-roster` | `production` | 照哪一份接受的場合：`production`（正式名冊）或 `test`（測試名冊） |
| `-timeout` | `30s` | 一次 `bb verify` 最多跑多久，超過算證明不通過 |
| `-json` | 關 | 用 JSON 輸出 |
| `-crl-archive` | （無） | 廢止清冊存檔的目錄，裡面有清冊檔案和索引 `index.jsonl`。沒給時沒有任何樹根被承認（見下面） |
| `-crl-trust-index` | 關 | 只讀索引，不拿清冊檔案重算（見下面） |

發證金鑰和接受的電路編在程式裡，沒有選項能換；存檔裡的清冊也只用這兩把發證金鑰驗章。

### 存檔：完整重算或只信索引

第 3 項檢查（`root`）要知道每個樹根屬於哪些可用的清冊、清冊日期是哪天。這個答案從存檔來：

- **預設：完整重算。** 對目錄裡的每個清冊重新驗章、建樹，重建一份索引，和 `index.jsonl` 逐行比對。照規格「Re-verifying with the index」，**重建的索引才算數**：有不同時，每一個不同都在標準錯誤印一行，最後印一行共有幾個不同，然後照重建的索引繼續算，結果照樣印出；結束碼是 1，不會是 0。不同包括：沒有 `index.jsonl`（只報一次）、`index.jsonl` 沒辦法切成行（最後沒有 LF、開頭有 BOM；只報一次）、寫法不合規格或順序錯的行（每行一次，附行號）、索引列了但目錄裡沒有的檔案、索引沒列的檔案、同一個檔案的行不同。細節見 `crl/README.md` 的 `crl.RebuildArchive`。每個清冊開始時在標準錯誤印一行。內政部大小的清冊一份要 5 到 10 秒。
- **`-crl-trust-index`：只信索引。** 只讀 `index.jsonl` 並檢查每一行的寫法（包括樹根小於 BN254 純量體的模數 `p`），不讀清冊檔案，所以快；但索引寫錯的樹根不會被發現。標準錯誤會印一行提醒。沒有 `index.jsonl`、或任何一行寫法不對時，沒有別的東西能代替它，停下，結束碼 2。

**沒給 `-crl-archive` 時**沒有任何樹根被承認：每一筆證明通過、題目沒用過的紀錄都會是 `root`，標準錯誤印一行提醒。

## 輸出

文字輸出：

```
roster file: valid
records: 3
head: 98949b75a890c8c834c752fe28fda41da55edeed66cc196b75547d376f4192e7

records:
  1 valid first
  2 valid withdraw
  3 invalid root

scope iamreal:threads:0______________
  cards:
    QSP7N676SNSV57YS61FXVMVQDD9ETF5SGJ2N0CNGFF2EN8D0V880  current none  last card proof 2027-01-01
  accounts:
```

壞掉的檔案只印一行：`roster file: broken at line 3: line (…)`，不算現況。

`-json` 的形狀和 `spec/vectors/` 相同：有效的檔案是 `{"valid": true, "head": …, "results": [...], "state": [...]}`，`results` 和 `state` 同 `roster-rules.json`；壞掉的是 `{"valid": false, "line": 3, "code": "line"}`，同 `record.json` 的 `files`。

## 結束碼

| 碼 | 意思 |
|---|---|
| 0 | 檔案有效，每一筆都有效 |
| 1 | 檔案壞掉、有無效的紀錄，或完整重算時清冊存檔的索引和清冊檔案不同（包括沒有索引、索引寫法不對；結果照重建的索引算） |
| 2 | 沒辦法檢查（選項錯誤、讀不到檔案、`bb` 或通用參數不對、驗證器出錯、`-crl-trust-index` 時沒有索引或索引寫法不對） |

## 測試

```
go test ./cmd/iamreal-verify
IAMREAL_BB=/path/to/bb go test -tags iamrealtest ./cmd/iamreal-verify   # 加上真證明的端到端測試
```

- `main_test.go`：假的驗證器和假的清冊存檔，跑 `spec/vectors/record.json` 的檔案，檢查文字和 JSON 的輸出、壞掉的檔案、空的名冊、結束碼。
- `archive_test.go`：`testdata/` 的測試名冊和清冊存檔（見 `testdata/README.md`），用真的存檔和假的驗證器：完整重算和只信索引都是全部有效；拿掉一份清冊（連同索引那一行），用它的紀錄變成 `root`；索引沒跟著改、多一個檔案、索引的樹根改過時，完整重算印出每一個不同、照重建的索引算出結果（結束碼 1），只信索引時照索引回答；沒有索引、索引寫法不對、索引最後沒有 LF 時，完整重算同樣報出不同、算出結果（結束碼 1），只信索引時結束碼 2。
- `e2e_test.go`：同樣的案例，換成真的驗證器和 `bb`。測試的證明是用拋棄式的發證金鑰做的，要經由 `verifier.NewWithIssuers` 注入，這個函式只在建置標籤 `iamrealtest` 下存在（見 `verifier/README.md`「發證金鑰和測試金鑰」），所以要加 `-tags iamrealtest`；沒設 `IAMREAL_BB` 時跳過。另外確認用編進程式的發證金鑰時，三筆都是 `proof`。

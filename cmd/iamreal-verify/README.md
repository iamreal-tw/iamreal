# iamreal-verify

重驗一份名冊檔案：整份檔案是否成立、每一筆的結果、最後每張卡片和每個帳號的現況。把 `verifier/`（驗證每一筆的證明）和 `roster/`（名冊規則）接起來。

## 安裝

需要 Go 1.26、`bb` 6.0.0 和通用參數檔 `bn254_g1.dat`，取得方式見 `verifier/README.md`。

```
go build -o iamreal-verify ./cmd/iamreal-verify
```

## 用法

```
iamreal-verify -bb <bb 的路徑> -crs <通用參數目錄> [選項] <名冊檔案>
```

名冊檔案寫 `-` 時從標準輸入讀。

| 選項 | 預設 | 說明 |
|---|---|---|
| `-bb` | （必填） | `bb` 6.0.0 的路徑。版本不對就不執行 |
| `-crs` | （必填） | 放 `bn254_g1.dat` 的目錄。SHA-256 不對就不執行 |
| `-roster` | `production` | 照哪一份接受的場合：`production`（正式名冊）或 `test`（測試名冊） |
| `-timeout` | `30s` | 一次 `bb verify` 最多跑多久，超過算證明不通過 |
| `-json` | 關 | 用 JSON 輸出 |

發證金鑰和接受的電路編在程式裡，沒有選項能換。

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
| 1 | 檔案壞掉，或有無效的紀錄 |
| 2 | 沒辦法檢查（選項錯誤、讀不到檔案、`bb` 或通用參數不對、驗證器出錯） |

## 現在的限制

**還沒有廢止清冊的存檔可讀**（`crl/` 還沒寫，存檔的格式也還沒定，見 `spec/revocation-tree.md`「Open items」）。在那之前沒有任何樹根被承認：每一筆證明通過、題目沒用過的紀錄都會是 `root`，指令會在標準錯誤印一行提醒。

## 測試

```
go test ./cmd/iamreal-verify
```

測試用假的驗證器和假的清冊存檔，跑 `spec/vectors/record.json` 的檔案，檢查文字和 JSON 的輸出、壞掉的檔案、空的名冊、結束碼。

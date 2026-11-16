# crl/：從內政部的廢止清冊重建樹根

這個目錄讓人檢查的事：**拿內政部的廢止清冊，任何人都能重建出相同的樹根。** 規則在 [`spec/revocation-tree.md`](../spec/revocation-tree.md)：哪些清冊可以用、樹怎麼建、「不在樹裡」的證明長什麼樣子。

這裡的程式不引用這個程式庫的其他目錄。指令在 [`cmd/iamreal-crl/`](../cmd/iamreal-crl)，只引用 `crl/`。用來驗清冊簽章的兩張發證憑證直接放在這裡（`MOICA2.cer`、`MOICA-G3.cer`），測試會檢查它們的 SHA-256 和模數等於 [`spec/issuers.md`](../spec/issuers.md) 與 `spec/vectors/issuers.json`。

## 單獨執行

只需要 Go 1.26。在程式庫的根目錄：

```sh
go build -o iamreal-crl ./cmd/iamreal-crl
```

### 拿內政部的清冊重算樹根

1. 下載清冊（完整清冊，DER）。清冊有內政部的簽章，用 HTTP 下載也能檢查它沒被改過：
   - G2：`http://moica.nat.gov.tw/repository/MOICA/CRL2/complete.crl`
   - G3：`http://crl-moica.moi.gov.tw/crl/MOICA-G3-complete.crl`
2. 檢查並建樹：

   ```sh
   ./iamreal-crl check -issuer G3 MOICA-G3-complete.crl
   ```

   印出的欄位：

   | 欄位 | 內容 |
   |---|---|
   | `crl_number` | 清冊編號（`cRLNumber`），十進位；沒有這個延伸欄位時是 `-` |
   | `this_update`、`next_update` | 清冊的 `thisUpdate`、`nextUpdate`（UTC） |
   | `crl_date` | 清冊日期：`thisUpdate` 換成台灣日期（UTC+8） |
   | `sha256` | 整個檔案的 SHA-256 |
   | `entries` | 廢止的筆數 |
   | `usable` | 照規格「Which CRLs」可不可用 |
   | `root` | 樹根，64 個小寫十六進位數字（大端序），和紀錄的 `smt_root` 同一種寫法 |

3. 拿 `root` 和紀錄的 `smt_root` 比對。紀錄的日期要落在清冊日期的前 1 天到後 3 天之間，樹根才被承認（規格「Which roots a record may use」）。

清冊不可用時印出 `usable no` 和原因，結束代碼是 1；其他錯誤（讀不到檔案、不是 DER 的清冊）是 2。不可用的原因有：簽章演算法不是 sha256WithRSAEncryption、簽章不對、差異清冊（`deltaCRLIndicator`）、分段清冊（`issuingDistributionPoint`）、不認得的關鍵延伸欄位、同一個延伸欄位出現兩次、序號是負數／不是最短編碼／超過 20 個位元組、兩個序號的最低 127 位元相同。

在 M1 Max 上，G3（約 17.6 萬筆）建樹約 5 秒、記憶體約 110 MB；G2（約 34 萬筆）約 10 秒、約 200 MB。

### 算「不在樹裡」的證明

```sh
./iamreal-crl prove -issuer G3 -serial 1234567890abcdef1234567890abcdef MOICA-G3-complete.crl
```

`-serial` 是憑證序號的內容位元組當成無號整數，用十六進位寫（可以有 `0x`，也可以是 `openssl` 印的冒號格式）。輸出是電路的輸入 `smt_root`、`smt_siblings`（128 個）、`smt_old_key`、`smt_old_value`、`smt_is_old0`。序號在清冊裡（被廢止）時沒有證明，結束代碼 2。

這個指令是給檢查和測試用的。持卡人的裝置自己建樹、自己算證明，不用這個指令，也不把序號交給任何人。

### 存檔索引（提案）

規格把「存檔放哪裡、什麼格式」列為待辦，這裡的格式是提案：

```sh
./iamreal-crl index DIR
```

讀一個目錄裡的每個檔案，用兩把發證金鑰試簽章，決定它屬於 G2 還是 G3，每份可用的清冊印一行，依金鑰、清冊編號、SHA-256 排序：

```
{"issuer":"G3","crl_number":"4660","this_update":"2026-11-15T16:30:00Z","next_update":"2026-11-17T04:30:00Z","crl_date":"2026-11-16","sha256":"…","root":"…"}
```

每一行是固定的樣板（鍵的順序固定、沒有空白），和紀錄的寫法相同（[`spec/record.md`](../spec/record.md)「Lines and files」）。不可用或讀不懂的檔案不列入，原因印在標準錯誤，所有檔案處理完後結束代碼是 1。

索引只是方便：重驗的人仍然要下載清冊本身，檢查簽章，自己重建樹根。

`-key FILE` 讓 `check`、`prove` 改用測試用的發證金鑰（公鑰或憑證，DER 或 PEM），`index` 則多試這把金鑰。測試金鑰從來不是內政部的金鑰。

## 檔案

| 檔案 | 內容 |
|---|---|
| `crl.go` | 解析 `CertificateList`（嚴格的 DER），`Check` 判斷可不可用並取出每個序號的鍵，清冊日期 |
| `key.go` | 鍵：序號內容位元組的無號大端值，最多 20 個位元組 |
| `tree.go` | 樹（circomlib 的稀疏 Merkle 樹，Poseidon2）、樹根、「不在樹裡」的證明 |
| `issuers.go`、`MOICA2.cer`、`MOICA-G3.cer` | 兩把發證金鑰 |
| `poseidon2/` | Poseidon2（`spec/scoped-id.md`）。`constants.go` 由 `spec/vectors/poseidon2-constants.json` 產生（`go generate ./crl/poseidon2`） |
| `internal/crltest/` | 寫自製清冊的程式；`makecrl/` 寫一份內政部大小的自製清冊，用來量時間 |
| `testdata/` | 自製的小清冊、測試發證金鑰的公鑰、`expected.json`（每份可不可用、樹根） |

## 測試

```sh
go test ./crl/...
```

- `spec/vectors/poseidon2-constants.json`：常數、置換；`spec/vectors/poseidon2.json`：`hash_2`、`hash_3`、`scoped_id`、`revocation_tree`（樹根和每一份證明）。
- 樹和規格裡的遞迴定義（測試裡另寫一份慢的）在亂數的樹上比對；每份證明用電路的檢查方式（`assert_not_in_tree`）重算回樹根。
- Poseidon2 另有一份 `math/big` 寫的慢版本（`poseidon2/reference_test.go`），兩份互相比對。
- `testdata/` 的每份自製清冊：可不可用、原因、樹根、清冊日期等。

### 重新產生自製清冊

```sh
go run ./crl/testdata/generate.go
```

每次產生新的金鑰和簽章，所以每個檔案都會變；私鑰不保留。產生後，`expected.json` 的樹根要拿另一份獨立的實作（例如電路程式庫裡的參考樹加 Barretenberg 的 Poseidon2）重算比對，再提交。

## 第三方套件

- `github.com/consensys/gnark-crypto`：只用 BN254 純量體的運算（`ecc/bn254/fr`），不用它的 Poseidon2。用 `math/big` 寫的版本每次雜湊約 130 µs，G2 建樹推算要 110 秒左右；用 `fr` 約 12 µs，實測 10 秒。
- `golang.org/x/crypto/cryptobyte`：讀 DER。序號要讀原始的內容位元組，`crypto/x509` 的 `ParseRevocationList` 只給 `big.Int`，分不出負數、非最短編碼和長度。

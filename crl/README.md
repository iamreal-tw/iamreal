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
   | `crl_number` | 清冊編號（`cRLNumber`），十進位；沒有這個延伸欄位、它不是非負整數、超過 20 個內容位元組、或清冊的延伸欄位超過 16 個時是 `-` |
   | `this_update`、`next_update` | 清冊的 `thisUpdate`、`nextUpdate`（UTC） |
   | `crl_date` | 清冊日期：`thisUpdate` 換成台灣日期（UTC+8） |
   | `sha256` | 整個檔案的 SHA-256 |
   | `entries` | 廢止的筆數（同一個序號列兩次算兩筆） |
   | `usable` | 照規格「Which CRLs」可不可用 |
   | `reason` | 不可用時的原因代碼（下表） |
   | `root` | 可用時的樹根，64 個小寫十六進位數字（大端序），和紀錄的 `smt_root` 同一種寫法 |
   | `keys` | 樹裡的鍵數（同一個序號列兩次算一個鍵） |

3. 拿 `root` 和紀錄的 `smt_root` 比對。紀錄的日期要落在清冊日期的前 1 天到後 3 天之間，樹根才被承認（規格「Which roots a record may use」）。

清冊不可用時印出 `usable no` 和原因代碼，說明印在標準錯誤，結束代碼是 1；不是 DER 的 `CertificateList` 也算不可用（只印 `sha256`）。其他錯誤（讀不到檔案、選項錯誤）是 2。

### 不可用的原因代碼

規格「Which CRLs」的每一條對應下面一個或幾個代碼，順序和規格「Archive index」的原因代碼表相同。存檔索引把它接在 `-` 後面寫在 `root` 欄位（例如 `-not_usable_signature`）。好幾條都不符合時，給檢查順序最前面的那一個：

| 順序 | 代碼 | 意思 |
|---|---|---|
| 1 | `not_usable_der` | 不是 DER 的 `CertificateList`（多餘的位元組、非最短的長度、結構不對） |
| 2 | `not_usable_algorithm` | `tbsCertList` 裡或外面的簽章演算法不是 sha256WithRSAEncryption，或參數不是 NULL（包括省略） |
| 3 | `not_usable_signature` | 簽章在發證金鑰下驗不過（索引：兩把都驗不過） |
| 4 | `not_usable_too_many_extensions` | 清冊本身的延伸欄位超過 16 個 |
| 5 | `not_usable_duplicate_extension` | 清冊本身的同一個延伸欄位出現兩次 |
| 6 | `not_usable_critical_extension` | 清冊本身有關鍵延伸欄位，不論是哪一個（`authorityKeyIdentifier`、`cRLNumber` 標成關鍵也算） |
| 7 | `not_usable_delta` | 差異清冊（有 `deltaCRLIndicator`，關鍵與否都算；標成關鍵的先由第 6 列擋下） |
| 8 | `not_usable_partitioned` | 分段清冊（有 `issuingDistributionPoint`，關鍵與否都算；標成關鍵的先由第 6 列擋下）。第 7、8 列是同一步：兩個延伸欄位都有時，清冊裡排在前面的那一個決定代碼 |
| 9 | `not_usable_crl_number` | 沒有 `cRLNumber`，或它不是非負的 DER INTEGER，或超過 20 個內容位元組（前導的 `00` 也算；RFC 5280 5.2.3 的上限） |
| 10 | `not_usable_too_many_extensions`、`not_usable_duplicate_extension`、`not_usable_critical_extension` 或 `not_usable_serial` | 某一筆的延伸欄位超過 16 個、某一筆的延伸欄位出現兩次、某一筆有關鍵延伸欄位（不論是哪一個，所以帶關鍵 `certificateIssuer` 的間接清冊、`reasonCode` 標成關鍵的清冊都不可用）、或某一筆的序號不合格（空的、負數、不是最短編碼、超過 20 個內容位元組）。逐筆檢查，第一個有問題的那一筆決定代碼；同一筆裡照這個順序 |
| 11 | `not_usable_collision` | 兩個**不同**的鍵最低 127 位元相同。同一個序號列兩次算一個鍵，不算衝突 |

代碼在程式裡是 `crl.Reason…` 常數，清單是 `crl.Reasons`。

在 M1 Max 上，G3（約 17.6 萬筆）建樹約 5 秒、記憶體約 110 MB；G2（約 34 萬筆）約 10 秒、約 200 MB。這是一棵樹從頭算每一個雜湊（`crl.NewTree`）的時間。

### 重用雜湊

一份接一份處理同一把發證金鑰的清冊時（重建清冊存檔的索引），不必每一棵樹都從頭算（[#439](https://github.com/iamreal-tw/iamreal/issues/439)）。相鄰兩份清冊只差一兩百個序號，樹的絕大部分節點相同；一個節點的雜湊只由它底下有哪些鍵決定：葉子是 `Poseidon2(鍵, 1, 1)`，分支是 `Poseidon2(左子節點, 右子節點)`。

- `crl.TreeBuilder` 建一棵樹時，邊建邊對照它建的上一棵：葉子的鍵相同就拿上一棵的雜湊；分支在同一個位置、兩個子節點的雜湊都相同，就拿上一棵那個分支的雜湊；其餘照算。拿來用的值就是照算會得到的值，所以建出來的樹和 `crl.NewTree` 的逐個節點相同
- **重用的只有雜湊函式的結果**。每一份清冊照樣解析、照樣驗內政部的簽章、照樣做「Which CRLs」的每一項檢查、照樣算出自己的樹根
- 不留表：對照的是上一棵樹本身，所以一個建樹器手上只有上一棵樹，建幾棵都一樣。不寫磁碟，不跨執行
- `crl.Indexer` 替每把發證金鑰各留一個建樹器；`crl.BuildIndex`、`crl.RebuildArchive`（和 `iamreal-crl index`、`iamreal-verify`）用它。`crl.NewTree`、`crl.IndexFile` 不重用，留著當對照：測試拿每一份的結果和它們比（`reuse_test.go`）
- 順序不影響結果，只影響省多少：兩份清冊離得越遠，相同的節點越少。從網址讀時照索引的順序（同一把金鑰、照清冊編號），目錄照檔名的順序

2026-11-26 在 M1 Max 上對測試網站的 58 份（G2、G3 各 29 份）量到的：每把金鑰的第一份照舊（G2 11.2 秒、G3 5.7 秒，含解析、驗章和檢查），之後的每一份中位數 0.33 秒；58 份的索引合計 32.6 秒，原本 531 秒。

### 算「不在樹裡」的證明

```sh
./iamreal-crl prove -issuer G3 -serial 1234567890abcdef1234567890abcdef MOICA-G3-complete.crl
```

`-serial` 是憑證序號的內容位元組當成無號整數，用十六進位寫（可以有 `0x`，也可以是 `openssl` 印的冒號格式）。輸出是電路的輸入 `smt_root`、`smt_siblings`（128 個）、`smt_old_key`、`smt_old_value`、`smt_is_old0`。序號在清冊裡（被廢止）時沒有證明，結束代碼 2。

這個指令是給檢查和測試用的。持卡人的裝置自己建樹、自己算證明，不用這個指令，也不把序號交給任何人。

### 測試用的發證金鑰：`-key-g2`、`-key-g3`

`check`、`prove`、`index` 都可以加 `-key-g2 FILE`、`-key-g3 FILE`（各自可有可無）：給的檔案（公鑰或憑證，DER 或 PEM）代替內政部那一把發證金鑰，沒給的那一把仍是內政部的。`check`、`prove` 仍要給 `-issuer`，用的是那個發證者的金鑰（有代替的就用代替的）；`index` 用代替的金鑰驗過的行，`issuer` 照樣寫 `G2`、`G3`，所以索引的格式合規格。用到測試金鑰時，標準錯誤會印一行 `WARNING`。測試金鑰從來不是內政部的金鑰，這樣算出來的結果和內政部的清冊無關，只給測試用。

### 存檔索引

格式照規格「Archive index」。存檔是一個目錄：清冊檔案，加上索引 `index.jsonl`。

```sh
./iamreal-crl index DIR > DIR/index.jsonl
```

`index` 讀目錄裡的每個檔案（不讀子目錄、名字以 `.` 開頭的檔案和 `index.jsonl` 本身），用兩把發證金鑰試簽章，每個檔案印一行，可用或不可用都印：

```
{"issuer":"G3","crl_number":"2026111605","this_update":"2026-11-15T21:12:06Z","next_update":"2026-11-17T09:00:00Z","crl_date":"2026-11-16","sha256":"…","root":"…"}
{"issuer":"-","crl_number":"-","this_update":"-","next_update":"-","crl_date":"-","sha256":"…","root":"-not_usable_der"}
```

| 欄位 | 寫法 |
|---|---|
| `issuer` | 簽章驗得過的金鑰，`G2` 或 `G3`；兩把都驗不過時 `-`。這裡的「驗得過」只看 RSA 的 SHA-256 簽章本身，不看演算法欄位，所以演算法欄位不對、但簽章驗得過的清冊有 `issuer`，原因是 `not_usable_algorithm` |
| `crl_number` | `cRLNumber` 的十進位，沒有前導零；沒有、讀不懂、是負數、超過 20 個內容位元組、或清冊的延伸欄位超過 16 個時 `-` |
| `this_update`、`next_update` | UTC，`YYYY-MM-DDTHH:MM:SSZ`；沒有時（或整個檔案讀不懂時）`-` |
| `crl_date` | 清冊日期；整個檔案讀不懂時 `-` |
| `sha256` | 整個檔案的 SHA-256 |
| `root` | 可用時是樹根；不可用時是 `-` 接上面的原因代碼 |

排序：`issuer`（位元組順序，所以 `-` 在 `G2`、`G3` 前面），然後 `crl_number` 當數字（`-` 在所有數字前面），然後 `sha256`。內容相同的兩個檔案得到兩行相同的行。

有任何不可用的檔案時，索引照樣印完，每個不可用的檔案在標準錯誤印一行，結束代碼是 1。

`-key-g2`、`-key-g3` 讓測試金鑰代替內政部的金鑰（見上面）。

### 讀存檔：`crl.Archive`

`prooflog/` 的第 3 項檢查（樹根是否被承認）要問：「這把金鑰、這個樹根，有哪些可用清冊的日期？」`crl.Archive` 回答這個問題（`CRLDates(issuer, root)`，日期是 `YYYY-MM-DD` 字串；`crl/` 不引用 `verifier/`，換成 `verifier.Date` 在 `cmd/iamreal-verify` 做）。兩種開法：

- **`crl.RebuildArchive(DIR, 金鑰, …)`：完整重算。** 對目錄裡的每個檔案重新驗章、建樹，重建一份索引，和 `index.jsonl` 逐行比對（比的是整行，所以 `sha256`、`root`、日期都比到）。照規格「Re-verifying with the index」，**重建的索引才算數**：回傳的 `Archive` 是重建的索引的，每一個不同都一起回傳（`[]crl.IndexMismatch`），不會停在第一個。回報這些不同是呼叫的人的事（`cmd/iamreal-verify` 印在標準錯誤）。不同有這幾種：
  - **沒有 `index.jsonl`**，或它**沒辦法切成行**（最後沒有 LF、開頭有 BOM）：只算一個不同，不再逐行比對（不會把每個檔案都再報一次「索引沒列」）。
  - **寫法不合規格的行**（`crl.ParseIndex` 會拒絕的：樣板不對、欄位格式不對、樹根不小於 `p`……）：每一行算一個不同，附行號；這一行不拿來比對，所以它對應的檔案通常也會報成「索引沒列的檔案」。**順序錯的行**也附行號報一個不同，但這一行本身寫法沒錯，照樣拿來比對。
  - 寫法正確的行逐行比對後的三種不同，先照索引的順序、再照檔案的順序：索引列了但目錄裡沒有的檔案、索引沒列的檔案、同一個檔案（`sha256` 相同）的行不同。

  只有讀不到檔案時是錯誤。每把發證金鑰的第一份清冊約 5 到 11 秒；之後的每一份，照清冊編號的順序處理時量到約 0.3 秒，照檔名的順序（目錄）沒有量過，存檔越大能重用的越少（「重用雜湊」）。`crl.RebuildArchiveOf` 是同一件事，檔案一個一個給（`crl.ArchiveFile`）：讀一份、算出它那一行、放掉，再讀下一份，給不在磁碟上的存檔用。
- **`crl.ReadArchiveIndex(DIR)`：只信索引。** 只讀 `index.jsonl`，照規格檢查每一行（`crl.ParseIndex`）：固定的樣板、各欄位的格式、`crl_date` 等於 `this_update` 在台灣的日期、有樹根的行要有 `issuer`、`crl_number`、`this_update`，樹根要小於 BN254 純量體的模數 `p`、行的順序。樹根是不是那份清冊的、檔案本身，都沒有檢查。沒有 `index.jsonl`、或任何一行寫法不對，都是錯誤（`*crl.IndexError` 指出第一個有問題的行）：只信索引時沒有別的東西能代替它。

兩種都只用可用的行（`root` 是樹根的行）。同一個樹根可能對應好幾份清冊（兩份清冊之間沒有新的廢止時），每一份的日期都會回傳。

索引只是方便：重驗的人可以從檔案重建它，完整重算就是這樣做。

### 清冊差異檔：`crl.ApplyPatch`

規格「CRL patches」：從同一把發證金鑰的上一份可用清冊還原出這一份的檔，放在存檔目錄的子目錄 `patches/`（`crl.PatchesDir`），檔名 `<上一份的 SHA-256>-<這一份的 SHA-256>.patch`（`crl.PatchName`）。它不是清冊存檔的一部分：`crl.BuildIndex`、`crl.RebuildArchive` 跳過子目錄，本機的存檔不用有它。

- `crl.ApplyPatch(上一份, 差異檔)`：照兩種指令（複製上一份的一段、寫入接下來的位元組）還原，檔不合格式時回傳 `*crl.UnusablePatch`。複製只能往前、不重疊，所以時間和記憶體和兩個輸入的大小成正比。
- `crl.RestorePatch(上一份, 差異檔, SHA-256)`：再核對還原出來的 SHA-256 等於檔名的後半，不等也是 `*crl.UnusablePatch`。還原出來的只有這樣才算數，所以差異檔和做它的人都不用信。

`cmd/iamreal-verify` 從網址讀清冊存檔時用它（那邊的 README「下載」）。產生差異檔不在規格裡，這裡也沒有：鏡像（`worker/src/crl-patch.ts`）自己做。

## 檔案

| 檔案 | 內容 |
|---|---|
| `crl.go` | 解析 `CertificateList`（嚴格的 DER），`Check` 判斷可不可用並取出每個序號的鍵，原因代碼，清冊日期 |
| `index.go` | 存檔索引的一行（`IndexFile`）、整個目錄（`BuildIndex`）、排序、讀索引並檢查寫法（`ParseIndex`）、`Archive`（`RebuildArchive`、`ReadArchiveIndex`） |
| `key.go` | 鍵：序號內容位元組的無號大端值，最多 20 個位元組 |
| `patch.go` | 清冊差異檔：還原（`ApplyPatch`、`RestorePatch`）、檔名（`PatchName`） |
| `tree.go` | 樹（circomlib 的稀疏 Merkle 樹，Poseidon2）、樹根、「不在樹裡」的證明 |
| `issuers.go`、`MOICA2.cer`、`MOICA-G3.cer` | 兩把發證金鑰 |
| `poseidon2/` | Poseidon2（`spec/scoped-id.md`）。`constants.go` 由 `spec/vectors/poseidon2-constants.json` 產生（`go generate ./crl/poseidon2`） |
| `internal/crltest/` | 寫自製清冊的程式；`makecrl/` 寫一份內政部大小的自製清冊，用來量時間；`makelarge/` 寫下載上限 32 MiB 之內最壞的幾種檔，用來量讀一份的時間和記憶體（`worker/README.md`「清冊鏡像量到的」、`web/README.md`「讀清冊的記憶體」、`device-core/README.md`「讀清冊的記憶體」） |
| `testdata/` | 自製的小清冊、測試發證金鑰的公鑰、`expected.json`（每份可不可用、原因代碼、樹根）。`worker/`、`web/`、`device-core/` 的測試讀同一份 |
| `testdata/times/` | 時間用各種寫法寫的自製清冊，和 `expected.json`（每份在存檔索引裡的那一行，照規格「Times」）。最後十六份不是時間：九份（`oid-*`）是延伸欄位的 OID（規格「Object identifiers」），七份是元素後面多了東西：`expected.json` 的格式只有這個目錄寫得出「不是 DER」，所以放在這裡。`worker/`、`web/`、`device-core/` 的測試讀同一份 |

## 測試

```sh
go test ./crl/...
```

- `spec/vectors/poseidon2-constants.json`：常數、置換；`spec/vectors/poseidon2.json`：`hash_2`、`hash_3`、`scoped_id`、`revocation_tree`（樹根和每一份證明）。
- 樹和規格裡的遞迴定義（測試裡另寫一份慢的）在亂數的樹上比對；每份證明用電路的檢查方式（`assert_not_in_tree`）重算回樹根。
- Poseidon2 另有一份 `math/big` 寫的慢版本（`poseidon2/reference_test.go`），兩份互相比對。
- `testdata/` 的每份自製清冊：可不可用、原因代碼、樹根、清冊日期等，以及它在存檔索引裡的那一行。原因代碼的順序也各有清冊，規格那張表每相鄰的兩步都有一份兩個原因同時成立的（[#218](https://github.com/iamreal-tw/iamreal/issues/218)；第 1、2 步的那一份在 `testdata/times/`：時間的寫法先於演算法）：演算法先於簽章、簽章先於延伸欄位太多、延伸欄位太多先於重複、重複先於關鍵、關鍵延伸欄位先於差異清冊和分段清冊、差異清冊和分段清冊同時有時排在前面的那一個決定、差異清冊或分段清冊先於清冊編號、清冊編號先於逐筆的檢查、清冊的延伸欄位先於逐筆的、逐筆的檢查先於撞號；同一筆裡延伸欄位太多先於重複、重複先於關鍵、關鍵先於序號；第一個有問題的那一筆決定。上限各有剛好在上限和超過一個的清冊：清冊編號 20 和 21 個位元組，清冊和一筆的延伸欄位 16 和 17 個。
- `testdata/times/` 的每份清冊：它在存檔索引裡的那一行。時間只收 RFC 5280 的兩種寫法（規格「Times」）：`Z` 結尾、有秒的 UTCTime（`YYMMDDHHMMSSZ`）和 GeneralizedTime（`YYYYMMDDHHMMSSZ`）；帶時差、沒有秒、有小數的，`thisUpdate`、`nextUpdate`、每一筆的 `revocationDate` 都一樣，整份是 `-not_usable_der`。也包括 `nextUpdate` 剛好是 `0001-01-01T00:00:00Z`（Go 的零值）時照樣寫出來。
- `testdata/times/` 的九份 `oid-*`：清冊或一筆多一個延伸欄位，它的 OID 裡一個數字是 2^31−1 和 2^31（第一個數字、後面的數字、一筆的延伸欄位各一對），或數字不是最短寫法、沒寫完、OID 是空的（[#227](https://github.com/iamreal-tw/iamreal/issues/227)）。2^31−1 的三份讀得懂（`-not_usable_signature`），其餘是 `-not_usable_der`。這條界線原本是 Go 的 `cryptobyte` 的，現在寫在規格「Object identifiers」，四份實作都照它
- `testdata/times/` 的 `extension-*`、`entry-then-null`、`entry-extensions-then-null`、`tbs-then-null` 七份：一個延伸欄位、一筆廢止、`tbsCertList` 裡比該有的多一個元素（或延伸欄位少了值），都是 `-not_usable_der`。逐個元素走、不先全部列出來的讀法（[#410](https://github.com/iamreal-tw/iamreal/issues/410)）也要認得多出來的東西
- `testdata/` 的 `entry-negative-then-entry-critical`、`entry-critical-then-entry-negative`、`entry-duplicate-then-entry-seventeen`：多筆廢止各有不同的問題時，由排在前面的那一筆決定
- `spec/vectors/crl-patch.json`：每個可用的差異檔還原出標準答案的檔、檔名相同；每個不可用的（複製超出上一份、往回複製、長度超出結尾、不是 `00`、`01` 開頭的指令、還原出來的 SHA-256 不是檔名）都被拒絕。TypeScript 的鏡像讀同一份（`worker/test/crl-patch.test.ts`）。
- 存檔索引：排序、每一種寫錯的行被拒絕（包括樹根不小於 `p`）、完整重算回報改過的樹根、多出來的檔案、少了的檔案、沒有索引、沒辦法切成行的索引、寫法不對和順序錯的行（附行號），每一個不同都回報，並照重建的索引回答；只信索引時照索引回答，索引不在或寫錯是錯誤。

### 重新產生自製清冊

```sh
go run ./crl/testdata/generate.go
```

每次產生新的金鑰和簽章，所以每個檔案都會變；私鑰不保留。產生後，`expected.json` 的樹根要拿另一份獨立的實作（例如電路程式庫裡的參考樹加 Barretenberg 的 Poseidon2）重算比對，再提交。

`testdata/times/` 另外產生：

```sh
go run ./crl/testdata/times/generate.go
```

每一份該得到的那一行手寫在 `generate.go` 裡，照規格「Times」；`crl/` 算出來的不同，它就停下來、不寫檔。簽章用一把當場產生、沒有人信任的金鑰（私鑰不保留），所以這些檔沒有一份可用：讀得懂的是 `-not_usable_signature`，時間寫法不收的是 `-not_usable_der`。這裡檢查的只有時間怎麼讀、怎麼寫。

## 第三方套件

- `github.com/consensys/gnark-crypto`：只用 BN254 純量體的運算（`ecc/bn254/fr`），不用它的 Poseidon2。用 `math/big` 寫的版本每次雜湊約 130 µs，G2 建樹推算要 110 秒左右；用 `fr` 約 12 µs，實測 10 秒。
- `golang.org/x/crypto/cryptobyte`：讀 DER。序號要讀原始的內容位元組，`crypto/x509` 的 `ParseRevocationList` 只給 `big.Int`，分不出負數、非最短編碼和長度。

# circuits/：電路的原始碼

過卡時算證明的電路，用 Noir 寫，用 Barretenberg 的 UltraHonk 算證明和驗證。每次過卡算一份證明（ADR-0013）；發證金鑰有 2048 和 4096 位元兩種，各編一份電路。PSE 的 circom 電路留作對照，同一批測試案例兩邊逐案比對（ADR-0012）。放在這個程式庫的理由在 ADR-0038。

這個目錄讓人檢查三件事：

1. **電路檢查了什麼**：讀 `lib/` 的原始碼，對照下面「電路檢查哪些事」。
2. **網頁和 app 用的電路、後台和重驗的人用的驗證金鑰，就是從這份原始碼編出來的**：跑 `./rebuild.sh`，重編出的電路檔和 `web/circuits/`、驗證金鑰和 `verifier/vk/` 逐位元組相同。
3. **電路的行為和 PSE 的 circom 電路相同**，有意的差異各有 ADR：跑逐案比對，看每個案例在 Noir 和 circom 兩邊的結果。

**這份電路沒有經過人工稽核，上線前也不會有。** 做過的 AI 輔助檢查：查了什麼、找到什麼、改了哪些、哪些還沒有重新檢查，見 [`REVIEW.md`](REVIEW.md)。

原始碼從先前一個私有的程式庫搬來（提交 `497b610c64a3e598ccc769f39e886d1d5ca889ed`），不帶歷史（ADR-0038）。搬檔的是兩個提交，裡面每個檔都和 `497b610` 的對應檔逐位元組相同：第一個是電路、測試和逐案比對，第二個是隨機差異測試的程式（`fuzz/`）和兩張結果表（`results/`）。四個檔不在這兩個提交裡，因為它們寫著原本那台電腦上的路徑，改過才放進來：這份 `README.md`（改寫）、`fuzz/README.md`（改寫）、`fuzz/lib/common.mjs` 和 `fuzz/campaign.sh`（只改了那幾行）。改寫和整理都在後面的提交。測試和逐案比對用的都是自製的金鑰和憑證，沒有任何真實憑證的內容，不需要讀卡機或卡片。

## 目錄

| 路徑 | 內容 |
|---|---|
| `card_proof_rs2048/`、`card_proof_rs4096/` | **要上線的兩份電路**，只有進入點，內容全在 `lib/` |
| `lib/src/lib.nr` | `card_proof`：把下面各部分接起來。這一層沒有 circom 的對照 |
| `lib/src/certificate.nr` | 憑證的部分：發證金鑰的簽章、憑證的結構、廢止清冊 |
| `lib/src/der.nr` | 從憑證開頭照 DER 結構走：版本、序號、簽章演算法、發證者、效期、主體、公鑰、金鑰用途、正卡。所有位置由結構決定 |
| `lib/src/signature.nr` | 卡片的兩次簽章：種類檢查、驗章、匿名編號、打包 |
| `lib/src/rsa.nr` | RSA PKCS#1 v1.5 SHA-256 驗章，並要求簽章小於模數 |
| `lib/src/smt.nr` | 序號不在廢止清冊的雜湊樹裡（circomlib 的樹狀結構） |
| `lib/src/hash.nr` | Poseidon2 |
| `comparison/` | **只為了逐案比對**：把各部分包成 circom 電路的形狀。見裡面的 `README.md` |
| `tests/` | 電路的測試和逐案比對，見下面「測試」 |
| `tests/probes/` | **只為了測試**：把單一個函式包成電路，見裡面的 `README.md` |
| `tests/counterfactual/` | 反事實測試：在電路的副本裡拿掉一行檢查，確認對應的測試會失敗 |
| `tests/vectors/make-poseidon2.mjs` | 產生 `spec/vectors/poseidon2.json`（Poseidon2 的標準答案） |
| `fuzz/` | 隨機差異測試，手動跑。見裡面的 `README.md` |
| `results/equivalence.md` | 逐案比對表：每一案在三個電路的結果，有意的差異和對應的 ADR，開頭寫怎麼判斷「行為相同」 |
| `results/counterfactual.md` | 反事實測試 2026-11-16 那次的結果 |
| `REVIEW.md` | AI 輔助檢查的摘要 |
| `rebuild.sh` | **重建並比對**：見下面 |
| `fetch-nargo.sh`、`nargo.sha256` | 下載釘住的 `nargo`，核對 SHA-256 |
| `sha256.sh` | 這裡的腳本算 SHA-256 都用它 |
| `find-bb.sh`、`bb.sha256` | 找到 `@aztec-foundation/bb.js` 附的 `bb`，核對 SHA-256 |
| `build-circom.sh`、`zkid-commit` | 建逐案比對用的 circom 見證產生器，從 `zkid-commit` 釘住的提交 |

## 電路檢查哪些事

| 檢查 | 位置 | 出處 |
|---|---|---|
| 憑證是 `issuer_modulus` 這把發證金鑰簽的 | `certificate.nr`、`rsa.nr` | ADR-0012 |
| 從憑證的第一個位元組開始，照結構一欄一欄走到主體目錄屬性為止；版本 v3，簽章演算法 sha256WithRSAEncryption；所有位置由結構決定，沒有一個由證明者提供。延伸欄位的兩個長度（外層的 `[3]` 和裡面的 `SEQUENCE`）不讀，主體目錄屬性之後的延伸欄位不看，所以電路接受的範圍比「合法的 DER」寬 | `der.nr` | ADR-0008、0009 |
| 憑證在 `current_time` 這個時間在效期內；只收年份小於 50 的 `UTCTime` | `der.nr` | ADR-0008 |
| 公鑰取自結構上的公鑰欄位，RSA 剛好 2048 位元（模數的最高位元是 1），指數 65537 | `der.nr` | ADR-0009、0010 |
| 金鑰用途是簽章，而且只有這一項 | `der.nr` | ADR-0010 |
| 國民的正卡：憑證政策、主體目錄屬性剛好是國民、沒有 `cardHolderRank` | `der.nr` | ADR-0011 |
| 序號不在廢止清冊的樹裡（樹根 `smt_root`） | `smt.nr` | ADR-0012 |
| 卡片用憑證裡的公鑰簽了場合字串：31 個位元組，第一個是小寫英文字母或 `S` | `signature.nr`、`lib.nr` | ADR-0002、0007、0013 |
| 匿名編號是那個簽章的雜湊；簽章只有一種寫法（每一段都在範圍內、整數小於模數），一張卡片在一個場合只有一個值 | `signature.nr`、`rsa.nr` | ADR-0002、0012 |
| 同一把公鑰簽了宣告碼：31 個位元組，第一個是 `S` 以外的大寫英文字母 | `signature.nr`、`lib.nr` | ADR-0002、0013 |

卡片的公鑰從憑證讀出來直接用來驗兩個簽章，不是輸入，也不出現在公開輸入裡。電路裡的 `nullifier` 就是名詞表的匿名編號（`scoped_id`）。

後台發的題目不是電路的輸入（ADR-0013）。宣告碼由題目算出、由卡片簽過，驗證的人用題目重算宣告碼、和證明的輸出比對，題目就靠這一步綁進證明。沒有重算宣告碼，就等於沒有檢查題目。

裝置給電路的輸入見 `spec/circuit-inputs.md`；公開輸入的順序、編碼和驗證的人要做的檢查見 `spec/proof-verification.md`。

## 工具和函式庫

| | 版本 | 從哪裡來、怎麼核對 |
|---|---|---|
| `nargo` | 1.0.0（`noirc` 1.0.0+275d3ab1a5c916c6ea73e8d6b943f685f574500c） | Noir 在 GitHub 的 release；`nargo.sha256` 寫了下載檔的路徑和 SHA-256，`fetch-nargo.sh` 照它下載和核對。只有 Apple 晶片的 macOS 和 x86-64 的 Linux |
| `bb` | 6.0.0 | `@aztec-foundation/bb.js` 6.0.0 附的原生執行檔，和 `web/` 用的同一個套件；`find-bb.sh` 照 `bb.sha256` 核對 |
| `@noir-lang/noir_js` | 1.0.0 | 測試用，和 `web/` 釘同一個版本（`package.json`、根目錄的 `pnpm-lock.yaml`） |
| `@aztec-foundation/bb.js` | 6.0.0 | 測試用（電路外的 Poseidon2）；`bb` 也從它來 |

電路引用的 Noir 函式庫（`lib/Nargo.toml` 用標籤寫，下表是標籤指到的提交）：

| 函式庫 | 標籤 | 提交 | 授權 |
|---|---|---|---|
| `zkpassport/noir_rsa` | v0.12.1 | `9aa85bd7228bd57e835e9add0d3edd3b19548310` | Apache-2.0（`LICENSE`） |
| `zkpassport/noir-bignum` | v0.11.0-1 | `d177cfb7959f2a0c93555ece9d6764521df1cca3` | Apache-2.0（`LICENSE`） |
| `noir-lang/sha256` | v0.3.0 | `9442e5b6856f98b2ec029882d7e90199ecff91ba` | 沒有 `LICENSE` 檔；`package.json` 宣告 MIT |
| `noir-lang/poseidon` | v0.3.0 | `0880c371e88e583d39515fd3f877538657ac41eb` | Apache-2.0（`LICENSE`）；只用 Poseidon2 |
| `zkpassport/sha512` | v0.2.0 | `e92ffb473f3264529a0793770f63a09946df50cc` | Apache-2.0（`LICENSE`；`package.json` 寫 MIT）。`noir_rsa` 引用，這裡的電路沒有用到 |
| `zac-williamson/sha1` | v0.11 | `d510f33c8546488286946ed459b26b62f5a71f91` | Apache-2.0（`LICENSE`）。`noir_rsa` 引用，這裡的電路沒有用到 |

`nargo` 第一次編譯時把函式庫抓到 `~/nargo`，設 `NARGO_HOME` 沒有作用。用完可以刪掉。

### 授權

這個目錄照這個程式庫的 Apache-2.0。`tests/lib/cert.mjs` 和 `tests/cases.mjs` 照 PSE zkID 的 circom 測試（`wallet-unit-poc/circom/tests/`，MIT 授權，Copyright (c) 2026 Ethereum Foundation）改寫：憑證的做法照它的 `testCert.ts`，案例照它每一個測試檔，換成自製的金鑰和憑證。兩個檔的開頭也寫了出處和授權。

## 重建並比對

在這個目錄：

```
pnpm install       # 在程式庫的根目錄跑也可以；bb 和測試用的套件
./rebuild.sh
```

`rebuild.sh` 做的事：

1. `fetch-nargo.sh` 下載 `nargo` 到 `.tools/`，SHA-256 和 `nargo.sha256` 不同就停下來；`find-bb.sh` 找到 `bb`，SHA-256 和 `bb.sha256` 不同就停下來
2. 用 `nargo compile` 編 `card_proof_rs2048`、`card_proof_rs4096`
3. 用 `web/scripts/strip-circuit.mjs` 只留 `noir_version`、`abi`、`bytecode`（`web/circuits/README.md`），和 `web/circuits/` 的檔逐位元組比對
4. 用 `bb write_vk -t noir-recursive` 從重編的電路寫出驗證金鑰，和 `verifier/vk/` 的檔逐位元組比對

比的是提交進來的檔本身，不是 README 裡的雜湊表。每個檔都比；對不上的，印出檔名、提交的檔的 SHA-256（expected）和重編的 SHA-256（actual），結束碼是 1。全部相同時印：

```
same: web/circuits/card_proof_rs2048.json (sha256 8bd668a500df0109111e91ecac6c14554d2d9875b13cf8b9edf7bc194bf73de5)
same: verifier/vk/card_proof_rs2048.vk (sha256 816406c75c5422cefab5acd70276f3dc8ce5d269736aefd9795e230569bd3ac8)
same: web/circuits/card_proof_rs4096.json (sha256 9ee2aa5001acf3b7f78c09d8a7d1d68e13948073b7fcadea6fc6ab0596a6705a)
same: verifier/vk/card_proof_rs4096.vk (sha256 bed43ed823a5273292150785bce9a24a24162711a25e8c3a4337a61bdc9f38c2)
rebuild: the two circuits and the two verification keys are the committed ones
```

`bb` 第一次執行時把通用參數下載到 `.crs/`。換 `nargo` 或 `bb` 的版本之後，這個指令說出電路檔和驗證金鑰有沒有變；變了就是名額重來（ADR-0012）。

## 測試

```
pnpm install
"$(./fetch-nargo.sh)" compile --workspace   # 全部電路（正式的、比對用的、測試用的），編到 target/
"$(./fetch-nargo.sh)" test --workspace      # Noir 的單元測試（公鑰承諾值，比對用）
./build-circom.sh                            # 逐案比對的 circom 那一欄，見下面
pnpm test                                    # 全部的 JavaScript 測試，含逐案比對
```

`pnpm test` 跑的：

- `tests/equivalence.test.mjs`：**逐案比對**。circom 的每一個測試案例（`tests/cases.mjs`，改用自製的金鑰和憑證），加上這裡新增的案例，同一份位元組同時餵給三個電路：`comparison/` 裡同形狀的部分、正式的電路（其餘部分照實）、circom 的電路。三者要和預期的接受或拒絕相同，有意的差異除外。結果寫到 `out/equivalence.md`；提交的紀錄是 `results/equivalence.md`，表的開頭說明每一欄、每一種差異，和「行為相同」是拿整份證明的判斷來比（circom 那邊是三份證明合起來）。現在是 110 案：29 案是有意的差異（種類檢查，ADR-0013），1 案是單一部分的差異（`part-level difference`，見下面「和 circom 電路不同的地方」），其他 0 案不同。
- `tests/card_proof.test.mjs`：逐案比對做不到的部分。兩個簽章是不是用憑證裡的公鑰驗的、兩段字能不能互換、換一個題目算出的宣告碼（卡片沒有重簽）會被拒絕、種類的邊界字元、同一個簽章換一種分段、不到 2048 位元的卡片金鑰、有內容的廢止清冊、電路的輸出和電路外算的雜湊相同。
- `tests/vectors.test.mjs`：讀 `spec/vectors/poseidon2.json`，和 Go、TypeScript、Rust 的實作讀同一份。其他測試的預期值都是執行時用 bb.js 算的，函式庫改了雜湊的包法時電路和 bb.js 可能一起變，那些測試看不出來；這裡的值寫死在檔案裡，電路和 bb.js 都要算出同一個值。`node tests/vectors/make-poseidon2.mjs` 用 bb.js 重新寫出這個檔；檔案有任何變動，都代表雜湊變了。
- `tests/library-guarantees.test.mjs`：**函式庫保證的測試**。電路有幾項保證靠函式庫裡的某一行成立（`REVIEW.md`「找到的問題」第 4 項），每一項一個「那一行不見就會失敗」的測試。檔案開頭列了每個測試對應哪一行。

### circom 的見證產生器

逐案比對的 circom 那一欄要 circom 電路的見證產生器。`./build-circom.sh` 從 `https://github.com/iamreal-tw/zkID`（PSE zkID 的 fork）只抓 `zkid-commit` 那一個提交（不帶歷史），在暫存目錄照它 `wallet-unit-poc/circom/README.md` 跑 `yarn install`（照 `yarn.lock`，不跑安裝腳本）和 `yarn compile:all`，再只把測試和 `fuzz/` 讀的檔（每份電路的 `.wasm` 和 `witness_calculator.js`、`fuzz/` 要的一個 circom 原始檔）留在 `.zkID/`，約 20 MB；其餘的刪掉。要 git、PATH 上有 circom 2.2.3、corepack（Node 附的）。在 Apple M 系列的電腦上約 3 分鐘，建置時暫存目錄要約 4 GB 的空間。

測試預設找 `.zkID/wallet-unit-poc/circom/build`，可以用環境變數 `ZKID_CIRCOM_BUILD` 改。已經有一份建好的（例如另一個 worktree 的 `.zkID/`），用 `ZKID_CIRCOM_BUILD` 指過去就好，不用每個 worktree 各建一份。找不到時 circom 那一欄標 `not run`，Noir 的部分照跑。改電路後要重跑（ADR-0012）。

對照的對象：`zkid-commit` 是 fork 的 `primary-card` 分支，在 PSE 上游 `ethereum/zkID` 的 `RSA-X.509-Cert` 分支的 `97210baed65ed53d098a4e86fb551caf1c844b4e` 之上多 7 個提交（`git log 97210ba..e95abdf`）：憑證電路加了效期、公鑰位置由結構推導、金鑰用途、正卡、卡片金鑰剛好 2048 位元的檢查（ADR-0008 到 0011），各有新的 circom 測試；一個 AI 檢查之後的加強；一個把 `currentTime` 接到輸入產生器、證明程式和網頁。逐案比對跑這個提交上每一個 circom 測試的案例。

### 反事實測試

不在 `pnpm test` 裡，CI 也不跑。對「函式庫保證的測試」的每一項，在電路的副本裡把那一行拿掉、重編，確認對應的測試失敗、不相干的測試照過，驗證金鑰也照預期變或不變：

```
"$(./fetch-nargo.sh)" compile --workspace    # 先編過一次，nargo 才會把函式庫抓到 ~/nargo
node tests/counterfactual/run.mjs             # 全部；後面接名稱只跑那幾個
```

副本建在系統的暫存目錄，跑完刪掉（`KEEP=1` 留著）；結果寫到 `out/counterfactual/result.md`，2026-11-16 那次的結果是 `results/counterfactual.md`。約 4 分鐘。

### 隨機差異測試

不在 `pnpm test` 裡，CI 也不跑。大量隨機產生的憑證和簽章同時餵給 Noir 和 circom 的電路，再和一份照 ADR 寫的參考判斷比對；程式、怎麼跑、怎麼判斷一案在 [`fuzz/README.md`](fuzz/README.md)。

## 升級工具或函式庫之前

函式庫的版本是釘死的；電路的幾項保證靠函式庫裡特定的幾行，升級時那幾行可能不見而沒有任何錯誤。換任何一個版本之前和之後都要做：

1. `pnpm test`，特別是 `tests/library-guarantees.test.mjs` 和 `tests/vectors.test.mjs`（這個不過，代表匿名編號和廢止清冊的樹根全部換了）。
2. `node tests/counterfactual/run.mjs`。升級後函式庫的原始碼變了，腳本裡要拿掉的那幾行文字要跟著對過；找不到就會停下來。
3. 含 circom 的逐案比對，`out/equivalence.md` 和 `results/equivalence.md` 比，差異有變就查原因；更新紀錄就把它複製過去。
4. 隨機差異測試（`fuzz/`），至少一萬筆。
5. `./rebuild.sh`。驗證金鑰變了，就是名額重來（ADR-0012）。

## 和 circom 電路不同的地方

- **一份證明，不是三份**（ADR-0013）。circom 拆成憑證一份、簽章兩份，用公鑰承諾值連起來；這裡卡片的公鑰在電路裡直接共用，沒有承諾值，也沒有 `pk_blind`。
- **沒有題目的輸入**（ADR-0013）。circom 的簽章電路有一個公開輸入 `challenge`，只用一個恆真的平方式引用它，不限制任何值。這裡拿掉了，題目只透過宣告碼綁定。
- **種類檢查**（ADR-0013）：場合字串的第一個位元組必須是小寫英文字母或 `S`，宣告碼必須是 `S` 以外的大寫英文字母。circom 是同一份簽章電路跑兩次，沒有這項檢查。逐案比對表裡標成 `intended difference`。
- 輸入是原始的憑證內容和長度，SHA-256 的補齊在電路裡做。長度以後的位元組不影響結果，所以電路要求走到的最後一個位元組在長度以內。
- 序號由電路自己讀，不是輸入。
- 卡片簽的字直接是 31 個位元組的輸入，不是補齊後的 1536 個位元組。
- 大數用 120 位元一段（circom 是 121 位元）。
- **卡片金鑰剛好 2048 位元在哪裡檢查。** 兩邊的憑證部分都要求模數的第一個位元組不小於 `0x80`。此外，這裡的簽章部分自己也會拒絕不到 2048 位元的金鑰（函式庫建立金鑰參數時檢查）；circom 的簽章電路不看金鑰長度，靠憑證電路和公鑰承諾值。所以單獨比簽章部分時兩邊不同（單一部分的差異，逐案比對表裡標成 `part-level difference`），整份證明（circom 是三份證明合起來）的結果相同。
- 多兩組私有輸入 `issuer_redc`、`card_redc`，是函式庫算模數乘法用的輔助值。
- 雜湊是 BN254 純量體上的 Poseidon2，所以匿名編號、廢止清冊的樹根都和 circom 的版本不同。

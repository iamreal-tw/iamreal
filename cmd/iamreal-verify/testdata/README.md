# 端到端測試的資料

一份測試名冊，三筆紀錄都帶真的證明，加上一個廢止清冊的存檔，給 `archive_test.go` 和 `e2e_test.go` 用。發證金鑰和卡片金鑰都是當場產生的拋棄式金鑰，私鑰沒有留下；憑證和清冊是合成的。**沒有任何真實憑證或清冊的內容。** 兩把發證金鑰只在測試裡注入（存檔經由 `archive_test.go` 的 `testIssuerKeys`，驗證器經由 `verifier.NewWithIssuers`），正式的執行檔不認得它們。

| 檔案 | 內容 |
|---|---|
| `archive/` | 存檔：三份清冊和索引 `index.jsonl` |
| `issuer-G2.der`、`issuer-G3.der` | 兩把測試用發證金鑰的公鑰（SubjectPublicKeyInfo）。同一把金鑰簽卡片的憑證和清冊，和內政部一樣 |
| `roster.jsonl` | 測試名冊（場合 `iamreal-test:public:0__________`） |
| `circuits-commit` | 產生測試資料時電路原始碼的提交；提交的這一份記的是先前私有程式庫的 `497b610…`，在這個程式庫查不到（見「怎麼產生的」） |
| `generate.go`、`make-proofs.mjs` | 產生上面這些檔案的程式 |

## 存檔

| 檔案 | 金鑰 | 清冊編號 | `thisUpdate`（UTC） | 清冊日期 | 廢止的序號 |
|---|---|---|---|---|---|
| A `G2-2026111605.crl` | G2 | 2026111605 | 2026-11-15 21:12:06 | 2026-11-16 | 200 個 |
| B `G3-2026112005.crl` | G3 | 2026112005 | 2026-11-19 21:11:40 | 2026-11-20 | 150 個 |
| C `G3-2026112105.crl` | G3 | 2026112105 | 2026-11-20 21:12:15 | 2026-11-21 | 和 B 相同 |

B 和 C 廢止的序號相同，所以樹根相同（兩份清冊之間沒有新的廢止）。清冊用 Go 的 `x509.CreateRevocationList` 簽，結構和內政部的相同：版本 2、sha256WithRSAEncryption（參數 NULL）、`authorityKeyIdentifier` 和 `cRLNumber`、每一筆一個 `reasonCode`。

## 名冊

| `seq` | 電路 | `issuer` | 帳號清單 | 日期 | 樹根 | 承認它的清冊 |
|---|---|---|---|---|---|---|
| 1 | `card_proof_rs2048` | `G2` | `threads:alice` | 2026-11-16 | A | A |
| 2 | `card_proof_rs4096` | `G3` | `test-example:a-b`、`threads:alice` | 2026-11-21 | B（= C） | B、C |
| 3 | `card_proof_rs4096` | `G3` | `threads:alice` | 2026-11-24 | B（= C） | 只有 C（B 的日期加 3 天是 11-23） |

兩張卡片，每把發證金鑰一張，序號都不在清冊裡。三筆都有效：`threads first`；`test-example first, threads first`；`test-example withdraw, threads refresh`（第 3 筆的清單沒有 `test-example` 的帳號，就是收回它）。拿掉 C 時第 3 筆變成 `root`，拿掉 A 時第 1 筆變成 `root`，拿掉 B 時三筆仍然有效。

## 怎麼產生的

需要 `circuits/` 的測試程式（`tests/lib/`）和公布的電路檔（`web/circuits/`，`circuits/rebuild.sh` 從原始碼重編、逐位元組比對的那兩個檔）、`bb` 6.0.0、放 2^18 個點 `bn254_g1.dat` 的通用參數目錄（`bb prove` 要用）。在程式庫的根目錄：

```
pnpm install
bb=$(circuits/find-bb.sh)
go run ./cmd/iamreal-verify/testdata/generate.go -bb "$bb" -crs <通用參數目錄>
```

`circuits/find-bb.sh` 印出 `@aztec-foundation/bb.js` 6.0.0 附的 `bb`，印之前核對過 SHA-256；核對不過時它說明原因、什麼都不印，產生器拿到空的 `bb` 就停下來，不寫任何檔。`generate.go` 產生兩把發證金鑰，簽三份清冊，寫出索引；把私鑰、每筆紀錄的帳號清單和要用的序號交給 `make-proofs.mjs`（放在暫存目錄，結束時刪掉）。`make-proofs.mjs` 自己照 `spec/declaration-code.md` 算宣告碼（`circuits/tests/lib/declaration-code.mjs` 是更早的草稿，不用它），`generate.go` 再確認和 `verifier.DeclarationCode` 算出的相同。`make-proofs.mjs` 用 `circuits/tests/lib/` 做卡片的憑證、用它的參考樹從序號自己建樹、算證明，和 `verifier/testdata/make-proofs.mjs` 同樣的做法，不寫任何東西到 `circuits/`、`web/circuits/` 裡；它要求這兩個目錄沒有未提交的修改，`circuits-commit` 記的是當時這個程式庫的提交。`generate.go` 再確認 `circuits/` 的參考樹和 `crl/` 算出的樹根相同，組成名冊，確認每一行都是測試名冊裡格式正確的紀錄。

提交的這一份是電路的原始碼搬進 `circuits/` 之前做的，`circuits-commit` 寫的是先前私有程式庫的 `497b610c64a3e598ccc769f39e886d1d5ca889ed`。搬進 `circuits/` 時原始碼相同（ADR-0038），電路檔和驗證金鑰都沒變，所以沒有重新產生。

每次執行的金鑰、題目和證明都不同，測試照樣通過。

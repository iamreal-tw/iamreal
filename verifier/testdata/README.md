# 真的證明（測試用）

兩份真的證明，一個電路一份，給 `proof_test.go` 測 `bb verify` 那一層。發證金鑰和卡片金鑰都是當場產生的拋棄式金鑰，私鑰沒有留下；憑證是合成的。**沒有任何真實憑證的內容。** 這兩把發證金鑰只在測試裡經由 `export_test.go` 注入，正式的執行檔不認得它們。

| 檔案 | 內容 |
|---|---|
| `proofs.json` | 產生測試資料時電路原始碼的提交（`circuits_commit`；提交的這一份記的是先前的私有程式庫的 `497b610…`，在這個程式庫查不到，見「怎麼產生的」）、場合字串、廢止清冊的樹根，和每一筆紀錄的欄位（帳號清單、題目）、宣告碼、測試用發證金鑰的模數、電路算出的匿名編號（`nullifier`，大端序） |
| `card_proof_rs2048.proof`、`card_proof_rs4096.proof` | 零知識的證明（`-t noir-recursive`），各 14,656 個位元組 |
| `card_proof_rs2048.public_inputs`、`card_proof_rs4096.public_inputs` | `bb prove` 寫出的公開輸入（736、1,280 個位元組）。測試只拿它和驗證器自己重建的公開輸入比對，驗證時不用它 |
| `card_proof_rs2048.no-zk.proof`、`card_proof_rs4096.no-zk.proof` | 同一份見證用 `-t noir-recursive-no-zk` 做的非零知識證明，各 13,120 個位元組 |
| `make-proofs.mjs` | 產生上面這些檔案的程式 |

兩筆紀錄合起來是一份測試的證明紀錄，兩筆都有效：

| `seq` | 電路 | `issuer` | 帳號清單 | `challenge` | 種類 |
|---|---|---|---|---|---|
| 1 | `card_proof_rs2048` | `G2` | `test-example:a-b`、`threads:alice` | `2026-11-16.000G40R40M30E209185GR38E1W` | `test-example first`、`threads first` |
| 2 | `card_proof_rs4096` | `G3` | `threads:alice` | `2027-01-01.BQC3JFKB1AYNR9ZE3YV4H4AYRR` | `test-example withdraw`、`threads refresh` |

場合字串是測試的證明紀錄的 `iamreal-test:public:0__________`。第 1 筆的宣告碼 `DV554WVTAP1A8KY9C02H8BKS4R6X1D6` 和 `spec/vectors/declaration-code.json` 的「two accounts, test scope」相同。同一張卡片、同一張憑證（2026-01-01 到 2031-01-01 有效），廢止清冊的樹有 200 個序號。

## 怎麼產生的

用 `circuits/` 的測試程式（`tests/lib/`）和公布的電路檔（`web/circuits/`，`circuits/rebuild.sh` 從原始碼重編、逐位元組比對的那兩個檔），`bb` 6.0.0。在程式庫的根目錄：

```
pnpm install
bb=$(circuits/find-bb.sh)
node verifier/testdata/make-proofs.mjs "$bb" <通用參數目錄> verifier/testdata
```

`circuits/find-bb.sh` 印出 `@aztec-foundation/bb.js` 6.0.0 附的 `bb`，印之前核對過 SHA-256；核對不過時它說明原因、什麼都不印，產生器拿到空的 `bb` 就停下來，不寫任何檔。宣告碼由 `make-proofs.mjs` 自己照 `spec/declaration-code.md` 算（`circuits/tests/lib/declaration-code.mjs` 是更早的草稿，不用它）；`proof_test.go` 再確認和 `verifier.DeclarationCode` 相同。`make-proofs.mjs` 不寫任何東西到 `circuits/`、`web/circuits/` 裡。它要求這兩個目錄沒有未提交的修改，在 `circuits_commit` 記下當時這個程式庫的提交，並檢查兩種設定寫出的驗證金鑰都等於 `spec/record.md` 的 SHA-256。`bb prove` 需要 2^18 個點的通用參數（第一次執行時 `bb` 會下載到指定的目錄）。

提交的這一份是電路的原始碼搬進 `circuits/` 之前做的，`circuits_commit` 寫的是先前的私有程式庫的 `497b610c64a3e598ccc769f39e886d1d5ca889ed`。搬進 `circuits/` 時原始碼相同（ADR-0038），電路檔和驗證金鑰都沒變，所以沒有重新產生。

每次執行的金鑰都不同，所以重新產生會得到不同的證明和 `proofs.json`，測試照樣通過。

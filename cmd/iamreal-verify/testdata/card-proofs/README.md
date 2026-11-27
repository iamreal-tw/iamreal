# 用真的證明走完整條路的測試資料

給 `worker/test/records-real.test.ts` 用（Go 的舊後台刪掉之前是它的 `e2e_test.go`）：廢止清冊、十四次過卡的請求，每一次都帶真的證明。發證金鑰和卡片金鑰都是當場產生的拋棄式金鑰，私鑰沒有留下；憑證和清冊是合成的。**沒有任何真實憑證或清冊的內容。** 兩把發證金鑰只在測試裡注入：Worker 的測試建置（`worker/test/build.ts`）、重驗指令經由 `verifier.NewWithIssuers`（只在建置標籤 `iamrealtest` 下存在）；部署的 Worker 和正式的執行檔不認得它們。

| 檔案 | 內容 |
|---|---|
| `crl/` | 三份清冊，測試由假的內政部伺服器提供給鏡像 |
| `issuer-G2.der`、`issuer-G3.der` | 兩把測試用發證金鑰的公鑰（SubjectPublicKeyInfo）。同一把金鑰簽卡片的憑證和清冊 |
| `card-proofs.json` | 十四次過卡：後台的時鐘（台灣時間）、題目的 16 個亂數位元組、送出的內容（`POST /api/v1/records` 的請求，帶整份帳號清單）、預期的回應（成功時每個平台的種類，失敗時錯誤代碼） |
| `circuits-commit` | 產生測試資料時電路原始碼的提交；提交的這一份記的是先前的私有程式庫的 `497b610…`，在這個程式庫查不到（見「怎麼產生的」） |
| `generate.go` | 產生上面這些檔案的程式 |

## 清冊

| 檔案 | 金鑰 | 清冊編號 | 清冊日期 | 什麼時候出現在假的內政部 |
|---|---|---|---|---|
| `A-G2.crl` | G2 | 2026112005 | 2026-11-20 | 一開始 |
| `B-G3.crl` | G3 | 2026112005 | 2026-11-20 | 一開始 |
| `C-G3.crl` | G3 | 2026112105 | 2026-11-21 | 2026-11-21 第一次過卡前，鏡像再抓一次 |

B 和 C 廢止的序號相同，所以樹根相同。兩張卡片的序號都不在清冊裡。

## 過卡

題目由後台發：測試把後台的亂數來源換成 `card-proofs.json` 裡的 16 個位元組，後台發出的題目就是證明當初用的那一個。

場合是測試的證明紀錄的 `iamreal-test:public:0__________`，平台有 `test-example` 和 `threads`。

| | 時間 | 卡片 | 帳號清單 | 回應 |
|---|---|---|---|---|
| 1 | 2026-11-20 10:00 | G2 的卡 | `threads:alice` | `201` `threads first` |
| 2 | 2026-11-20 10:05 | G3 的卡 | `test-example:a-b`、`threads:alice` | `201` `test-example first, threads first` |
| 3 | 2026-11-20 10:20 | G3 的卡 | `test-example:a-b`、`threads:alice_` | `201` `test-example refresh, threads switch`（`threads` 第 1 次：當天才宣告的帳號當天換掉，也算一次更換） |
| 4 | 2026-11-21 09:00 | G3 的卡 | `test-example:a-b`、`threads:bob` | `201` `test-example refresh, threads switch`（第 2 次） |
| 5 | 2026-11-21 09:30 | G3 的卡 | `test-example:c-d`、`threads:bob` | `201` `test-example switch, threads refresh` |
| 6 | 2026-11-22 09:00 | G3 的卡 | `test-example:c-d`、`threads:carol` | `201` `test-example refresh, threads switch`（第 3 次） |
| 7 | 2026-11-23 09:00 | G3 的卡 | `test-example:c-d`、`threads:dave` | `201` `test-example refresh, threads switch`（第 4 次） |
| 8 | 2026-11-23 10:00 | G2 的卡 | （空的清單） | `201` `threads withdraw` |
| 9 | 2026-11-23 10:30 | G2 的卡 | （空的清單） | `400` `empty`（這張卡片已經沒有帳號） |
| 10 | 2026-11-24 09:00 | G3 的卡 | `test-example:c-d`、`threads:erin` | `201` `test-example refresh, threads switch`（`threads` 第 5 次，最後一次） |
| 11 | 2026-11-24 09:30 | G3 的卡 | `test-example:c-d` | `201` `test-example refresh, threads withdraw` |
| 12 | 2026-11-24 11:00 | G3 的卡 | `test-example:c-d`、`threads:dave` | `400` `switch_limit`（證明驗得過；上一次宣告的是 `erin`，換成 `dave` 是第 6 次更換） |
| 13 | 2026-11-24 11:30 | G3 的卡 | （空的清單） | `201` `test-example withdraw`（`threads` 在第 11 次已經收回） |
| 14 | 2026-11-24 12:00 | G3 的卡 | `threads:dave` | `400` `switch_limit`（證明驗得過；同第 12 次。G3 的卡這一天已經寫入 3 筆，後台的 `daily_limit` 也會擋，但紀錄規則先套） |

G2 的卡的清冊 A 是 2026-11-20 的，所以 G2 的過卡都在 11-23 以前（之後後台會回 `crl_stale`）。

每一次預期 `201`、清單不是空的過卡，測試先送同一份證明配上別的清單：最後一個帳號的名稱改成 `carl`，`400` `proof`；兩個帳號時再送少一個帳號的（`proof`）和順序對調的（`malformed`）。題目仍然可以用，最後送原本的。

## 怎麼產生的

需要 `circuits/` 的測試程式（`tests/lib/`）和公布的電路檔（`web/circuits/`，`circuits/rebuild.sh` 從原始碼重編、逐位元組比對的那兩個檔）、`bb` 6.0.0、放 2^18 個點 `bn254_g1.dat` 的通用參數目錄（`bb prove` 要用）。在程式庫的根目錄：

```
pnpm install
bb=$(circuits/find-bb.sh)
go run ./cmd/iamreal-verify/testdata/card-proofs/generate.go -bb "$bb" -crs <通用參數目錄>
```

證明由 `cmd/iamreal-verify/testdata/make-proofs.mjs` 做（同一支程式，見那裡的 `README.md`；宣告碼由它照 `spec/declaration-code.md` 算），不寫任何東西到 `circuits/`、`web/circuits/` 裡。`generate.go` 確認 `circuits/` 的參考樹和 `crl/` 算出的樹根相同、`make-proofs.mjs` 的宣告碼和 `verifier.DeclarationCode` 相同，每一次過卡都是測試的證明紀錄裡格式正確的紀錄。全部約 25 秒（十四份證明）。

提交的這一份是電路的原始碼搬進 `circuits/` 之前做的，`circuits-commit` 寫的是先前的私有程式庫的 `497b610c64a3e598ccc769f39e886d1d5ca889ed`。搬進 `circuits/` 時原始碼相同（ADR-0038），電路檔和驗證金鑰都沒變，所以沒有重新產生。

每次執行的金鑰、題目和證明都不同，測試照樣通過。

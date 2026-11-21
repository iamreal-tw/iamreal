# comparison：只為了和 circom 電路逐案比對

**這個目錄不是要上線的電路。** 要上線的是根目錄的 `card_proof_rs2048`、`card_proof_rs4096`。

ADR-0012 規定電路的各個部分各自和 PSE 的 circom 電路逐案比對。circom 那邊把一次過卡拆成三份證明：`CertChainRSA256` 一份，`UserSigRSA256` 跑兩次，三份用公鑰承諾值連起來。這裡把正式電路的各個部分包成和 circom 相同的形狀，同一份位元組才能同時餵給兩邊。

## 內容

| 路徑 | 對照的 circom 電路 | 內容 |
|---|---|---|
| `lib/src/lib.nr` | | 下面四份電路共用的包裝，和公鑰承諾值 `pk_commit` |
| `cert_chain_rs2048/`、`cert_chain_rs4096/` | `certChainRS2048`、`certChainRS4096` | 正式電路的憑證部分（`valid_certificate`），輸出公鑰承諾值 |
| `user_sig_scope/` | `userSigRS2048`（簽場合字串那次） | 正式電路的場合字串簽章部分，輸出公鑰承諾值、匿名編號、場合字串 |
| `user_sig_code/` | `userSigRS2048`（簽宣告碼那次） | 正式電路的宣告碼簽章部分，輸出公鑰承諾值、宣告碼 |
| `lib/src/tests.nr` | `pk_commit.test.ts` | 公鑰承諾值的單元測試 |

檢查的邏輯全部呼叫正式電路的函式庫（`../lib/`）裡的同一批函式，這裡只多了承諾值。

## 為什麼留著公鑰承諾值和 `pk_blind`

正式的電路沒有承諾值（ADR-0013）。這裡留著，是因為 circom 的測試有兩個案例比的是承諾值：

- 憑證別處放一段假的公鑰開頭，承諾值要和沒放的時候相同（取到的是結構上的那把公鑰）。
- 三個部分的承諾值相同（三份是同一張卡片）。

兩邊用同一種輸出比較，這兩個案例才是同一件事的比對。承諾值只出現在這個目錄和比對的測試裡。

## 為什麼沒有題目的輸入

circom 的 `UserSigRSA256` 有一個公開輸入 `challenge`，只被一個平方式引用（`challengeSquared <== challenge * challenge`），不限制任何值，所以不管給什麼值，circom 接受或拒絕的結果都一樣。正式的電路沒有這個輸入（題目只透過宣告碼綁定，ADR-0013），這裡的兩份簽章電路也跟著拿掉，檢查和正式電路的對應部分完全相同。

circom 的測試「題目給任何值都接受」（`any value for the per-session challenge`）留在逐案比對裡：題目只餵給 circom，Noir 的兩欄照常跑同一份簽章。三欄都是接受，表上的備註寫明這件事。

## 卡片金鑰的長度

卡片金鑰剛好 2048 位元，兩邊的憑證部分都檢查（模數的第一個位元組不小於 `0x80`；`../lib/src/der.nr`，circom 的 `certChain.circom`）。簽章部分不一樣：這裡的 `user_sig_*` 建立金鑰參數時函式庫會再檢查一次，不到 2048 位元的金鑰直接拒絕；circom 的 `userSigRS2048` 不看金鑰長度，靠憑證電路和公鑰承諾值。所以「不到 2048 位元的金鑰的簽章」單獨餵給簽章部分時，Noir 拒絕、circom 接受；同一把金鑰的憑證兩邊都拒絕。逐案比對表把這一案標成 `part-level difference`，和同一把金鑰的憑證那一案放在一起看。

## 重跑

在根目錄：

```
nargo compile
nargo test --package comparison
node --test tests/equivalence.test.mjs
```

結果寫到 `out/equivalence.md`。每一案同時跑這裡的電路、正式的電路、circom 的電路；表的說明在檔案開頭。circom 那一欄需要它的見證產生器，見根目錄的 `README.md`。

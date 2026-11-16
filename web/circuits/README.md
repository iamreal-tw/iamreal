# web/circuits/：編譯好的電路

頁面算證明用的兩份電路。**電路的原始碼尚未公開。** 這裡只有編譯後的結果（ACIR bytecode 和輸入輸出的格式），讓頁面能算證明、讓人能核對頁面載入的就是這兩份。

| 檔案 | `issuer` | SHA-256（這裡的檔案） | 驗證金鑰的 SHA-256 |
|---|---|---|---|
| `card_proof_rs2048.json` | `G2` | `8bd668a500df0109111e91ecac6c14554d2d9875b13cf8b9edf7bc194bf73de5` | `816406c75c5422cefab5acd70276f3dc8ce5d269736aefd9795e230569bd3ac8` |
| `card_proof_rs4096.json` | `G3` | `9ee2aa5001acf3b7f78c09d8a7d1d68e13948073b7fcadea6fc6ab0596a6705a` | `bed43ed823a5273292150785bce9a24a24162711a25e8c3a4337a61bdc9f38c2` |

驗證金鑰的 SHA-256 和 `spec/proof-verification.md`、`spec/record.md`「Accepted circuits」、`verifier/vk/` 相同。頁面載入電路檔後先核對上表的 SHA-256（`src/prover/artifacts.ts`），不同就停下來。

## 來源

- 電路的程式庫（私有，之後公開）的提交 `497b610c64a3e598ccc769f39e886d1d5ca889ed`，`nargo` 1.0.0（`noirc` 1.0.0+275d3ab1a5c916c6ea73e8d6b943f685f574500c）編譯。
- `nargo compile` 寫出的檔案除了 `bytecode` 和 `abi`，還有 `file_map`（電路和它用到的函式庫的完整原始碼，以及編譯那台電腦上的路徑）、`debug_symbols`、`hash`。頁面用不到這些，原始碼也還沒公開，所以用 `scripts/strip-circuit.mjs` 只留下 `noir_version`、`abi`、`bytecode`：

  ```
  node scripts/strip-circuit.mjs <nargo 寫出的 card_proof_rs2048.json> circuits/card_proof_rs2048.json
  node scripts/strip-circuit.mjs <nargo 寫出的 card_proof_rs4096.json> circuits/card_proof_rs4096.json
  ```

- `nargo` 寫出的原檔的 SHA-256：`card_proof_rs2048.json` `eaa08d003865af49d360c1a93a898c479434ae9759fab23a5cb5ee5767e81a4a`，`card_proof_rs4096.json` `43e74244fdd87a749e2f4724cbf9f1ecb3ee54530e2238e635395c2688a09ae5`。原檔含有編譯路徑，換一台電腦編譯，這兩個值會不同；`bytecode` 和 `abi` 相同（在另一個目錄重新編譯核對過）。

## 怎麼核對

用 `bb` 6.0.0 從這裡的檔案寫出驗證金鑰，SHA-256 要等於上表：

```
bb write_vk -b circuits/card_proof_rs4096.json -o /tmp/vk4096 -t noir-recursive
shasum -a 256 /tmp/vk4096/vk
```

兩份都核對過（2026-11-16）。

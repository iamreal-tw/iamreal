# web/circuits/：編譯好的電路

頁面算證明用的兩份電路。

- **提交的檔案只留三個欄位：`noir_version`、`abi`、`bytecode`。**
- **`bytecode` 就是電路本身**（ACIR，gzip 後 base64）。任何人都可以從它讀出電路檢查什麼、怎麼檢查；公開這兩個檔案就公開了電路做的事。
- **電路的原始碼（Noir）尚未公開。** `nargo compile` 寫出的檔案裡有原始碼（`file_map`），這裡的檔案沒有。

| 檔案 | `issuer` | SHA-256（這裡的檔案） | 驗證金鑰的 SHA-256 |
|---|---|---|---|
| `card_proof_rs2048.json` | `G2` | `8bd668a500df0109111e91ecac6c14554d2d9875b13cf8b9edf7bc194bf73de5` | `816406c75c5422cefab5acd70276f3dc8ce5d269736aefd9795e230569bd3ac8` |
| `card_proof_rs4096.json` | `G3` | `9ee2aa5001acf3b7f78c09d8a7d1d68e13948073b7fcadea6fc6ab0596a6705a` | `bed43ed823a5273292150785bce9a24a24162711a25e8c3a4337a61bdc9f38c2` |

驗證金鑰的 SHA-256 和 `spec/proof-verification.md`、`spec/record.md`「Accepted circuits」、`verifier/vk/` 相同。頁面載入電路檔後先核對上表的 SHA-256（`src/prover/artifacts.ts`），不同就停下來，卡片不簽章。

## 來源

- 電路的程式庫（私有，之後公開）的提交 `497b610c64a3e598ccc769f39e886d1d5ca889ed`，`nargo` 1.0.0（`noirc` 1.0.0+275d3ab1a5c916c6ea73e8d6b943f685f574500c）編譯。
- `nargo compile` 寫出的檔案除了上面三個欄位，還有 `file_map`（電路和它用到的函式庫的完整原始碼，以及編譯那台電腦上的路徑）、`debug_symbols`、`hash`。頁面用不到它們，所以用 `scripts/strip-circuit.mjs` 拿掉：

  ```
  node scripts/strip-circuit.mjs <nargo 寫出的 card_proof_rs2048.json> circuits/card_proof_rs2048.json
  node scripts/strip-circuit.mjs <nargo 寫出的 card_proof_rs4096.json> circuits/card_proof_rs4096.json
  ```

  `hash` 是超過 2^53 的整數，JavaScript 的 `JSON.parse` 讀不準，也一起拿掉。`bytecode` 和 `abi` 沒有改：在另一個目錄從同一個提交重新編譯，兩者逐位元組相同。

## 怎麼核對

1. 檔案的 SHA-256 等於上表第三欄：

   ```
   shasum -a 256 circuits/*.json
   ```

2. 用 `bb` 6.0.0 從這裡的檔案寫出驗證金鑰，SHA-256 等於上表第四欄（也就是後台和重驗的人用的那把）：

   ```
   bb write_vk -b circuits/card_proof_rs4096.json -o /tmp/vk4096 -t noir-recursive
   shasum -a 256 /tmp/vk4096/vk
   ```

   第 2 步說明這份 `bytecode` 就是驗證金鑰對應的電路：用別的電路算的證明，在這把金鑰下驗不過。兩份都核對過（2026-11-16）。

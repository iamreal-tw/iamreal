# probes：只為了測試

**這個目錄不是要上線的電路。** 每一份把正式電路（`../../lib/`）或函式庫裡的單一個函式包成一份小電路，讓測試能單獨對它餵輸入。

| 路徑 | 包的是什麼 | 誰在用 |
|---|---|---|
| `hash_vectors/` | `hash_2`、`hash_3`、18 個元素的雜湊鏈（匿名編號的算法）、廢止清冊的不在樹裡的檢查 | `tests/vectors.test.mjs`：和 `tests/vectors/poseidon2.json` 的寫死標準答案比 |
| `canonical_signature/` | `rsa.nr` 的 `canonical_signature`：簽章只有一種寫法。後面不接驗章 | `tests/library-guarantees.test.mjs` |
| `sha256_var/` | 函式庫的 `sha256_var`，128 個位元組的緩衝區 | `tests/library-guarantees.test.mjs` |

為什麼需要：正式電路裡，簽章換一種分段會被擋兩次（這裡的 `from_array`，和函式庫乘法裡順帶的範圍檢查）。只測正式電路，拿掉其中一個測試照樣通過，看不出我們自己那一行還在不在。單獨包起來之後，只剩我們自己的兩項檢查。

`nargo compile` 會一起編，編到 `target/probe_*.json`。

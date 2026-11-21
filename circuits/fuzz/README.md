# fuzz/：隨機差異測試（Noir 對 circom）

用大量隨機產生的憑證和簽章（合法的和各種壞掉的），同時餵給 Noir 的電路（`../comparison/` 裡和 circom 同形狀的部分、正式的 `card_proof_*`）和 PSE 的 circom 電路（見證產生器），再和一份照 ADR 寫的參考判斷比對。全部用自製的金鑰和憑證，不需要讀卡機或卡片。

不在 `pnpm test` 裡，CI 也不跑；手動跑。電路的 AI 檢查用過它，結果的摘要在 `../REVIEW.md`。升級工具或函式庫之前要跑，見 `../README.md`「升級工具或函式庫之前」。

## 需要

- `circuits/` 已經 `pnpm install`、`"$(./fetch-nargo.sh)" compile --workspace`（`../target/*.json`）。Noir 的執行器和 bb.js 從 `../node_modules` 載入，沒有另外的套件。
- circom 的見證產生器：`../build-circom.sh` 建在 `../.zkID/`，和 `../tests/` 找的是同一個；環境變數 `ZKID_CIRCOM_BUILD` 可以改。也要讀它的一個電路原始檔（`components/poseidonP256Constants.circom`，算 circom 那邊的雜湊），預設在 build 的上一層 `circuits/`（`build-circom.sh` 會留下這個檔），可以用 `ZKID_CIRCOM_SRC` 改。只跑 Noir 時加 `--no-circom`。
- Node 22；`selftest/make-mutants.sh` 另外要 `python3`（改突變體的原始碼）。
- `keys/pool.json`：金鑰池，第一次執行時產生，之後固定。裡面是用完即丟的私鑰，不進版本控制（`../.gitignore`）。同一個種子要重現同一批案例，必須用同一份金鑰池；AI 檢查時用的那一份沒有公開，所以這裡跑同一個種子得到的是另一批案例。

## 檔案

| 檔案 | 內容 |
|---|---|
| `lib/common.mjs` | 有種子的亂數（sfc32，種子是 `sha256(seed:index)`，每一案獨立）、金鑰池、原始 RSA、circom 那邊的 Poseidon（secq256r1 體） |
| `lib/oracle.mjs` | 參考判斷：照 ADR-0008 到 0011 和電路文件寫的結構走法、PKCS#1 v1.5 驗章、種類 |
| `lib/smt.mjs` | circomlib 形狀的廢止清冊樹，可對兩種雜湊各建一份；證明的變造 |
| `lib/gen.mjs` | 產生案例：憑證（`chain`）、簽章（`sig`）、整份證明（`card`，只有 Noir 的 `card_proof_*`） |
| `lib/exec.mjs` | 把一案轉成三個電路的輸入、執行、比對判斷和輸出 |
| `run.mjs` | 工作行程；一案一行寫到 `results/<seed>/w<id>.jsonl`，有問題的案例把全部輸入寫到 `findings/<seed>-<index>.json` |
| `campaign.sh` | 平行跑一輪，記錄寫到 `logs/` |
| `summarize.mjs` | 統計 |
| `prove.mjs` | 用 `bb prove` / `bb verify` 確認 Noir 的一個判斷（`bb` 是 `../find-bb.sh` 找到的那一個） |
| `selftest/` | 測試程式本身的檢查：故意拿掉一項檢查的 Noir 電路（突變體），測試必須抓到；參考判斷和逐案比對手寫的預期相同 |
| `repro/key-not-2048.mjs` | 卡片金鑰不是 2048 位元時，兩邊各部分怎麼判斷的最小重現 |

`keys/`、`results/`、`findings/`、`logs/`、`proofs/` 都是執行時寫的，不進版本控制。

## 怎麼跑

在這個目錄：

```
./campaign.sh main1 8 150                 # 種子 main1、8 個行程、150 分鐘
node summarize.mjs main1                  # 統計

node run.mjs --seed main1 --case 1234 --verbose                # 重跑一案
node run.mjs --seed X --only chain --mutation smt --count 50   # 只跑某一類
node prove.mjs --circuit card_proof_rs2048 --finding findings/<file>.json

selftest/make-mutants.sh                  # 建突變體，見下面；有一個編不過就結束碼 1
selftest/run-mutants.sh 200               # 真電路必須 0 個問題，每個突變體至少 1 個，每一輪的案例都跑完；不成立就結束碼 1
node selftest/oracle-vs-handwritten.mjs   # 參考判斷對逐案比對的預期
node repro/key-not-2048.mjs
```

工作行程 `w` 跑第 `w, w+W, w+2W, ...` 案，所以同一個種子、同一個 `--case` 永遠是同一案，和行程數無關。

`run-mutants.sh` 沒有逾時。偶爾有工作行程一啟動就卡住（不用 CPU、日誌是空的）：停掉它，那一輪會因為工作行程結束碼不是 0、案例數不足而失敗，整個重跑一次。

突變體建在程式庫外面的 `$FUZZ_WORK/mutants/`（預設是系統暫存目錄下的 `circuits-fuzz`）：建在程式庫裡面的話，`nargo` 會找到 `circuits/Nargo.toml`，編的是真的電路。`run-mutants.sh` 的結果也寫在那裡。

## 一案怎麼判斷

每一案算出三個電路各自「應該」接受或拒絕（參考判斷），再看：

1. 每個電路的判斷和參考判斷相同（例外：`card` 類改了 `redc` 而其他都合法時，參考判斷是「都可以」，因為 `redc` 只影響不受約束的計算）。
2. Noir 的比對用部分和 circom 的判斷相同。兩種情況記成 `note`，不算問題：
   - 種類檢查（ADR-0013，有意的差異）：簽章合法、金鑰 2048 位元、只有第一個位元組的種類不對時，Noir 拒絕而 circom 接受。
   - 金鑰長度（檢查的位置不同）：簽章合法、金鑰不是 2048 位元時，Noir 的簽章部分拒絕，circom 的 `userSigRS2048` 接受。這時另外拿一張其他都合法、帶這把金鑰的憑證餵給 circom 的憑證電路，它必須拒絕；它接受就是問題（circom 的三份證明合起來收了不是 2048 位元的金鑰）。
3. 接受時，輸出和電路外算的值相同：`pk_commit`（兩邊各自的雜湊，對結構上的那把公鑰）、匿名編號（標準簽章的雜湊）、場合字串和宣告碼的打包值。

參考判斷和兩個電路是分開寫的，但描述的是同一份格式規格；三者都錯在同一處的話，這個測試看不出來。

參考判斷（`lib/oracle.mjs` 的 `walk`）裡「卡片金鑰剛好 2048 位元」放在最後一項：產生案例時會用到 `walk` 回報的位置，這一項是後來加的，放在最後，同一個種子產生的其他案例才和加之前相同。`card scope-uppercase`（場合字串用大寫字母開頭、卡片也簽了它）也是後來加的，用另一條亂數序列決定，取代一半原本沒有變造的 `card` 案例。

## 限制

- 只到執行器層級：Noir 是 `noir_js` 的 `execute`，circom 是見證產生器（含 `===` 的檢查）。執行器拒絕，代表誠實的見證產生不出來，不代表約束系統沒有解；不受約束的計算（Noir 的 brillig、circom 的 `<--`）被惡意的證明者換掉的情況不在範圍內。
- 證明只在 `prove.mjs` 走過，不是每一案都走。
- circom 的 wasm 見證產生器在長時間執行的行程裡偶爾丟出 `RuntimeError: memory access out of bounds`。同一案在新的行程重跑結果正常。看到這個錯誤時，先用 `--case` 在新行程重跑再判斷。

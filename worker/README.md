# worker/：後台

**這個目錄讓人檢查的事：規則有照做。** 這裡是 Cloudflare 上的後台（ADR-0023），一個 Worker 專案。名冊規則、場合字串這些算法在 [`protocol/`](../protocol)，這裡只引用它，不引用這個程式庫的其他目錄。

## 現在有什麼

清冊鏡像做完了，其他還是骨架。舊的後台 [`server/`](../server)（Go）還在，還是對照。

| 有 | 還沒有 |
|---|---|
| 清冊鏡像（[排程做什麼](#排程做什麼)）：每小時抓內政部的兩份廢止清冊，原始位元組存進 R2 的 `crl/<SHA-256>.crl`，驗章、建樹，寫清冊存檔的索引 `crl/index.jsonl`。`crl/testdata/` 的每一案和 Go 的 `crl/` 比對過 | 在 Cloudflare 上跑過的紀錄：這一版還沒部署 |
| 名冊的 Durable Object：存著每把發證金鑰最新兩份可用清冊的樹根、編號、日期 | 寫入紀錄、題目、卡片狀態 |
| 驗證證明和 Poseidon2 的雜湊（[驗證證明](#驗證證明)），在本機的 workerd 裡逐案和原生的 `bb verify` 比對過 | 呼叫驗證的程式：送出一筆時驗證 |
| 測試專用的建置和測試的工具 | 任何頁面和 API：每個網址都回 `404` |
| 部署測試環境的指令。2026-11-19 用它第一次部署到 `test.iamreal.tw`（[第一次部署量到的](#第一次部署量到的)） | GitHub Actions 的工作流程 |

## 單獨執行

需要 Node 22 和 pnpm。不需要 Cloudflare 的帳號。在程式庫的根目錄 `pnpm install`，然後在這個目錄：

```sh
pnpm dev         # 在本機的 workerd 啟動 Worker
pnpm test        # 測試
pnpm typecheck   # 型別檢查
```

`pnpm dev` 啟動的是測試專用的建置，旁邊有一個假的內政部（本機的伺服器），所以不會對內政部送請求。它印出 Worker 的網址；按 Enter 跑一次排程，印出排程寫的紀錄和 R2 的模擬裡的檔案。R2 的模擬每次啟動都是空的。

## 三樣不是設定值的東西

後台認哪些發證金鑰、去哪裡抓內政部的清冊、現在幾點，都寫在程式裡，不是設定值（ADR-0028）：設定寫錯，不會讓後台收下假卡片簽的東西。

- [`src/target.ts`](src/target.ts) 是部署用的那一份：內政部的兩把發證金鑰（[`src/issuers.ts`](src/issuers.ts)，測試拿 `spec/vectors/issuers.json` 核對）、內政部的兩個清冊網址（和 [`crl/README.md`](../crl/README.md) 寫的相同）、真的時鐘。其他程式用 `#target` 這個名字引用它（`package.json` 的 `imports`）。
- [`test-build/`](test-build) 是測試專用的建置換上的那一份：`target.ts` 是測試當場產生的發證金鑰、假的內政部的網址、可以調的時鐘；`index.ts` 是進入點，在 Worker 前面多一個調時鐘的開關 `PUT /__test/clock`，和兩個入口：`POST /__test/verify` 讓測試呼叫得到驗證證明，`GET /__test/newest-crls` 讓測試看得到名冊的 Durable Object 存著的最新清冊（這兩樣還沒有自己的 API）。入口呼叫的就是 `src/in-worker.ts` 的 `proofVerifier` 和 `src/roster.ts` 的 `newestCrls`，沒有換掉任何一部分。**這兩個入口是暫時的**：送出一筆的介面（[#67](https://github.com/iamreal-tw/iamreal/issues/67)）接上驗證和清冊的檢查之後，測試改走真的介面，兩個都拿掉。
- 測試的發證金鑰每個測試的程序產生一次（[`test/crls.ts`](test/crls.ts)）。私鑰留在那個程序的記憶體裡，用來簽測試的清冊；不寫進任何檔案，也不進任何建置。和 `crl/testdata/` 比對的那個測試，G2 換成簽 `crl/testdata/` 的那一把（只有公鑰）。
- 怎麼換：[`test/build.ts`](test/build.ts) 跑 `wrangler deploy --dry-run`，用 `--alias` 把 `#target` 指到 `test-build/target.ts`，進入點換成 `test-build/index.ts`，金鑰和網址用 `--define` 帶進去。wrangler 的設定檔和部署的指令裡沒有這些參數，所以部署的建置拿到的一定是 `src/target.ts`。
- [`test/bundle.test.ts`](test/bundle.test.ts) 用部署的指令自己的參數和環境（[`scripts/deploy.ts`](scripts/deploy.ts)，加 `--dry-run`）把要上傳的那一包打出來，檢查：
  - 裡面的網址只有內政部的兩個
  - 裡面長到可能是 RSA 金鑰的字串，恰好是 `spec/vectors/issuers.json` 的兩個模數，加上 Barretenberg 通用參數的那一個點（128 個位元組，用它的 SHA-256 認）。找得到的寫法是十六進位、十進位、base64、PEM；拆成數字陣列或執行時才拼起來的金鑰，這個檢查看不到。只看 JavaScript 的模組；WASM 檔和驗證金鑰用 SHA-256 認，不當文字掃
  - 沒有假的內政部、時鐘的開關和測試專用建置的其他痕跡
  - wrangler 列出的 binding 只有 `ROSTER`、`DATA`、`ROSTER_OBJECT_NAME`，所以金鑰、網址、時鐘沒有設定值可以讀。用 `wrangler secret` 另外設在 Worker 上的密鑰不在設定檔裡，這個檢查看不到
  - 把測試專用的建置也打出來，確認同樣的找法在那一包找得到測試的金鑰、假的內政部和時鐘的開關

**驗證證明的程式兩種建置相同。** 測試專用的建置換掉的只有 `#target` 和進入點；驗證證明和 Poseidon2 的六個檔（`src/in-worker.ts` 和它引用的 `src/verify.ts`、`src/poseidon2.ts`、`src/engine.ts`、`src/barretenberg.ts`、`src/circuits.ts`）不引用 `#target`，也不引用 `src/` 裡這六個以外的檔（[`test/layout.test.ts`](test/layout.test.ts) 檢查）。兩包裡不是 JavaScript 的模組都恰好是 WASM 檔和兩把驗證金鑰，SHA-256 是核對過的那三個（`test/bundle.test.ts`）。部署的那一包從清冊鏡像開始含這三個檔：鏡像引用 `src/in-worker.ts` 的 `poseidon2Hash`，驗證金鑰跟著同一個檔進來，雖然還沒有程式呼叫驗證。

`target.ts` 還有兩樣時間，也是測試專用的建置會換的：等內政部一份清冊最久等多久（部署的是 5 分鐘，測試換成一兩秒，測逾時才不用等幾分鐘），和一輪鏡像補之前留下的檔最久補多久（部署的是 5 分鐘，測試可以設成 0 來測這條界線）。

Worker 載入時檢查發證金鑰是一把 2048 位元的 G2 和一把 4096 位元的 G3，不是就不啟動。

## 驗證證明

照 ADR-0023 和 [#16](https://github.com/iamreal-tw/iamreal/issues/16) 的結論，在 Worker 裡用 Barretenberg 的 WASM 驗（[`spec/proof-verification.md`](../spec/proof-verification.md)）。

### 介面

[`src/verify.ts`](src/verify.ts) 的 `ProofVerifier`，後台只經過它驗證：

```ts
interface ProofVerifier {
  verify(circuit: string, proof: Uint8Array, publicInputs: readonly Uint8Array[]): Promise<boolean>;
}
```

- `circuit` 是電路的名稱，`card_proof_rs2048` 或 `card_proof_rs4096`；`publicInputs` 每個值是 32 個位元組、大端序，照電路的順序。
- 回 `true` 是通過，`false` 是拒絕。請求本身有任何不對都是拒絕，不丟例外：不認得的名稱、長度不對的證明、個數或大小不對的公開輸入、不小於模數的值、驗不過的證明、讓 Barretenberg 丟例外的證明。
- **跑不起來不是拒絕，也不是通過。** 驗證器自己跑不起來（WASM 實例化失敗、載入通用參數失敗）時 `verify` 丟例外（`EngineError`，`notStarted` 是 `true`），不回任何結果；那和證明無關，沒有任何輸入會造成它。呼叫的人不可以把它當成通過：#67 要把它處理成「這一筆不接受、不寫入」，是後台自己的錯誤，不是 `proof` 這個拒絕代碼。下一次呼叫會重新試著實例化。[`test/engine.test.ts`](test/engine.test.ts) 確認這條路不會回 `true`，也不會回 `false`。
- Barretenberg 回的不是預期的那一種答覆、或答覆裡沒有結果時，算拒絕，並丟掉那個實例。
- 在 Worker 裡驗的那一個是 [`src/in-worker.ts`](src/in-worker.ts) 的 `proofVerifier`。之後改走 Containers 跑原生的 `bb`，換掉的是它，其他程式不動。

### 呼叫 WASM 之前的檢查

和 Go 的 [`verifier/verify.go`](../verifier/verify.go) 在呼叫 `bb` 之前做的相同，不通過就不問 WASM：

1. 證明剛好 14,656 個位元組
2. 公開輸入的個數是這個電路的個數（23 或 40），每個值剛好 32 個位元組
3. 每個值小於模數 `p`

在這幾種輸入上，WASM 和原生的 `bb` 出錯的方式不同（#16），所以兩邊都不問。

### 丟例外就換實例

WASM 丟出任何例外都算拒絕，並丟掉那個實例，下一筆重新實例化（[`src/engine.ts`](src/engine.ts)）。同一個實例一直吃例外會漏記憶體，到大約第 335 次之後連正確的證明都驗不過（#16）；[`test/verify.test.ts`](test/verify.test.ts) 有連續 500 個丟例外的證明之後再驗正確證明的案例，拿掉「丟掉實例」那一行它會失敗。測試沒辦法讓真的 WASM 回形狀不對的答覆或不啟動，這幾種情況在 [`test/engine.test.ts`](test/engine.test.ts) 用一個頂替 Barretenberg 實例的假物件測，在 Node 裡跑。

一個實例的記憶體上限設在 16 MiB（驗一筆用到 2.6 MiB）。Barretenberg 自己印的訊息不留：裡面可能帶著正在驗的內容。

### WASM 檔和驗證金鑰從哪裡來

每一次建置（測試的、`pnpm dev` 的、部署的）都先跑 [`scripts/engine-files.ts`](scripts/engine-files.ts)，核對下面三個檔的 SHA-256，寫進 `generated/`（不進版控）；任何一個不對，建置就停在這裡，不呼叫 wrangler。

| 檔案 | 來源 | SHA-256 |
|---|---|---|
| `barretenberg.wasm`（18,278,515 個位元組） | `@aztec-foundation/bb.js` 6.0.0 的 `dest/browser/barretenberg_wasm/fetch_code/browser/barretenberg.js`：單執行緒的 WASM 以 gzip 加 base64 寫在這個檔裡，取出來解壓縮 | `88c435ec45998ad74b51b25659b37e59b4beea256073138415547f8153f9ead9` |
| `card_proof_rs2048.vk.bin` | [`verifier/vk/card_proof_rs2048.vk`](../verifier/vk)，Go 的驗證器編進去的同一個檔 | `816406c75c5422cefab5acd70276f3dc8ce5d269736aefd9795e230569bd3ac8` |
| `card_proof_rs4096.vk.bin` | [`verifier/vk/card_proof_rs4096.vk`](../verifier/vk) | `bed43ed823a5273292150785bce9a24a24162711a25e8c3a4337a61bdc9f38c2` |

- 驗證金鑰在程式庫裡只有 `verifier/vk/` 那一份；`generated/` 裡的是每次建置時抄的，檔名加 `.bin` 是為了讓 wrangler 照預設的規則把它當成位元組載入，設定檔不用改。兩個 SHA-256 和 `spec/proof-verification.md` 的表相同（[`test/engine-files.test.ts`](test/engine-files.test.ts) 核對）。
- 自己核對 WASM 的 SHA-256：在這個目錄 `node --experimental-strip-types -e 'import("./scripts/engine-files.ts").then((m) => m.prepareEngineFiles())' && shasum -a 256 generated/barretenberg.wasm`。
- bb.js 只用到這一個檔，它的程式沒有進 Worker。載入程式是自己寫的（[`src/barretenberg.ts`](src/barretenberg.ts)）：bb.js 是抓位元組來編譯（`WebAssembly.compile`），Workers 不允許：Cloudflare 的文件把 `WebAssembly.compile`、`WebAssembly.compileStreaming`、收位元組的 `WebAssembly.instantiate`、`WebAssembly.instantiateStreaming` 和 `eval()`、`new Function` 列在一起，寫「For security reasons, the following are not allowed」（[JavaScript and web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)，2026-11-20 讀的）。這裡是把 WASM 當模組引用，執行環境給的是編好的模組（[WebAssembly in JavaScript](https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/)）。提供給 WASM 的是 1 塊記憶體和 5 個函式，用和 bb.js 相同的 msgpack 格式（`msgpackr`）呼叫 `bbapi` 的 `SrsInitSrs`、`CircuitVerify`、`Poseidon2Hash`；`CircuitVerify` 的設定是 `noir-recursive`，沒有別的。
- 通用參數不下載：G1 的第一個點 `(1, 2)` 和 G2 的那一個點寫在載入程式裡。G2 那 128 個位元組和 `https://crs.aztec-cdn.foundation/g2.dat` 相同（bb.js 6.0.0 的 `src/crs/net_crs.ts` 下載的網址；2026-11-20 抓下來逐位元組對過，SHA-256 `01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f`）。WASM 自己核對這兩個點，不對就中止（#16），所以寫錯的後果是什麼都驗不過，不是驗錯。
- 直接跑 `wrangler deploy` 不會經過這個核對，用的是 `generated/` 裡現有的檔；部署一律用 `pnpm run deploy:test`。

### Poseidon2

[`src/in-worker.ts`](src/in-worker.ts) 的 `poseidon2Hash(inputs: readonly Uint8Array[]): Uint8Array`（型別 `Poseidon2Hash` 在 [`src/poseidon2.ts`](src/poseidon2.ts)）：輸入和輸出都是 32 個位元組、大端序的體元素，同步，用驗證證明的同一個 WASM 實例。清冊鏡像建樹用它（[`src/crl-tree.ts`](src/crl-tree.ts)），Worker 裡沒有另一份 Poseidon2。不是 32 個位元組或不小於 `p` 的輸入丟 `RangeError`，不問 WASM。Barretenberg 跑不起來、丟例外、或回的不是雜湊時丟 `EngineError`，並丟掉那個實例（跑不起來時沒有實例可丟）；下一次呼叫用新的實例。[`test/poseidon2.test.ts`](test/poseidon2.test.ts) 拿 `spec/vectors/poseidon2.json`（Go 的 `crl/poseidon2` 讀的同一份）核對：`hash_2`、`hash_3`、`scoped_id` 每一案在 Node 裡直接呼叫這個函式（Worker 沒有只算雜湊的入口）；`revocation_tree` 每一案的樹根在本機的 workerd 裡經過清冊鏡像核對。

### 和原生的 `bb verify` 逐案比對

```sh
IAMREAL_BB=/path/to/bb pnpm test                                                          # 全部的測試，包含比對
IAMREAL_BB=/path/to/bb node --experimental-strip-types --test test/compare.test.ts        # 只跑比對
```

`IAMREAL_BB` 指到 `bb` 6.0.0（和 Go 的測試同一個變數），另外要有 `go`；沒設就跳過。約 80 秒。[`test/compare.test.ts`](test/compare.test.ts) 做的事：

1. 用一個頂替 `bb` 的腳本跑 `go test ./verifier`，留下每次交給 `bb verify` 的驗證金鑰、證明、公開輸入，再把同樣的參數交給真的 `bb`。內容相同的算一案。Go 的測試裡有亂數的證明，所以每次跑的案例不完全相同。
2. 加上 Go 在呼叫 `bb` 之前就擋掉、所以腳本看不到的那幾種，每個電路 16 案：公開輸入加上 `p`、等於 `p`、`2^256 − 1`、個數多一個少一個、沒有、少一個位元組；證明是空的、多或少一個位元組、多或少一個值、非零知識的證明；別的電路的驗證金鑰（配原本的公開輸入、配那個電路的公開輸入）。
3. 每一案各問一次原生的 `bb verify -t noir-recursive`（結束代碼 0 是通過，其他都是拒絕）和本機 workerd 裡的 Worker，通過或拒絕要相同。全部比完之後，兩個電路正確的證明還要驗得過。

2026-11-20 跑的結果（原生 `bb` 6.0.0，macOS arm64；workerd 1.20261110.1）：Go 的測試呼叫 `bb verify` 1,109 次，內容不同的 1,096 案，加上第 2 項的 32 案，共 1,128 案；原生通過 2 案、拒絕 1,126 案，**沒有一案不同**。

比不到的：驗證金鑰本身被改過的情況（#16 試過少一個位元組的驗證金鑰）。這個介面不收驗證金鑰，金鑰是建置時核對過 SHA-256 的那兩把。

### 量到的

2026-11-20，Apple Silicon，本機的 workerd（1.20261110.1），從測試的程序經 HTTP 量，各 200 次的中位數。本機的 workerd 不限 CPU 和記憶體，這些數字只說明量級。

| | 往返一次 |
|---|---|
| 不存在的網址（只有 HTTP 的往返） | 2.6 ms |
| 驗證的入口，在呼叫 WASM 之前就拒絕（往返加上讀請求） | 3.9 ms |
| 驗一筆 `card_proof_rs2048` | 18.5 ms |
| 驗一筆 `card_proof_rs4096` | 18.7 ms |
| 前一筆丟了例外之後驗一筆（多一次實例化） | 20.3 ms |

- 扣掉往返，驗一筆約 15 ms，實例化約 2 ms。Worker 啟動後的第一筆（第一次實例化加驗證）往返 84 ms。
- 在 Node 22 裡直接跑載入程式一次：實例化加載入通用參數 10 ms，第一筆驗證 26 ms，第二筆 13 ms；WASM 的記憶體實例化後是 2.5 MiB，驗完兩筆是 2.6 MiB。
- 打包後的大小（部署的那一包，`wrangler deploy --dry-run` 印的）：17,973 KiB，gzip 後 4,026 KiB，幾乎都是 WASM。清冊鏡像做好之前，部署的那一包是 5.7 KiB；**這個大小的一包還沒有上傳到 Cloudflare 過**。

## 設定檔

[`wrangler.jsonc`](wrangler.jsonc)。最上層是每個環境都一樣的：進入點、相容日期、Durable Object 的 migration、不送使用統計給 Cloudflare。沒有 `build.command`，部署時不會執行任何自訂的指令。

每個環境一段，寫在 `env` 底下。現在只有測試環境 `env.test`（ADR-0028）：

| 欄位 | 值 | 說明 |
|---|---|---|
| `name` | `iamreal-test` | Worker 的名稱。部署的權杖只能部署這一個 |
| `workers_dev`、`preview_urls` | `false` | 不開 `workers.dev` 的網址，只走自訂網域 `test.iamreal.tw`。自訂網域在儀表板上設，不在這裡（ADR-0029） |
| `triggers.crons` | `0 * * * *` | 每小時整點跑一次排程 |
| `durable_objects` | `ROSTER` → 類別 `Roster` | 一份名冊一個 Durable Object |
| `r2_buckets` | `DATA` → `iamreal-test-data` | 公開的檔案，經 `test-data.iamreal.tw` 下載（ADR-0027） |
| `vars.ROSTER_OBJECT_NAME` | `test-1` | 名冊那個 Durable Object 的名稱。清空測試名冊就是換一個名稱 |

之後加正式環境，是在 `env` 底下多一段，程式不用改。最上層沒有 `name`，也沒有 binding：指令沒帶 `--env` 時，wrangler 拿套件名稱 `iamreal-worker` 當 Worker 的名稱，不會是 `iamreal-test`。

## 排程做什麼

每小時一次，一輪清冊鏡像（[`src/mirror.ts`](src/mirror.ts)），照 [`spec/revocation-tree.md`](../spec/revocation-tree.md)。三步：

**一、抓和存。**

1. 同時抓 G2、G3 的清冊，兩份互不等待。每一份從送出請求到收完最多等 5 分鐘：G2 的清冊約 17 MB，每秒 0.5 Mbit 也收得完；排程一次最多能跑 15 分鐘（[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)）。
2. 收到完整的 `200` 時，算內容的 SHA-256。R2 裡已經有 `crl/<SHA-256>.crl` 就不重存；沒有才寫入。
3. 下面的情況算失敗，那一份不存任何檔，另一份照常：
   - 狀態不是 `200`、連不上、超過 5 分鐘
   - 執行環境回報連線中斷
   - 收到的長度和回應的 `Content-Length` 不同
   - 內容是 0 個位元組
   - 內容超過 32 MiB（33,554,432 個位元組）。回應有 `Content-Length` 時看它，不讀內容；沒有時邊讀邊數，超過就停

**二、補索引。** 列出儲存桶裡 `crl/` 底下的清冊檔，讀 `crl/index.jsonl`；有檔案、索引裡沒有行的，一個一個讀出來：

1. 核對內容的 SHA-256 和檔名相同。
2. 讀清冊、驗章（[`src/crl.ts`](src/crl.ts)）：可不可用、原因代碼和它們的順序，和 Go 的 [`crl/`](../crl) 相同。簽章用兩把發證金鑰各試一次，哪一把驗得過，`issuer` 就是哪一把。
3. 可用的建樹（[`src/crl-tree.ts`](src/crl-tree.ts)），得到樹根。
4. 這個檔的行加進索引，整份索引重寫一次。
5. 把索引現在列著的最新清冊告訴名冊的 Durable Object（第三步）。

所以：

- **可用不可用都存、都有一行。** 內政部的伺服器回一頁 HTML 的錯誤訊息，也會存起來，索引裡是 `-not_usable_der`。
- **索引裡已經有的檔不再讀、不再建樹。** 內政部沒有換清冊的那幾個小時，這一步只列一次儲存桶、讀一次索引，索引不重寫。
- **寫到一半失敗，下一輪補得回來。** 補的依據是儲存桶裡有什麼，不是這一輪抓到什麼：上一輪存了檔、還沒寫行就結束，這一輪補上那一行，內政部那時已經換了清冊也一樣。索引是一個物件，每次整份換掉，不會有人讀到半份。讀到的索引有寫法不合規格的行、重複的行、對不到檔案的行時，那些行不算數，從檔案重來。
- **一個檔拿不到行，只是那個檔的事。** 內容和檔名不符、讀不出來、建樹時 Barretenberg 出錯：那個檔記一行 `failed`，其他檔照做，Durable Object 照樣被告知，下一輪再試那個檔。這一次排程最後以例外結束。
- **這一輪抓到的檔先做，一定做。** 之前留下、還沒有行的檔接著做，照寫進儲存桶的時間，新的先做（過卡要用的是最新的清冊）；但這一輪開始補索引滿 5 分鐘之後就不再開始新的一份，留給下一輪。整份索引不見時，要分好幾輪才補得完，每一輪寫的行都留著。
- **兩輪同時跑，不會蓋掉對方的行。** 索引用條件式寫入：只有儲存桶裡的索引還是這一輪讀到的那一份（照 ETag），或讀的時候沒有、現在也還沒有，才寫得進去（[R2 的條件式操作](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations)）。寫不進去就重讀索引、把自己的行加到新的那一份上再寫，最多試 5 次。
- **讀一個檔花的時間不超過它大小的線性倍數，除了一處。** 延伸欄位有沒有重複用集合找，不是兩兩比。清冊編號沒有長度上限（和 Go 相同），位元組一次轉成整數；但把整數印成十進位是 JavaScript 引擎做的，比線性慢：見[量到的](#清冊鏡像量到的)。
- **不替每一筆廢止建物件**（[#26](https://github.com/iamreal-tw/iamreal/issues/26)）：在原始位元組上逐筆走，每個序號的鍵直接寫進一個 `Uint32Array`，重複的序號和最低 127 位元相同的鍵用排序找。讀完之後檔案的位元組就放掉，建樹時只留著鍵。
- **建樹時讓出執行緒。** 樹切成最多 4,096 塊（樹根往下 12 層的子樹），每做完約 256 個鍵就等一次 `setTimeout(0)`，同一個實例裡等著的請求在這時候被處理。

**三、告訴名冊的 Durable Object。** 從索引取每把發證金鑰最新兩份可用的清冊（照清冊編號，和裝置選清冊的方法相同；不可用的不算），把樹根、編號、清冊日期交給名冊的 Durable Object，它整份換掉自己存的（[`src/roster.ts`](src/roster.ts) 的 `setNewestCrls`）。每一輪一開始讀完索引就交一次，不管有沒有新的清冊；之後每寫完一次索引再交一次，所以 G2 的新清冊不用等 G3 的樹建完。

守住的只有一條：**Durable Object 知道的樹根，一定已經列在儲存桶的索引裡。** 交出去的永遠是從剛寫成功（或剛讀到）的那一份索引算的。

```ts
interface KnownCrl {
  root: string;      // 樹根，64 個小寫十六進位數字，和紀錄的 smt_root 同一種寫法
  crlNumber: string; // 清冊編號，十進位
  crlDate: string;   // 清冊日期：thisUpdate 的台灣日期，YYYY-MM-DD
}
type NewestCrls = { G2: KnownCrl[]; G3: KnownCrl[] }; // 每把最多兩份，最新的在前
```

Durable Object 用 `newestCrls()` 讀出來。送出一筆時的兩個檢查（樹根是不是這兩份之一、最新那一份是不是太舊）還沒做，在 [#67](https://github.com/iamreal-tw/iamreal/issues/67)。

只要有一份清冊沒抓到、有一個檔沒補上行、索引沒寫成、或沒交給 Durable Object，這一次排程就以例外結束，在 Cloudflare 的紀錄上是失敗的一次；做得到的部分照樣做完。

寫進資料儲存桶的每個物件都設 `Cache-Control`：資料網域的快取規則是「有就照它，沒有就不快取」。

| 物件 | `Cache-Control` | 理由 |
|---|---|---|
| `crl/<SHA-256>.crl` | `public, max-age=31536000, immutable` | 檔名就是內容的雜湊，內容不會變 |
| `crl/index.jsonl` | `public, max-age=60` | 內政部簽發新的清冊就會變 |

**鏡像在一個換得掉的介面後面**（ADR-0023）：`src/mirror.ts` 的 `CrlMirror`，只有一個方法 `round()`，回傳這一輪做了什麼、哪裡出錯，不丟例外。現在的實作 `crlMirrorInWorker` 全部在 Worker 裡做，要的東西（來源、儲存桶、發證金鑰、雜湊、兩個時間、告訴 Durable Object 的函式 `tell`）由 `src/index.ts` 交給它；超過 Workers 的限制時換掉它（例如在 Containers 跑 Go 的 `crl/`），`src/index.ts` 只改建立它的那幾行。

**有一種截斷在抓的時候擋不住。** 回應沒有 `Content-Length`（chunked）、連線在最後一塊之前斷掉時，本機的 workerd（1.20261110.1）不回報錯誤，收到的那一段看起來就是完整的回應，會被存起來。它不是內政部簽的清冊，索引裡是不可用的一行。回應有 `Content-Length`、連線提早斷掉時，本機的 workerd 既不報錯也不結束，所以是等到逾時才算失敗。這兩件事在 Cloudflare 上是不是一樣，還沒有在部署的環境看過。

排程寫的紀錄只在即時的輸出看得到（`wrangler tail` 或儀表板的即時紀錄），沒有開保存。每一份來源一行，每一個補上行的檔一行：

```
{"event":"crl_mirror","at":"2026-11-20T08:00:00.123Z","issuer":"G3","result":"stored","sha256":"…"}
{"event":"crl_index","at":"2026-11-20T08:00:00.123Z","result":"indexed","sha256":"…","issuer":"G3","crl_number":"2026112016","crl_date":"2026-11-20","root":"…","entries":178020,"keys":178020,"hashes":434659,"read_ms":113,"tree_ms":15657}
```

- `crl_mirror` 的 `result` 是 `stored`（新的一份）、`already_stored`（已經有）、`failed`（附 `error`）。
- `crl_index` 的 `result` 是 `indexed` 或 `failed`（附 `error`）。`entries` 是廢止的筆數，`keys` 是樹裡的鍵數，`hashes` 是建樹算了幾次 Poseidon2；`read_ms` 是從儲存桶讀出來到驗完章，`tree_ms` 是建樹，都是毫秒。

### 和 Go 的 `crl/` 逐案比對

[`test/crl-testdata.test.ts`](test/crl-testdata.test.ts)，在 `pnpm test` 裡。每一份清冊當成假的內政部的回應，經過本機 workerd 裡的整個 Worker，看儲存桶裡的索引。

1. `crl/testdata/` 的 37 份自製清冊：每一份的可用不可用、原因代碼、樹根、編號、時間、清冊日期，和 `crl/testdata/expected.json`（Go 的測試讀的同一份）相同。
2. `crl/testdata/times/` 的 48 份：`thisUpdate`、`nextUpdate` 用規格「Times」收的和不收的各種寫法（沒有秒的 UTCTime、帶時差、西元 0 年以前和 9999 年以後、不存在的日期……；線上那兩份清冊的時間都是 12 位數字加 `Z` 的 UTCTime）。每一份在索引裡的那一行，和 `crl/testdata/times/expected.json` 寫的逐字相同；那些答案是照規格手寫的，Go 的測試讀同一份。
3. 把儲存桶裡的清冊檔寫到一個目錄，跑 Go 的 `iamreal-crl index`，印出來的索引和儲存桶裡的 `crl/index.jsonl` 逐位元組相同。除了上面 85 份，還有 3 個不是清冊的檔和 1 份測試金鑰簽的清冊。**這一項要有 `go`，沒有就跳過；前兩項不用。**

2026-11-20 跑的結果：三項都過，共 89 個檔，索引 89 行，沒有一行不同。

### 清冊鏡像量到的

2026-11-20，Apple Silicon。清冊是測試網站 2026-11-19 鏡像下來的兩份（[第一次部署量到的](#第一次部署量到的)那兩個 SHA-256），從 `test-data.iamreal.tw` 下載，沒有對內政部送請求。**本機的 workerd 不限 CPU 和記憶體，這些數字只說明量級；Cloudflare 上的還沒量。**

本機的 workerd（1.20261110.1），整個 Worker，發證金鑰換成內政部的兩把，假的內政部送出那兩份檔，跑一次排程：

| | G2 | G3 |
|---|---|---|
| 大小 | 16,893,934 位元組 | 8,818,913 位元組 |
| 廢止的筆數、樹裡的鍵數 | 341,055 | 178,020 |
| 從儲存桶讀出來、算 SHA-256、讀清冊、驗章、排序 | 200 ms | 113 ms |
| 建樹 | 29.2 秒 | 15.7 秒 |
| Poseidon2 算了幾次 | 833,443 | 434,659 |
| 樹根 | `08aca62b…e1f9` | `04c63283…ffdd` |

- 整次排程 45.4 秒，幾乎都是 Poseidon2：每次約 35 µs，包含 msgpack 的編碼和解碼。離每小時一次的排程 15 分鐘的 CPU 時間上限約 20 倍。
- 兩個樹根和 Go 的 `iamreal-crl check` 對同一份檔案算的相同。
- 接著再跑一次排程（兩份都已經在索引裡）：48 ms。
- 建樹的時候每 100 ms 對同一個 Worker 送一個請求，共 314 個：往返的中位數 41 ms，第 95 百分位 64 ms，最久 339 ms。沒有鏡像在跑時是 2.6 ms。
- 在 Node 22 裡直接跑同一段程式，Poseidon2 每次約 30 µs，G2 建樹 25.7 秒、G3 13.5 秒。
- 審查後的修正（條件式寫入、每寫一次索引就告訴 Durable Object 一次）之後再跑一次：整次排程 42.5 秒，G2 建樹 27.5 秒、G3 14.4 秒，樹根相同；建樹時的請求往返中位數 38 ms。

記憶體，在 Node 22 裡量（workerd 裡量不到）。G2 那一份，和一份 Go 的 `crl/internal/crltest/makecrl` 做的同樣大小的自製清冊（16,937,158 位元組，342,152 筆），結果相同：

| | JavaScript 的記憶體（`heapUsed`） | `ArrayBuffer` |
|---|---|---|
| 讀完清冊（放掉檔案之前），沒有強制回收時看到的高點 | 25 MB | 30.5 MB：檔案 16.9 MB，加鍵的兩份陣列（排序前、排序後）各 6.5 MB |
| 讀完、檔案放掉、回收之後 | 8.6 MB | 6.5 MB：排序後的鍵 |
| 建完樹、回收之後 | 6 到 10 MB | 6.6 MB |

- 排序當下多一個 1.4 MB 的陣列，沒有取樣到，所以 `ArrayBuffer` 的高點約 32 MB。
- 自製的那一份在 JavaScript 的記憶體限制 24 MB（`--max-old-space-size=24`）下跑得完，樹根和 Go 算的相同。
- WASM 的線性記憶體另計，上限 16 MiB，建樹用到 2.5 MiB 上下（[#26](https://github.com/iamreal-tw/iamreal/issues/26)）。
- 抓和存的那一步，兩份清冊同時在記憶體裡，約 26 MB；補索引時一次只讀一份。兩份都剛好是上限 32 MiB 時，這一步是 64 MiB；沒有 `Content-Length` 的回應在接起來的那一刻多佔一倍。

**故意做來拖時間的檔**，在 Node 22 裡量讀一個檔（`readCrl`）的時間。這種檔不需要簽章就會被存下來：內政部的網址是 `http://`，路上的人可以換掉回應。

| 檔案 | 讀一次 | Go 的 `iamreal-crl check` |
|---|---|---|
| 清冊編號是 400,000 個位元組的整數 | 0.2 秒（修正前 26.3 秒） | 0.14 秒 |
| 清冊編號是 4,000,000 個位元組的整數 | 2.9 秒 | 5.0 秒 |
| 清冊編號是 16,000,000 個位元組的整數 | 14.9 秒 | 44.4 秒 |
| 30,000 個不同的延伸欄位（390 KB） | 12 ms（修正前 27.2 秒） | 沒量 |

- 清冊編號的時間幾乎都花在把整數印成十進位，這一步是一次同步的呼叫，中間不讓出執行緒；Go 也是這裡慢。照這個趨勢，上限 32 MiB 的檔最壞約 40 秒，那段時間同一個實例裡的請求要等。每個這樣的檔只會讀一次（之後索引裡有它的行）。
- 要根本解決，得在規格裡給清冊編號一個長度上限（RFC 5280 第 5.2.3 節要求簽發者不超過 20 個位元組），Go 和這裡一起改。這一版沒有改行為。
- 索引的那一行會帶著整個十進位的編號：4 MB 的整數是 960 萬個數字的一行。

**部署之後要看的**，還沒有答案：

- Cloudflare 上一次排程真的 CPU 時間（`wrangler tail` 的 `crl_index` 那幾行有每一份的 `tree_ms`）
- 18 MB（gzip 後 4 MB）的一包上傳得上去、啟動得了
- 編好的 WASM 機器碼算不算進每個實例 128 MB 的記憶體上限。Cloudflare 的文件寫的是「Each isolate can consume up to 128 MB of memory, including the JavaScript heap and WebAssembly allocations」（[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)，2026-11-20 讀的），沒有講機器碼
- 第一次排程要補的檔：儲存桶裡從 2026-11-19 起每小時鏡像下來的清冊都還沒有行，有幾份沒有查過。一輪補不完時分幾輪補，補齊之前索引只列一部分

### 內政部看得到什麼

- `User-Agent` 是一般的 `Mozilla/5.0 (compatible)`，不帶專案名稱。
- Cloudflare 會在 Worker 送出的每個請求加上 `CF-Worker` 標頭，值是這個 Worker 所在 zone 的名稱（[Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)），照這份文件會是 `iamreal.tw`；沒有實際看過送到內政部的請求。這一項不是程式決定的；營運者知道並接受，`CONTRIBUTING.md`「工作時對外的請求」把它列為例外。本機的 workerd 會模仿它，值是 Worker 的名稱加 `.example.com`。

## 測試的工具

[`test/harness.ts`](test/harness.ts) 的 `startWorker()`：打出測試專用的建置，在本機的 workerd 啟動整個 Worker（用 wrangler 的 `createTestHarness`），旁邊開一個假的內政部。之後每一張後台的票都用它。

| 測試要做的事 | 用法 |
|---|---|
| 送 HTTP 請求 | `worker.fetch("/路徑")`，或對 `worker.url` 用一般的 `fetch` |
| 觸發排程 | `worker.runSchedule()`，回傳 `outcome`（`ok` 或 `exception`） |
| 讀 R2 的模擬裡寫出來的檔案 | `worker.files("crl/")`：檔名、內容、`Cache-Control`、寫入時間 |
| 調時鐘 | `worker.setClock(new Date("…"))` |
| 假的內政部 | `worker.moica.serve("G2", 位元組)`、`.fail("G3", 503)`、`.cutOff(…)`（送到一半斷線）、`.stall(…)`（不回應或送到一半停住）、`.requests` |
| 縮短等內政部的上限 | `startWorker({ crlTimeoutMs: 1500 })`，預設 2 秒 |
| Worker 寫的紀錄 | `worker.logLines()` |
| 驗一份證明 | `worker.verify(電路名稱, 證明, 公開輸入)`，回 `true` 或 `false` |
| 做一份測試金鑰簽的清冊 | [`test/crls.ts`](test/crls.ts) 的 `makeCrl({ issuer, number, thisUpdate, serials })`，交給 `worker.moica.serve` |
| 名冊的 Durable Object 知道的最新清冊 | `worker.newestCrls()` |
| 把儲存桶弄成上一輪做到一半的樣子 | `worker.putFile(檔名, 內容)`、`worker.deleteFile(檔名)` |
| 假的內政部不帶 `Content-Length` | `worker.moica.serve("G2", 位元組, "chunked")` |
| 改一輪補舊檔的界線 | `startWorker({ crlCatchUpMs: 0 })`，預設是部署的 5 分鐘 |
| 重啟 Worker 和 Durable Object | `worker.restart()`：儲存的東西和儲存桶的檔案留著，記憶體裡的（包括調過的時鐘）不見 |
| 換發證金鑰 | `startWorker({ issuers: [G2, G3] })`，預設是測試自己的兩把 |

測試不對內政部送請求。測試用 Node 內建的 test runner，和 `protocol/`、`web/` 相同。

## 型別檢查

Workers 執行環境的型別（`R2Bucket`、`DurableObject`……）和 `Env` 由 `wrangler types` 從設定檔和本機的 workerd 產生，寫到 `worker-configuration.d.ts`；這個檔不進版控，`pnpm typecheck` 每次重新產生。沒有另外裝型別的套件。

型別檢查分兩份設定，因為兩邊的全域型別不同：

- `tsconfig.json`：在 Worker 裡執行的程式（`src/`、`test-build/`），用上面產生的型別，沒有 Node 也沒有 DOM 的型別
- `test/tsconfig.json`：在 Node 裡執行的測試和指令（`test/`、`scripts/`）。它另外帶 DOM 的型別：測試在 Node 裡直接載入 WASM 檔（`test/poseidon2.test.ts`），`WebAssembly` 的型別在那裡

## 部署測試環境

```sh
pnpm run deploy:test
```

[`scripts/deploy-test.ts`](scripts/deploy-test.ts) 讀程式庫根目錄的 `.env.local` 裡的兩行，`CLOUDFLARE_API_TOKEN_TEST` 和 `CLOUDFLARE_ACCOUNT_ID`，交給 `wrangler deploy --env test --experimental-provision=false`。那把權杖只能部署 `iamreal-test`（ADR-0029）。不用 `wrangler login`。shell 裡原有的 `CLOUDFLARE_*`、`CF_*`、`WRANGLER_*` 變數都不會傳給 wrangler，所以別的權杖或別的 API 網址不會被用到。

- 環境固定是測試環境。唯一接受的參數是 `--dry-run`：只打包，不上傳。
- 呼叫 wrangler 之前先核對 WASM 檔和驗證金鑰的 SHA-256（[WASM 檔和驗證金鑰從哪裡來](#wasm-檔和驗證金鑰從哪裡來)），不對就不部署。
- `--experimental-provision=false` 讓 wrangler 不問 Cloudflare 儲存桶在不在；為什麼要帶，見[下一節](#第一次部署量到的)。
- 正式環境只從 GitHub Actions 部署，這裡沒有它的指令。

## 第一次部署量到的

2026-11-19，從營運者的電腦用 `.env.local` 那把只有 `iamreal-test` 的 `Editor` 的權杖部署（wrangler 4.160.1），版本 `12ae49e5-228c-4122-b1e7-335e47392499`。時間都是 UTC。經過記在 [#63](https://github.com/iamreal-tw/iamreal/issues/63)。這一節是 [#26](https://github.com/iamreal-tw/iamreal/issues/26) 和 ADR-0029 留下「部署時確認」的那兩件事的出處。

### 只有 `Editor` 權限的權杖也跑得了 Durable Object 的 migration

14:30 的部署上傳了帶 migration `v1`（`new_sqlite_classes: ["Roster"]`）的 Worker，沒有用別的權杖。部署後用同一把權杖讀 Worker 的設定（`GET …/workers/scripts/iamreal-test/settings`），`ROSTER` 這個 binding 帶著 Durable Object 的 `namespace_id`。只看過建立類別的這一種 migration；改名、刪除類別的沒有試過。

這把權杖做得到和做不到的：

| 做的事 | 結果 |
|---|---|
| 上傳 Worker，連同 Durable Object 的 migration | 做得到 |
| 設排程 `0 * * * *` | 做得到 |
| `workers_dev: false`、`preview_urls: false` | 做得到。部署後用同一把權杖 `GET …/workers/scripts/iamreal-test/subdomain`，回 `enabled: false`、`previews_enabled: false` |
| `wrangler tail --env test`，讀即時的紀錄 | 做得到 |
| 讀 R2 儲存桶的資料（`GET …/r2/buckets/iamreal-test-data`，wrangler 部署時自己送的） | 做不到：`Authentication error [code: 10000]`。wrangler 寫在本機的紀錄檔記這個回應是 `Unauthorized 401` |
| 列出帳號的 Durable Object namespace（`GET …/workers/durable_objects/namespaces`）、列出自訂網域（`GET …/workers/domains`） | 做不到：部署後用同一把權杖各送一次，都回 `403` 和同一個錯誤代碼 |

**第一次試沒有部署成功。** 14:29 跑 `pnpm run deploy:test`，那時它給 wrangler 的參數是 `deploy --env test`。wrangler 在上傳之前問 Cloudflare 儲存桶 `iamreal-test-data` 在不在（它會自動建不存在的資源），權杖讀不了 R2，wrangler 就停在這裡，什麼都沒上傳：

```
✘ [ERROR] A request to the Cloudflare API (/accounts/<帳號編號>/r2/buckets/iamreal-test-data) failed.

  Authentication error [code: 10000]
```

指令加上 `--experimental-provision=false` 之後 wrangler 不問這一題，部署成功。權杖沒有換，也沒有加權限。

關於這個參數：

- 它是 wrangler 4.160.1 的隱藏參數，每個指令都收，`wrangler deploy --help` 不列；預設是 `true`，別名 `x-provision`。升級 wrangler 時要確認它還在。
- 設成 `false` 只是跳過「資源在不在、要不要建」那一步，上傳的內容不變。
- 什麼時候非帶不可：Worker 上還沒有這個 binding 的時候，也就是第一次部署和之後新增 binding。照 wrangler 的程式讀，已部署的 Worker 上有同名、同 `bucket_name` 的 binding 時它不會去問 R2，所以之後不帶應該也過；這一點沒有試過。
- 儲存桶是營運者在儀表板建的（ADR-0029），部署不該建任何資源，所以指令一律帶著。

部署沒有動到儀表板上設的自訂網域。從本機 `curl` `https://test.iamreal.tw/`：部署前（14:29）回 `200`、`content-length: 12`，是部署前就在那個 Worker 上的程式；部署後（14:30）每個網址都回 `404`、沒有內容，就是骨架現在的行為。

部署時 wrangler 印一則警告：設定檔最上層沒有 `name`。那是故意的（見「設定檔」）；有警告時 wrangler 會問 npm 有沒有新版（見「套件」）。

### 從 Cloudflare 抓得到內政部的兩個清冊網址

排程第一次在 Cloudflare 上跑，是 15:00 那一次：排定的時間 15:00:12.752，13,261 毫秒跑完，CPU 時間 72 毫秒，結果是 `ok`。兩份都抓到、都存進 R2：

| | G2 | G3 |
|---|---|---|
| 網址 | `http://moica.nat.gov.tw/repository/MOICA/CRL2/complete.crl` | `http://crl-moica.moi.gov.tw/crl/MOICA-G3-complete.crl` |
| 排程印的 `result` | `stored` | `stored` |
| 大小 | 16,893,934 位元組 | 8,818,913 位元組 |
| SHA-256 | `9f7785eca72a4e94d0418345e7961d5376cc44bb8831b3e6f748df375a712a19` | `ebd20bbd621375da8bd7b75fabcc309ebd0db4ad12ce1289e4e80752a9e0c18f` |
| R2 記的寫入時間 | 15:00:19 | 15:00:26 |
| 清冊的 `thisUpdate`、cRLNumber | 09:11:05、2026111917 | 09:11:54、2026111917 |

- **狀態碼**：排程的紀錄不印狀態碼。`stored` 只有在收到完整的 `200` 時才會出現（見「排程做什麼」），所以兩個都是 `200`。
- **花的時間**：排程的紀錄也不印每一份花多久。兩份同時開始抓；從排程開始（15:00:13.551）到 R2 記的寫入時間，G2 約 6 秒，G3 約 13 秒，包含抓、算 SHA-256、寫入。R2 的時間只到秒。離每一份 5 分鐘的上限很遠。
- **下載得到**：`https://test-data.iamreal.tw/crl/<SHA-256>.crl` 兩個都回 `200`，`Content-Length` 和上表相同，`Cache-Control` 是 `public, max-age=31536000, immutable`；下載回來重算的 SHA-256 和檔名相同，`openssl crl` 讀得出兩份都是內政部憑證管理中心簽發的清冊。回應沒有 `Content-Type`：鏡像寫入時沒有設。
- 這些數字來自 `wrangler tail --env test --format json`（同一把權杖）和資料網域的回應標頭。只看了這一次排程，沒有從別的地方對內政部的網址送請求。

還沒看過的：內政部回錯誤、斷線、逾時的時候，Cloudflare 上的行為和本機的 workerd 是不是一樣（「排程做什麼」最後一段寫的那兩件事）。

## 套件

都釘精確版本。

在 Worker 裡執行的套件只有一個：

- `msgpackr` 1.12.1：呼叫 Barretenberg 的 WASM 用的編碼，和 bb.js 6.0.0 用的是同一版（[#59](https://github.com/iamreal-tw/iamreal/issues/59)）。只有 [`src/barretenberg.ts`](src/barretenberg.ts) 引用它

四個開發用的套件：

- `wrangler`（連帶 `miniflare`、`workerd`、`esbuild`）：在本機跑 Worker、打包、部署
- `typescript`、`@types/node`：型別檢查，版本和 `protocol/`、`web/` 相同
- `@aztec-foundation/bb.js` 6.0.0：只在建置時讀它裡面的 WASM 檔（[驗證證明](#wasm-檔和驗證金鑰從哪裡來)），它的程式不進 Worker。`web/` 用的是同一版，lockfile 裡本來就有

部署出去的程式裡的外部套件就是 `msgpackr`，另外帶 WASM 檔和兩把驗證金鑰：清冊鏡像用 Poseidon2 建樹，它們跟著進了部署的那一包。

沒有任何套件的安裝腳本會執行。有安裝腳本的三個套件列在根目錄 `pnpm-workspace.yaml` 的 `ignoredBuiltDependencies`：`workerd` 和 `esbuild` 的執行檔是各自平台的套件直接帶的，安裝腳本沒跑也能用；`msgpackr-extract` 是 `web/` 那邊的。

wrangler 執行時對外送的東西：使用統計關掉了（設定檔的 `send_metrics`，指令再加 `WRANGLER_SEND_METRICS=false`）。它印開頭那一行時會問 npm 有沒有新版，測試和部署的指令用 `WRANGLER_HIDE_BANNER=true` 關掉那一行；設定檔有警告或 wrangler 自己出錯時，它還是會問。

## 檔案

| 檔案 | 內容 |
|---|---|
| `wrangler.jsonc` | Worker 專案的設定 |
| `src/index.ts` | 進入點：HTTP（現在都回 `404`）和排程 |
| `src/mirror.ts` | 清冊鏡像：介面 `CrlMirror` 和在 Worker 裡做的那一個 |
| `src/crl.ts`、`src/crl-time.ts` | 讀一份清冊：可不可用、原因代碼、索引那一行的欄位、樹的鍵 |
| `src/crl-tree.ts` | 從鍵算樹根 |
| `src/crl-index.ts` | 索引的寫法和順序、最新兩份可用的清冊 |
| `src/roster.ts` | 名冊的 Durable Object：現在只存最新的清冊 |
| `src/target.ts`、`src/issuers.ts` | 部署用的發證金鑰、清冊網址、時鐘、等清冊的上限、補舊檔的界線 |
| `src/in-worker.ts` | 在 Worker 裡用的 `proofVerifier` 和 `poseidon2Hash`：把下面幾個檔和 WASM 檔、驗證金鑰接起來，只有它引用 `generated/` |
| `src/verify.ts` | 驗證證明的介面 `ProofVerifier`、呼叫 Barretenberg 之前的檢查 |
| `src/poseidon2.ts` | Poseidon2 的雜湊 |
| `src/circuits.ts` | 接受的電路：名稱、公開輸入的個數、驗證金鑰的 SHA-256。`worker/` 裡電路的清單只有這一份 |
| `src/engine.ts`、`src/barretenberg.ts` | Barretenberg 的實例（丟例外或答覆不對就換）、WASM 的載入程式 |
| `scripts/engine-files.ts` | 建置的第一步：核對 WASM 檔和驗證金鑰的 SHA-256，寫進 `generated/` |
| `test-build/` | 測試專用的建置換上的那一份 |
| `test/harness.ts`、`test/build.ts`、`test/proofs.ts` | 測試的工具、兩種建置、`verifier/testdata/` 的測試證明和驗證的測試共用的小工具 |
| `test/crls.ts` | 測試的發證金鑰、用它們簽的清冊 |
| `test/crl-testdata.test.ts` | 清冊鏡像和 Go 的 `crl/` 逐案比對（第三項要有 `go`） |
| `test/mirror-faults.test.ts` | 清冊鏡像出錯和遇到大東西的時候：拿不到行的檔、拖時間的檔、太大的回應、超過一頁的儲存桶、之前留下的檔、兩輪同時寫索引 |
| `test/engine.test.ts` | Barretenberg 丟例外、答覆不對、跑不起來時的行為（在 Node 裡，用假的實例） |
| `test/compare.test.ts` | 和原生的 `bb verify` 逐案比對（要設 `IAMREAL_BB`） |
| `test/*.test.ts` | 測試 |
| `scripts/dev.ts` | `pnpm dev` |
| `scripts/deploy-test.ts`、`scripts/deploy.ts` | `pnpm run deploy:test`；它給 wrangler 的參數、怎麼讀權杖、給 wrangler 的環境 |

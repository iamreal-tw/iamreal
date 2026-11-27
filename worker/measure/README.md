# worker/measure/：上線前的負載量測

**這個目錄讓人檢查的事：#52 和 #196 要負載的那幾個數字是怎麼量的。** 一個臨時的 Worker `iamreal-measure`、兩個臨時的儲存桶，營運者一次量完、量完全部刪掉。量到的數字寫回 [`worker/README.md`](../README.md)「上線前的量測」。

要量的：

| | 量什麼 | 灌了什麼 |
|---|---|---|
| 重建 | 從證明紀錄重建十萬筆要多久（[從證明紀錄重建](../README.md#從證明紀錄重建)） | 十萬筆做出來的紀錄，每筆一張不同的卡片 |
| 大小 | 每張卡片在物件裡佔多少位元組、每張表幾列 | 重建完的十萬張卡片 |
| 頁面 | 同一個 Durable Object 一秒回答幾個島民證明的頁面 | 同上，每一頁挑一張隨機的卡片，快取沒命中 |
| 寫入 | 證明紀錄的物件一秒寫得了幾筆（物件那一側），寫的時候頁面慢多少 | 同上 |
| 計數 | 收計數的物件一秒收多少（[計數](../README.md#計數)） | 不用 |
| 換日公布 | #196：十萬張卡片時公布多久、這段時間過卡的請求最久等多久 | 重建完的十萬張卡片 |

## 這是不驗證證明就寫入的建置

[`measure-build/index.ts`](../measure-build/index.ts) 是部署的 Worker 和它的兩個物件（`src/index.ts`），前面加幾個 `/__measure/` 的門。其中兩個寫入的東西沒有人驗證過：

- 做出來的證明紀錄（[`measure-build/log.ts`](../measure-build/log.ts)）：每一筆每個欄位的格式都對（`spec/record.md`「Check a line」），證明是同樣長度的隨機位元組。重建不驗證證明（ADR-0033 的重建只重做紀錄規則），所以拿得來量重建
- 寫入的門（`/__measure/write`）：和 `POST /api/v1/records` 一樣向物件拿題目、計次、讓它收下一筆，中間少了驗證。驗證是在 Worker 裡做的，不佔物件（[送出一筆](../README.md#送出一筆)）；這裡量的就是物件那一側。驗證那一側的 CPU 時間在測試網站上用真卡片量（`worker/README.md`「營運者用真卡片過卡時看的」）

**為什麼不違反 ADR-0028**：ADR-0028 擋的是測試網站或正式網站收下假卡片，所以發證金鑰不是設定值、假的發證金鑰不進任何建置。這個建置裡沒有假的發證金鑰，認的仍然是內政部的兩把（`src/target.ts`）；它沒有驗證任何一張卡片，而是不驗證。做出來的紀錄只寫進這個臨時 Worker 自己的物件（名稱 `test-measure`）和自己的兩個儲存桶，不進測試的證明紀錄，也不進正式的；量完 Worker、物件、儲存桶都刪掉。

只能部署成這一個 Worker：

- [`config.ts`](config.ts) 每次從 `wrangler.jsonc` 的測試環境做出設定，名稱固定是 `iamreal-measure`、儲存桶固定是 `iamreal-measure-data` 和 `iamreal-measure-logs`，只開 `workers.dev`，沒有排程（清冊鏡像不跑，不對內政部送任何請求）、沒有路由；名稱是 `wrangler.jsonc` 裡任何一個環境的、多了排程或路由、用了別的儲存桶，就拒絕
- [`deploy.ts`](deploy.ts) 只讀營運者自己的權杖檔裡的 `CLOUDFLARE_API_TOKEN_MEASURE`，不讀 `.env.local` 那把部署測試網站的
- 部署測試網站、之後的正式網站用的檢查（`scripts/deploy-build-checks.ts` 的 `NOT_DEPLOYED`）看到 `measure-build`、`/__measure/`、`MEASURE_KEY` 就失敗；沒有任何工作流程、`package.json` 的指令跑這個目錄（[`test/measure.test.ts`](../test/measure.test.ts)、[`test/bundle.test.ts`](../test/bundle.test.ts)）

**門要密碼。** 門開在公開的 `workers.dev` 網址上，所以要帶營運者自己產生、自己設在 Worker 上的密碼（Worker 的 secret `MEASURE_KEY`，請求帶 `Authorization: Bearer <密碼>`）。沒設、設的不到 32 個字、帶錯或沒帶，`/__measure/` 底下都是部署的 Worker 回的 `404`。密碼不經過維護者或 agent。

| 門 | 做什麼 |
|---|---|
| `POST /__measure/log-file` | 在 Worker 裡做一個寫滿的紀錄檔（1,000 筆），寫進資料儲存桶。不碰物件：物件第一次啟動時就開始重建，檔要先在 |
| `POST /__measure/fingerprints` | 寫一行的指紋檔 |
| `GET /__measure/size` | 物件的 `databaseSize` 和每張表的列數 |
| `GET /__measure/short-ids?n=` | 隨機的 n 個短編號 |
| `POST /__measure/crls` | 給物件一份今天的 G3、G2 清冊，樹根是做出來的紀錄用的那一個 |
| `POST /__measure/write` | 一筆寫入（拿題目、計次、收下），一張新的卡片 |
| `POST /__measure/publish-now` | 讓今天的公布現在就到期：拿掉今天那一行、物件的第一天改成昨天、儲存桶的指紋檔照剩下的行重寫、alarm 現在響 |
| `GET /__measure/count-events?date=` | 那一天每分鐘的計數明細檔各收了幾筆、超過上限沒留下幾筆 |

設定和部署的 Worker 不同的地方只有這些：物件的名稱 `test-measure`、停止收過卡（重建要）、重建的名稱 `measure-1`、每分鐘的計數上限 100,000（能設的最大值）、沒有照 IP 的上限（綁定不在時放行，每個請求寫一行 `rate_limit_unavailable`，可以接受）、沒有 Static Assets（每個網址都跑 Worker）。停止收過卡只擋網站的介面：寫入的門直接問物件，物件重建完就收。

## 在本機先跑一次

```sh
cd worker
node --experimental-strip-types measure/smoke.ts
```

[`smoke.ts`](smoke.ts) 用部署時做的同一份設定在本機的 workerd 跑這個建置，密碼是那一次自己產生的，然後跑 `load.ts all --quick`（2,000 筆、每一級 3 秒、計數一分鐘）。不對外送任何請求，約 3 分鐘。不是 `pnpm test` 的一部分。

2026-11-27 在開發用的 Mac 上跑的（本機的 workerd 不限 CPU 和記憶體，**只說明每一步走得通和量級**，不是 Cloudflare 上的數字）：

- 產生 2,000 筆 1 秒，一檔 19,977,000 個位元組；重建 4 秒，`swapped`
- 2,000 張卡片時整個物件 3,178,496 個位元組，平均一張 1,589（含固定的部分）；`cards`、五張衍生表各 2,000 列，`challenges` 0 列（紀錄是兩天前的，用過的題目不留）
- 頁面：同時 2 個每秒 628 個、4 個每秒 702 個，p99 12 ms
- 寫入：同時 1 個每秒 88 筆、2 個每秒 132 筆；旁邊 5 個讀頁面的從每秒約 700 個掉到 442、327
- 計數：同時 2 個，一分鐘送了 40,920 筆、明細檔收了 40,920 筆
- 公布 2,661 張卡片 0.3 秒，一個請求最久等了 274 ms

## 營運者要做的

一次做完約一到兩小時（產生和重建十萬筆的時間還不知道，本機的比例推是十幾分鐘）。費用：儲存桶存 2 GB 一天、百萬次以下的請求，可以忽略。

**之前（在 Cloudflare 的儀表板，ADR-0029：後台以外的設定由營運者做）**

1. R2 → 建兩個儲存桶：`iamreal-measure-data`、`iamreal-measure-logs`。位置 Automatic、存放等級 Standard；**不設**公開網域、CORS、生命週期規則
2. Workers & Pages → 建一個 Worker，名稱 `iamreal-measure`，用 Hello World 的範本。先有這個 Worker，下一步的權杖才能只限定它。它的 `workers.dev` 網址（`https://iamreal-measure.<子網域>.workers.dev`）記下來
3. 建一把 Account API token，和測試網站的那兩把同一種：範圍「Specified Workers → `iamreal-measure`」、權限「Individual Workers: Editor」，有到期的選項就設 2 天。寫進自己電腦上一個**不在程式庫裡**的檔，只有自己讀得到：

   ```sh
   (umask 077 && cat > ~/.config/iamreal/measure.env)   # 貼上下面兩行，按 Ctrl-D
   ```

   ```
   CLOUDFLARE_API_TOKEN_MEASURE=<權杖>
   CLOUDFLARE_ACCOUNT_ID=<帳號編號>
   ```

**部署和密碼（在程式庫的 `worker/`）**

4. 部署：`node --experimental-strip-types measure/deploy.ts deploy --token-file ~/.config/iamreal/measure.env`
5. 產生密碼、設給 Worker，密碼留在這個終端機：

   ```sh
   export MEASURE_KEY="$(openssl rand -hex 32)"
   printf %s "$MEASURE_KEY" | node --experimental-strip-types measure/deploy.ts secret --token-file ~/.config/iamreal/measure.env
   ```

**量（同一個終端機）**

6. `node --experimental-strip-types measure/load.ts https://iamreal-measure.<子網域>.workers.dev all | tee ~/measure-$(date +%F).txt`
   - 第一步印請求進的是哪個機房（`cf-ray`）；不是台灣附近的（`TPE`、`KHH`、`HKG` 等）就停下來：往返的時間會在每一個數字裡。換一個網路再跑
   - 每一步印開始和結束的時間（UTC）：同一段時間到儀表板看下一步
   - 某一步出錯時，從那一步重跑就好（`load.ts <網址> <那一步>`）；**`generate` 之前不要跑會問物件的步驟**，物件第一次啟動時就重建，檔要先在。`generate` 中途斷掉的話，刪掉兩個儲存桶的內容和 Worker（連同物件）重來
7. 量的同時，或量完當天，在儀表板記下：
   - Durable Objects → `iamreal-measure` 的 `ProofLog` 那個 namespace → Metrics：重建、寫入、公布那幾段時間的 CPU 時間、記憶體（Memory usage 的 P999；#196 要知道 SQLite 複製表用的記憶體算不算在 128 MB 裡）、rows read / rows written、儲存的大小
   - Workers & Pages → `iamreal-measure` → Metrics：CPU 時間、錯誤
   - 同一個 namespace 的 `Counts`：計數那一段的 CPU 時間和記憶體
8. 把第 6 步的檔和第 7 步的數字交給維護者，寫進 `worker/README.md`。檔裡沒有 IP、密碼和帳號；截圖不要有帳號名稱

**量完刪掉（當天）**

9. Workers & Pages → `iamreal-measure` → Settings → Delete。它的 Durable Object（連同十萬張做出來的卡片）跟著刪
10. R2 → 兩個儲存桶各自先清空（Objects → 全選 → Delete；或 Settings 裡的清空），再 Delete bucket
11. 刪掉第 3 步的權杖（Manage Account → API Tokens），和那個檔：`rm ~/.config/iamreal/measure.env`
12. `unset MEASURE_KEY`，關掉那個終端機
13. 在 #52、#196 回報刪完了

## 檔案

| 檔 | 內容 |
|---|---|
| [`config.ts`](config.ts) | 從 `wrangler.jsonc` 做出臨時 Worker 的設定，名稱和儲存桶不對就拒絕 |
| [`deploy.ts`](deploy.ts) | 部署、設密碼，用營運者的權杖檔 |
| [`load.ts`](load.ts) | 負載的每一步 |
| [`smoke.ts`](smoke.ts) | 在本機的 workerd 跑一次小的 |
| [`../measure-build/`](../measure-build) | 這個 Worker 的入口和做出來的證明紀錄 |

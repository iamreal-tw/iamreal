# worker/：後台

**這個目錄讓人檢查的事：規則有照做。** 這裡是 Cloudflare 上的後台（ADR-0023），一個 Worker 專案。名冊規則、場合字串這些算法在 [`protocol/`](../protocol)，這裡只引用它，不引用這個程式庫的其他目錄。

## 現在有什麼

現在只有骨架。舊的後台 [`server/`](../server)（Go）還在，還是對照。

| 有 | 還沒有 |
|---|---|
| 每小時的排程：抓內政部的兩份廢止清冊，原始位元組存進 R2 的 `crl/<SHA-256>.crl` | 驗清冊的簽章、建樹、清冊存檔的索引 `crl/index.jsonl` |
| 名冊的 Durable Object：設定、binding、migration，類別是空的 | 寫入紀錄、題目、卡片狀態 |
| 測試專用的建置和測試的工具 | 任何頁面和 API：每個網址都回 `404` |
| 部署測試環境的指令 | 部署本身，和 GitHub Actions 的工作流程 |

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
- [`test-build/`](test-build) 是測試專用的建置換上的那一份：`target.ts` 是測試當場產生的發證金鑰（私鑰不留下）、假的內政部的網址、可以調的時鐘；`index.ts` 是進入點，在 Worker 前面多一個調時鐘的開關 `PUT /__test/clock`。
- 怎麼換：[`test/build.ts`](test/build.ts) 跑 `wrangler deploy --dry-run`，用 `--alias` 把 `#target` 指到 `test-build/target.ts`，進入點換成 `test-build/index.ts`，金鑰和網址用 `--define` 帶進去。wrangler 的設定檔和部署的指令裡沒有這些參數，所以部署的建置拿到的一定是 `src/target.ts`。
- [`test/bundle.test.ts`](test/bundle.test.ts) 用部署的指令（加 `--dry-run`）把要上傳的那一包打出來，檢查裡面只有內政部的兩個網址和兩把金鑰，沒有測試的金鑰、假的內政部、時鐘的開關；再把測試專用的建置也打出來，確認這些字串在那一包裡找得到。

Worker 載入時檢查發證金鑰是一把 2048 位元的 G2 和一把 4096 位元的 G3，不是就不啟動。

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

每小時一次（[`src/mirror.ts`](src/mirror.ts)）：

1. 依序抓 G2、G3 的清冊。
2. 回應是 `200` 時，算內容的 SHA-256。R2 裡已經有 `crl/<SHA-256>.crl` 就不重存；沒有才寫入，`Cache-Control` 是 `public, max-age=31536000, immutable`（檔名就是內容的雜湊，內容不會變）。
3. 其他狀態或連不上時，那一份不存任何檔，另一份照常。兩份都試過之後，只要有一份失敗，這一次排程就以例外結束，在 Cloudflare 的紀錄上是失敗的一次。

寫進資料儲存桶的每個物件都要設 `Cache-Control`：資料網域的快取規則是「有就照它，沒有就不快取」。

每一份清冊寫一行紀錄，只在即時的輸出看得到（`wrangler tail` 或儀表板的即時紀錄），沒有開保存：

```
{"event":"crl_mirror","at":"2026-11-20T08:00:00.123Z","issuer":"G3","result":"stored","sha256":"…"}
```

`result` 是 `stored`（新的一份）、`already_stored`（已經有）、`failed`（附 `error`）。

### 內政部看得到什麼

- `User-Agent` 是一般的 `Mozilla/5.0 (compatible)`，不帶專案名稱。
- Cloudflare 會在 Worker 送出的每個請求加上 `CF-Worker` 標頭，值是這個 Worker 所在 zone 的名稱（[Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)）。這一項不是程式決定的。本機的 workerd 會模仿它，值是 Worker 的名稱加 `.example.com`。

## 測試的工具

[`test/harness.ts`](test/harness.ts) 的 `startWorker()`：打出測試專用的建置，在本機的 workerd 啟動整個 Worker（用 wrangler 的 `createTestHarness`），旁邊開一個假的內政部。之後每一張後台的票都用它。

| 測試要做的事 | 用法 |
|---|---|
| 送 HTTP 請求 | `worker.fetch("/路徑")`，或對 `worker.url` 用一般的 `fetch` |
| 觸發排程 | `worker.runSchedule()`，回傳 `outcome`（`ok` 或 `exception`） |
| 讀 R2 的模擬裡寫出來的檔案 | `worker.files("crl/")`：檔名、內容、`Cache-Control`、寫入時間 |
| 調時鐘 | `worker.setClock(new Date("…"))` |
| 假的內政部 | `worker.moica.serve("G2", 位元組)`、`worker.moica.fail("G3", 503)`、`worker.moica.requests` |
| Worker 寫的紀錄 | `worker.logLines()` |

測試不對內政部送請求。測試用 Node 內建的 test runner，和 `protocol/`、`web/` 相同。

## 型別檢查

Workers 執行環境的型別（`R2Bucket`、`DurableObject`……）和 `Env` 由 `wrangler types` 從設定檔和本機的 workerd 產生，寫到 `worker-configuration.d.ts`；這個檔不進版控，`pnpm typecheck` 每次重新產生。沒有另外裝型別的套件。

型別檢查分兩份設定，因為兩邊的全域型別不同：

- `tsconfig.json`：在 Worker 裡執行的程式（`src/`、`test-build/`），用上面產生的型別，沒有 Node 也沒有 DOM 的型別
- `test/tsconfig.json`：在 Node 裡執行的測試和指令（`test/`、`scripts/`）

## 部署測試環境

```sh
pnpm run deploy:test
```

[`scripts/deploy-test.ts`](scripts/deploy-test.ts) 讀程式庫根目錄的 `.env.local` 裡的兩行，`CLOUDFLARE_API_TOKEN_TEST` 和 `CLOUDFLARE_ACCOUNT_ID`，交給 `wrangler deploy --env test`。那把權杖只能部署 `iamreal-test`（ADR-0029）。不用 `wrangler login`。

- 環境固定是測試環境。唯一接受的參數是 `--dry-run`：只打包，不上傳。
- 這個指令還沒有實際部署過。第一次部署和它要確認的兩件事（從 Cloudflare 抓不抓得到內政部的 `http://` 網址、只有 `Editor` 的權杖能不能跑 Durable Object 的 migration）在 [#63](https://github.com/iamreal-tw/iamreal/issues/63)。
- 正式環境只從 GitHub Actions 部署，這裡沒有它的指令。

## 套件

只有一個開發用的套件 `wrangler`（連帶 `miniflare`、`workerd`、`esbuild`），釘精確版本。在本機跑 Worker、打包、部署都用它。部署出去的程式沒有任何外部套件。

pnpm 預設不執行套件的安裝腳本，這裡也沒有放行任何一個：`workerd` 和 `esbuild` 的執行檔是各自平台的套件直接帶的，它們的安裝腳本沒跑也能用。

## 檔案

| 檔案 | 內容 |
|---|---|
| `wrangler.jsonc` | Worker 專案的設定 |
| `src/index.ts` | 進入點：HTTP（現在都回 `404`）和排程 |
| `src/mirror.ts` | 清冊鏡像 |
| `src/roster.ts` | 名冊的 Durable Object（空的類別） |
| `src/target.ts`、`src/issuers.ts` | 部署用的發證金鑰、清冊網址、時鐘 |
| `test-build/` | 測試專用的建置換上的那一份 |
| `test/harness.ts`、`test/build.ts` | 測試的工具、兩種建置 |
| `test/*.test.ts` | 測試 |
| `scripts/dev.ts`、`scripts/deploy-test.ts` | `pnpm dev`、`pnpm run deploy:test` |

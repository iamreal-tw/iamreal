---
status: accepted（部分由 ADR-0025、ADR-0026 取代）
---

# 後台全部放在 Cloudflare，用 TypeScript 重寫

> Consequences 裡留待決定的三件事後來定了：完整重驗在哪裡跑（ADR-0025）、每張卡片的狀態怎麼存（ADR-0024 和它的票）、頁面的資料撐不住時搬去哪裡（ADR-0026 改成 KV 或 D1，到時候再定）。公開的檔案放在 `data.iamreal.tw`（ADR-0027）。其餘有效。

後台整個放在 Cloudflare 上，沒有自己管的機器。`server/` 用 TypeScript 重寫成一個 Worker 專案；`verifier/`、`roster/`、`crl/`、`cmd/` 的 Go 程式留著，當獨立的重驗工具。

先前的後台是一個 Go 程式加一個 SQLite 檔，是在電路還用 circom、驗證器的外層是 Go 的時候定的。電路改用 Noir 之後（ADR-0012），這個前提不在了。

各部分放在哪裡：

- **寫入**：一份名冊一個 Durable Object，是這份名冊唯一的寫入者。一個交易裡寫入整筆紀錄、給序號、更新這張卡片的狀態和頁面用的衍生表、把題目標成已接受，寫完才回應。
- **紀錄的正本**：R2 上的名冊目錄。Durable Object 只留還沒寫滿一檔的紀錄；寫滿 1,000 筆，把那一檔寫到 R2，讀回來核對後才刪掉自己的那 1,000 筆。檔名和內容都從紀錄算得出來，重做的結果相同。
- **驗證證明**：在 Worker 裡驗，不在 Durable Object 裡。送出一筆時，Worker 先請 Durable Object 檢查題目並算一次送出，自己驗證明，再請 Durable Object 檢查清冊樹根和名冊規則後寫入。檢查的順序和 `docs/api/card-proof.md` 相同。
- **訪客的頁面**：衍生表在同一個 Durable Object，和紀錄在同一個交易裡更新。Worker 產生 HTML，產生好的頁面在 Cloudflare 的快取最多放 60 秒。題目、卡片現況、送出不快取。
- **清冊鏡像**：Cron Trigger 每小時抓內政部的清冊，原始檔存 R2；檔案和上一次相同就停，不同才驗章、建樹、算樹根。
- **名冊指紋**：Durable Object 每寫入一筆就更新滾動的雜湊（ADR-0021），每天台灣時間換日時在指紋檔加一行。
- **靜態檔**：過卡的頁面（`web/` 建置出來的檔案、電路檔、通用參數）用 Workers Static Assets；清冊、名冊目錄、雜湊清單、指紋檔放 R2。這些下載不經過後台的程式。
- **部署**：一個 Worker 專案，過卡的頁面和後台同一個提交、同一次部署。

理由：

- **營運者只有一個人，維護簡單排第一。** 自己管一台機器，作業系統更新、TLS、備份和還原演練、監控、機器壞掉時重建都是持續的工作，而且沒有自動切換。重寫是一次的代價。
- **每件事都對得到元件。** 限制和出處整理在[整個後台放在 Cloudflare 上，有哪些元件可用、各有什麼限制](https://github.com/iamreal-tw/iamreal/issues/6)。
- **驗證在 Workers 上做得到。** 用 Workers 允許的載入方式，WASM 的驗證和原生的 `bb verify` 在 1,123 個案例上通過或拒絕全部相同（[實測](https://github.com/iamreal-tw/iamreal/issues/16)）。
- **Durable Object 和 R2 之間沒有共同的交易，設計成不需要。** 紀錄先完整落在 Durable Object，才算接受；搬到 R2 是之後的事，失敗就重做。
- **資料庫的大小跟卡片數走，不跟紀錄數走。** 一個 Durable Object 的 SQLite 上限 10 GB（[limits](https://developers.cloudflare.com/durable-objects/platform/limits/)），一筆紀錄約 20 KB，帶證明的紀錄不能長期留在裡面。
- **留著 Go 的重驗工具，是要有兩份獨立的實作。** 後台收錯一筆時，拿名冊用另一份實作重算會發現。這幾個目錄照的是協定規格，上線後很少改。重寫後台時，Go 版也是逐案比對的對照。

## Considered Options

- **一台自己管的機器，Go 程式加 SQLite，前面放 Cloudflare**：架構最直白，程式幾乎不用重寫。沒有採用，因為上面第一條的那些工作都落在營運者身上，機器壞掉時寫入和沒被快取的頁面一起停。
- **代管的容器平台加代管的資料庫**：零件數和全部放 Cloudflare 差不多，還要維護容器映像檔，資料庫要改寫。
- **在 Cloudflare Containers 跑現有的 Go 執行檔**：磁碟不保留、隨時可能被停掉，SQLite 檔不能放在上面（[Containers FAQ](https://developers.cloudflare.com/containers/faq/)）。
- **重驗工具也改成 TypeScript，程式庫只剩一種語言**：後台和重驗工具會是同一份程式，錯會錯在一起。
- **證明在 Durable Object 裡驗**：少一次呼叫，但驗證的運算會佔住唯一的寫入者。
- **衍生表一開始就另外放一份到 D1，頁面只讀 D1**：頁面被大量請求打垮時不影響寫入。沒有先做，因為題目、卡片現況、送出本來就直接打到寫入者，限流無論如何要做；多一個儲存和一段同步，換到的保護有限。

## Consequences

- **要 Workers 的付費方案。** 免費方案每個請求的 CPU 時間是 10 ms，驗一筆約 12 ms（[limits](https://developers.cloudflare.com/workers/platform/limits/)）。
- **驗證和清冊鏡像各放在換得掉的介面後面。** 超過 Workers 的限制時，改成在 Cloudflare Containers 跑原生的 `bb` 和 Go 的 `crl/`，其他部分不動。
- **清冊鏡像在 Worker 裡做得完，但讀清冊時不能每一筆建一個物件。** 本機的 workerd 裡，一次排程抓兩份清冊、存 R2、驗章、建樹共 35 秒，樹根和 Go 的 `crl/` 相同；每小時一次的排程上限 15 分鐘（[實測](https://github.com/iamreal-tw/iamreal/issues/26)、[limits](https://developers.cloudflare.com/workers/platform/limits/)）。照 `web/src/crl/crl.ts` 的寫法讀 G2 要 132 MB，超過 Worker 的 128 MB；鍵直接寫進 `Uint32Array` 時全程約 35 MB。Poseidon2 用驗證證明的同一份 WASM。建樹時分組做、組和組之間讓出執行緒，免得擋住同一個實例裡的請求。Cloudflare 上真的 CPU 時間、抓不抓得到內政部的 `http://` 網址，部署到測試網站時確認。
- **WASM 的驗證要照實測的兩條做**：任何例外都算拒絕，並丟掉那個實例；呼叫之前先做 `verifier/verify.go` 在呼叫 `bb` 之前做的檢查。
- **名冊規則有兩份實作**，Go 的在 `roster/`，TypeScript 的給後台和裝置用，兩份讀 `spec/vectors/` 同一份標準答案。規則要改時兩邊一起改。
- **名冊檔寫滿就公開，不等每天。** 每天公布的是指紋檔的一行。ADR-0014 寫的「後台每次發布快照前自己完整重算」跟著改。完整重驗在哪裡跑、多久一次，已經定在 ADR-0025（討論在[名冊變大之後，每日快照怎麼重驗](https://github.com/iamreal-tw/iamreal/issues/22)）。
- **現況不放記憶體。** Durable Object 閒置時會被移出記憶體，名冊規則要的每張卡片的狀態存在它的 SQLite，寫入時只讀寫那一張卡片。存法已經定了：狀態自己一張表、一張卡片一列、和紀錄同一個交易寫入，結論在[名冊規則要的每張卡片狀態怎麼存](https://github.com/iamreal-tw/iamreal/issues/9)；順帶改的規則是 ADR-0024。
- **讀取和寫入擠在同一個 Durable Object。** 大量請求打不同的網址時快取幫不上，Durable Object 忙不過來，頁面和過卡會一起失敗；已經寫入的紀錄不會掉。靠限流和查不到的結果也快取來擋；讀取量量出來撐不到尖峰，或真的被這樣打過，就把衍生表複製到 D1（ADR-0026 改成搬到 KV 還是 D1 到時候再定）。
- **儲存的位置不能固定在台灣。** 亞洲只有盡量的提示（[data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)）。放在上面的資料大多本來就公開；不公開的是還沒用掉的題目和連線紀錄（ADR-0022）。隱私權說明照實寫。
- **Go 的 `server/` 在 TypeScript 的後台逐案比對通過後刪掉。** `CLAUDE.md` 的目錄表和「Go 的程式是同一個模組」那幾句跟著改。

# server

過卡的後台：發題目、回答一張卡片的現況、收證明並寫入名冊、鏡像內政部的廢止清冊、每天出快照。介面照 [`docs/api/card-proof.md`](../docs/api/card-proof.md)。

**這個目錄讓人檢查的事：規則有照做。** 名冊規則只有一份，在 `roster/`；這裡不重寫任何一條。現況、「這一筆寫進去會不會有效」都由 `roster.Rules` 回答，每一行紀錄的寫法、`seq`、`prev` 由 `roster.ReadLine` 檢查，證明由 `verifier/` 驗，清冊由 `crl/` 讀。這裡只多了名冊規則以外、只有後台能做的幾件事：題目（發、10 分鐘、最多送 5 次、只能接受一次）、只收最新兩份清冊的樹根、清冊太舊時停止接受。

只引用 `verifier/`、`roster/`、`crl/`，和 SQLite 的驅動。

## 怎麼單獨執行

需要 Go 1.26、`bb` 6.0.0 和通用參數檔 `bn254_g1.dat`（取得方式見 `verifier/README.md`）。在程式庫的根目錄：

```
go build -o iamreal-server ./server

./iamreal-server serve    -data DATA -bb <bb> -crs <通用參數目錄> [-addr 127.0.0.1:8080] [-web <靜態檔目錄>] [-roster test|production] [-mirror=false]
./iamreal-server mirror   -data DATA
./iamreal-server snapshot -data DATA -bb <bb> -crs <通用參數目錄> [-out <目錄>] [-roster test|production]
```

| 子指令 | 做什麼 |
|---|---|
| `serve` | 跑後台。開機時從資料庫讀出全部紀錄重算現況（見「開機」）；之後每分鐘刪掉過期的題目；`-mirror` 開著時（預設）一開始和之後每小時抓一次內政部的清冊 |
| `mirror` | 抓一次內政部的清冊就結束。任何一份抓不到時結束碼是 1 |
| `snapshot` | 每日快照（見「每日快照」）。可以在 `serve` 跑著的時候執行：它用唯讀的方式開資料庫 |

| 選項 | 預設 | 說明 |
|---|---|---|
| `-data` | （必填） | 資料目錄，見「資料放在哪裡」 |
| `-bb`、`-crs` | （必填，`mirror` 不用） | `bb` 6.0.0 的路徑、放 `bn254_g1.dat` 的目錄。版本或 SHA-256 不對就不啟動 |
| `-roster` | `test` | 接受哪一份名冊的場合：`test`（測試名冊）或 `production`（正式名冊） |
| `-addr` | `127.0.0.1:8080` | `serve` 聽的位址 |
| `-web` | （無） | `serve` 在 `/` 一起提供的靜態檔目錄（之後放 `web/` 建置出來的檔案）。沒給時 `/` 是 404 |
| `-mirror` | 開 | `serve` 要不要自己跑清冊鏡像 |
| `-out` | `DATA/roster` | `snapshot` 寫到哪個目錄 |

發證金鑰（驗證明、驗清冊）和內政部清冊的網址編在程式裡，沒有選項能換。**只有**用建置標籤 `iamrealtest` 建置的執行檔（`go build -tags iamrealtest ./server`，`testissuers.go`），三個子指令多兩個選項：`-test-issuers <目錄>`（放 `issuer-G2.der`、`issuer-G3.der`，拋棄式的測試金鑰，取代內政部的）、`-test-moica <網址>`（假的內政部，提供 `G2.crl`、`G3.crl`）。給 `web/` 的端到端測試（`web/test/e2e/ui.ts`）用：頁面算的假卡片的證明，由真的後台驗證、寫入。照這份 README 建置的執行檔沒有這兩個選項。

## 資料放在哪裡

```
DATA/iamreal.sqlite   名冊的紀錄、發出去還沒刪掉的題目
DATA/crl/             清冊鏡像：每份清冊的原始位元組（SHA256.crl）、索引 index.jsonl；在 /crl/ 提供
DATA/roster/          公布的名冊：名冊目錄（每 1,000 筆一檔）、鏈尾檔 heads.jsonl；在 /roster/ 提供
```

**SQLite 只有兩張表**（`store/sqlite.go`）：

| 表 | 欄位 | 說明 |
|---|---|---|
| `records` | `seq` 和紀錄的十個欄位，寫法和名冊的那一行相同 | 只增不改。紀錄雜湊不存，從欄位算 |
| `challenges` | 題目、發出的時間、送出的次數、是否已接受 | 發出後存起來；過期（10 分鐘）後由 `serve` 每分鐘刪一次 |

後台其他地方不碰 SQL，只經過 `store.Store` 這個介面：寫入一筆（`Append`，同一個交易裡把題目標成已接受，而且 `seq`、`prev` 必須接得上）、讀某一段（`Records`）、讀筆數和鏈尾（`Head`），加上題目的三個動作。之後證明搬到物件儲存、資料庫換掉，都只動 `store/`。

資料庫用 WAL 模式（快照可以邊讀）、`synchronous(FULL)`（寫入完成的紀錄斷電也不會掉）、一個連線（一個程式裡的讀寫一次一個）。

## 介面

照 `docs/api/card-proof.md`，欄位、狀態碼、錯誤代碼一字不差。所有回應是 JSON，帶 `Cache-Control: no-store` 和 `X-Request-Id`（這個請求在紀錄裡的請求編號，持卡人回報問題時說得出來）；不設 cookie，不送 CORS 標頭。

文件沒有列、這裡另外用到的三個錯誤代碼：

| 狀態 | 代碼 | 什麼時候 |
|---|---|---|
| `404` | `not_found` | `/api/` 底下沒有這個路徑 |
| `405` | `method_not_allowed` | 方法不對（例如 `GET /api/v1/records`），帶 `Allow` 標頭 |
| `500` | `internal` | 後台自己出錯（資料庫、`bb` 跑不起來、亂數來源）；原因記在紀錄裡，附請求編號 |

`429` `rate_limited` 的代碼留著，這一段沒有做限流。

請求的內容最多 64 KB。內容必須剛好是文件列的那幾個鍵、每個一次、值都是字串；多一個鍵、少一個鍵、同一個鍵兩次、鍵的大小寫不同、值不是字串、物件後面還有東西，都是 `malformed`（`request.go`）。

### 送出一筆的檢查順序（`submit.go`）

照介面文件的順序，第一個不通過的決定錯誤代碼：

1. **每個欄位的格式。** 場合不是這份名冊接受的是 `scope`，其他是 `malformed`。
2. **題目**：沒發過或已經過了 10 分鐘（剛好 10 分鐘就算過期）是 `challenge_unknown`；已經接受過一筆是 `challenge_used`；這次是第 6 次以上送出是 `challenge_attempts`。走到這一步就算一次送出，之後的檢查失敗，題目仍然可以再用，最多 5 次。
3. **驗證證明**（`verifier/`，`bb` 在子行程裡跑）：不通過是 `proof`。
4. **清冊的樹根**：這把發證金鑰在鏡像裡最新的清冊（照清冊編號，只算可用的）超過 3 天（今天的台灣日期 − 清冊日期 > 3）或一份都沒有，是 `503` `crl_stale`；樹根不是最新兩份之一的，是 `root`。
5. **名冊規則**（`roster.Rules.Check`）：`root`、`date_order`、`not_current`、`switch_limit`。

全部通過才寫入，寫入和題目標成已接受在同一個交易裡，再用 `roster.Rules.Apply` 更新記憶體裡的現況。步驟 4、5 和寫入在同一把鎖裡做，一次一筆：兩個請求同時送出時，`seq` 連續，鏈不斷；同一個題目同時送兩次，只有一次被接受，另一次是 `challenge_used`。

### 時間

所有日期都是台灣日期（UTC+8，固定時差，不讀機器的時區設定）。題目的日期是發出那一刻的台灣日期，所以 23:59:59 發的是當天，00:00:00 發的是隔天。時鐘在測試裡可以換掉（`Config.Now`）。

## 開機

`serve` 開機時從資料庫一筆一筆讀出全部紀錄，每一筆：

- 用 `roster.ReadLine` 檢查這一行的寫法、`seq`、`prev`（和重驗的人一樣）；
- 用 `roster.Rules.Apply` 套用規則。證明不重驗（寫入時驗過了，每日快照會全部重驗）；清冊的樹根照樣檢查，用鏡像的索引 `index.jsonl`。

任何一筆寫法錯、鏈斷掉、無效（包括它用的清冊不在鏡像裡了），就不啟動，印出是第幾筆、哪個代碼。

## 清冊鏡像（`mirror.go`）

內政部的兩個網址寫在 `mirror.go` 的 `moicaCRLs`（G2：`http://moica.nat.gov.tw/repository/MOICA/CRL2/complete.crl`，G3：`http://crl-moica.moi.gov.tw/crl/MOICA-G3-complete.crl`，和 `crl/README.md` 寫的相同）。清冊有內政部的簽章，用 HTTP 抓也能檢查。

- 每小時對每個網址送一次條件請求（`If-None-Match`、`If-Modified-Since`，用上一次回應的 `ETag`、`Last-Modified`）。`304` 就什麼都不做。這兩個值只放在記憶體：程式重開後第一次會整份下載，內容看過就不再存。
- 內容的 SHA-256 在索引裡已經有，就不存。沒有的話存成 `SHA256.crl`（64 個小寫十六進位數字），再用 `crl.IndexFile` 算出這一行，加進 `index.jsonl`、照規格排序。可用不可用都存、都列一行（規格「Archive index」）。
- 先寫成 `.` 開頭的暫存檔再改名，所以後台和下載的人不會讀到寫一半的檔案；`.` 開頭的檔案不算存檔的一部分，也不提供下載。
- `User-Agent` 是 Go 預設的 `Go-http-client/1.1`，不帶專案或個人資訊。

## 每日快照（`snapshot.go`）

一個子指令，排程每天跑一次。

1. 讀出全部紀錄，接成名冊檔案。
2. 用 `crl.RebuildArchive` 從清冊檔案重建索引（重新驗章、建樹）。和 `index.jsonl` 有任何不同就不發布。
3. 用 `roster.Check` 完整重算：每一份證明都用 `bb` 重驗。名冊不成立、或有任何無效的紀錄，就不發布，印出是哪一筆、哪個代碼（ADR-0014）。
4. 已經公布的檔案必須是現在名冊的開頭：寫滿的檔位元組相同，最後一個檔是現在那個檔的開頭；`heads.jsonl` 的每一行都要是這份名冊的鏈尾。不是的話不發布。
5. 寫名冊目錄（每 1,000 筆一檔，檔名是第一筆的 `seq` 寫成 16 位數字），**寫滿的檔不重寫**；最後在 `heads.jsonl` 加今天（台灣日期）一行。

結束碼：`0` 發布了（或今天已經發布過同一個鏈尾，什麼都不用做）；`1` 有東西不對，什麼都沒寫；`2` 沒辦法檢查（讀不到檔案、`bb` 不對）。同一天第二次跑、但名冊多了紀錄時，因為一個日期只能有一行，結束碼是 `1`。

## 連線紀錄記了什麼（`log.go`）

`/api/` 的每一個請求一行 JSON，寫到標準錯誤，**只有**：時間、請求編號（每次隨機產生）、方法、路徑（不是五個介面之一時寫 `other`）、狀態碼、錯誤代碼、程式版本（建置時的 git 提交）。

**不記**：IP 位址和連接埠（連 `X-Forwarded-For` 之類的標頭也不讀）、任何標頭、請求的內容：匿名編號、帳號名稱、題目都不記。要題目的請求不記題目本身。五個介面用同一條規則，所以沒有哪一個會記錯。`net/http` 自己的錯誤訊息可能含有對方的位址，所以只記「出了錯」，不記內容。靜態檔（`/crl/`、`/roster/`、網頁）不記。

後台自己出錯時另記一行，附請求編號和出錯的地方，不附請求的內容。

## 回應標頭

所有回應都送的標頭寫在 `headers.go` 的 `responseHeaders`：`X-Content-Type-Options: nosniff`。`-web` 目錄的每個檔案（頁面、它的程式和 worker、電路、通用參數）另外送 `pageHeaders`：`web/README.md` 寫的 `Content-Security-Policy`、`Document-Isolation-Policy: isolate-and-credentialless`（多執行緒的證明，同時保留和內政部元件視窗的來往）和 `Cross-Origin-Opener-Policy: same-origin-allow-popups`（用 `window.open` 開了這一頁的別的網站，碰不到這一頁和它開的元件視窗）。理由在 `web/README.md`「頁面需要的標頭」；`server_test.go` 檢查那裡引用的和這裡一字不差。清冊鏡像和名冊不送這三個。

靜態檔：`.crl` 是 `application/pkix-crl`，`.jsonl` 是 `application/jsonl`。不列目錄，`.` 開頭的檔案不提供。

## 測試

```
go test ./server/...
IAMREAL_BB=/path/to/bb go test -tags iamrealtest ./server    # 加上真證明的端到端測試
go test -race ./server/...
```

| 檔案 | 測什麼 |
|---|---|
| `store/sqlite_test.go` | 鏈接不上（跳號、重號、`prev` 錯）就不寫；題目沒發過或已接受就不寫紀錄；送出次數；刪過期題目；重開、唯讀 |
| `api_test.go` | 每個介面每個錯誤代碼：題目的日期在台灣午夜前後；`card-state` 的每一種 `malformed`，回應的欄位順序；`records` 的每一種 `malformed`、`scope`、`challenge_unknown`（沒發過；剛好 10 分鐘；差 1 奈秒仍可用，跨過午夜）、`challenge_used`、`challenge_attempts`（失敗 4 次後第 5 次仍可成功；失敗 5 次後第 6 次被擋）、`proof`、`root`（第三新的清冊、別把金鑰的樹根、不存在的樹根）、`crl_stale`（清冊日期後第 3 天 23:59:59 可以、第 4 天 00:00:00 不行；新清冊進來後恢復；這把金鑰沒有清冊）、`date_order`、`not_current`、`switch_limit`；`404`、`405` |
| `server_test.go` | 20 個請求同時送出時 `seq` 連續、鏈不斷，同一個題目同時送兩次只接受一次；重開後現況相同；有無效紀錄、清冊不見、索引寫錯、名冊屬於另一份時不啟動並指出第幾筆；紀錄裡沒有對方的位址、匿名編號、帳號、題目，只有該有的欄位；每個 API 回應的 `X-Request-Id` 和那一行紀錄的請求編號相同，靜態檔沒有；靜態檔，頁面的標頭只在網頁目錄的檔案上；`web/README.md` 引用的 CSP 和這裡的相同 |
| `mirror_test.go` | 假的內政部伺服器：第一次下載並建索引（和 `crl.BuildIndex` 相同）、之後送條件請求、新清冊加一行、同樣的內容換了 `ETag` 不重存、不是清冊的檔案也存並列為不可用、錯誤狀態不存；索引寫錯時不動存檔 |
| `snapshot_test.go` | 空名冊、1,001 筆切成兩個檔、同一天再跑什麼都不做、隔天寫滿的檔不重寫；有無效的紀錄、證明驗不過、清冊索引和檔案不同、已公布的檔被改過、`heads.jsonl` 不是這份名冊的或寫法不對時，都不發布 |
| `e2e_test.go` | 建置標籤 `iamrealtest`、需要 `bb`：用 `testdata/` 的真證明（見那裡的 `README.md`）從假的內政部抓清冊，跑宣告、再次過卡、更換、更換到上限、收回，以及證明驗不過；出快照（每份證明用 `bb` 重驗），用 `go build -tags iamrealtest` 建出的 `iamreal-verify` 重驗那個目錄，結果和後台的現況相同；換成內政部的金鑰時快照拒絕發布 |

## 檔案

| 檔案 | 內容 |
|---|---|
| `main.go` | 三個子指令和選項 |
| `server.go` | `Config`、開機時重算現況 |
| `api.go` | 路由、回應、`challenges`、`card-state`、`config`、`head` |
| `submit.go` | `records`：送出一筆的檢查和寫入 |
| `request.go` | 嚴格讀請求的 JSON |
| `crls.go` | 鏡像的索引：名冊規則的 `CRLArchive`、最新兩份和 3 天的檢查 |
| `clock.go` | 台灣日期、10 分鐘、5 次、3 天 |
| `mirror.go` | 清冊鏡像 |
| `snapshot.go` | 每日快照 |
| `log.go` | 連線紀錄、程式版本 |
| `headers.go` | 回應標頭、頁面的標頭、靜態檔 |
| `testissuers.go` | 只在建置標籤 `iamrealtest` 下：測試金鑰和假內政部的選項 |
| `store/` | 名冊和題目的儲存：介面和 SQLite 的實作 |
| `testdata/` | 端到端測試的資料 |

## 第三方套件

- `modernc.org/sqlite` v1.62.0：SQLite 的驅動，純 Go，不需要 cgo。只有 `store/` 引用它。

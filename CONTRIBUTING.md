# 貢獻規範

硬限制、語言、目錄的規矩在 `CLAUDE.md`；用詞在 `GLOSSARY.md`；決策在 `docs/adr/`。這一份是每個變更都要符合的規範，`/code-review` 照它檢查。

## 先停下來問的情況

在 issue 或 PR 上問，等回覆再做：

- 變更會碰到 `CLAUDE.md` 的硬限制
- 票沒有講、而且不只一種合理做法的設計判斷
- 畫面上需要一句 `design/copy/` 裡沒有的話
- 需要新增外部套件

## 改之前要先給維護者看文字的文件

ADR、`CLAUDE.md`、`GLOSSARY.md`、`docs/design/principles.md`、這一份。PR 的說明裡把改前和改後的句子並排列出來。

`spec/`、`docs/api/`、`design/copy/` 可以直接改，在 PR 的說明裡寫改了什麼。

## 畫面上的字

- 畫面上的每一句都寫在 `design/copy/`，畫面逐字照它。要改一句話，文字檔和畫面在同一個 PR 裡一起改
- 測試直接讀 `design/copy/` 來比對畫面
- 寫任何給人看的句子之前，讀 `docs/design/principles.md`

## 規則和算法只有一份

- 名冊規則有兩份實作：Go 的 `roster/`（重驗的指令用）和 TypeScript 的 `protocol/`（後台和裝置共用）。後台、裝置和指令呼叫它，自己不判斷一筆紀錄有效或無效
- 改名冊規則時，`spec/roster-rules.md`、`spec/vectors/`、Go、TypeScript 在同一個 PR 改好，名冊規則的版本號加一號（ADR-0030）
- 改到名冊規則的函式（`protocol/` 的 `applyRecord`、`applyList`，Go 的 `roster/rules.go`）而版本號沒有加：PR 的說明寫明存著的卡片狀態為什麼不受影響。什麼樣的修改要加一號，寫在 `spec/roster-rules.md`「The version number」
- 改名冊規則的 PR 附上新舊兩版在最新正式名冊上逐筆比較的結果：全部相同才往回套用，否則寫明生效日（ADR-0031）
- 兩種以上語言都實作的算法，測試讀 `spec/vectors/` 裡同一份標準答案

## 頁面

- 訪客看的頁面由後台產生，預設沒有程式。要加程式時用自己網域的檔案，並在 PR 的說明裡寫換到了什麼
- 頁面只載入自己網域的資源；唯一的例外是島民證明和查詢頁嵌入的 Threads 個人檔案
- 每一種頁面送的安全標頭定義在一個地方，README 寫明每一項的理由

## 測試資料

- 範例和測試用假資料：帳號 `@alice`、短編號 `7K2Q9FM4XD`
- 測試、截圖、PR 裡出現的卡片、憑證、PIN 都是假的
- 測試或截圖需要真實的第三方帳號時，用大型機構或政府單位的官方帳號

## 套件

- 用精確的版本，lockfile 進版控
- 選發布滿 7 天的版本

## 部署會執行到的東西

合併到 `main` 會部署測試網站，推版本標籤會部署正式網站；部署的工作拿著部署的權杖（ADR-0029）。所以 PR 動到下面任何一項，要逐行看，PR 的說明寫出改了什麼、為什麼：

- `.github/workflows/` 裡的任何檔案
- 工作流程用的 action：一律釘在完整的 commit SHA，不用標籤或分支
- 工作流程用 `pull_request_target` 觸發，或把 secrets 交給建置、測試的步驟：不接受
- wrangler 的設定檔，特別是 `build.command`：部署時會執行它（[custom builds](https://developers.cloudflare.com/workers/wrangler/custom-builds/)）
- `worker/site/` 裡 wrangler 上傳的檔，特別是 `_headers`、`_redirects`：不會被執行，但決定過卡頁面和樣式表帶什麼標頭、哪個網址送哪個檔（`worker/README.md`「Static Assets」）
- `package.json` 的 `scripts`，特別是 `preinstall`、`install`、`postinstall`、`prepare`：安裝套件時就會執行
- 新增的套件、lockfile 裡的變動：解析到的網址和雜湊要對得上公開的套件庫
- 安裝套件和 wrangler 啟動時會讀的檔：`.npmrc`、`.pnpmfile.cjs`（或 `.mjs`、`.js`）、`pnpm-workspace.yaml`、`worker/` 底下的 `.env*`
- 部署的工作會呼叫的任何腳本

審外人的 PR 時，`/code-review` 照這份清單列出動到哪幾項、每一項改了什麼；動到任何一項，維護者自己看過才合併。

## 工作時對外的請求

- 讀公開的頁面；被要求登入、註冊、送表單，或被擋下來時，停在那裡，把它當成結果寫下來
- 請求用一般的 `User-Agent`，內容不帶這個專案的名稱和任何人的個人資料
  - 例外：後台的清冊鏡像對內政部送的請求。照 Cloudflare 的文件，Worker 送出的每個請求會被加上 `CF-Worker` 標頭，值是 Worker 所在 zone 的名稱，在這裡會是 `iamreal.tw`（[Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)）；程式拿不掉它，營運者知道並接受。程式自己加的內容照上面那一句
- 本機的測試頁用 `http://127.0.0.1:<埠>` 開

## 寫進這個程式庫的字

- 程式、提交訊息、issue、PR、文件，都當作已經公開
- 關於具名公司、機關或個人的說法，附可以查的來源

## 完成的定義

PR 的說明照 `/pr` 的格式，「Evidence」列出下面每一項的結果：

- `go build ./...`、`go vet -tags iamrealtest ./...`、`gofmt -l .`
- `go test -count=1 -tags iamrealtest ./...`（要設 `IAMREAL_BB` 指到 `bb`）
- 動到 `protocol/` 時：在 `protocol/` 跑 `pnpm typecheck`、`pnpm test`，再跑下面 `web/` 和 `worker/` 的那幾項（兩邊都引用它）
- 動到 `web/` 時：在 `web/` 跑 `pnpm typecheck`、`pnpm test`、`pnpm test:e2e`、`pnpm test:ui`
- 動到 `worker/` 或 `.github/workflows/` 時：在 `worker/` 跑 `pnpm typecheck`、`pnpm test`（工作流程的檢查在 `worker/test/workflows.test.ts`）
- 動到畫面時：桌機和手機寬度的截圖

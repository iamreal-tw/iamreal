# .github/：GitHub Actions 的工作流程

**這個目錄讓人檢查的事：PR 的檢查拿不到任何權杖，部署測試網站的權杖只在上傳的那一步。**（ADR-0029）

| 檔案 | 什麼時候跑 | 做什麼 |
|---|---|---|
| [`workflows/checks.yml`](workflows/checks.yml) | 每個 PR（`pull_request`） | `CONTRIBUTING.md`「完成的定義」的 Go、`protocol/`、`worker/`、`web/` 的型別檢查和 Node 裡的測試：`go`、`typescript` 兩個工作。只能讀，不引用任何 secret |
| [`workflows/checks-browser.yml`](workflows/checks-browser.yml) | PR 改到它用到的檔時（`pull_request` 的 `paths`） | `web/` 的 `pnpm test:e2e`、`pnpm test:ui`：`browser` 一個工作。只能讀，不引用任何 secret |
| [`workflows/deploy-test.yml`](workflows/deploy-test.yml) | 推到 `main` | 打包、檢查，再把那一包上傳到測試網站 |

**為什麼 `browser` 分開、只在有關的檔改了才跑**（#123）：這兩套測試在 GitHub 的 runner 上要約 16 分鐘（2026-11-20 在 #119 量的：`browser` 15 分 28 秒，`go` 1 分 56 秒，`typescript` 5 分 11 秒），是一次檢查的三分之二；程式庫公開之前，Actions 的用量算在組織免費方案的額度裡。只動 `worker/` 或文件的 PR 和它們無關。

`checks-browser.yml` 的 `paths` 列出這兩套測試用到的東西：頁面（`web/`、`protocol/`）、畫面上的字（`design/`）、規格和標準答案（`spec/`）、它們建置和啟動的 Go 程式（`server/`、`verifier/`、`roster/`、`crl/`、`cmd/`、`go.mod`、`go.sum`）、套件（`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`）和這個工作流程檔自己。PR 改到的檔只要有一個符合其中一項，工作流程就跑（[workflow syntax 的 `on.<event>.paths`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore)）。`worker/test/workflows.test.ts` 從這兩套測試的原始碼（它們 import 的檔、`join(repo, …)` 的路徑、它們 `go build` 的套件和那些套件引用的套件）找出用到的最上層目錄和檔，確認每一個都在清單裡；執行時才拼出來的路徑、它們啟動的程式在執行時讀的檔，這個檢查看不到。

兩個限制：

- **#69 之後要把 `worker/**` 加進清單。** 那時 `web/` 的端到端測試改成對 Worker 跑，用到 `worker/`；上面那個測試會發現，但要記得同時改 `checks-browser.yml` 和 `worker/test/workflows.ts` 的 `BROWSER_PATHS`。
- **被 `paths` 濾掉的工作流程不會回報檢查。** 照 GitHub 的文件，這時它的檢查一直停在「Pending」，要求它通過的 PR 不能合併（同一節）。現在 `main` 沒有設必要檢查；之後要把檢查設成必要的，`checks-browser.yml` 不能直接列進去，要另想辦法（例如改成同一個工作流程裡一個判斷的工作加 `if`，讓它每次都回報）。

怎麼部署、上傳那一步還信任什麼：[`worker/README.md`「從 GitHub Actions 部署」](../worker/README.md#從-github-actions-部署)。

## 在本機檢查

工作流程本身在本機跑不起來。檢查它們的規則在 [`worker/test/workflows.ts`](../worker/test/workflows.ts)，測試在 `worker/test/workflows.test.ts`：

```sh
pnpm install --frozen-lockfile   # 在根目錄
cd worker
node --experimental-strip-types --test test/workflows.test.ts
```

`worker/` 的 `pnpm test` 也包括它。這些規則防手誤和明顯的改動，不能代替逐行看（`CONTRIBUTING.md`「部署會執行到的東西」）。

# .github/：GitHub Actions 的工作流程

**這個目錄讓人檢查的事：PR 的檢查拿不到任何權杖，部署測試網站的權杖只在上傳的那一步。**（ADR-0029）

| 檔案 | 什麼時候跑 | 做什麼 |
|---|---|---|
| [`workflows/checks.yml`](workflows/checks.yml) | 每個 PR（`pull_request`），和合併佇列裡的每一組（`merge_group`） | `CONTRIBUTING.md`「完成的定義」的 Go、`protocol/`、`worker/`、`web/` 的型別檢查和 Node 裡的測試，`device-core/` 的 Rust，`android/` 的 app 的建置、JVM 上的單元測試和 lint：`go`、`typescript`、`device-core`、`android` 四個工作，加上決定 PR 階段跑哪幾個的 `changes`（下面「必要檢查在 PR 階段照路徑跳過」）。只能讀，不引用任何 secret |
| [`workflows/checks-browser.yml`](workflows/checks-browser.yml) | PR 改到它用到的檔時（`pull_request` 的 `paths`）；不在合併佇列裡跑 | `web/` 的 `pnpm test:e2e`、`pnpm test:ui`：`browser` 一個工作。只能讀，不引用任何 secret |
| [`workflows/checks-ios.yml`](workflows/checks-ios.yml) | PR 改到 `ios/`、`device-core/`、app 包進去或測試讀的檔、或這個檔時（`pull_request` 的 `paths`）；不在合併佇列裡跑 | 在 macOS 上編 `device-core/` 給模擬器、建置 `ios/` 的 app、在模擬器上跑它的測試：`ios` 一個工作（`ios/README.md`）。只能讀，不引用任何 secret |
| [`workflows/deploy-test.yml`](workflows/deploy-test.yml) | 推到 `main` | 打包、檢查，再把那一包上傳到測試網站 |

**為什麼 `browser` 分開、只在有關的檔改了才跑**（#123）：這兩套測試在 GitHub 的 runner 上要約 16 分鐘（2026-11-20 在 #119 量的：`browser` 15 分 28 秒，`go` 1 分 56 秒，`typescript` 5 分 11 秒），是一次檢查的三分之二。只動 `worker/` 或文件的 PR 和它們無關，不必多等這 16 分鐘。分開的時候程式庫還沒公開，Actions 的用量算在組織免費方案每月含的額度裡，用完就不能再跑；2026-11-21 公開之後，標準的 GitHub-hosted runner 在公開的程式庫不算用量（「The following usage remains free independently and does not reduce the included compute usage: Standard GitHub-hosted runners in public repositories」，[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)），所以現在分開是為了時間，不是額度。`checks.yml` 的四個必要檢查在 PR 階段也照路徑跳過（#206），但做法不同、在合併佇列裡四項全跑：見下面「必要檢查在 PR 階段照路徑跳過」。

`checks-browser.yml` 的 `paths` 列出這兩套測試用到的東西：頁面（`web/`、`protocol/`）、畫面上的字（`design/`）、規格和標準答案（`spec/`）、它們建置和啟動的 Go 程式（`server/`、`verifier/`、`roster/`、`crl/`、`cmd/`、`go.mod`、`go.sum`）、套件（`pnpm-lock.yaml`、`pnpm-workspace.yaml`）和這個工作流程檔自己。照 GitHub 的文件（[workflow syntax 的 `on.<event>.paths`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore)）：

- PR 改到的檔只要有一個符合其中一項，工作流程就跑。樣式要從根目錄比對整個路徑，`**` 包括 `/`；沒有 `/` 的樣式（例如 `go.mod`）只比對根目錄的那個檔。
- 改到哪些檔，看的是整個 PR 對基底分支的差異（「three-dot diffs for pull requests」），不是這一次推送改的。
- 被濾掉、沒有跑的工作流程，它的檢查停在「Pending」。

**清單的測試只是多一層提醒。** `worker/test/workflows.test.ts` 讀這兩套測試的原始碼，找出它們用到的最上層目錄和檔，確認每一個都在清單裡。找得到的寫法：

- 相對路徑的 import（含 JSON）、用 workspace 套件名稱的 import（`iamreal-protocol/…`，或 `pnpm-workspace.yaml` 裡其他套件的名稱）、頁面 HTML 的 `<script src>`
- `join(repo, "<目錄>"…)`、`join(web, "..", "<目錄>"…)`、`join(web, "../<目錄>"…)`，折行的也算
- `new URL("../…", import.meta.url)`
- 它們 `go build` 的套件（寫成 `"go", [… "./<套件>"`），和那些套件引用的這個模組裡的每個套件（`go list -deps`）

找不到的寫法（#123 的審查試過）：樣板字串（`` `${repo}/docs` ``）、用 `+` 接起來的路徑、帶 `?raw` 的 import、CSS 的 `@import`、套件名放在變數裡的 `go build`、它們啟動的程式在執行時讀的檔，以及執行時用其他方式拼出來的路徑。所以讓這兩套測試多用一個目錄的人，要自己把它加進清單。

兩個限制：

- **#69 之後要把 `worker/**` 加進清單。** 那時 `web/` 的端到端測試改成對 Worker 跑，用到 `worker/`。#69 的人要自己同時改 `checks-browser.yml` 和 `worker/test/workflows.ts` 的 `BROWSER_PATHS`；用上面找得到的寫法引用 `worker/` 時，測試會失敗提醒，用找不到的寫法就不會。
- **被 `paths` 濾掉的工作流程不會回報檢查。** 它的檢查停在「Pending」，要求它通過的 PR 不能合併（同一節）。`main` 的 ruleset 要求的必要檢查是 `checks.yml` 的 `go`、`typescript`、`device-core`、`android`（`android` 和合併佇列一起加進 ruleset）；要把 `browser` 也設成必要的，`checks-browser.yml` 不能直接列進去，要照四個必要檢查的做法（同一個工作流程裡一個判斷的工作加 `if`，讓它每次都回報；見「必要檢查在 PR 階段照路徑跳過」），也要讓它在合併佇列裡跑（下一節）。

**`checks-ios.yml`：runner、Xcode、模擬器的來源。** 這三個值寫死在工作流程檔和 `worker/test/workflows.ts`，來源是 GitHub 的 [actions/runner-images](https://github.com/actions/runner-images)（2026-11-20 讀）：

- `runs-on: xcode-27`：[README 的「Available Images」](https://github.com/actions/runner-images/blob/main/README.md#available-images)列的標籤，Apple 晶片，標著 preview（[公告](https://github.com/actions/runner-images/issues/14404)）。標籤如果在正式推出時改名，這個工作會一直排隊，要跟著改
- `/Applications/Xcode_27.2.app`（build 27B52）和 iOS 27.2 的模擬器 `iPhone 17`：[這個映像的說明](https://github.com/actions/runner-images/blob/main/images/macos/xcode-27-arm64-Readme.md)的「Xcode」和「Installed Simulators」。映像上也有 Rust 和 rustup
- 選它是因為 `ios/` 是用同一版 Xcode（27.2，27B52）開發和測試的。另一個選擇是正式的 `macos-26`，上面最新的是 Xcode 26.6（[macos-26-arm64 的說明](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md)）；`ios/` 沒有在 26.6 上建置過
- 這個工作流程還沒有在 GitHub 上跑過（寫的時候分支還沒推送）；第一次跑的結果記在加它的 PR

**`checks-ios.yml` 的 `paths`** 列出 app 和它的測試用到的東西：`ios/`、`device-core/`，app 包進去的檔（`web/circuits/`、`verifier/vk/`），測試讀的檔（`spec/vectors/`、`design/copy/`、`web/scripts/fetch-crs.mjs`），和這個工作流程檔自己。規格只寫了前兩個（「[規格：手機 app 第一份](https://github.com/iamreal-tw/iamreal/issues/155)」：macOS 的分鐘數算得重）；後面幾個不加的話，只改它們的 PR 會讓 iOS 的檢查壞掉而沒有人看到。代價是改 `design/copy/` 或 `spec/vectors/` 的 PR 也會跑一次 macOS。`worker/test/workflows.test.ts` 讀 `ios/Tests/` 和 `ios/check-app.sh` 的原始碼，確認它們寫出來的路徑都在清單裡；用別的方式拼出來的路徑它看不到。

**必要檢查在 PR 階段照路徑跳過，合併佇列四項全跑**（#206）。只改文件的 PR 不必等 `android` 的 11 分鐘（2026-11-20 量的，[#203](https://github.com/iamreal-tw/iamreal/issues/203)）。必要檢查不能用 `paths`：被 `paths` 濾掉的工作流程不回報檢查，PR 會停在「Pending」（上面的限制）。所以 `checks.yml` 每次都跑，由裡面的 `changes` 工作決定四個必要檢查各自跑不跑：

- **`changes` 做什麼。** 它只用 GitHub 自己的 `actions/checkout`（取完整的歷史，`fetch-depth: 0`），再跑 [`workflows/changed-paths.sh`](workflows/changed-paths.sh)，一份只用 bash 和 git 的腳本，不用第三方的 action。在 `pull_request` 上，腳本用 `git diff 基底...PR 的頭` 列出 PR 改到的檔，也就是 PR 的頭對它和基底分支的共同祖先的差異，和 `paths` 看的一樣（「three-dot diffs for pull requests」，上面那一節）；改名的檔，新舊兩個名字都算。某個必要檢查的清單裡有一項符合其中一個檔，它就輸出那個檢查要跑。在 `pull_request` 以外的事件（合併佇列的 `merge_group`）上，它不看差異，四項都輸出要跑。每一項跑或跳過的原因印在 `changes` 的紀錄裡。
- **四個必要檢查怎麼依它決定。** 每個工作有 `needs: changes` 和同一個樣子的 `if`：`changes` 沒有成功、或事件不是 `pull_request`、或 `changes` 說它要跑，三者有一個成立就跑。被 `if` 跳過的工作回報成功（「A job is skipped by a conditional」：「The job reports "Success"」，[Troubleshooting required status checks 的 Handling skipped but required checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks#handling-skipped-but-required-checks)），所以 PR 可以合併、可以排進佇列，畫面上那一項顯示「Skipped」。
- **合併佇列四項全跑。** `if` 裡直接寫了事件不是 `pull_request` 就跑，不經過 `changes` 的輸出；腳本在 `merge_group` 上也輸出全跑。所以清單漏了東西，最壞是 PR 階段少跑一項，進 `main` 之前佇列會補跑，`main` 不會因此變紅。
- **`changes` 失敗時，四個必要檢查是失敗，不是跳過。** 同一頁說「A job depends on a failed job」時「The dependent job is skipped and may not block merging」，要「Use `always()` with `needs` for required checks that depend on other jobs」。所以 `if` 以 `always()` 開頭，`changes` 沒有成功時四個工作照樣開始；它們的第一步檢查 `changes` 的結果，不是 `success` 就失敗。腳本遇到任何問題（找不到基底的提交、清單裡有它不認得的樣式）都直接結束、不輸出「跳過」。用 `always()` 而不是 `!cancelled()`：`cancelled()` 在執行被取消時是真（「Returns `true` if the workflow was canceled」，[Expressions 的 Status check functions](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions)），那時 `!cancelled()` 開頭的 `if` 是假，還沒開始的必要檢查會是被條件跳過、回報成功。`always()` 在被取消時也是真（「Causes the step to always execute, and returns `true`, even when canceled」，同一節），代價是取消一次執行時，還沒開始的必要檢查可能會開始，`changes` 沒成功的話在第一步失敗。這一段是照文件推的，還沒有在 GitHub 上看過取消時的實際結果。
- **清單在哪裡。** 四份清單寫在 `worker/test/workflows.ts`（`GO_PATHS`、`TYPESCRIPT_PATHS`、`DEVICE_CORE_PATHS`、`ANDROID_PATHS`），格式和比對規則同 `BROWSER_PATHS`、`IOS_PATHS`：從根目錄比對整個路徑，`**` 包括 `/`。只用兩種樣式：沒有萬用字元的路徑（就那一個檔），和 `<目錄>/**`（底下所有的檔）；其他樣式規則和腳本都不接受。`checks.yml` 把清單寫在 `changes` 的 `env`（一份清單一行，用空白隔開），腳本從那裡讀；`worker/test/workflows.ts` 的規則要求 `env` 和清單一字不差，所以沒有第二份會走樣的清單。改清單要同時改 `workflows.ts` 和 `checks.yml` 的那一行。
- **每一份清單都有的**：`checks.yml` 和 `changed-paths.sh`、`worker/test/workflows.ts` 和 `workflows.test.ts`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`go.mod`、`go.sum`。改 CI 或套件的 PR 四項都跑。
- **`typescript` 的清單幾乎是全部**：除了 `docs/` 和根目錄的文件以外的每個目錄。`worker/` 的測試會建置、執行 Go 的程式，`workflows.test.ts` 會讀 `android/`、`ios/`、`device-core/` 和工作流程。所以 PR 階段省下的主要是只改文件的 PR（四項都跳過），和只改 Go、Rust、app 的 PR 各自不相關的那幾項。

`worker/test/workflows.ts` 的規則擋下：必要檢查不經過 `changes`、在 `merge_group` 上可以被跳過、`changes` 沒成功時變成跳過、`changes` 用了別的 action 或別的指令。它是把 `if` 當運算式算過每一種情況（`changes` 的結果、輸出、事件、有沒有被取消），不是比對文字；它讀不懂的 `if` 一律算問題。`workflows.test.ts` 另外在一個暫時的 git 程式庫裡實際跑 `changed-paths.sh`，餵它 `checks.yml` 裡的清單。

**清單的涵蓋測試和它看不到的。** 和 `BROWSER_PATHS` 一樣，測試只是多一層提醒：它讀原始碼，找出寫得出來的路徑，確認都在清單裡。漏掉的不會讓 `main` 變紅（佇列全跑），但 PR 階段會少跑那一項，所以讓某個檢查多讀一個目錄的人，要自己把它加進清單。

- **`go`**：`go list` 列出的每個套件的目錄，加上 Go 原始碼裡以 `../` 開頭的字串和 `filepath.Join("..", …)` 指到的檔（測試讀的 `spec/`、`design/copy/`、`web/README.md`、一份 ADR）。手寫的：三個 `package.json`（這個工作會 `pnpm install` 來拿 bb）。看不到：用其他方式拼出來的路徑、測試從環境變數拿到的路徑、清單以外的目錄裡新增的 Go 檔（`go build ./...`、`gofmt -l .` 會掃到）。
- **`typescript`**：`protocol/`、`worker/`、`web/` 每個有進版本控制的原始碼，找得到的寫法和 `BROWSER_PATHS` 的相同（import、`join(…)`、`new URL(…)`、`"go", […]`），`join` 的第一個參數認 `REPO`、`repo`、`WORKER_DIR`、`web`、`here` 這幾個名字；它們用到的 Go 套件再照 `go` 的做法找。看不到的也相同，另外看不到 `new URL` 只寫到根目錄的（`` `../../${path}` ``）。
- **`device-core`**：Rust 裡的 `repo_file("…")`、`vectors("…")`、`.join("../…")`、`include_str!`、`include_bytes!`，和 `Cargo.toml` 的 `path = "…"`。現在的程式沒有 `include_str!`、`include_bytes!`、`build.rs`；測試是在執行時讀檔。手寫、偵測不到的：`build.rs` 或相依套件的巨集在編譯時讀的檔、用 `format!` 以外的方式拼出來的路徑、兩個下載的腳本（`fetch-barretenberg.sh`、`fetch-crs.sh`）讀的東西。這些現在都在 `device-core/` 裡（雜湊檔 `barretenberg.sha256`、`crs.sha256`、`.cargo/config.toml`、`rust-toolchain.toml`、`Cargo.lock`），整個目錄在清單裡；之後有哪一個讀到 `device-core/` 以外，要手動加。
- **`android`**：Gradle 腳本裡的 `rootProject.file("…")`、`core.resolve("…")`，和 shell 腳本裡的 `$here/…`、`$core/…`（`build-native.sh` 編 `device-core/`、打包 `web/circuits/`、`verifier/vk/`，單元測試讀 `spec/vectors/`、`design/copy/`）。手寫、偵測不到的：Android 的 Gradle 外掛照慣例讀的檔（`AndroidManifest.xml`、`res/`、`gradle.properties`、`gradle/verification-metadata.xml`、wrapper）、`fetch-zig.sh` 和 `zig.sha256`、Kotlin 測試從系統屬性拿到的路徑。這些都在 `android/` 或 `device-core/` 裡，兩個目錄整個在清單裡。`device-core/` 的建置讀什麼，`android` 就跟著讀什麼，所以上一點偵測不到的，這裡也一樣。

三個 PR 的工作流程的 `concurrency` 群組名稱不同：群組在所有工作流程之間共用，「concurrency group names must be unique across workflows to avoid canceling in-progress jobs or runs from other workflows」（[workflow syntax 的 `concurrency`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idconcurrency)）。

## 合併佇列（#180）

`main` 用合併佇列：PR 排進佇列後，GitHub 把它和 `main`、排在它前面的 PR 合成一個暫時的分支（`gh-readonly-queue/main/…`），在那上面跑 `main` 要求的檢查，過了才合併（[Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)）。兩個各自綠燈的 PR 合起來是紅的，會在這裡被擋下，不會進 `main`、不會部署到測試網站（#180 的起因）。

- **佇列裡四個必要檢查全跑，不照路徑跳過。** PR 階段被跳過的檢查（「必要檢查在 PR 階段照路徑跳過」），在這裡會跑；`main` 上的每個提交都通過完整的四項。
- **佇列只跑 `checks.yml`。** 必要檢查要由在 `merge_group` 上跑的工作流程回報，不然佇列等不到（[Events that trigger workflows 的 `merge_group`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group)）。`checks.yml` 只寫了 `checks_requested` 這一種活動，那一頁說寫明活動能讓之後多出新的活動時不被觸發。`checks-browser.yml`、`checks-ios.yml` 不在佇列裡跑：同一頁替 `merge_group` 只列了 `branches`、`branches-ignore` 兩種篩選，沒有 `paths`，放進去每一次合併都要多等瀏覽器測試、多跑一次 macOS。
- **`concurrency`。** PR 的執行照 PR 編號分組，新的推送取消前一次。佇列的執行沒有 PR 編號，改照 `github.ref` 分組，也就是那一組的暫時分支（`merge_group` 的 `GITHUB_REF` 是「Ref of the merge group」，同一頁；`github.ref` 是「The fully-formed ref of the branch or tag that triggered the workflow run」，`pull_request` 以外的觸發「this is the branch or tag ref that triggered the workflow run」，[Contexts reference 的 `github`](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context)）。不這樣分，佇列裡各組的執行會在同一個群組裡互相取消。
- **佇列的執行沒有 fork 的限制。** fork 來的 PR 拿不到 secret、權杖只能讀，文件寫的是 `pull_request`；佇列的暫時分支在這個程式庫裡，裡面有 PR 的改動，文件沒有說那條限制也適用。所以讓它安全的是 `checks.yml` 本身：不引用任何 secret、權杖只能讀、不用快取，改到它的 PR 要逐行看（`CONTRIBUTING.md`「部署會執行到的東西」），`worker/test/workflows.ts` 擋下引用 secret、放寬權限、別的工作流程也在 `merge_group` 上跑這類改動。
- **必要檢查照工作的名稱比對。** `checks.yml` 的工作必須恰好是 `go`、`typescript`、`device-core`、`android`，而且不設 `name`（`worker/test/workflows.ts` 的 `REQUIRED_CHECKS`）：改了 id 或設了 `name`，回報的檢查就不是 ruleset 等的那一個，佇列會一直等。依據：GitHub 的文件說必要檢查照工作的名稱認，「make sure that job names are unique across all workflows. Using the same job name in multiple workflows can cause ambiguous status check results」（[About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)），`name` 是「a name for the job, which is displayed in the GitHub UI」（[workflow syntax 的 `jobs.<job_id>.name`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idname)）。沒設 `name` 時檢查的名稱就是工作的 id，文件沒有明寫，是看到的：`main` 的 ruleset 要求的 `go`、`typescript`、`device-core` 就是這三個沒設 `name` 的工作的 id（2026-11-21 讀 ruleset）；`android` 是之後加進 `checks.yml` 的工作，和合併佇列一起加進 ruleset。
- **合併是排進佇列。** `gh pr merge` 在必要檢查過了時把 PR 加進佇列，沒過時開自動合併（[Merging a pull request with a merge queue](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue)）。

怎麼部署、上傳那一步還信任什麼：[`worker/README.md`「從 GitHub Actions 部署」](../worker/README.md#從-github-actions-部署)。

## 在本機檢查

工作流程本身在本機跑不起來。檢查它們的規則在 [`worker/test/workflows.ts`](../worker/test/workflows.ts)，測試在 `worker/test/workflows.test.ts`：

```sh
pnpm install --frozen-lockfile   # 在根目錄
cd worker
node --experimental-strip-types --test test/workflows.test.ts
```

`worker/` 的 `pnpm test` 也包括它。`changed-paths.sh` 的測試要有 `bash` 和 `git`。`paths` 清單的測試要有 `go` 才完整：沒有 `go` 時，檢查 Go 套件的那一項跳過，其他照查；設了 `CI`（GitHub Actions 會設）或 `IAMREAL_BB` 時沒有 `go`，那一項是失敗，不是跳過。這些規則防手誤和明顯的改動，不能代替逐行看（`CONTRIBUTING.md`「部署會執行到的東西」）。

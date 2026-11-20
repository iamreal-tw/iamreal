# .github/：GitHub Actions 的工作流程

**這個目錄讓人檢查的事：PR 的檢查拿不到任何權杖，部署測試網站的權杖只在上傳的那一步。**（ADR-0029）

| 檔案 | 什麼時候跑 | 做什麼 |
|---|---|---|
| [`workflows/checks.yml`](workflows/checks.yml) | 每個 PR（`pull_request`），和合併佇列裡的每一組（`merge_group`） | `CONTRIBUTING.md`「完成的定義」的 Go、`protocol/`、`worker/`、`web/` 的型別檢查和 Node 裡的測試，`device-core/` 的 Rust，`android/` 的 app 的建置、JVM 上的單元測試和 lint：`go`、`typescript`、`device-core`、`android` 四個工作，加上決定 PR 階段跑哪幾個的 `changes`（下面「必要檢查在 PR 階段照路徑跳過」）。只能讀，不引用任何 secret；快取只能還原、不能存（`cache-mode: read`，「快取」一節） |
| [`workflows/checks-browser.yml`](workflows/checks-browser.yml) | PR 改到它用到的檔時（`pull_request` 的 `paths`）；不在合併佇列裡跑 | `web/` 的 `pnpm test:e2e`、`pnpm test:ui`：`browser` 一個工作。只能讀，不引用任何 secret |
| [`workflows/checks-ios.yml`](workflows/checks-ios.yml) | PR 改到 `ios/`、`device-core/`、app 包進去或測試讀的檔、或這個檔時（`pull_request` 的 `paths`）；不在合併佇列裡跑 | 在 macOS 上編 `device-core/` 給模擬器、建置 `ios/` 的 app、在模擬器上跑它的測試：`ios` 一個工作（`ios/README.md`）。只能讀，不引用任何 secret |
| [`workflows/deploy-test.yml`](workflows/deploy-test.yml) | 推到 `main` | 打包、檢查，再把那一包上傳到測試網站。碰不到快取（`cache-mode: none`） |
| [`workflows/cache.yml`](workflows/cache.yml) | 推到 `main` | 編譯 `device-core/`，把 cargo 的 registry 和 `device-core/target/` 存成快取，給 `checks.yml` 的 `device-core` 還原：`cache-device-core` 一個工作。不引用任何 secret，`GITHUB_TOKEN` 只能讀（`contents: read`）；唯一能存快取的工作流程（`cache-mode: write`） |

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

- **`changes` 做什麼。** 它只用 GitHub 自己的 `actions/checkout`（取完整的歷史，`fetch-depth: 0`），再跑 [`workflows/changed-paths.sh`](workflows/changed-paths.sh)，一份只用 bash 和 git 的腳本，不用第三方的 action。在 `pull_request` 上，腳本用 `git diff 基底...PR 的頭` 列出 PR 改到的檔，也就是 PR 的頭對它和基底分支的共同祖先的差異，和 `paths` 看的一樣（「three-dot diffs for pull requests」，上面那一節）；改名的檔，新舊兩個名字都算。某個必要檢查的清單裡有一項符合其中一個檔，它就輸出那個檢查要跑。在 `pull_request` 以外的事件（合併佇列的 `merge_group`）上，它不看差異，四項都輸出要跑。每一項跑或跳過的原因印在 `changes` 的紀錄裡；檔名是 PR 決定的，印出來時可印的 ASCII 以外的字元（包括換行）一律換成 `?`，所以中文檔名在紀錄裡是一串 `?`，檔名也不能在紀錄裡多出一行讓 runner 當成 workflow command。
- **四個必要檢查怎麼依它決定。** 每個工作有 `needs: changes` 和同一個樣子的 `if`：`changes` 沒有成功、或事件不是 `pull_request`、或 `changes` 說它要跑，三者有一個成立就跑。被 `if` 跳過的工作回報成功（「A job is skipped by a conditional」：「The job reports "Success"」，[Troubleshooting required status checks 的 Handling skipped but required checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks#handling-skipped-but-required-checks)），所以 PR 可以合併、可以排進佇列，畫面上那一項顯示「Skipped」。
- **合併佇列四項全跑。** `if` 裡直接寫了事件不是 `pull_request` 就跑，不經過 `changes` 的輸出；腳本在 `merge_group` 上也輸出全跑。所以清單漏了東西，最壞是 PR 階段少跑一項，進 `main` 之前佇列會補跑，`main` 不會因此變紅。
- **`changes` 失敗時，四個必要檢查是失敗，不是跳過。** 同一頁說「A job depends on a failed job」時「The dependent job is skipped and may not block merging」，要「Use `always()` with `needs` for required checks that depend on other jobs」。所以 `if` 以 `always()` 開頭，`changes` 沒有成功時四個工作照樣開始；它們的第一步檢查 `changes` 的結果（經 `env` 拿到），不是 `success` 就失敗。腳本遇到任何問題（找不到基底的提交、清單裡有它不認得的樣式）都直接結束、不輸出「跳過」。用 `always()` 而不是 `!cancelled()`：`cancelled()` 在執行被取消時是真（「Returns `true` if the workflow was canceled」，[Expressions 的 Status check functions](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions)），那時 `!cancelled()` 開頭的 `if` 是假，還沒開始的必要檢查會是被條件跳過、回報成功。`always()` 在被取消時也是真（「Causes the step to always execute, and returns `true`, even when canceled」，同一節），代價是取消一次執行時，還沒開始的必要檢查可能會開始，`changes` 沒成功的話在第一步失敗。這一段是照文件推的，還沒有在 GitHub 上看過取消時的實際結果。
- **清單在哪裡。** 四份清單寫在 `worker/test/workflows.ts`（`GO_PATHS`、`TYPESCRIPT_PATHS`、`DEVICE_CORE_PATHS`、`ANDROID_PATHS`），格式和比對規則同 `BROWSER_PATHS`、`IOS_PATHS`：從根目錄比對整個路徑，`**` 包括 `/`。只用兩種樣式：沒有萬用字元的路徑（就那一個檔），和 `<目錄>/**`（底下所有的檔）；其他樣式規則和腳本都不接受。目錄沒寫 `/**` 的話腳本會把它當成一個檔名、永遠比對不到，所以 `workflows.test.ts` 另外確認清單裡沒有哪一項是程式庫裡的目錄卻沒寫 `/**`。`checks.yml` 把清單寫在 `changes` 的 `env`（一份清單一行，用空白隔開），腳本從那裡讀；`worker/test/workflows.ts` 的規則要求 `env` 和清單一字不差，所以沒有第二份會走樣的清單。改清單要同時改 `workflows.ts` 和 `checks.yml` 的那一行。
- **每一份清單都有的**：`checks.yml` 和 `changed-paths.sh`、`worker/test/workflows.ts` 和 `workflows.test.ts`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`go.mod`、`go.sum`。改 CI 或套件的 PR 四項都跑。另外有七個現在不存在的根目錄檔：`.npmrc`、`.pnpmfile.cjs`、`package.json`（改變 pnpm 從哪裡裝、怎麼裝）、`go.work`、`go.work.sum`（Go 的 workspace）、`.cargo/config.toml`（cargo 會從 `device-core/` 往上找到它）、`.gitattributes`（改變檔案取出來的樣子）。沒有萬用字元的樣式比對的是檔名，所以哪個 PR 加了其中一個，四項都跑。
- **`typescript` 的清單幾乎是全部**：除了 `docs/` 和根目錄的文件以外的每個目錄。`worker/` 的測試會建置、執行 Go 的程式，`workflows.test.ts` 會讀 `android/`、`ios/`、`device-core/` 和工作流程。所以 PR 階段省下的主要是只改文件的 PR（四項都跳過），和只改 Go、Rust、app 的 PR 各自不相關的那幾項。

`worker/test/workflows.ts` 的規則擋下：必要檢查不經過 `changes`、在 `merge_group` 上可以被跳過、`changes` 沒成功時變成跳過、`changes` 用了別的 action 或別的指令。它是把 `if` 當運算式算過每一種情況（`changes` 的結果、輸出、事件、有沒有被取消），不是比對文字；它讀不懂的 `if` 一律算問題。`workflows.test.ts` 另外在一個暫時的 git 程式庫裡實際跑 `changed-paths.sh`，餵它 `checks.yml` 裡的清單。

**清單的涵蓋測試和它看不到的。** 和 `BROWSER_PATHS` 一樣，測試只是多一層提醒：它讀原始碼，找出寫得出來的路徑，確認都在清單裡。漏掉的不會讓 `main` 變紅（佇列全跑），但 PR 階段會少跑那一項，所以讓某個檢查多讀一個目錄的人，要自己把它加進清單。

- **根目錄的設定檔**：上面那七個是手寫的，涵蓋測試不看。工具會自己往上層目錄找的其他設定檔（例如根目錄的 `rust-toolchain.toml`、`tsconfig.json`、`.tool-versions`），加的人要自己加進清單。清單裡的目錄底下的同類檔（`web/.npmrc`、`device-core/.cargo/config.toml`）已經跟著目錄在清單裡。
- **`go`**：`go list` 列出的每個套件的目錄，加上 Go 原始碼裡以 `../` 開頭的字串和 `filepath.Join("..", …)` 指到的檔（測試讀的 `spec/`、`design/copy/`、`web/README.md`、一份 ADR）。手寫的：三個 `package.json`（這個工作會 `pnpm install` 來拿 bb）。看不到：用其他方式拼出來的路徑、測試從環境變數拿到的路徑、清單以外的目錄裡新增的 Go 檔（`go build ./...`、`gofmt -l .` 會掃到）。
- **`typescript`**：`protocol/`、`worker/`、`web/` 每個有進版本控制的原始碼，找得到的寫法和 `BROWSER_PATHS` 的相同（import、`join(…)`、`new URL(…)`、`"go", […]`），`join` 的第一個參數認 `REPO`、`repo`、`WORKER_DIR`、`web`、`here` 這幾個名字；它們用到的 Go 套件再照 `go` 的做法找。看不到的也相同，另外看不到 `new URL` 只寫到根目錄的（`` `../../${path}` ``）。
- **`device-core`**：Rust 裡的 `repo_file("…")`、`vectors("…")`、`.join("../…")`、`include_str!`、`include_bytes!`，和 `Cargo.toml` 的 `path = "…"`。現在的程式沒有 `include_str!`、`include_bytes!`、`build.rs`；測試是在執行時讀檔。手寫、偵測不到的：`build.rs` 或相依套件的巨集在編譯時讀的檔、用 `format!` 以外的方式拼出來的路徑、兩個下載的腳本（`fetch-barretenberg.sh`、`fetch-crs.sh`）讀的東西。這些現在都在 `device-core/` 裡（雜湊檔 `barretenberg.sha256`、`crs.sha256`、`.cargo/config.toml`、`rust-toolchain.toml`、`Cargo.lock`），整個目錄在清單裡；之後有哪一個讀到 `device-core/` 以外，要手動加。清單裡另外手寫了 `workflows/cache.yml`：它的雜湊在這個工作還原的快取的鍵裡（「快取」一節），改它的 PR 會讓這個工作從零編一次。
- **`android`**：Gradle 腳本裡的 `rootProject.file("…")`、`core.resolve("…")`，和 shell 腳本裡的 `$here/…`、`$core/…`（`build-native.sh` 編 `device-core/`、打包 `web/circuits/`、`verifier/vk/`，單元測試讀 `spec/vectors/`、`design/copy/`）。手寫、偵測不到的：Android 的 Gradle 外掛照慣例讀的檔（`AndroidManifest.xml`、`res/`、`gradle.properties`、`gradle/verification-metadata.xml`、wrapper）、`fetch-zig.sh` 和 `zig.sha256`、Kotlin 測試從系統屬性拿到的路徑。這些都在 `android/` 或 `device-core/` 裡，兩個目錄整個在清單裡。`device-core/` 的建置讀什麼，`android` 就跟著讀什麼，所以上一點偵測不到的，這裡也一樣。

三個 PR 的工作流程、`deploy-test.yml`、`cache.yml` 的 `concurrency` 群組名稱都不同：群組在所有工作流程之間共用，「concurrency group names must be unique across workflows to avoid canceling in-progress jobs or runs from other workflows」（[workflow syntax 的 `concurrency`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idconcurrency)）。

## 合併佇列（#180）

`main` 用合併佇列：PR 排進佇列後，GitHub 把它和 `main`、排在它前面的 PR 合成一個暫時的分支（`gh-readonly-queue/main/…`），在那上面跑 `main` 要求的檢查，過了才合併（[Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)）。兩個各自綠燈的 PR 合起來是紅的，會在這裡被擋下，不會進 `main`、不會部署到測試網站（#180 的起因）。

- **佇列裡四個必要檢查全跑，不照路徑跳過。** PR 階段被跳過的檢查（「必要檢查在 PR 階段照路徑跳過」），在這裡會跑；`main` 上的每個提交都通過完整的四項。
- **佇列只跑 `checks.yml`。** 必要檢查要由在 `merge_group` 上跑的工作流程回報，不然佇列等不到（[Events that trigger workflows 的 `merge_group`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group)）。`checks.yml` 只寫了 `checks_requested` 這一種活動，那一頁說寫明活動能讓之後多出新的活動時不被觸發。`checks-browser.yml`、`checks-ios.yml` 不在佇列裡跑：同一頁替 `merge_group` 只列了 `branches`、`branches-ignore` 兩種篩選，沒有 `paths`，放進去每一次合併都要多等瀏覽器測試、多跑一次 macOS。
- **`concurrency`。** PR 的執行照 PR 編號分組，新的推送取消前一次。佇列的執行沒有 PR 編號，改照 `github.ref` 分組，也就是那一組的暫時分支（`merge_group` 的 `GITHUB_REF` 是「Ref of the merge group」，同一頁；`github.ref` 是「The fully-formed ref of the branch or tag that triggered the workflow run」，`pull_request` 以外的觸發「this is the branch or tag ref that triggered the workflow run」，[Contexts reference 的 `github`](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context)）。不這樣分，佇列裡各組的執行會在同一個群組裡互相取消。
- **佇列的執行沒有 fork 的限制。** fork 來的 PR 拿不到 secret、權杖只能讀，文件寫的是 `pull_request`；佇列的暫時分支在這個程式庫裡，裡面有 PR 的改動，文件沒有說那條限制也適用。所以讓它安全的是 `checks.yml` 本身：不引用任何 secret、權杖只能讀、快取只能還原不能存（`cache-mode: read`，「快取」一節），改到它的 PR 要逐行看（`CONTRIBUTING.md`「部署會執行到的東西」），`worker/test/workflows.ts` 擋下引用 secret、放寬權限、別的工作流程也在 `merge_group` 上跑這類改動。
- **必要檢查照工作的名稱比對。** `checks.yml` 的工作必須恰好是 `go`、`typescript`、`device-core`、`android`，而且不設 `name`（`worker/test/workflows.ts` 的 `REQUIRED_CHECKS`）：改了 id 或設了 `name`，回報的檢查就不是 ruleset 等的那一個，佇列會一直等。依據：GitHub 的文件說必要檢查照工作的名稱認，「make sure that job names are unique across all workflows. Using the same job name in multiple workflows can cause ambiguous status check results」（[About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)），`name` 是「a name for the job, which is displayed in the GitHub UI」（[workflow syntax 的 `jobs.<job_id>.name`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idname)）。沒設 `name` 時檢查的名稱就是工作的 id，文件沒有明寫，是看到的：`main` 的 ruleset 要求的 `go`、`typescript`、`device-core` 就是這三個沒設 `name` 的工作的 id（2026-11-21 讀 ruleset）；`android` 是之後加進 `checks.yml` 的工作，和合併佇列一起加進 ruleset。
- **合併是排進佇列。** `gh pr merge` 在必要檢查過了時把 PR 加進佇列，沒過時開自動合併（[Merging a pull request with a merge queue](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue)）。
- **佇列現在的設定**（`main` 的 ruleset 的 `merge_queue` 規則，2026-11-21 用 `gh api repos/iamreal-tw/iamreal/rulesets/27745555` 讀）：合併方式 merge commit（`MERGE`）；一組全部通過才合併（`ALLGREEN`）；同時最多 5 個佇列項目在跑檢查（`max_entries_to_build`，文件寫的是「The maximum number of `merge_group` webhooks to dispatch」）；一次合併 1 到 5 個 PR（`min_entries_to_merge`、`max_entries_to_merge`）；等湊滿一組的時間 0 分（`min_entries_to_merge_wait_minutes`，#204 從 5 改成 0）；檢查 60 分沒有回報算失敗（`check_response_timeout_minutes`）。等待時間是「a timeout for reaching the minimum group size, which allows smaller groups to merge if there are no more PRs queued within your specified time limit」（[Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue#managing-a-merge-queue) 的「Wait time」）。照字面，最小組數是 1 時排進去就湊滿了，不該等；文件沒有明寫這種情況，設成 0 是為了不必靠推論，PR 排進去就開始跑。實際從排進去到開始跑的時間記在 #204 的 PR。這些值在 GitHub 上，不在程式庫裡；改了要回來更新這一段。
- **排進佇列前，自己確認 `browser`、`ios` 通過。** 這兩項不是必要檢查，也不在佇列裡跑（「佇列只跑 `checks.yml`」那一點）：PR 上它們紅燈或還在跑，`gh pr merge` 照樣能把 PR 排進佇列，佇列也不會擋，紅燈的測試就這樣進了 `main`。
- **不必為了和最新的 `main` 同步而把 `main` 併進分支。** 佇列會把 PR 疊在最新的 `main`（和排在它前面的 PR）上重跑必要檢查，合起來是不是綠的由佇列負責；自己先併一次只會多跑一整輪檢查。只有兩種情況要併：和 `main` 有衝突，或這個 PR 需要 `main` 上新的東西（例如要用剛合併的程式，或要在 PR 上看 `browser`、`ios` 對合起來的結果跑）。

## 快取（#203）

`device-core` 的檢查從零編要 4 分多鐘（#203 量的）。現在它還原推到 `main` 時存下的 cargo 快取，依賴的套件不必重編。省多少還沒量：`device-core/` 的 release 設定是 `lto = true`、`codegen-units = 1`，每個測試的執行檔在連結時還要做一次 LTO，那一段快取幫不上。實際的時間記在加快取的 PR 的 Evidence。

**誰能寫、誰能讀：靠每個工作流程最上面的 `cache-mode`。**

| 工作流程 | `cache-mode` | 快取的 action |
|---|---|---|
| `cache.yml`（推到 `main`） | `write`：能還原、能存 | `actions/cache` |
| `checks.yml`（PR 和合併佇列） | `read`：能還原、不能存 | `actions/cache/restore` |
| `deploy-test.yml`、`checks-browser.yml`、`checks-ios.yml` | `none`：都不能 | 沒有 |

- **界線是 `cache-mode`，不是用哪個 action。** `read`「allows cache restores but prevents cache saves」，`none`「prevents all cache access」（[2026-09-10 的 changelog](https://github.blog/changelog/2026-09-10-control-github-actions-cache-access-with-cache-mode)）；「Access is enforced with scoped cache tokens, so a job cannot restore or save caches beyond the mode it is granted」（[workflow syntax 的 `cache-mode`](https://docs.github.com/actions/reference/workflows-and-actions/workflow-syntax#cache-mode)，2026-11-21 讀）。`checks.yml` 的 `run` 步驟跑的是 PR 的程式；工作裡的程式可以不經過任何 action，拿工作自己的權杖直接對快取服務存東西（[Cacheract](https://adnanthekhan.com/2024/12/21/cacheract-the-monster-in-your-build-cache/)）。所以只用沒有存檔步驟的 `actions/cache/restore` 擋不住它，擋住它的是權杖本身不能存。
- **每個檔都寫明，不靠預設。** 沒寫的時候「a `read` or `write` default is used based on the trigger type」（同一頁）。工作層級不准設：「Job-level settings override workflow-level settings」（changelog）。新的工作流程要寫 `none`。
- **action 跟著 `cache-mode` 走，是讓檔案看得出它在做什麼。** `checks.yml` 只用 `actions/cache/restore`（「It works similarly to the `cache` action except that it doesn't have a post step to save the cache」，[restore 的 README](https://github.com/actions/cache/blob/v6.1.0/restore/README.md)），`none` 的檔不用任何快取的 action。不被允許的快取步驟不會失敗（「the cache step logs an informational message and continues」，workflow syntax 那一頁），寫錯了不會有人發現，所以由 `worker/test/workflows.ts` 擋。
- **`cache-mode` 底下還有 GitHub 替快取劃的範圍**（[Dependency caching 的 Restrictions for accessing a cache](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache)，2026-11-21 讀）。一次執行讀得到的只有自己分支和預設分支的快取：「Workflow runs can restore caches created in either the current branch or the default branch (usually `main`)」；PR 的執行「can also restore caches created in the base branch」。PR 的執行存的快取，別的執行讀不到：它「can only be restored by re-runs of the pull request. It cannot be restored by the base branch or other pull requests targeting that base branch」。那一頁沒有提合併佇列；佇列的執行跑在這個程式庫的暫時分支上，它存不了快取靠的是 `cache-mode: read`，不是這一條。
- `cache.yml` 只在推到 `main` 時觸發，不引用任何 secret，`GITHUB_TOKEN` 只能讀（`contents: read`）：存快取的那一步手上只有寫快取的權杖（`cache-mode: write`），沒有 secret，也沒有能改程式庫的權杖。
- `deploy-test.yml` 是 `cache-mode: none`，部署的那一包和快取無關。這是它為了快取唯一多的一行，作用是拿掉它碰快取的能力。
- 快取裡只有公開的東西（crates.io 的套件和編出來的檔）。GitHub 的文件提醒快取誰都讀得到：「Anyone who can open a pull request against your repository can read the contents of caches in the base branch」（Dependency caching 那一頁），所以不能把金鑰放進去；這裡的工作流程本來就拿不到金鑰。

**還剩的風險**（ADR-0029）：一段進了 `main` 的惡意程式，可以在 `cache.yml` 裡把東西留在快取，影響之後的檢查。它既然在 `main`，本來就跑在之後的每一次檢查裡；部署碰不到快取，部署的權杖不受影響。`worker/test/workflows.ts` 看不到 `cache.yml` 的指令在快取裡留下什麼。

**存什麼、鍵是什麼。** 兩個快取，各一個路徑（`worker/test/workflows.ts` 的 YAML 讀法不讀多行的值，所以一個步驟一個路徑）：

- `~/.cargo/registry`：`Cargo.lock` 列的套件，下載和解開之後的樣子。
- `device-core/target`：編出來的東西。

**還原回來的東西不會再核對一次。** cargo 在下載套件時照 `Cargo.lock` 裡的 checksum 核對；已經在 registry 裡的套件（還原回來的就是）不會再對，`target/` 裡編好的檔也沒有雜湊可對。所以有快取的那一次檢查，信任的是 `main` 上那一次 `cache.yml` 留下的內容，就是上面那條還剩的風險。沒有快取的那一次，套件是當場下載、核對的。

鍵是名稱、runner 的作業系統和架構，加上這幾個檔的雜湊：`.github/workflows/cache.yml`，和 `device-core/` 的 `Cargo.lock`、三個 `Cargo.toml`、`rust-toolchain.toml`、`.cargo/config.toml`、`barretenberg.sha256`。後面幾個決定編哪些套件、用什麼設定、用哪一版 Rust、連結哪一份 Barretenberg；`cache.yml` 裡是填快取的指令，改了指令或參數（連註解也算）就是新的鍵。`checks.yml` 算的是同一個鍵。

- **不設 `restore-keys`。** 鍵要完全相同才還原，不然就當沒有快取：換了依賴或工具鏈的 PR 不會拿到替舊的 `Cargo.lock` 或舊的 Rust 編的 `target/`。代價是這種 PR 的 `device-core` 從零編，合併後 `cache.yml` 才存新的鍵。
- **同一個鍵只存一次。** 「You cannot change the contents of an existing cache」（同一頁）；鍵已經有快取時 `cache.yml` 還原它、編完、不再存。所以 `target/` 裡 `device-core/` 自己的那部分是第一次存的時候的，之後不更新。這不影響結果：cargo 看原始檔的修改時間，剛 checkout 的檔比快取新，`device-core/` 自己的兩個套件每次都重編；重用的是依賴的套件。
- **`cache.yml` 編的和 `device-core` 編的相同**：同一個目錄、同樣的 `BB_LIB_DIR`、同樣的 `cargo clippy --locked --release --all-targets` 和 `cargo test --locked --release`，只差測試加了 `--no-run`（只編不跑：跑測試不會在 `target/` 留下之後用得到的東西）。兩邊不一樣的話，cargo 會當成不同的東西重編，快取就白存了；`worker/test/workflows.ts` 裡兩個工作共用的步驟和指令只寫一次，改一邊不改另一邊，測試會失敗。
- **沒有快取時照樣通過，只是慢**：第一次、換了鍵、被刪掉的時候。`actions/cache/restore` 的 `fail-on-cache-miss` 預設是 `false`，這裡不設。快取 7 天沒人讀會被刪（「GitHub will remove any cache entries that have not been accessed in over 7 days」），整個程式庫超過 10 GB 時從最久沒用的開始刪（[Usage limits and eviction policy](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#usage-limits-and-eviction-policy)）；被刪之後要等下一次推到 `main` 才會再存。

`worker/test/workflows.ts` 擋下的改動：任何一個檔的 `cache-mode` 和上表不同或沒寫，新的工作流程不是 `none`，工作層級設了 `cache-mode`；`checks.yml` 的工作用會存快取的 `actions/cache` 或 `actions/cache/save`，或 `device-core` 以外的工作還原它的快取；`deploy-test.yml`、`checks-browser.yml`、`checks-ios.yml` 或新的工作流程用任何一種快取的 action；`cache.yml` 在推到 `main` 以外的事件上觸發、引用 secret、權限不是恰好 `contents: read`、工作和寫死的不同；快取的 `path`、`key` 和寫死的不同，或多了 `restore-keys`。

怎麼部署、上傳那一步還信任什麼：[`worker/README.md`「從 GitHub Actions 部署」](../worker/README.md#從-github-actions-部署)。

## 在本機檢查

工作流程本身在本機跑不起來。檢查它們的規則在 [`worker/test/workflows.ts`](../worker/test/workflows.ts)，測試在 `worker/test/workflows.test.ts`：

```sh
pnpm install --frozen-lockfile   # 在根目錄
cd worker
node --experimental-strip-types --test test/workflows.test.ts
```

`worker/` 的 `pnpm test` 也包括它。`changed-paths.sh` 的測試要有 `bash` 和 `git`。`paths` 清單的測試要有 `go` 才完整：沒有 `go` 時，檢查 Go 套件的那一項跳過，其他照查；設了 `CI`（GitHub Actions 會設）或 `IAMREAL_BB` 時沒有 `go`，那一項是失敗，不是跳過。這些規則防手誤和明顯的改動，不能代替逐行看（`CONTRIBUTING.md`「部署會執行到的東西」）。

# .github/：GitHub Actions 的工作流程

**這個目錄讓人檢查的事：PR 的檢查拿不到任何權杖，部署測試網站的權杖只在上傳的那一步。**（ADR-0029）

| 檔案 | 什麼時候跑 | 做什麼 |
|---|---|---|
| [`workflows/checks.yml`](workflows/checks.yml) | 每個 PR（`pull_request`），和合併佇列裡的每一組（`merge_group`） | `CONTRIBUTING.md`「完成的定義」的 Go、`protocol/`、`worker/`、`web/` 的型別檢查和 Node 裡的測試，`device-core/` 的 Rust，`android/` 的 app 的建置、JVM 上的單元測試和 lint：`go`、`typescript`、`device-core`、`android` 四個工作。只能讀，不引用任何 secret；快取只能還原、不能存（`cache-mode: read`，「快取」一節） |
| [`workflows/checks-browser.yml`](workflows/checks-browser.yml) | PR 改到它用到的檔時（`pull_request` 的 `paths`）；不在合併佇列裡跑 | `web/` 的 `pnpm test:e2e`、`pnpm test:ui`：`browser` 一個工作。只能讀，不引用任何 secret |
| [`workflows/checks-ios.yml`](workflows/checks-ios.yml) | PR 改到 `ios/`、`device-core/`、app 包進去或測試讀的檔、或這個檔時（`pull_request` 的 `paths`）；不在合併佇列裡跑 | 在 macOS 上編 `device-core/` 給模擬器、建置 `ios/` 的 app、在模擬器上跑它的測試：`ios` 一個工作（`ios/README.md`）。只能讀，不引用任何 secret |
| [`workflows/deploy-test.yml`](workflows/deploy-test.yml) | 推到 `main` | 打包、檢查，再把那一包上傳到測試網站。碰不到快取（`cache-mode: none`） |
| [`workflows/cache.yml`](workflows/cache.yml) | 推到 `main` | 編譯 `device-core/`、建置 `android/`，把 cargo 的 registry、`device-core/target/`、Gradle 的依賴和 wrapper 存成快取，給 `checks.yml` 的 `device-core`、`android` 還原：`cache-device-core`、`cache-android` 兩個工作。不引用任何 secret，`GITHUB_TOKEN` 只能讀（`contents: read`）；唯一能存快取的工作流程（`cache-mode: write`） |

**為什麼 `browser` 分開、只在有關的檔改了才跑**（#123）：這兩套測試在 GitHub 的 runner 上要約 16 分鐘（2026-11-20 在 #119 量的：`browser` 15 分 28 秒，`go` 1 分 56 秒，`typescript` 5 分 11 秒），是一次檢查的三分之二。只動 `worker/` 或文件的 PR 和它們無關，不必多等這 16 分鐘。分開的時候程式庫還沒公開，Actions 的用量算在組織免費方案每月含的額度裡，用完就不能再跑；2026-11-21 公開之後，標準的 GitHub-hosted runner 在公開的程式庫不算用量（「The following usage remains free independently and does not reduce the included compute usage: Standard GitHub-hosted runners in public repositories」，[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)），所以現在分開是為了時間，不是額度。

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
- **被 `paths` 濾掉的工作流程不會回報檢查。** 它的檢查停在「Pending」，要求它通過的 PR 不能合併（同一節）。`main` 的 ruleset 要求的必要檢查是 `checks.yml` 的 `go`、`typescript`、`device-core`、`android`（`android` 和合併佇列一起加進 ruleset）；要把 `browser` 也設成必要的，`checks-browser.yml` 不能直接列進去，要另想辦法（例如改成同一個工作流程裡一個判斷的工作加 `if`，讓它每次都回報），也要讓它在合併佇列裡跑（下一節）。

**`checks-ios.yml`：runner、Xcode、模擬器的來源。** 這三個值寫死在工作流程檔和 `worker/test/workflows.ts`，來源是 GitHub 的 [actions/runner-images](https://github.com/actions/runner-images)（2026-11-20 讀）：

- `runs-on: xcode-27`：[README 的「Available Images」](https://github.com/actions/runner-images/blob/main/README.md#available-images)列的標籤，Apple 晶片，標著 preview（[公告](https://github.com/actions/runner-images/issues/14404)）。標籤如果在正式推出時改名，這個工作會一直排隊，要跟著改
- `/Applications/Xcode_27.2.app`（build 27B52）和 iOS 27.2 的模擬器 `iPhone 17`：[這個映像的說明](https://github.com/actions/runner-images/blob/main/images/macos/xcode-27-arm64-Readme.md)的「Xcode」和「Installed Simulators」。映像上也有 Rust 和 rustup
- 選它是因為 `ios/` 是用同一版 Xcode（27.2，27B52）開發和測試的。另一個選擇是正式的 `macos-26`，上面最新的是 Xcode 26.6（[macos-26-arm64 的說明](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md)）；`ios/` 沒有在 26.6 上建置過
- 這個工作流程還沒有在 GitHub 上跑過（寫的時候分支還沒推送）；第一次跑的結果記在加它的 PR

**`checks-ios.yml` 的 `paths`** 列出 app 和它的測試用到的東西：`ios/`、`device-core/`，app 包進去的檔（`web/circuits/`、`verifier/vk/`），測試讀的檔（`spec/vectors/`、`design/copy/`、`web/scripts/fetch-crs.mjs`），和這個工作流程檔自己。規格只寫了前兩個（「[規格：手機 app 第一份](https://github.com/iamreal-tw/iamreal/issues/155)」：macOS 的分鐘數算得重）；後面幾個不加的話，只改它們的 PR 會讓 iOS 的檢查壞掉而沒有人看到。代價是改 `design/copy/` 或 `spec/vectors/` 的 PR 也會跑一次 macOS。`worker/test/workflows.test.ts` 讀 `ios/Tests/` 和 `ios/check-app.sh` 的原始碼，確認它們寫出來的路徑都在清單裡；用別的方式拼出來的路徑它看不到。

三個 PR 的工作流程、`deploy-test.yml`、`cache.yml` 的 `concurrency` 群組名稱都不同：群組在所有工作流程之間共用，「concurrency group names must be unique across workflows to avoid canceling in-progress jobs or runs from other workflows」（[workflow syntax 的 `concurrency`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idconcurrency)）。

## 合併佇列（#180）

`main` 用合併佇列：PR 排進佇列後，GitHub 把它和 `main`、排在它前面的 PR 合成一個暫時的分支（`gh-readonly-queue/main/…`），在那上面跑 `main` 要求的檢查，過了才合併（[Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)）。兩個各自綠燈的 PR 合起來是紅的，會在這裡被擋下，不會進 `main`、不會部署到測試網站（#180 的起因）。

- **佇列只跑 `checks.yml`。** 必要檢查要由在 `merge_group` 上跑的工作流程回報，不然佇列等不到（[Events that trigger workflows 的 `merge_group`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group)）。`checks.yml` 只寫了 `checks_requested` 這一種活動，那一頁說寫明活動能讓之後多出新的活動時不被觸發。`checks-browser.yml`、`checks-ios.yml` 不在佇列裡跑：同一頁替 `merge_group` 只列了 `branches`、`branches-ignore` 兩種篩選，沒有 `paths`，放進去每一次合併都要多等瀏覽器測試、多跑一次 macOS。
- **`concurrency`。** PR 的執行照 PR 編號分組，新的推送取消前一次。佇列的執行沒有 PR 編號，改照 `github.ref` 分組，也就是那一組的暫時分支（`merge_group` 的 `GITHUB_REF` 是「Ref of the merge group」，同一頁；`github.ref` 是「The fully-formed ref of the branch or tag that triggered the workflow run」，`pull_request` 以外的觸發「this is the branch or tag ref that triggered the workflow run」，[Contexts reference 的 `github`](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context)）。不這樣分，佇列裡各組的執行會在同一個群組裡互相取消。
- **佇列的執行沒有 fork 的限制。** fork 來的 PR 拿不到 secret、權杖只能讀，文件寫的是 `pull_request`；佇列的暫時分支在這個程式庫裡，裡面有 PR 的改動，文件沒有說那條限制也適用。所以讓它安全的是 `checks.yml` 本身：不引用任何 secret、權杖只能讀、快取只能還原不能存（`cache-mode: read`，「快取」一節），改到它的 PR 要逐行看（`CONTRIBUTING.md`「部署會執行到的東西」），`worker/test/workflows.ts` 擋下引用 secret、放寬權限、別的工作流程也在 `merge_group` 上跑這類改動。
- **必要檢查照工作的名稱比對。** `checks.yml` 的工作必須恰好是 `go`、`typescript`、`device-core`、`android`，而且不設 `name`（`worker/test/workflows.ts` 的 `REQUIRED_CHECKS`）：改了 id 或設了 `name`，回報的檢查就不是 ruleset 等的那一個，佇列會一直等。依據：GitHub 的文件說必要檢查照工作的名稱認，「make sure that job names are unique across all workflows. Using the same job name in multiple workflows can cause ambiguous status check results」（[About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)），`name` 是「a name for the job, which is displayed in the GitHub UI」（[workflow syntax 的 `jobs.<job_id>.name`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idname)）。沒設 `name` 時檢查的名稱就是工作的 id，文件沒有明寫，是看到的：`main` 的 ruleset 要求的 `go`、`typescript`、`device-core` 就是這三個沒設 `name` 的工作的 id（2026-11-21 讀 ruleset）；`android` 是之後加進 `checks.yml` 的工作，和合併佇列一起加進 ruleset。
- **合併是排進佇列。** `gh pr merge` 在必要檢查過了時把 PR 加進佇列，沒過時開自動合併（[Merging a pull request with a merge queue](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue)）。

## 快取（#203）

`device-core` 的檢查從零編要 4 分多鐘（#203 量的）。現在它還原推到 `main` 時存下的 cargo 快取，依賴的套件不必重編。省多少還沒量：`device-core/` 的 release 設定是 `lto = true`、`codegen-units = 1`，每個測試的執行檔在連結時還要做一次 LTO，那一段快取幫不上。`android` 從零要 11 分鐘（#203 量的：Rust 從頭編三次約 5.5 分、lint 約 3 分、下載 Gradle 約 1 分），它還原 cargo 和 Gradle 的快取，Rust 的依賴不必重編，Gradle 和它的依賴不必下載；lint 每次照跑。實際的時間記在加快取的 PR（`device-core` 是 #205，`android` 是 #207）的 Evidence。

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
- 快取裡只有公開的東西（crates.io 的套件、Google 和 Maven Central 的程式庫、Gradle 的發行檔，和編出來的檔）。GitHub 的文件提醒快取誰都讀得到：「Anyone who can open a pull request against your repository can read the contents of caches in the base branch」（Dependency caching 那一頁），所以不能把金鑰放進去；這裡的工作流程本來就拿不到金鑰。

**還剩的風險**（ADR-0029）：一段進了 `main` 的惡意程式，可以在 `cache.yml` 裡把東西留在快取，影響之後的檢查。它既然在 `main`，本來就跑在之後的每一次檢查裡；部署碰不到快取，部署的權杖不受影響。`worker/test/workflows.ts` 看不到 `cache.yml` 的指令在快取裡留下什麼。

**存什麼、鍵是什麼。** 每個快取一個路徑（`worker/test/workflows.ts` 的 YAML 讀法不讀多行的值，所以一個步驟一個路徑；分開存，`gh cache list` 也看得到每一份多大）。每個工作只還原自己的快取：

| 工作 | 快取的名稱 | 路徑 | 內容 |
|---|---|---|---|
| `device-core` | `device-core-cargo-registry` | `~/.cargo/registry` | `Cargo.lock` 列的套件，下載和解開之後的樣子 |
| | `device-core-target` | `device-core/target` | `cargo clippy`、`cargo test` 編出來的東西 |
| `android` | `android-cargo-registry` | `~/.cargo/registry` | 同上，Android 的建置用到的那些 |
| | `android-target-host` | `device-core/target/release` | 給 JVM 測試用的那份（`build-native.sh host`），和兩個 Android 架構的建置腳本、程序巨集（cargo 交叉編譯時把它們編在這裡） |
| | `android-target-aarch64-linux-android` | `device-core/target/aarch64-linux-android` | 手機的架構 |
| | `android-target-x86_64-linux-android` | `device-core/target/x86_64-linux-android` | 模擬器的架構 |
| | `android-gradle-caches` | `~/.gradle/caches` | Gradle 下載的外掛和程式庫，和它從中做出來的東西（轉換過的程式庫、編好的建置腳本） |
| | `android-gradle-wrapper` | `~/.gradle/wrapper` | wrapper 下載的 Gradle 9.9.1 |

`~/.gradle` 只存 `caches` 和 `wrapper`，不存整個目錄：裡面還有 init script（`init.d/`，每次建置都會先跑）和 `gradle.properties`，Gradle 的文件提醒「A shared cache directory that carries init scripts across jobs is a persistence vector」（[Securing the Build Tool](https://docs.gradle.org/current/userguide/securing_build_tool.html#sec:init_scripts)，2026-11-21 讀）。`android` 的兩個工作都用 `--no-daemon`，存快取的時候沒有 Gradle 還在跑、拿著鎖；`actions/cache` 的範例提醒「Ensure no Gradle daemons are running anymore when your workflow completes. Creating the cache package might fail due to locks being held by Gradle」（[examples.md 的 Java - Gradle](https://github.com/actions/cache/blob/v6.1.0/examples.md#java---gradle)）。

**還原回來的東西，大多不會再核對一次。**

- cargo 在下載套件時照 `Cargo.lock` 裡的 checksum 核對；已經在 registry 裡的套件（還原回來的就是）不會再對，`target/` 裡編好的檔也沒有雜湊可對。
- Gradle 的程式庫會再核對：`verification-metadata.xml` 在的時候，「Gradle automatically verifies all dependencies during every build」，核對不過時文件寫的情況之一是「Dependency tampered in local cache - Delete the file from cache and Gradle will re-download」（[Securing Dependencies 的 Enabling Dependency Verification](https://docs.gradle.org/current/userguide/securing_dependencies.html#sub:enabling-verification)，2026-11-21 讀）。文件沒有說它每次重算檔案的雜湊，還是用自己記在 `~/.gradle/caches` 裡的；後者的話，那份紀錄也是還原回來的。Gradle 從程式庫做出來的東西（轉換過的程式庫、編好的建置腳本）不再核對。
- wrapper 只在下載 Gradle 時核對 `distributionSha256Sum`：「If the computed sum matches `distributionSha256Sum`, the Wrapper unpacks the distribution and writes an `.ok` marker file next to it. Subsequent invocations skip verification.」（[Securing the Build Tool 的 distribution checksum](https://docs.gradle.org/current/userguide/securing_build_tool.html#sec:distribution_checksum)，同一天讀）。還原回來的 Gradle 不會再對。

所以有快取的那一次檢查，信任的是 `main` 上那一次 `cache.yml` 留下的內容，就是上面那條還剩的風險。沒有快取的那一次，套件、程式庫和 Gradle 都是當場下載、核對的。

鍵是名稱、runner 的作業系統和架構，加上一組檔的雜湊。兩個工作都有 `.github/workflows/cache.yml`，和 `device-core/` 的 `Cargo.lock`、三個 `Cargo.toml`、`rust-toolchain.toml`、`.cargo/config.toml`、`barretenberg.sha256`、`fetch-barretenberg.sh`：決定編哪些套件、用什麼設定、用哪一版 Rust、連結哪一份 Barretenberg；`cache.yml` 裡是填快取的指令，改了指令或參數（連註解也算）就是新的鍵。`android` 的再加上 `android/` 的：

- `build-native.sh`：cargo 的指令和參數，交給 cc-rs 的 NDK 編譯器
- `settings.gradle.kts`、`build.gradle.kts`、`app/build.gradle.kts`、`gradle.properties`：外掛、程式庫、SDK、NDK 的版本和 `minSdk`（NDK 編譯器的 API level）
- `gradle/verification-metadata.xml`：Gradle 下載的每個檔的 SHA-256，換了任何一個版本，這個檔就變
- `gradle/wrapper/gradle-wrapper.properties`：哪一版 Gradle

`fetch-zig.sh`、`zig.sha256` 不在鍵裡：Zig 只做最後的連結，輸出在 Gradle 的建置目錄，那裡不快取。`android` 的六份快取用同一組檔：Rust 的改了，Gradle 的快取也換新的鍵，反過來也一樣；分開算會多一組要對齊的清單，換來的只是少下載一次。`checks.yml` 算的是同一個鍵。鍵裡的每個檔都要在程式庫裡（`hashFiles` 碰到不存在的路徑不會報錯，只是少算一個檔），`worker/test/workflows.test.ts` 會核對。

- **不設 `restore-keys`。** 鍵要完全相同才還原，不然就當沒有快取：換了依賴或工具鏈的 PR 不會拿到替舊的 `Cargo.lock` 或舊的 Rust 編的 `target/`。代價是這種 PR 的 `device-core`、`android` 從零編，合併後 `cache.yml` 才存新的鍵。
- **同一個鍵只存一次。** 「You cannot change the contents of an existing cache」（同一頁）；鍵已經有快取時 `cache.yml` 還原它、編完、不再存。所以 `target/` 裡 `device-core/` 自己的那部分是第一次存的時候的，之後不更新。這不影響結果：cargo 看原始檔的修改時間，剛 checkout 的檔比快取新，`device-core/` 自己的套件每次都重編；重用的是依賴的套件。Gradle 的快取也停在第一次存的樣子；改了建置腳本就是新的鍵，所以裡面的程式庫和編好的建置腳本是這個鍵的那一版。
- **`cache.yml` 編的和 `checks.yml` 編的相同**：`cache-device-core` 和 `device-core` 在同一個目錄、用同樣的 `BB_LIB_DIR`、同樣的 `cargo clippy --locked --release --all-targets` 和 `cargo test --locked --release`，只差測試加了 `--no-run`（只編不跑：跑測試不會在 `target/` 留下之後用得到的東西）。`cache-android` 和 `android` 的步驟完全相同：同樣的 SDK、同樣的 JDK 17、同一行 `./gradlew --no-daemon build`，測試和 lint 也照跑。兩邊不一樣的話，cargo 和 Gradle 會當成不同的東西重編，快取就白存了；`worker/test/workflows.ts` 裡兩邊共用的步驟和指令只寫一次，改一邊不改另一邊，測試會失敗。
- **沒有快取時照樣通過，只是慢**：第一次、換了鍵、被刪掉的時候。`actions/cache/restore` 的 `fail-on-cache-miss` 預設是 `false`，這裡不設。快取 7 天沒人讀會被刪（「GitHub will remove any cache entries that have not been accessed in over 7 days」），整個程式庫超過 10 GB 時從最久沒用的開始刪（[Usage limits and eviction policy](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#usage-limits-and-eviction-policy)）；被刪之後要等下一次推到 `main` 才會再存。

**大小：10 GB 是 `device-core` 和 `android` 的八份快取加起來的上限。** 合併前量不到（`cache.yml` 只在推到 `main` 時跑），各份的大小記在 #207 的 PR 的 Evidence。本機的 Gradle 可以當參考：`~/.gradle/caches` 約 940 MB（程式庫 460 MB、轉換過的 430 MB），`~/.gradle/wrapper` 約 150 MB，壓縮前。換鍵之後舊的那一組不會馬上刪，要等 7 天沒人讀或被擠掉，所以改了 `Cargo.lock` 或 Gradle 的版本那一週，兩組會同時在。合併後這樣量：

```sh
gh cache list --repo iamreal-tw/iamreal --ref refs/heads/main --limit 100 --sort size_in_bytes \
  --json key,sizeInBytes --jq '.[] | "\(.sizeInBytes / 1048576 | floor) MB  \(.key)"'
```

整個程式庫用了多少：`gh api repos/iamreal-tw/iamreal/actions/cache/usage`。

加起來接近 10 GB 時，先拿掉 `android-target-x86_64-linux-android`（只有模擬器用的除錯版用它），再考慮 `android-target-host`；被擠掉的快取只會讓下一次檢查變慢，不會讓它失敗。

`worker/test/workflows.ts` 擋下的改動：任何一個檔的 `cache-mode` 和上表不同或沒寫，新的工作流程不是 `none`，工作層級設了 `cache-mode`；`checks.yml` 的工作用會存快取的 `actions/cache` 或 `actions/cache/save`，或還原不是自己的快取；`deploy-test.yml`、`checks-browser.yml`、`checks-ios.yml` 或新的工作流程用任何一種快取的 action；`cache.yml` 在推到 `main` 以外的事件上觸發、引用 secret、權限不是恰好 `contents: read`、工作和寫死的不同；快取的 `path`、`key` 和寫死的不同，或多了 `restore-keys`。

怎麼部署、上傳那一步還信任什麼：[`worker/README.md`「從 GitHub Actions 部署」](../worker/README.md#從-github-actions-部署)。

## 在本機檢查

工作流程本身在本機跑不起來。檢查它們的規則在 [`worker/test/workflows.ts`](../worker/test/workflows.ts)，測試在 `worker/test/workflows.test.ts`：

```sh
pnpm install --frozen-lockfile   # 在根目錄
cd worker
node --experimental-strip-types --test test/workflows.test.ts
```

`worker/` 的 `pnpm test` 也包括它。`paths` 清單的測試要有 `go` 才完整：沒有 `go` 時，檢查 Go 套件的那一項跳過，其他照查；設了 `CI`（GitHub Actions 會設）或 `IAMREAL_BB` 時沒有 `go`，那一項是失敗，不是跳過。這些規則防手誤和明顯的改動，不能代替逐行看（`CONTRIBUTING.md`「部署會執行到的東西」）。

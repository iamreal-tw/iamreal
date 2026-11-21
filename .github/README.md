# .github/：GitHub Actions 的工作流程

**這個目錄讓人檢查的事：PR 的檢查拿不到任何權杖，部署測試網站的權杖只在上傳的那一步；上傳 app 的金鑰只在不建置的那個工作。**（ADR-0029、ADR-0036）

| 檔案 | 什麼時候跑 | 做什麼 |
|---|---|---|
| [`workflows/checks.yml`](workflows/checks.yml) | 每個 PR（`pull_request`），和合併佇列裡的每一組（`merge_group`） | `CONTRIBUTING.md`「完成的定義」的 Go、`protocol/`、`worker/`、`web/` 的型別檢查和 Node 裡的測試，`device-core/` 的 Rust，`android/` 的 app 的建置、JVM 上的單元測試和 lint：`go`、`typescript`、`device-core`、`android` 四個工作，加上決定 PR 階段跑哪幾個的 `changes`（下面「必要檢查在 PR 階段照路徑跳過」）。只能讀，不引用任何 secret；快取只能還原、不能存（`cache-mode: read`，「快取」一節） |
| [`workflows/checks-browser.yml`](workflows/checks-browser.yml) | PR 改到它用到的檔時（`pull_request` 的 `paths`）；不在合併佇列裡跑 | `web/` 的 `pnpm test:e2e`、`pnpm test:ui`、`pnpm test:worker`：`browser` 一個工作。只能讀，不引用任何 secret |
| [`workflows/checks-ios.yml`](workflows/checks-ios.yml) | PR 改到 `ios/`、`device-core/`、app 包進去或測試讀的檔、或這個檔時（`pull_request` 的 `paths`）；不在合併佇列裡跑 | 在 macOS 上編 `device-core/` 給模擬器、建置 `ios/` 的 app、在模擬器上跑它的測試：`ios` 一個工作（`ios/README.md`）。只能讀，不引用任何 secret |
| [`workflows/deploy-test.yml`](workflows/deploy-test.yml) | 推到 `main` | 建置過卡的頁面、打包 Worker、檢查兩者，再把它們上傳到測試網站。碰不到快取（`cache-mode: none`） |
| [`workflows/upload-android.yml`](workflows/upload-android.yml) | 營運者手動觸發（`workflow_dispatch`），只在 `main` 上 | 建置 Android 的商店 build（`tw.iamreal.app`）、用上傳金鑰簽章，傳到 Google Play 的內部測試：`build`、`upload` 兩個工作（下面「上傳 Android 的 app」）。金鑰只在 `upload`，它在 environment `app-test` 裡；碰不到快取（`cache-mode: none`） |
| [`workflows/cache.yml`](workflows/cache.yml) | 推到 `main` | 編譯 `device-core/`、建置 `android/`，把 cargo 的 registry、`device-core/target/`、Gradle 的依賴和 wrapper 存成快取，給 `checks.yml` 的 `device-core`、`android` 還原：`cache-device-core`、`cache-android` 兩個工作。不引用任何 secret，`GITHUB_TOKEN` 只能讀（`contents: read`）；唯一能存快取的工作流程（`cache-mode: write`） |

**為什麼 `browser` 分開、只在有關的檔改了才跑**（#123）：這兩套測試在 GitHub 的 runner 上要約 16 分鐘（2026-11-20 在 #119 量的：`browser` 15 分 28 秒，`go` 1 分 56 秒，`typescript` 5 分 11 秒），是一次檢查的三分之二。只動文件、app 或 `server/` 的 PR 和它們無關，不必多等這 16 分鐘（那時這兩套測試配的是 Go 的舊後台，只動 `worker/` 的 PR 也不跑；#69 之後它們對 Worker 跑，`worker/` 有改就跑）。分開的時候程式庫還沒公開，Actions 的用量算在組織免費方案每月含的額度裡，用完就不能再跑；2026-11-21 公開之後，標準的 GitHub-hosted runner 在公開的程式庫不算用量（「The following usage remains free independently and does not reduce the included compute usage: Standard GitHub-hosted runners in public repositories」，[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)），所以現在分開是為了時間，不是額度。`checks.yml` 的四個必要檢查在 PR 階段也照路徑跳過（#206），但做法不同、在合併佇列裡四項全跑：見下面「必要檢查在 PR 階段照路徑跳過」。

`checks-browser.yml` 的 `paths` 列出這三套測試用到的東西：頁面（`web/`、`protocol/`）、畫面上的字（`design/`）、規格和標準答案（`spec/`）、它們對著跑的後台（`worker/`，#69）、`pnpm test:ui` 建置來重驗名冊的 Go 程式 `iamreal-verify` 和它引用的套件（`cmd/`、`verifier/`、`roster/`、`crl/`、`go.mod`、`go.sum`）、套件（`pnpm-lock.yaml`、`pnpm-workspace.yaml`）和這個工作流程檔自己。照 GitHub 的文件（[workflow syntax 的 `on.<event>.paths`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore)）：

- PR 改到的檔只要有一個符合其中一項，工作流程就跑。樣式要從根目錄比對整個路徑，`**` 包括 `/`；沒有 `/` 的樣式（例如 `go.mod`）只比對根目錄的那個檔。
- 改到哪些檔，看的是整個 PR 對基底分支的差異（「three-dot diffs for pull requests」），不是這一次推送改的。
- 被濾掉、沒有跑的工作流程，它的檢查停在「Pending」。

**清單的測試只是多一層提醒。** `worker/test/workflows.test.ts` 讀這三套測試的原始碼（`web/test/e2e/`、`web/test/worker-card-proof.ts`，和它們引用的檔，包括 `worker/test/` 的測試工具），找出它們用到的最上層目錄和檔，確認每一個都在清單裡。找得到的寫法：

- 相對路徑的 import（含 JSON）、用 workspace 套件名稱的 import（`iamreal-protocol/…`，或 `pnpm-workspace.yaml` 裡其他套件的名稱）、頁面 HTML 的 `<script src>`
- `join(repo, "<目錄>"…)`、`join(web, "..", "<目錄>"…)`、`join(web, "../<目錄>"…)`，折行的也算
- `new URL("../…", import.meta.url)`
- 它們 `go build` 的套件（寫成 `"go", [… "./<套件>"`），和那些套件引用的這個模組裡的每個套件（`go list -deps`）

找不到的寫法（#123 的審查試過）：樣板字串（`` `${repo}/docs` ``）、用 `+` 接起來的路徑、帶 `?raw` 的 import、CSS 的 `@import`、套件名放在變數裡的 `go build`、它們啟動的程式在執行時讀的檔，以及執行時用其他方式拼出來的路徑。所以讓這幾套測試多用一個目錄的人，要自己把它加進清單。

**`worker/**` 在清單裡，`server/**` 不在**（#69）。這三套測試對本機 workerd 裡的 Worker 跑：wrangler 從 `worker/` 打包、讀 `worker/wrangler.jsonc` 和 `worker/site/`，這些是執行時才讀的，上面的讀法看不到，所以整個 `worker/` 手動列進去。Go 的舊後台 `server/` 它們不再建置，也不啟動；`workflows.test.ts` 確認它們建置的 Go 程式只有 `./cmd/iamreal-verify`，而它不引用 `server/`。

改對 Worker 跑之後，這個工作在 GitHub 的 runner 上跑完過一次：PR #235 的最後一次，11 分 50 秒（2026-11-21）。同一個 PR 的前一次跑了 14 分 43 秒還沒跑完，就因為分支有新的提交被取消了，所以花的時間不只這一個數字，還要再看幾次。在一台同時跑著別的測試的 M1 Max 上，三套依序是約 3 分、6 分、40 秒（同一天）。工作的上限是 30 分鐘。

一個限制：

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
- **`changes` 失敗時，四個必要檢查是失敗，不是跳過。** 同一頁說「A job depends on a failed job」時「The dependent job is skipped and may not block merging」，要「Use `always()` with `needs` for required checks that depend on other jobs」。所以 `if` 以 `always()` 開頭，`changes` 沒有成功時四個工作照樣開始；它們的第一步檢查 `changes` 的結果（經 `env` 拿到），不是 `success` 就失敗。腳本遇到任何問題（找不到基底的提交、清單裡有它不認得的樣式）就以失敗結束，`changes` 跟著失敗；那之前它可能已經替前面幾項寫了輸出，但 `changes` 沒有成功時 `if` 不看輸出，四項都會開始、在第一步失敗。用 `always()` 而不是 `!cancelled()`：`cancelled()` 在執行被取消時是真（「Returns `true` if the workflow was canceled」，[Expressions 的 Status check functions](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions)），那時 `!cancelled()` 開頭的 `if` 是假，還沒開始的必要檢查會是被條件跳過、回報成功。`always()` 在被取消時也是真（「Causes the step to always execute, and returns `true`, even when canceled」，同一節），代價是取消一次執行時，還沒開始的必要檢查可能會開始，`changes` 沒成功的話在第一步失敗。這一段是照文件推的，還沒有在 GitHub 上看過取消時的實際結果。
- **清單在哪裡。** 四份清單寫在 `worker/test/workflows.ts`（`GO_PATHS`、`TYPESCRIPT_PATHS`、`DEVICE_CORE_PATHS`、`ANDROID_PATHS`），格式和比對規則同 `BROWSER_PATHS`、`IOS_PATHS`：從根目錄比對整個路徑，`**` 包括 `/`。只用兩種樣式：沒有萬用字元的路徑（就那一個檔），和 `<目錄>/**`（底下所有的檔）；其他樣式規則和腳本都不接受。目錄沒寫 `/**` 的話腳本會把它當成一個檔名、永遠比對不到，所以 `workflows.test.ts` 另外確認清單裡沒有哪一項是程式庫裡的目錄卻沒寫 `/**`。`checks.yml` 把清單寫在 `changes` 的 `env`（一份清單一行，用空白隔開），腳本從那裡讀；`worker/test/workflows.ts` 的規則要求 `env` 和清單一字不差，所以沒有第二份會走樣的清單。改清單要同時改 `workflows.ts` 和 `checks.yml` 的那一行。
- **每一份清單都有的**：`checks.yml` 和 `changed-paths.sh`、`worker/test/workflows.ts` 和 `workflows.test.ts`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`go.mod`、`go.sum`。改 CI 或套件的 PR 四項都跑。另外有七個現在不存在的根目錄檔：`.npmrc`、`.pnpmfile.cjs`、`package.json`（改變 pnpm 從哪裡裝、怎麼裝）、`go.work`、`go.work.sum`（Go 的 workspace）、`.cargo/config.toml`（cargo 會從 `device-core/` 往上找到它）、`.gitattributes`（改變檔案取出來的樣子）。沒有萬用字元的樣式比對的是檔名，所以哪個 PR 加了其中一個，四項都跑。
- **`typescript` 的清單幾乎是全部**：除了 `docs/` 和根目錄的文件以外的每個目錄。`worker/` 的測試會建置、執行 Go 的程式，`workflows.test.ts` 會讀 `android/`、`ios/`、`device-core/` 和工作流程。所以 PR 階段省下的主要是只改文件的 PR（四項都跳過），和只改 Go、Rust、app 的 PR 各自不相關的那幾項。

`worker/test/workflows.ts` 的規則擋下：必要檢查不經過 `changes`、在 `merge_group` 上可以被跳過、`changes` 沒成功時變成跳過、`changes` 用了別的 action 或別的指令。它是把 `if` 當運算式算過每一種情況（`changes` 的結果、輸出、事件、有沒有被取消），不是比對文字；它讀不懂的 `if` 一律算問題。`workflows.test.ts` 另外在一個暫時的 git 程式庫裡實際跑 `changed-paths.sh`，餵它 `checks.yml` 裡的清單。

**清單的涵蓋測試和它看不到的。** 和 `BROWSER_PATHS` 一樣，測試只是多一層提醒：它讀原始碼，找出寫得出來的路徑，確認都在清單裡。漏掉的不會讓 `main` 變紅（佇列全跑），但 PR 階段會少跑那一項，所以讓某個檢查多讀一個目錄的人，要自己把它加進清單。

- **根目錄的設定檔**：上面那七個是手寫的，涵蓋測試不看。工具會自己往上層目錄找的其他設定檔（例如根目錄的 `rust-toolchain.toml`、`tsconfig.json`、`.tool-versions`），加的人要自己加進清單。子目錄裡的同類檔，只有整個目錄在清單裡的檢查才涵蓋：`typescript` 有 `protocol/**`、`worker/**`、`web/**`（例如 `web/.npmrc`），`device-core`、`android` 有 `device-core/**`（例如 `device-core/.cargo/config.toml`）。`go` 不涵蓋：它在根目錄跑 `pnpm install`，清單裡和套件有關的只有根目錄那幾個檔和三個 `package.json`，三個套件目錄裡其他會影響安裝的檔不在它的清單。
- **`go`**：`go list` 列出的每個套件的目錄，加上 Go 原始碼裡以 `../` 開頭的字串和 `filepath.Join("..", …)` 指到的檔（測試讀的 `spec/`、`design/copy/`、`web/README.md`、一份 ADR）。手寫的：三個 `package.json`（這個工作會 `pnpm install` 來拿 bb）。看不到：用其他方式拼出來的路徑、測試從環境變數拿到的路徑、清單以外的目錄裡新增的 Go 檔（`go build ./...`、`gofmt -l .` 會掃到）。
- **`typescript`**：`protocol/`、`worker/`、`web/` 每個有進版本控制的原始碼，找得到的寫法和 `BROWSER_PATHS` 的相同（import、`join(…)`、`new URL(…)`、`"go", […]`），`join` 的第一個參數認 `REPO`、`repo`、`WORKER_DIR`、`web`、`here` 這幾個名字；它們用到的 Go 套件再照 `go` 的做法找。看不到的也相同，另外看不到 `new URL` 只寫到根目錄的（`` `../../${path}` ``）。
- **`device-core`**：Rust 裡的 `repo_file("…")`、`vectors("…")`、`.join("../…")`、`include_str!`、`include_bytes!`，和 `Cargo.toml` 的 `path = "…"`。現在的程式沒有 `include_str!`、`include_bytes!`、`build.rs`；測試是在執行時讀檔。手寫、偵測不到的：`build.rs` 或相依套件的巨集在編譯時讀的檔、用 `format!` 以外的方式拼出來的路徑、兩個下載的腳本（`fetch-barretenberg.sh`、`fetch-crs.sh`）讀的東西。這些現在都在 `device-core/` 裡（雜湊檔 `barretenberg.sha256`、`crs.sha256`、`.cargo/config.toml`、`rust-toolchain.toml`、`Cargo.lock`），整個目錄在清單裡；之後有哪一個讀到 `device-core/` 以外，要手動加。清單裡另外有 `workflows/cache.yml`：它的雜湊在這個工作還原的快取的鍵裡（「快取」一節），改它的 PR 會讓這個工作從零編一次。`android` 的清單也一樣。這一項有規則看著：`worker/test/workflows.ts` 從每個工作的快取的鍵讀出 `hashFiles(…)` 列的檔，每一個都要在那個工作的清單裡。
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
- **合併後自動刪掉 PR 的分支**（#215）。程式庫設定的「Automatically delete head branches」（`delete_branch_on_merge`）2026-11-21 打開：「You can have head branches automatically deleted after pull requests are merged in your repository」（[Managing the automatic deletion of branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches)）。刪掉的分支可以在 PR 頁面按「Restore branch」救回來（[Deleting and restoring branches in a pull request](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-branches-in-your-repository/deleting-and-restoring-branches-in-a-pull-request#restoring-a-deleted-branch)）。同一個程式庫裡以被刪分支為基底、還開著的 PR 會改基底：「GitHub automatically updates any such pull requests, changing their base branch to the merged pull request's base branch」（[Managing branches within your repository](https://docs.github.com/en/pull-requests/how-tos/commit-changes/managing-branches-within-your-repository#deleting-a-branch)）。從 fork 來的 PR 看的是 fork 的設定，這裡的設定管不到：「GitHub uses the Automatically delete head branches setting on the head repository (the fork)」（[Managing the automatic deletion of branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches)）。從合併佇列合併時會不會刪，文件沒有提到；打開後第一個從佇列合併的是 #215，結果記在它的留言。這個值也在 GitHub 上，不在程式庫裡（`gh api repos/iamreal-tw/iamreal -q .delete_branch_on_merge` 讀）；改了要回來更新這一點。
- **排進佇列前，自己確認 `browser`、`ios` 通過。** 這兩項不是必要檢查，也不在佇列裡跑（「佇列只跑 `checks.yml`」那一點）：PR 上它們紅燈或還在跑，`gh pr merge` 照樣能把 PR 排進佇列，佇列也不會擋，紅燈的測試就這樣進了 `main`。
- **不必為了和最新的 `main` 同步而把 `main` 併進分支。** 佇列會把 PR 疊在最新的 `main`（和排在它前面的 PR）上重跑必要檢查，合起來是不是綠的由佇列負責；自己先併一次只會多跑一整輪檢查。只有兩種情況要併：和 `main` 有衝突，或這個 PR 需要 `main` 上新的東西（例如要用剛合併的程式，或要在 PR 上看 `browser`、`ios` 對合起來的結果跑）。

## 快取（#203）

`device-core` 的檢查還原推到 `main` 時存下的 cargo 快取，依賴的套件不必重編。`android` 還原 cargo 和 Gradle 的快取，Rust 的依賴不必重編，Gradle 和它的依賴不必下載；lint 每次照跑。

2026-11-20（UTC）量的，同一個提交各跑一次沒有快取、有快取（只重跑那一個工作）：

| 工作 | 沒有快取 | 有快取 | 量的執行 |
|---|---|---|---|
| `device-core` | 6 分 21 秒（`cargo clippy` 25 秒、`cargo test` 301 秒） | 5 分 46 秒（2 秒、275 秒） | [44802298028](https://github.com/iamreal-tw/iamreal/actions/runs/44802298028) 第 1、2 次 |
| `android` | 7 分 19 秒（`gradlew build` 361 秒） | 6 分 31 秒（299 秒，還原六份 25 秒） | [44811758760](https://github.com/iamreal-tw/iamreal/actions/runs/44811758760) 第 1、2 次 |

省得不多。有快取時，時間大半花在 `device-core/` 自己的兩個 crate（`checks`、`prover`）：`device-core/` 的 release 設定是 `lto = true`、`codegen-units = 1`，每次都要重做 LTO，快取幫不上（`device-core` 的 `cargo test` 裡這一段約 4 分；`android` 的 `gradlew build` 裡三次 `cargo build --release --lib` 各約 1 分）。要再快得從這裡下手（#212）。

**誰能寫、誰能讀：靠每個工作流程最上面的 `cache-mode`。**

| 工作流程 | `cache-mode` | 快取的 action |
|---|---|---|
| `cache.yml`（推到 `main`） | `write`：能還原、能存 | `actions/cache` |
| `checks.yml`（PR 和合併佇列） | `read`：能還原、不能存 | `actions/cache/restore` |
| `deploy-test.yml`、`checks-browser.yml`、`checks-ios.yml`、`upload-android.yml` | `none`：都不能 | 沒有 |

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

`~/.gradle` 只存 `caches` 和 `wrapper`，不存整個目錄：裡面還有 init script（`init.d/`，每次建置都會先跑）和 `gradle.properties`，Gradle 的文件提醒「A shared cache directory that carries init scripts across jobs is a persistence vector」（[Securing the Build Tool](https://docs.gradle.org/current/userguide/securing_build_tool.html#sec:init_scripts)，2026-11-21 讀）。`android` 的兩個工作都用 `--no-daemon`，存快取的時候沒有 Gradle 還在跑、拿著鎖；`actions/cache` 的範例提醒「Ensure no Gradle daemons are running anymore when your workflow completes. Creating the cache package might fail due to locks being held by Gradle」（[examples.md 的 Java - Gradle](https://github.com/actions/cache/blob/v6.1.0/examples.md#java---gradle)，2026-11-21 讀）。`cache-android` 的最後一步、存快取之前，刪掉 `~/.gradle/caches` 裡的 `*.lock` 和 `gc.properties`：Gradle 講複製它的依賴快取時寫「Do not copy the `*.lock` or `gc.properties` files if they exist.」（[Dependency caching 的 Copying and reusing the cache](https://docs.gradle.org/current/userguide/dependency_caching.html#sec:cache-copy)，2026-11-21 讀）。

**還原回來的東西，大多不會再核對一次。**

- cargo 在下載套件時照 `Cargo.lock` 裡的 checksum 核對；已經在 registry 裡的套件（還原回來的就是）不會再對，`target/` 裡編好的檔也沒有雜湊可對。
- Gradle 的程式庫會再核對：`verification-metadata.xml` 在的時候，「Gradle automatically verifies all dependencies during every build」，核對不過時文件寫的情況之一是「Dependency tampered in local cache - Delete the file from cache and Gradle will re-download」（[Securing Dependencies 的 Enabling Dependency Verification](https://docs.gradle.org/current/userguide/securing_dependencies.html#sub:enabling-verification)，2026-11-21 讀）。文件沒有說它每次重算檔案的雜湊，還是用記下來的；Gradle 9.9.1 的原始碼是重算：核對時用的 `ChecksumService`（[ChecksumAndSignatureVerificationOverride.java](https://github.com/gradle/gradle/blob/v9.9.1/platforms/software/dependency-management/src/main/java/org/gradle/api/internal/artifacts/ivyservice/ivyresolve/verification/ChecksumAndSignatureVerificationOverride.java)）把算過的雜湊記在一個 `CrossBuildFileHashCache`（[DefaultChecksumService.java](https://github.com/gradle/gradle/blob/v9.9.1/platforms/core-execution/hashing-services/src/main/java/org/gradle/internal/hash/DefaultChecksumService.java)），它放在建置自己的快取目錄（[CoreBuildSessionServices.java](https://github.com/gradle/gradle/blob/v9.9.1/subprojects/core/src/main/java/org/gradle/internal/service/scopes/CoreBuildSessionServices.java)），沒有另外指定時是建置根目錄底下的 `.gradle`（[BuildScopeCacheDir.java](https://github.com/gradle/gradle/blob/v9.9.1/subprojects/core/src/main/java/org/gradle/cache/internal/BuildScopeCacheDir.java)），這裡就是 `android/.gradle/`，不在快取裡，剛 checkout 時也沒有。所以從還原回來的快取拿的每個程式庫，都重算一次 SHA-256 再對（2026-11-21 讀的原始碼，`v9.9.1` 這個標籤，和 `gradle-wrapper.properties` 的版本相同）。Gradle 從程式庫做出來的東西（轉換過的程式庫、編好的建置腳本）不再核對。
- wrapper 只在下載 Gradle 時核對 `distributionSha256Sum`：「If the computed sum matches `distributionSha256Sum`, the Wrapper unpacks the distribution and writes an `.ok` marker file next to it. Subsequent invocations skip verification.」（[Securing the Build Tool 的 distribution checksum](https://docs.gradle.org/current/userguide/securing_build_tool.html#sec:distribution_checksum)，同一天讀）。還原回來的 Gradle 不會再對。

所以有快取的那一次檢查，信任的是 `main` 上那一次 `cache.yml` 留下的內容，就是上面那條還剩的風險。沒有快取的那一次，套件、程式庫和 Gradle 都是當場下載、核對的。

鍵是名稱、runner 的作業系統和架構，加上一組檔的雜湊。兩個工作都有 `.github/workflows/cache.yml`，和 `device-core/` 的 `Cargo.lock`、三個 `Cargo.toml`、`rust-toolchain.toml`、`.cargo/config.toml`、`barretenberg.sha256`、`fetch-barretenberg.sh`：決定編哪些套件、用什麼設定、用哪一版 Rust、連結哪一份 Barretenberg；`cache.yml` 裡是填快取的指令，改了指令或參數（連註解也算）就是新的鍵。`android` 的再加上 `android/` 的：

- `build-native.sh`：cargo 的指令和參數，交給 cc-rs 的 NDK 編譯器
- `settings.gradle.kts`、`build.gradle.kts`、`app/build.gradle.kts`、`gradle.properties`：外掛、程式庫、SDK、NDK 的版本和 `minSdk`（NDK 編譯器的 API level）
- `gradle/verification-metadata.xml`：Gradle 下載的每個檔的 SHA-256，換了任何一個版本，這個檔就變
- `gradle/wrapper/gradle-wrapper.properties`：哪一版 Gradle

`fetch-zig.sh`、`zig.sha256` 不在鍵裡：Zig 只做最後的連結，輸出在 Gradle 的建置目錄，那裡不快取。`android` 的六份快取用同一組檔：Rust 的改了，Gradle 的快取也換新的鍵，反過來也一樣；分開算會多一組要對齊的清單，換來的只是少下載一次。`checks.yml` 算的是同一個鍵。鍵裡的每個檔都要在程式庫裡（`hashFiles` 碰到不存在的路徑不會報錯，只是少算一個檔），`worker/test/workflows.test.ts` 會核對。

- **不設 `restore-keys`。** 鍵要完全相同才還原，不然就當沒有快取：換了依賴或工具鏈的 PR 不會拿到替舊的 `Cargo.lock` 或舊的 Rust 編的 `target/`。代價是這種 PR 的 `device-core`、`android` 從零編，合併後 `cache.yml` 才存新的鍵。
- **同一個鍵只存一次。** 「You cannot change the contents of an existing cache」（GitHub 的 Dependency caching 那一頁）；鍵已經有快取時 `cache.yml` 還原它、編完、不再存。所以 `target/` 裡 `device-core/` 自己的那部分是第一次存的時候的，之後不更新。這不影響結果：cargo 看原始檔的修改時間，剛 checkout 的檔比快取新，`device-core/` 自己的套件每次都重編；重用的是依賴的套件。Gradle 的快取也停在第一次存的樣子；改了建置腳本就是新的鍵，所以裡面的程式庫和編好的建置腳本是這個鍵的那一版。
- **`cache.yml` 編的和 `checks.yml` 編的相同**：`cache-device-core` 和 `device-core` 在同一個目錄、用同樣的 `BB_LIB_DIR`、同樣的 `cargo clippy --locked --release --all-targets` 和 `cargo test --locked --release`，只差測試加了 `--no-run`（只編不跑：跑測試不會在 `target/` 留下之後用得到的東西）。`cache-android` 和 `android` 的步驟相同：同樣的 SDK、同樣的 JDK 17、同一行 `./gradlew --no-daemon build`，測試和 lint 也照跑；`cache-android` 只在最後多一步刪掉鎖檔和 `gc.properties`。兩邊不一樣的話，cargo 和 Gradle 會當成不同的東西重編，快取就白存了；`worker/test/workflows.ts` 裡兩邊共用的步驟和指令只寫一次，改一邊不改另一邊，測試會失敗。
- **沒有快取時照樣通過，只是慢**：第一次、換了鍵、被刪掉的時候。`actions/cache/restore` 的 `fail-on-cache-miss` 預設是 `false`，這裡不設。快取 7 天沒人讀會被刪（「GitHub will remove any cache entries that have not been accessed in over 7 days」），整個程式庫超過 10 GB 時從最久沒用的開始刪（[Usage limits and eviction policy](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#usage-limits-and-eviction-policy)）；被刪之後要等下一次推到 `main` 才會再存。

**大小：10 GB 是 `device-core` 和 `android` 的八份快取加起來的上限。** 2026-11-20（UTC）第一次存完的大小（`gh cache list` 的 `sizeInBytes`，壓縮後，單位 MiB）：

| 快取 | MiB |
|---|---|
| `android-gradle-caches` | 352 |
| `device-core-target` | 207 |
| `android-target-host` | 145 |
| `android-gradle-wrapper` | 128 |
| `android-target-aarch64-linux-android` | 119 |
| `android-target-x86_64-linux-android` | 117 |
| `device-core-cargo-registry`、`android-cargo-registry` | 各 17 |

一組約 1.1 GB，換鍵那一週兩組同時在也約 2.3 GB，離 10 GB 很遠。換鍵之後舊的那一組不會馬上刪，要等 7 天沒人讀或被擠掉，所以改了 `Cargo.lock` 或 Gradle 的版本那一週，兩組會同時在。重新量：

```sh
gh cache list --repo iamreal-tw/iamreal --ref refs/heads/main --limit 100 --sort size_in_bytes \
  --json key,sizeInBytes --jq '.[] | "\(.sizeInBytes / 1048576 | floor) MB  \(.key)"'
```

整個程式庫用了多少：`gh api repos/iamreal-tw/iamreal/actions/cache/usage`。

加起來接近 10 GB 時要拿掉幾份，照每 GB 省下的時間決定先拿掉哪一份：兩個 Android 架構每次 `gradlew build` 都會編（除錯版是兩個都編），沒有哪一份是用不到的。照上面的量法，現在不用拿。被擠掉的快取只會讓下一次檢查變慢，不會讓它失敗。

`worker/test/workflows.ts` 擋下的改動：任何一個檔的 `cache-mode` 和上表不同或沒寫，新的工作流程不是 `none`，工作層級設了 `cache-mode`；`checks.yml` 的工作用會存快取的 `actions/cache` 或 `actions/cache/save`，或還原不是自己的快取；`deploy-test.yml`、`checks-browser.yml`、`checks-ios.yml`、`upload-android.yml` 或新的工作流程用任何一種快取的 action；`cache.yml` 在推到 `main` 以外的事件上觸發、引用 secret、權限不是恰好 `contents: read`、工作和寫死的不同；快取的 `path`、`key` 和寫死的不同，或多了 `restore-keys`。

怎麼部署、上傳那一步還信任什麼：[`worker/README.md`「從 GitHub Actions 部署」](../worker/README.md#從-github-actions-部署)。

## 上傳 Android 的 app（#175）

[`workflows/upload-android.yml`](workflows/upload-android.yml) 把 Android 的商店 build（`tw.iamreal.app`，ADR-0037）傳到 Google Play 的內部測試軌道。上線前它連測試網站、簽測試名冊的場合字串（`android/README.md`「兩種 build」）。

**怎麼觸發。** 只能手動：GitHub 的 Actions 頁面選 `upload-android`、「Run workflow」，分支選 `main`；或在營運者的電腦上 `gh workflow run upload-android.yml --ref main`（coding agent 也可以，ADR-0036）。推送、合併、別的工作流程都不會觸發它；它不收任何輸入。一次只跑一個，不取消正在跑的（`concurrency`）；在它跑的時候再觸發，新的那次等著，但同時只能有一次在等：再觸發一次，等著的那次會被取消（「By default, any existing pending job or workflow in the same concurrency group will be canceled and the new queued job or workflow will take its place」，[workflow syntax 的 `concurrency`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)，2026-11-21 讀）。

**兩個工作。**

| 工作 | 拿得到什麼 | 做什麼 |
|---|---|---|
| `build` | 沒有 secret；權杖只能讀程式 | 不在 `main` 上就停。用 [`android-version.sh`](workflows/android-version.sh) 算版本。和 `checks.yml` 的 `android` 一樣裝 libc++、Rust、SDK、參數檔，再跑 `./gradlew bundleRelease`，帶上版本。`bundleRelease` 會接著跑 bundle 的檢查（`checkBundle`、`checkManifest`、`checkLibraries`，`android/README.md`「建置時的檢查」）：識別碼、連測試網站、沒有正式網站和正式名冊的場合字串、沒有假卡片和測試的發證金鑰。檢查不過就停，不會上傳。簽哪一份名冊的場合字串由 Kotlin 傳給核心的名冊編號決定（`Environment.kt` 的 `ROSTER`），編進 dex 時只是一個數字，bundle 的檢查找不到它；它由 `DeviceCoreTest` 的「the scope string is the one of the test roster」看著，那是 `checks.yml` 的 `android` 每次都跑的單元測試，`main` 上的每個提交都在合併佇列裡跑過（「合併佇列」），所以這裡不再跑一次。沒有簽章的 `.aab` 留成 artifact `android-bundle` |
| `upload` | environment `app-test` 的三個 secret | 不建置、不跑 Gradle。拿 `build` 留下的 `.aab`，用 [`android-sign.sh`](workflows/android-sign.sh) 以上傳金鑰簽章，簽好的留成 artifact `android-bundle-signed`，再用 [`play-upload.sh`](workflows/play-upload.sh) 傳到內部測試 |

- **金鑰只在 `upload`。** secret 名稱照 #162：`ANDROID_UPLOAD_KEYSTORE_BASE64`、`ANDROID_UPLOAD_KEYSTORE_PASSWORD` 只在簽章那一步的 `env`，`PLAY_SERVICE_ACCOUNT_JSON` 只在上傳那一步的 `env`。`app-test` 只把 secret 給 `main` 上的工作（#162 的設定），所以在別的分支上觸發時，`build` 先停下來；就算它沒停，`upload` 也拿不到金鑰。
- **跑 Gradle 的工作拿不到金鑰。** Gradle 的外掛、建置腳本、`build-native.sh` 都在 `build` 裡跑；`upload` 只跑釘住的三個 action、runner 上的 JDK（`jarsigner`）和工具（`bash`、`base64`、`unzip`、`awk`、`curl`、`openssl`、`jq`），和同一個提交的兩個腳本。
- **傳上去的就是檢查過的。** `android-sign.sh` 簽完先用 `jarsigner -verify` 驗，再比對簽好的檔和 `build` 留下的檔：每個檔的 CRC-32 相同，只多了簽章的三個檔（`META-INF/MANIFEST.MF`、`UPLOAD.SF`、`UPLOAD.RSA`），否則停下來。
- **app 的簽章金鑰不在這裡。** 上傳金鑰只對 Google Play 證明這個檔是我們傳的；手機上的 app 由 Google Play 用 app 的簽章金鑰重簽，那把由營運者保管（ADR-0036、ADR-0037）。
- **新 app 的第一個 build 要手動傳。** Google 的文件：「You can only use this API to make changes to an existing app (that has at least one APK uploaded); thus, you will have to upload at least one APK through the Play Console before you can use this API.」（[Edits](https://developers.google.com/android-publisher/edits)，2026-11-21 讀）。所以第一次執行在 `play-upload.sh` 失敗、印出 API 的回答；營運者從這次執行的 artifact 下載 `android-bundle-signed`，在 Play Console 傳到內部測試（#162 第二段）。上傳金鑰不經過營運者的電腦。之後的 build 走 API。

**版本號**（ADR-0036「版本號和標籤」，照 #176 改的；兩個 app 寫法相同）。

- 顯示的版本（`versionName`）是台灣的日期（UTC+8，沒有日光節約時間），年、月、日不補零，例如 `2026.11.5`、`2026.11.21`。日期取的是 `build` 算版本那一步執行的時候：觸發後排隊排過午夜的話，是隔天。同一天的每次上傳顯示的版本相同，靠 `versionCode` 分。不像網站的標籤那樣加 `.1`：iOS 顯示的版本「The required format is three period-separated integers」（[CFBundleShortVersionString](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleshortversionstring)，2026-11-21 讀），兩個 app 寫法一致（#176）。
- `versionCode` 是這次執行的編號 `github.run_number`：「A unique number for each run of a particular workflow in a repository. This number begins at 1 for the workflow's first run, and increments with each new run. This number does not change if you re-run the workflow run.」（[Contexts reference 的 `github`](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context)，2026-11-21 讀）。Android 的文件要每一版的 `versionCode` 比前一版大，並說「You can't upload an APK to the Play Store with a versionCode you have already used for a previous version」、「The greatest value Google Play allows for versionCode is 2100000000」（[Version your app](https://developer.android.com/studio/publish/versioning)，同一天讀）。所以：
  - 重跑一次已經傳上去的執行，`versionCode` 和上次相同，會被 Google Play 拒絕；要重新觸發一次
  - 這個工作流程檔改名，或刪掉再重建，編號會從 1 重新數，比 Google Play 上已有的小，上傳會被拒絕。（文件只說編號是「each run of a particular workflow」，沒有寫改名或重建之後怎麼算；這裡照最壞的情況處理。）要改名或重建時，在 `android-version.sh` 加上一個固定的數，讓 `versionCode` 接著往上
- 沒有改用「從 Google Play 讀最大的 `versionCode` 再加一」：`versionCode` 要在建置時寫進 app，而讀 Google Play 要服務帳號的金鑰，`build` 就得拿到金鑰，或多一個拿金鑰的工作。編號重來的情況只在改工作流程的檔名時發生，改的人照上一點處理。
- 版本由 Gradle 屬性 `iamreal.versionName`、`iamreal.versionCode` 交給 `app/build.gradle.kts`；沒給的建置（拉取請求的檢查、這台電腦）是 `1`、`dev`。

**對 Google Play 的呼叫**（`play-upload.sh`）。不用第三方的 action 或工具，只用 `curl`、`openssl`、`jq` 照 Google 的文件呼叫：

1. 用服務帳號的金鑰簽一個 JWT，換一個 Android Publisher 範圍的 token（[Using OAuth 2.0 for Server to Server Applications](https://developers.google.com/identity/protocols/oauth2/service-account)）。金鑰經由管線交給 `openssl`，不寫進檔案；token 在紀錄裡遮掉（`::add-mask::`），經由標頭檔交給 `curl`，不出現在命令列
2. 開一個 edit（[`edits.insert`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits/insert)）
3. 把 `.aab` 傳進去（[`edits.bundles.upload`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.bundles/upload)），Google Play 回它的 `versionCode`
4. 內部測試軌道放一個那個 `versionCode` 的版本，狀態 `completed`，也就是發給軌道上的測試者（[`edits.tracks.update`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks/update)）
5. 提交這個 edit（[`edits.commit`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits/commit)）

任何一步失敗就停，印出 API 的回答；沒有提交的 edit 不改變任何東西。服務帳號在 Play Console 只有這個 app 的「將應用程式發布至測試群組」和兩項唯讀的權限（#162），發不了正式版。

**合併之後才驗得到的**（本機驗了腳本，見下面「在本機檢查」；工作流程本身在本機跑不起來）：

- `build` 在 runner 上做得出 `.aab`（步驟和 `android` 的檢查相同，只把 `build` 換成 `bundleRelease`）
- 上傳金鑰、服務帳號的金鑰在 `app-test` 裡，名稱對得上
- 第一次手動傳之後，API 開的內部測試版本能不能直接是 `completed`（發給測試者）。不行的話，API 的回答會印在紀錄裡，照它改 `play-upload.sh`
- 營運者從內部測試裝到手機、打得開

## 在本機檢查

工作流程本身在本機跑不起來。檢查它們的規則在 [`worker/test/workflows.ts`](../worker/test/workflows.ts)，測試在 `worker/test/workflows.test.ts`：

```sh
pnpm install --frozen-lockfile   # 在根目錄
cd worker
node --experimental-strip-types --test test/workflows.test.ts
```

`upload-android.yml` 的三個腳本的測試在 `worker/test/upload-android.test.ts`：版本號（台灣的日期、`versionCode` 的範圍）、用測試當場產生的上傳金鑰簽章並驗證、對 Google Play 的每一個呼叫（`curl` 換成一個照 API 的文件回答的替身，核對 JWT 的簽章和內容、呼叫的順序、token 沒有出現在命令列、上傳失敗時不提交）。簽章的測試要有 JDK（`JAVA_HOME`，或 Mac 上 `java_home` 找得到的）；沒有時跳過，設了 `CI` 時是失敗。

`worker/` 的 `pnpm test` 也包括它們。`changed-paths.sh` 的測試要有 `bash` 和 `git`。`paths` 清單的測試要有 `go` 才完整：沒有 `go` 時，檢查 Go 套件的那一項跳過，其他照查；設了 `CI`（GitHub Actions 會設）或 `IAMREAL_BB` 時沒有 `go`，那一項是失敗，不是跳過。這些規則防手誤和明顯的改動，不能代替逐行看（`CONTRIBUTING.md`「部署會執行到的東西」）。

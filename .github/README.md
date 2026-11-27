# .github/：GitHub Actions 的工作流程

**這個目錄讓人檢查的事：PR 的檢查拿不到任何權杖，部署測試網站的權杖只在上傳的那一步，上傳 app 的金鑰只在上傳的那一個工作，那個工作不建置。**（ADR-0029、ADR-0036）

| 檔案 | 什麼時候跑 | 做什麼 |
|---|---|---|
| [`workflows/checks.yml`](workflows/checks.yml) | 每個 PR（`pull_request`），和合併佇列裡的每一組（`merge_group`） | `CONTRIBUTING.md`「完成的定義」的 Go、`protocol/`、`worker/`、`web/` 的型別檢查和 Node 裡的測試，`device-core/` 的 Rust，`android/` 的 app 的建置、JVM 上的單元測試和 lint：`go`、`typescript`、`device-core`、`android` 四個工作，加上決定 PR 階段跑哪幾個的 `changes`（下面「必要檢查在 PR 階段照路徑跳過」）。只能讀，不引用任何 secret；快取只能還原、不能存（`cache-mode: read`，「快取」一節） |
| [`workflows/checks-browser.yml`](workflows/checks-browser.yml) | PR 改到它用到的檔時（`pull_request` 的 `paths`）；不在合併佇列裡跑 | `web/` 的 `pnpm test:e2e`、`pnpm test:ui`、`pnpm test:worker`：`browser` 一個工作。只能讀，不引用任何 secret |
| [`workflows/checks-ios.yml`](workflows/checks-ios.yml) | PR 改到 `ios/`、`device-core/`、app 包進去或測試讀的檔、或這個檔時（`pull_request` 的 `paths`）；不在合併佇列裡跑 | 在 macOS 上編 `device-core/` 給模擬器、建置 `ios/` 的 app、在模擬器上跑它的測試：`ios` 一個工作（`ios/README.md`）。只能讀，不引用任何 secret |
| [`workflows/checks-circuits.yml`](workflows/checks-circuits.yml) | PR 改到電路的原始碼、編好的電路檔、驗證金鑰，或重建和電路的測試用到的其他檔時（`pull_request` 的 `paths`）；不在合併佇列裡跑 | 從 `circuits/` 重編兩份電路和驗證金鑰，和 `web/circuits/`、`verifier/vk/` 逐位元組比對；`nargo test`；`circuits/` 的 JavaScript 測試，含和 circom 電路的逐案比對：`circuits` 一個工作（下面「`checks-circuits.yml`」）。只能讀，不引用任何 secret |
| [`workflows/deploy-test.yml`](workflows/deploy-test.yml) | 推到 `main` | 建置過卡的頁面、打包 Worker、檢查兩者，再把它們上傳到測試網站。碰不到快取（`cache-mode: none`） |
| [`workflows/upload-android.yml`](workflows/upload-android.yml) | 營運者手動觸發（`workflow_dispatch`），只在 `main` 上 | 建置 Android 的正式 app（`tw.iamreal.app`）、用上傳金鑰簽章，傳到它在 Google Play 的內部測試：`build`、`upload` 兩個工作（下面「上傳 Android 的 app」）。金鑰只在 `upload`，它在 environment `app-test` 裡；碰不到快取（`cache-mode: none`） |
| [`workflows/upload-android-test.yml`](workflows/upload-android-test.yml) | 營運者手動觸發（`workflow_dispatch`），只在 `main` 上 | 同上，傳的是 Android 的測試 app（`tw.iamreal.app.test`）（下面「上傳 Android 的 app」） |
| [`workflows/upload-ios.yml`](workflows/upload-ios.yml) | 只能手動觸發（`workflow_dispatch`），在 `main` 上 | 建置 iPhone 的正式 app（`tw.iamreal.app`，ADR-0040）、檢查它，再簽章、上傳到 App Store Connect（TestFlight）：`build`、`upload` 兩個工作。`build` 沒有金鑰；`upload` 在 environment `app-test`，不取出程式庫、不跑程式庫的腳本，只有最後一步拿到 App Store Connect 的 API 金鑰（[`ios/README.md`「上傳到 TestFlight」](../ios/README.md#上傳到-testflight)）。碰不到快取（`cache-mode: none`） |
| [`workflows/upload-ios-test.yml`](workflows/upload-ios-test.yml) | 只能手動觸發（`workflow_dispatch`），在 `main` 上 | 和 `upload-ios.yml` 相同的兩個工作，建置、上傳的是 iPhone 的測試 app（`tw.iamreal.app.test`，ADR-0040）：`ios/archive.sh --test-app`，build 號碼是這個工作流程的執行編號加 1,000,000。分成兩個工作流程，是因為執行編號各自數，兩個 app 的號碼不會交錯（[`ios/README.md`「版本和 build」](../ios/README.md#版本和-build)）。用同一個 environment `app-test` 和同一組金鑰。碰不到快取（`cache-mode: none`） |
| [`workflows/cache.yml`](workflows/cache.yml) | 推到 `main` | 編譯 `device-core/`、建置 `android/`，把 cargo 的 registry、`device-core/target/`、Gradle 的依賴和 wrapper 存成快取，給 `checks.yml` 的 `device-core`、`android` 還原：`cache-device-core`、`cache-android` 兩個工作。不引用任何 secret，`GITHUB_TOKEN` 只能讀（`contents: read`）；唯一能存快取的工作流程（`cache-mode: write`） |
| [`workflows/reverify.yml`](workflows/reverify.yml) | 每天台灣時間 00:30（排程，`schedule`），和手動觸發（`workflow_dispatch`） | 營運者每天的重驗（ADR-0025）：用 Go 的 `iamreal-verify` 和原生的 `bb`，讀公開的網址，把測試的證明紀錄從第 1 筆整份重驗：`test` 一個工作；正式的那一份 `production` 寫好了、還不跑（下面「每天的重驗」）。不引用任何 secret，`GITHUB_TOKEN` 只能讀，碰不到快取（`cache-mode: none`） |
| [`workflows/watch-test.yml`](workflows/watch-test.yml) | 每小時一次（`schedule`，每小時的第 17 分），和營運者手動觸發（`workflow_dispatch`） | 從 Cloudflare 以外檢查測試網站公開的結果，有一項不對工作就失敗，GitHub 寄通知信（[從外面定時檢查](#從外面定時檢查53)）。不引用任何 secret，權杖只能讀，碰不到快取（`cache-mode: none`） |

**為什麼 `browser` 分開、只在有關的檔改了才跑**（#123）：這兩套測試在 GitHub 的 runner 上要約 16 分鐘（2026-11-20 在 #119 量的：`browser` 15 分 28 秒，`go` 1 分 56 秒，`typescript` 5 分 11 秒），是一次檢查的三分之二。只動文件、app 或 `server/` 的 PR 和它們無關，不必多等這 16 分鐘（那時這兩套測試配的是 Go 的舊後台，只動 `worker/` 的 PR 也不跑；#69 之後它們對 Worker 跑，`worker/` 有改就跑）。分開的時候程式庫還沒公開，Actions 的用量算在組織免費方案每月含的額度裡，用完就不能再跑；2026-11-21 公開之後，標準的 GitHub-hosted runner 在公開的程式庫不算用量（「The following usage remains free independently and does not reduce the included compute usage: Standard GitHub-hosted runners in public repositories」，[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)），所以現在分開是為了時間，不是額度。`checks.yml` 的四個必要檢查在 PR 階段也照路徑跳過（#206），但做法不同、在合併佇列裡四項全跑：見下面「必要檢查在 PR 階段照路徑跳過」。

`checks-browser.yml` 的 `paths` 列出這三套測試用到的東西：頁面（`web/`、`protocol/`）、畫面上的字（`design/`）、規格和標準答案（`spec/`）、它們對著跑的後台（`worker/`，#69）、`pnpm test:ui` 建置來重驗證明紀錄的 Go 程式 `iamreal-verify` 和它引用的套件（`cmd/`、`verifier/`、`prooflog/`、`crl/`、`go.mod`、`go.sum`）、套件（`pnpm-lock.yaml`、`pnpm-workspace.yaml`，和 `circuits/package.json`：它是 workspace 的套件，`pnpm install` 拿 lockfile 和它比對）、根目錄那七個現在不存在、加了就改變每個檢查怎麼安裝、建置或取出檔案的檔（`ROOT_FILES_PATHS`，下面「每一份清單都有的」那一點；這個工作也跑 `pnpm install` 和 `go build`）和這個工作流程檔自己。照 GitHub 的文件（[workflow syntax 的 `on.<event>.paths`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore)）：

- PR 改到的檔只要有一個符合其中一項，工作流程就跑。樣式要從根目錄比對整個路徑，`**` 包括 `/`；沒有 `/` 的樣式（例如 `go.mod`）只比對根目錄的那個檔。
- 改到哪些檔，看的是整個 PR 對基底分支的差異（「three-dot diffs for pull requests」），不是這一次推送改的。
- 被濾掉、沒有跑的工作流程，它的檢查停在「Pending」。

**清單的測試只是多一層提醒。** `worker/test/workflows.test.ts` 讀這三套測試的原始碼（`web/test/e2e/`、`web/test/worker-card-proof.ts`，和它們引用的檔，包括 `worker/test/` 的測試工具），找出它們用到的最上層目錄和檔，確認每一個都在清單裡。找得到的寫法：

- 相對路徑的 import（含 JSON）、用 workspace 套件名稱的 import（`iamreal-protocol/…`，或 `pnpm-workspace.yaml` 裡其他套件的名稱）、頁面 HTML 的 `<script src>`
- `join(repo, "<目錄>"…)`、`join(web, "..", "<目錄>"…)`、`join(web, "../<目錄>"…)`，折行的也算
- `new URL("../…", import.meta.url)`
- 它們 `go build` 的套件（寫成 `"go", [… "./<套件>"`），和那些套件引用的這個模組裡的每個套件（`go list -deps`）

找不到的寫法（#123 的審查試過）：樣板字串（`` `${repo}/docs` ``）、用 `+` 接起來的路徑、帶 `?raw` 的 import、CSS 的 `@import`、套件名放在變數裡的 `go build`、它們啟動的程式在執行時讀的檔，以及執行時用其他方式拼出來的路徑。所以讓這幾套測試多用一個目錄的人，要自己把它加進清單。

**`worker/**` 在清單裡**（#69）。這三套測試對本機 workerd 裡的 Worker 跑：wrangler 從 `worker/` 打包、讀 `worker/wrangler.jsonc` 和 `worker/site/`，這些是執行時才讀的，上面的讀法看不到，所以整個 `worker/` 手動列進去。`workflows.test.ts` 確認它們建置的 Go 程式只有 `./cmd/iamreal-verify`。

改對 Worker 跑之後，這個工作在 GitHub 的 runner 上跑完過一次：PR #235 的最後一次，11 分 50 秒（2026-11-21）。同一個 PR 的前一次跑了 14 分 43 秒還沒跑完，就因為分支有新的提交被取消了，所以花的時間不只這一個數字，還要再看幾次。在一台同時跑著別的測試的 M1 Max 上，三套依序是約 3 分、6 分、40 秒（同一天）。工作的上限是 30 分鐘。

一個限制：

- **被 `paths` 濾掉的工作流程不會回報檢查。** 它的檢查停在「Pending」，要求它通過的 PR 不能合併（同一節）。`main` 的 ruleset 要求的必要檢查是 `checks.yml` 的 `go`、`typescript`、`device-core`、`android`（`android` 和合併佇列一起加進 ruleset）；要把 `browser` 也設成必要的，`checks-browser.yml` 不能直接列進去，要照四個必要檢查的做法（同一個工作流程裡一個判斷的工作加 `if`，讓它每次都回報；見「必要檢查在 PR 階段照路徑跳過」），也要讓它在合併佇列裡跑（下一節）。

**`checks-ios.yml`：runner、Xcode、模擬器的來源。** 這三個值寫死在工作流程檔和 `worker/test/workflows.ts`，來源是 GitHub 的 [actions/runner-images](https://github.com/actions/runner-images)（2026-11-20 讀）：

- `runs-on: xcode-27`：[README 的「Available Images」](https://github.com/actions/runner-images/blob/main/README.md#available-images)列的標籤，Apple 晶片，標著 preview（[公告](https://github.com/actions/runner-images/issues/14404)）。標籤如果在正式推出時改名，這個工作會一直排隊，要跟著改
- `/Applications/Xcode_27.2.app`（build 27B52）和 iOS 27.2 的模擬器 `iPhone 17`：[這個映像的說明](https://github.com/actions/runner-images/blob/main/images/macos/xcode-27-arm64-Readme.md)的「Xcode」和「Installed Simulators」。映像上也有 Rust 和 rustup
- 選它是因為 `ios/` 是用同一版 Xcode（27.2，27B52）開發和測試的。另一個選擇是正式的 `macos-26`，上面最新的是 Xcode 26.6（[macos-26-arm64 的說明](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md)）；`ios/` 沒有在 26.6 上建置過
- 這個工作流程還沒有在 GitHub 上跑過（寫的時候分支還沒推送）；第一次跑的結果記在加它的 PR
- `upload-ios.yml`、`upload-ios-test.yml` 的兩個工作用同一個 runner 和同一個 Xcode，`worker/test/workflows.ts` 用同一組常數寫

**`upload-ios.yml`、`upload-ios-test.yml`：上傳的工作還信任什麼。** 它不取出程式庫、不跑程式庫的腳本，金鑰只在最後一步（寫到 runner 的暫存目錄裡只有自己讀得到的檔，交給 `xcodebuild -exportArchive`）。它信任的是：釘住的 `actions/download-artifact`、runner 映像上的 Xcode，`build` 從同一個提交做出來、交下來的 archive 和 `ExportOptions.plist`，和 environment 的 variable `APPLE_TEAM_ID`（團隊代號，寫進 `ExportOptions.plist`）。`build` 跑程式庫的程式，所以上傳的是那個提交建出來的東西，這和部署測試網站相同；Xcode 匯出時不執行 archive 裡的程式。`worker/test/workflows.ts` 擋下：手動以外的觸發、`build` 拿到 environment 或金鑰、`upload` 不在 `app-test`、`upload` 多了任何一步，和兩個工作與寫死的不同。environment `app-test` 只讓 `main` 上的執行拿金鑰是 GitHub 上的設定，不在程式庫裡（#161）。

**`checks-ios.yml` 的時間上限是 45 分鐘。** 它 archive 正式 app 和測試 app 各一次之後（#496），跑了 26 分 21 秒（[這一次](https://github.com/iamreal-tw/iamreal/actions/runs/45970030103/job/140407942105)，2026-11-27），離原本的 30 分鐘太近：macOS 的 runner 慢一點就會被中斷。

**`checks-ios.yml` 的 `paths`** 列出 app 和它的測試用到的東西：`ios/`、`device-core/`，app 包進去的檔（`web/circuits/`、`verifier/vk/`、`design/fonts/`、`design/motion/`），測試讀的檔（`spec/vectors/`、`design/copy/`、`design/tokens.json`、`web/scripts/fetch-crs.mjs`），和這個工作流程檔自己。規格只寫了前兩個（「[規格：手機 app 第一份](https://github.com/iamreal-tw/iamreal/issues/155)」：macOS 的分鐘數算得重）；後面幾個不加的話，只改它們的 PR 會讓 iOS 的檢查壞掉而沒有人看到。代價是改 `design/copy/`、`design/tokens.json` 或 `spec/vectors/` 的 PR 也會跑一次 macOS。`worker/test/workflows.test.ts` 讀 `ios/Tests/` 和 `ios/check-app.sh` 的原始碼，確認它們寫出來的路徑都在清單裡；用別的方式拼出來的路徑它看不到。

**`checks-circuits.yml`**（#247，ADR-0038）：改電路的 PR 自動確認三件事，和 `circuits/README.md` 寫給人手動跑的是同一串指令：

- **重編的結果就是提交的檔。** `circuits/rebuild.sh` 用釘住的 `nargo` 重編兩份電路、用 `bb` 寫出驗證金鑰，和 `web/circuits/`、`verifier/vk/` 逐位元組比對；對不上的印出檔名和兩邊的 SHA-256，工作失敗。
- **電路的測試通過。** `nargo test --workspace`，和 `circuits/` 的 `pnpm test`。
- **和 circom 的逐案比對沒有新的差異。** circom 的見證產生器由 `circuits/build-circom.sh` 從 `iamreal-tw/zkID` 釘在 `circuits/zkid-commit` 的提交建出來。最後一步要求 `pnpm test` 寫出的比對表 `circuits/out/equivalence.md` 和提交的 `circuits/results/equivalence.md` 逐位元組相同（`diff -u`），再把整張表印在紀錄裡。提交的表每一案都有 circom 的結果（`workflows.test.ts` 檢查），所以 circom 沒建起來、那一欄變成 `not run` 時，這一步失敗；有意改變電路接受什麼的 PR，要在同一個 PR 更新那張表。

下載的工具都先核對 SHA-256，雜湊都在 `circuits/` 裡、只寫一次：`nargo` 1.0.0（`circuits/fetch-nargo.sh`，照 `circuits/nargo.sha256`）、`circom` 2.2.3（`circuits/fetch-circom.sh`，照 `circuits/circom.sha256`，從 [iden3/circom 的 release](https://github.com/iden3/circom/releases/tag/v2.2.3) 下載 `circom-linux-amd64`）。`bb` 是 `@aztec-foundation/bb.js` 6.0.0 附的，由 `circuits/find-bb.sh` 照 `circuits/bb.sha256` 核對，所以這個工作沒有其他工作那一步 `sha256sum --check`。`build-circom.sh` 照 zkID 那個提交的 `yarn.lock` 安裝它的 JavaScript 套件、不跑安裝腳本，用的 yarn 1.22.22 是它 `package.json` 的 `packageManager` 寫的，由 corepack 照那裡的雜湊核對。另外兩樣是下載了不核對雜湊、但錯了會被比對抓到的：`nargo` 照 `circuits/lib/Nargo.toml` 的標籤抓 Noir 的函式庫（標籤被移到內容不同的提交時，重編的電路檔就不同），`bb` 下載它的通用參數（不同時，寫出的驗證金鑰就不同）。工作整個寫死在 `worker/test/workflows.ts`（`CIRCUITS_JOB_STEPS`），哪一步換了工具的來源、拿掉重建或最後的比對，規則都擋。

**`checks-circuits.yml` 的 `paths`**：`circuits/`；重建比對的對象 `web/circuits/`、`verifier/vk/`，和重建時用的 `web/scripts/strip-circuit.mjs`；電路的測試讀的 `spec/vectors/poseidon2.json`、`spec/vectors/declaration-code.json`；套件（`pnpm-lock.yaml`、`pnpm-workspace.yaml`，和 workspace 其他三個套件的 `package.json`：這個工作在根目錄跑 `pnpm install --frozen-lockfile`，pnpm 拿 lockfile 和每個套件的 `package.json` 比對）；根目錄那七個檔（`ROOT_FILES_PATHS`，和必要檢查的清單同一份）：例如加一個 `.pnpmfile.cjs` 就能改變 `@aztec-foundation/bb.js` 解析到什麼，`bb` 正是從那裡來的，加一個 `.gitattributes` 就能改變取出來的 `web/circuits/`、`verifier/vk/`，也就是 `rebuild.sh` 逐位元組比對的檔；和這個工作流程檔自己。`workflows.test.ts` 讀 `circuits/` 每個進版本控制的檔，找出寫到 `circuits/` 以外的路徑，確認都在清單裡：JavaScript 的 `join(ROOT, …)`（`ROOT` 是 `circuits/`）、`join(dirname(fileURLToPath(import.meta.url)), …)`、相對路徑的 import，shell 腳本的 `$root/…` 和 `rebuild.sh` 的 `compare "…"`，`Nargo.toml` 的 `path = "…"`。看不到的：用其他方式拼出來的路徑，`nargo`、`bb`、circom 自己讀的東西，和 zkID 那個提交裡的檔。

時間：2026-11-21 第一次在 GitHub 上跑（[#262 的這一次](https://github.com/iamreal-tw/iamreal/actions/runs/44914901525/job/136878301995)）：建 circom 約 4 分鐘、含 circom 的 `pnpm test` 約 3 分半，重建並比對、編全部電路、`nargo test` 加起來約 40 秒，整個工作約 8 分半。工作的上限是 30 分鐘，和其他工作相同，約是這次的 3.5 倍；circom 的建置如果慢到接近上限，照 #243 停下來談要不要改放編好的見證產生器。

**必要檢查在 PR 階段照路徑跳過，合併佇列四項全跑**（#206）。只改文件的 PR 不必等 `android` 的 11 分鐘（2026-11-20 量的，[#203](https://github.com/iamreal-tw/iamreal/issues/203)）。必要檢查不能用 `paths`：被 `paths` 濾掉的工作流程不回報檢查，PR 會停在「Pending」（上面的限制）。所以 `checks.yml` 每次都跑，由裡面的 `changes` 工作決定四個必要檢查各自跑不跑：

- **`changes` 做什麼。** 它只用 GitHub 自己的 `actions/checkout`（取完整的歷史，`fetch-depth: 0`），再跑 [`workflows/changed-paths.sh`](workflows/changed-paths.sh)，一份只用 bash 和 git 的腳本，不用第三方的 action。在 `pull_request` 上，腳本用 `git diff 基底...PR 的頭` 列出 PR 改到的檔，也就是 PR 的頭對它和基底分支的共同祖先的差異，和 `paths` 看的一樣（「three-dot diffs for pull requests」，上面那一節）；改名的檔，新舊兩個名字都算。某個必要檢查的清單裡有一項符合其中一個檔，它就輸出那個檢查要跑。在 `pull_request` 以外的事件（合併佇列的 `merge_group`）上，它不看差異，四項都輸出要跑。每一項跑或跳過的原因印在 `changes` 的紀錄裡；檔名是 PR 決定的，印出來時可印的 ASCII 以外的字元（包括換行）一律換成 `?`，所以中文檔名在紀錄裡是一串 `?`，檔名也不能在紀錄裡多出一行讓 runner 當成 workflow command。
- **四個必要檢查怎麼依它決定。** 每個工作有 `needs: changes` 和同一個樣子的 `if`：`changes` 沒有成功、或事件不是 `pull_request`、或 `changes` 說它要跑，三者有一個成立就跑。被 `if` 跳過的工作回報成功（「A job is skipped by a conditional」：「The job reports "Success"」，[Troubleshooting required status checks 的 Handling skipped but required checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks#handling-skipped-but-required-checks)），所以 PR 可以合併、可以排進佇列，畫面上那一項顯示「Skipped」。
- **合併佇列四項全跑。** `if` 裡直接寫了事件不是 `pull_request` 就跑，不經過 `changes` 的輸出；腳本在 `merge_group` 上也輸出全跑。所以清單漏了東西，最壞是 PR 階段少跑一項，進 `main` 之前佇列會補跑，`main` 不會因此變紅。
- **`changes` 失敗時，四個必要檢查是失敗，不是跳過。** 同一頁說「A job depends on a failed job」時「The dependent job is skipped and may not block merging」，要「Use `always()` with `needs` for required checks that depend on other jobs」。所以 `if` 以 `always()` 開頭，`changes` 沒有成功時四個工作照樣開始；它們的第一步檢查 `changes` 的結果（經 `env` 拿到），不是 `success` 就失敗。腳本遇到任何問題（找不到基底的提交、清單裡有它不認得的樣式）就以失敗結束，`changes` 跟著失敗；那之前它可能已經替前面幾項寫了輸出，但 `changes` 沒有成功時 `if` 不看輸出，四項都會開始、在第一步失敗。用 `always()` 而不是 `!cancelled()`：`cancelled()` 在執行被取消時是真（「Returns `true` if the workflow was canceled」，[Expressions 的 Status check functions](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions)），那時 `!cancelled()` 開頭的 `if` 是假，還沒開始的必要檢查會是被條件跳過、回報成功。`always()` 在被取消時也是真（「Causes the step to always execute, and returns `true`, even when canceled」，同一節），代價是取消一次執行時，還沒開始的必要檢查可能會開始，`changes` 沒成功的話在第一步失敗。這一段是照文件推的，還沒有在 GitHub 上看過取消時的實際結果。
- **清單在哪裡。** 四份清單寫在 `worker/test/workflows.ts`（`GO_PATHS`、`TYPESCRIPT_PATHS`、`DEVICE_CORE_PATHS`、`ANDROID_PATHS`），格式和比對規則同 `BROWSER_PATHS`、`IOS_PATHS`：從根目錄比對整個路徑，`**` 包括 `/`。只用兩種樣式：沒有萬用字元的路徑（就那一個檔），和 `<目錄>/**`（底下所有的檔）；其他樣式規則和腳本都不接受。目錄沒寫 `/**` 的話腳本會把它當成一個檔名、永遠比對不到，所以 `workflows.test.ts` 另外確認清單裡沒有哪一項是程式庫裡的目錄卻沒寫 `/**`。`checks.yml` 把清單寫在 `changes` 的 `env`（一份清單一行，用空白隔開），腳本從那裡讀；`worker/test/workflows.ts` 的規則要求 `env` 和清單一字不差，所以沒有第二份會走樣的清單。改清單要同時改 `workflows.ts` 和 `checks.yml` 的那一行。
- **每一份清單都有的**：`checks.yml` 和 `changed-paths.sh`、`worker/test/workflows.ts` 和 `workflows.test.ts`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`go.mod`、`go.sum`。改 CI 或套件的 PR 四項都跑。另外有七個現在不存在的根目錄檔：`.npmrc`、`.pnpmfile.cjs`、`package.json`（改變 pnpm 從哪裡裝、怎麼裝）、`go.work`、`go.work.sum`（Go 的 workspace）、`.cargo/config.toml`（cargo 會從 `device-core/` 往上找到它）、`.gitattributes`（改變檔案取出來的樣子）。沒有萬用字元的樣式比對的是檔名，所以哪個 PR 加了其中一個，四項都跑。
- **`typescript` 的清單幾乎是全部**：除了 `docs/` 和根目錄的文件以外的每個目錄。`worker/` 的測試會建置、執行 Go 的程式，`workflows.test.ts` 會讀 `android/`、`ios/`、`device-core/`、`circuits/` 和工作流程。所以 PR 階段省下的主要是只改文件的 PR（四項都跳過），和只改 Go、Rust、app 的 PR 各自不相關的那幾項。

`worker/test/workflows.ts` 的規則擋下：必要檢查不經過 `changes`、在 `merge_group` 上可以被跳過、`changes` 沒成功時變成跳過、`changes` 用了別的 action 或別的指令。它是把 `if` 當運算式算過每一種情況（`changes` 的結果、輸出、事件、有沒有被取消），不是比對文字；它讀不懂的 `if` 一律算問題。`workflows.test.ts` 另外在一個暫時的 git 程式庫裡實際跑 `changed-paths.sh`，餵它 `checks.yml` 裡的清單。

**清單的涵蓋測試和它看不到的。** 和 `BROWSER_PATHS` 一樣，測試只是多一層提醒：它讀原始碼，找出寫得出來的路徑，確認都在清單裡。漏掉的不會讓 `main` 變紅（佇列全跑），但 PR 階段會少跑那一項，所以讓某個檢查多讀一個目錄的人，要自己把它加進清單。

- **根目錄的設定檔**：上面那七個是手寫的，涵蓋測試不看。工具會自己往上層目錄找的其他設定檔（例如根目錄的 `rust-toolchain.toml`、`tsconfig.json`、`.tool-versions`），加的人要自己加進清單。子目錄裡的同類檔，只有整個目錄在清單裡的檢查才涵蓋：`typescript` 有 `protocol/**`、`worker/**`、`web/**`（例如 `web/.npmrc`），`device-core`、`android` 有 `device-core/**`（例如 `device-core/.cargo/config.toml`）。`go` 不涵蓋：它在根目錄跑 `pnpm install`，清單裡和套件有關的只有根目錄那幾個檔和四個 `package.json`，四個套件目錄裡其他會影響安裝的檔不在它的清單。
- **`go`**：`go list` 列出的每個套件的目錄，加上 Go 原始碼裡以 `../` 開頭的字串和 `filepath.Join("..", …)` 指到的檔（測試讀的 `spec/`、`design/copy/`、`web/README.md`、一份 ADR）。手寫的：workspace 每個套件的 `package.json`（這個工作會 `pnpm install` 來拿 bb，pnpm 拿 lockfile 和它們比對）；`workflows.test.ts` 從 `pnpm-workspace.yaml` 讀出有哪些套件，確認每個在根目錄跑 `pnpm install` 的檢查的清單都有它們的 `package.json`。看不到：用其他方式拼出來的路徑、測試從環境變數拿到的路徑、清單以外的目錄裡新增的 Go 檔（`go build ./...`、`gofmt -l .` 會掃到）。
- **`typescript`**：`protocol/`、`worker/`、`web/` 每個有進版本控制的原始碼，找得到的寫法和 `BROWSER_PATHS` 的相同（import、`join(…)`、`new URL(…)`、`"go", […]`），`join` 的第一個參數認 `REPO`、`repo`、`WORKER_DIR`、`web`、`here` 這幾個名字；它們用到的 Go 套件再照 `go` 的做法找。看不到的也相同，另外看不到 `new URL` 只寫到根目錄的（`` `../../${path}` ``）。
- **`device-core`**：Rust 裡的 `repo_file("…")`、`vectors("…")`、`.join("../…")`、`include_str!`、`include_bytes!`，和 `Cargo.toml` 的 `path = "…"`。現在的程式沒有 `include_str!`、`include_bytes!`、`build.rs`；測試是在執行時讀檔。手寫、偵測不到的：`build.rs` 或相依套件的巨集在編譯時讀的檔、用 `format!` 以外的方式拼出來的路徑、兩個下載的腳本（`fetch-barretenberg.sh`、`fetch-crs.sh`）讀的東西。這些現在都在 `device-core/` 裡（雜湊檔 `barretenberg.sha256`、`crs.sha256`、`.cargo/config.toml`、`rust-toolchain.toml`、`Cargo.lock`），整個目錄在清單裡；之後有哪一個讀到 `device-core/` 以外，要手動加。清單裡另外有 `workflows/cache.yml`：它的雜湊在這個工作還原的快取的鍵裡（「快取」一節），改它的 PR 會讓這個工作從零編一次。`android` 的清單也一樣。這一項有規則看著：`worker/test/workflows.ts` 從每個工作的快取的鍵讀出 `hashFiles(…)` 列的檔，每一個都要在那個工作的清單裡。
- **`android`**：Gradle 腳本裡的 `rootProject.file("…")`、`core.resolve("…")`，和 shell 腳本裡的 `$here/…`、`$core/…`（`build-native.sh` 編 `device-core/`、打包 `web/circuits/`、`verifier/vk/`，`copyDesign` 包進 `design/copy/`、`design/fonts/`、`design/motion/` 的檔，單元測試讀 `spec/vectors/`、`design/copy/`、`design/motion/`）。手寫、偵測不到的：Android 的 Gradle 外掛照慣例讀的檔（`AndroidManifest.xml`、`res/`、`gradle.properties`、`gradle/verification-metadata.xml`、wrapper）、`fetch-zig.sh` 和 `zig.sha256`、Kotlin 測試從系統屬性拿到的路徑。這些都在 `android/` 或 `device-core/` 裡，兩個目錄整個在清單裡。`device-core/` 的建置讀什麼，`android` 就跟著讀什麼，所以上一點偵測不到的，這裡也一樣。

四個 PR 的工作流程、`deploy-test.yml`、`upload-ios.yml`、`upload-ios-test.yml`、`cache.yml` 的 `concurrency` 群組名稱都不同：群組在所有工作流程之間共用，「concurrency group names must be unique across workflows to avoid canceling in-progress jobs or runs from other workflows」（[workflow syntax 的 `concurrency`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idconcurrency)）。

## 合併佇列（#180）

`main` 用合併佇列：PR 排進佇列後，GitHub 把它和 `main`、排在它前面的 PR 合成一個暫時的分支（`gh-readonly-queue/main/…`），在那上面跑 `main` 要求的檢查，過了才合併（[Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)）。兩個各自綠燈的 PR 合起來是紅的，會在這裡被擋下，不會進 `main`、不會部署到測試網站（#180 的起因）。

- **佇列裡四個必要檢查全跑，不照路徑跳過。** PR 階段被跳過的檢查（「必要檢查在 PR 階段照路徑跳過」），在這裡會跑；`main` 上的每個提交都通過完整的四項。
- **佇列只跑 `checks.yml`。** 必要檢查要由在 `merge_group` 上跑的工作流程回報，不然佇列等不到（[Events that trigger workflows 的 `merge_group`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group)）。`checks.yml` 只寫了 `checks_requested` 這一種活動，那一頁說寫明活動能讓之後多出新的活動時不被觸發。`checks-browser.yml`、`checks-ios.yml`、`checks-circuits.yml` 不在佇列裡跑：同一頁替 `merge_group` 只列了 `branches`、`branches-ignore` 兩種篩選，沒有 `paths`，放進去每一次合併都要多等瀏覽器測試、多跑一次 macOS、多建一次 circom。
- **`concurrency`。** PR 的執行照 PR 編號分組，新的推送取消前一次。佇列的執行沒有 PR 編號，改照 `github.ref` 分組，也就是那一組的暫時分支（`merge_group` 的 `GITHUB_REF` 是「Ref of the merge group」，同一頁；`github.ref` 是「The fully-formed ref of the branch or tag that triggered the workflow run」，`pull_request` 以外的觸發「this is the branch or tag ref that triggered the workflow run」，[Contexts reference 的 `github`](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context)）。不這樣分，佇列裡各組的執行會在同一個群組裡互相取消。
- **佇列的執行沒有 fork 的限制。** fork 來的 PR 拿不到 secret、權杖只能讀，文件寫的是 `pull_request`；佇列的暫時分支在這個程式庫裡，裡面有 PR 的改動，文件沒有說那條限制也適用。所以讓它安全的是 `checks.yml` 本身：不引用任何 secret、權杖只能讀、快取只能還原不能存（`cache-mode: read`，「快取」一節），改到它的 PR 要逐行看（`CONTRIBUTING.md`「部署會執行到的東西」），`worker/test/workflows.ts` 擋下引用 secret、放寬權限、別的工作流程也在 `merge_group` 上跑這類改動。
- **必要檢查照工作的名稱比對。** `checks.yml` 的工作必須恰好是 `go`、`typescript`、`device-core`、`android`，而且不設 `name`（`worker/test/workflows.ts` 的 `REQUIRED_CHECKS`）：改了 id 或設了 `name`，回報的檢查就不是 ruleset 等的那一個，佇列會一直等。依據：GitHub 的文件說必要檢查照工作的名稱認，「make sure that job names are unique across all workflows. Using the same job name in multiple workflows can cause ambiguous status check results」（[About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)），`name` 是「a name for the job, which is displayed in the GitHub UI」（[workflow syntax 的 `jobs.<job_id>.name`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idname)）。沒設 `name` 時檢查的名稱就是工作的 id，文件沒有明寫，是看到的：`main` 的 ruleset 要求的 `go`、`typescript`、`device-core` 就是這三個沒設 `name` 的工作的 id（2026-11-21 讀 ruleset）；`android` 是之後加進 `checks.yml` 的工作，和合併佇列一起加進 ruleset。
- **合併是排進佇列。** `gh pr merge` 在必要檢查過了時把 PR 加進佇列，沒過時開自動合併（[Merging a pull request with a merge queue](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue)）。
- **佇列現在的設定**（`main` 的 ruleset 的 `merge_queue` 規則，2026-11-21 用 `gh api repos/iamreal-tw/iamreal/rulesets/27745555` 讀）：合併方式 merge commit（`MERGE`）；一組全部通過才合併（`ALLGREEN`）；同時最多 5 個佇列項目在跑檢查（`max_entries_to_build`，文件寫的是「The maximum number of `merge_group` webhooks to dispatch」）；一次合併 1 到 5 個 PR（`min_entries_to_merge`、`max_entries_to_merge`）；等湊滿一組的時間 0 分（`min_entries_to_merge_wait_minutes`，#204 從 5 改成 0）；檢查 60 分沒有回報算失敗（`check_response_timeout_minutes`）。等待時間是「a timeout for reaching the minimum group size, which allows smaller groups to merge if there are no more PRs queued within your specified time limit」（[Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue#managing-a-merge-queue) 的「Wait time」）。照字面，最小組數是 1 時排進去就湊滿了，不該等；文件沒有明寫這種情況，設成 0 是為了不必靠推論，PR 排進去就開始跑。實際從排進去到開始跑的時間記在 #204 的 PR。這些值在 GitHub 上，不在程式庫裡；改了要回來更新這一段。
- **合併後自動刪掉 PR 的分支**（#215）。程式庫設定的「Automatically delete head branches」（`delete_branch_on_merge`）2026-11-21 打開：「You can have head branches automatically deleted after pull requests are merged in your repository」（[Managing the automatic deletion of branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches)）。刪掉的分支可以在 PR 頁面按「Restore branch」救回來（[Deleting and restoring branches in a pull request](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-branches-in-your-repository/deleting-and-restoring-branches-in-a-pull-request#restoring-a-deleted-branch)）。同一個程式庫裡以被刪分支為基底、還開著的 PR 會改基底：「GitHub automatically updates any such pull requests, changing their base branch to the merged pull request's base branch」（[Managing branches within your repository](https://docs.github.com/en/pull-requests/how-tos/commit-changes/managing-branches-within-your-repository#deleting-a-branch)）。從 fork 來的 PR 看的是 fork 的設定，這裡的設定管不到：「GitHub uses the Automatically delete head branches setting on the head repository (the fork)」（[Managing the automatic deletion of branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches)）。從合併佇列合併時會不會刪，文件沒有提到；打開後第一個從佇列合併的是 #215，結果記在它的留言。這個值也在 GitHub 上，不在程式庫裡（`gh api repos/iamreal-tw/iamreal -q .delete_branch_on_merge` 讀）；改了要回來更新這一點。
- **排進佇列前，自己確認 `browser`、`ios`、`circuits` 通過。** 這三項不是必要檢查，也不在佇列裡跑（「佇列只跑 `checks.yml`」那一點）：PR 上它們紅燈或還在跑，`gh pr merge` 照樣能把 PR 排進佇列，佇列也不會擋，紅燈的測試就這樣進了 `main`。
- **不必為了和最新的 `main` 同步而把 `main` 併進分支。** 佇列會把 PR 疊在最新的 `main`（和排在它前面的 PR）上重跑必要檢查，合起來是不是綠的由佇列負責；自己先併一次只會多跑一整輪檢查。只有兩種情況要併：和 `main` 有衝突，或這個 PR 需要 `main` 上新的東西（例如要用剛合併的程式，或要在 PR 上看 `browser`、`ios`、`circuits` 對合起來的結果跑）。

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
| `deploy-test.yml`、`checks-browser.yml`、`checks-ios.yml`、`checks-circuits.yml`、`upload-android.yml`、`upload-android-test.yml`、`upload-ios.yml`、`upload-ios-test.yml` | `none`：都不能 | 沒有 |

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

`worker/test/workflows.ts` 擋下的改動：任何一個檔的 `cache-mode` 和上表不同或沒寫，新的工作流程不是 `none`，工作層級設了 `cache-mode`；`checks.yml` 的工作用會存快取的 `actions/cache` 或 `actions/cache/save`，或還原不是自己的快取；`deploy-test.yml`、`checks-browser.yml`、`checks-ios.yml`、`checks-circuits.yml`、`upload-android.yml`、`upload-android-test.yml` 或新的工作流程用任何一種快取的 action；`cache.yml` 在推到 `main` 以外的事件上觸發、引用 secret、權限不是恰好 `contents: read`、工作和寫死的不同；快取的 `path`、`key` 和寫死的不同，或多了 `restore-keys`。

怎麼部署、上傳那一步還信任什麼：[`worker/README.md`「從 GitHub Actions 部署」](../worker/README.md#從-github-actions-部署)。

## 上傳 Android 的 app（#175）

兩個工作流程，一個 app 一個（ADR-0040，`android/README.md`「三種 app」）：

| 工作流程 | app | 建置 | build 號碼 |
|---|---|---|---|
| [`workflows/upload-android.yml`](workflows/upload-android.yml) | 正式 app `tw.iamreal.app`：上線前連測試網站、簽測試的證明紀錄的場合字串 | `bundleRelease` | 執行編號 |
| [`workflows/upload-android-test.yml`](workflows/upload-android-test.yml) | 測試 app `tw.iamreal.app.test`：永遠連測試網站 | `bundleTrial` | 執行編號加 1,000,000 |

兩個檔的工作除了上表和 artifact 的名稱（`android-bundle`、`android-test-bundle`，簽好的各加 `-signed`）、`play-upload.sh` 傳到哪個 app 以外完全相同，`worker/test/workflows.ts` 用同一個函式寫出兩份來比對。分成兩個檔，是讓兩個 app 的執行編號各自數，號碼不會交錯（ADR-0036 的版本號那一段）。下面寫的每一點兩個都適用。

**怎麼觸發。** 只能手動：GitHub 的 Actions 頁面選 `upload-android`（或 `upload-android-test`）、「Run workflow」，分支選 `main`；或在營運者的電腦上 `gh workflow run upload-android.yml --ref main`（測試 app 是 `upload-android-test.yml`；coding agent 也可以，ADR-0036）。推送、合併、別的工作流程都不會觸發它；它不收任何輸入。一次只跑一個，不取消正在跑的（`concurrency`）；在它跑的時候再觸發，新的那次等著，但同時只能有一次在等：再觸發一次，等著的那次會被取消（「By default, any existing pending job or workflow in the same concurrency group will be canceled and the new queued job or workflow will take its place」，[workflow syntax 的 `concurrency`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)，2026-11-21 讀）。

**兩個工作。**

| 工作 | 拿得到什麼 | 做什麼 |
|---|---|---|
| `build` | 沒有 secret；權杖只能讀程式 | 不在 `main` 上就停。用 [`android-version.sh`](workflows/android-version.sh) 算版本。和 `checks.yml` 的 `android` 一樣裝 libc++、Rust、SDK、參數檔，再跑 `./gradlew bundleRelease`（測試 app 是 `bundleTrial`），帶上版本。它會接著跑 bundle 的檢查（`checkBundle`、`checkManifest`、`checkLibraries`，`android/README.md`「建置時的檢查」）：識別碼、build 號碼在這個 app 的範圍裡、連測試網站、沒有正式網站和正式的證明紀錄的場合字串、沒有假卡片和測試的發證金鑰、沒有廣告編號的權限。檢查不過就停，不會上傳。簽哪一份證明紀錄的場合字串由 Kotlin 傳給核心的證明紀錄編號決定（各個 build type 的 `Environment.kt` 的 `PROOF_LOG`），編進 dex 時只是一個數字，bundle 的檢查找不到它；它由 `BuildTest` 的「an app on the test site talks to it and signs for the test log」看著，正式 app 和測試 app 各在自己的 build type 裡跑（`testReleaseUnitTest`、`testTrialUnitTest`），那是 `checks.yml` 的 `android` 每次都跑的單元測試，`main` 上的每個提交都在合併佇列裡跑過（「合併佇列」），所以這裡不再跑一次。沒有簽章的 `.aab` 留成 artifact |
| `upload` | environment `app-test` 的三個 secret | 不建置、不跑 Gradle。拿 `build` 留下的 `.aab`，用 [`android-sign.sh`](workflows/android-sign.sh) 以上傳金鑰簽章，簽好的留成 artifact，再用 [`play-upload.sh`](workflows/play-upload.sh) 傳到這個 app 的內部測試（app 的套件名稱由工作流程交給它，不寫在腳本裡） |

- **金鑰只在 `upload`。** 兩個工作流程用 environment `app-test` 的同一組 secret（ADR-0040），名稱照 #162：`ANDROID_UPLOAD_KEYSTORE_BASE64`、`ANDROID_UPLOAD_KEYSTORE_PASSWORD` 只在簽章那一步的 `env`，`PLAY_SERVICE_ACCOUNT_JSON` 只在上傳那一步的 `env`。`app-test` 只把 secret 給 `main` 上的工作（#162 的設定），所以在別的分支上觸發時，`build` 先停下來；就算它沒停，`upload` 也拿不到金鑰。
- **跑 Gradle 的工作拿不到金鑰。** Gradle 的外掛、建置腳本、`build-native.sh` 都在 `build` 裡跑；`upload` 只跑釘住的三個 action、runner 上的 JDK（`jarsigner`）和工具（`bash`、`base64`、`unzip`、`awk`、`curl`、`openssl`、`jq`），和同一個提交的兩個腳本。
- **傳上去的就是檢查過的。** `android-sign.sh` 簽完先用 `jarsigner -verify` 驗，再比對簽好的檔和 `build` 留下的檔：每個檔的 CRC-32 相同，只多了簽章的三個檔（`META-INF/MANIFEST.MF`、`UPLOAD.SF`、`UPLOAD.RSA`），否則停下來。
- **app 的簽章金鑰不在這裡。** 上傳金鑰只對 Google Play 證明這個檔是我們傳的；手機上的 app 由 Google Play 用 app 的簽章金鑰重簽。兩個 app 的簽章金鑰都由 Google 產生（Play App Signing 的預設，ADR-0040），營運者和 GitHub 都沒有。
- **新 app 的第一個 build，API 就收了。** Google 的文件說「You can only use this API to make changes to an existing app (that has at least one APK uploaded); thus, you will have to upload at least one APK through the Play Console before you can use this API.」（[Edits](https://developers.google.com/android-publisher/edits)，2026-11-21 讀），但正式 app 的第一個 build 用 API 直接傳上去了，沒有回 `Package not found`（`upload-android.yml` 第一次執行，[run 45928594859](https://github.com/iamreal-tw/iamreal/actions/runs/45928594859)，2026-11-27，#162）。測試 app 的第一個 build 預期一樣；API 不收的話，`play-upload.sh` 失敗、印出 API 的回答，營運者從這次執行的 artifact 下載簽好的 `.aab`（`android-test-bundle-signed`），在 Play Console 傳到內部測試。上傳金鑰不經過營運者的電腦。

**版本號**（ADR-0036「版本號和標籤」，照 #176 改的；兩個 app 寫法相同）。

- 顯示的版本（`versionName`）是台灣的日期（UTC+8，沒有日光節約時間），年、月、日不補零，例如 `2026.11.5`、`2026.11.21`。日期取的是 `build` 算版本那一步執行的時候：觸發後排隊排過午夜的話，是隔天。同一天的每次上傳顯示的版本相同，靠 `versionCode` 分。不像網站的標籤那樣加 `.1`：iOS 顯示的版本「The required format is three period-separated integers」（[CFBundleShortVersionString](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleshortversionstring)，2026-11-21 讀），兩個 app 寫法一致（#176）。
- `versionCode` 是這次執行的編號 `github.run_number`，測試 app 再加 1,000,000（`android-version.sh` 的第三個參數，正式 app 給 `0`）。為什麼加 1,000,000：`android/README.md`「三種 app」（ADR-0040「測試網站的最低版本」）；`app/build.gradle.kts` 擋住正式 app 到 1,000,000、測試 app 不在 1,000,000 到 1,999,999 的 build。執行編號是「A unique number for each run of a particular workflow in a repository. This number begins at 1 for the workflow's first run, and increments with each new run. This number does not change if you re-run the workflow run.」（[Contexts reference 的 `github`](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context)，2026-11-21 讀）。Android 的文件要每一版的 `versionCode` 比前一版大，並說「You can't upload an APK to the Play Store with a versionCode you have already used for a previous version」、「The greatest value Google Play allows for versionCode is 2100000000」（[Version your app](https://developer.android.com/studio/publish/versioning)，同一天讀）。所以：
  - 重跑一次已經傳上去的執行，`versionCode` 和上次相同，會被 Google Play 拒絕；要重新觸發一次
  - 工作流程檔改名，或刪掉再重建，編號會從 1 重新數，比 Google Play 上已有的小，上傳會被拒絕。（文件只說編號是「each run of a particular workflow」，沒有寫改名或重建之後怎麼算；這裡照最壞的情況處理。）要改名或重建時，把工作流程交給 `android-version.sh` 的數加大，讓 `versionCode` 接著往上，而且留在那個 app 的範圍裡
- 沒有改用「從 Google Play 讀最大的 `versionCode` 再加一」：`versionCode` 要在建置時寫進 app，而讀 Google Play 要服務帳號的金鑰，`build` 就得拿到金鑰，或多一個拿金鑰的工作。編號重來的情況只在改工作流程的檔名時發生，改的人照上一點處理。
- 版本由 Gradle 屬性 `iamreal.versionName`、`iamreal.versionCode` 交給 `app/build.gradle.kts`；沒給的建置（拉取請求的檢查、這台電腦）顯示的版本是 `dev`，build 號碼是那個 app 的範圍裡的第一個（正式 app `1`、測試 app `1000000`；開發用 build 固定 `2000000`）。

**對 Google Play 的呼叫**（`play-upload.sh`）。不用第三方的 action 或工具，只用 `curl`、`openssl`、`jq` 照 Google 的文件呼叫：

1. 用服務帳號的金鑰簽一個 JWT，換一個 Android Publisher 範圍的 token（[Using OAuth 2.0 for Server to Server Applications](https://developers.google.com/identity/protocols/oauth2/service-account)）。金鑰經由管線交給 `openssl`，不寫進檔案；token 在紀錄裡遮掉（`::add-mask::`），經由標頭檔交給 `curl`，不出現在命令列
2. 開一個 edit（[`edits.insert`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits/insert)）
3. 把 `.aab` 傳進去（[`edits.bundles.upload`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.bundles/upload)），Google Play 回它的 `versionCode`
4. 內部測試軌道放一個那個 `versionCode` 的版本，狀態 `completed`，也就是發給軌道上的測試者（[`edits.tracks.update`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks/update)）
5. 提交這個 edit（[`edits.commit`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits/commit)）

任何一步失敗就停，印出 API 的回答；沒有提交的 edit 不改變任何東西。服務帳號在 Play Console 只有兩個 app 各自的「將應用程式發布至測試群組」和兩項唯讀的權限（#162、ADR-0040），發不了正式版。

**正式 app 已經驗過的**（#162，2026-11-27）：`build` 在 runner 上做得出 `.aab`；上傳金鑰、服務帳號的金鑰在 `app-test` 裡，名稱對得上；API 開的內部測試版本直接是 `completed`；營運者從內部測試裝到手機。

**測試 app 合併之後才驗得到的**（本機驗了腳本和 `bundleTrial`，見下面「在本機檢查」；工作流程本身在本機跑不起來）：營運者觸發一次 `upload-android-test.yml`，API 收下測試 app 的 build；從它的內部測試裝到手機、打得開（測試 app 的 Play 後台在 #479）。

## 每天的重驗（#421）

`workflows/reverify.yml` 是 ADR-0025 說的營運者每天的重驗，測試的證明紀錄也跑一份（ADR-0028）。它和任何人自己做的重驗是同一支指令、同一份公開的檔：建置這個程式庫的 `iamreal-verify`（[`cmd/iamreal-verify/README.md`](../cmd/iamreal-verify/README.md)），用 `@aztec-foundation/bb.js` 6.0.0 附的原生 `bb`（先核對 SHA-256），由同目錄的 [`workflows/reverify.sh`](workflows/reverify.sh) 對公開的網址跑一次：

```
iamreal-verify -bb <bb> -crs <通用參數目錄> -proof-log test -data https://test-data.iamreal.tw/
```

**它做什麼。** `iamreal-verify` 預設的讀法一次做完 ADR-0025 的四件事：

| ADR-0025 的 | 這一次跑做的 |
|---|---|
| 新增的紀錄 | 每一筆從第 1 筆起檢查寫法、驗證證明、套用紀錄規則；算出來的指紋和雜湊清單，和公布的 `fingerprints.jsonl`、`hashes/` 核對 |
| 新增的清冊 | 清冊存檔的每一份清冊重新驗章、建樹，重建索引，和 `crl/index.jsonl` 逐行比 |
| 舊的紀錄檔 | 每一檔每次都重新下載、重算，和公布的雜湊清單、指紋檔核對。沒有進度檔，所以比的不是「自己記著的那一檔結尾的指紋」：紀錄檔、雜湊清單、指紋檔三樣一起被改成彼此一致的另一份，這裡看不出來，要靠另一個地方抄的指紋檔（ADR-0027，[#35](https://github.com/iamreal-tw/iamreal/issues/35)） |
| 卡片狀態檔 | 指紋檔最後一行那天的 `card-state/<日期>.jsonl`，和從證明紀錄算出來的逐張比 |

- **每次從第 1 筆整份重驗，沒有進度檔，也不碰快取**（[#413](https://github.com/iamreal-tw/iamreal/issues/413)）。驗一筆約 12 ms（[#16](https://github.com/iamreal-tw/iamreal/issues/16)），十萬筆約 20 分鐘。
- **執行紀錄裡看得到的**：`iamreal-verify` 在標準錯誤印的每一行（讀哪個網址、公布了幾筆、每一份清冊、雜湊清單、指紋檔、卡片狀態檔的結果，和每一個問題）；標準輸出的前三行（證明紀錄成立時是成立、筆數、指紋；不成立時只有一行，寫壞在第幾行、哪一個代碼）和每一筆無效的紀錄（第幾筆、哪一個代碼）。每一筆有效的紀錄和每張卡片的現況不印：它們在公開的證明紀錄裡，印出來只會讓執行紀錄跟著筆數變長。最後一行是結果和這一次跑了幾秒：

  ```
  reverify: the test proof log at https://test-data.iamreal.tw/ passed: exit code 0, 75 seconds
  ```

- **什麼時候跑**：排程是 UTC 16:30，台灣時間 00:30。後台在台灣的日期換了之後公布那一天的指紋（[`worker/README.md`「每天換日公布證明紀錄」](../worker/README.md#每天換日公布證明紀錄)）。重驗比公布早跑到時，核對到前一天那一行為止，照樣有結果。GitHub 的排程在尖峰時會延後；公開的程式庫 60 天沒有活動，排程會被停掉（[schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)），要到 Actions 的頁面重新打開。排程只在 `main` 上的那一份工作流程檔跑。手動觸發：Actions 頁面的「Run workflow」，或 `gh workflow run reverify.yml`。
- **它拿不到什麼**：沒有任何 secret，`GITHUB_TOKEN` 只能讀，沒有快取。它停不了過卡，也改不了後台的任何東西（ADR-0025：停止收過卡由營運者手動做）。套件只裝 `web/` 的（`bb` 在那裡），不跑安裝腳本、不讀 `.pnpmfile.cjs`、只從 npm 的 registry 裝。兩個工作整個寫死在 `worker/test/workflows.ts`（`REVERIFY_JOBS`），觸發的方式、網址、少了核對 `bb`、多了任何一步，規則都擋；`reverify.sh` 的測試在 `workflows.test.ts`，把 `iamreal-verify` 換成一個照樣印字、照樣回結束碼的替身。

**沒過時。** 結束碼不是 0，工作就失敗。照 `reverify.sh` 印的最後一行分：

| 最後一行 | 結束碼 | 營運者做什麼 |
|---|---|---|
| `passed` | 0 | 不用做 |
| `DID NOT PASS` | 1 | 往上看是哪一筆、哪一項，照下一張表 |
| `could not be checked` | 2 | 下載不到檔這一類：不算沒有通過（ADR-0025），下一次排程會從頭再做一次；連著幾天都這樣才要查 |
| `did not run to its end` | 其他 | `iamreal-verify` 沒跑完（被停掉、超過工作的上限）：對證明紀錄什麼都還不知道，手動再觸發一次 |

工作在 `reverify.sh` 之前就失敗（裝套件、`bb` 的 SHA-256 不對、編不過）時沒有這一行，那是工作流程自己的問題，和證明紀錄無關。

`DID NOT PASS` 時，照 ADR-0025「沒有通過時」的表：

| 執行紀錄裡看到的 | ADR-0025 的哪一種 | 處理 |
|---|---|---|
| `<第幾筆> invalid <代碼>` | 新增的紀錄裡有一筆無效 | 停止收過卡，查原因 |
| `card-state/<日期>.jsonl: card … is different`、`… is missing`、卡片狀態檔壞掉（`line`、`order`） | 卡片狀態檔和重算的不同 | 停止收過卡，查原因 |
| `fingerprints.jsonl` 或 `hashes/` 的某一行、某一份和重算的不同 | 公布的指紋或雜湊清單和重算的不同 | 停止收過卡，查原因 |
| `log file: broken at line …`（紀錄檔少了、切法不對、某一行壞掉） | 紀錄檔本身變了 | 先停止收過卡。沒有進度檔，這一次跑分不出是舊的紀錄檔被動過（ADR-0025：不停止收過卡，從備份換回那一檔）還是後台寫出了壞的紀錄；拿備份或另一份抄本（ADR-0033）比過、確定只是舊檔被動過，才照那一列處理 |
| `CRL archive: …`（索引和清冊檔不同） | ADR-0025 的表沒有這一種 | 查清冊鏡像；結果照重建的索引算，所以紀錄有沒有因此無效，看上面幾列 |

每一次都開一張公開的 issue：第幾筆、哪個代碼、原因、怎麼修的。**測試的證明紀錄沒通過時**只要營運者知道，不停收過卡、不開公開的 issue（ADR-0028）；現在跑的只有這一份。

工作失敗時，營運者收到的是 GitHub 的通知信，和[從外面定時檢查](#從外面定時檢查53)走同一個管道（[#53](https://github.com/iamreal-tw/iamreal/issues/53)、#413「通知」）。信寄給誰、合併之後要把這個工作流程停用再啟用一次，見[通知信寄給誰](#通知信寄給誰)。

**一次超過一小時，就開票做進度檔。** 最後一行印秒數，超過 3,600 秒時再多印一行提醒。

**時間幾乎都花在清冊存檔，不在紀錄；現在最大的一項是下載。** 清冊存檔只會變多：內政部每把發證金鑰一天簽 4 份，一天多 8 份、約 103 MB。2026-11-26 在一台 M1 Max 上照這個工作的做法對測試網站跑了一次（1 筆紀錄、58 份清冊，G2、G3 各 29 份，共 746 MB）：74.7 秒，其中下載 40.1 秒（一份約 0.7 秒）、重建索引 32.6 秒（每把金鑰的第一份共 17 秒，之後的每一份約 0.33 秒）、驗那一筆證明和其餘的約 2 秒；記憶體最高 370 MB。同一天改之前是 573.7 秒，幾乎都在建樹：那時每一份清冊的樹都從頭算，一份約 9 秒，一天多約 73 秒（[#439](https://github.com/iamreal-tw/iamreal/issues/439)；`crl/README.md`「重用雜湊」）。照本機的數字估，現在一天多約 8 秒：約 2028 年初一次超過一小時，約 7 年後碰到一個工作 6 小時的上限。這是推估，GitHub 的 runner 上下載和計算的速度不同，實際的秒數看執行紀錄（改之前 runner 上是 481 秒，#439 的內文）。超過一小時要做的進度檔，先記的是「驗過的清冊」那一項（ADR-0025 的進度檔本來就有它）。做進度檔時要一起解的：ADR-0025 寫進度檔放 GitHub Actions 的快取，ADR-0029 之後只有 `cache.yml` 能寫快取（[#413](https://github.com/iamreal-tw/iamreal/issues/413)）。工作的上限是 6 小時，GitHub 給一個工作最長的時間。

**正式的證明紀錄**：`production` 這個工作寫好了，讀 `https://data.iamreal.tw/`，但有一行 `if: false`，不跑。正式網站有了之後，刪掉 `reverify.yml` 裡 `production` 底下的 `if: false` 那一行，和 `worker/test/workflows.ts` 的 `REVERIFY_JOBS` 裡 `production` 的 `if: "false"`（兩邊要一致，測試會擋）。

## 從外面定時檢查（#53）

`watch-test.yml` 每小時跑一次 [`worker/test/outside-check.ts`](../worker/test/outside-check.ts)，只對 `test.iamreal.tw` 和 `test-data.iamreal.tw` 送 `GET`（#413「通知」）。任何一項不對，工作就失敗：

| 檢查 | 不對的時候 |
|---|---|
| `GET /api/v1/config` 回 `200`，有平台表 | 後台沒有回應 |
| 首頁 `GET /` 回 `200` | 頁面打不開 |
| 資料網域的 `proof-log/fingerprints.jsonl` 最後一行的日期是今天（台灣） | 今天的證明紀錄沒有公布 |
| 清冊存檔的索引裡，G2、G3 最新的可用清冊，日期不早於昨天 | 鏡像停了，或內政部的清冊沒有更新 |
| 資料網域有今天的卡片狀態檔 `proof-log/card-state/<日期>.jsonl` | 同上，今天沒有公布 |
| 資料網域的 `connection-log/oldest.json` 讀得懂，`checked` 在 2 小時內，`oldest` 是 `null` 或不早於今天（UTC）的 33 天前（#20；2026-11-27 打開，見下面） | 後台沒有在看連線紀錄，或有超過期限還沒刪的 |
| 資料網域的 `count-events/oldest.json`，同一種讀法、同樣的門檻（#54；2026-11-27 打開） | 後台沒有在看計數的明細，或有超過期限還沒刪的 |
| 資料網域的 `count-totals/oldest.json`，同一種讀法，`checked` 在 2 小時內，`oldest` 是測試網站第一天加總的日期 2026-11-26（#435；2026-11-27 打開） | 後台沒有在看計數的加總，或最早一天的加總被刪了 |

門檻和時間：

- **每小時一次，第 17 分。** 不在整點，是因為 GitHub 寫了整點是高負載的時候，排程可能被延後，負載夠高時「some queued jobs may be dropped」（[Events that trigger workflows, `schedule`](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule)，2026-11-26 讀）。
- **公布有一小時的寬限。** 每天的公布在台灣時間午夜，第一個小時每分鐘重試（`worker/README.md`「每天公布」）。所以台灣時間 01:00 以前，昨天那一行、昨天的卡片狀態檔也算過。
- **測試的證明紀錄剛清空時不算失敗。** 清空的那一天起兩天內，還沒有指紋檔和卡片狀態檔也算過，日期讀 `worker/wrangler.jsonc` 的 `TEST_PROOF_LOG_CLEARED_ON`，和 `worker/test/site-check.ts` 相同。
- **清冊的門檻是一天。** 內政部大約每六小時發一份（2026-11-26 看測試網站的索引：每天 05、10、17、23 時左右各一份）。裝置在清冊超過 3 天時停下（`config` 的 `crl_max_age_days`），所以這一項比過卡停下早一天以上失敗。

印出來的、通知裡的，只有每一項的名稱，不對的那一項加上狀態碼或日期。沒有連線紀錄的內容，也沒有 IP 位址。

在本機對 `worker/test/` 的 Worker 跑，每一種狀況各自失敗，是 `worker/test/outside-check.test.ts`。對線上的測試網站手動跑：

```sh
cd worker
node --experimental-strip-types test/outside-check.ts
```

**連線紀錄那一項（#20）和計數那一項（#54）2026-11-27 打開了。** 計數那一項和連線紀錄的做法相同：後台每小時看計數明細最舊一檔的日期，寫成 `count-events/oldest.json`。下面講連線紀錄的幾點，計數都一樣。

- 後台每小時看一次最舊的連線紀錄，把結果寫成資料網域上的 `connection-log/oldest.json`：`{"checked":"<UTC 的時間>","oldest":"<UTC 的日期>"}`，一筆都沒有時 `oldest` 是 `null`。
- 這個檢查只讀那一個公開的檔，不讀儲存桶，不握讀 R2 的權杖。
- 33 天的來歷：31 天，加 R2 的生命週期規則最多晚一天刪，再留一天。
- #20、#54 部署之後，這兩個檔出現在測試網站上（2026-11-27 讀到的都是 `{"checked":"2026-11-26T18:00:13.633Z","oldest":null}`），`worker/test/outside-check.ts` 的 `CONNECTION_LOG_CHECKED`、`COUNT_EVENTS_CHECKED` 改成 `true`。檔不在、後台超過 2 小時沒看、最舊的超過 33 天，都算失敗。

**加總那一項（#435）2026-11-27 也打開了。** 加總永久保存，最早一天不會變：後台每小時看 `count-totals/day/` 最早一天的日期，寫成 `count-totals/oldest.json`（同一種格式）；檢查比對的是 `worker/test/outside-check.ts` 的 `COUNT_TOTALS_FIRST`。#435 部署之後，測試網站有了第一天的加總（2026-11-27 讀到的是 `{"checked":"2026-11-27T04:00:12.946Z","oldest":"2026-11-26"}`），`COUNT_TOTALS_FIRST` 填上 `2026-11-26`。日期變晚就是到期規則刪了它；檔不在、後台超過 2 小時沒看，也算失敗。

還沒做的：正式網站。有了之後加上同樣的檢查。

### 通知信寄給誰

工作失敗時，GitHub 寄通知信。這是上線前唯一的通知管道：後台不握送通知的金鑰，不接其他服務（#413「通知」）。

GitHub 的兩頁文件說法不同（2026-11-26 讀）：

- [Events that trigger workflows](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule)：「Notifications for scheduled workflows are sent to the user who last modified the cron syntax in the workflow file.」
- [Notifications for workflow runs](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs)：「Notifications for scheduled workflows are sent to the user who initially created the workflow. If a different user updates the cron syntax in the workflow file, subsequent notifications will be sent to that user instead.」同一頁還寫：「If a scheduled workflow is disabled and then re-enabled, notifications will be sent to the user who re-enabled the workflow rather than the user who last modified the cron syntax.」

在這個程式庫，兩種說法都可能不是營運者。推到 `main` 的是合併佇列：2026-11-26 看 `cache.yml` 由推送觸發的 run，`actor` 和 `triggering_actor` 都是 `github-merge-queue[bot]`，合併提交的作者是營運者。文件沒有說「建立」「最後改 `cron` 的人」指推送的人還是提交的作者，所以信可能寄給這個 bot，也就是沒有人收。

**所以合併之後，營運者要在 Actions 的頁面把 `watch-test` 和 `reverify` 各停用、再啟用一次。** 照上面第二頁的最後一句，之後的通知寄給重新啟用的人。之後有人改了 `cron` 那一行，或再停用、啟用過，收信的人可能又換掉，要再做一次。

收不收得到信，看收信的人自己在 GitHub 的設定：Settings → Notifications → System → Actions，選 Email，並勾「Only notify for failed workflows」（[Configuring notifications for GitHub Actions](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications)）。手動觸發的工作，信寄給按下觸發的人。

### 已知的缺口

**排程自己沒有跑的時候，沒有人會發現。** 上線前不解（#413）：

- 整點附近的排程可能被延後或丟掉（上面的出處）。
- 公開的程式庫 60 天沒有活動，排程的工作流程會被自動停用：「In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days.」（同上）。文件沒有寫停用時會不會通知誰。
- 之後要補時，加一個外部的監測，不用改上面的做法。

## 在本機檢查

工作流程本身在本機跑不起來。檢查它們的規則在 [`worker/test/workflows.ts`](../worker/test/workflows.ts)，測試在 `worker/test/workflows.test.ts`：

```sh
pnpm install --frozen-lockfile   # 在根目錄
cd worker
node --experimental-strip-types --test test/workflows.test.ts
```

`upload-android.yml`、`upload-android-test.yml` 的三個腳本的測試在 `worker/test/upload-android.test.ts`：版本號（台灣的日期、`versionCode` 的範圍、測試 app 加的 1,000,000）、用測試當場產生的上傳金鑰簽章並驗證、對 Google Play 的每一個呼叫（`curl` 換成一個照 API 的文件回答的替身，核對 JWT 的簽章和內容、呼叫的順序、token 沒有出現在命令列、上傳失敗時不提交、傳到工作流程給的那一個 app、不像套件名稱的不送出）。簽章的測試要有 JDK（`JAVA_HOME`，或 Mac 上 `java_home` 找得到的）；沒有時跳過，設了 `CI` 時是失敗。

`worker/` 的 `pnpm test` 也包括它們。`changed-paths.sh` 的測試要有 `bash` 和 `git`。`paths` 清單的測試要有 `go` 才完整：沒有 `go` 時，檢查 Go 套件的那一項跳過，其他照查；設了 `CI`（GitHub Actions 會設）或 `IAMREAL_BB` 時沒有 `go`，那一項是失敗，不是跳過。這些規則防手誤和明顯的改動，不能代替逐行看（`CONTRIBUTING.md`「部署會執行到的東西」）。

## 討論區的發文範本

[`DISCUSSION_TEMPLATE/`](DISCUSSION_TEMPLATE/) 是 GitHub Discussions 三個分類的發文表單：`q-a.yml`（Q&A）、`ideas.yml`（Ideas）、`general.yml`（General）。檔名要和分類的代號相同（[Syntax for discussion category forms](https://docs.github.com/en/discussions/managing-discussions-for-your-community/syntax-for-discussion-category-forms)）。代號跟著分類名稱產生；名稱用中文時代號也是中文，表單對不上（#271 試過，表單沒有出現），所以分類名稱用英文、說明用中文。Announcements 只有維護者能發，沒有範本。

三份都在最上面提醒不要貼出姓名、身分證字號、PIN 碼、卡片的照片或看得到姓名的截圖，送出前要勾選確認；Q&A 多一欄選填的請求編號（`design/copy/faq.md`「回報問題時要附的請求編號是什麼？」）。討論區最上面置頂的說明是同一件事（[#269](https://github.com/iamreal-tw/iamreal/discussions/269)）。這些檔不會被建置或部署執行。

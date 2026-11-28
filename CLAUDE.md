# iamreal

讓持卡人用一張有效的台灣自然人憑證換一張島民證明：把這張卡片在 Threads 的名額公開宣告給一個 Threads 帳號，用零知識證明保護持卡人的身分。對外只講 Threads；規格保留之後加入其他平台的彈性（ADR-0017）。

## 硬限制

設計會碰到其中一條時，停下來，先開 issue 討論：

- 電路用 Noir 自己寫，行為要和對照用的 PSE circom 電路相同；改變電路接受什麼的修改、以及和對照版本有意的差異，各有一份 ADR；匿名編號的算法上線後不動（ADR-0012）
- 匿名編號只有持卡人算得出來；伺服器、內政部、維護者都算不出來
- 憑證、公鑰、簽章、PIN 只留在持卡人的裝置上；PIN 只在記憶體裡停留到送給卡片為止
- 畫面和流程都不收身分證字號

## 語言

- 英文：程式碼、註解、API 欄位、協定規格
- 繁體中文：介面文字、設計文件
- 繁體中文或英文皆可：issues、PR、提交訊息

## 慣例

- Noir 的工具和函式庫釘在特定版本；PSE 的 circom 電路釘在特定 commit，當對照用；改電路後重跑逐案比對
- 範例和測試用假資料：帳號 `@alice`、短編號 `7K2Q9FM4XD`
- 密鑰只放在 `.gitignore` 排除的檔案（`.env.local`）

## 目錄

最上層照「公開這段程式，是為了讓人能檢查哪一件事」來分：

| 目錄 | 內容 | 讓人能檢查的事 | 可以引用 |
|---|---|---|---|
| `spec/` | 協定規格和標準答案 | 不同的實作算出相同的答案 | 無 |
| `circuits/` | 電路的 Noir 原始碼、電路的測試、逐案比對和隨機差異測試、重建並比對的指令（ADR-0038） | 電路檢查了什麼；從原始碼重編出的電路檔和驗證金鑰就是 `web/circuits/`、`verifier/vk/` 裡的；行為和 PSE 的 circom 電路相同 | Noir 的函式庫、`noir_js`、`bb.js`；重建時用 `web/scripts/strip-circuit.mjs` |
| `verifier/` | 驗證核心和獨立的重驗指令（Go） | 任何人都能重驗一筆紀錄 | Barretenberg 的驗證程式（`testdata/` 的產生器可以引用 `circuits/tests/lib/` 的測試工具） |
| `prooflog/` | 紀錄規則的第二份實作（Go） | 拿快照重算，得到相同的現況 | `verifier/` |
| `design/` | 各客戶端共用的介面文字和設計語彙 | 各客戶端說同一句話、長得一樣 | 無 |
| `crl/` | 廢止清冊的樹的建樹程式（Go） | 拿內政部的清冊能重建相同的樹根 | 無 |
| `cmd/` | 重驗證明紀錄、重算樹根的指令（Go） | 任何人都能從命令列重驗 | `verifier/`、`prooflog/`、`crl/`（`iamreal-verify/testdata/` 的產生器可以引用 `circuits/tests/lib/` 的測試工具；那裡的 `card-proofs/` 是 `worker/` 的測試用的） |
| `protocol/` | `spec/` 的 TypeScript 實作：紀錄規則、場合字串、宣告碼、匿名編號、題目 | 後台和裝置用的是同一份規則 | 無 |
| `worker/` | 後台（TypeScript，Cloudflare 的 Worker 專案，ADR-0023） | 規則有照做 | `protocol/` |
| `device-core/` | Android、iOS 共用的核心（Rust，ADR-0034）：`spec/` 的實作、憑證和清冊的檢查、算證明 | 兩個 app 在手機上做的檢查和算法是同一份，而且不碰 PIN、網路、NFC、檔案 | Barretenberg（`barretenberg-rs`）、Noir 的 ACVM |
| `web/`、`android/`、`ios/` | 持卡人裝置上執行的程式 | 憑證、公鑰、簽章、PIN 沒有離開裝置 | `web/`：`protocol/`；`android/`、`ios/`：`device-core/`；都不引用 `worker/`（`web/test/` 的端到端測試可以引用 `worker/test/` 的測試工具） |

- 目錄在第一次需要時才建立，建立時附 `README.md`：這個目錄讓人檢查什麼、怎麼單獨執行
- Go 的程式是同一個模組，`go.mod` 在根目錄；`verifier/` 和 `prooflog/` 要能不帶後台單獨編譯
- Rust 的程式是 `device-core/` 一個 cargo workspace，兩個套件：`checks/` 不依賴原生函式庫，要能不帶 Barretenberg 單獨編譯和測試；`prover/` 連結 Barretenberg，對 Kotlin、Swift 開放的 C 函式都在這裡，慣例寫在 `device-core/README.md`
- Go 的 `verifier/`、`prooflog/`、`crl/`、`cmd/` 是後台以外的第二份實作，每天的重驗用它（ADR-0025、ADR-0030）。Go、TypeScript、Rust（`device-core/`，ADR-0034）的實作互不引用，只共用 `spec/`
- `worker/` 還沒做完：清冊鏡像、過卡的四個介面、每一種訪客頁面、每天公布證明紀錄有了；限流有了照 IP 的那一層，全站的總量上限還沒有（`worker/README.md`「現在有什麼」）。測試網站跑的是它，本機用真卡片過卡（`pnpm local`）也是
- 做任何畫面、寫任何介面文字之前，先讀 `docs/design/principles.md`
- 兩種以上語言都要實作的算法，測試一律讀 `spec/vectors/` 裡同一份標準答案

## Agent skills

### 貢獻規範

每個變更要符合的規範在 `CONTRIBUTING.md`。

### Issue tracker

Issue 記在 GitHub Issues（`iamreal-tw/iamreal`），用 `gh` CLI 操作。見 `docs/agents/issue-tracker.md`。

### Triage labels

沿用五個預設標籤：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。見 `docs/agents/triage-labels.md`。

### Domain docs

單一 context：根目錄的 `GLOSSARY.md` 加 `docs/adr/`。見 `docs/agents/domain.md`。

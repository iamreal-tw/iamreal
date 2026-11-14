# iamreal

讓持卡人用一張有效的台灣自然人憑證，把名額宣告給一個社群帳號，用零知識證明保護持卡人的身分。

## 硬限制

設計會碰到其中一條時，停下來，先開 issue 討論：

- PSE 的電路原樣使用（改電路需要專業稽核）。唯一在討論中的例外是 ADR-0008（效期檢查），接受之前照舊
- 匿名編號只有持卡人算得出來；伺服器、內政部、營運者都算不出來
- 憑證、公鑰、簽章、PIN 只留在持卡人的裝置上；PIN 只在記憶體裡停留到送給卡片為止
- 畫面和流程都不收身分證字號

## 語言

- 英文：程式碼、註解、API 欄位、協定規格
- 繁體中文：介面文字、設計文件
- 繁體中文或英文皆可：issues、PR、提交訊息

## 慣例

- PSE 的程式當成依賴，釘在特定 commit
- 範例和測試用假資料：帳號 `@alice`、短編號 `7K2Q9F`
- 密鑰只放在 `.gitignore` 排除的檔案（`.env.local`）

## 目錄

最上層照「公開這段程式，是為了讓人能檢查哪一件事」來分：

| 目錄 | 內容 | 讓人能檢查的事 | 可以引用 |
|---|---|---|---|
| `spec/` | 協定規格和標準答案 | 不同的實作算出相同的答案 | 無 |
| `verifier/` | 驗證核心和獨立的重驗指令 | 任何人都能重驗一筆紀錄 | PSE 的驗證程式 |
| `roster/` | 名冊規則的參考實作 | 拿快照重算，得到相同的現況 | `verifier/` |
| `design/` | 各平台共用的介面文字和設計語彙 | 各平台說同一句話、長得一樣 | 無 |
| `crl/` | 廢止清冊快照的產生程式 | 拿內政部的清冊能重建相同的指紋 | 無 |
| `server/` | 後台 | 規則有照做 | `verifier/`、`roster/` |
| `web/`、`android/`、`ios/` | 持卡人裝置上執行的程式 | 憑證、公鑰、簽章、PIN 沒有離開裝置 | 不引用 `server/` |

- 目錄在第一次需要時才建立，建立時附 `README.md`：這個目錄讓人檢查什麼、怎麼單獨執行
- Go 的程式是同一個模組，`go.mod` 在根目錄；`verifier/` 和 `roster/` 要能不帶後台單獨編譯
- 做任何畫面、寫任何介面文字之前，先讀 `docs/design/principles.md`
- 兩種以上語言都要實作的算法，測試一律讀 `spec/vectors/` 裡同一份標準答案

## Agent skills

### Issue tracker

Issue 記在 GitHub Issues（`iamreal-tw/iamreal`），用 `gh` CLI 操作。見 `docs/agents/issue-tracker.md`。

### Triage labels

沿用五個預設標籤：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。見 `docs/agents/triage-labels.md`。

### Domain docs

單一 context：根目錄的 `GLOSSARY.md` 加 `docs/adr/`。見 `docs/agents/domain.md`。

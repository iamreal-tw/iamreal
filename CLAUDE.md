# iamreal

讓持卡人用一張有效的台灣自然人憑證，把名額宣告給一個社群帳號，用零知識證明保護持卡人的身分。

## 硬限制

設計會碰到其中一條時，停下來，先開 issue 討論：

- PSE 的電路原樣使用（改電路需要專業稽核）
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

## Agent skills

### Issue tracker

Issue 記在 GitHub Issues（`iamreal-tw/iamreal`），用 `gh` CLI 操作。見 `docs/agents/issue-tracker.md`。

### Triage labels

沿用五個預設標籤：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。見 `docs/agents/triage-labels.md`。

### Domain docs

單一 context：根目錄的 `GLOSSARY.md` 加 `docs/adr/`。見 `docs/agents/domain.md`。

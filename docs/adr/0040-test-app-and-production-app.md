---
status: accepted
---

# 兩個商店的 app：測試 app 永遠連測試網站，正式 app 上線起連正式網站

Android 和 iOS 各有兩個商店的 app：測試 app `tw.iamreal.app.test` 和正式 app `tw.iamreal.app`，另外有不上傳商店的開發用 build `tw.iamreal.app.dev`。這一份取代 ADR-0037（只有一個商店的 app）。ADR-0036 的其餘部分（只從 GitHub Actions 上傳、建置和上傳分開、正式 app 的 Android 簽章金鑰自己產生、可重現的建置）照舊。

## 三種 app

| | 正式 app | 測試 app | 開發用 build |
|---|---|---|---|
| 識別碼（Android、iOS 相同） | `tw.iamreal.app` | `tw.iamreal.app.test` | `tw.iamreal.app.dev` |
| 連哪裡 | 上線前：測試網站。上線起：正式網站 | 測試網站 | 測試網站 |
| 簽的場合字串 | 跟著連的網站 | `iamreal-test:public:0` | `iamreal-test:public:0` |
| 發到哪裡 | Google Play 的測試軌道和正式版、TestFlight 和 App Store | Google Play 的內部測試和封閉測試、TestFlight；永遠不上正式版 | 不上傳商店，營運者用線裝 |
| 給誰 | 封閉測試的測試者；上線後所有人 | 測試網站的測試者 | 營運者 |

- **環境在建置時寫死**，和 ADR-0036 相同。正式 app 連哪個網站是程式庫裡的一個設定，上線那天用一個 PR 改它。
- **上線前，正式 app 也連測試網站。** Google Play 新的個人帳號，正式 app 自己要跑 12 位測試者、連續 14 天的封閉測試；那 14 天連測試網站（ADR-0036 的理由：測試者可以重複過卡，正式的證明紀錄不在公開之前開張）。
- **三種 app 能同時裝在一支手機上**，因為識別碼不同。
- **測試 app 的 Android 簽章金鑰由 Google 產生**（Play App Signing 的預設）。正式 app 的照 ADR-0036 自己產生、由營運者保管。
- **iOS 的測試 app 上線前不發給營運者以外的人。** 上線前 iPhone 的測試者用正式 app 的 TestFlight（它連的也是測試網站）。

## 測試網站的最低版本

上線那天，測試網站的最低版本（ADR-0035）調高到正式 app 上線前的每一個 build 之上，還連著測試網站的舊 build 在要 PIN 之前停下來。這一欄只分 Android 和 iOS，不分是哪一個 app，所以：

- **測試 app 和開發用 build 的 build 號碼，一律比正式 app 上線前的每一個 build 大**，上線那天的調高擋不到它們。號碼怎麼編寫在 `android/`、`ios/` 的 README。
- 上線後，測試網站的最低版本只管測試 app 和開發用 build。

## 誰上傳、誰發布

| | 做什麼 | 誰 |
|---|---|---|
| 上傳 | GitHub Actions 建置，傳到 Google Play 的內部測試和 TestFlight；兩個 app 各一個工作流程 | 營運者手動觸發；營運者電腦上的 coding agent 也可以觸發 |
| 給測試者 | 把一個 build 推到封閉測試、TestFlight 的外部測試 | 營運者在商店的後台按 |
| 發布正式版 | 把正式 app 的一個 build 升到 Google Play 的正式版、送 App Store 審查 | 營運者在商店的後台按 |
| 標籤 | 升上正式版的 build 的提交，推 `android/v…`、`ios/v…` | 營運者；標籤不觸發上傳 |

- **CI 的金鑰只能上傳到測試軌道。** Google Play 的服務帳號在兩個 app 都只有「將應用程式發布至測試群組」。
- **兩個 app 共用 GitHub 的 environment `app-test`。** 兩個工作流程拿的金鑰都只能傳到測試軌道；Apple 的 API 金鑰本來就碰得到帳號裡所有的 app（ADR-0036），分開也沒有隔離。

## 理由

- **這個產品上線後不能在正式網站上測。** 過卡會寫進公開、不能修改的證明紀錄，用掉更換的次數。日後每一次在測試網站上測，都需要一個連測試網站、從商店裝得到的 app；ADR-0037 上線後只剩開發用 build，iPhone 只能用 Ad Hoc 給少數人。
- **正式 app 的 14 天是一次性的成本。** 14 天照 app 算：官方的句子照 app 寫（「must run a closed test for their app」，[App testing requirements for new personal developer accounts](https://support.google.com/googleplay/android-developer/answer/14151465)），申請的入口在每個 app 自己的頁面；Play Console 的說明助理 2026-11-27 也這樣答。所以兩個 app 省不掉正式 app 的封閉測試和上線那天的切換，換到的是上線後的測試。
- **內部測試和封閉測試的限制是同一個 app 裡的。** 「A user who opts into your app's internal test is no longer eligible to receive an open or closed test.」（[Set up an open, closed, or internal test](https://support.google.com/googleplay/android-developer/answer/9845334)）。測試 app 的內部測試者可以直接加入正式 app 的封閉測試。
- **測試 app 的簽章金鑰丟了補得回來。** 它不做可重現的比對，也不會有人把它當正式版；最壞是重新開一個測試 app。
- **iOS 的測試 app 上線前不對外發。** TestFlight 的 app「should be intended for public distribution」（App Review Guidelines 2.2）；上線前正式 app 的 TestFlight 已經連測試網站，不需要測試 app。

## Considered Options

- **一個商店的 app（ADR-0037）**：少一個識別碼、少一份商店的資料。上線後在測試網站上測只剩開發用 build；開發用 build 的 build 號碼固定是 1，上線那天調高測試網站的最低版本會連它一起擋。
- **正式 app 的封閉測試連正式網站，上線不用切換**：正式的證明紀錄在公開之前開張；測試者過一次卡就沒事可做。
- **測試 app 跑 14 天，正式 app 直接上正式版**：要 14 天照帳號算才成立，官方的寫法和說明助理的回答都是照 app 算。
- **測試 app 的簽章金鑰也自己產生**：多一把不能重設的金鑰要保管，換到的只有測試 app 用不到的核對。
- **兩個 app 各一個 GitHub environment**：Android 上能分開，iOS 分不開；兩把都只能傳到測試軌道。

## Consequences

- **多一個永久佔著的識別碼、多一份商店的資料**：商店頁、資料安全性、內容分級、App 隱私標示，測試 app 要開封閉測試或 TestFlight 對外測試時各填一份。
- **上線當天要改正式 app 連的網站**，並調高測試網站的最低版本。
- **上線後，商店的測試軌道上，正式 app 是下一版正式版，連正式網站**；在測試網站上測用測試 app。
- **`android/`、`ios/`、上傳的工作流程現在只有正式 app 和開發用 build**，要加測試 app。

# screens

每一頁、每一個畫面定稿的樣子。做畫面的人照著做，檢查的人拿來對照。

## 截圖上的字以 `design/copy/` 為準

截圖上的字不是規格。和 `design/copy/` 不同時，以 `design/copy/` 為準；版面和視覺的規則以 `design/DESIGN.md`、`design/tokens.json` 為準。定稿版的截圖上還留著幾句之後才改的字，例如「您」「本人」、小寫的 threads、舊的動作寫法（「宣告了」「把…換給…」）、第 1 步的兩個按鈕；各頁的票照 `design/copy/` 改，不照截圖。

截圖上的帳號名稱、島民編號、日期、數字都是假資料。

## 命名

`<頁>[-<狀態>]-<desktop|phone>.png`：桌機寬 1280px，手機寬 390px，原寸 PNG。例外：

- 網頁的過卡流程只有桌機：手機瀏覽器只給 app（#135）
- app 只有手機
- 連結預覽圖只有一張，1200×630

## 定稿版和實作版

每一頁的施工 PR 用實際頁面的截圖換掉同名的定稿版，並改下面表裡的「版本」。

- **定稿版**：施工前定下的樣子
- **實作版**：換成了實際頁面或畫面的截圖

### 訪客的頁面

實作版由 `worker/` 測試用的 Worker 產生：證明紀錄是正式的那種（頁面上沒有測試網站的標示），內容是 `design/copy/` 例子的假資料。島民證明頁和查詢頁拍照前把嵌入框換成空白頁，所以框裡是空的：拍照時不向 Threads 送請求，截圖上也不會出現真的帳號。

| 截圖 | 網址 | 版本 |
|---|---|---|
| `home-desktop.png`、`home-phone.png` | `/` | 實作版 |
| `proof-desktop.png`、`proof-phone.png` | `/p/7K2Q9FM4XD`（島民證明頁） | 實作版 |
| `account-desktop.png`、`account-phone.png` | `/threads/@alice`（查詢頁，有卡片宣告這個帳號） | 實作版 |
| `account-none-desktop.png`、`account-none-phone.png` | `/threads/@alice`（查詢頁，沒有卡片宣告這個帳號） | 實作版 |
| `hang-proof-desktop.png`、`hang-proof-phone.png` | `/hang/7K2Q9FM4XD`（掛上去，從一張島民證明來） | 定稿版 |
| `hang-desktop.png`、`hang-phone.png` | `/hang`（掛上去，沒有指定哪一張） | 定稿版 |
| `proof-log-desktop.png`、`proof-log-phone.png` | `/proof-log` | 定稿版 |
| `verify-desktop.png`、`verify-phone.png` | `/verify` | 實作版 |
| `faq-desktop.png`、`faq-phone.png` | `/faq` | 實作版 |
| `prepare-desktop.png`、`prepare-phone.png` | `/prepare`（過卡需要什麼） | 實作版 |
| `og-image.png` | 每一頁的連結預覽圖（`og:image`）。網站送的就是這一張：`worker/site/og-image.png` 是它逐位元組的拷貝（`worker/scripts/site-files.ts`），改這張圖時重跑那支腳本 | 定稿版 |

### 網頁的過卡流程（`/proof/`）

實作版是 `web/` 的無頭瀏覽器測試（`web/test/e2e/ui.ts`）在 1280px 寬拍的，只認得 Threads 的平台表（第 1 步是正式的建置）；帳號、島民編號、日期是測試的假資料。

| 截圖 | 畫面 | 版本 |
|---|---|---|
| `card-proof-web-1-before-desktop.png` | 第 1 步：開始之前（正式的建置，只認得 Threads） | 實作版 |
| `card-proof-web-2-read-desktop.png` | 第 2 步：讀取卡片 | 實作版 |
| `card-proof-web-2-read-revoked-desktop.png` | 第 2 步：憑證已經被廢止，停在這裡 | 實作版 |
| `card-proof-web-3-pin-desktop.png` | 第 3 步：輸入 PIN | 實作版 |
| `card-proof-web-4-accounts-first-desktop.png` | 第 4 步：你的帳號，還沒宣告過 | 實作版 |
| `card-proof-web-4-accounts-existing-desktop.png` | 第 4 步：你的帳號，已經有宣告 | 實作版 |
| `card-proof-web-5-confirm-new-desktop.png` | 第 5 步：確認，新宣告 | 實作版 |
| `card-proof-web-5-confirm-switch-desktop.png` | 第 5 步：確認，更換 | 實作版 |
| `card-proof-web-5-progress-desktop.png` | 第 5 步：進行中 | 實作版 |
| `card-proof-web-6-done-desktop.png` | 第 6 步：完成，這張卡片的第一筆紀錄 | 實作版 |

### app 的過卡流程

Android 的實作版由模擬器上的過卡測試（`android/test/card-proof.ts`，指令見 `android/README.md`「模擬器上過一次卡」）加上 `IAMREAL_DESIGN_SCREENS=<目錄>` 拍：拍的時候把模擬器的螢幕暫時換成 390 dp 寬、一個像素一個 dp，從系統的狀態列下面拍到這一步的最後，至少 844 高。帳號、島民編號、日期是測試的假資料，連結的網址是測試連的本機伺服器。iPhone 和 Android 共用名稱的那幾張，換成哪一個 app 的寫在「版本」。

| 截圖 | 畫面 | 版本 |
|---|---|---|
| `card-proof-app-1-before-phone.png` | 第 1 步：開始之前 | 實作版（Android） |
| `card-proof-app-2-read-iphone-phone.png` | 第 2 步：讀取卡片，iPhone 的感應位置 | 定稿版 |
| `card-proof-app-2-read-android-phone.png` | 第 2 步：讀取卡片，Android（感應位置的示意圖由 #173 加） | 實作版（Android） |
| `card-proof-app-2-reading-iphone-phone.png` | 第 2 步：iPhone 感應中，系統的感應面板 | 定稿版 |
| `card-proof-app-3-pin-phone.png` | 第 3 步：輸入 PIN | 實作版（Android） |
| `card-proof-app-4-accounts-phone.png` | 第 4 步：你的帳號 | 實作版（Android） |
| `card-proof-app-5-confirm-phone.png` | 第 5 步：確認 | 實作版（Android） |
| `card-proof-app-5-progress-phone.png` | 第 5 步：進行中 | 實作版（Android） |
| `card-proof-app-6-done-phone.png` | 第 6 步：完成，這張卡片的第一筆紀錄 | 實作版（Android） |

### app 的其他畫面

| 截圖 | 畫面 | 版本 |
|---|---|---|
| `app-reminder-1-done-phone.png` | 第一次過卡完成，問要不要提醒 | 定稿版 |
| `app-reminder-2-schedule-phone.png` | 提醒的間隔和時刻 | 定稿版 |
| `app-reminder-3-notification-phone.png` | 提醒的通知（示意，不是系統的實際畫面） | 定稿版 |
| `app-reminder-4-from-notification-phone.png` | 從通知點進來的第 1 步 | 定稿版 |
| `app-settings-phone.png` | 設定 | 定稿版 |
| `app-splash-phone.png` | 啟動畫面（Android 的實作版由模擬器上的過卡測試拍，同上） | 實作版（Android） |
| `app-update-soon-phone.png` | 這一版快不能過卡了 | 定稿版 |
| `app-update-required-phone.png` | 這一版不能過卡了 | 定稿版 |
| `app-no-nfc-phone.png` | 這支手機沒有 NFC | 定稿版 |

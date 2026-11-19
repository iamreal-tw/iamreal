# 兩個商店的開發者帳號、審查和測試版的規定

對應 issue #84。查證日期：2026-11-19。

## 怎麼讀這份筆記

- 只引用 Apple 和 Google 自己的網頁，引文保留英文原文。
- 每一項標三種記號之一：
  - 【一手】來源的原文明寫。
  - 【推論】來源沒有直接寫，是從原文推出來的；推論的依據寫在同一項。
  - 【查不到】在列出的官方頁面裡找不到說法。
- 引文取自 2026-11-19 當天的英文版頁面。商店的規定會改，用之前重新查一次。
- 金額是官方頁面寫的美元定價；兩家都寫了各地區實際金額可能不同。
- 有兩個來源不在開發者文件的網域裡，但是同一家公司的官方頁面：`support.google.com/accounts`（Android 使用者的設定說明）和 `www.apple.com/legal`（Apple 的隱私說明）。用到的地方有標出來。

## 1. 個人名義的帳號

### 1.1 Apple Developer Program（個人）

| 項目 | 內容 | 記號 |
|---|---|---|
| 費用 | 每年 99 美元。"The Apple Developer Program annual fee is 99 USD … in local currency where available. Prices may vary by region and are listed in local currency during the enrollment process." | 【一手】[A1] |
| 資格 | Apple Account 開啟雙重認證，且達到所在地區的法定成年年齡。 | 【一手】[A1] |
| 身分驗證 | 用 Apple Developer app 註冊時，要拍政府發的有照片的證件。"You'll be asked to verify your identity using your driver's license or government-issued photo ID. … We accept passports in most regions, and some regions can accept additional types of government-issued ID, like a driver's license." 同一頁的註腳寫 Apple 不保留證件影像，也可以聯絡 Apple 改用別的驗證方式。 | 【一手】[A2] |
| 付款 | 個人註冊並用信用卡付款時，要用本人的卡，否則註冊會延後，並會被要求提供證件影本。 | 【一手】[A1] |
| 審核要等多久 | 官方沒有寫個人註冊的處理時間。只寫了："If you haven't received a membership confirmation within 24 hours of your purchase, contact us." | 【查不到】確切天數；24 小時那一句是【一手】[A1] |
| 商店頁顯示的名稱 | 是法律姓名，不能用別名或公司名。"If you're an individual or sole proprietor/single-person business, your personal legal name will be listed as the seller on the App Store. Do not enter an alias, nickname, or company name as your first or last name" | 【一手】[A1] |
| 要顯示組織名稱 | 必須是法律實體，並以組織身分註冊。"If you are a sole proprietor/single-person business, you must join as an individual and your legal name will appear as the seller." | 【一手】[A1] |
| 還公開哪些個人資料 | 取決於歐盟《數位服務法》的 trader 身分，由開發者自己判斷並申報。申報為 trader 時，個人要提供「Address or P.O. Box、Phone number、Email address」，Apple 驗證後顯示在歐盟 27 個地區的商品頁上。申報為非 trader 時不用提供聯絡資料："This is not a trader account. You won't need to provide any contact information." 就算不在歐盟上架，也要申報 trader 身分。 | 【一手】[A3] |
| 非 trader、或不在歐盟上架時，商品頁上除了姓名還顯示什麼 | 官方頁面沒有一份完整的清單。 | 【查不到】 |

### 1.2 Google Play Console（個人帳號）

| 項目 | 內容 | 記號 |
|---|---|---|
| 費用 | 一次性 25 美元。"There is a US$25 one-time registration fee." 不收預付卡。 | 【一手】[G1] |
| 帳號類型 | 分個人（personal）和組織（organization）兩種。組織帳號要有 D-U-N-S 編號。 | 【一手】[G1][G2] |
| 必須用組織帳號的 app | 金融產品和服務、健康類 app、獲准使用 `VpnService` 的 app、政府 app（"Government apps, including apps developed by or on behalf of a government agency"）。 | 【一手】[G2] |
| 註冊時要提供 | 開發者名稱（可以和法律姓名不同）、法律姓名、法律地址、聯絡信箱、聯絡電話、開發者信箱、trader 身分。法律姓名和地址取自連結的 Google 付款資料。 | 【一手】[G3] |
| 身分驗證 | 個人帳號要提供政府發的身分證件（"Official government identity document"），文件要和付款資料完全一致。驗證完成前不能送審 app。 | 【一手】[G4] |
| 裝置驗證 | 新的個人帳號要用 Play Console 手機 app 證明手上有實體 Android 裝置，才能上架。裝置要沒有 root、Android 10 以上；驗證本身「should take less than a minute」。 | 【一手】[G5] |
| 審核要等多久 | 官方沒有寫身分驗證的處理時間。 | 【查不到】 |
| 商店頁顯示的名稱 | 顯示的是開發者名稱，可以和法律姓名不同、可以隨時改："Your developer name appears on Google Play, and you can change this name at any time." | 【一手】[G3] |
| 還公開哪些個人資料 | 法律姓名、國家、開發者信箱都會顯示："Google displays your legal name, your country (based on your legal address), and your developer email address on Google Play. If you monetize on Google Play, Google displays your full address." | 【一手】[G3] |
| 電話 | 聯絡電話是給 Google 聯絡用的（"for Google to contact you"）。個人帳號的必填項目裡沒有「開發者電話」這一項（組織帳號有，並且會顯示）。 | 【一手】[G3] |
| 特定地區的額外資料 | "In certain regions, you must provide additional information that may appear on Google Play, such as your phone number or full address." 列出的地區是巴西、歐盟、日本、韓國、印度（app），以色列、越南（遊戲）。這份清單裡沒有台灣；該頁也寫明清單並非完整的法律要求。 | 【一手】[G3][G6] |

兩家的差別：Apple 個人帳號的賣家名稱就是法律姓名；Google 個人帳號顯示的開發者名稱可以自訂，但法律姓名、國家和開發者信箱另外也會顯示。

## 2. Google Play 新個人帳號：正式上架前的封閉測試

| 項目 | 內容 | 記號 |
|---|---|---|
| 適用對象 | 2023-11-13 之後建立的個人帳號。組織帳號不在這一頁的適用範圍。 | 【一手】[G7] |
| 人數和天數（現行值） | 至少 12 位測試者，連續加入滿 14 天。"Developers with personal accounts created after November 13, 2023, must run a closed test for their app with a minimum of 12 testers who have been opted in continuously for at least 14 days." | 【一手】[G7] |
| 怎麼算 | 申請當下要有至少 12 位，而且是往前連續 14 天都在："At least 12 testers must be opted in to your closed test when you apply for production access, and they must have been opted in continuously for the preceding 14 days." | 【一手】[G7] |
| 達標前不能用的功能 | 正式版（Production）和預先註冊（Pre-registration）。開放測試要拿到正式版權限之後才能用："Open testing becomes available after you gain production access." | 【一手】[G7] |
| 達標之後 | 在 Play Console 的 Dashboard 申請正式版權限，回答關於封閉測試、app 和上線準備的問題。 | 【一手】[G7] |
| 申請的審查時間 | "Review usually takes seven days or less, but can occasionally take longer." | 【一手】[G7] |
| 可能被要求繼續測試 | 原因包括「having fewer than 12 opted-in testers or insufficient tester engagement during the testing period」。 | 【一手】[G7] |

## 3. 測試版

### 3.1 TestFlight

| | 內部測試 | 外部測試 |
|---|---|---|
| 誰能當測試者 | App Store Connect 帳號裡的成員（Account Holder、Admin、App Manager、Developer、Marketing 角色）【一手】[A4] | 任何人，不必是 App Store Connect 的使用者【一手】[A6] |
| 人數上限 | 100 人【一手】[A4][A5] | 每個 app 10,000 人【一手】[A4][A6] |
| 要不要審查 | 官方把審查寫在外部測試之下（"If you invite external testers, your beta build may require review"），沒有寫內部測試要審查。【推論】內部測試不必過審；官方沒有一句直接這樣寫 [A5] | 要。第一個 build 要完整審查，之後的不一定："A review is required only for the first build. Subsequent builds may not require a full review. Testing can begin once a build is approved."【一手】[A5][A6] |
| 怎麼加入 | 在 App Store Connect 建內部群組、加入成員；可以設定新 build 自動發給內部測試者【一手】[A4] | 用信箱寄邀請，或公開連結。公開連結可以設人數上限（1 到 10,000）和裝置、系統版本的條件【一手】[A4][A6] |

其他：

- 測試者要裝 TestFlight app，用邀請信或公開連結接受邀請。【一手】[A5]
- 每個 build 可以測 90 天："Your build becomes unavailable for testers after 90 days." 【一手】[A5]
- 每位測試者最多 30 台裝置。【一手】[A4]
- 要先建內部群組，才能建外部群組。【一手】[A6]
- 24 小時內最多送 6 個 build 給 TestFlight App Review；同一個版本一次只能有一個 build 在審。【一手】[A6]
- TestFlight 審查要等多久：【查不到】。

### 3.2 Google Play 的測試軌道

| | 內部測試 | 封閉測試 | 開放測試 |
|---|---|---|---|
| 人數上限 | 每個 app 100 人【一手】[G8] | 每份信箱名單 2,000 人，每個軌道最多 50 份名單、每個開發者帳號最多 200 份；也可以用 Google 群組【一手】[G8] | 預設不限；可以設上限，但不能低於 1,000【一手】[G8] |
| 要不要審查 | "Internal tests might not be subject to standard Play policy or security reviews."【一手】[G8] | 官方只對內部測試寫了可能不受一般審查；封閉測試的用途寫的是「ensure that your app complies with Google Play policy before launch」。【推論】封閉測試會經過一般的審查；官方沒有一句直接這樣寫 [G7][G8] | 同左【推論】[G8] |
| 使用前提 | 無，app 設定完成前就能用【一手】[G7] | 完成 app 設定【一手】[G7] | 新的個人帳號要先拿到正式版權限【一手】[G7] |
| 怎麼加入 | 用信箱名單指定；測試者打開加入連結後同意加入【一手】[G8] | 信箱名單或 Google 群組；用群組時要先加入群組再同意加入測試【一手】[G8] | 任何人拿到連結就能加入；測試版會出現在 Google Play 上【一手】[G7][G8] |
| 在商店找得到嗎 | 找不到，只能用網址："available to internal testers via URL only–it's not discoverable on Google Play."【一手】[G9] | 兩頁的寫法不同。[G8]："If you run an internal or closed test prior to open testing or production rollout, testers cannot find your app by searching Google Play." [G9]："Your app is discoverable on Google Play but only selected testers can install and use it."【一手】，兩句都是原文 | 找得到，任何人都能成為測試者【一手】[G9] |

其他：

- 加入連結只在 app 狀態是「Published」時才會顯示；第一次發布任何測試時，連結可能要幾個小時才能用。【一手】[G8]
- 已加入內部測試的使用者，不能同時收到封閉或開放測試的版本，要先退出內部測試。【一手】[G8]
- 測試者不能留公開評論；封閉和開放測試的測試者可以透過 Google Play 留私下的意見。【一手】[G8]

## 4. 正式版和更新的審查要等多久、有沒有加急

| | App Store | Google Play |
|---|---|---|
| 通常多久 | "typically reviewing at least 50% of submissions in less than 24 hours and 90% in less than 48 hours"；送審資料不完整會延後。【一手】[A7] | 官方沒有給一般情況的數字。只寫了對某些開發者帳號會審得比較久："For certain developer accounts, we'll take more time to thoroughly review your app … This may result in review times of up to seven days or longer in exceptional cases." 哪些帳號屬於「certain developer accounts」沒有寫。【一手】[G9]；一般情況的時間【查不到】 |
| 加急 | 有。遇到特殊情況可以申請，官方舉的例子是修正重大錯誤、配合自己直接參與的活動。修正錯誤時要附上在現行版本重現的步驟；配合活動時要寫活動、日期、app 和活動的關係。【一手】[A7] | 【查不到】官方頁面沒有提到加急的管道 [G9] |
| 更新和新 app 的審查時間有沒有差別 | 【查不到】官方的數字沒有分新 app 和更新 [A7] | 【查不到】[G9] |
| 控制發布時間 | 可以在 App Store Connect 排定發布時間。【一手】[A7] | 可以在 Publishing overview 頁面控制變更何時送審、何時發布。【一手】[G10] |

Google Play 新個人帳號第一次上正式版，另外還有第 2 節的正式版權限申請（通常七天以內）。

## 5. 審查的人手上沒有那張實體卡時怎麼送審

### 5.1 Apple

- 需要特定硬體的 app，要提供影片，而且不能是螢幕錄影："Required hardware: Apps with required hardware must provide a video (not a screen recording) that shows your app running on a physical Apple device as it pairs and interacts with the hardware." 【一手】[A8]
- 環境難以重現或需要特定硬體時，要準備好示範影片或硬體："If features require an environment that is hard to replicate or require specific hardware, be prepared to provide a demo video or the hardware." 【一手】[A7]
- 送審前的清單寫要給審查者完整的存取："provide either an active demo account or fully-featured demo mode, plus any other hardware or resources that might be needed to review your app (such as login credentials or a sample QR code)." 【一手】[A9]
- 示範模式，審查準則 2.1(a) 的寫法是要事先取得 Apple 同意："If you are unable to provide a demo account due to legal or security obligations, you may include a built-in demo mode in lieu of a demo account with prior approval by Apple. Ensure the demo mode exhibits your app's full features and functionality." 【一手】[A9]
- 示範模式，說明頁的寫法："If your app handles sensitive user information, or operates in a highly regulated industry, you can implement a demonstration mode instead of providing a demo account. A demonstration mode should show your app's full features and functionality using demonstration data." 這一頁沒有提到事先同意；兩處寫法不同，準則是 2.1(a) 那一句。【一手】[A8]
- 「事先同意」要怎麼申請：【查不到】。
- 特殊設定、帳號資訊、特別的操作說明，寫在 App Store Connect 的 App Review Information；說明和連結寫在 Review Notes 欄位，文件放 Attachment。不寫的話審查可能延後或不通過。【一手】[A7]
- 審查備註還要寫：app 的用途和對象、測試過的裝置和系統版本、用到的外部服務、各地區的差異。【一手】[A8]
- 登入要驗證碼時，要事先寫在 Notes 欄位，否則可能要安排通話，"Calls are typically completed within three to five business days." 【一手】[A8]
- 送審前可以預約和 App Review 一對一討論（"Request a one-on-one App Review appointment"）。【一手】[A8]
- 審查準則和這兩頁都沒有提到「實體身分證件」或「政府發的卡」這種情況；上面幾條是把實體卡當作「required hardware」或「resources needed to review」來讀。【推論】

### 5.2 Google Play

- 要讓審查者能進入 app 的所有功能："you must provide the necessary information for our team to log in and access all app functionality … This may include standard sign-in details for testing purposes, an active demo account details such as a username and password for a pre-configured account, or any other access resources such as QR codes or specific instructions for accessing restricted areas of your app." 【一手】[G11]
- 受限的情況不只帳號密碼："If your entire app or parts of your app are restricted based on login credentials, sign in details, memberships, location, or other forms of authentication, you must provide all required details to enable access to your app." 【一手】[G12]
- 填寫位置是 Play Console 的 App content 頁的「Sign-in details」，最多五組說明；登入方式特別時寫在「Any other instructions」欄位。【一手】[G12]
- 提供的登入資料要隨時可用、可重複使用、不受地點限制；平常要一次性密碼或兩步驟驗證的，要提供能跳過的可重複使用的憑證；要用英文提供。失效的話 app 可能被退回。【一手】[G11]
- 不是數字或文字的憑證（例如 QR code、條碼），要產生一個固定網址上傳。【一手】[G11]
- 需要實體卡或其他硬體才能用的 app 該怎麼送審：【查不到】。上面兩頁沒有提到硬體、實體卡、示範影片或示範模式。

## 6. 用 NFC 讀卡的 app 在審查上有沒有額外的要求

### 6.1 Apple

- 審查準則全文沒有出現「NFC」或「Near Field」。【一手】[A9]（2026-11-19 對全文搜尋，零筆）
- 所以準則裡沒有專門針對 NFC 讀卡的條文。【推論】相關的一般要求是第 5.1 節的硬體和影片。
- 技術上的前提（不符合就讀不到卡，和審查條文是兩回事）：
  - `Info.plist` 要有 `NFCReaderUsageDescription`，"A message that tells people why the app is requesting access to the device's NFC hardware." 【一手】[A10]
  - 要有 entitlement「Near Field Communication Tag Reader Session Formats」。【一手】[A10]
  - 讀 ISO 7816 的卡，要把 app 支援的應用識別碼（AID）列出來："To interact with ISO 7816 tags, add the list of the application identifiers supported in your app to the `com.apple.developer.nfc.readersession.iso7816.select-identifiers` information property list key." 【一手】[A11]
  - Core NFC 不能用在 app extension，並且要裝置支援 NFC。【一手】[A10]
- 準則 4.8（登入服務）列出的例外裡，有一條是「Your app uses a government or industry-backed citizen identification system or electronic ID to authenticate users.」這一條講的是可以不必另外提供同等的登入服務，和 NFC 無關。【一手】[A9]

### 6.2 Google Play

- 「Permissions and APIs that Access Sensitive Information」政策頁全文沒有出現「NFC」。【一手】[G13]（2026-11-19 對全文搜尋，零筆）
- 所以這一頁沒有把 NFC 權限列為要另外申報的敏感權限。【推論】其他政策頁有沒有提到 NFC：【查不到】（沒有逐頁查完整個政策中心）。
- 技術上的前提：
  - manifest 要宣告 `android.permission.NFC`。【一手】[G14]
  - 宣告 `<uses-feature android:name="android.hardware.nfc" android:required="true" />` 的話，app 只會出現在有 NFC 硬體的裝置的 Google Play 上；NFC 不是必要功能時可以不宣告，改在執行時檢查。【一手】[G14]
  - Android 16 起，app 第一次收到 NFC intent 時系統會通知使用者，使用者可以在通知裡選擇不讓這個 app 再掃描 NFC 標籤；app 可以用 `NfcAdapter.isTagIntentAllowed()` 檢查。【一手】[G14]
  - Android 17（API 37）起，目標 SDK 高於 `BAKLAVA` 的 app，要接收 NFC intent 的 activity 必須用 `android.permission.DISPATCH_NFC_MESSAGE` 保護。【一手】[G14]

## 7. 商店自己收的統計和當機報告、隱私標示

### 7.1 商店自己收的資料和使用者怎麼不給

| | Apple | Google |
|---|---|---|
| 開發者看得到什麼 | App Store Connect 的 Analytics：安裝數、工作階段、使用中的裝置、刪除數、當機數等。詳細的當機紀錄在 Xcode 看。【一手】[A12] | Play Console 的 Android vitals：當機率、ANR 率等穩定性和效能指標。資料在 Play Console 保留 90 天。【一手】[G15] |
| 資料來自哪些使用者 | 只來自同意分享的使用者："App usage data is collected only from users who have agreed to share diagnostics and usage information with app developers." 開發者看得到同意比例的歷史。【一手】[A12][A13] | 只來自同意分享的使用者："Data is collected from users who have opted in to automatically share usage and diagnostics data from a subset of Android devices and OS versions." 不含未經認證的裝置，也不含不是從 Google Play 安裝的版本。【一手】[G15] |
| 使用者怎麼不給 | 設定 > 隱私權與安全性 > 分析與改進功能，關掉「與 App 開發者共享」："go to Settings > Privacy & Security > Analytics & Improvements, and turn off Share With App Developers." 關掉「分享 iPhone 與手錶分析」時，這一項會自動關閉。【一手】[A14]（`www.apple.com/legal`） | 設定 > Google > 更多 > 使用情況與診斷，關掉。同一頁寫明："Turning off usage and diagnostics won't affect info that apps might collect." 【一手】[G16]（`support.google.com/accounts`） |
| 隱私保護 | 部分來源的資料要達到最低門檻才顯示。【一手】[A13] | 分享給開發者的是彙總資料："Some aggregated info can help partners, like Android developers"。【一手】[G16] |
| 這些要不要寫進隱私標示 | 不用："You are not responsible for disclosing data collected by Apple." 但開發者自己從 Apple 的框架或服務取得的資料要申報。【一手】[A15] | 【查不到】Data safety 的說明頁沒有直接寫 Google Play 自己收的資料要不要申報 [G17] |

TestFlight 向測試者收哪些資料、測試者怎麼不給：【查不到】（這次沒有查到官方頁面的說法）。

### 7.2 App Store 的 App Privacy

- 誰要填：送新 app 和更新到 App Store 都要。"This information is required to submit new apps and app updates to the App Store." 第三方程式碼（SDK、分析工具）收的也要算進去。【一手】[A15]
- 只在 TestFlight 發布的 app 要不要填：【查不到】。
- 「收集」的定義："'Collect' refers to transmitting data off the device in a way that allows you and/or your third-party partners to access it for a period longer than what is necessary to service the transmitted request in real time." 【一手】[A15]
- 只在裝置上處理的不算收集："Data that is processed only on device is not 'collected' and does not need to be disclosed in your answers. If you derive anything from that data and send it off device, the resulting data should be considered separately." 【一手】[A15]
- 每一種資料要申報：收了哪些類型、用途、是否連結到使用者的身分、是否用於追蹤。【一手】[A15]
- 資料類型包括 Identifiers（User ID、Device ID）、Usage Data、Diagnostics（Crash Data、Performance Data、Other Diagnostic Data）等。【一手】[A15]
- 隱私權政策的網址是必填。"Privacy Policy (Required): The URL to your publicly accessible privacy policy." 審查準則 5.1.1(i) 另外要求 app 內也要有容易找到的隱私權政策連結。【一手】[A15][A9]

### 7.3 Google Play 的 Data safety

- 誰要填：封閉測試、開放測試、正式版的 app 都要；只在內部測試軌道的 app 不用。"All developers that have an app published on Google Play must complete the Data safety form, including apps on closed, open, or production testing tracks. … Apps that are exclusively active on this track [internal testing] do not need to complete the Data safety form." 【一手】[G17]
- 不收任何資料的 app 也要填，並且要提供隱私權政策的連結："Even developers with apps that do not collect any user data must complete this form and provide a link to their privacy policy." 【一手】[G17]
- 「收集」的定義：把資料從使用者的裝置傳出去。「分享」的定義：把收集到的使用者資料轉給第三方。【一手】[G17]
- 不算收集的兩種情況：
  - 只在裝置上處理："User data accessed by your app that is only processed locally on the user's device and not sent off device does not need to be disclosed." 【一手】[G17]
  - 端對端加密："User data that is sent off device, but that is unreadable by you or anyone other than the sender and recipient as a result of end-to-end encryption does not need to be disclosed." 【一手】[G17]
- 以假名方式收集的資料要申報："data that can reasonably be re-associated with a user must be disclosed." 【一手】[G17]
- 資料類型包括 Personal info、App info and performance（Crash logs、Diagnostics、Other app performance data）、Device or other IDs 等。【一手】[G17]
- 另外要申報：傳輸過程是否全部加密、有沒有讓使用者要求刪除資料的方式。【一手】[G17]

## 查不到的項目（彙整）

1. Apple 個人註冊、Google 個人帳號身分驗證各要等多久。
2. Apple 個人帳號在非 trader 或不在歐盟上架時，商品頁上除了法律姓名還顯示哪些資料的完整清單。
3. TestFlight 審查要等多久。
4. Google Play 一般情況的審查時間、新 app 和更新的差別、加急的管道。
5. Google Play 對「需要實體卡或硬體才能用」的 app 怎麼送審。
6. Apple 示範模式的「prior approval」怎麼申請。
7. 只在 TestFlight 發布的 app 要不要填 App Privacy；TestFlight 向測試者收哪些資料。
8. Google Play 自己收的統計要不要寫進 Data safety。
9. Google Play 政策中心其他頁面有沒有提到 NFC（只查了敏感權限那一頁）。

## 來源

全部在 2026-11-19 查證。

Apple：

- [A1] Enrollment — https://developer.apple.com/help/account/membership/program-enrollment/
- [A2] Enrolling, verifying, and renewing with the Apple Developer app — https://developer.apple.com/help/account/membership/enrolling-in-the-app/
- [A3] Manage European Union Digital Services Act trader requirements — https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements
- [A4] TestFlight — https://developer.apple.com/testflight/
- [A5] TestFlight overview — https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview
- [A6] Invite external testers — https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers
- [A7] App Review — https://developer.apple.com/distribute/app-review/
- [A8] Provide information for a complete review — https://developer.apple.com/help/app-review/before-submitting-for-review/complete-review
- [A9] App Review Guidelines — https://developer.apple.com/app-store/review/guidelines/
- [A10] Core NFC — https://developer.apple.com/documentation/corenfc
- [A11] NFCTagReaderSession — https://developer.apple.com/documentation/corenfc/nfctagreadersession
- [A12] App usage（App Store Connect Analytics Help）— https://developer.apple.com/help/app-store-connect-analytics/engagement/app-usage/
- [A13] App Analytics（App Store Connect）— https://developer.apple.com/app-store-connect/analytics/
- [A14] App Analytics & Privacy — https://www.apple.com/legal/privacy/data/en/app-analytics/
- [A15] App Privacy Details — https://developer.apple.com/app-store/app-privacy-details/

Google：

- [G1] Get started with Play Console — https://support.google.com/googleplay/android-developer/answer/6112435?hl=en
- [G2] Choose a developer account type — https://support.google.com/googleplay/android-developer/answer/13634885?hl=en
- [G3] Required information to create a Play Console developer account — https://support.google.com/googleplay/android-developer/answer/13628312?hl=en
- [G4] Verify your developer identity information — https://support.google.com/googleplay/android-developer/answer/10841920?hl=en
- [G5] Device verification requirements for new developer accounts — https://support.google.com/googleplay/android-developer/answer/14316361?hl=en
- [G6] Requirements for distributing apps in specific countries/regions — https://support.google.com/googleplay/android-developer/answer/6223646?hl=en
- [G7] App testing requirements for new personal developer accounts — https://support.google.com/googleplay/android-developer/answer/14151465?hl=en
- [G8] Set up an open, closed, or internal test — https://support.google.com/googleplay/android-developer/answer/9845334?hl=en
- [G9] Publish your app — https://support.google.com/googleplay/android-developer/answer/9859751?hl=en
- [G10] Prepare and roll out a release — https://support.google.com/googleplay/android-developer/answer/9859348?hl=en
- [G11] Requirements for providing sign in details for review — https://support.google.com/googleplay/android-developer/answer/15748846?hl=en
- [G12] Prepare your app for review — https://support.google.com/googleplay/android-developer/answer/9859455?hl=en
- [G13] Permissions and APIs that Access Sensitive Information — https://support.google.com/googleplay/android-developer/answer/16558241?hl=en
- [G14] NFC basics — https://developer.android.com/develop/connectivity/nfc/nfc
- [G15] Monitor your app's technical quality with Android vitals — https://support.google.com/googleplay/android-developer/answer/9844486?hl=en
- [G16] Share usage & diagnostics information with Google — https://support.google.com/accounts/answer/6078260?hl=en
- [G17] Provide information for Google Play's Data safety section — https://support.google.com/googleplay/android-developer/answer/10787469?hl=en

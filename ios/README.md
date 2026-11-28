# ios/：iPhone 的 app（Swift）

**這個目錄讓人檢查的事：憑證、公鑰、簽章、PIN 沒有離開手機，而且 app 算的和檢查的就是 `device-core/` 那一份。** 協定的算法、裝置上的檢查、算證明都在 `device-core/`（Rust，ADR-0034），這裡的 Swift 只呼叫它對外的 C 函式（`idc_` 開頭），不自己算。例外是讀卡：對卡片送的指令和卡片要的安全通道（`spec/card-channel.md`）照 ADR-0034 寫在 Swift，`App/CardChannel.swift` 的測試讀 `spec/vectors/card-channel.json`。畫面、讀卡、送出請求都寫在這個目錄；要看 PIN 去了哪裡，看這裡就夠，`device-core/` 沒有任何函式收 PIN。

這個目錄不引用 `protocol/`、`worker/`，沒有第三方的套件。

## 現在有什麼

過卡的八步和流程（[#170](https://github.com/iamreal-tw/iamreal/issues/170)），照網頁版 `web/src/flow.ts` 的順序，卡片感應三次（[#133](https://github.com/iamreal-tw/iamreal/issues/133)）。卡片用 iPhone 的 NFC 讀（[#174](https://github.com/iamreal-tw/iamreal/issues/174)）：每一次感應是系統的一個讀卡面板，讀憑證不用 PIN，簽章前先和第二代卡片建立安全通道（`spec/card-channel.md`）才送 PIN。畫面和啟動畫面照 `design/screens/` 的 `card-proof-app-*`、`app-splash-phone.png`（[#296](https://github.com/iamreal-tw/iamreal/issues/296)），讀取卡片那一步有感應位置的示範（`card-proof-app-2-read-iphone-phone.png`，下面「第 2 步有感應位置的示範」）。第 1 到 5 步的字和第 4 步的分流照 `design/copy/card-proof.md`（[#363](https://github.com/iamreal-tw/iamreal/issues/363)）：第 1 步「找附近的戶政事務所」交給 iPhone 的地圖搜尋「戶政事務所」（地圖的連結 `https://maps.apple.com/?q=…`，app 不要位置的權限），另一個連結用瀏覽器開內政部憑證管理中心的網站；第 4 步在卡片沒有宣告時只有填帳號的欄位，已經有宣告時主按鈕是「更新島民證明」，下面是「改成別的帳號」和「收回對 @alice 的宣告」；這張卡片今天已經過卡 3 次時，一進到這個畫面就丟掉 PIN，下面是「打開你的島民證明看看。」和「重新掛上連結」「回到開頭」，「重新掛上連結」在 app 裡顯示這張卡片現在宣告的帳號的完整第 6 步（沒有「第 N 步，共 8 步」、記進證明紀錄的那一行和換新卡片那一句；「上一步」回到第 4 步）。過卡提醒和設定（[#298](https://github.com/iamreal-tw/iamreal/issues/298)，照 [#93](https://github.com/iamreal-tw/iamreal/issues/93)）照 `design/screens/` 的 `app-reminder-*`、`app-settings-phone.png`：提醒是手機自己排的本機通知。送出之後是三步（[#364](https://github.com/iamreal-tw/iamreal/issues/364)，照 `design/copy/card-proof.md` 第 6 到 8 步），每一步上方寫「共 8 步」：第 6 步把連結掛上個人檔案（再次過卡是只問一句的短版，「重新掛上連結」換成完整的；「複製證明連結」和「打開 Threads」左右並排，任一顆的字在半寬裡放不下一行時（系統字體放大、iOS 15）上下排；從短版換到的完整的第 6 步多一顆「上一步」，回到短版；第二顆照舊打開這個帳號的個人檔案，VoiceOver 讀完整的「打開 @alice 的 Threads 個人檔案」；下面是會動的示範和四步的字，見下一段）；第 7 步問要不要提醒（「設定提醒」打開選間隔和時刻，在那裡按「開啟提醒」才問系統；存好回到第 7 步，持卡人自己按「下一步」）；第 8 步是完成和分享（「分享到 Threads」打開 Threads 的發文畫面，旁邊分享符號的小按鈕打開系統的分享面板，一排在上；「上一步」「完成」並排在下）。第 7、8 步可以按「上一步」；全部收回時第 5 步之後直接到第 8 步。填帳號和 PIN 時，鍵盤正上方有一條「完成」收起鍵盤（`card-proof.md`「app：鍵盤」）。換步驟時畫面直接換，不帶動畫：按鈕照它的字認，另一步同一個位置的按鈕是另一顆，不會從這一顆變形過去。

中斷和錯誤（[#172](https://github.com/iamreal-tw/iamreal/issues/172)，照 [#133](https://github.com/iamreal-tw/iamreal/issues/133)、ADR-0035）：

| 情況 | app 做什麼 |
|---|---|
| 第 1 次感應卡片離開、沒有感應到 | 寫原因，「再感應一次」只重做那一次 |
| 在面板上按「取消」（第 1、2 次感應） | 回到按下之前的畫面，不寫原因；第 2 次的 PIN 還在 |
| 第 2 次感應：卡片在 PIN 送出之前離開、在卡片接受 PIN 之後離開、沒有感應到、換了卡 | PIN 留在記憶體，「再感應一次」只重做那一次，不用再輸入 |
| 第 2 次感應：卡片在送 PIN 的那一道指令離開，而且還沒有接受過這個 PIN | 不自動重送：丟掉 PIN，回到輸入的畫面，寫明不確定卡片有沒有收到。卡片接受過這個 PIN 之後（接受了、簽章時離開，再感應一次），在送 PIN 時離開照「再感應一次」 |
| PIN 不正確、安全通道建立不起來 | 丟掉 PIN，回到輸入的畫面 |
| 第 3 次感應：卡片離開（不管 PIN 送出了沒有：第 2 次已經被接受過）、沒有感應到、換了卡、按了「取消」 | PIN 留在記憶體，「再感應一次」只重做那一次；「取消」丟掉 PIN 回到開頭 |
| PIN 的第一個字進到欄位之後滿 5 分鐘、PIN 還在記憶體裡（欄位裡的也算） | 丟掉 PIN 和做到一半的過卡，回到第 1 步，上面寫原因。感應或請求做到一半時等它結束。切到別的 app 再回來，5 分鐘內 PIN 還在；系統把 app 停在背景時計時不會跑，回到 app 的那一刻補查 |
| app 被系統結束 | 從第 1 步來（上面「不寫磁碟」） |
| 這一版比 `config` 的最低版本舊（`min_app`，由核心的 `idc_min_app` 讀，`spec/min-app.md`） | 起算日之前：第 1 步最上面提醒（在過卡提醒的那一段上面），照常過卡。起算日當天起：整個畫面換掉第 1 步，沒有任何通到感應或 PIN 的按鈕；打開 app 時、回到 app 時和按「感應卡片」連上伺服器之後各看一次；`config` 之後說可以了，畫面換回第 1 步 |
| `min_app` 讀不懂（包括 app 自己的 build number 不是整數） | 第 2 步停在「連上島民證明的伺服器」，和 `config` 讀不懂相同，不讀卡 |
| 手機不能讀卡（沒有 NFC） | 整個畫面換掉第 1 步 |

「到 App Store 更新」開的是正式 app（`tw.iamreal.app`，ADR-0040）在 App Store 的頁面，`https://apps.apple.com/app/id<數字>`。TestFlight 和 App Store 是 App Store Connect 的同一筆，所以數字只有一個，連測試網站或正式網站都一樣：

- **數字是 `6837606453`**，寫在 `App/AppEnvironment.swift` 的 `storeAppID`（一行；只有數字，不帶 `id`）。它是 App Store Connect 正式 app 的「App 資訊」裡的 Apple ID，不是密鑰。要換就改那一行。
- **正式 app（Release）** 在那兩個畫面有「到 App Store 更新」的按鈕。`storeAppID` 是 `nil` 時沒有按鈕，句子照舊。
- **測試 app（TestApp，`tw.iamreal.app.test`）和開發用 build（Debug，`tw.iamreal.app.dev`）沒有按鈕**（#484）：測試 app 永遠不上 App Store，開發用 build 不在任何商店；那個號碼的頁面是正式 app 的，在那裡更新不會讓這兩個變新。測試 app 從 TestFlight 更新；開發用 build 太舊時，從新的原始碼再用線裝一次（「怎麼用線裝到手機」）。畫面上的句子不分 app，照樣寫到 App Store 更新，不加新的字。

第 2 步有感應位置的示範（[#376](https://github.com/iamreal-tw/iamreal/issues/376)），取代原本的示意圖和圖說：進到第 2 步就開始，三輪（10.55 秒）後停在卡片貼好的那一格；示範框右下角一行小字（「停止播放」「再看一次」），點示範本身也一樣。按了「感應卡片」之後示範停在卡片貼好的那一格、不自己重播（沒有感應到、再感應一次時也是），感應中小字和示範都不能按；讀完之後不畫。按「感應卡片」之前，按鈕緊接在示範下面、清單在按鈕下面；讀到一半停下或讀完之後，清單在上、按鈕在下（`design/copy/card-proof.md`「2. 讀取卡片」app 段）。減少動態時照樣播，對 VoiceOver 是一句說明（`app_demo.sense_iphone`）。說明的那一句沒有改。

第 6 步有掛上去的示範（[#375](https://github.com/iamreal-tw/iamreal/issues/375)，[#369](https://github.com/iamreal-tw/iamreal/issues/369)；`design/copy/card-proof.md`「示範」、`design/motion/README.md`）：五個示意畫面由左到右排成一列，鏡頭從按「複製證明連結」一路帶到個人檔案多出來的那一行，20.7 秒，帳號和網址是這張島民證明自己的，回程是按「連結」那一頁右上角的「完成」（iPhone 的做法）。示範大半進到畫面時自己播一次（一次過卡只自己播一次，從第 7 步按「上一步」回來不再自己播）；示範框右下角一行小字，播的時候是「停止播放」（按了直接到最後一格），停了或播完是「再看一次」，點示範本身也一樣；播到哪一步，四步的字裡那一步用淺灰底和左邊一條紅線標出來。系統設定減少動態時照樣播，看的人用「停止播放」停下來（#369 的決定）。對 VoiceOver 整段示範是一句說明，四步的字照常唸。短版的第 6 步沒有示範；卡片在 Threads 上沒有帳號時也沒有。沒有加任何程式庫：示意畫面是 SwiftUI 自己的元件，每一格的時間來自系統的 `TimelineView`。一步最下面的兩顆按鈕也左右並排，往下走的那一顆在右，任一顆的字在半寬裡放不下一行、或三顆時上下排、往下走的在上；第 8 步的「分享到 Threads」和分享符號的小按鈕一排在兩顆上面（`design/DESIGN.md`「按鈕」，`CardProofView.swift` 的 `ButtonRow`、`Screen.top`、`Screen.beside`）。iOS 15 沒有辦法問系統按鈕的字有多寬，一律上下排。

| 檔案 | 內容 |
|---|---|
| `App/DeviceCore.swift` | `device-core/` 的 C 函式包成 Swift：位元組進、位元組出；核心交出來的每一塊緩衝區複製後立刻還給核心（核心會先蓋成零）。一次過卡的 session 是 `DeviceCore.Session`，放掉時核心把憑證和算出來的東西蓋成零 |
| `App/Card.swift` | 「卡片」這一層：一次感應（`tap`）裡讀憑證、帶 PIN 簽章，和一次感應停下來的原因（`CardFailure`）。`PIN` 也在這裡：只在記憶體，`clear()` 蓋成零 |
| `App/NFCCard.swift` | 用 Core NFC 讀卡：一次感應是一個 `NFCTagReaderSession`，系統的面板中間那一句照 `design/copy/card-proof.md`「app：感應的面板」；感應沒有完成時帶著「沒有完成，請看 app 畫面上的說明。」把面板收成失敗的樣子，不然系統會播完成的勾（[#367](https://github.com/iamreal-tw/iamreal/issues/367)）；同時只開一個；卡片中途離開時說 PIN 送出了沒有 |
| `App/GpkiCard.swift` | 對卡片送的指令：讀 PKCS #15 的目錄和每一張憑證（不用 PIN）；建立安全通道、驗 PIN、簽章；認出第一代的卡片 |
| `App/CardChannel.swift` | `spec/card-channel.md`：卡片的靜態金鑰、安全通道的金鑰和每一道指令的加密與 MAC、PIN 和要簽的區塊。三個讀卡的檔（這個、`GpkiCard.swift`、`NFCCard.swift`）第一行寫出處：上游 `mctea01/my-Bonds-fork-android` 的 `GpkiCard.kt`，釘 commit `a8696253`（Apache-2.0，`NOTICE`） |
| `App/Backend.swift` | 「後台」這一層：`config`、清冊鏡像的兩種檔、查現況、題目、送出。位元組進出，請求和回應的內容由核心寫和讀。拿題目的請求送出去之後回應的標頭沒有來時（連線被關，或等到逾時），再送一次，第二次還是沒有才是 `network`（[#404](https://github.com/iamreal-tw/iamreal/issues/404)）：手機停在第 4、5 步的那幾分鐘，先前留著的連線可能已經不通。第二次用一個新的 session，所以是新的連線。連不上伺服器、等的工作被取消都不重送；送出紀錄的請求不自己重送（`Tests/ChallengeAgainTests.swift`）。每個請求的 `User-Agent` 是固定的 `iamreal`，和 Android 相同，`Accept-Language` 是固定的 `zh-TW`；不設的話系統會送 app 的 build、系統的版本和手機的語言清單（[#444](https://github.com/iamreal-tw/iamreal/issues/444)） |
| `App/CardProofFlow.swift` | 一次過卡，沒有畫面的狀態機。每一步呼叫核心的哪個函式、PIN 和憑證和簽章各留到什麼時候，寫在檔頭 |
| `App/CardProofModel.swift`、`App/Screen.swift`、`App/Screens.swift` | 畫面看到的過卡：`Screen` 是一個畫面上從上到下的每一句話和每一個按鈕，`Screens` 決定 `design/copy/card-proof.md` 的哪一句放在哪裡，`CardProofModel` 做按鈕要做的事 |
| `App/CardProofView.swift` | 把 `Screen` 畫出來（SwiftUI，`ScreenView`），長得和 `design/screens/` 的 `card-proof-app-*` 一樣。它自己沒有任何句子，也不做任何判斷 |
| `App/Theme.swift` | 畫面用的數值：`design/tokens.json` 裡 app 用到的那幾個，有 `-phone` 的用 `-phone` 的值。標題用包進 app 的源流明體 TW（執行時向系統登記，不列在 `Info.plist`）；其他的字用系統的字型 |
| `App/TeachingAnimation.swift` | 兩段示範的算法（`design/motion/README.md`）：給時間表、平台和秒數，算出那一刻的狀態（掛上去：鏡頭在哪兩個取景之間、哪些框被框起來、哪一顆被按著和紅圈、六個畫面變化各走了幾成、現在是四步裡的哪一步；感應位置：卡片的高度、離定位多遠、看不看得見、紅圈、第幾輪、是不是停住了）。純函式：不計時、不碰畫面、不記得上一次問的是幾秒。答案對 `spec/vectors/teaching-animation.json`，和網頁、Android 的實作是同一份 |
| `App/HangDemoView.swift` | 把那個狀態畫出來：五個示意畫面（第一個是 app 第 6 步自己的畫面，後四個照 `design/copy/hang.md` 的示意圖），每個有名字的框回報自己排在哪裡，鏡頭照時間表的取景對著那些位置算，這個檔裡沒有寫死的座標。帳號和網址放不下時在尾端截掉，不換行。畫面上的字都從 `card-proof.json` 讀（`Screens.hangDemo`） |
| `App/SenseDemoView.swift` | 第 2 步的示範：手機正面朝著持卡人、不動，紅色的卡片從右邊滑到手機後面的上方，被手機擋住的部分是紅色的虛線，感應到的那一刻一個紅圈。手機和卡片照實際大小的比例畫（iPhone 約 71.5 × 147 mm，卡片 85.6 × 54 mm），所以卡片比手機寬、兩邊露出來。不畫手，不轉手機 |
| `App/Mark.swift` | 記號：斜放的卡片和從後面站起來的島，和 `web/src/ui/logo.ts` 同一張圖、同一份輪廓 |
| `App/SplashView.swift` | 啟動畫面：記號和「島民證明 │ iamreal.tw」（`design/copy/app.json`）。打開 app 時顯示一秒，同時向後台拿 `config`。系統自己的啟動畫面沒有改（它只能放圖片和底色，改它要動專案檔） |
| `App/Copy.swift`、`App/Platforms.swift` | 句子從 `design/copy/card-proof.json` 讀，不屬於過卡的從 `design/copy/app.json` 讀（兩個檔都原樣包進 app）；Threads 的名稱、`@`、怎麼整理輸入的帳號、個人檔案的網址寫死在 app |
| `App/CRLNumbers.swift` | 每一把發證金鑰用過的最高清冊編號。公開的數字；過卡之後 app 留下來的，除了它只有提醒的四樣和過卡裝置編號 |
| `App/Counts.swift` | 計數：過卡裝置編號（換的規則在核心）、一次過卡的嘗試、`CardProofFlow.Stop` 對到表上的原因（見「PIN、憑證、簽章在哪裡」的計數那一點） |
| `App/Reminder.swift` | 過卡提醒：下次提醒的日子怎麼算（間隔是整數週，落在同一個星期幾；選日期；一週後再提醒；每次過卡完成重排），和手機上存的四樣（開關、間隔、時刻、下次提醒的日子，存在偏好設定，關掉就一起刪掉；ADR-0016「app 在手機上留下什麼」） |
| `App/ReminderScreens.swift`、`App/ReminderPages.swift`、`App/ReminderViews.swift` | 提醒的畫面：日子和時刻的寫法、選間隔和時刻、設定、從通知點進來的第 1 步上面那一段（句子從 `design/copy/app.json` 讀；過卡第 7 步在 `Screens.swift`，句子在 `card-proof.json`）；兩個畫面的按鈕要做的事；系統的通知（`UNUserNotificationCenter`，通知上有「一週後再提醒我」）。通知的權限在持卡人於選間隔和時刻那一頁按「開啟提醒」時才要（第 7 步的「設定提醒」和設定頁的開關都先到那一頁）；系統不允許時什麼都不存，留在那一頁說明，過卡照常完成。點通知打開第 1 步；正在過卡（第 2 到 5 步，可能有 PIN 在記憶體裡）時不丟掉，第 1 步上面那一段等回到第 1 步才出現，過完卡就不再出現。app 開著的時候通知照樣跳出來 |
| `App/AppEnvironment.swift` | 這個 build 連哪個網站、簽哪一份證明紀錄的場合字串，是三種 app 的哪一種，正式 app 在 App Store 的頁面。建置時寫死 |
| `App/BundledFile.swift` | 包進 app 的檔案 |
| `App/IamrealApp.swift` | app 的進入點：用上面那些組出這個 build 的過卡 |
| `App/Bridge.h` | Swift 看得到的 C：只有 `device-core/include/iamreal_device_core.h` |
| `App/Assets.xcassets` | app 的圖示：記號放在白底上（[#490](https://github.com/iamreal-tw/iamreal/issues/490)），和 Android 的相同。1024×1024、沒有透明度（App Store Connect 不收有透明度的圖示，也不收沒有圖示的 build），由 `android/test/AppIcon.java` 照 Android 的圖示畫出來（`android/README.md`「圖示」），不要手改 |
| `Config/Shared.xcconfig`、`Config/Test.xcconfig` | 最低的 iOS 版本、只做 iPhone、連結哪一份核心；三種 app 的識別碼和測試網站的環境 |
| `Config/Info.plist`、`Config/IamrealApp.entitlements`、`Config/IamrealAppDev.entitlements` | 讀卡要的宣告（「讀卡的宣告」）和 app 網域（「app 網域」）。`Info.plist` 的其他項目照專案檔的設定產生，和這個檔合在一起；entitlement 檔正式 app 和測試 app 用第一個，開發用 build 用第二個 |
| `IamrealApp.xcodeproj` | 手寫的 Xcode 專案，兩個 target：`IamrealApp`、`IamrealAppTests`。`App/`、`Tests/` 是跟著資料夾走的群組，加檔案不用改專案檔 |
| `build-core.sh` | 編 `device-core/` 給 iOS 用，並下載、核對 Barretenberg 的靜態函式庫和參數檔 |
| `check-app.sh`、`check-app-test.sh` | 建置時的檢查，和它自己的測試 |
| `archive.sh`、`check-archive.sh`、`check-archive-test.sh`、`ExportOptions.plist` | 上傳到 TestFlight 的 archive、對它的檢查和檢查的測試、簽章和上傳的設定（「上傳到 TestFlight」） |
| `Tests/` | 在模擬器上跑的測試，包含假卡片（`Tests/FakeCard.swift`） |

### PIN、憑證、簽章在哪裡

要檢查它們有沒有離開手機，看這幾個檔就夠：

- **PIN**：從畫面的欄位（`CardProofView` 的 `SecureField`，值在 `CardProofModel.pinText`）進 `PIN`，按下「確認卡片」時欄位清空。`PIN` 交給 `CardProofFlow`，留到第三次感應送給卡片為止，最長 5 分鐘（#133）；完成、取消、停下來、卡片回 PIN 不正確、安全通道建立不起來、送 PIN 時卡片離開而卡片還沒有接受過這個 PIN、滿 5 分鐘時蓋成零。感應沒有做完而 PIN 可以再用時（卡片離開、沒有感應到、換了卡、在面板上按取消），第二次感應的 PIN 留在 `CardProofModel.pin` 等「再感應一次」，第三次的留在 `CardProofFlow`；這時輸入新的 PIN，舊的先蓋成零。5 分鐘從 PIN 的第一個字進到欄位算起（`CardProofModel` 的 `startPINClock`），照手機的時鐘；時鐘被往回調到那之前也算到期。到期時感應或請求正在做的話等它結束；第三次感應前等伺服器回題目之後再查一次，過了就不送。面板等卡片最多 60 秒，這段不算在內。唯一收 PIN 的對外介面是 `CardConnection.sign`：`GpkiCard.sign` 把它補成 VERIFY 的資料（`CardChannel.pinBlock`），只在安全通道建立之後、加密著送給卡片；安全通道建立不起來（`CardFailure.channel`）、是第一代的卡片（`CardFailure.firstGeneration`）時不送。PIN 的長度或字元沒有卡片收（6 到 10 個可列印的 ASCII 字元以外，`CardChannel.cardTakes`）時，按「確認卡片」不出現面板，PIN 丟掉，請持卡人再輸入一次。`Backend`、`DeviceCore` 沒有任何函式收 PIN
- **第二、第三次感應**：`CardProofFlow.signTap` 先再讀一次憑證，第一次感應選定的那一張要在裡面，才把 PIN 交給卡片；不在就是 `CardFailure.otherCard`，PIN 沒有送
- **憑證和簽章**：選定的憑證和第一個簽章留在 `CardProofFlow`，證明算完就蓋成零；核心自己的那一份跟著 session 蓋掉
- **姓名**：核心檢查憑證後回傳，只交給「輸入 PIN」的畫面
- **憑證的到期日**：第 7 步要比憑證的到期日和下次提醒的日子（到期日比較早就多一句），所以 `CardProofFlow` 把選定的憑證的 `not_after` 交給送出之後的畫面（`CardProofFlow.Done.notAfter`），只在記憶體裡，回到開頭就丟；不存進手機，通知不提
- **不寫磁碟**：過卡做到一半的狀態只在 `CardProofModel` 和 `CardProofFlow` 的記憶體裡，沒有用系統保存畫面狀態的任何機制，app 被系統結束就從第 1 步來。`Tests/BuildTests.swift` 檢查 `App/` 的原始碼沒有寫檔、偏好設定、鑰匙圈、狀態保存的呼叫，例外只有 `CRLNumbers.swift` 的清冊編號、`Reminder.swift` 的提醒的四樣、`Counts.swift` 的過卡裝置編號，和持卡人按「複製連結」時的剪貼簿
- **計數**（`App/Counts.swift`，`spec/counts.md`；ADR-0032、ADR-0039，#434）：過卡到了表上的哪一步、停下來或要再試一次的原因代碼、感應中途卡片離開（第幾次感應）、送出被擋後再送同一筆、下載清冊、建樹、算證明花了多久的分級（時鐘往回調時不送）。一筆一個請求（`Backend.count`），不等回應、送不出去不重送，過卡照常。每一筆帶 `client`（`ios`）、嘗試編號（一次過卡一個，只在記憶體裡）、過卡裝置編號（`UserDefaults`，台灣的日期起算 31 天後換新的，舊的不留，規則在核心的 `idc_count_device_id`）、系統版本（`UIDevice.current.systemVersion`）、app 版本（`CFBundleShortVersionString`）、手機型號（`utsname` 的 machine，例如 `iPhone15,2`；不是 `UIDevice.name` 那個持卡人取的名字）；版本和型號不合格式的整個不送。內文由核心照步驟表組（`idc_count`）。原因是 `Counts.reason(of:)` 從 `CardProofFlow.Stop` 選的，不帶任何文字、帳號、匿名編號、卡片上的值。`CardProofFlow` 停下來（`fail`）的送 stop、讓那一步再做一次的送 retry；設定、最低版本、開始時被擋這幾種在建立流程之前，由 `CardProofModel` 送；`open` 在第 1 步出現時送。持卡人取消、呼叫的順序不對被拒絕都不送。送出一筆的內文最前面加上過卡裝置編號（`CardProofFlow.withDeviceID`）。不用 IDFA、`identifierForVendor`、推播權杖，不連結 `AdSupport`，沒有第三方的分析（#94）

已知的限制：`SecureField` 交出來的是 Swift 的 `String`，欄位清空之後它在記憶體裡的那一份 app 蓋不到；`PIN` 自己的位元組會蓋成零。

### 還沒有的

- 在面板上按「取消」和卡片中途離開，系統告訴 app 的先後沒有文件：卡片接上之後按「取消」，系統讓指令失敗比告訴 app「取消了」早到時，app 會當成卡片中途離開（畫面寫再感應一次），不是取消。要真手機才看得出來
- 第一代的卡片：`GpkiCard` 認得出來（選不到第二代的應用程式、選得到主檔案），但只有在卡片有 `Config/Info.plist` 那三個應用程式之一時，系統才會把卡片交給 app。第一代的卡片有沒有，手上沒有卡片能試；沒有的話持卡人看到的是面板一直等、最後「沒有感應到卡片」
- 送不出去之後的再送：後台沒有回應、或說人太多（`429`、`503` `busy`）時同一筆可以再送一次；網頁版在後台回其他 5xx 時也可以再送，再送被回「題目用過了」時會查現況確認那一筆是不是已經記下，這裡還沒有
- 文字沒有對應句子的兩種情況，畫面只顯示代碼，和網頁版相同（`web/src/ui/messages.ts`）：核心回了 app 不認得的憑證原因代碼、app 自己把步驟的順序叫錯（`state`）。兩種都是程式的錯，不是持卡人會遇到的情況；要不要有一句話留給 #172
- 清冊的索引或檔案下載不到時，畫面一律寫「現在拿不到可用的內政部廢止清冊……（代碼 `crl_unavailable`）」，不分是連不上還是 HTTP 的錯誤：`spec/device-checks.md` 把兩種都歸在 `crl_unavailable`，網頁版也一樣
- `design/copy/card-proof.md` 標了「app 的寫法還沒有定」的句子，先用網頁的那一句：讀卡時的其他錯誤、讀到兩張都通過檢查的憑證、檔案的內容和預期的不同、算不出證明、後台列了而 app 不認得的平台那一列、第 6 步讀不出後台回報每個帳號記成什麼時的那一句；要「再讀一次卡片」的地方，按鈕先用「再感應一次卡片」

主畫面上 app 的名稱，正式 app 是「島民證明 封測」，測試 app 是「島民證明 測試」，開發用 build 是「島民證明 dev」（`design/copy/app.md`，第一版，Android 相同）；正式的名稱在商店頁的那張票定（[#154](https://github.com/iamreal-tw/iamreal/issues/154)）。每個畫面最上面有「測試的證明紀錄」的標示（`design/copy/test-site.md`）。

## 環境在建置時寫死

iPhone 有三種 app（ADR-0040），識別碼不同，可以同時裝在一支 iPhone 上。專案的三個組態各做一種：

| | 正式 app | 測試 app | 開發用 build |
|---|---|---|---|
| 組態 | Release | TestApp | Debug |
| 識別碼 | `tw.iamreal.app` | `tw.iamreal.app.test` | `tw.iamreal.app.dev` |
| 圖示下面的名稱（`design/copy/app.md`） | 島民證明 封測 | 島民證明 測試 | 島民證明 dev |
| 連哪裡 | 上線前：`https://test.iamreal.tw`、`https://test-data.iamreal.tw`（ADR-0028）。上線起：正式網站 | 測試網站，上線後也是 | 測試網站，上線後也是 |
| app 網域（「app 網域」） | 上線前：`test-app.iamreal.tw`。上線起：`app.iamreal.tw` | `test-app.iamreal.tw`，上線後也是 | 沒有 |
| 卡片簽的場合字串 | 上線前：`iamreal-test:public:0`（核心的 `IDC_PROOF_LOG_TEST`） | `iamreal-test:public:0`，上線後也是 | `iamreal-test:public:0`，上線後也是 |
| build 號碼 | 1 到 999,999：`upload-ios.yml` 的執行編號 | 1,000,000 到 1,999,999：`upload-ios-test.yml` 的執行編號加 1,000,000 | 固定 2,000,000 |
| 怎麼裝 | TestFlight，上線起也從 App Store（從 GitHub Actions 上傳：「上傳到 TestFlight」） | TestFlight，永遠不上 App Store；上線前只給營運者（ADR-0040） | 用線裝（「怎麼用線裝到手機」） |
| 「到 App Store 更新」的按鈕 | 有 | 沒有 | 沒有 |

三個組態都以 `Config/Test.xcconfig` 為底：這個檔照組態定識別碼，並定一個編譯條件 `IAMREAL_ENV_TEST`；`App/AppEnvironment.swift` 照編譯條件給網址和哪一份證明紀錄，沒有條件就編不過。是哪一種 app 也由編譯條件定：Debug 有 `DEBUG`，TestApp 有 `IAMREAL_TEST_APP`（`AppEnvironment.app`）。名稱和專案檔裡的 build 號碼照組態寫在專案檔（`INFOPLIST_KEY_CFBundleDisplayName`、`CURRENT_PROJECT_VERSION`）。app 裡沒有切換環境的設定，後台也不能叫 app 換環境。上線那天用一個 PR 讓 Release 改用正式網站的設定檔；TestApp 和 Debug 留在 `Config/Test.xcconfig`，那個 PR 不碰它們。正式網站的設定現在還沒有。

## 最低的 iOS 版本：15.0；只做 iPhone

最低版本取兩個要求裡較高的（[#98](https://github.com/iamreal-tw/iamreal/issues/98) 第 3 點），不往上加：

- **Barretenberg 預先編好的 iOS 函式庫：15.0。** 讀它的 `LC_BUILD_VERSION`：

  ```
  xcrun otool -l "$(../device-core/fetch-barretenberg.sh arm64-ios)/libbb-external.a" | grep -A4 LC_BUILD_VERSION | grep minos | sort -u
  ```

  2026-11-20 讀 `v6.0.0` 的 `arm64-ios` 和 `arm64-ios-sim`，每一個目的檔都是 `minos 15.0`。
- **用 NFC 讀 ISO 7816 的卡片：13.0**（[#85](https://github.com/iamreal-tw/iamreal/issues/85)）。

這個數字寫在 `Config/Shared.xcconfig` 的 `IPHONEOS_DEPLOYMENT_TARGET`，`build-core.sh` 編 Rust 時讀同一行。這台開發用的電腦上只有 iOS 18.3 和 26.0 的模擬器，15.0 的手機或模擬器上還沒有跑過。

只做 iPhone：`TARGETED_DEVICE_FAMILY = 1`（沒有 iPad 的介面），也不給 Mac 和 Vision Pro 當 iPhone app 裝（`SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD`、`SUPPORTS_XR_DESIGNED_FOR_IPHONE_IPAD` 都是 `NO`）。iPad 仍然能用相容模式裝 iPhone 的 app；要讓 iPad 裝不了，`Config/Info.plist` 的 `UIRequiredDeviceCapabilities` 要求 `nfc`（#174），沒有 NFC 的 iPhone 也裝不了。模擬器只支援 Apple 晶片的 Mac：Aztec 沒有給 Intel Mac 的 iOS 模擬器用的函式庫。

## 讀卡的宣告

- `Config/IamrealApp.entitlements`（正式 app、測試 app）和 `Config/IamrealAppDev.entitlements`（開發用 build）：`com.apple.developer.nfc.readersession.formats` 只有 `TAG`（[#85](https://github.com/iamreal-tw/iamreal/issues/85)）。app 的識別碼要在開發者帳號裡開了 NFC Tag Reading，簽出來的 app 才有這一項。兩個檔只差在 app 網域（下一節）
- `Config/Info.plist`：
  - `NFCReaderUsageDescription`：`design/copy/app.md`「讀卡的用途說明（iOS）」那一句
  - `com.apple.developer.nfc.readersession.iso7816.select-identifiers`：`spec/card-channel.md` 的三個應用程式，簽章的那一個排第一。系統照這個順序 SELECT，選到一個就把卡片交給 app；app 之後用名稱 SELECT 的只能是這三個（#85）。卡片管理員的兩個在 iPhone 上選得到（[#89](https://github.com/iamreal-tw/iamreal/issues/89)）
  - `UIRequiredDeviceCapabilities`：`nfc`
- `Tests/BuildTests.swift` 對 app 的 `Info.plist` 檢查這三項。entitlement 由 `check-app.sh` 檢查：組態用的那個檔，和模擬器的 build 放在執行檔裡的那一份（`__TEXT,__entitlements`）。用線裝到手機的 build 由 Xcode 簽章時放進去；上傳的 build 見「合併後才驗得到的」

## app 網域

正式 app 和測試 app 的 entitlement 有 `com.apple.developer.associated-domains`，只有一項 `applinks:test-app.iamreal.tw`：在 iPhone 上打開測試網站的 app 網域的任何網址（Universal Links），裝了 app 就打開 app（[#527](https://github.com/iamreal-tw/iamreal/issues/527)、[#532](https://github.com/iamreal-tw/iamreal/issues/532)）。app 網域跟著 app 連的網站（ADR-0040「app 網域跟著連的網站」）：上線前兩個 app 都連測試網站，所以都認它；網站那一邊，`test-app.iamreal.tw/.well-known/apple-app-site-association` 列出這兩個 app（`worker/`）。開發用 build 不認任何 app 網域：它的 App ID 沒有開 Associated Domains，用線裝的人也不用改網站的檔。

- **app 不讀網址。** 從連結打開和從主畫面打開完全相同：`App/` 沒有任何收網址的地方（`onOpenURL`、`onContinueUserActivity`、`NSUserActivity`、app 或 scene 的 delegate），`Info.plist` 也不註冊自己的網址前綴（`CFBundleURLTypes`），`check-app.sh` 擋下這些名稱（[#92](https://github.com/iamreal-tw/iamreal/issues/92)）。所以別人的連結塞不進帳號或任何東西。app 只有一個畫面（`WindowGroup`），系統把它叫到前面：過卡做到一半時被連結打開，畫面停在原本那一步，不重來
- **檢查。** `check-app.sh` 核對專案檔給每個組態的 entitlement 檔（`CODE_SIGN_ENTITLEMENTS`；Xcode 建置時交給它的也要是那一個）和檔的內容：正式 app、測試 app 是 `Config/IamrealApp.entitlements`，有 `TAG` 和 `applinks:test-app.iamreal.tw` 這兩項、沒有別的；開發用 build 是 `Config/IamrealAppDev.entitlements`，只有 `TAG`。app 帶著 entitlement 的時候（模擬器的 build 在執行檔裡、簽過章的 app 在簽章裡）也核對 app 帶的那一份。上傳的工作流程用同一個檔簽 ad hoc 的章，簽好之後再核對一次（「上傳到 TestFlight」）
- **App ID 和描述檔。** 兩個 App ID 都開了 Associated Domains，App Store 描述檔照著重發（[#529](https://github.com/iamreal-tw/iamreal/issues/529)）。重發的兩份 App Store 描述檔，`com.apple.developer.associated-domains` 是 `*`（#529 用 `security cms -D` 看過），app 實際宣告哪個網域由 entitlement 檔決定
- **還沒在手機上確認的**（#527 的實機驗收）：相機掃 QR code、Safari 和 Threads 內建的瀏覽器裡按按鈕會不會打開 app；過卡做到一半時被連結打開是不是停在原本那一步；正式 app 和測試 app 裝在同一支 iPhone 上時開哪一個（#527 列為要實機測的）；Apple 的 CDN 抓不抓得到檔（`https://app-site-association.cdn-apple.com/a/v1/test-app.iamreal.tw`）
- **上線那天**（ADR-0040 Consequences）：正式 app 改用一個自己的 entitlement 檔，`applinks:app.iamreal.tw`，專案檔 Release 的 `CODE_SIGN_ENTITLEMENTS` 指向它，`upload-ios.yml` 簽 ad hoc 的章和核對的那兩步跟著改，`check-app.sh` 給 Release 新的網域和檔名；測試 app 和開發用 build 照舊。網站那一邊，`test-app.iamreal.tw` 的檔拿掉正式 app，`app.iamreal.tw` 的檔列正式 app

一次感應裡做的事（`App/NFCCard.swift`、`App/GpkiCard.swift`）：

| 感應 | 指令 |
|---|---|
| 第 1 次：讀憑證 | 選第二代的應用程式（選不到、選得到主檔案的是第一代的卡片，停下）；讀 DF 5030 底下的 CDF，照它寫的路徑讀每一張憑證 |
| 第 2、3 次：簽章 | 同上讀一次憑證（`CardProofFlow` 比對是不是第 1 次那張）；讀 PrKDF 找簽章的金鑰；選卡片管理員讀金鑰資訊、選安全網域讀卡片識別碼、算出這張卡片的靜態金鑰；INITIALIZE UPDATE、核對卡片的驗證碼、EXTERNAL AUTHENTICATE；之後每一道指令都在安全通道裡：VERIFY（PIN）、選金鑰檔、送要簽的區塊兩半、讀回簽章 |

卡片接上之後大約 20 秒系統就結束連線（#89），所以一次感應裡不等人、不等網路：檢查憑證、清冊、題目、算證明都在兩次感應之間。#89 量過：從卡片接上到簽完兩次是 1.6 秒。

## 包進 app 的檔案

app 算證明要的檔案都在安裝檔裡，執行時不下載（ADR-0035）：

| app 裡的檔名 | 來源 |
|---|---|
| `card_proof_rs2048.json`、`card_proof_rs4096.json` | `web/circuits/`（版控裡的檔，和網頁版同一份） |
| `card_proof_rs2048.vk`、`card_proof_rs4096.vk` | `verifier/vk/`（後台和重驗的人用的那兩把） |
| `bn254_g1_compressed_2p18.dat`、`bn254_g2.dat` | 參數檔。`device-core/fetch-crs.sh` 下載，核對 `device-core/crs.sha256`，和網頁版的 `web/scripts/fetch-crs.mjs` 是同樣的兩個檔 |
| `card-proof.json` | `design/copy/card-proof.json`：畫面上的每一句話 |
| `app.json` | `design/copy/app.json`：只在 app 上、不屬於過卡的字 |
| `GenRyuMin2TW-B.otf` | `design/fonts/GenRyuMin2TW-B.otf`：標題用的源流明體 TW 的子集 |
| `hang.json` | `design/motion/hang.json`：第 6 步示範的時間表，和網頁、Android 讀的是同一個檔，app 沒有另外抄一份 |
| `sense.json` | `design/motion/sense.json`：第 2 步示範的時間表（app 用其中 iPhone 的那一組） |
| `PrivacyInfo.xcprivacy` | `App/PrivacyInfo.xcprivacy`：privacy manifest（下面「privacy manifest」） |

Xcode 專案直接引用這些位置，不另存一份。核心在用之前還會自己核對電路檔、驗證金鑰、參數檔的 SHA-256（`idc_session_check_artifacts`，算證明時再核對一次）。

## 怎麼單獨建置和測試

需要 Apple 晶片的 Mac、Xcode 27.2、rustup、`curl`。不需要手機、卡片、後台、Node、Go。

```
cd ios
(cd ../device-core && rustup target add aarch64-apple-ios-sim)   # 第一次；在 device-core/ 裡跑，裝到 rust-toolchain.toml 的那一版
./build-core.sh simulator
xcodebuild test -project IamrealApp.xcodeproj -scheme IamrealApp \
  -destination "platform=iOS Simulator,name=iPhone 17" -derivedDataPath build
./check-app-test.sh build/Build/Products/Debug-iphonesimulator/IamrealApp.app
```

- `build-core.sh simulator` 編兩份函式庫：app 的，和測試用的（見下面「模擬器的函式庫認測試金鑰」）；`build-core.sh device` 只編 app 的
- `build-core.sh` 先下載 Barretenberg 的靜態函式庫（`device-core/fetch-barretenberg.sh`）和參數檔（`device-core/fetch-crs.sh`），兩者都核對 SHA-256 才用，再用 `cargo build --locked --release` 編出 `device-core/target/<target>/release/libiamreal_device_core.a`。Xcode 專案連結的就是那個位置的檔，所以改了 `device-core/` 要重跑它。它不放進 Xcode 的建置階段：下載不該發生在 Xcode 的建置裡，Xcode 給建置階段的環境變數（`SDKROOT` 等）也是給 iOS 的，不是給 cargo 在 Mac 上跑的建置腳本的。
- `xcodebuild test` 建置 app、跑 `check-app.sh`、在模擬器上跑 `Tests/`。
- 拉取請求的檢查（`.github/workflows/checks-ios.yml`）跑的就是上面的指令（它先 `rustup toolchain install` 裝 `rust-toolchain.toml` 的那一版），再用 `-configuration Release build` 建一次，最後照上傳的做法做一次給手機的 archive、跑 `check-archive-test.sh`（「上傳到 TestFlight」），只在改到 `ios/`、`device-core/`、它讀的檔（`.github/README.md` 列出來）或那個工作流程檔時跑。runner、Xcode、模擬器的來源在 `.github/README.md`。

要在模擬器上看畫面：用 Xcode 打開 `IamrealApp.xcodeproj` 按執行，或 `xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/IamrealApp.app` 再 `xcrun simctl launch booted tw.iamreal.app.dev`。

### 用假卡片過卡

上面的 `xcodebuild test` 沒有後台，`Tests/CardProofTests.swift` 會跳過。要跑它，由 `web/test/app-backend.ts` 起本機的 Worker 再跑同一道指令（另外需要 Node、pnpm、Go 和 `bb` 6.0.0；在程式庫根目錄先 `pnpm install --frozen-lockfile`）：

```
cd web
IAMREAL_BB=<bb 的路徑> node --experimental-strip-types test/app-backend.ts first,refresh,switch,withdraw -- \
  xcodebuild test -project ../ios/IamrealApp.xcodeproj -scheme IamrealApp \
  -destination "platform=iOS Simulator,name=iPhone 17" -derivedDataPath ../ios/build
```

那個腳本做的事：產生測試的發證金鑰和一張假卡片，起 Worker 的測試建置（`worker/test/harness.ts`）和假的內政部，鏡像清冊，把位址、假卡片的憑證和金鑰寫到 `web/test-output/app/backend.json`，跑後面的指令；指令成功之後讓 Worker 公布證明紀錄，用 Go 的 `iamreal-verify`（`-tags iamrealtest`，原生的 `bb` 重驗每一份證明）重驗，並比對證明紀錄裡每一筆在 Threads 的種類是第一個參數寫的那四種。

測試從畫面那一層操作（按畫面上有的按鈕、在欄位打字），「卡片」換成 `Tests/FakeCard.swift`，「後台」是真的 `HTTPBackend` 連本機的 Worker，核心、證明都是真的：

- 同一張卡片新宣告、再次過卡、隔天更換、收回各一次，每個畫面上的每一句話和預期的逐句相同，而且每一句都在 `design/copy/card-proof.md` 裡。第 4 步走的是畫面上的那幾個按鈕：新宣告填欄位，再次過卡按「更新島民證明」，更換按「改成別的帳號」再填，收回按「收回對 @bob 的宣告」；欄位空著按「下一步」不往下，「改成別的帳號」的「上一步」和第 5 步的「上一步」回到按下之前的那個畫面
- 第 1 步「找附近的戶政事務所」和內政部憑證管理中心的連結交給系統開的網址
- 第一次感應不送 PIN；第二、第三次感應換成另一張卡時，那張卡沒有收到 PIN，畫面請持卡人換回來，再感應一次就接著做
- 完成、取消、PIN 不正確之後，記憶體裡沒有 PIN
- app 一打開（畫面第一次畫出來）就向後台拿 `config`，第 1 步每次打開和回到 app 時再拿一次；按「下一步」時拿一次帶開始記號的（`config?start`），接著讀卡時再拿一次不帶記號的
- 停止收過卡（[#394](https://github.com/iamreal-tw/iamreal/issues/394)、[#402](https://github.com/iamreal-tw/iamreal/issues/402)），在新宣告之前：`app-backend.ts` 的 `PUT /__app-test/paused` 切換後台的 `CARD_PROOFS_PAUSED`（`TestBackend.setPaused`）。停止時打開，第 1 步是 `before.paused` 那一句、沒有「下一步」；恢復後回到 app，「下一步」回來了。走到第 5 步才停止：拿題目回 `paused`（卡片沒有被要求簽章），和送出之前才停止（`CountingBackend.beforeSubmit`）而送出回 `paused`，兩次都停在那一項，寫 `stops.paused` 和請求編號，只有「回到開頭」，回到的第 1 步寫停止的那一句。恢復之後的新宣告就是「恢復之後走得完」，所以證明紀錄還是那四筆
- 人太多（ADR-0026，[#420](https://github.com/iamreal-tw/iamreal/issues/420)），在再次過卡的那一次：`CountingBackend.turnAway` 把指定的請求照後台被擋時的樣子回（`429` `rate_limited` 或 `503` `busy`），不送到 Worker。回到 app 時第 1 步問的 `config` 被擋：第 1 步照常有「下一步」。按「下一步」時的 `config?start` 被擋（`503`、`429` 各一次）：停在第 1 步，`before.busy` 在「下一步」正上方，卡片沒有被感應。讀卡時不帶記號的 `config` 被擋：照樣讀卡。卡片簽完後查現況被擋：`stops.too_many`，按鈕是「上一步」「再試一次」，按「再試一次」直接到第 4 步，卡片沒有再感應、沒有再收到 PIN。拿題目被擋、送出被擋：停在那一項，`stops.too_many`，按鈕是「再試一次」和「取消」；拿題目的「再試一次」之後卡片簽一次，送出的「再試一次」不再感應。每一個畫面的每一句都在 `card-proof.md` 裡，截圖是 `screens-ios/` 的 `1-busy`、`3-busy`、`5-busy`、`5-busy-submit`
- 手機的日期和後台差一天時，停在第三次感應之前，卡片沒有被要求簽第二次
- 第 6 步複製的連結、「打開你的島民證明」開的網址（Worker 上那一頁真的列出帳號）、「打開 @alice 的 Threads 個人檔案」開的網址；第 8 步「分享到 Threads」打開的 Threads web intent 預填的文字，和旁邊分享符號的小按鈕交給分享面板的文字（同一段：帶順序號碼的那一句，號碼和 Worker 上那一頁寫的相同，下一行是這張島民證明的網址）
- 送出之後的三步：新宣告走完整的第 6 步（兩顆按鈕並排；示範給報讀器的說明和按鈕的字照 `design/copy/`，按「停止播放」後變成「再看一次」，再按又是「停止播放」）；第 7 步的「設定提醒」打開選間隔和時刻（系統在那裡才問，見 `ReminderTests`），在那裡存好之後第 7 步寫排好的日子、等「下一步」；再次過卡的第 6 步是短版，「重新掛上連結」換成完整的，完整的那一頁按「上一步」回到短版，提醒已經開著時第 7 步只有「下一步」；更換之後按「這次不要」不向系統要權限、什麼都不存；收回從第 5 步直接到第 8 步。第 7、8 步的「上一步」不碰卡片。四種最後一步的標題各不相同
- 今天已經過卡 3 次：`CountingBackend.cardStateAnswer` 把 `card-state` 的回答換成今天已經 3 筆（四種紀錄要照順序留在證明紀錄裡，這裡不真的多過三次卡）。到第 4 步時記憶體裡沒有 PIN；「打開你的島民證明」開這張卡片的頁面；「重新掛上連結」是完整的第 6 步、不在八步裡、沒有記進證明紀錄那一行，複製的連結、打開的個人檔案、示範照第 6 步；「上一步」回到第 4 步，「回到開頭」回到第 1 步；卡片沒有再簽章、沒有拿題目、沒有送出；那一頁拍成 `4-daily-limit-hang.png`
- 每個畫面的截圖寫到 `web/test-output/app/screens-ios/`

`ios/` 不引用 `worker/`：和那個腳本之間只有 `backend.json` 和 HTTP。拉取請求的檢查（`.github/workflows/checks-ios.yml`）沒有跑這一段。

### 模擬器的函式庫認測試金鑰

假卡片的憑證是測試金鑰簽的，app 的 session（`idc_session_open`）只認內政部的金鑰，第一步就不收。所以 `build-core.sh simulator` 多編一份測試用的函式庫：`device-core/` 開了 cargo feature `test-issuers`，多一個函式 `idc_testing_session_open`，開一個改認呼叫的人給的發證金鑰的 session。這個 feature 只多這一個函式；核心自己的測試用的 `testing`（會把 Poseidon2、建樹開出來）這裡不開。那一份編在自己的目錄 `device-core/target/test-issuers/`。

- 只有模擬器的 Debug 組態連結它（`Config/Shared.xcconfig`），也就是 `xcodebuild test` 跑的那一種
- 只有 `Tests/` 看得到那個函式（`Tests/Bridge.h`），`App/` 的橋接檔沒有它的宣告
- 模擬器的 Release、給手機的 Debug 和 Release 連結的都是沒有開 feature 的那一份。`check-app.sh` 擋下這幾種 app 裡出現這個函式的名稱或那個函式庫的記號；`check-app-test.sh` 有這兩案。拉取請求的檢查會建一次模擬器的 Release 和一次給手機的 archive，上傳的 build 都是給手機的 Release

### 測試讀什麼

測試在模擬器裡跑，直接讀這個程式庫在 Mac 上的檔案（模擬器看得到 Mac 的磁碟），不複製。

- `Tests/DeviceCoreTests.swift`：從 Swift 呼叫核心，對 `spec/vectors/scope.json`（兩份證明紀錄的場合字串）和 `spec/vectors/min-app.json` 裡 iOS 的每一案（最低版本的四種結果）；連結進來的函式庫的版本等於標頭檔的；Barretenberg 有回應
- `Tests/BuildTests.swift`：包進去的 `hang.json`、`sense.json` 和 `design/motion/` 的逐位元組相同；這個 build 是開發用 build（識別碼、網址、場合字串；測試跑在 Debug；Release 和 TestApp 的識別碼、名稱、build 號碼、網址由 `check-app.sh` 看）、測試 app 的組態以 `Config/Test.xcconfig` 為底、編譯條件是測試的環境（所以簽的是上面那一支的場合字串，上線後也是）、App Store 的頁面是正式 app 的而且只有正式 app 會開、只給 iPhone、內建的檔案都在而且就是上表的來源、參數檔的雜湊和網頁版下載時核對的相同、「測試的證明紀錄」的標示和 app 的名稱在 `design/copy/`、包進去的 `card-proof.json`、`app.json`、字型和程式庫裡的逐位元組相同；`App/` 的原始碼用到的每一句都在 `design/copy/card-proof.json` 或 `app.json`、`app.json` 的每一句都用到了（主畫面上的名稱和 Android 的通知類別除外）、自己沒有寫任何中文的句子；`App/` 的原始碼不寫磁碟（清冊編號和提醒的四樣除外）
- `Tests/ReminderTests.swift`：下次提醒的日子（一個月、三個月、六個月、跨月跨年、同一個星期幾、選日期只管這一次、能選的日子、一週後再提醒、每次過卡重排）和手機上存的東西，不靠系統真的發通知（換成記下被叫做什麼的假通知）；關掉提醒後，偏好設定裡沒有留下任何一樣；系統不允許通知時什麼都不存
- `Tests/CardProofTests.swift`：用假卡片過卡（上面那一節）；中斷和錯誤的每一種（上面那張表）：三次感應各自的卡片離開、沒有感應到、按了取消，送 PIN 時離開不自動重送，5 分鐘前後、過了 5 分鐘按下確認也不簽、最後一次感應之後不受影響，最低版本的四種結果、沒有 NFC
- `Tests/CardChannelTests.swift`：安全通道對 `spec/vectors/card-channel.json` 的每一案：靜態金鑰、卡片識別碼、金鑰資訊、卡片的挑戰、安全通道的金鑰和 EXTERNAL AUTHENTICATE、一連串指令的加密、MAC 和計數器（沒有資料的指令也加一）、PIN 的區塊、要簽的區塊
- `Tests/NFCCardTests.swift`：`NFCCard` 怎麼收起系統的面板，面板換成記下被叫做什麼的假面板、卡片是模擬的第二代卡片：讀到、簽好時不帶錯誤訊息，面板寫可以拿開卡片；卡片接上之後每一種停下來的原因（PIN 不正確、鎖卡、安全通道、第一代、不是同一張、中途離開、其他錯誤）和 Core NFC 回報的中斷，都帶「沒有完成，請看 app 畫面上的說明。」收一次，面板上的每一句從 `card-proof.json` 讀，那一句在 `card-proof.md` 裡；在面板上按「取消」（PIN 送出之前或之後）、等不到卡片、手機不能讀卡時 app 不再收面板
- `Tests/GpkiCardTests.swift`：`GpkiCard` 對一張模擬的第二代卡片（`Tests/SimulatedGpkiCard.swift`：照卡片的做法解密、檢查 MAC 和它自己的計數器，有 PIN 的錯誤次數和簽章的金鑰）：讀憑證不用 PIN、不建安全通道；簽章用簽章的那一把；PIN 錯兩次是 PIN 不正確、第三次鎖卡；卡片收不了的 PIN 不送；卡片的驗證碼不對、金鑰不是 16 個位元組時不送 PIN；第一代的卡片什麼都不讀、不送 PIN；卡片中途離開時知道 PIN 送出了沒有
- `Tests/TeachingAnimationTests.swift`：示範的算法對 `spec/vectors/teaching-animation.json` 掛上去和感應位置的每一案（兩個平台都有），時間表讀 `design/motion/hang.json`、`sense.json`：數字差在檔案寫的 `tolerance` 以內，其餘逐字相同；時間表沒有的平台不收；任何一刻的狀態和先前問過哪一刻無關；iPhone 的感應位置三輪後停住，卡片留在手機背面的上方、沒有紅圈
- `Tests/ThemeTests.swift`：`App/Theme.swift` 的每一個數值和 `design/tokens.json` 同名的那一個相同；標題的字型是 `--font-display` 的第一個，而且就是包進 app 的那一份
- `Tests/ScreensTests.swift`：不用後台，拿 `design/copy/card-proof.md` 的例子（`@alice`、`7K2Q9FM4XD`、2026-11-16、王小明）做出第一次宣告的每一個畫面，和已經宣告 `@alice` 的卡片的第 4、5 步（目前宣告的帳號、改成別的帳號、再次過卡、更換、收回的確認）：每一句都在文字檔裡、沒有「了解更多」；第 2 步按「感應卡片」之前按鈕在示範下面、清單在按鈕下面，停下或讀完之後清單在上；兩顆按鈕在半寬放得下一行時並排、往下走的在右，放不下或三顆時上下排（`SideBySide`）；第 1 步、第 3 步、第 4 步的每一種（沒有宣告、全部收回過、已經有宣告、改成別的帳號和它依次數換掉的那一句、不能再更換、今天已經過卡 3 次和它的「重新掛上連結」、沒有可以掛的帳號時只有「回到開頭」、卡片在 app 不認得的平台上有帳號）、第 5 步的每一種逐句照文字檔；選間隔和時刻、設定、從通知點進來的第 1 步，每一句照 `design/copy/app.md`；系統不允許通知時選間隔的畫面留著並說為什麼；設定打開的網址；照 app 畫的樣子拍成 390 點寬的整頁截圖，連同啟動畫面和提醒的畫面寫到 `web/test-output/app/screens-ios/`，檔名就是 `design/screens/` 裡對應的那一張（下面「截圖」）
- `Tests/PausedTests.swift`：停止收過卡（#394），對著假後台（`config` 說不說 `paused`，`challenges`、`records` 回 `paused`）：第 1 步在「下一步」的位置寫 `before.paused`，回到 app 時再問一次；`config` 在第 2 步才說的，讀卡之前停下；第 5 步 `stops.paused` 只給「回到開頭」，不給「再試一次」；說了 `paused` 的 config 下一次過卡開始時再問；第 1 步每次打開（和回到 app 時）都再問一次 `config`，用來在讀卡之前說停止收過卡
- `Tests/CountsTests.swift`：不用後台。過卡裝置編號在台灣的日期滿 31 天才換、讀不懂的值換掉；一筆計數帶什麼不帶什麼、版本和型號不合格式的拿掉；每一步只送一次、停下來之後不再送、伺服器的代碼表上沒有的送 `server_other`；`CardProofFlow.Stop` 的每一種都有表上的原因（核心組得出 iOS 的內文才算）；送出的內文帶過卡裝置編號；手機型號是系統的代碼。`Tests/CardProofTests.swift` 用假卡片過完四次卡之後，核對這幾次送出的每一筆計數：都是 iOS 的、只有表上的欄位、沒有帳號和 PIN；過完卡的四次各送了每一步一次和三個計時、沒有 stop；停止收過卡送了 `server_paused`、換卡送了 `other_card`；每一次送出都帶著計數的過卡裝置編號。計數也照樣送到本機的 Worker
- `Tests/BusyTests.swift`：人太多（ADR-0026，#420），不用後台：按「下一步」時送的是 `GET /api/v1/config?start`，其他時候不帶記號；`429`、`503` `busy` 算人太多，`503` 別的代碼不算（對著本機的假後台，`NWListener`）。開始的那一次被擋時停在第 1 步，`before.busy` 在「下一步」正上方，卡片沒有被感應；讀卡時不帶記號的 `config` 被擋時用按「下一步」時拿到的那一份，照樣去感應卡片；開始的那一次沒有回答時沒有可以用的，停在讀卡之前寫 `stops.too_many`。第 3 步查現況被擋時寫 `stops.too_many`，按鈕是「上一步」「再試一次」；第 5 步拿題目、送出被擋時停在那一項，寫 `stops.too_many`（送出被擋不是「送出失敗」那一句），按鈕是「再試一次」和「取消」
- `Tests/SubmitAnswerTests.swift`：對著本機只答一次的假後台（Network 框架的 `NWListener`）送出：201 的內文中途斷線或超過 1 MiB 時，`HTTPBackend.submit` 給沒有位元組、不是 `network`，交給核心讀是「什麼都沒說」（完成畫面只說記下了，#264）；剛好 1 MiB 照收、`503` 照舊是那個代碼
- `Tests/ChallengeAgainTests.swift`：對著本機一個照順序回應的假後台（`NWListener`）拿題目（#404）：第一次讀完請求就關連線、第二次才回 → 拿到題目，送了兩次；兩次都不回 → `network`，只送兩次；有回應（429）或回應的內文中途斷掉 → 不重送；等回應的工作被取消 → 不重送；`records`、`card-state` 沒有回應時只送一次
- `Tests/UserAgentTests.swift`：對著本機記下每個請求標頭的假後台，把 `Backend` 的六種請求各送一次，另外讓第一次拿題目的請求沒有回應、看用另一個 session 送的第二次（#404）：每一個的 `User-Agent` 都是 `iamreal`、`Accept-Language` 都是 `zh-TW`，標頭裡沒有 app 的名稱、CFNetwork、Darwin；系統另外加的標頭只有 `Host`、`Accept`、`Accept-Encoding`、`Connection`、`Content-Type`、`Content-Length`，前三個固定的值照模擬器上量到的比（#444；改之前量到的是 `User-Agent: IamrealApp/1 CFNetwork/3860.100.1 Darwin/27.2.0`、`Accept-Language: zh-TW,zh-Hant;q=0.9`）
- `Tests/DoneScreenTests.swift`：送出後後台的回應和送出之後的三步。`spec/vectors/records-response.json` 的每一案由核心讀（`idc_records_response`），app 拿到的和標準答案相同。第 6 步：第一次宣告逐字照 `design/copy/card-proof.md`（「app」那一節），兩顆按鈕並排、在示範的上面，示範右下角的小字播的時候寫「停止播放」、其餘寫「再看一次」，示範裡的帳號和網址是這張卡片的、畫面上的每一句都在 `card-proof.md`「示範」的清單裡；再次過卡的短版、從短版換到的完整那一頁有「上一步」、什麼時候不是短版、已複製、讀不出每個平台記成什麼、別的卡片也宣告了同一個帳號、和確認時不同的每一種（後台是誠實的時候用假卡片過卡遇不到，所以在這裡測）。第 7 步：沒存提醒時問（「設定提醒」打開選間隔和時刻）、開著時寫重排後的日子、選了日期時不寫多久之後、憑證在提醒前到期時多的那一句。第 8 步：逐字照文字檔、「分享到 Threads」（Threads 的 web intent）和分享符號的小按鈕（系統的分享面板）一排在最上面、「上一步」「完成」在它下面並排、沒有順序號碼時、標題照這次過卡做了什麼（新宣告、再次過卡、更換、全部收回和其他幾種）、全部收回的那一頁、分享的那一句。時刻的寫法
- `check-app-test.sh`：`check-app.sh` 讓建好的 app 通過，並擋下每一份改過的副本
- `check-archive-test.sh`：`check-archive.sh` 讓 `archive.sh` 做的 archive 通過，並擋下每一份改過的副本（「上傳到 TestFlight」）

### 截圖

`Tests/ScreensTests.swift` 拍的截圖，檔名就是 `design/screens/` 裡 app 共用的那幾張（`card-proof-app-1-before-phone.png`、`-3-pin`、`-4-accounts`、`-5-confirm`、`-5-progress`、`-6-hang`、`-6-hang-short`、`-7-reminder`、`-7-reminder-on`、`-8-done`、`-8-done-switch`、`-8-withdraw`、`app-splash-phone.png`；提醒的 `app-reminder-2-schedule-phone.png`、`-4-from-notification`、`app-settings-phone.png`。`app-reminder-3-notification-phone.png` 是系統的通知的示意，不拍）。`design/screens/` 放的是哪一個 app 的，寫在那裡的 README「版本」；要換成 iPhone 的，跑過 `xcodebuild test` 之後從 `web/test-output/app/screens-ios/` 把同名的檔複製過去，版本改成「實作版（iOS）」。已經宣告帳號的卡片的第 4、5 步也拍（`card-proof-app-4-accounts-existing-phone.png`、`-4-accounts-switch`、`-5-confirm-refresh`、`-5-confirm-switch`、`-5-confirm-withdraw`），`design/screens/` 沒有同名的，只留在輸出的目錄。示範另外畫幾個時間點（按下「複製證明連結」、四個 Threads 的示意畫面各自被按的那一刻、貼上、最後一格，和帳號有 30 個字時的三張）到 `web/test-output/app/screens-ios/demo/`，第 2 步的示範也畫（手機、卡片進來、貼好、紅圈、離開、停住）；`xcodebuild test` 前面加 `TEST_RUNNER_IAMREAL_DEMO_FRAMES=hang` 或 `=sense` 時那一段改成每十五分之一秒一格，可以接成影片。讀取卡片的那一張只有 iPhone 的，檔名是 `card-proof-app-2-read-iphone-phone.png`，`design/screens/` 放的是這裡拍的（#174）。感應中的那一張（`card-proof-app-2-reading-iphone-phone.png`）蓋著系統的面板，這裡拍不到，留著定稿。

## privacy manifest（`App/PrivacyInfo.xcprivacy`）

App Store 要 app 帶一份 privacy manifest，申報用到的 required reason API（[#445](https://github.com/iamreal-tw/iamreal/issues/445)，「app 的計數、當機回報和商店的隱私標示」[#94](https://github.com/iamreal-tw/iamreal/issues/94) 第 10 點）。檔名和四個鍵照 Apple 的 [Privacy manifest files](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files)；API 的類別和理由代碼照 [Describing use of required reason API](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api) 和它的 [`NSPrivacyAccessedAPIType`](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype)（2026-11-26 讀的）。`App/` 是 Xcode 同步的資料夾，檔放在裡面就會包進 app，專案檔不用改。

**用到的 required reason API。** Apple 的清單有五類，這個 app 用到兩類：

| 類別 | 理由代碼 | 用在哪裡 | 為什麼是這個代碼 |
|---|---|---|---|
| `NSPrivacyAccessedAPICategoryUserDefaults` | `CA92.1` | `App/CRLNumbers.swift`（每把發證金鑰用過的最高清冊編號）、`App/Reminder.swift`（提醒的四樣設定）、`App/Counts.swift`（過卡裝置編號和產生的日子），都是 `UserDefaults.standard` | Apple：「Declare this reason to access user defaults to read and write information that is only accessible to the app itself.」app 沒有 App Group、沒有延伸功能，讀寫的只有自己的 |
| `NSPrivacyAccessedAPICategoryFileTimestamp` | `C617.1` | `App/` 的程式沒有用。連結進來的 `device-core/` 讓執行檔引用了這一類的函式：正式 app 的 build 是 `fstat`、`lstat`（Barretenberg 的 `bbapi`），模擬器上的 Debug build 另外有 `stat`、`fstatat`（2026-11-26 用 `nm -u` 看的） | Apple：「Declare this reason to access the timestamps, size, or other metadata of files inside the app container, app group container, or the app's CloudKit container.」核心不碰檔案（`device-core/README.md`），app 交給它的是位元組，不是路徑；這些函式如果被叫到，碰得到的只有 app 自己容器裡的檔 |

- **另外三類沒有用到**：系統開機時間（`systemUptime`、`mach_absolute_time`）、磁碟空間、使用中的鍵盤。`check-app.sh` 看原始碼裡的名稱和執行檔引用的函式，哪一類用到了卻沒申報、或申報了卻沒用到，建置就失敗。
- **檔案時間戳那一類是往多報的方向填的。** Apple 的文件說的是：執行檔用到 required reason API，包著它的 bundle 就要有 privacy manifest 申報（「For each executable or dynamic library in an app that uses a required reason API, the bundle that includes the executable or dynamic library needs to include a privacy manifest file that reports the API.」）。文件沒有講「連結進來、但 app 的流程不會叫到」的函式算不算用到，也沒有講 C、Rust 的程式；App Store Connect 上傳時實際怎麼判斷，這裡沒有查到。執行檔既然引用了，就照會被叫到來申報。
- **追蹤**：`NSPrivacyTracking` 是 `false`，沒有追蹤的網域（`docs/store-privacy-labels.md`「兩家各自另外問的」）。
- **收集的資料**（`NSPrivacyCollectedDataTypes`）照 [`docs/store-privacy-labels.md`](../docs/store-privacy-labels.md) 裡 app 現在實際送的那幾列，每一類都是連結、不追蹤，用途照那一份（App Functionality、Analytics）：

  | manifest 的值 | 那一份的第幾列 |
  |---|---|
  | `NSPrivacyCollectedDataTypeUserID` | 第 1 列：宣告的帳號和島民編號 |
  | `NSPrivacyCollectedDataTypeCoarseLocation`、`NSPrivacyCollectedDataTypeOtherDiagnosticData` | 第 3 列：IP 位址（Cloudflare 的那一份現在就有） |
  | `NSPrivacyCollectedDataTypeOtherDataTypes` | 第 10 列：紀錄的其他欄位 |
  | `NSPrivacyCollectedDataTypeDeviceID`（App Functionality、Analytics） | 第 5 列：過卡裝置編號 |
  | `NSPrivacyCollectedDataTypeProductInteraction`（Analytics） | 第 6 列：計數的步驟和動作 |
  | `NSPrivacyCollectedDataTypeOtherDiagnosticData` 多一個 Analytics | 第 7、9 列：停下來的原因代碼；手機型號、系統版本、app 版本 |
  | `NSPrivacyCollectedDataTypePerformanceData`（Analytics） | 第 8 列：花了多久的分級 |

  第 2、4 列（後台的連線紀錄，[#20](https://github.com/iamreal-tw/iamreal/issues/20)）用的類別已經在上面。Apple：Xcode 把 app 和各 SDK 的 manifest 彙整成一份 privacy report，在 App Store Connect 填隱私標示時參考它；標示本身還是要營運者在後台填（[#161](https://github.com/iamreal-tw/iamreal/issues/161)）。

## 建置時的檢查（`check-app.sh`）

app 的最後一個建置階段跑 `check-app.sh`，不過就是建置失敗。它檢查建出來的 `.app` 和 `App/` 的原始碼：

- 識別碼是這個組態的那一種 app 的（Debug 是 `tw.iamreal.app.dev`，Release 是 `tw.iamreal.app`，TestApp 是 `tw.iamreal.app.test`；別的組態一律不過），圖示下面的名稱是 `design/copy/app.md` 給那一種 app 的；build 號碼在那一種 app 的範圍裡（「版本和 build」）；環境是 `IAMREAL_ENV_TEST`，執行檔裡有測試網站的兩個網址、沒有正式網站的。卡片簽的是不是測試的證明紀錄的場合字串，它從執行檔看不出來（兩條場合字串都寫死在核心裡），由 `Tests/BuildTests.swift` 檢查
- `UIDeviceFamily` 只有 iPhone
- app 裡有 `PrivacyInfo.xcprivacy`，內容就是 `App/PrivacyInfo.xcprivacy` 的；它寫不追蹤、沒有追蹤的網域；它申報的 required reason API 和 app 用到的一樣，不多不少（上面「privacy manifest」；用到與否看 `App/` 原始碼裡的名稱和執行檔引用的函式）。看不到的：這些名稱看不出來的用法，和理由代碼寫得對不對
- 內建的電路檔、驗證金鑰和程式庫裡的逐位元組相同，參數檔的 SHA-256 等於 `device-core/crs.sha256`
- app 裡沒有任何執行檔連結 `AdSupport` 或 `AppTrackingTransparency`；沒有 `Frameworks/`；專案檔沒有 Swift 套件。這是「沒有第三方 SDK」能從建置看出來的部分
- 原始碼沒有 `identifierForVendor`
- entitlement 是那一種 app 的：讀卡只有 `TAG`；正式 app、測試 app 的 app 網域只有 `test-app.iamreal.tw`，開發用 build 沒有（上面「app 網域」）
- app 不讀打開它的網址：原始碼沒有 `onOpenURL`、`onContinueUserActivity`、`NSUserActivity`、app 或 scene 的 delegate 這些名稱，`Info.plist` 沒有 `CFBundleURLTypes`
- `App/` 的原始碼沒有寫 log 或標準輸出的呼叫（`print`、`NSLog`、`os_log`、`Logger`、`FileHandle.standardError`、`fatalError` 等），Debug 也沒有；`device-core/` 兩個套件的 `src/` 沒有 `println!`、`eprintln!`、`dbg!`，也沒有拿 `stdout()`、`stderr()`。所以 release build 自己不輸出 log
- 模擬器的 Debug 以外的 app，執行檔裡沒有 `idc_testing_session_open` 和測試用函式庫的記號（上面「模擬器的函式庫認測試金鑰」）
- 原始碼只經過 `App/Bridge.h` 碰 C：它是 app 的 bridging header，內容只有引入 `device-core/` 標頭檔的那一行，`App/` 裡沒有別的 C、Objective-C 或 module map。測試的 target 另有 `Tests/Bridge.h`，內容只有引入測試用標頭檔的那一行。靜態函式庫裡還有 Barretenberg 自己的 C 函式，app 不准呼叫（`device-core/README.md`「Poseidon2 不開放成 C 函式」）

這些檢查是照字面找，防的是手誤，不能代替逐行看。看不到的有兩件：

- **Barretenberg 自己的程式會不會印東西。** 2026-11-20 在模擬器上跑 Release 的 build（只呼叫三個函式），系統的 log 裡沒有任何一行是 app 自己的執行檔寫的，`simctl launch --console` 也沒有收到輸出。2026-11-21 在模擬器上用假卡片算了四份證明（Debug 的 build，`xcodebuild test` 的輸出），那一段除了系統網路層自己的幾行之外沒有別的輸出；Release 的 build 算證明時還沒有看過
- **核心 panic 時 Rust 會印一行。** C 函式的邊界會接住 panic、回 `IDC_ERR_INTERNAL`，但 Rust 預設在接住之前先把 panic 的訊息和位置寫到標準錯誤。訊息是固定的字串（`device-core/README.md`「錯誤裡沒有值」），不含卡片、憑證、帳號的內容；要不要連這一行都不印，是 `device-core/` 的事

拉取請求的檢查另外建一次 Release 的組態，並 archive 正式 app 和測試 app 各一次，讓這些檢查也對三種 app 跑過。

## 怎麼用線裝到手機

開發用 build（Debug，識別碼 `tw.iamreal.app.dev`），不經過商店（ADR-0040）。它和從 TestFlight、App Store 裝的正式 app、測試 app 識別碼不同，三個可以同時留在手機上。需要付費的 Apple 開發者帳號，Xcode 登入過；識別碼 `tw.iamreal.app.dev` 在帳號裡註冊過、開了 NFC Tag Reading（[#161](https://github.com/iamreal-tw/iamreal/issues/161)）。

```
cd ios
(cd ../device-core && rustup target add aarch64-apple-ios)   # 第一次；在 device-core/ 裡跑，裝到 rust-toolchain.toml 的那一版
./build-core.sh device
xcrun devicectl list devices            # 找手機的識別碼
xcodebuild build -project IamrealApp.xcodeproj -scheme IamrealApp -configuration Debug \
  -destination "id=<手機的識別碼>" -derivedDataPath build \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=<團隊的代號>
xcrun devicectl device install app --device <手機的識別碼> build/Build/Products/Debug-iphoneos/IamrealApp.app
```

團隊的代號不寫進專案檔，每次從命令列給（或在 Xcode 的 Signing & Capabilities 選，不要提交那個改動）。手機要先打開開發者模式。

## 用真卡片測試

agent 不碰卡片；這一節由營運者用自己的卡片和 iPhone 照著做，結果記在 PR（[#174](https://github.com/iamreal-tw/iamreal/issues/174)）。用「怎麼用線裝到手機」裝開發用 build：它連測試網站、簽測試的證明紀錄的場合字串，可以重複過卡。

記下來的：iPhone 的機型和 iOS 版本、卡片是第幾代、每一項照預期或不照預期（不照預期時，畫面上的代碼和停在哪一項）。PIN 不寫下來；截圖裡有姓名的不附。

1. **三次感應的完整過卡**
   - 第 2 步「感應卡片」之前，畫面上有感應位置的示範（`design/screens/card-proof-app-2-read-iphone-phone.png`）：照示範把卡片貼在手機背面的上方，讀不讀得到；示範順不順；VoiceOver 把它唸成一句「示範：手機正面朝你……」（[#376](https://github.com/iamreal-tw/iamreal/issues/376)）
   - 按「感應卡片」：系統的面板寫「把自然人憑證貼在 iPhone 背面的上方」；卡片貼上去後「讀取中，不要移動卡片……」；讀完「讀到了，可以拿開卡片」，面板收起來
   - 第 3 步顯示卡片上的姓名。輸入 PIN、按「確認卡片」：面板寫「卡片簽章中，不要移動卡片……」，簽完「卡片簽好了，可以拿開卡片」；接著出現這張卡片的帳號清單
   - 填帳號、確認，按「宣告這個帳號」（或「再次過卡」）：第三次感應的面板同上，接著算證明、送出，到第 6 步（掛上去），再到提醒、完成和分享
   - `https://test.iamreal.tw/p/<短編號>` 看得到這一筆
2. **中途拿開卡片**
   - 前兩種（面板寫「讀取中」「卡片簽章中」時拿開）：系統的面板收起來之前是失敗的樣子，不是藍色的勾，寫「沒有完成，請看 app 畫面上的說明。」（[#367](https://github.com/iamreal-tw/iamreal/issues/367)）。後兩種是自己按面板的「取消」，面板直接收起來，沒有這一句
   - 第 1 次感應，面板寫「讀取中」時拿開：第 2 步停在「感應卡片，讀取卡片上的憑證」，寫「卡片在讀取途中離開了手機。請再感應一次，感應時不要移動卡片。」，按鈕「再感應一次」；再感應一次就接著做
   - 第 2 次感應，面板寫「卡片簽章中」時拿開：第 3 步寫「讀卡時發生錯誤（代碼 `connection_lost`）。請重新插卡再試一次。」，PIN 丟掉，按鈕「再感應一次卡片」回到第 2 步（這一段的句子和按鈕照 `card-proof.md` 改是 [#172](https://github.com/iamreal-tw/iamreal/issues/172)）。重新來一次，過得了卡
   - 拿開得太快，卡片還沒接上就離開時，面板會繼續等卡片；按面板的「取消」，畫面寫「沒有感應到卡片……」
   - 卡片接上後、面板寫「讀取中」時按面板的「取消」：畫面也寫「沒有感應到卡片……」（寫成「卡片在讀取途中離開了手機……」也記下來：系統告訴 app 的先後和預期的不同）
3. **輸入錯的 PIN 一次**：第 3 步寫「PIN 不正確。連續輸入錯誤三次，卡片會被鎖住。」，PIN 欄位是空的。接著輸入正確的 PIN，過得了卡。只錯一次，不要連錯三次
4. **第二次感應換一張卡**：第 1 次感應用卡片 A，第 2 次感應換成另一張第二代的自然人憑證 B：第 3 步寫「這不是剛才讀到的那張卡片，PIN 沒有送出。請換回剛才那張卡片，再感應一次。」，按鈕「再感應一次」；換回 A 再感應就接著做，PIN 不用再輸入
5. **第 7 步的通知被拒絕**（[#364](https://github.com/iamreal-tw/iamreal/issues/364)）：先在系統的設定裡關掉這個 app 的通知（或第一次被問時按「不允許」）。過卡到第 7 步按「設定提醒」，在選間隔和時刻那一頁按「開啟提醒」：那一頁留著，寫「沒有排提醒：手機不允許這個 app 發通知。……」，什麼都沒存；按「取消」回到第 7 步。到系統的設定裡允許通知，再按一次「設定提醒」「開啟提醒」：回到第 7 步，寫下次提醒的日子、按鈕是「下一步」，設定頁的「下次提醒」是同一天
6. **第 6 步的示範**（[#375](https://github.com/iamreal-tw/iamreal/issues/375)）：過卡到完整的第 6 步，示範自己播一次，停在個人檔案多出來的那一行；看起來順不順（有沒有卡、掉格）。播的時候按右下角的「停止播放」直接到最後一格，小字變成「再看一次」；點示範本身也一樣。開著 VoiceOver：示範被唸成一句「示範：按「複製證明連結」……」，裡面的字不逐一唸，四步的字照常唸。系統的字體放到最大：兩顆按鈕上下排，字沒有被切掉

沒有在這張清單上的：第一代的卡片（手上沒有）、別的 iPhone 機型、從 TestFlight 裝的 build。

## 上傳到 TestFlight

正式 app（Release，`tw.iamreal.app`）和測試 app（TestApp，`tw.iamreal.app.test`）只從 GitHub Actions 上傳（ADR-0036、ADR-0040），各一個工作流程：`.github/workflows/upload-ios.yml` 和 `upload-ios-test.yml`。兩個一樣只能手動觸發，營運者或營運者電腦上的 coding agent 在 `main` 上觸發：

```
gh workflow run upload-ios.yml --repo iamreal-tw/iamreal --ref main        # 正式 app
gh workflow run upload-ios-test.yml --repo iamreal-tw/iamreal --ref main   # 測試 app
```

合併到 `main` 不會上傳。上傳成功之後，App Store Connect 處理完那個 build，TestFlight 的內部群組「營運者」自動收到（[#161](https://github.com/iamreal-tw/iamreal/issues/161)；測試 app 的 App Store Connect 那一筆和它的群組是 #485）。兩個工作流程只差在 archive 的那一步（`archive.sh` 帶不帶 `--test-app`、build 號碼），用同一個 environment `app-test`、同一把金鑰。識別碼來自組態（`Config/Test.xcconfig`），工作流程和 `archive.sh` 都不給；檢查的腳本（`check-app.sh`、`check-archive.sh`）照組態核對它是不是那一個。

### 兩個工作

| | `build` | `upload` |
|---|---|---|
| 拿得到金鑰 | 不能 | 能：environment `app-test` 的 App Store Connect API 金鑰（開發者角色的團隊金鑰，#161）、Apple Distribution 發布憑證和描述檔（#143），那個 environment 只讓 `main` 上的執行拿 |
| 跑什麼 | 這個程式庫的程式：`build-core.sh device`，再 `archive.sh`（測試 app 是 `archive.sh --test-app`） | 不取出程式庫、不跑它的任何腳本：解開 `build` 交下來的 tar 檔，把團隊代號寫進 `ExportOptions.plist`，把發布憑證放進自己的鑰匙圈、裝好描述檔，先簽一次檢查 entitlement，再用 Xcode 的 `xcodebuild -exportArchive` 簽章、上傳 |
| 交出去的 | archive 包成一個 tar 檔（artifact 不保留檔案的權限），加 `ExportOptions.plist` | 上傳到 App Store Connect |

- **`archive.sh`** 做 Release（帶 `--test-app` 時 TestApp）的 archive，不簽章（`CODE_SIGNING_ALLOWED=NO`；這個工作沒有能簽章的東西），最後跑 `check-archive.sh`。建置時 `check-app.sh` 照常當最後一個建置階段跑。
- **archive 之後用 entitlement 檔簽一個 ad hoc 的章。** 沒有簽章的 archive 裡沒有 entitlement，Xcode 匯出時只用它在 app 上找得到的：第一次手動簽章（[run 46001796708](https://github.com/iamreal-tw/iamreal/actions/runs/46001796708)，#143）簽出來的 app 沒有 NFC，`upload` 的檢查擋下了。所以 `build` 在 `archive.sh` 之後跑 `codesign --sign -`（ad hoc：不用金鑰、不用團隊）帶 `Config/IamrealApp.entitlements`，交下去的 app 就帶著 entitlement；`upload` 的匯出再用發布憑證重簽。
- **`check-archive.sh`** 確認要上傳的就是那一個 app：識別碼 `tw.iamreal.app`（帶 `--test-app` 時 `tw.iamreal.app.test`）；版本和 build 是給它的那兩個數字，app 裡和 archive 自己的紀錄都是；app 有圖示（App Store Connect 不收沒有圖示的 build）；app 裡只有執行檔、Xcode 放的 `Info.plist`、`PkgInfo`、編好的圖示（`Assets.car` 和給舊版 iOS、給 iPad 相容模式的兩張 PNG）和「包進 app 的檔案」那張表的每一個（privacy manifest 也在裡面），沒有測試（`PlugIns/`，假卡片在裡面）、沒有別的檔，執行檔裡沒有 `FakeCard`；再以那個組態跑一次 `check-app.sh`（build 號碼在那個 app 的範圍裡、連測試網站、沒有正式網站的網址、沒有測試用的函式庫 `idc_testing_session_open`、內建的檔和程式庫的相同）。卡片簽哪一份證明紀錄的場合字串，執行檔裡看不出來（兩條都寫死在核心）；它跟著網址走：`App/AppEnvironment.swift` 在同一個編譯條件底下定網址和證明紀錄，執行檔裡是測試網站的網址，所以編進去的是測試那一支，而 `Tests/BuildTests.swift` 確認那一支簽 `iamreal-test:public:0`。
- **簽章用營運者做的發布憑證，手動簽章**（[#143](https://github.com/iamreal-tw/iamreal/issues/143)）。開發者角色的 API 金鑰用不了 Apple 代管的發布憑證（第一次執行 [run 45933174888](https://github.com/iamreal-tw/iamreal/actions/runs/45933174888)：「You haven't been given access to cloud-managed distribution certificates」），API 金鑰也沒有地方另外給這個權限；它也不能建發布用的描述檔（[Roles](https://developer.apple.com/help/account/access/roles/)：「Create and delete distribution provisioning profiles」開發者那一欄是空的）。所以照 ADR-0036 的備案，營運者做一張 Apple Distribution 憑證和兩份 App Store 描述檔（兩個 app 各一份），放進 `app-test`，`ExportOptions.plist` 寫 `signingStyle` `manual`、`signingCertificate` `Apple Distribution`，描述檔在 `upload` 裡照識別碼寫進 `provisioningProfiles`。API 金鑰只用來上傳。不改用 App Manager 或 Admin 角色的金鑰：兩個都能送審（同一頁的「Submit apps」）。
- **`app-test` 裡簽章用的 secret**：

  | 名稱 | 內容 | 哪個工作流程用 |
  |---|---|---|
  | `IOS_DIST_P12_BASE64` | Apple Distribution 憑證和它的私鑰，`.p12`，base64 | 兩個 |
  | `IOS_DIST_P12_PASSWORD` | `.p12` 的密碼 | 兩個 |
  | `IOS_APPSTORE_PROFILE_BASE64` | `tw.iamreal.app` 的 App Store 描述檔，base64 | `upload-ios.yml` |
  | `IOS_TEST_APPSTORE_PROFILE_BASE64` | `tw.iamreal.app.test` 的 App Store 描述檔，base64 | `upload-ios-test.yml` |

  描述檔要包含 NFC Tag Reading 和 Associated Domains：`upload` 檢查描述檔是這個 app、這個團隊，允許 NFC 的 `TAG`，而且有 Associated Domains，不是就停。App ID 的能力改了，描述檔就失效要重做（[Enable app capabilities](https://developer.apple.com/help/account/identifiers/enable-app-capabilities/)：「Provisioning profiles that contain a modified App ID become invalid.」）。
- **憑證和描述檔有到期日，到期前要換。** 到期日在 Apple Developer 網站的 Certificates、Profiles 頁上看得到；換的時候營運者重做、換掉上面的 secret。`.p12` 用「鑰匙圈存取」匯出：OpenSSL 3 預設的加密方式做的 `.p12`，`security import` 可能讀不了。撤銷憑證時，App Store 上的 app 不受影響，但已經上傳、還沒送審的 build 可能變成無效（[Certificates overview](https://developer.apple.com/help/account/certificates/certificates-overview/)）。
- **先簽一次、不上傳，檢查 entitlement。** Xcode 簽出來的 entitlement 要到這裡才看得到；`upload` 先用 `destination` `export` 簽一次，從簽好的 app 讀出 entitlement，要和 `Config/IamrealApp.entitlements` 相同，不多不少：`com.apple.developer.nfc.readersession.formats` 剛好是 `TAG` 一個，`com.apple.developer.associated-domains` 剛好是 `applinks:test-app.iamreal.tw` 一個（「app 網域」）；識別碼要對，才往下簽章上傳。
- **團隊代號**是 environment `app-test` 的 variable `APPLE_TEAM_ID`（不是 secret：每個簽過的 app 裡都看得到它）。archive 只有 ad hoc 的章、沒有團隊，匯出要知道用哪個團隊（`xcodebuild -help`：`teamID`「Defaults to the team used to build the archive」）。沒有設這個 variable，`upload` 在拿到金鑰之前就失敗。團隊代號不寫進程式庫（「怎麼用線裝到手機」）。
- **`manageAppVersionAndBuildNumber` 是 `false`**：版本和 build 用 `archive.sh` 給的，Xcode 不另外改。`uploadSymbols` 是 `true`：Apple 收到當機報告時能還原成函式名稱（[#94](https://github.com/iamreal-tw/iamreal/issues/94)：當機只看商店自己的報告）。

### 版本和 build

- **版本是觸發那一天的台灣日期**，年.月.日、不補零，例如 `2026.11.5`、`2026.11.21`。App Store Connect 的版本只收三個整數（[`CFBundleShortVersionString`](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleshortversionstring)：「The required format is three period-separated integers」），所以同一天上傳第二次不加 `.1`（網站的標籤才加，ADR-0029），版本相同，靠 build 分（ADR-0036）。TestFlight 同一個版本可以有好幾個 build。
- **build 號碼，三種 app 各一段**（ADR-0040「測試網站的最低版本」）：
  - 正式 app：`upload-ios.yml` 的執行編號（`GITHUB_RUN_NUMBER`），1 到 999,999
  - 測試 app：`upload-ios-test.yml` 的執行編號加 1,000,000，1,000,000 到 1,999,999
  - 開發用 build：專案檔 Debug 的 `CURRENT_PROJECT_VERSION`，固定 2,000,000

  為什麼這樣編：測試網站的最低版本（ADR-0035）只分 Android 和 iOS，不分是哪一個 app。上線那天測試網站的最低版本調到 1,000,000，擋下還連著測試網站的正式 app 舊 build，而測試 app 和開發用 build 的號碼都比它大，照樣能過卡。測試 app 的上傳另外一個工作流程，是因為執行編號各自數，兩個 app 的號碼不會交錯。`check-app.sh` 在每次建置時擋住範圍外的號碼，archive 也一樣（`check-archive.sh` 再以那個組態跑它）。開發用 build 每次都是同一個號碼，裝新的會蓋掉舊的
- **執行編號每次觸發加一**，同一次執行重跑時不變。重跑一個已經傳上去的執行，App Store Connect 會拒收同一個 build；要再傳就重新觸發一次。
- **執行編號跟著工作流程走。** `upload-ios.yml` 或 `upload-ios-test.yml` 改名、或刪掉再加回來，GitHub 當成新的工作流程，編號從 1 重來，比 App Store Connect 上已有的小，上傳會被拒。到那時候在那個工作流程給 `archive.sh` 的 build 加上一個固定的數（上一次的 build），並寫在這裡；加了之後還是要在那個 app 的範圍裡。沒有改成從 App Store Connect 讀最新的 build 再加一：`build` 沒有金鑰，build 要在建置時寫進 app。

### 合併後才驗得到的

這個工作流程只在 `main` 上、手動觸發才跑，拉取請求的檢查跑不到上傳的那一半：

- `build` 交下去的 tar 檔、`upload` 解開它和把團隊代號寫進 `ExportOptions.plist`：第一次執行（run 45933174888）都跑過了，失敗在之後的簽章
- `build` 的指令：`checks-ios.yml` 每次用同樣的 `archive.sh` 做一次 archive、跑 `check-archive-test.sh`，所以拉取請求時就看得到；它沒有包成 tar 檔交下去
- `upload` 的手動簽章：鑰匙圈、描述檔、Xcode 簽章在 run 46001796708 都跑過了；還沒跑到的是開發者角色的金鑰能不能上傳（[Roles](https://developer.apple.com/help/account/access/roles/) 的「Upload builds」開發者那一欄寫要有 Certificates, Identifiers & Profiles 的權限，API 金鑰算不算有，文件沒有寫）、App Store Connect 收不收這個 build
- app 網域的 entitlement（#532）：Xcode 用重發的描述檔重簽時帶不帶上 `applinks:test-app.iamreal.tw`，要等 entitlement 進了 `main` 之後兩個工作流程各跑一次才看得到；`upload` 先簽一次的那一步會看
- 讀卡的 entitlement（`Config/IamrealApp.entitlements`，[#174](https://github.com/iamreal-tw/iamreal/issues/174)）：沒有 ad hoc 簽章時，Xcode 簽出來的 app 沒有 NFC（run 46001796708）。有了 ad hoc 簽章之後，Xcode 重簽時會不會照它帶上 NFC，`upload` 先簽一次的那一步會看；不會的話那一步失敗，不會上傳

### 上傳之後營運者做的

- **第一次觸發之前**：在 environment `app-test` 加 variable `APPLE_TEAM_ID`（團隊代號，2026-11-27 加了），和上面「簽章用的 secret」那張表的 secret（測試 app 的描述檔要等它的 App ID 註冊，#485）。

- **出口管制的加密問題：已經寫在 `Config/Info.plist`，不用每個 build 回答。** App Store Connect 問「App 會使用哪種加密演算法？」，營運者 2026-11-27 對 build 3 選「未使用上方提及的任一種演算法」：app 拿來保密的加密只有連伺服器的 HTTPS（`URLSession`）和卡片安全通道的 AES-128、AES-CMAC（`App/CardChannel.swift` 經由系統的 CommonCrypto），都是系統的加密；`device-core/` 執行的只有雜湊、驗簽章和零知識證明。連結進來的零知識證明程式庫裡有 AES 的實作（Noir 的求解器依賴的 `aes`、`cbc` 套件，Barretenberg 的 `AES128Constraint`），但我們的電路沒有用 AES，這段程式不會執行，也不拿來保護任何資料；營運者知道這一點，仍然選上面那個答案（2026-11-28）。所以 `ITSAppUsesNonExemptEncryption` 是 `NO`：Apple 寫 `NO` 表示 app「including any third-party libraries you link against—either uses no encryption, or only uses encryption that’s exempt from export compliance requirements」（[ITSAppUsesNonExemptEncryption](https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption)）。app 改用別的加密、或電路用到 AES 時，回頭重看這一項。
- **對外測試的群組**：第一個 build 上傳之後才能建，關掉截圖回饋（#161）。

## 工具和版本

版本都釘死；沒有任何套件管理工具裝進來的東西。

- **Xcode 27.2**（build 27B52）。拉取請求的檢查用 GitHub 的 `xcode-27` runner 上 `/Applications/Xcode_27.2.app` 那一份，同一個 build（來源見 `.github/README.md`）
- **Rust**：`device-core/rust-toolchain.toml` 的那一版，加 `aarch64-apple-ios-sim`、`aarch64-apple-ios` 兩個 target
- **Barretenberg 6.0.0 的靜態函式庫、參數檔**：下載後核對 `device-core/barretenberg.sha256`、`device-core/crs.sha256`
- 專案檔是手寫的，不用產生專案的工具；沒有 CocoaPods、Swift Package、Carthage

顯示的版本用日期（`MARKETING_VERSION`），`build`（`CURRENT_PROJECT_VERSION`）是遞增的整數（ADR-0036），三種 app 各一段（「版本和 build」）。上傳的 build 由 `archive.sh` 在建置時給（「上傳到 TestFlight」）；專案檔裡的固定值是用線裝的開發用 build 的 2,000,000，和不經 `archive.sh` 建置時正式 app 的 1、測試 app 的 1,000,000。

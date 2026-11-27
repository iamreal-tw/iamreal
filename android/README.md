# android/：Android 的 app（Kotlin）

**這個目錄讓人檢查的事：憑證、公鑰、簽章、PIN 沒有離開手機；手機上做的檢查和算法是 `device-core/` 那一份；發出去的安裝檔裡有什麼。** app 引用 `device-core/`（ADR-0034），不引用 `protocol/`、`worker/`。

現在有過卡能通的路：八步（開始之前、讀取卡片、輸入 PIN、你的帳號、確認，送出之後是掛上去、提醒、完成和分享；網頁沒有提醒那一步，共七步；[#362](https://github.com/iamreal-tw/iamreal/issues/362)），卡片感應三次，PIN 輸入一次（[#133](https://github.com/iamreal-tw/iamreal/issues/133)、[#134](https://github.com/iamreal-tw/iamreal/issues/134)）。畫面照 `design/screens/card-proof-app-*` 和 `design/DESIGN.md`（[#295](https://github.com/iamreal-tw/iamreal/issues/295)），用 Jetpack Compose，文字逐字來自 `design/copy/card-proof.json`；打開 app 先是啟動畫面（`app-splash-phone.png`，字來自 `design/copy/app.json`）。顏色、字級、間距照 `design/tokens.json`，寫在 `app/src/main/kotlin/tw/iamreal/app/ui/Theme.kt`；標題用包進安裝檔的源流明體 TW（「內建的檔案」），內文和等寬字用系統的。只有亮色，和網頁一樣。在模擬器上用假卡片對著本機的 Worker 過得完（「模擬器上過一次卡」）。手機上用 NFC 讀真的自然人憑證（[#173](https://github.com/iamreal-tw/iamreal/issues/173)，「讀卡」）。

過卡的提醒和設定頁（[#297](https://github.com/iamreal-tw/iamreal/issues/297)，「過卡提醒」）：第 7 步問要不要提醒，手機自己排本機通知；第 1 步和第 8 步的頁首有「設定」。字來自 `design/copy/app.json` 和 `card-proof.json`。

過卡被打斷時（[#171](https://github.com/iamreal-tw/iamreal/issues/171)），句子都在 `design/copy/card-proof.md` 各步的「app」，哪一個原因說哪一句在 `ui/Messages.kt`：

- **卡片離開、NFC 被關掉、換了卡**：只重做那一次感應（「再感應一次」）。第 3 步這時 PIN 欄位不能改，用的是記憶體裡的 PIN
- **送 PIN 時掉線**：卡片從來沒有接受過這個 PIN 時，app 不重送，清掉 PIN，請持卡人再輸入。卡片回了 app 不認得的答覆時也一樣。卡片接受過（之後才掉線）的，PIN 是對的，留著重送：`card/Card.kt` 的 `pinAccepted`，`flow/CardProof.kt` 的 `sign`
- **PIN 不正確**：清掉 PIN，第 3 步重新輸入；發生在第三次感應時回到開頭
- **PIN 在手機上滿 5 分鐘**：從 PIN 的第一個字進到欄位算起（還在欄位裡的也算），清掉 PIN 和做到一半的過卡，回到第 1 步，最上面寫原因。app 切到背景再回來時、按「確認卡片」和最後一次感應之前各看一次時間；已經在等卡片的那一次感應會做完。手機的時鐘往回調不會延長
- **最低版本**（`config` 的 `min_app`，ADR-0035、`spec/min-app.md`）：怎麼判斷在核心（`idc_min_app`），拿 app 自己的 `versionCode` 和手機的時鐘去問。打開 app、每次回到第 1 步都看：比最低版本舊、還沒到起算日，第 1 步最上面提醒，照常過卡；起算日當天起整個第 1 步換掉，只剩開 Google Play 的按鈕。三次感應之前各再看一次（`flow/CardProof.kt` 的 `checkMinApp`）：過卡做到一半到了起算日，也在等卡片之前停下。這一欄讀不懂時不往下，和平台表讀不懂相同
- **沒有 NFC 的手機**：整個第 1 步換掉。NFC 只是關著的，在按了「感應卡片」之後說，給開系統設定的按鈕

還沒有的：

- 第 2 步的示範還沒有在真手機上對過（[#153](https://github.com/iamreal-tw/iamreal/issues/153)）：示範裡卡片在手機背面上下找、停在比中間高一點的地方，是時間表定的，不是量過某一支手機的位置

## 圖示

app 的圖示是記號（紅色的自然人憑證和墨色的台灣，`web/src/ui/logo.ts`）放在頁面的白底上，營運者從三個方向裡選的（[#490](https://github.com/iamreal-tw/iamreal/issues/490)），和 iOS 的相同。每一種 build 都是同一個圖示，靠圖示下面的名稱分。

- `app/src/main/res/mipmap-anydpi/ic_launcher.xml`：adaptive icon，底是 `token_bg`，前景是 `drawable/launcher_mark.xml`。前景 108dp，系統只顯示中間的 72dp、裁成它自己的形狀；記號每單位 0.76dp、放在正中間，卡片的每個角都在直徑 66dp 的圓裡，裁成圓形也不會切到。`ThemeTest` 核對底是 `token_bg`、前景畫的記號和啟動畫面的 `splash_mark.xml` 相同，台灣的每一點和卡片的四個角都在那個圓裡
- 沒有單色的那一層（`<monochrome>`）：手機設成用主題色的圖示時，這個 app 照樣顯示原本的顏色
- `test/AppIcon.java` 照 `launcher_mark.xml` 放記號的位置（和台灣的輪廓，卡片照 `web/src/ui/logo.ts` 寫在程式裡）畫出 iOS 的圖示（1024×1024、沒有透明度，寫進 `ios/App/Assets.xcassets/`），和 Google Play 商店頁的兩張圖：圖示（512×512、32 位元 PNG）、主題圖片（1024×500、24 位元 PNG，記號加「島民證明」，名稱從 `design/copy/app.json` 的 `splash.name` 讀、用 `design/fonts/` 的源流明體）。只用 JDK，改了記號或 `launcher_mark.xml` 之後在程式庫的根目錄手動跑；建置和部署都不跑它。商店的兩張由營運者自己換上 Play Console：

  ```sh
  java android/test/AppIcon.java android/test-output/store
  ```

## 讀卡

`app/src/main/kotlin/tw/iamreal/app/card/`：`Card.kt` 是過卡看到的介面，用 NFC 讀真卡片的是這三個檔：

- **`NfcCard.kt`：系統的讀卡模式。** 只有一次感應在等卡片或用著卡片、而且 app 的畫面在前景時，讀卡模式才開著（`NfcAdapter.enableReaderMode`，只收 NFC-A 和 NFC-B，不讀 NDEF）；其他時候貼上卡片，app 不讀。app 切到背景時關掉，回到前景、感應還在等時再打開。等 60 秒沒有卡片，那一次感應就是「沒有感應到卡片」。手機沒有 NFC 或 NFC 關著，不等，直接停下來
- **`GpkiCard.kt`：送給卡片的指令。** 每一次感應：選卡片上的簽章應用程式（沒有它、但有第一代卡片的主檔和 `5030` 目錄的，是第一代的卡片，停下來，不送別的指令）；不用 PIN 讀金鑰和憑證的目錄、每一張憑證；建立安全通道，再送兩道加密的「選擇檔案」，卡片接受了才算讀完。所以通道建立不起來的卡片停在第 2 步，持卡人還沒輸入 PIN。上游只在簽章時建立通道（讀憑證不需要它），iOS 的 app 照上游，第 1 次感應不建；這裡三次都建，是為了讓這種卡片在輸入 PIN 之前就停下來（[#365](https://github.com/iamreal-tw/iamreal/issues/365)）。第 2 次、第 3 次感應才建立不起來的話，PIN 沒有送出、丟掉：第 3 步要重新輸入，第 5 步只能回到開頭（`flow/CardProof.kt` 的 `ENDS_AT_LAST_TAP`）。之後在同一個通道裡送 PIN、讓卡片簽章。PIN 不是 6 到 10 個可列印的 ASCII 字元時，沒有卡片會收：第 3 步不出現面板、不送，PIN 丟掉（`app_pin.pin_format`，`SecureChannel.pinBlock` 的規則）。PIN 只送一次：那一道指令原樣送一次，卡片回的不是成功就停下來，不重送，也不接著要回應（別的指令遇到 `61XX`、`6CXX` 會）；送 PIN 的那一道指令途中卡片離開，不知道卡片收到沒有，也不重送（`PIN_MAYBE_SENT`，第 3 步要重新輸入 PIN）。按了面板上的「取消」，在下一道指令之前停下，不會停在一道指令的中間
- **`SecureChannel.kt`：安全通道的計算**（`spec/card-channel.md`）。卡片的通道金鑰由寫在程式裡的金鑰素材和卡片的識別碼算出來；卡片回的驗證碼和算出來的不同，就不回送認證、不送 PIN。加密計數器每一道指令都加一，沒有資料的也算

這三個檔裡出自上游的兩個（`GpkiCard.kt`、`SecureChannel.kt`），檔頭第一行寫出處：`mctea01/my-Bonds-fork-android` 的 `GpkiCard.kt`，釘在 commit `a8696253`（`spec/card-channel.md`、`NOTICE`）。只讀第二代的卡片：第一代的程式和它的金鑰都不在 app 裡。

卡片會停下來的情況和畫面上的句子在 `design/copy/card-proof.md` 第 2 步的「app」；哪一個原因說哪一句在 `ui/Messages.kt`。

### 真卡片的測試清單

讀卡的指令只有真卡片測得到（模擬器的測試用的是假卡片）。營運者用自己的卡片和手機照這份清單測，結果記在拉取請求上。用開發用 build（「怎麼用線裝到手機」）：連測試網站，簽的是測試的證明紀錄的場合字串，不會記進正式的證明紀錄。記下手機的型號和 Android 版本。

1. **三次感應的完整過卡**：第 1 步到第 8 步走完一次。第 2 步在按「感應卡片」之前先看示範，再照它做一次：卡片平貼在手機背面、沒有反應就慢慢上下移動，讀不讀得到，實際感應到的位置在哪裡（記下手機的型號和位置，#153）。每一次感應，面板依序是「把卡片貼在手機背面」、「讀取中」、「可以拿開卡片了」。第 6 步「打開你的島民證明」打開後是這次宣告的帳號
2. **中途拿開卡片**：第 2 步面板寫「讀取中」時拿開卡片，畫面寫「卡片在讀取途中離開了手機……」，按「再感應一次」可以讀完。第 5 步感應時面板寫「讀取中」就拿開，畫面寫「卡片在感應途中離開了手機。請再感應一次。」，按「再感應一次」不用再輸入 PIN 就能完成
   - 第 3 步按「確認卡片」，卡片一貼上、面板一變成「讀取中」就拿開。看拿開的時機，畫面寫兩種之一：「卡片在感應途中離開了手機。PIN 還在……」（PIN 還沒送出），或「感應在送出 PIN 的時候中斷了，不確定卡片有沒有收到。……」（PIN 欄位清空，要重新輸入）。記下是哪一句；兩種都不會自己再送一次 PIN
3. **輸入錯的 PIN 一次**：第 3 步故意輸入錯的 PIN，畫面寫「PIN 不正確。連續輸入錯誤三次，卡片會被鎖住。」，PIN 欄位清空。接著輸入正確的 PIN 過完：卡片的錯誤次數在正確的 PIN 之後歸零。**只錯一次**，錯三次卡片會被鎖住
4. **第二次感應換一張卡**：第 2 步讀卡片 A，第 3 步輸入 A 的 PIN 後感應另一張卡片 B。畫面寫「這不是剛才讀到的那張卡片，PIN 沒有送出。……」，PIN 還在，換回 A 再感應一次可以往下。B 最好是另一張自然人憑證（例如家人的）；沒有的話用別的 IC 卡（悠遊卡、金融卡），畫面寫「停在這裡」，同樣沒有送出 PIN。畫面要是寫成第一代的自然人憑證那一句，記下來：那是把別的卡認成了第一代
5. **通知被拒絕之後打開**（Android 13 以上的手機）：第 7 步按「開啟提醒」，系統問要不要允許通知時選不允許。畫面寫「沒有排提醒：手機不允許這個 app 發通知。……」，主按鈕是「打開通知設定」；按了是系統裡這個 app 的通知設定頁。在那裡允許通知，回到 app：畫面還是第 7 步，換成「這支手機會在 … 提醒你，大約三個月後。」和「下一步」，設定頁的「下次提醒」是同一天
6. 順手看的：第 2 步按「感應卡片」後按面板的「取消」，回到按下之前的畫面；手機的 NFC 關著時按「感應卡片」，畫面寫「手機的 NFC 關著。……」，「打開 NFC 設定」打開系統的 NFC 設定

測完回報：每一項過不過，不過的寫畫面上的句子。不傳有姓名的截圖（第 3 步的畫面有卡片上的姓名），不傳 PIN。

## 過卡提醒

照 [#93](https://github.com/iamreal-tw/iamreal/issues/93) 和 `design/copy/app.md`「過卡提醒」「設定」：

- **手機自己排，不經過伺服器。** 用系統的鬧鐘（`AlarmManager.setWindow`），到了就發一則本機通知。不是精確的鬧鐘：精確的鬧鐘從 Android 12 起要另一個權限（Android 14 起預設不給），提醒不需要準到分鐘。系統最多晚 10 分鐘送出；手機很久沒動、進了省電的休眠（Doze）時會更晚
- **存的只有四樣**：開著、間隔、時刻、下次提醒的日子（`shared_prefs/reminder.xml`）。關掉提醒就整個清空，所以關掉之後和從來沒開過一樣，第 7 步會再問一次；按「這次不要」也什麼都不存。不存帳號、短編號、連結、上次過卡日。過卡完成時，第 7 步拿記憶體裡這張卡片的憑證到期日和提醒的日子比，到期日不存
- **手機關著的時候到了**：系統的鬧鐘在手機重開時就忘了。重開時提醒的時刻在過去 24 小時內，就補發一次；超過 24 小時就等下次過卡。手機不存「發過了沒有」，所以發過之後 24 小時內重開機（包括手機自己在半夜重開），會再發一次
- **過卡完成、改了設定、按了「一週後再提醒我」**，都會收掉還掛著的通知：舊通知上的「一週後再提醒我」會蓋掉新排的日子。在「選間隔和時刻」只改時刻時，日子不變（選過的日子也一樣）；改了間隔、那一天的提醒已經來過、或新的時刻在那一天已經過了，才從今天重算
- **權限**：按「開啟提醒」才向系統要通知的權限（`POST_NOTIFICATIONS`，Android 13 起要問；之前的版本只看使用者有沒有關掉這個 app 的通知）。不允許的話什麼都不存，第 7 步寫出原因，主按鈕換成「打開通知設定」，開系統裡這個 app 的通知設定頁（`Settings.ACTION_APP_NOTIFICATION_SETTINGS`）；回到 app、畫面還在第 7 步時再查一次，允許了就照預設排好（`ReminderModel.backAtRemind`）。按「這次不要」或走到別的步之後就不再自己排。手機重開會忘掉鬧鐘，所以要被告知手機重開了（`RECEIVE_BOOT_COMPLETED`）；app 更新、換時區、每次打開 app 也重設一次
- **接收器不讓別的 app 叫**（`exported="false"`）：鬧鐘到了、通知上的「一週後再提醒我」、系統的三種廣播。打開 app 的畫面是對外開放的（主畫面要叫得到它），所以別的 app 也能用通知的那個方式打開它：得到的只有第 1 步上方那一段字
- **測試**：日子怎麼算、存什麼、關掉後留下什麼，是單元測試（`app/src/test/…/reminder/`，假的鬧鐘和記憶體裡的儲存）；第 7 步說哪幾句是 `RemindViewTest`，第 6、第 8 步是 `DoneViewTest`。模擬器上的過卡測試走過第 7 步的「這次不要」「開啟提醒」和提醒已經開著的樣子、選間隔和時刻、設定頁，把模擬器的時鐘撥到提醒的時刻，看通知的字、按「一週後再提醒我」、點通知進第 1 步，最後關掉提醒，確認 app 的儲存裡不剩提醒的東西

## 第 2 步的示範

第 2 步說明的下面是一段會動的示範（[#374](https://github.com/iamreal-tw/iamreal/issues/374)，`design/copy/card-proof.md`「示範」），取代原本的示意圖和圖說：手機正面朝著持卡人、全程不動，紅色的卡片從右邊滑到手機後面，上下慢慢找兩次，停在比中間高一點的地方，那一刻一個紅圈。被手機擋住的部分用紅色的虛線透出來。不畫手，不轉手機。每一支 Android 感應的位置不同，所以畫的是怎麼找，說明也換成引導移動卡片的那一句（`app_read.how_android`）。

- **時間表是 `design/motion/sense.json`**（`raw/sense_motion.json`）的 `variants.android`；算法 `ui/demo/SenseMotion.kt` 的 `senseStateAt` 是純函式，`SenseMotionTest` 讀 `spec/vectors/teaching-animation.json` 感應位置的每一個答案
- **畫面**是一個 `Canvas`（`ui/demo/SenseDemo.kt`），計時和第 6 步的示範共用（`ui/demo/DemoPlayer.kt`）
- **什麼時候播**：進到第 2 步就開始，播三輪後停在卡片貼好的那一格。下面同一顆按鈕（「停止」「再看一次」）。按了「感應卡片」，示範直接停在卡片貼好的那一格，不自己再動，感應中那顆按鈕不能按：面板出來時底下的畫面是靜的。從第 3 步按「上一步」回來是重新讀卡，示範也從頭播一次
- 系統關掉動畫時照樣播，對報讀器是一個元素、唸 `app_demo.sense_android`，和第 6 步的示範相同
- 模擬器上的過卡測試檢查：示範給報讀器的那一句、說明、按鈕的兩個字樣和 `design/copy/` 逐字相同；進到這一步時按鈕是「停止」，按了變成「再看一次」。加上 `IAMREAL_RECORD_SENSE=<檔名>.webm` 時另外錄一段

## 第 6 步的示範

第 6 步「複製證明連結」和打開個人檔案的按鈕下面，是一段會動的示範（[#373](https://github.com/iamreal-tw/iamreal/issues/373)，`design/copy/card-proof.md`「示範」）：五個示意畫面排成一列，鏡頭從按「複製證明連結」一路帶到個人檔案多出來的那一行，帳號和網址是這張島民證明自己的。和網頁 `/hang/<短編號>`、iOS 播的是同一段。

- **時間表是 `design/motion/hang.json`**，建置時原樣包進安裝檔（`raw/hang_motion.json`），app 不另外抄一份。Android 播的是回程按左上角 ✕ 的那一版（`variants.android`）
- **算法是純函式**（`ui/demo/HangMotion.kt` 的 `hangStateAt`）：給時間表和秒數，算出那一刻鏡頭在哪、哪個框被標出來、哪一顆被按著、六個畫面變化各走了幾成、現在是四步裡的哪一步。不計時、不碰畫面。`HangMotionTest` 讀 `spec/vectors/teaching-animation.json` 的每一個答案，和網頁、iOS 對的是同一份
- **畫面**（`ui/demo/HangDemo.kt`）用 Compose 自己的元件畫，不加程式庫：整列一個 `graphicsLayer`（位移加縮放），計時用系統給的每一格（`withFrameNanos`，`ui/demo/DemoPlayer.kt`）。五個畫面上的每個框都回報過位置之後才算鏡頭，在那之前整列看不見。示意畫面裡的長度和字級是固定的 dp，不跟系統的字級：帳號最長 30 個字時留在一行，放不下的在尾端截掉
- **什麼時候播**：大半張圖進到畫面時自己播一次，停在最後一格。下面一顆按鈕，播的時候是「停止」（直接到最後一格），停了或播完是「再看一次」。到第 7 步再回來不會從頭重播：播到一半離開的，回來接著播；app 切到背景的那段時間不算。播到哪一步，下面四步的字裡那一步標出來
- **系統關掉動畫時照樣播**（[#369](https://github.com/iamreal-tw/iamreal/issues/369) 維護者 2026-11-26 的留言）：這段動畫是自己照每一格的時間算的，系統的那個設定本來就管不到它，app 也不去問；看的人用「停止」停下來
- **對報讀器**整段示範是一個元素，唸 `app_demo.hang` 那一句；裡面畫的字不唸，四步的字照常唸
- **兩顆按鈕左右並排**，在示範上面，和示範的第一個畫面相同：「複製證明連結」和「打開 Threads」。第二顆寫短的字才排得進一行，它照舊打開這個帳號的個人檔案；對報讀器唸完整的「打開 @alice 的 Threads 個人檔案」。並排時每一顆只有一半寬，按鈕得長高才放得下字的時候（系統字級放大），改成上下排（`ui/Widgets.kt` 的 `SideBySide`）
- 模擬器上的過卡測試檢查：示範給報讀器的那一句、按鈕的兩個字樣和 `design/copy/` 逐字相同，按「停止」後變成「再看一次」，兩顆按鈕左右並排而且在示範上面，「打開 Threads」給報讀器的是帶帳號的那一句。加上 `IAMREAL_RECORD=<檔名>.webm` 時，另外把示範從頭播一次、用模擬器主機這一側的錄影存下來（模擬器裡的 `screenrecord` 讀不到畫面）

## 兩種 build

同一個 app 有兩種 build（ADR-0037），識別碼不同，可以同時裝在一支手機上：

| | 正式 app | 開發用 build |
|---|---|---|
| build type | `release` | `debug` |
| 識別碼 | `tw.iamreal.app` | `tw.iamreal.app.dev`（`applicationIdSuffix = ".dev"`） |
| 圖示下面的名稱（`design/copy/app.md`） | 島民證明 封測（`src/main/res/`） | 島民證明 dev（`src/debug/res/`） |
| 連哪裡 | 上線前：`https://test.iamreal.tw`、`https://test-data.iamreal.tw` | 同左，上線後也是 |
| 簽的場合字串 | 上線前：`iamreal-test:public:0` | 同左，上線後也是 |
| 怎麼裝 | Google Play 的內部測試（營運者手動觸發 [`upload-android.yml`](../.github/workflows/upload-android.yml) 上傳，ADR-0036、ADR-0037；「上傳到 Google Play」） | 用線裝（「怎麼用線裝到手機」） |
| 版本 | 上傳時給：台灣的日期（`2026.11.5`，同一天相同）；`versionCode` 是工作流程執行的編號 | `1`、`dev` |

環境寫死在 `app/src/main/kotlin/tw/iamreal/app/Environment.kt` 一個地方，兩種 build 共用；app 裡沒有切換的設定，後台也不能叫它換。Kotlin 呼叫核心時指定的證明紀錄永遠是這一份（`core/DeviceCore.kt`），所以 app 的程式拿不到正式的證明紀錄的場合字串。上線那天用一個 PR 讓商店的 build 改連正式網站；正式網站的設定現在還沒有。

第三種 build type `fake` 只給模擬器的測試（「模擬器上過一次卡」）：它是開發用 build 換上假卡片和本機的後台，識別碼 `tw.iamreal.app.dev.fake`、名稱和開發用 build 相同，不會上傳到任何地方。

## 上傳到 Google Play

商店的 build 只從 GitHub Actions 上傳（ADR-0036）：營運者在 `main` 上手動觸發 [`.github/workflows/upload-android.yml`](../.github/workflows/upload-android.yml)，它建置 `bundleRelease`（連 `build.gradle.kts` 的 bundle 檢查，「建置時的檢查」），用上傳金鑰簽章，傳到內部測試。簽章、上傳、版本號怎麼算，見 [`.github/README.md`「上傳 Android 的 app」](../.github/README.md#上傳-android-的-app175)。

版本由兩個 Gradle 屬性給：`-Piamreal.versionName=2026.11.21 -Piamreal.versionCode=42`（`app/build.gradle.kts`）。沒給的時候是 `1`、`dev`，所以這台電腦上的建置和拉取請求的檢查都是這兩個值。

## 商店頁的圖片

Google Play 商店頁的圖片（截圖是 [#489](https://github.com/iamreal-tw/iamreal/issues/489) 的第一版，圖示和主題圖片是 [#490](https://github.com/iamreal-tw/iamreal/issues/490) 的）。都由程式產生，在這台電腦上跑，產生的圖不進程式庫：營運者在 Play Console 的商店資訊上傳。改了 app 的排版、字、顏色之後重跑，換掉商店頁上的。

**手機截圖 4 張**：「模擬器上過一次卡」的測試加上 `IAMREAL_STORE_SCREENS=<目錄>`，在新宣告的那一次拍：

| 檔名 | 畫面 |
|---|---|
| `phone-1-read.png` | 第 2 步，感應的面板等著卡片 |
| `phone-2-pin.png` | 第 3 步，PIN 打好了（畫面上是圓點） |
| `phone-3-accounts.png` | 第 4 步，填了 `@alice` |
| `phone-4-done.png` | 第 8 步，完成和「分享到 Threads」 |

```
cd ../web
IAMREAL_STORE_SCREENS=$PWD/../android/test-output/store IAMREAL_BB=<bb 6.0.0 的路徑> node --experimental-strip-types test/app-backend.ts \
  first,refresh,switch,withdraw -- node --experimental-strip-types ../android/test/card-proof.ts
```

- 準備和「模擬器上過一次卡」相同（模擬器、`-skin 1080x2280`）；整個測試照樣跑完，截圖在途中拍。測試沒有全過時，圖照樣留著，但先看哪裡沒過再用
- 每一張是模擬器整個螢幕，和測試相同的大小：1080×2280、密度 420。Google Play 收的手機截圖是 JPEG 或 24 位元、沒有透明度的 PNG，每邊 320 到 3,840 像素、長邊不超過短邊 2.3 倍（[Add preview assets](https://support.google.com/googleplay/android-developer/answer/9866151)）。`screencap -p` 給的 PNG 有透明度，所以測試讀 `screencap` 的原始像素，自己寫成 RGB 的 PNG（`test/emulator.ts` 的 `screenshotRgb`），拍完逐張核對，不合就算沒過
- 拍的那一刻，系統的狀態列換成示範模式（Android 的 SystemUI demo mode）：時間固定 09:00、電池和訊號滿格、網路連上（測試關掉了模擬器的網路）、沒有通知的圖示。拍完換回來
- 畫面上的都是假資料：假卡片（姓名「測試用戶」）、帳號 `@alice`、本機後台給的島民編號。沒有真的姓名
- 測試的 build（`fake`）和發出去的 app 畫面是同一份程式；它連的是本機的後台，畫面上不出現網址

**圖示和主題圖片**（512×512、1024×500）：`test/AppIcon.java` 照 app 的圖示畫（「圖示」）。

## PIN、憑證、簽章在哪裡

要檢查它們有沒有離開手機，看這幾個檔：

| 東西 | 在哪裡 | 什麼時候清掉 |
|---|---|---|
| PIN | 輸入時在 `ui/Model.kt` 的 `PinField`（一個字元陣列，不是字串；輸入欄位裡只有圓點）。第二次感應成功後，`flow/CardProof.kt` 留一份位元組，等第三次感應。感應時 `card/GpkiCard.kt` 把它補成卡片要的 10 個位元組，在安全通道裡加密後送給卡片；補好的那一份送出後就蓋成零 | 第三次感應送出後、取消、停下來、卡片回 PIN 不正確、安全通道建立不起來、PIN 的第一個字輸入後滿 5 分鐘；都是蓋成零。5 分鐘的計時在 app 的行程裡：行程在背景被系統凍結時不會跑，回到 app 的那一刻補查 |
| 憑證 | 第一次感應讀到的幾張交給核心；選中的那一張 `CardProof` 留一份，第二、第三次感應拿來比對是不是同一張卡，**比對相同才把 PIN 交給卡片** | 算完證明、取消、停下來 |
| 卡片上的姓名 | 核心回給畫面，只顯示在輸入 PIN 的畫面 | 離開過卡時 |
| 兩個簽章 | `CardProof`，到算完證明為止 | 算完證明、取消、停下來 |

- **不寫磁碟。** 做到一半的過卡只在行程的記憶體裡（`MainActivity` 的 `model`）：不放進系統的狀態保存（`onSaveInstanceState` 交出去的是空的），不寫檔案。app 被系統結束就從第 1 步來
- **存下來的只有三樣**，都在 app 自己的偏好設定檔，不進備份：每把發證金鑰用過的最高清冊編號（`MainActivity.kt` 的 `StoredCrlNumbers`，清冊編號是公開的數字）；提醒開著時的四樣東西（`reminder/Phone.kt` 的 `PreferencesStorage`，「過卡提醒」）；過卡裝置編號和產生的日子（`MainActivity.kt` 的 `StoredDeviceId`，16 個隨機位元組，台灣的日期起算 31 天後換新的，舊的不留，`flow/Counts.kt`；ADR-0039）
- **連網路的只有 `backend/Backend.kt`**：後台的四個介面和清冊鏡像的兩種檔案，位置是建置時寫死的。拿題目的那一個請求（`POST /api/v1/challenges`）送出去之後回應的第一行沒有來時（連線被關，或等到逾時），再送一次，第二次還是沒有才寫「伺服器的回應不正確……（代碼 network）」（[#404](https://github.com/iamreal-tw/iamreal/issues/404)）：手機停在第 4、5 步的那幾分鐘，先前留著的連線可能已經不通了。多拿一個題目沒有副作用；送出紀錄的請求不自己重送。連不上伺服器（沒有網路）不重送。最壞的情況是等兩次逾時（各 30 秒）才看到那一句。`ChallengeAgainTest` 對這台電腦上一個手寫回應的伺服器測這幾種情況；模擬器上的過卡測試讓伺服器把一次題目的請求讀完就關掉連線，過卡照常走完。請求不帶 cookie。帶著手機的東西的只有兩種：計數（`POST /api/v1/counts`，見下一點）和送出一筆，送出一筆多帶過卡裝置編號（`device_id`，後台只記在連線紀錄，ADR-0022、ADR-0039）。送出去的內容由核心組，只有 `device_id` 是 `flow/CardProof.kt` 的 `withDeviceId` 加在核心組好的內文最前面（它不是證明的一部分，核心不經手）；核心在檢查都通過之前不算匿名編號（`device-core/README.md`「檢查都通過了」），所以這裡的程式順序寫錯時，帶著匿名編號的請求送不出去
- **計數**（`flow/Counts.kt`，`spec/counts.md`；ADR-0032、ADR-0039）：過卡到了表上的哪一步、停下來或要再試一次的原因代碼、感應中途卡片離開（第幾次感應）、下載清冊、建樹、算證明花了多久的分級。一筆一個請求，在另一條執行緒送，不等回應、送不出去不重送，過卡照常。每一筆帶 `client`（`android`）、嘗試編號（一次過卡一個，只在記憶體裡）、過卡裝置編號、系統版本（`Build.VERSION.RELEASE`）、app 版本（`versionName`）、手機型號（`Build.MODEL`，不是使用者替手機取的名字）；版本和型號不合格式的整個不送。內文由核心照步驟表組（`idc_count`），後台會丟掉的那一筆不送。原因是 `Counts.reasonOf` 從停下來的代碼選的，不帶例外、卡片、伺服器的任何文字，也沒有帳號、匿名編號、卡片上的值。停下來（過卡結束）和要再試一次（畫面在同一次過卡讓人再按，人太多被擋的卡片現況、題目、送出也是）分開送；送出被擋之後再送同一筆是動作 `resubmit`。`open` 在第 1 步出現時送。持卡人自己取消、呼叫的順序不對被拒絕（什麼都沒改變）都不送。不用 AAID、推播權杖，沒有第三方的分析（#94）
- **碰卡片的只有 `card/` 這一層**：一次感應是一次 `tap`，裡面先 `readCertificates`（不用 PIN），再 `sign`（帶 PIN）。發出去的 app 用 NFC 讀真卡片（「讀卡」）。要的權限多一個 `NFC`，它只讓 app 和貼在手機上的卡片說話
- 看島民證明、Threads 的個人檔案都是開瀏覽器（或 Threads 的 app），app 裡不載入任何網頁。第 1 步「還沒有自然人憑證，怎麼申辦？」裡的兩個連結也是交給別的 app（`design/copy/card-proof.md`「1. 開始之前」）：「找附近的戶政事務所」交給手機的地圖 app 搜尋「戶政事務所」（`geo:0,0?q=…`；手機上沒有 app 接這種網址時，改開地圖網站的同一個搜尋），另一個開內政部憑證管理中心的網站。這時還沒有讀卡，兩個都不帶任何過卡的資料；app 不要位置的權限，附近是地圖自己判斷的（`ui/Screens.kt` 的 `FIND_OFFICE_MAP`）。完成畫面的「分享」交給系統的分享面板，帶一句話（有後台回的順序號碼就寫「第 N 張」）和這張島民證明的網址

## 目錄

| 路徑 | 內容 |
|---|---|
| `app/src/main/kotlin/tw/iamreal/app/core/` | `DeviceCore`：Kotlin 呼叫核心的唯一入口，每個函式對應 `device-core/include/iamreal_device_core.h` 的一個 C 函式。失敗時丟 `DeviceCoreException`，裡面只有代碼 |
| `app/src/main/kotlin/tw/iamreal/app/flow/` | `CardProof`：一次過卡，沒有畫面，順序照 `web/src/flow.ts`；每一項檢查和計算都交給核心。`Counts`：計數和過卡裝置編號。`Platforms`：app 自己認得的平台（只有 Threads） |
| `app/src/main/kotlin/tw/iamreal/app/card/` | 「卡片」這一層：介面（`Card.kt`），和用 NFC 讀真卡片的三個檔（「讀卡」） |
| `app/src/main/kotlin/tw/iamreal/app/backend/` | 送給後台和清冊鏡像的請求 |
| `app/src/main/kotlin/tw/iamreal/app/reminder/` | 過卡提醒：下次提醒的日子怎麼算、存什麼（`Reminders.kt`），日子和時刻的寫法（`When.kt`），系統的鬧鐘、通知和接收器（`Phone.kt`） |
| `app/src/main/kotlin/tw/iamreal/app/ui/` | 啟動畫面和八步的畫面（Compose）、感應的面板、哪個情況顯示 `design/copy/` 的哪一句、主題的數值（`Theme.kt`）；提醒的畫面和設定頁（`Reminder.kt`） |
| `app/src/real/` | 發出去的安裝檔和用線裝的建置接到什麼（`Target.kt`）：測試網站、NFC 讀的卡片、核心自己的 session |
| `app/src/fake/` | 只給模擬器測試的建置（build type `fake`）：假卡片、本機的後台、認測試金鑰的 session |
| `app/src/testing/` | `TestingCore`：測試用的函式庫才有的那一個函式。只編進 `fake` 和單元測試 |
| `test/` | 模擬器上過卡的測試（Node），見「模擬器上過一次卡」；它也拍商店頁的截圖（「商店頁的圖片」）。畫 app 的圖示、商店頁的圖示和主題圖片的 `AppIcon.java`（「圖示」） |
| `jni/` | JNI 那一層（C）：把 `idc_` 的 C 函式包成 Kotlin 呼叫得到的函式。照 `device-core/README.md`「C 函式的慣例」釋放和清除；只呼叫 `idc_` 開頭的函式 |
| `build-native.sh` | 編 `device-core/` 的靜態函式庫，和 JNI 那一層連結成 `libiamreal_device_core_jni.so` |
| `fetch-zig.sh`、`zig.sha256` | 下載 Zig 0.15.1，核對 SHA-256 |
| `bundled.sha256` | 包進安裝檔的電路檔和驗證金鑰的 SHA-256。參數檔的在 `device-core/crs.sha256`，由 `device-core/fetch-crs.sh` 下載（和 iOS 共用） |
| `app/build.gradle.kts` | 識別碼、`minSdk`、函式庫和內建的檔案怎麼進安裝檔、建置時的檢查 |
| `gradle/verification-metadata.xml` | Gradle 下載的每個外掛和程式庫的 SHA-256 |

## 原生的函式庫

Aztec 給 Android 的 Barretenberg 靜態函式庫是用 Zig 0.15.1 編的（函式庫裡每個目的檔的 `.comment` 寫的是 zig-bootstrap 的 clang 20.1.2），用的是 LLVM 的 libc++（`std::__1`）。NDK 的 libc++ 是 `std::__ndk1`，兩者連結不起來（[#88](https://github.com/iamreal-tw/iamreal/issues/88)）。所以：

- `.so` 由同一版 Zig 連結，libc++ 靜態連進去。Zig 由 `fetch-zig.sh` 從 ziglang.org 下載，核對 `zig.sha256`（取自 ziglang.org 的下載頁）
- NDK 提供 Android 的 C 標頭檔和函式庫（sysroot），和一個 C 編譯器：`device-core/` 的套件裡只有 `blake3`（Noir 的 ACVM 帶進來的）有 C 和組合語言（SIMD 的部分），由 cc-rs 編。`build-native.sh` 把 NDK 的 `<target><minSdk>-clang` 和 `llvm-ar` 交給 cc-rs（`CC_<target>`、`AR_<target>`），這是 Rust 在 Android 上常見的設法，編出來的程式碼和 minSdk 一致。這段 C 沒有用到 C++，和上面 libc++ 的問題無關；最後的連結仍由 Zig 做
- `.so` 只開放 Java 執行環境要找的函式（`jni/exports.map`）：`JNI_OnLoad` 和 `DeviceCore` 的幾個（測試用的函式庫多 `TestingCore` 的一個）。Barretenberg 自己的 C 函式和 `idc_` 的函式都在裡面，但從 `.so` 外面呼叫不到
- 不連結 `liblog`
- 連結時加 `-z defs`：有函式沒人定義，連結就停，不會等到手機上載入才失敗
- 分頁對齊 16 KB（`max-page-size=16384`）
- JNI 那一層載入時比對 `idc_abi_version()` 和標頭檔的 `IDC_ABI_VERSION`，不同就不載入

發出去的安裝檔（release）只有 `arm64-v8a`。開發用 build（debug）多帶 `x86_64`，給 x86-64 電腦上的模擬器；Apple 晶片的 Mac 上，模擬器用的也是 `arm64-v8a`。

## minSdk：29（Android 10）

`minSdk` 是 NDK 和 Barretenberg 的 Android 函式庫要求的較高者（[#155](https://github.com/iamreal-tw/iamreal/issues/155)），不往上加：

| 來源 | 要求 | 依據 |
|---|---|---|
| NDK 29.0.14206865 | 21 | sysroot 裡最低的 API 是 21 |
| Barretenberg 6.0.0 的 Android 函式庫 | **29** | 它的執行緒區域變數用 ELF TLS（目的檔裡是 `R_AARCH64_TLSDESC_*` 的重定位，沒有 `__emutls` 的符號），連結出來的 `.so` 有 `PT_TLS` 區段。Android 從 API 29 才支援：「Android supports ELF TLS starting at API level 29」（[Android changes for NDK developers](https://android.googlesource.com/platform/bionic/+/HEAD/android-changes-for-ndk-developers.md)，「ELF TLS」，2026-11-20 讀） |

自己核對：

```
NDK=$ANDROID_HOME/ndk/29.0.14206865/toolchains/llvm/prebuilt/<darwin-x86_64 或 linux-x86_64>/bin
$NDK/llvm-readelf -r ../device-core/vendor/barretenberg/arm64-android/libbb-external.a | grep -c TLSDESC
$NDK/llvm-readelf -lW app/build/intermediates/merged_native_libs/release/mergeReleaseNativeLibs/out/lib/arm64-v8a/libiamreal_device_core_jni.so | grep TLS
```

量測時的實驗 app（#88）用 26 連結，但裡面的函式庫是同一份，要的同樣是 29；Android 9 以下沒有實際裝過。殼在 API 29 的模擬器（`arm64-v8a`）上跑過 debug 和 release 兩種建置。`x86_64` 的函式庫同樣有 `PT_TLS`，有編、有連結、有包進 debug 的安裝檔，但還沒有在 x86-64 的模擬器上載入過（這裡沒有那種電腦）。

`targetSdk` 和 `compileSdk` 是 36。

## 內建的檔案

電路檔、驗證金鑰、參數檔包進安裝檔（ADR-0035），在 `assets/` 底下：

| 檔案 | 從哪裡來 |
|---|---|
| `card_proof_rs2048.json`、`card_proof_rs4096.json` | `web/circuits/`（進版控的那兩份） |
| `card_proof_rs2048.vk`、`card_proof_rs4096.vk` | `verifier/vk/` |
| `bn254_g1_compressed_2p18.dat`（8 MiB）、`bn254_g2.dat` | `device-core/fetch-crs.sh` 從 Aztec 的 CDN 下載到 `device-core/vendor/crs/`，和 `web/scripts/fetch-crs.mjs` 抓的是同樣的檔案 |

`bundled.sha256` 和 `device-core/crs.sha256` 列出每一個的 SHA-256，數字和 `web/circuits/README.md`、`web/src/prover/artifacts.ts` 相同。建置時每個檔案先核對再複製（`bundleFiles`），做出安裝檔後再核對一次裡面的檔案（`checkApk`）。app 用它們之前，核心還會照寫死在 `device-core/` 的 SHA-256 再核對一次（ADR-0035）：讀完卡之後一次，算證明之前再一次。

`design/` 的五個檔建置時原樣複製進安裝檔的資源（`copyDesign`，清單是 `app/build.gradle.kts` 的 `designResources`），app 的程式裡沒有給人看的句子：

| 資源 | 來源 |
|---|---|
| `raw/card_proof_copy.json` | `design/copy/card-proof.json`：過卡畫面上的每一句話 |
| `raw/app_copy.json` | `design/copy/app.json`：只在 app 上、不屬於過卡的字 |
| `raw/hang_motion.json` | `design/motion/hang.json`：第 6 步示範的時間表（「第 6 步的示範」） |
| `raw/sense_motion.json` | `design/motion/sense.json`：第 2 步示範的時間表（「第 2 步的示範」） |
| `font/genryumin2tw_b.otf` | `design/fonts/GenRyuMin2TW-B.otf`：標題用的源流明體 TW 的子集 |

做出安裝檔後 `checkApk`、`checkBundle` 確認每一個都在 `res/` 裡，而且和程式庫裡的逐位元組相同。release 的 APK 把資源換成短的名稱（例如 `res/c7.otf`），所以照內容找，不照路徑。

## 建置時的檢查

`./gradlew build` 會跑；只做安裝檔時也會跑，不管做的是 APK（`assemble*`、`package*`）還是上傳到 Google Play 用的 bundle（`bundle*`，由 `checkBundle` 看 `.aab` 裡的 manifest、函式庫、內建的檔案和 dex，項目相同）。任何一項不過就失敗（`app/build.gradle.kts`）：

- **合併後的 manifest**（`checkManifest`）：識別碼不是這個 build type 該有的就失敗（`release` 是 `tw.iamreal.app`、`debug` 是 `tw.iamreal.app.dev`、`fake` 是 `tw.iamreal.app.dev.fake`，逐字寫在 `app/build.gradle.kts` 的 `ids`）；任何地方出現 `AD_ID` 就失敗；要的權限只能是 `app/build.gradle.kts` 裡 `allowedPermissions` 列的：網路（`INTERNET`）、讀卡（`NFC`；沒有 NFC 的手機也裝得上，`uses-feature` 寫 `required="false"`）、提醒的通知（`POST_NOTIFICATIONS`）、手機重開時被告知（`RECEIVE_BOOT_COMPLETED`，「過卡提醒」），加上 `androidx.core` 替 app 自己宣告、只有這個 app 拿得到的那一個（`<識別碼>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`）；別的 app 叫得到的元件只能是 app 的那一個畫面。`AndroidManifest.xml` 另外寫了移除 `AD_ID`，之後有程式庫帶進來也會被拿掉；畫面的程式庫帶進來、app 一打開就會自己做的兩件事也在那裡拿掉：找 emoji 字型（手機上有 Google Play services 時會去問它）、安裝啟動用的 profile 和讓開發工具觸發它的接收器
- **安裝檔**（`checkApk`）：原生的函式庫只有我們的那一個，release 只有 `arm64-v8a`；`assets/` 裡的檔案和兩份清單完全相同，不多不少；`.so` 沒有連結 `liblog`。Compose 帶進來的 `androidx.graphics:graphics-path` 有自己的一個原生函式庫（Android 13 以前走訪路徑的線段用的），打包時排除掉；畫面畫的路徑（記號、打勾）只交給系統去畫，不走訪它的線段，模擬器的測試走過每一個畫面。程式庫帶的啟動用 profile 也不放進去
- **沒有假卡片、不認測試的發證金鑰**（`checkApk`）：debug 和 release 的 dex 裡出現 `tw/iamreal/app/fake/` 或 `TestingCore`，或 `.so` 裡有測試用函式庫的記號（`device-core/prover/src/lib.rs` 的 `IDC_TESTING_MARK`），就失敗。這兩樣只在 build type `fake` 裡
- **上線前只連測試網站**（`checkApk`）：`debug` 和 `release` 的 dex 裡沒有測試網站的網址（`https://test.iamreal.tw`）就失敗；任何一種 build 的 dex 裡出現正式網站的網址（`//iamreal.tw`、`//data.iamreal.tw`）或正式的證明紀錄的場合字串（`iamreal:public:`）就失敗。場合字串本身不在 Kotlin 裡，由核心照代表哪一份證明紀錄的數字給；單元測試核對核心給這個 app 的是 `spec/vectors/scope.json` 裡測試的證明紀錄的那一條。`.so` 裡兩份證明紀錄的場合字串都有（核心是同一份），Kotlin 只傳得出測試的證明紀錄的數字
- **release build 不輸出 log**：R8 拿掉對 `android.util.Log`、`PrintStream` 的 `print`／`println`、`java.util.logging.Logger` 的 `log` 的呼叫（`app/proguard-rules.pro`；後兩種是 Compose 和 `androidx.concurrent` 裡的幾處警告）。之後 `checkApk` 讀 release 的 dex 裡每一個被呼叫的方法：還提到 `android.util.Log`，或還有呼叫 `java.io.PrintStream` 的任何方法、`java.util.logging.Logger` 除了 `getLogger` 以外的方法、任何 `printStackTrace`，就失敗。留下來的是讀了沒用的 `System.out` 和做了沒用的 `Logger`：R8 拿不掉，但沒有東西寫得出去
- **沒有第三方 SDK**（`checkLibraries`）：app 帶的程式庫只能是 `app/build.gradle.kts` 裡 `allowedLibraries` 逐一列名的：Kotlin 的標準函式庫和它引用的標註，畫面用的 Jetpack Compose（`ui`、`foundation`）和 `androidx.activity`，以及這三個帶進來的（都是 Google 的 AndroidX 和 JetBrains 的 kotlinx，見「工具和套件」）。清單以外的一律不過，以檔案加進來的 jar、aar 也算。沒有 Google Play services，沒有 Material 元件

這些檢查看的是寫錯和不小心加進來的東西。它們看不到的：Android 系統自己寫的 log（app 當掉時系統會記下例外的堆疊；核心的例外只有代碼）、C 函式庫的 `syslog`（Barretenberg 連結到它，在 libc 裡，拿不掉）、`.so` 裡的程式用系統呼叫直接做的事。`.so` 向 libc 要的函式裡有 `syslog`、`fprintf`、`socket`、`connect`（Barretenberg 和 libc++ 帶進來的），app 沒有網路的權限時 `socket` 連不出去。

安裝檔裡另外有 AGP 自己放的兩個小檔：`META-INF/com/android/build/gradle/app-metadata.properties`（AGP 的版本）和 `META-INF/version-control-info.textproto`（建置時的 git 提交）。

## 工具和套件

版本都釘死，選發布滿 7 天的（`CONTRIBUTING.md`「套件」）。

| 東西 | 版本 | 發布 | 釘在哪裡 |
|---|---|---|---|
| Gradle | 9.9.1 | 2026-11-10 | `gradle/wrapper/gradle-wrapper.properties`，連發行檔的 SHA-256；`gradle-wrapper.jar` 的 SHA-256 由 `worker/test/workflows.test.ts` 核對 |
| Android Gradle Plugin | 9.5.1 | 2026-11-05 | `build.gradle.kts` |
| Kotlin（Gradle 外掛和標準函式庫） | 2.4.21 | 2026-10-08 | `build.gradle.kts` |
| Compose 的編譯器外掛（`org.jetbrains.kotlin.plugin.compose`，跟著 Kotlin 發布） | 2.4.21 | 2026-10-08 | `build.gradle.kts` |
| `androidx.compose.ui:ui`、`androidx.compose.foundation:foundation`（畫面） | 1.11.4 | 2026-07-01 | `app/build.gradle.kts` |
| `androidx.activity:activity`（讓畫面接上 Compose 的那個 `ComponentActivity`） | 1.13.0 | 2026-03-11 | `app/build.gradle.kts` |
| JUnit（只在測試） | 4.13.2 | 2021-02-13 | `app/build.gradle.kts` |
| `org.json:json`（只在測試：在 JVM 上讀 `spec/vectors/`；Android 內建同一套 JSON） | 20260814 | 2026-08-14 | `app/build.gradle.kts` |
| Zig | 0.15.1 | 2025-08-19 | `fetch-zig.sh`、`zig.sha256` |
| Android NDK | 29.0.14206865 | | `app/build.gradle.kts` |
| Android SDK：`build-tools;36.0.0`、`platforms;android-36` | | | `app/build.gradle.kts` |
| Rust、Barretenberg | 見 `device-core/README.md` | | |

Compose 用 1.11.4，不是最新的 1.13.0：1.12 起要用 Android 17 的 SDK（`compileSdk` 37）編，這裡的 `compileSdk` 是 36。沒有用 Compose 的 BOM、Material 元件、`activity-compose`：畫面只用 `foundation` 的基本元件自己畫按鈕和欄位。上面三個帶進來 60 幾個套件（`androidx.*` 的 lifecycle、savedstate、core、collection、annotation 等，`kotlinx-coroutines`、`kotlinx-serialization-core`，以及 `com.google.guava:listenablefuture`、`org.jspecify:jspecify` 兩個只有標註和介面的小套件），每一個的名稱都列在 `allowedLibraries`，版本和 SHA-256 在 `gradle/verification-metadata.xml`；`./gradlew :app:dependencies --configuration releaseRuntimeClasspath` 印得出解析到的版本。

Gradle 下載的每一個檔案（外掛、它們帶進來的套件、測試的程式庫）都照 `gradle/verification-metadata.xml` 核對 SHA-256，清單上沒有的不用。它相當於其他目錄的 lockfile。改版本之後重寫它：

```
./gradlew --write-verification-metadata sha256 clean build
```

寫出來的清單只有這台機器下載過的檔案。`aapt2` 每種作業系統一個檔，在 Mac 上重寫之後要補回 Linux 的那一筆（`aapt2-<版本>-linux.jar`，從 Google 的 Maven 下載後算 SHA-256），反過來也一樣；改動要逐行看。

## 怎麼單獨建置

需要：JDK 17、Android SDK（`ANDROID_HOME` 指到它，上表的 NDK、build-tools、platform 裝好）、rustup、`curl`、一個 C 編譯器。Linux 另外要 LLVM 的 libc++（`libc++-dev`、`libc++abi-dev`）。不需要手機、卡片、後台、Node、Go。

```
cd device-core && rustup target add aarch64-linux-android x86_64-linux-android && ./fetch-crs.sh && cd ../android
./gradlew build
```

`build` 做的事：

1. `build-native.sh` 編 `device-core/`（它會叫 `device-core/fetch-barretenberg.sh` 和 `fetch-zig.sh`，各自核對 SHA-256），連結 `.so`
2. 做出三個安裝檔：`app/build/outputs/apk/debug/app-debug.apk`、`app/build/outputs/apk/release/app-release-unsigned.apk`（沒有簽章；簽章和上傳在 GitHub Actions，ADR-0036），和只給模擬器測試的 `app/build/outputs/apk/fake/app-fake.apk`（識別碼 `tw.iamreal.app.dev.fake`，不會上傳到任何地方）
3. 跑單元測試、lint、上面的檢查

拉取請求的檢查（`.github/workflows/checks.yml` 的 `android`）在 Linux 上跑的就是這幾行。

### 測試

`./gradlew test`。測試在這台機器的 JVM 上跑，不需要模擬器：`build-native.sh host` 把同一份 Rust 和同一份 JNI 的程式編成這台機器的函式庫，Kotlin 的 `DeviceCore` 載入它。測試讀 `spec/vectors/` 的標準答案，不複製。`SubmitAnswerTest` 對著本機只答一次的假後台送出：201 的內文中途斷線或超過 1 MiB 時，`Backend.submit` 給沒有位元組、不是 `network`，交給核心讀是「什麼都沒說」（完成畫面只說記下了，#264）。`PausedTest`、`PausedViewTest` 測停止收過卡（#394）：`config` 說 `paused` 時第 2 步在讀卡之前停下；`challenges`、`records` 對著本機的假後台回 `503` `paused` 時，畫面是 `stops.paused`，只給重新開始。第 1 步每次打開（和回到 app 時）都再問一次 `config`，用來在讀卡之前說停止收過卡。`BusyTest`、`BusyViewTest` 測人太多（ADR-0026，#419），對著本機的假後台，被擋的請求照後台的樣子回 `429` `rate_limited` 或 `503` `busy`：按第 1 步的「下一步」時問一次帶開始記號的 `config?start`，被擋時過卡停在這裡，不感應卡片。接著讀卡時再問一次不帶記號的 `config`（「再感應一次卡片」開始的過卡不經過第 1 步，也是問這一次），被擋時用按「下一步」時拿到的那一份，和網頁相同；那一份讀不懂時沒有可以用的，停在讀卡之前。卡片現況、題目、送出被擋時過卡不結束：`BusyTest` 用 `spec/vectors/` 的一張卡片（測試的發證金鑰）和測試用的核心走完一次過卡，三個請求各被擋一次、各再送一次，卡片總共感應三次、交出 PIN 兩次，再送的卡片現況和紀錄和第一次逐位元組相同。`BusyViewTest` 檢查這三處的句子是 `stops.too_many`、按鈕是「再試一次」，送出被擋時不是「送出失敗」那一句。`AppNameTest` 讀 `design/copy/app.md`，核對正式 app 和開發用 build 圖示下面的名稱各自和它寫的相同、`app.json` 的名稱是三種 app 各一個（測試 app 的是給 #483 的建置用的），三個名稱都不同。`AppCopyTest` 核對 `design/copy/app.md` 和 `app.json` 雙向逐字相同：JSON 的每一個值是 Markdown 某個程式碼區塊的一行，那些區塊的每一行也都是 JSON 的一個值。`SecureChannelTest` 跑 `spec/vectors/card-channel.json` 的每一案（假的金鑰素材）。`GpkiCardTest` 對一張在測試裡模擬的卡片送指令：卡片那一端照 `spec/card-channel.md` 核對每一道加密指令的 MAC、用它自己數的計數器解密，所以計數器少算一道指令，下一道就被拒絕；測的是通道建立不起來時不回送認證、不送 PIN，第一代的卡片停下來，PIN 被拒絕或卡片在送 PIN 時離開都不重送，「取消」在下一道指令之前停下。app 寫在程式裡的金鑰素材是不是真卡片的，只有真卡片測得出來（「真卡片的測試清單」）。`CountsTest` 測計數（`flow/Counts.kt`）：過卡裝置編號照 `spec/vectors/counts.json` 的 `device_ids` 換（規則在核心，`idc_count_device_id`）、一筆計數帶什麼不帶什麼、版本和型號不合格式的拿掉、每一步只送一次、停下來之後不再送、伺服器的代碼表上沒有的送 `server_other`、送不出去時過卡照常；`CardProof` 停下來的每一種都有表上的原因（核心組得出內文才算），第 2 步感應的每一種失敗送的是 stop、retry 還是感應中途掉線的動作，`config` 停止收過卡、沒有回應、版本太舊各送什麼。`RecordedCounts` 是測試記下計數的那一份。`ThemeTest` 讀 `design/tokens.json`，核對 `ui/Theme.kt` 和 `res/values/colors.xml`（視窗和 Android 12 起系統的啟動畫面用的顏色）寫的每一個數值和同名的那一個相同，並核對 app 的圖示（「圖示」）。

這台機器的函式庫是測試用的那一種（`build-native.sh` 的 `test-issuers`：`device-core/` 開 cargo feature `test-issuers`，多一個收測試發證金鑰開 session 的函式 `idc_testing_session_open`，其餘和 app 連結的相同）：標準答案裡的憑證是測試金鑰簽的，不是內政部簽的。`SessionTest` 用它拿 `circuit-inputs.json` 的一張卡片從 Kotlin 走完一次過卡在核心裡的每一步：檢查憑證、選清冊和檢查清冊、建樹、核對內建的檔案、查現況的請求和短編號、算證明和送出的請求，並跑 `list-consequence.json`、`card-status.json` 的每一案。`AnswerTest` 跑 `records-response.json` 的每一案：送出後後台的回應由核心讀（`idc_records_response`），app 拿到的 `seq`、雜湊、每個平台記成什麼、和確認畫面不同的平台，和標準答案相同。`DoneViewTest` 檢查完成畫面說哪幾句（`design/copy/card-proof.json` 的哪幾個鍵）：小卡、掛到個人檔案、還可以做的那幾句，第一筆紀錄、全部收回、超過一個平台時各不同的地方；以及對後台的回應：和確認時相同、讀不出每個平台記成什麼（標題「證明紀錄已經記下這次過卡」、日期和說明原因的那一句；那一句 `design/copy/card-proof.md` 寫了 app 的寫法還沒有定，先用網頁的，和 iOS 相同）、別的卡片也宣告了同一個帳號、和確認時不同的每一種。後台是誠實的時候模擬器上遇不到最後一種，所以在這裡測。

測到的：Kotlin 到 JNI 到核心這條路的每一個函式、代碼變成例外、傳進去的位元組呼叫後沒有被改、app 自己開的 session 不認測試金鑰。測不到的：Android 上的 `.so`（Zig 連結的那一個）和畫面。那兩樣由下面模擬器的測試看。

### 模擬器上過一次卡

`test/card-proof.ts`：在模擬器上照持卡人的方式（點按、打字）走完八步，四次：新宣告（填帳號的欄位）、再次過卡（「更新島民證明」），隔天更換（「改成別的帳號」）、收回（「收回對 @bob 的宣告」）。形狀照 `web/test/worker-card-proof.ts`，把瀏覽器換成模擬器。

- **後台和卡片的金鑰是 `web/test/app-backend.ts` 的**（Android 和 iOS 的測試共用）：它起本機的 Worker（`worker/test/harness.ts` 的測試建置：測試的發證金鑰、假的內政部、可調的時鐘），用 `web/test/fixtures` 當場產生卡片的金鑰和憑證，寫成 `web/test-output/app/backend.json`，再把這裡的測試當成它的指令跑起來。這裡的測試只讀那個檔、講 HTTP，不引用 `web/`、`worker/` 的程式
- **卡片是假的**：`app/src/fake/…/FakeCard.kt`，用那把測試金鑰簽章。每一次感應向測試問「現在貼上來的是哪一張卡」，所以測試決定什麼時候貼卡、貼哪一張
- **app 是 build type `fake`**：`src/fake/` 換掉 `src/real/`（假卡片、連 `127.0.0.1:18169`、認測試金鑰的 session），原生函式庫是測試用的那一種。其他的程式和發出去的 app 是同一份
- 測試關掉模擬器的網路，只把模擬器的 18169 埠轉到本機的伺服器（`adb reverse`）：app 連得到的只有它。第 6 步打開 Threads 個人檔案的瀏覽器因此不會真的連出去
- 第 1 步的「找附近的戶政事務所」：看系統打開的網址是地圖的搜尋。模擬器上沒有地圖 app，所以測到的是改開地圖網站的那一條路；交給地圖 app 的那一條要在真手機上按一次
- 第 4 步：沒有宣告時什麼都不填按「下一步」不往下；「改成別的帳號」之後欄位是空的，空的按「下一步」不往下，「不改了」回到原本的畫面；第 5 步按「上一步」回到剛才那個畫面，欄位照剛才填的
- 送出之後的三步：第一次是完整的第 6 步，再次過卡是短版（按「重新掛上連結」換成完整的），收回直接到第 8 步。第 6 步的按鈕：複製證明連結、打開 Threads 的個人檔案和這張島民證明（看系統打開的網址）。第 8 步的「分享到 Threads」叫出系統的分享面板，面板上顯示的分享內容是帶順序號碼的那一句（號碼和 Worker 上那一頁寫的相同）和這張島民證明的網址；「上一步」回到第 7 步，「完成」回到第 1 步
- 沒測到的：系統不允許通知的那個畫面和「打開通知設定」。模擬器是 Android 10，不會問通知的權限；那一句是單元測試（`RemindViewTest`），整條路在真手機上走（「真卡片的測試清單」）
- 畫面用 `uiautomator dump` 讀，預期的每一句從 `design/copy/card-proof.json` 讀，逐字比對
- 第二、第三次感應各貼一次「該放簽章憑證的位置是另一張憑證」的卡：畫面說不是同一張卡，假卡片沒有被交到 PIN
- 第二、第三次感應各貼一次「安全通道建立不起來」的卡（[#365](https://github.com/iamreal-tw/iamreal/issues/365)）：假卡片沒有被交到 PIN。第 3 步 PIN 欄位清空，按鈕是「上一步」「確認卡片」，沒有重新輸入就按不會出現面板；第 5 步只有「回到開頭」
- 過卡被打斷的每一種（[#171](https://github.com/iamreal-tw/iamreal/issues/171)），都在第一筆紀錄之前：假卡片在讀取途中、送 PIN 的那一刻、接受 PIN 之後離開；錯的 PIN；第 2 步之後 NFC 被關掉；切到背景再回來；把模擬器的時鐘調快 6 分鐘再回到 app（回到第 1 步，最上面寫原因，PIN 要重新輸入）；`am force-stop` 之後重開（從第 1 步來）。每一種都數假卡片被交到幾次 PIN：送 PIN 時掉線之後 app 不會自己再送
- 最低版本：測試改寫後台 `config` 的 `min_app` 再交給 app（測試的 build 是 1）。起算日是明天時第 1 步最上面有提醒和開 Google Play 的按鈕，照常能往下；畫面停在第 1 步、把模擬器的時鐘調到起算日，第 2 步在等卡片之前就換成「這一版不能過卡了」；起算日是今天時一打開就是那個畫面，沒有「下一步」。`min_app` 讀不懂、`config` 沒有回應：第 2 步在等卡片之前停下，寫網頁版的那一句
- 沒有 NFC 的手機：假卡片在感應時說沒有 NFC，和 app 一打開就問到沒有，兩條路都換成「這支手機不能感應卡片」
- 隔天的兩次：把後台的時鐘和模擬器的時鐘都調到明天（測試結束時把模擬器的調回來）
- 計數（[#433](https://github.com/iamreal-tw/iamreal/issues/433)）：測試中間那台伺服器記下 app 送的每一筆計數和每一次送出的 `device_id`，最後核對：每一筆是 Android 的、只有表上的欄位，沒有帳號、短編號、PIN、姓名、憑證；系統版本是模擬器的 10，fake 的 build 版本是 `dev`、不合格式所以不帶；過完卡的四次各送了每一步一次（從 `open` 到 `done`）和三個計時的步驟；被打斷的那幾種送了對的原因和感應中途掉線的動作；每一次送出都帶著計數的過卡裝置編號。app 存的檔多一個 `card_proof_device_id.xml`，裡面只有一個編號和它的日期
- 停止收過卡（[#394](https://github.com/iamreal-tw/iamreal/issues/394)、[#402](https://github.com/iamreal-tw/iamreal/issues/402)），在新宣告之前：`app-backend.ts` 的 `PUT /__app-test/paused` 切換後台的 `CARD_PROOFS_PAUSED`。停止時打開 app，第 1 步是 `before.paused` 那一句、沒有「下一步」；恢復後回到 app，「下一步」回來了。走到第 5 步才停止：拿題目回 `paused`（卡片沒有被交到 PIN），和題目拿到了、卡片簽了才停止而送出回 `paused`，兩次都停在那一項，寫 `stops.paused` 和請求編號，只有「回到開頭」，回到的第 1 步寫停止的那一句。恢復之後的新宣告就是「恢復之後走得完」，所以證明紀錄還是那四筆
- 人太多（ADR-0026，[#419](https://github.com/iamreal-tw/iamreal/issues/419)），在再次過卡的那一次：測試的伺服器把指定的請求照後台被擋時的樣子回（`429` `rate_limited` 或 `503` `busy`，`Retry-After`），不交給後台。回到 app 時第 1 步問的 `config` 被擋：第 1 步照常有「下一步」，沒有人太多的那一句。按「下一步」時的 `config?start` 被擋（`503` `busy`、`429` `rate_limited` 各一次）：停在第 1 步，`before.busy` 在「下一步」上面，app 沒有等卡片。接著讀卡時不帶記號的 `config` 被擋：照樣讀卡。卡片簽完後查現況被擋：PIN 欄位下面是 `stops.too_many`，按鈕是「再試一次」「上一步」，按「再試一次」直接到第 4 步，卡片沒有再感應、沒有再交出 PIN。拿題目被擋、送出被擋：停在那一項，`stops.too_many`，按鈕是「再試一次」和「取消」；拿題目的「再試一次」之後才感應最後一次，送出的「再試一次」不再感應。整次過卡照樣感應三次
- 這裡的測試全過之後，`app-backend.ts` 讓 Worker 在下一個午夜公布證明紀錄，抄下資料桶，用 Go 的 `iamreal-verify`（帶 `iamrealtest` 標籤建置，才收測試的發證金鑰）和原生的 `bb` 重驗：四筆紀錄都有效，每一筆的種類是新宣告、再次過卡、更換、收回
- 截圖留在 `test-output/screens/`。加上 `IAMREAL_DESIGN_SCREENS=<目錄>` 時，另外在那個目錄拍 `design/screens/` 的那幾張（`app-splash-phone.png`、`card-proof-app-*`），大小照 `design/screens/README.md`：拍的時候把模擬器的螢幕暫時換成 390 dp 寬、一個像素一個 dp，拍完換回來。裁切用 macOS 的 `sips`，所以這個選項只在 Mac 上用

```
(cd ../worker && pnpm install)                                                  # app-backend.ts 要它們的套件
$ANDROID_HOME/emulator/emulator -avd iamreal-api29 -skin 1080x2280 -no-window &  # 見下面「模擬器」
cd ../web && pnpm install
IAMREAL_BB=<bb 6.0.0 的路徑> node --experimental-strip-types test/app-backend.ts \
  first,refresh,switch,withdraw -- node --experimental-strip-types ../android/test/card-proof.ts
```

需要 Node 22、go、`bb` 6.0.0（`verifier/README.md`）、一個開著的模擬器。**測試只對模擬器下指令**：每一道 `adb` 都帶模擬器的序號（`test/emulator.ts`，不是 `emulator-<數字>` 的序號不收），接著線的手機不會被碰到。同時開著幾個模擬器時用 `IAMREAL_EMULATOR=emulator-5554` 指定。拉取請求的檢查不跑這一個（那裡沒有模擬器）。

它不測的：會讓過卡停下來的每一種情況（[#171](https://github.com/iamreal-tw/iamreal/issues/171)），和真卡片的指令（營運者用真卡片照「真卡片的測試清單」測）。

## 怎麼用線裝到手機

裝的是開發用 build（`debug`，識別碼 `tw.iamreal.app.dev`），簽的是這台電腦上 Android 開發用的金鑰，不是商店的那一把。它和從 Google Play 裝的商店 build 識別碼不同，兩個可以同時留在手機上。ADR-0037 的「少數測試者拿開發用 build 的安裝檔」還沒有做：那要一把固定的簽章金鑰（和商店的無關），不是每台電腦各自的開發用金鑰。

1. 手機：設定裡打開「開發人員選項」和「USB 偵錯」，接上線，在手機上允許這台電腦
2. `$ANDROID_HOME/platform-tools/adb devices` 看得到手機
3. 安裝並打開：

   ```
   ./gradlew assembleDebug
   $ANDROID_HOME/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk
   $ANDROID_HOME/platform-tools/adb shell am start -n tw.iamreal.app.dev/tw.iamreal.app.MainActivity
   ```

打開是過卡的第 1 步。真卡片怎麼測，見「真卡片的測試清單」。

同時接著手機、開著模擬器時，`adb` 要用 `-s <序號>` 指定裝到哪一個。

### 模擬器

```
sdkmanager "emulator" "system-images;android-29;default;arm64-v8a"    # x86-64 的電腦用 x86_64
avdmanager create avd -n iamreal-api29 -k "system-images;android-29;default;arm64-v8a"
$ANDROID_HOME/emulator/emulator -avd iamreal-api29 -skin 1080x2280
```

模擬器的時區要是 `Asia/Taipei`（不是的話在模擬器的設定裡改）：過卡測試把模擬器的時鐘撥到提醒的晚上 9:00，用的是台灣的時間，時區不對時測試一開始就停。

`-skin 1080x2280` 不能省。`avdmanager` 建的 AVD 預設螢幕是 320x640、密度 160；`test/card-proof.ts` 把密度設成手機常見的 420 之後，第 2 步的畫面只放得下標題和一段說明，「感應卡片」在畫面外，捲也捲不到，測試就停在那裡。`adb shell wm size` 只能放大到實體螢幕的兩倍，補不回來，所以要在啟動時給螢幕的大小。

之後和手機相同，`adb -s emulator-5554 install …`。要在模擬器上看 release 的建置，先用一把隨便產生的金鑰簽它（`apksigner sign`），沒有簽章的安裝檔裝不上去。

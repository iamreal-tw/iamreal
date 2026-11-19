# iPhone 用 NFC 讀 ISO 7816 的卡片：要宣告什麼、有哪些限制

對應 issue #85。這一份只查文件，沒有實測；實測是另一張票。

- 查證日期：2026-11-19。下面每個網址都是這一天讀到的內容。
- 來源以 Apple 的官方文件為主：developer.apple.com 的 Core NFC 文件、WWDC 的講稿、帳號說明、審查準則，以及 Xcode 27.2（iOS 27.2 SDK）裡 `CoreNFC.framework/Headers/` 的標頭檔註解。
- 每一項的標記：
  - 【一手】Apple 的文件、講稿或 SDK 標頭檔裡寫明的。
  - 【推論】從一手資料推出來的，或來源不是 Apple（開發者論壇的使用者回報、第三方程式庫）。要靠實測確認。
  - 【查不到】在上面那些 Apple 來源裡找過，沒有寫。

要做的事：一次過卡要 SELECT 卡片上的應用程式、建立安全通道、VERIFY PIN、做兩次 RSA-2048 簽章。卡片是 ISO 14443 Type A、ISO 7816-4。

## 結論

| 問題 | 答案 | 標記 |
|---|---|---|
| 要哪些宣告 | entitlement `com.apple.developer.nfc.readersession.formats` 含 `TAG`；`Info.plist` 要有 `NFCReaderUsageDescription` 和 `com.apple.developer.nfc.readersession.iso7816.select-identifiers` | 一手 |
| AID 怎麼宣告 | 寫成十六進位字串的陣列，放在 `Info.plist`。沒列在裡面的 AID，用名稱 SELECT 會被系統擋下 | 一手 |
| 能宣告幾個 | 文件沒有寫上限。公開的程式庫裡有宣告 22 個的 | 查不到／推論 |
| 哪些 AID 不能選 | 文件只寫「和支付有關的」不支援，沒有公布清單 | 一手（原則）／查不到（清單） |
| 卡片管理員的 AID 在不在限制裡 | Apple 的文件沒有提。有公開的程式庫把 `A000000151000000` 列進宣告；也有使用者回報另一個 AID 被擋 | 查不到／推論 |
| 一次讀取最長多久 | 60 秒 | 一手 |
| 和卡片的連線最長多久 | Apple 的文件沒有寫。論壇上有使用者回報大約 20 秒會斷，沒有 Apple 的回覆 | 查不到／推論 |
| 整個流程放不放得進去 | 文件答不了，要實測 | 推論 |
| 機型和版本 | iOS 13.0 起；iPhone 7 之後的機型 | 一手 |
| 超過 255 個位元組的指令 | API 接受，Lc 最大 65535、Le 最大 65536。卡片收不收是卡片的事 | 一手／推論 |
| 免費帳號 | 不能。NFC Tag Reading 只開放給付費的兩種開發者計畫 | 一手 |
| 送審的額外要求 | 審查準則全文沒有出現 NFC。適用一般規定：用途說明字串、提供審查需要的硬體或資源 | 一手 |
| 公開的例子 | 有：電子護照、德國身分證、愛沙尼亞身分證（PIN 加簽章）、YubiKey（PIV 和安全通道） | 見最後一節 |

## 1. entitlement 和 Info.plist

**要三樣東西。**【一手】

1. Entitlement `com.apple.developer.nfc.readersession.formats`，值是字串陣列，文件列出的可能值是 `TAG`：「Allows read and write access to a tag using NFCTagReaderSession.」在 Xcode 開啟「Near Field Communication Tag Reading」這個 capability 就會加上。
   來源：<https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.nfc.readersession.formats>
2. `Info.plist` 的 `NFCReaderUsageDescription`，非空字串：「You're required to provide this key if your app uses APIs that access the NFC hardware.」沒有這一項就去讀卡，app 會結束（「If the app attempts to read a tag without providing this key and string, the app exits.」）。
   來源：<https://developer.apple.com/documentation/bundleresources/information-property-list/nfcreaderusagedescription>、<https://developer.apple.com/documentation/corenfc/building-an-nfc-tag-reader-app>
3. `Info.plist` 的 `com.apple.developer.nfc.readersession.iso7816.select-identifiers`，字串陣列，「A list of application identifiers that the app supports.」iOS 13.0 起。
   來源：<https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.nfc.readersession.iso7816.select-identifiers>

`NFCTagReaderSession` 的說明把前兩樣列為必要，第三樣是讀 ISO 7816 卡片時要加的。
來源：<https://developer.apple.com/documentation/corenfc/nfctagreadersession>

**缺了會怎樣。**【一手】SDK 標頭檔 `NFCISO7816Tag.h`：缺 entitlement，或 AID 清單裡「does not contain at least one valid entry」，session 會以 `NFCReaderErrorSecurityViolation` 結束。`NFCError.h` 對這個錯誤的說明是「Missing required entitlement and/or privacy settings from the client app.」

**`PACE` 這個值用不到。**【一手】標頭檔 `NFCTagReaderSession.h` 寫明只有用 `NFCPollingPACE` 才需要在 entitlement 加 `PACE`。PACE 是電子護照和歐洲身分證用的協定。

**app extension 不能用。**【一手】「Core NFC isn't available for use in app extensions」。
來源：<https://developer.apple.com/documentation/corenfc>

## 2. AID 怎麼宣告、系統怎麼用這份清單

**系統偵測到卡片時，照清單的順序逐一 SELECT，第一個成功的就交給 app。**【一手】

> When the session discovers a compatible ISO 7816 tag, the session performs a `SELECT` command for each application identifier provided in [the Info.plist key]. The `SELECT` command searches for the identifiers in the order in which they appear in the array. The session calls the `tagReaderSession:didDetectTags:` delegate method after the first successful `SELECT` command. The `initialSelectedAID` property of the found tag contains the selected identifier.

來源：<https://developer.apple.com/documentation/corenfc/nfciso7816tag>

從這段話可以知道三件事：

- 清單裡一個都選不到的卡片，app 完全收不到通知。標頭檔 `NFCISO7816Tag.h`：「Tag will not be returned to the NFCTagReaderSessionDelegate if no application described in [the key] is found.」【一手】
- app 拿到卡片時，卡片上已經選好一個應用程式，是哪一個看 `initialSelectedAID`。【一手】
- 清單的順序決定先選到誰。要讓系統一開始就選到要用的那個應用程式，把它排在第一個。【推論】

**之後 app 自己送的 SELECT 也受這份清單限制。**【一手】

> When you send a `SELECT` command with a `p1Parameter` value of `0x04`, your app must support one of the applications listed in the [Info.plist key]. Otherwise, the `completionHandler` receives an `NFCReaderError.Code.readerErrorSecurityViolation` error.

來源：<https://developer.apple.com/documentation/corenfc/nfciso7816tag/sendcommand(apdu:completionhandler:)>

WWDC 2019 的講稿說法相同：收到卡片後「you're free to go ahead and select any other AID listed in your info.plist file」。
來源：<https://developer.apple.com/videos/play/wwdc2019/715/>

所以流程裡每一個要用名稱 SELECT 的應用程式都要先列進去。如果建立安全通道之前要選的應用程式和簽章用的不是同一個，兩個都要列。【推論】

**iOS 26.4 起可以在執行時從清單裡挑一部分。**【一手】`NFCTagReaderSession.Configuration` 的 `iso7816SelectIdentifiers`：「Entries must be specified in "com.apple.developer.nfc.readersession.iso7816.select-identifiers" in Info.plist; all unknown / not matched entries will be dropped. An empty array indicates all applications specified in Info.plist will be used.」只能縮小，不能加入 `Info.plist` 沒有的 AID。原本的 `init(pollingOption:delegate:queue:)` 在 26.4 標為 deprecated。
來源：<https://developer.apple.com/documentation/corenfc/nfctagreadersession/configuration/iso7816selectidentifiers>、<https://developer.apple.com/documentation/corenfc/nfctagreadersession/init(pollingoption:delegate:queue:)>

**能宣告幾個。**【查不到】上面那些頁面和標頭檔都沒有寫數量上限。公開的程式庫裡有宣告 22 個 AID 的 `Info.plist`（見第 7 節 zkpassport），那個數字只能說明有人這樣寫，不能說明系統的上限。

**AID 的寫法（長度、能不能只寫前綴、有沒有萬用字元）。**【查不到】Apple 的文件沒有寫。WWDC 2019 的講稿只對 FeliCa 的 system code 明說不接受萬用字元，對 ISO 7816 的 AID 沒有說。

## 3. 哪些 AID 不能選

**和支付有關的 AID 不支援。**【一手】

> `NFCTagReaderSession` doesn't support selection of payment-related application IDs. In the European Union (EU), you can use `NFCPaymentTagReaderSession`, as described in that class's documentation.

來源：<https://developer.apple.com/documentation/corenfc/nfctagreadersession>

WWDC 2019：「for the time being, reading payment cards will not be supported」。
來源：<https://developer.apple.com/videos/play/wwdc2019/715/>

`NFCPaymentTagReaderSession`（iOS 26.0 起）只在歐盟可用，使用者的帳號和裝置都要在歐盟，另外要申請 entitlement。和這個專案無關。
來源：<https://developer.apple.com/documentation/corenfc/nfcpaymenttagreadersession>

**哪些 AID 算「和支付有關」。**【查不到】Apple 沒有公布清單，也沒有說明是比對完整的 AID 還是前綴。

**GlobalPlatform 卡片管理員的 AID 在不在限制裡。**【查不到】Apple 的文件、講稿、標頭檔都沒有提到卡片管理員或 GlobalPlatform。手上只有兩個不是 Apple 的線索，方向相反：

- 【推論】Yubico 的官方 SDK 文件要開發者把 `A000000151000000`（文件上的註解是「Security Domain」）列進這份清單，用途是在 iPhone 上經 NFC 建立安全通道。這表示至少有一家廠商公開以這個 AID 能被選到為前提來寫 SDK。
  來源：<https://github.com/Yubico/yubikit-swift/blob/e19212f2efbca9af280e57542e669885de5acdc1/YubiKit/YubiKit/YubiKit.docc/Resources/GettingStarted.md>（第 55–60 行）
- 【推論】Apple 開發者論壇 2019 年 9 月的一串討論裡，有使用者回報卡片管理員的 AID 是 `A000000003000000` 時，列進清單後系統偵測不到卡片，自己送 SELECT 得到 `NFCError Code=2 "Missing required entitlement"`；把卡片上那個應用程式改成別的 AID 之後可以選。這串討論沒有 Apple 人員回覆，原因沒有被證實。
  來源：<https://developer.apple.com/forums/thread/122314>

這兩個 AID 的前五個位元組不同。被擋的那一個和支付卡組織的 AID 共用開頭，這可能是原因，但只是猜測。這張卡片實際要選的 AID 能不能選，要在實測的票上用實機確認：把 AID 列進清單，看 `didDetect` 有沒有被呼叫、SELECT 回什麼。

## 4. 時間上限

**一個 session 最長 60 秒。**【一手】

- WWDC 2020：「Core NFC allows an app to read an NFC tag in a session lasting up to 60 seconds.」
  來源：<https://developer.apple.com/videos/play/wwdc2020/10209/>
- SDK 標頭檔 `NFCNDEFReaderSession.h`：「An opened session has a 60 seconds time limit restriction after -beginSession is called; -readerSession:didInvalidateWithError: will return NFCReaderSessionInvalidationErrorSessionTimeout error when the time limit is reached.」

要注意兩點：

- 標頭檔裡寫出 60 秒的是 `NFCNDEFReaderSession` 和 `NFCVASReaderSession`。`NFCTagReaderSession.h` 自己沒有寫秒數，網頁文件也沒有。`NFCTagReaderSession` 適用同一個 60 秒，依據是 WWDC 2020 那句不分 session 種類的話。【推論】
- 時間從呼叫 `begin()` 起算，不是從碰到卡片起算。使用者找感應位置花的時間也算在裡面。【一手，依標頭檔的「after -beginSession is called」】

**和卡片連上之後能維持多久。**【查不到】Apple 的文件只寫「A tag stays connected until your app connects to a different tag or restarts polling」，沒有寫時間上限。
來源：<https://developer.apple.com/documentation/corenfc/nfctagreadersession/connect(to:completionhandler:)>

【推論】Apple 開發者論壇上有一串 2019 年 6 月開始的討論，標題是「NFC Tag Connection has only 20 seconds timeout」：使用者回報對 ISO 7816 卡片連續送 APDU，大約 20 秒後收到 `Code=100 "Tag connection lost"` 或 `Code=201 "Session timeout"`。到 2022 年還有人回報同樣的情況。整串沒有 Apple 人員回覆，沒有被證實，也沒有被否認。
來源：<https://developer.apple.com/forums/thread/118922>

**其他會讓 session 結束的情況。**【一手】

- app 進到背景：`NFCReaderSessionInvalidationErrorSessionTerminatedUnexpectedly`（`NFCNDEFReaderSession.h`）。
- 使用者按了系統畫面上的取消：`NFCReaderSessionInvalidationErrorUserCanceled`。
- 系統同時只允許一個 reader session。網頁文件說其他的 session 會排隊，先進先出；標頭檔 `NFCNDEFReaderSession.h` 說會收到 `NFCReaderSessionInvalidationErrorSystemIsBusy`。兩處說法不一致，以實測為準。
  來源：<https://developer.apple.com/documentation/corenfc/nfctagreadersession>
- session 結束後不能重用，要建新的。重新建立之後卡片的狀態從頭開始。
  來源：<https://developer.apple.com/documentation/corenfc/nfctagreadersession/restartpolling()>

**session 進行中，畫面上是系統的讀卡面板。**【一手】標頭檔：「A modal system UI will present once -beginSession is called」。app 能改的是面板上的一行文字（`alertMessage`），和結束時的錯誤訊息（`invalidate(errorMessage:)`）。
來源：<https://developer.apple.com/documentation/corenfc/nfcreadersessionprotocol/alertmessage>

**一次過卡放不放得進去。**【推論】文件答不了這一題。能確定的只有：

- 整個流程（選應用程式、建立安全通道、驗 PIN、兩次簽章）要在同一個 session 裡做完，上限是 60 秒，從面板出現起算。
- 如果論壇回報的 20 秒屬實，卡片連上後的時間更短。
- 這張卡片做一次 RSA-2048 簽章要多久、建立安全通道來回幾次，Apple 的文件不會有，要實測。
- 兩次簽章之間如果要讓使用者在 app 的畫面上看內容、做決定，那段時間 session 得一直開著（卡片不能離開，時間照算），或是結束 session、之後再開一個新的，重做選應用程式、建立安全通道和驗 PIN。兩種做法的代價要在實測的票和流程設計上一起看。

## 5. 機型、版本、長指令

**版本。**【一手】`NFCTagReaderSession`、`NFCISO7816Tag`、`NFCISO7816APDU` 都是 iOS 13.0 起。回傳 `Result` 的 `sendCommand(apdu:resultHandler:)` 和 `NFCISO7816ResponseAPDU` 是 iOS 14.0 起。
來源：<https://developer.apple.com/documentation/corenfc/nfctagreadersession>、<https://developer.apple.com/documentation/corenfc/nfciso7816tag/sendcommand(apdu:resulthandler:)>

**機型。**【一手】WWDC 2019 講到 ISO 7816 等原生協定時：「all this is available on iPhone 7 and later phones」。WWDC 2020：「This has been supported on iPhones since the iPhone 7.」
來源：<https://developer.apple.com/videos/play/wwdc2019/715/>、<https://developer.apple.com/videos/play/wwdc2020/10209/>

網頁文件沒有機型表，只要求執行時檢查：「Before creating a reader session, always check the `readingAvailable` property」。
來源：<https://developer.apple.com/documentation/corenfc/nfcreadersession-swift.class/readingavailable>

文件的平台欄也列了 iPadOS 13.0 和 Mac Catalyst，但哪些 iPad 有讀卡的硬體，文件沒有寫。【查不到】

**Type A。**【一手】輪詢選項 `.iso14443`：「The option for detecting ISO 7816-compatible and MIFARE tags. Supports NFC type A and B modulation.」
來源：<https://developer.apple.com/documentation/corenfc/nfctagreadersession/pollingoption/iso14443>

**長指令（extended length APDU）。**【一手】API 接受：

- `NFCISO7816APDU.init(instructionClass:…:data:expectedResponseLength:)` 的 `expectedResponseLength`：「A length between 1 and 65536 inclusively」；「256 to send `00` as the short Le field value, assuming the data field is less than 256 bytes」；「65536 to send `0000` as the extended Le field」；-1 表示不帶 Le。
- 標頭檔 `NFCISO7816Tag.h`：「The Lc value is generated base on the size of the data object; possible value ranges from 1 to 65535 inclusively.」
- 要自己決定每個位元組時，用 `init(data:)` 傳整個 APDU。
- 錯誤碼 `readerTransceiveErrorPacketTooLong`（iOS 14.0 起）：「The packet length exceeds the limit supported by the tag.」

來源：<https://developer.apple.com/documentation/corenfc/nfciso7816apdu/init(instructionclass:instructioncode:p1parameter:p2parameter:data:expectedresponselength:)>、<https://developer.apple.com/documentation/corenfc/nfcreadererror-swift.struct/code/readertransceiveerrorpackettoolong>

【推論】所以 iPhone 這一端可以送資料超過 255 個位元組的指令。卡片支不支援長指令是卡片的事，Apple 的文件不會寫。RSA-2048 的簽章是 256 個位元組，短格式的 Le 送 `00` 就收得下，回應不需要長格式；送進去的資料如果不超過 255 個位元組，整個流程用短格式就夠。實際的指令長度在實測的票上確認。

## 6. 開發者帳號和送審

**免費帳號不能開這個功能。**【一手】Apple 的「Supported capabilities (iOS)」表格有三欄：ADP（付費的 Apple Developer Program）、ADEP（付費的企業計畫）、Apple Developer（免費，只同意開發者協議）。「Near Field Communication (NFC) Tag Reading」這一列，ADP 和 ADEP 有打勾，Apple Developer 那一欄是空的。同一張表裡免費帳號有打勾的例子：App groups、HealthKit、Keychain sharing。
來源：<https://developer.apple.com/help/account/reference/supported-capabilities-ios>

這表示連在自己的手機上試都需要付費的開發者計畫。實測的票要先確認帳號。

**送審。**【一手】App Store Review Guidelines（頁面上的日期是 2026-10-16）全文搜尋不到「NFC」或「Near Field」，沒有針對 NFC 的條文。適用的是一般規定：

- 2.1(a)：送審的版本要完整、能用；需要登入才能用的功能要給審查人員示範用的帳號。
- 「Before you submit」一節：要提供「any other hardware or resources that might be needed to review your app (such as login credentials or a sample QR code)」，並且「Include detailed explanations of non-obvious features … in the App Review notes, including supporting documentation where appropriate」。
- `NFCReaderUsageDescription` 的用途說明字串（第 1 節）。

來源：<https://developer.apple.com/app-store/review/guidelines/>

【推論】審查人員手上不會有這張卡片，也不會有 PIN。照上面的一般規定，審查備註要說明這個功能需要實體卡片、怎麼在沒有卡片的情況下看到流程。Apple 實際會要求什麼（例如示範影片），準則裡沒有針對 NFC 寫，要送審時才知道。

**宣告了特定的 AID，審查會不會問。**【查不到】準則沒有提。

## 7. 公開程式庫的例子

下面每一個都只看了宣告和少數幾行程式，沒有執行。連結固定在查證當天各程式庫預設分支最新的 commit。「宣告了」只代表檔案裡這樣寫；用這份宣告的版本有沒有通過 App Store 審查，從程式庫看不出來。

| 程式庫 | 讀什麼 | entitlement `formats` | 宣告的 AID |
|---|---|---|---|
| [AndyQ/NFCPassportReader](https://github.com/AndyQ/NFCPassportReader) | 電子護照 | `TAG` | `A0000002471001`、`A0000002472001`、`00000000000000` |
| [selfxyz/self](https://github.com/selfxyz/self) | 電子護照 | `PACE`、`TAG` | 同上三個 |
| [zkpassport/mobile-app](https://github.com/zkpassport/mobile-app) | 電子護照和其他證件 | `TAG` | 22 個，含 `A000000151000000`、`D2760000850101` |
| [Governikus/AusweisApp](https://github.com/Governikus/AusweisApp) | 德國身分證 | `TAG` | `E80704007F00070302` |
| [open-eid/MOPP-iOS](https://github.com/open-eid/MOPP-iOS) | 愛沙尼亞身分證，PIN 加簽章 | `TAG` | `A000000077010800070000FE00000100`、`A0000000181002030000000000000001` |
| [Yubico/yubikit-ios](https://github.com/Yubico/yubikit-ios)、[Yubico/yubikit-swift](https://github.com/Yubico/yubikit-swift) | YubiKey（含 PIV 和安全通道） | `TAG`（swift 版的範例另有 `NDEF`） | 見下 |

檔案位置：

- AndyQ/NFCPassportReader（commit `e52a401e`）：[`Examples/Example_SPM/NFCPassportReaderApp/Info.plist`](https://github.com/AndyQ/NFCPassportReader/blob/e52a401e3651c2e898adcc31e3e059e224813bcc/Examples/Example_SPM/NFCPassportReaderApp/Info.plist)、同目錄的 `NFCPassportReader.entitlements`。`Sources/NFCPassportReader/PassportReader.swift` 用 `NFCTagReaderSession(pollingOption: [.iso14443], …)`，並且處理 `readerSessionInvalidationErrorSessionTimeout`。
- selfxyz/self（commit `be761b35`）：[`app/ios/Self/Info.plist`](https://github.com/selfxyz/self/blob/be761b35e69d85e48dd1c6f3eca7422a4ae43add/app/ios/Self/Info.plist)、[`app/ios/Self/Self.entitlements`](https://github.com/selfxyz/self/blob/be761b35e69d85e48dd1c6f3eca7422a4ae43add/app/ios/Self/Self.entitlements)。
- zkpassport/mobile-app（commit `c52f5ef1`）：[`ios/zkpassportmobileapp/Info.plist`](https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/ios/zkpassportmobileapp/Info.plist)（第 335–358 行）、同目錄的 `zkpassportmobileapp.entitlements`。
- Governikus/AusweisApp（commit `794c5f52`）：[`resources/packaging/ios/Info.plist.in`](https://github.com/Governikus/AusweisApp/blob/794c5f52a8ca253b060103d10d6e65dba435dcaf/resources/packaging/ios/Info.plist.in)、同目錄的 `AusweisApp.entitlements`。
- open-eid/MOPP-iOS（commit `98700b1a`）：[`MoppApp/MoppApp/Info.plist`](https://github.com/open-eid/MOPP-iOS/blob/98700b1a9f5a4ff15246f8ca5a6e254b9ad3aad9/MoppApp/MoppApp/Info.plist)（第 1021–1025 行）、`MoppApp/MoppApp/MoppApp.entitlements`、[`MoppApp/MoppApp/NFCSignature.swift`](https://github.com/open-eid/MOPP-iOS/blob/98700b1a9f5a4ff15246f8ca5a6e254b9ad3aad9/MoppApp/MoppApp/NFCSignature.swift)。
- Yubico/yubikit-ios（commit `88f32cab`）：[`README.md`](https://github.com/Yubico/yubikit-ios/blob/88f32cabaa0ba96c426a2a45a9f4f487b1a82ae3/README.md)（第 146–153 行）、`YubiKitDemo/YubiKitDemo/Info.plist`。
- Yubico/yubikit-swift（commit `e19212f2`）：[`YubiKit/YubiKit/YubiKit.docc/Resources/GettingStarted.md`](https://github.com/Yubico/yubikit-swift/blob/e19212f2efbca9af280e57542e669885de5acdc1/YubiKit/YubiKit/YubiKit.docc/Resources/GettingStarted.md)、`Samples/OATHSample/OATHSample/Info.plist`、`YubiKit/YubiKit/SCP/SecurityDomainSession.swift`。

和這個專案最接近的兩個：

**open-eid/MOPP-iOS：在一個 session 裡驗 PIN 並簽章。** `NFCSignature.swift` 的 `createNFCSignature(can:pin:…)` 在呼叫之前就拿到 PIN，然後開 `NFCTagReaderSession(pollingOption: .iso14443, …)`，在同一個 session 裡建立卡片的保護通道、讀 PIN 的剩餘次數、呼叫 `calculateSignature(for:withPin2:)` 簽一次，最後 `session.invalidate()`。失敗時用 `session.invalidate(errorMessage:)` 把原因顯示在系統的面板上。它簽的是一次，不是兩次。

**Yubico 的 SDK：宣告了 PIV 和 Security Domain 的 AID。** 兩份 SDK 的文件都要開發者在 `Info.plist` 列出這些 AID（註解是 Yubico 文件上的原文）：

```
A000000527471117  // YubiKey Management Application
A0000006472F0001  // FIDO/U2F
A0000005272101    // OATH
A000000308        // PIV
A000000527200101  // YubiKey application/OTP
A000000151000000  // Security Domain
```

`A000000308` 只有 5 個位元組，是 PIV 應用程式 AID 的開頭。這份宣告如果照文件能用，表示清單裡可以寫比完整 AID 短的字串；這一點 Apple 的文件沒有寫（第 2 節），只能當線索。yubikit-swift 的文件另外提醒：「NFC connections are short-lived due to iOS timeout constraints. Perform operations quickly」，沒有寫秒數。

## 留給實測那張票的問題

文件答不了、要用實機確認的：

1. 這張卡片要用的每一個 AID 列進清單後，`didDetect` 有沒有被呼叫、之後的 SELECT 回什麼。
2. 卡片連上之後能撐多久：60 秒還是大約 20 秒。
3. 選應用程式、建立安全通道、驗 PIN、兩次簽章，在這張卡片上總共花多久。
4. 兩次簽章之間要不要結束 session。
5. 第二個 session 排隊還是直接失敗（第 4 節兩處文件說法不一致）。
6. 指令和回應的長度有沒有超過短格式。

## 查證方式

- Apple 的文件網頁要執行 JavaScript 才顯示內容。這裡讀的是同一頁背後的 JSON：把網址的 `https://developer.apple.com/documentation/…` 換成 `https://developer.apple.com/tutorials/data/documentation/….json`。引文和版本號都出自那份 JSON。
- 標頭檔在 `Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk/System/Library/Frameworks/CoreNFC.framework/Headers/`，Xcode 27.2（27B52）。
- 審查準則和能力表是把頁面抓下來做全文搜尋。
- 開發者論壇的兩串討論是使用者的回報，沒有 Apple 人員回覆，只列為線索。

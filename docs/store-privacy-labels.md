# 商店的隱私標示

App Store 的「App 隱私權」和 Google Play 的「資料安全性」，兩個 app（`android/`、`ios/`）各要填一份。這一份是填表的依據：app 送出什麼、在兩家各算哪一類、用途、連結與否，每一格對得到 ADR 或程式，和兩家的文件。

- 在兩家的後台照這一份填，是營運者的動作（[#161](https://github.com/iamreal-tw/iamreal/issues/161)、[#162](https://github.com/iamreal-tw/iamreal/issues/162)）
- **對外的承諾是 [`design/copy/privacy.md`](../design/copy/privacy.md)**，這一份跟著它。app 送的東西多一種、保存的期限改了，同一個 PR 改 ADR、隱私權說明和這一份（[#94](https://github.com/iamreal-tw/iamreal/issues/94) 第 8 點）
- **原則：兩家的文件答不出來的，往多報的方向填**（#94 第 7 點；那裡的理由是少報可能被下架，別人拿公開的程式來對也對得出來）。往多報填的每一格都標「多報」。有三項沒有照這個方向填，都寫明了為什麼、要多報時怎麼填：「[文件沒有回答的](#文件沒有回答的)」第 2、4、5 項
- 只管兩個 app。網頁版不經過商店，沒有標示；它收什麼寫在隱私權說明

**這張表照的是 ADR，不是現在的程式**（#274 的留言）。表裡標「還沒做」的，app 現在還沒有送；送審時 app 實際送什麼，就填到哪裡，見「[現在的程式做到哪裡](#現在的程式做到哪裡)」。

兩家文件的出處，讀的日期都是 2026-11-26：

- Apple：[App privacy details on the App Store](https://developer.apple.com/app-store/app-privacy-details/)，下面寫「Apple」加小節的名稱
- Google：[Provide information for Google Play's Data safety section](https://support.google.com/googleplay/android-developer/answer/10787469)，下面寫「Google」加小節的名稱

引號裡的英文是那兩頁的原文。

## 兩家怎麼定義「收集」

| | 原文 | 所以 |
|---|---|---|
| Apple（Data collection） | 「"Collect" refers to transmitting data off the device in a way that allows you and/or your third-party partners to access it for a period longer than what is necessary to service the transmitted request in real time.」 | 送出手機、而且存得比回應那一次請求久的才算 |
| Google（Data collection） | 「"Collect" means transmitting data from your app off a user's device.」 | 送出手機就算。例外是只在記憶體裡處理：「Processing data "ephemerally" means accessing and using it while the data is only stored in memory and retained for no longer than necessary to service the specific request in real-time.」 |
| 兩家 | Apple（Additional guidance）：「Data that is processed only on device is not "collected" and does not need to be disclosed in your answers.」Google（Not in scope for data collection）：只在手機上處理、沒有送出的資料「does not need to be disclosed」 | 沒有離開手機的不報 |
| Google（Data collection） | 「User data collected pseudonymously must be disclosed.」 | 隨機的編號也要報 |

**「連結」只有 Apple 問。** Apple（Data linked to the user）：每一類資料要答它是不是「linked to the user's identity (via their account, device, or other details)」；要算不連結，收集之前要先拿掉識別的東西，之後也不能「tie the data to other datasets that enable it to be linked to a particular user's identity」。Google 那一頁沒有這一題，表單問的是每一類資料是收集、分享還是兩者，和是必要還是使用者可以選（Data usage questions）。下面的表在 Google 那一欄寫「必要」或「可選」。

## 要報的

每一列是 app 送出手機的一種資料。「依據」是它為什麼存在、存多久；「狀態」是程式有了沒有。

| # | 資料 | 依據 | 狀態 | Apple：類別 | Apple：用途 | Apple：連結 | Google：類別 | Google：用途 | Google：必要 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 宣告的帳號（Threads 的帳號名稱）和島民編號（匿名編號）。寫進公開的證明紀錄，永久 | `spec/record.md`；隱私權說明第 4 段 | 有 | Identifiers › User ID | App Functionality | 是 | Personal info › User IDs | App functionality | 必要 |
| 2 | 沒有成功的送出的內容（帳號、島民編號、題目、證明），和 IP 記在連線紀錄的同一筆，31 天 | ADR-0022；隱私權說明第 5 段 | 還沒做（[#20](https://github.com/iamreal-tw/iamreal/issues/20)） | 同第 1 列：Identifiers › User ID | App Functionality | 是 | 同第 1 列：Personal info › User IDs | App functionality；Analytics（查問題） | 必要 |
| 3 | 送出時的 IP 位址，和從它得出的國家、網路業者的編號。連線紀錄，31 天；Cloudflare 自己的那一份也是 31 天 | ADR-0022；隱私權說明第 2、5、6 段 | 後台的連線紀錄還沒做（#20）；Cloudflare 的那一份現在就有 | Location › Coarse Location；Diagnostics › Other Diagnostic Data（多報） | App Functionality | 是 | Location › Approximate location | Fraud prevention, security, and compliance；Analytics（查問題） | 必要 |
| 4 | 送出的結果和錯誤代碼、請求編號、時間、寫成了第幾筆。連線紀錄，31 天 | ADR-0022；隱私權說明第 5 段 | 還沒做（#20） | Diagnostics › Other Diagnostic Data | App Functionality | 是 | App info and performance › Diagnostics | Analytics（查問題）；Fraud prevention, security, and compliance | 必要 |
| 5 | 過卡裝置編號：app 自己產生的隨機編號，31 天換一個。隨計數送出（明細 31 天，沒有 IP），也隨送出一筆的請求送出（和 IP、第幾筆記在連線紀錄的同一筆，31 天） | ADR-0039「三種編號」、ADR-0022；隱私權說明第 5、7 段 | 還沒做（[#433](https://github.com/iamreal-tw/iamreal/issues/433)、[#434](https://github.com/iamreal-tw/iamreal/issues/434)） | Identifiers › Device ID（多報） | Analytics；App Functionality | 是 | Device or other IDs（多報） | Analytics；Fraud prevention, security, and compliance | 必要 |
| 6 | 計數：過卡走到哪一步、按了哪些按鈕、感應中途掉線（第幾次感應）、客戶端是 Android 還是 iOS；把同一次過卡的各步接起來的嘗試編號。明細 31 天；加總永久，加總裡沒有編號 | ADR-0032「數什麼」、ADR-0039；隱私權說明第 7 段 | 還沒做（#433、#434） | Usage Data › Product Interaction | Analytics | 是 | App activity › App interactions | Analytics | 必要 |
| 7 | 計數：停下來時的錯誤代碼。明細 31 天，加總永久 | ADR-0032、ADR-0016；隱私權說明第 7 段 | 還沒做（#433、#434） | Diagnostics › Other Diagnostic Data | Analytics | 是 | App info and performance › Diagnostics | Analytics | 必要 |
| 8 | 計數：過卡的幾個步驟花了多久，分成寫死的幾級。明細 31 天，加總永久 | ADR-0032「數什麼」；隱私權說明第 7 段 | 還沒做（#433、#434） | Diagnostics › Performance Data | Analytics | 是 | App info and performance › Diagnostics | Analytics | 必要 |
| 9 | 計數：手機型號、系統版本、app 版本。明細 31 天；加總按月、人數少於 5 的不存 | ADR-0039「計數多帶的」；隱私權說明第 7 段 | 還沒做（#433、#434） | Diagnostics › Other Diagnostic Data（多報） | Analytics | 是 | App info and performance › Diagnostics（多報） | Analytics | 必要 |
| 10 | 隨每一筆送出、寫進公開的證明紀錄的其他欄位：題目、發證金鑰是第幾代、廢止清冊的樹根、證明。永久 | `spec/record.md`；隱私權說明第 4 段 | 有 | Other Data › Other Data Types（多報） | App Functionality | 是 | 沒有合適的類別，不報（下面第 4 項） | — | — |

各列的類別為什麼這樣選：

1. **帳號和島民編號。** Apple（Types of data › Identifiers）的 User ID 是「screen name, handle, account ID, assigned user ID, customer number, or other user- or account-level ID that can be used to identify a particular user or account」；Google（Data types › Personal info）的 User IDs 是「Identifiers that relate to an identifiable person. For example, an account ID, account number, or account name.」。帳號名稱本身就是；島民編號是一張卡片一個的編號，和帳號寫在同一筆，一起報。用途是服務本身：公開宣告就是這個 app 做的事。連結填「是」：帳號就是那個身分。
2. **沒有成功的送出**和第 1 列是同一種資料，多出來的是它沒有公開、連同 IP 留在營運者手上 31 天，用來重現問題。Apple 的 App Functionality 包括「minimize app crashes, improve scalability and performance, or perform customer support」；Google 的 Analytics 包括「to monitor app health, to diagnose and fix bugs or crashes」，所以 Google 多勾一個 Analytics。
3. **IP 位址。** 兩家都說照用途報。Apple（Additional guidance）：「Declare the relevant data types based on how you use IP address, such as precise location, coarse location, device ID, or diagnostics.」Google（Data types › Location）：「Approximate location that is inferred, such as via IP address or Access Point Name, must be disclosed here.」後台從 IP 得出國家和網路業者的編號，所以是概略的位置；IP 也用來查問題，Apple 多報一個 Diagnostics › Other Diagnostic Data。用途是限流、擋濫用的連線、查問題（ADR-0022），在 Apple 是 App Functionality（「prevent fraud, implement security measures」），在 Google 是 Fraud prevention, security, and compliance 加 Analytics。IP 當成「裝置的編號」的那一種用法這裡沒有，Device ID 另外因為第 5 列而報。
4. **送出的結果和錯誤代碼**是技術診斷：Apple 的 Other Diagnostic Data 是「Any other data collected for the purposes of measuring technical diagnostics related to the app」，Google 的 Diagnostics 是「Information about the performance of your app. For example battery life, loading time, latency, framerate, or any technical diagnostics.」。
5. **過卡裝置編號。** Apple 的 Device ID 是「Such as the device's advertising identifier, or other device-level ID」；Google 的 Device or other IDs 是「Identifiers that relate to an individual device, browser or app. For example, an IMEI number, MAC address, Widevine Device ID, Firebase installation ID, or advertising identifier.」。它不是系統給的編號，是 app 自己產生、31 天就換的；兩家的文件都沒有講這一種要不要報（下面第 1 項），照往多報填：它在 31 天內指的是同一份安裝，和 Google 舉的 Firebase installation ID 同一種。用途是看同一台裝置的幾次過卡（分析）和查濫用（ADR-0039）。連結填「是」：它和 IP、寫成了第幾筆記在連線紀錄的同一筆，從第幾筆對得到證明紀錄裡的帳號。
6. **計數的步驟和動作。** Apple 的 Product Interaction 是「app launches, taps, clicks, scrolling information … or other information about how the user interacts with the app」；Google 的 App interactions 是「Information about how a user interacts with the app. For example, the number of times they visit a page, screenshots taken, or sections they tap on.」。**連結填「是」，理由和 #94 不同**：#94 那時計數和 IP 存在同一筆；現在計數不存 IP（ADR-0032，2026-11-26 改），但每一筆帶著過卡裝置編號，而過卡裝置編號在連線紀錄裡對得到 IP 和帳號（第 5 列）。Apple 要算不連結，得在收集之前拿掉這種編號，之後也不能對得回去；這裡兩樣都不成立。對得到帳號的只有走到送出的裝置；沒有送出過的裝置，計數只連到那個編號，Apple 的「via their account, device, or other details」裡的 device 仍然算。第 7、8、9 列的連結是同一個理由。
   嘗試編號不另外報一類：它只認得一次過卡，隨這一列的計數送出（下面第 2 項）。
7. **停下來時的錯誤代碼**是技術診斷，類別同第 4 列。原因是卡片被廢止或暫時停用時，營運者看得出有一台裝置有這樣一張卡片，看不出是哪一張（ADR-0016；隱私權說明第 7 段）。
8. **花了多久。** Apple 的 Performance Data 是「Such as launch time, hang rate, or energy use」；Google 的 Diagnostics 舉的例子有「loading time, latency」。分成幾級而不是確切的時間，類別不變。
9. **手機型號、系統版本、app 版本。** 兩家的資料類別都沒有提到型號或系統版本（下面第 3 項）。它們是為了看哪些型號讀卡失敗而收的，照往多報填成技術診斷那一類。
10. **紀錄的其他欄位。** 兩家的類別沒有一類是它們（下面第 4 項）。Apple 有一類收其他的：Other Data Types 是「Any other data types not mentioned」，照往多報填；連結填「是」，它們和帳號在同一筆。Google 沒有這樣的一類。

## 兩家各自另外問的

| 題目 | 填 | 依據 |
|---|---|---|
| Apple：這些資料有沒有用來追蹤（Tracking） | 沒有，每一類都是 | Apple（Tracking）：追蹤是把 app 收的資料「with Third-Party Data for targeted advertising or advertising measurement purposes」連起來，或交給資料仲介。app 沒有廣告，不放 IDFA、AAID、`identifierForVendor`，沒有第三方的分析（ADR-0039，照 #94 第 3 點）；Android 的 manifest 移除了 `AD_ID` 的權限（`android/app/src/main/AndroidManifest.xml`） |
| Google：資料有沒有分享給第三方 | 沒有 | Google（Data sharing）列出不算分享的情形。**Cloudflare**：「Transferring user data to a "service provider" that processes it on behalf of the developer.」（隱私權說明第 6 段）。**寫進公開的證明紀錄**：「Transferring user data to a third party based on a specific user-initiated action, where the user reasonably expects the data to be shared」：宣告是持卡人自己在確認的畫面按下的，畫面寫明會公開。文件沒有直接講「公開」這一種（下面第 5 項）；這一格照 #94 填「沒有」 |
| Google：傳輸時有沒有加密 | 有 | app 只連 `https://` 的網址（`ios/App/AppEnvironment.swift`、Android 的 `usesCleartextTraffic="false"`）。Google：「Common encryption protocols include TLS (Transport Layer Security) and HTTPS.」 |
| Google：有沒有讓使用者要求刪除資料的方式 | 沒有 | 證明紀錄只增不改，宣告不能刪除、只能收回（ADR-0005；隱私權說明第 10 段）；連線紀錄和計數的明細 31 天自動刪除，個別的要求寫信、個別處理（隱私權說明第 14 段），不是一個刪除的機制。Google 只要求照實答有沒有：「you are required to indicate if you provide such a mechanism.」 |
| Google：帳號 | app 沒有帳號 | 過卡不建立帳號、不登入；宣告的是 Threads 的帳號名稱，不是 app 的帳號 |
| Google：每一類是必要還是可選 | 都是必要 | 計數和編號不提供退出（ADR-0032、ADR-0039）。Google：「You should not describe collection as optional if it is required for any of your app's users.」 |

## 不報的

| 資料 | 為什麼不報 | 依據 |
|---|---|---|
| PIN、姓名、自然人憑證的內容（序號、公鑰）、卡片的簽章 | 不離開手機 | `CLAUDE.md` 的硬限制；隱私權說明第 3 段。兩家：只在手機上處理的不算收集（上面的定義） |
| app 存在手機上的：用過的廢止清冊的版本號、過卡提醒的設定 | 不送出 | 廢止清冊的版本號：ADR-0015；提醒的設定：ADR-0016「app 在手機上留下什麼」；隱私權說明第 3 段 |
| 查卡片現況、拿題目、問設定的請求 | 查卡片現況的請求帶著島民編號，後台不記（ADR-0022：「看頁面、問設定、拿題目、查卡片現況……後台不寫紀錄」）。這一類資料反正因為第 1 列報了；請求的 IP 在 Cloudflare 的那一份，第 3 列 | ADR-0022；隱私權說明第 5 段 |
| 計數的請求的 IP 位址 | 後台只用來限流，不存（ADR-0032）。Apple（Additional guidance）：「if an authentication token or IP address is sent on a server call and not retained … you do not need to disclose this」。IP 這一類反正因為第 3 列報了 | ADR-0032「存什麼、留多久」 |
| 商店自己收的安裝數、各版本的使用量、當機報告 | 不是 app 送出的。Apple（Additional guidance）：「You are not responsible for disclosing data collected by Apple.」Google 的文件沒有講（下面第 6 項） | #94 第 6、7 點；隱私權說明第 12 段 |
| 島民證明上「下載 app」的連結帶的短編號 | 是網頁上的連結帶給商店的，app 不讀（ADR-0039） | 隱私權說明第 7 段 |
| app 裡點開的網頁（常見問題、隱私權說明、Threads） | app 沒有內嵌的網頁，連結交給系統的瀏覽器開（`ios/App/IamrealApp.swift` 的 `UIApplication.shared.open`、Android 的 `Intent.ACTION_VIEW`） | Apple（Additional guidance）：「Data collected via web traffic must be declared, unless you are enabling the user to navigate the open web.」 |
| 寫給營運者的信 | 不在 app 裡 | 隱私權說明第 12 段 |

## 文件沒有回答的

兩家的文件讀過之後答不出來的項目，和照「往多報」怎麼填。

1. **app 自己產生、定期換掉的隨機編號算不算裝置編號。** 兩頁都沒有講自己產生的、會重設或會換的編號。Apple 的 Device ID 只說「or other device-level ID」；Google 舉的例子裡有 Firebase installation ID，是同一種東西，但沒有講換掉的週期有沒有差。**填法**：算，報成 Apple 的 Device ID、Google 的 Device or other IDs（第 5 列）。
2. **嘗試編號要不要報成一類編號。** 它在手機上只在記憶體裡、一次過卡就丟，但隨計數送出，明細在後台留 31 天，所以兩家的定義下都是收集了。Google 那一頁講到，一個「identifier related to a specific in-app event」如果「does not reasonably relate to an individual device, browser or app」，不必報成 Device or other IDs；Apple 沒有講。**填法**：收集了，當成第 6 列計數的一部分報；不另外報成一類編號，因為兩家都沒有別的編號類別可以填，而裝置編號那一類已經因為第 5 列報了。所以這一項不改變填出來的結果。
3. **手機型號、系統版本、app 版本算哪一類。** 兩頁的資料類別都沒有提到型號、硬體或系統版本。**填法**：照用途報成技術診斷（第 9 列：Apple 的 Other Diagnostic Data、Google 的 Diagnostics）。另一個可以選的是 Apple 的 Other Data › Other Data Types（「Any other data types not mentioned」）、Google 的 Other app performance data（「Any other app performance data not listed here.」）；填出來同樣是「有收、連結、分析」，選了字面上比較接近的。
4. **題目、發證金鑰是第幾代、廢止清冊的樹根、證明算不算要報的資料。** 它們隨每一筆送出、永久公開。題目是後台發的亂數，樹根是公開的清冊算出來的，證明不透露憑證的內容；發證金鑰是第幾代說的是持卡人的卡片，每一代有幾百萬張。兩家的類別沒有一類是它們，文件也沒有講密碼學的證明。**填法**：Apple 有收其他資料的一類，往多報填成 Other Data › Other Data Types（第 10 列）。**Google 這一格沒有往多報填**：它沒有這樣的一類，最接近的是 Personal info › Other info（「Any other personal information such as date of birth, gender identity, veteran status, etc.」），填了，商店頁會寫成 app 收了生日、性別這一類的個人資料，和實際差得更遠。維護者要照多報填的話，Google 加 Personal info › Other info（App functionality，必要）。
5. **寫進公開的證明紀錄算不算「分享」。** Google 的文件列了「使用者自己發起、而且預期資料會被分享」不算分享，沒有直接講公開給所有人；Apple 的表單不問分享。**這一項沒有往多報填**：#94 把它列在文件沒有回答的項目裡，仍然填「沒有分享」，理由是上面那一條例外的字面涵蓋得到；這一份照維護者那時的決定。往多報的填法是在 Google 把第 1 列的 Personal info › User IDs 標成「收集並分享」，用途 App functionality。
6. **Google Play 自己收的資料（安裝數、Android vitals 的當機報告）要不要由開發者申報。** Apple 的文件寫明不用；Google 那一頁沒有提到 Google Play、Play services 或 Android vitals 自己收的。它的定義是「transmitting data from your app off a user's device」，連同 app 裡的函式庫和 SDK 送出的；app 沒有放 Google 的 SDK（ADR-0039，照 #94 第 3 點），這些不是 app 送出的。**填法**：不報（同 #94）。
7. **IP 位址留在伺服器的紀錄裡怎麼歸類。** 兩家都只說照用途。**填法**：概略的位置，Apple 多報一個診斷（第 3 列）。
8. **Google 的表單在「只在記憶體裡處理」的資料要不要填。** 那一頁有兩句不一樣的話：Data collection 一節說這種資料「needs to be included in your form response」但不會顯示在商店頁，常見問題說「If this use is ephemeral, you do not need to include it in your form response.」。和這一份有關的只有計數請求的 IP（限流的計數會記著一段時間，不完全符合只在記憶體裡的定義）。Approximate location 反正因為第 3 列報了，所以這一項不改變填出來的結果。

## 現在的程式做到哪裡

2026-11-26 的狀況。兩個 app 現在送出手機的只有過卡的四個介面要的東西：問設定、查卡片現況、拿題目、送出一筆（`docs/api/card-proof.md`），和下載公開的清冊。

| 列 | 現在 | 做了之後 |
|---|---|---|
| 1、10 | 有 | |
| 3 | 後台不寫連線紀錄；Cloudflare 自己的那一份有 IP、營運者看得到（隱私權說明第 5、6 段），所以現在就要報 | #20 做完，後台多一份，填法不變 |
| 2、4 | 沒有 | #20 做完才有 |
| 5 到 9 | 沒有：app 不送計數，沒有過卡裝置編號 | Android [#433](https://github.com/iamreal-tw/iamreal/issues/433)、iOS [#434](https://github.com/iamreal-tw/iamreal/issues/434) 做完才有 |

- **送審時照那一版 app 實際送的填。** 計數的票在上線前做完（[#431](https://github.com/iamreal-tw/iamreal/issues/431)）；封閉測試的 build 如果早於它們送審，標示只填第 1、3、10 列，#20 和計數上了之後在兩家的後台補上第 2、4 到 9 列
- **iOS 的請求現在可能已經帶著 app 的 build 和系統的版本。** `ios/App/Backend.swift` 沒有設 `User-Agent`，用的是系統預設的；Android 設成固定的 `iamreal`（`android/…/backend/Backend.kt`）。系統預設的 `User-Agent` 實際長什麼樣，這一份沒有量過；一般的了解是它帶 app 的名稱和 build、CFNetwork 和 Darwin 的版本。如果是，這幾個值現在就會和 IP 一起出現在 Cloudflare 自己的那一份裡，第 9 列對 iOS 就不是「還沒做」。送審之前要量一次，或讓 iOS 和 Android 一樣送固定的值；在那之前，iOS 的標示把第 9 列也填上（多報）
- **多報不是這裡的選項**：還沒有送的東西先填上去，商店頁就寫了 app 沒有做的事（`docs/design/principles.md`：不說得比實際多）

## 和隱私權說明逐項對過

2026-11-26 對 `design/copy/privacy.md`（那一天 [#427](https://github.com/iamreal-tw/iamreal/pull/427) 改過的）第 5 段「連線紀錄」、第 7 段「Cookie 和計數」：

| 隱私權說明寫的 | 這一份 |
|---|---|
| 第 5 段：送出時記請求編號、時間、結果、錯誤代碼、IP、國家、網路業者的編號、過卡裝置編號；成功的記第幾筆 | 第 3、4、5 列 |
| 第 5 段：送出沒有成功時，內容和 IP 記在同一筆 | 第 2 列 |
| 第 5 段：計數不記在連線紀錄，也不記 IP | 「不報的」計數請求的 IP；第 6 列連結的理由 |
| 第 5 段：Cloudflare 自己留著連線的資料 31 天 | 第 3 列；分享那一題的 service provider |
| 第 7 段：過卡走到哪一步、停下來時的錯誤代碼 | 第 6、7 列 |
| 第 7 段：按了哪些按鈕 | 第 6 列 |
| 第 7 段：過卡的幾個步驟花了多久，只分成幾段 | 第 8 列 |
| 第 7 段：在 app 裡過卡時的手機型號、系統版本、app 的版本 | 第 9 列 |
| 第 7 段：過卡裝置編號，31 天換；嘗試編號，一次過卡一個 | 第 5、6 列 |
| 第 7 段：計數一筆一筆的內容留 31 天，沒有 IP；加總永久，沒有 IP 和編號 | 第 5 到 9 列的「依據」 |
| 第 7 段：打開了哪一種頁面、從哪個網站連過來、造訪編號、瀏覽器和作業系統的種類和版本、讀卡機的名稱 | 只有網頁有，app 不送，不在標示裡 |
| 第 7 段：不放 cookie、沒有其他公司的分析或追蹤程式 | 追蹤那一題 |
| 第 7 段：「下載 app」的連結帶短編號 | 「不報的」 |

沒有一項說的和隱私權說明不一樣。

對的過程中看到幾份文件彼此不一致的地方。都不改變標示怎麼填（這一份照的是 2026-11-26 改過的 ADR-0022、ADR-0032、ADR-0039 的正文），記在這裡等維護者處理：

- **隱私權說明第 5、13 段**寫「每天各國家、各網路業者的請求數和失敗數永久保存」；ADR-0022 寫「不另外保存每天的統計」，請求從哪些國家、哪些網路來看 Cloudflare 的分析。ADR-0022 自己的 Considered Options 還有一句「要看更久以前的事，用每天的統計數字」，ADR-0032 也還提到「ADR-0022『每天各國家、各網路業者的請求數』」。哪一個對，標示都一樣：那是沒有 IP 的加總
- **隱私權說明第 5 段下面的依據**寫「ADR-0032（計數的內容進連線紀錄）」；ADR-0032 已經改成計數不進連線紀錄，那一段的正文也照改了，只有這一行註記沒有跟上
- **ADR-0016** 表下面那一段還寫「計數的請求連同 IP 留 31 天……後台看得出某個 IP 有一張卡片因為被廢止或暫時停用而過不了卡」；ADR-0032 改成計數不存 IP 之後，看得出的是「有一台裝置」（隱私權說明第 7 段寫的是這一個）
- **`docs/api/card-proof.md`** 還寫「No request's IP address is logged」；ADR-0022 之後送出一筆的請求會記 IP（[#20](https://github.com/iamreal-tw/iamreal/issues/20) 施工時改）

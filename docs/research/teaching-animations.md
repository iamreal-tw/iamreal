# 研究：過卡流程的教學動畫怎麼做

[#352](https://github.com/iamreal-tw/iamreal/issues/352) 的研究結果，2026-11-26。這份文件只提出做法，不改 app，也不改網頁；施工另外開票（最後一節）。

## 結論

- **兩處動畫都用原生的元件自己畫**：網頁是 HTML 和 CSS 加一小段程式，Android 是 Compose，iOS 是 SwiftUI。不加播放動畫檔的程式庫，不放影片。
- **三邊讀同一份時間表**（放 `design/`）：每一段幾秒、鏡頭對準哪個框、按哪裡、畫面變成什麼。三邊各寫一個小的播放程式。
- **網頁的掛上去從四張靜態圖換成動畫**，四步的字留著。沒有程式、或系統設定減少動態時，看到的還是現在的四張圖。
- 三邊都做了能跑的雛型，讀同一份時間表，沒有加任何套件（「雛型」一節）。

## 要畫的兩段

規則在 #352「已經定的」。這裡只寫研究中補上的決定。

### 掛上去

五個畫面由左到右排成一列，只有鏡頭動：我們自己的畫面（複製連結、打開 Threads）、Threads 的個人檔案、編輯個人檔案、連結、新增連結。往下一步鏡頭往右，存好回來鏡頭往左。每一步是全景、拉近、按、拉遠。

- 全長 20.7 秒，9 次按
- 複製連結之後按一次「打開 Threads」：它是持卡人真的會按的那一顆，少了它，畫面從我們的頁面換到 Threads 沒有原因
- 存好之後鏡頭直接滑回個人檔案，經過「編輯個人檔案」但不停。維護者 2026-11-26 在 iPhone 和 Android 上實測：離開「連結」那一頁就存了，不用在「編輯個人檔案」再按一次
- 兩個平台只差一下：按了「新增連結」那一頁的「完成」、回到「連結」那一頁之後，iOS 按右上角的「完成」；Android 那一顆是灰的，要按左上角的 ✕。維護者在兩支 Android 上確認過（一支 Samsung Galaxy Z Flip3，一支是另一位使用者的）
- 第一個畫面的兩顆按鈕（「複製連結」「打開 Threads」）左右並排，在示範的上面。網頁的那一頁、兩個 app 的第 6 步、示範裡的第一個畫面都是這個排法；app 原本是上下排，一起改（#369）

### 感應位置

平面的畫法：手機正面朝你，紅色卡片從旁邊滑到手機後面，被擋住的部分用紅色虛線透出來。

- 播三輪後停在卡片貼好的那一格（「要能停下來」）
- Android：8.75 秒一輪。卡片上下移動兩趟，停在偏上的位置，紅圈一次
- iPhone：3.75 秒一輪。卡片滑到靠上方就停住，紅圈一次

## 時間表

一份 JSON，三邊照它播。掛上去的那一份有 53 個事件，五種：

| 事件 | 意思 | 例子 |
|---|---|---|
| `camera` | 鏡頭在幾秒內移到某個取景 | 0.5 秒起，0.65 秒內對準「複製連結」 |
| `mark`、`unmark` | 要按的地方的紅框和標籤出現、消失 | 1.15 秒框出「複製連結」 |
| `tap` | 按下去：紅圈加按鈕變深；長按另外帶秒數 | 11.65 秒長按網址欄 0.5 秒 |
| `state` | 畫面的內容改變 | 「已複製」、出現「貼上」、網址填進去、清單多一列、個人檔案多一行 |
| `step` | 現在是四步文字裡的哪一步 | 5.35 秒起標第 2 步 |

- **取景不寫座標。** 寫的是哪一個框、放大到畫面的寬等於幾個單位（一個示意畫面寬 360 個單位）、框的哪一點放在畫面的哪一點。三邊各自用自己排出來的位置去算，所以字型不同、帳號長短不同，鏡頭還是對得準
- **兩個平台共用一份。** 事件裡回程按的那一顆叫 `back`，檔案裡另外寫明 iOS 是右上角的「完成」、Android 是左上角的 ✕
- **畫面的內容怎麼變不寫在時間表裡。** 時間表只說「這一刻變成已複製」，那一顆按鈕的字怎麼換由各邊自己畫
- **每一個值都只看時間。** 播放程式拿到一個秒數，就算得出那一刻的整個畫面，不靠前一格。所以可以從頭重播、可以停在任何一格截圖，三邊也能逐格對照
- 感應位置另一份，只有四種事件：卡片進來、移到某個高度、紅圈、離開。高度寫成手機高度的比例

時間表放在 `design/`，和 `design/copy/` 的文字一樣是三邊共用的來源。檔名和欄位在施工的票裡定。

## 三邊各自怎麼畫

| | 網頁 | Android | iOS |
|---|---|---|---|
| 示意畫面 | 伺服器寫出的 HTML，樣式在 `pages.css` | Compose 的 `Box`、`Row`、`Column`、`BasicText` | SwiftUI 的 `HStack`、`VStack`、`Text` |
| 鏡頭 | 整列的 `transform`（位移加縮放） | 整列的 `graphicsLayer`（位移加縮放） | 整列的 `scaleEffect` 加 `offset` |
| 每一格的時間 | Web Animations API（`Element.animate`），一個元素一串關鍵影格 | `withFrameNanos` | `TimelineView(.animation)` |
| 框的位置 | `offsetLeft`、`offsetTop` 往上加到那一列 | `onGloballyPositioned`：整列還沒移動時，每個框和整列各自的 `positionInRoot` 相減 | `transformAnchorPreference` 加 `GeometryReader` |
| 新的套件 | 沒有 | 沒有（`allowedLibraries` 已經有的三個） | 沒有 |
| 雛型的大小 | 播放程式 5.9 KB，壓縮後 2.3 KB（沒有縮小化） | 410 行 Kotlin | 301 行 Swift |

雛型的行數包含五個示意畫面。安裝檔會多多少沒有量。

做雛型時踩到的兩件事，施工時會再遇到：

- **Compose**：整列回報位置（`onGloballyPositioned`）的時候，裡面的框不一定都回報過了。要等每個框都回報過再算鏡頭，不然第一格算不出來，鏡頭停在原點
- **SwiftUI**：一個示意畫面和它裡面的按鈕都要回報位置時，要用 `transformAnchorPreference`（合併）。用 `anchorPreference`（設定）的話，外層的值會蓋掉裡面的，按鈕的位置就不見了

## 另外兩種做法

版本、大小、日期是 2026-11-26 查的。「量的」是把登記處上的檔案抓下來量，不是專案自己寫的數字。

### 動畫檔加播放的程式庫

設計工具匯出一個動畫檔，三邊各用一個程式庫播。查了 Lottie 和 Rive。

| | Android | iOS | 網頁 |
|---|---|---|---|
| Lottie | `lottie-compose` 6.7.1（2025-10-31，Apache-2.0）。它帶進 `androidx.appcompat:appcompat` 和 `com.squareup.okio:okio`，都不在 `allowedLibraries` 裡。AAR 共 567 KB，不含那兩個 [1][2] | `lottie-ios` 4.6.1（2026-06-13，Apache-2.0），會是 app 的第一個外部套件。專案建議的裝法是下載預先編好的函式庫，不是從原始碼編 [3][4] | `lottie-web` 5.13.0（MIT）。完整版用 `eval`，`script-src 'self'` 不准；精簡版沒有 `eval`，壓縮後 46 KB（量的）[5][6] |
| Rive | 有（MIT）[7] | 有（MIT）[7] | 要 WebAssembly，`script-src` 要加 `'wasm-unsafe-eval'` [8] |

不用的理由：

- **帳號和網址要換成每個人自己的。** Lottie 三邊都換得了文字，但三邊是三套不同的接法，字型也要各接一次 [9][10][11]。用了程式庫，「三邊共用一份」省下的工又花在這裡
- **Android 要放行兩個和畫面無關的程式庫**（`appcompat`、`okio`），和「安裝檔裡只有畫面用得到的東西」相反
- **iOS 的第一個外部套件**，而且建議的裝法是預先編好的函式庫：發出去的 app 裡多一塊不是從這個程式庫的原始碼編出來的東西
- **網頁要載入 46 KB 的播放程式**（自己寫的是 2.3 KB），或放寬回應標頭讓 WebAssembly 能跑
- **Rive 的三個執行環境一個月出好幾版** [12]，照「套件發布滿 7 天才用」的規定要一直追
- **動畫檔要用設計工具做**，看不出改了什麼。自己畫的話，時間表是一份讀得懂的 JSON，畫面是程式碼，改動在 PR 裡看得到

### 影片

把動畫算成影片檔，三邊各自播。

- **帳號和網址換不了。** 影片裡的字是畫死的，只能全部的人都看 `@alice`
- **兩個平台各一支**，掛上去兩支、感應位置兩支。這次算的參考影片，掛上去一支約 2.7 MB（1080×1350、H.264），沒有為了檔案大小調過
- **網頁要改回應標頭**：現在的 `default-src 'none'` 會擋 `<video>`，要加 `media-src 'self'` [13]。要讓舊的 iPhone 能播，得用 H.264 的 MP4（iOS 的 Safari 到 17.4 才能播 WebM）[14]
- **「播到哪一步就標出那一步的字」還是要寫程式**去對影片的時間
- 播放本身三邊都不用加套件：網頁是 `<video>`，Android 是系統的 `VideoView`，iOS 是 `AVKit` [15][16]
- **減少動態、報讀器、沒有程式時**，還是要另外準備靜態圖

影片唯一比較省的是不用畫示意畫面；但示意畫面網頁已經有了（現在的四張圖），兩個 app 也要畫靜態的版本。

### 來源

1. <https://repo1.maven.org/maven2/com/airbnb/android/lottie/6.7.1/lottie-6.7.1.pom>
2. <https://repo1.maven.org/maven2/com/airbnb/android/lottie-compose/6.7.1/lottie-compose-6.7.1.pom>
3. <https://github.com/airbnb/lottie-ios/releases>
4. <https://github.com/airbnb/lottie-spm/blob/4.6.1/Package.swift>
5. <https://registry.npmjs.org/lottie-web>
6. <https://github.com/airbnb/lottie-web/issues/323>
7. <https://rive.app/docs/runtimes/getting-started>
8. <https://github.com/rive-app/rive-wasm/issues/131>
9. <https://github.com/airbnb/lottie-android/blob/v6.7.1/lottie/src/main/java/com/airbnb/lottie/TextDelegate.java>
10. <https://github.com/airbnb/lottie-ios/blob/4.6.1/Sources/Public/TextProvider/AnimationTextProvider.swift>
11. <https://github.com/airbnb/lottie-web/wiki/TextLayer.updateDocumentData>
12. <https://github.com/rive-app/rive-android/releases>、<https://github.com/rive-app/rive-ios/releases>、<https://github.com/rive-app/rive-wasm/releases>
13. <https://www.w3.org/TR/CSP3/>（`media-src`、`default-src`）
14. <https://developer.apple.com/documentation/safari-release-notes/safari-17_4-release-notes>
15. <https://developer.android.com/reference/android/widget/VideoView>
16. <https://developer.apple.com/documentation/avkit/videoplayer>
17. <https://www.w3.org/TR/WCAG22/#pause-stop-hide>
18. <https://developer.android.com/reference/android/animation/ValueAnimator#areAnimatorsEnabled()>

## 報讀器

三邊相同：整張圖對報讀器是一個元素，唸一句說明，圖裡面的東西隱藏（`design/DESIGN.md`「無障礙」已經這樣規定示意圖）。說明的句子寫在 `design/copy/`。

雛型用的句子（還不是定稿）：

```
示範：按「複製連結」，到 Threads 的個人檔案按「編輯個人檔案」、「連結」、「新增連結」，貼上網址後按「完成」，個人檔案上多了一行連結。
```

四步的字照常讀出來，所以用報讀器的人拿到的資訊和看圖的人相同。雛型還沒有用 VoiceOver、TalkBack 或桌面的報讀器實際試過。

## 要能停下來

WCAG 2.2 的 2.2.2（A 級）：會動的東西同時符合「自己開始」「超過五秒」「旁邊還有別的內容」，就要有辦法暫停、停止或隱藏 [17]。兩段動畫都符合，不論用哪一種做法。#352「已經定的」只有「再看一次」，沒有停的方法。維護者 2026-11-26 定的：

- **掛上去**：同一顆按鈕，播的時候寫「停止」，按了停在最後一格；停了或播完寫「再看一次」
- **感應位置**：不再一直循環。播三輪就停在終點圖（和「你」那一點脈動三次就停相同），旁邊有「再看一次」

雛型還沒有做這一項。

## 減少動態

- 掛上去：不播，顯示現在的四張靜態圖和結果圖
- 感應位置：一張靜止的終點圖（卡片停在感應的位置）

怎麼知道：網頁是 `prefers-reduced-motion`；Android 是 `ValueAnimator.areAnimatorsEnabled()`（系統把動畫關掉、或省電模式關掉動畫時是否 [18]）；iOS 是 `accessibilityReduceMotion`。Android 要自己問：播放程式用 `withFrameNanos` 自己算時間，系統關掉動畫時它不會自己停（讀 Compose 的原始碼得到的結論，沒有在手機上試）。

網頁的雛型做到了「不播、顯示靜態圖」。兩個 app 的雛型現在只是停在最後一格，還沒有換成靜態圖。

## 網頁另外要回答的

### 帶一小段程式，不用產生純 CSS

| | 帶一小段程式（建議） | 用腳本從時間表產生純 CSS |
|---|---|---|
| 做了沒 | 做了雛型，實測過 | 沒有做，以下是推論 |
| 進到畫面才播 | 可以（`IntersectionObserver`） | 不行：頁面一載入就開始。圖在標題和按鈕下面，手機上捲到時可能已經播掉一半 |
| 再看一次 | 可以 | 要用連結加 `:target` 之類的繞法，第二次要換另一個連結 |
| 播到哪一步就標出那一步的字 | 可以 | 可以 |
| 帳號長短、螢幕寬窄 | 播放前照實際排出來的位置算 | 位置要在產生時就定死：圖只能固定寬度，或每種寬度各產生一份 |
| 和 app 共用時間表 | 直接讀同一份 | 多一個產生的步驟；產生的結果要進版本庫，還要檢查沒有過期 |
| 那一頁多載入 | 程式 5.9 KB（壓縮後 2.3 KB）、時間表 3.8 KB（壓縮後 0.9 KB） | 沒有程式；樣式多出每個框各一段關鍵影格，沒有量 |
| 回應標頭 | `/hang/<短編號>` 不用改；`/hang` 要改（下一段） | 都不用改 |

兩種做法都要多 5.0 KB 的樣式（壓縮後 1.6 KB）畫第一個畫面和幾個新的狀態；現在的四張圖已經有的 class 可以沿用。

### `/hang` 要准本站的程式

`/hang/<短編號>` 已經用 `SCRIPT_PAGE_HEADERS`（`script-src 'self'`），因為複製連結的按鈕要程式。從首頁點進來的 `/hang` 現在是 `VISITOR_HEADERS`，完全不准程式。要在那一頁播動畫，就要改成和 `/hang/<短編號>` 相同。

這是部署會執行到的東西。維護者 2026-11-26 同意放寬。

播放程式是本站的一個檔，不用行內樣式，也不向任何地方要資料：時間表由伺服器寫在頁面裡，放在一個不會被執行的 `<script type="application/json">` 裡。雛型在和 `/hang/<短編號>` 相同的回應標頭下跑過，Chrome 沒有擋下任何東西。CSP 的規格沒有提到 `Element.animate`，也沒有明說它不受 `style-src` 管；Safari 和 Firefox 要在施工時試。

### 沒有程式時

和現在一樣：四張靜態圖。播放程式載入後才把圖換成動畫、才顯示「再看一次」，做法和現在的複製按鈕相同（沒有程式時按鈕不出現）。

### `design/DESIGN.md`「動態」

現在的：

> 整個網站只有一個會自己動的東西：「你」那一點，載入後脈動三次就停住（每次 `--pulse-duration`，共 `--pulse-count` 次），留下一圈靜止的外圈。系統設定減少動態的人，一開始就是靜止的。按了之後的回饋（展開、切換）可以有短暫的過渡。

建議改成：

> 會自己動的東西只有兩種。
>
> 一是「你」那一點：載入後脈動三次就停住（每次 `--pulse-duration`，共 `--pulse-count` 次），留下一圈靜止的外圈。
>
> 二是教操作的示意圖（卡片貼在手機哪裡、把連結掛到個人檔案）：只用移動、縮放、淡入淡出，沒有聲音。掛上去的那一張進到畫面後播一次，停在最後一格；旁邊一顆按鈕，播的時候是「停止」，停了或播完是「再看一次」。卡片貼哪裡的那一張只在 app 裡，播三輪後停在卡片貼好的那一格，旁邊有「再看一次」。
>
> 系統設定減少動態的人，兩種一開始就是靜止的：「你」是那一圈外圈，示意圖是靜態的圖。按了之後的回饋（展開、切換）可以有短暫的過渡。

### 版面

手機上四步的字在圖的下面，播的時候不一定看得到被標出來的那一步。圖和四步的字怎麼排，在施工的票裡和畫面一起定。

## 雛型

三個雛型讀同一份時間表，錄影和截圖附在 #352 的留言。

| | 跑在哪裡 | 看到了什麼 | 沒有試的 |
|---|---|---|---|
| 網頁 | Chrome，手機的尺寸（390×844），回應標頭和 `/hang/<短編號>` 相同 | 進到畫面後播一次、停在最後一格；「再看一次」從頭播；播到哪一步，那一步的字標出來；減少動態時是靜態圖；沒有被擋下的東西 | Safari、Firefox、真手機、報讀器 |
| iOS | iPhone 16 Pro 模擬器，照 iOS 15 編譯 | 從頭播到最後一格（即時錄影） | 真手機、iOS 15 的裝置、報讀器、減少動態時的靜態圖 |
| Android | API 29 的模擬器 | 從頭播到最後一格（即時錄影）。模擬器上一秒約畫出 31 格 | 真手機上順不順、報讀器、減少動態時的靜態圖 |

感應位置的動畫還沒有雛型，只有時間表。它比掛上去簡單：一張卡片上下移動，一個紅圈。

## 還沒確認的

- Threads 的 iOS app 和 Android app 裡，這幾頁的字和位置是不是和示意圖相同。示意圖是照 Threads 網頁版 2026-11-25 的樣子畫的（`design/copy/hang.md`「示意圖」）
- Android 真手機上播放的流暢度，尤其是舊的手機。模擬器上一秒約 31 格，每一格的中位數是 48 毫秒；模擬器用軟體畫圖，不能代表手機
- Safari 和 Firefox 在現在的回應標頭下播不播得出來
- 安裝檔多出來的大小

## 之後的票

1. `design/` 的時間表（掛上去、感應位置）和它的格式說明
2. 網頁：`/hang` 和 `/hang/<短編號>` 的播放程式、`/hang` 的回應標頭、`design/DESIGN.md`「動態」、`design/copy/hang.md`
3. Android：第 2 步和第 6 步
4. iOS：第 2 步和第 6 步

第 1 張先做，其餘三張可以同時做。

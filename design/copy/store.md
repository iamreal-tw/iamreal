# 商店頁（Google Play、App Store）

兩個商店的商店頁上的文字，和給審查人員的說明。維護者在 Play Console 的商店資訊和「應用程式存取權」（App access）、App Store Connect 的 App 資訊和審查備註，逐字從這裡貼。名稱、截圖、圖示、上架的地區在「[app 的名稱、商店頁和上架的地區](https://github.com/iamreal-tw/iamreal/issues/154)」定。原則在 `docs/design/principles.md`。

- 商店頁不在原則「首頁和事實頁」列的說明和號召的那幾處裡，照事實頁寫：看的人在這裡決定要不要裝一個會要 PIN 的 app。所以帳號照「一張台灣國民的自然人憑證，把它在 Threads 唯一的名額給了」寫，不寫「台灣人持有」「真人」
- 只寫繁體中文。給審查人員的說明寫英文：Google 要登入的資料和說明是英文（[Requirements for providing sign in details for review](https://support.google.com/googleplay/android-developer/answer/15748846)）
- 名稱和完整說明兩個商店共用。兩個 app 寫法不同的地方，這裡寫「手機」，不寫 Android、iPhone
- 字數照 Google 的上限：簡短說明 80 字、完整說明 4,000 字，全形和半形一樣算一個字（[Add preview assets](https://support.google.com/googleplay/android-developer/answer/9859152)：「Character limits apply to both full-width and half-width characters.」）。程式碼區塊裡的字就是要貼的字，空一行是分段
- 不寫排名和使用者的推薦，不重複關鍵字（[Metadata](https://support.google.com/googleplay/android-developer/answer/9898842)）
- 「我們」是服務自稱（原則「文字的寫法」）
- `{site}` 是 app 連的網站：上線前是 `test.iamreal.tw`，上線起是 `iamreal.tw`（ADR-0040）。貼的時候換掉；上線那天和商店頁的網址一起改（#491）

## 1. 名稱

```
島民證明
```

不加副標或關鍵字（#154 的結論）。手機主畫面上的名稱是另一個欄位，在 `app.md`「主畫面上的名稱」。

## 2. 簡短說明

Google Play 的「簡短說明」，商店頁最先看到的一句（[Add preview assets](https://support.google.com/googleplay/android-developer/answer/9859152)：「The first text users see when looking at your app's detail page in Google Play.」）。App Store 用不用這一句、副標題填什麼，送 App Store 時另外定（#154 的結論：先定 Play 要的部分）。

```
用手機感應自然人憑證，把這張卡片在 Threads 唯一的名額給你的帳號，換一張島民證明。
```

- 45 個字（半形的空格也算）
- 「一定要有」的四件事（不是政府的 app、自然人憑證和 PIN 不離開手機、沒有帳號、沒有廣告）在完整說明的前幾段，這一句只講 app 做什麼。家人那一句不放在這裡（#154 的結論）

## 3. 完整說明

Google Play 的「完整說明」、App Store 的「描述」。

```
島民證明不是政府或內政部的 app。由一位台灣的軟體工程師個人開發和維護，原始碼公開在 GitHub。

用手機感應你的自然人憑證，把這張卡片在 Threads 唯一的名額給你的帳號，換一張島民證明。島民證明是一個公開的頁面，把它的網址放到你的 Threads 個人檔案上，看的人點進去，看得到有一張台灣國民的自然人憑證把它在 Threads 唯一的名額給了這個帳號，和上次過卡是幾天前，自己判斷。

島民證明只說有一張當時有效的卡片宣告了這個帳號。它不說帳號主人是誰，也不說這個帳號是真人。

需要什麼
· 實體的自然人憑證：本國國民的自然人憑證。行動自然人憑證、第一代的自然人憑證不能用
· 卡片的 PIN
· 有 NFC 的手機
過卡大約 3 分鐘。

怎麼過卡
1. 感應卡片：app 讀取卡片上的憑證，檢查它是內政部簽發給本國國民的自然人憑證、還在效期內、沒有被廢止
2. 輸入 PIN：卡片簽章一次，查這張卡片目前宣告的帳號
3. 填上你的 Threads 帳號，或沿用目前宣告的帳號
4. 確認：畫面列出會公開的內容。按下後卡片再簽一次，手機算出零知識證明，送出後記進公開的證明紀錄
5. 把島民證明的連結放到你的 Threads 個人檔案上

留在手機上的
· 自然人憑證、PIN、姓名和卡片的簽章不會離開這支手機。PIN 只在記憶體裡停留到送給卡片為止
· 送出的是一份零知識證明，和由你的卡片算出、我們算不回來的島民編號。我們不知道持卡人是誰
· app 不在手機上存任何卡片的資料，家人可以用同一支手機，各自用自己的卡片過卡

公開的
· 宣告的帳號、日期、島民編號，和卡片由內政部哪一代的發證金鑰簽發，會公開記在證明紀錄裡，任何人都看得到，也能下載整份證明紀錄自己重驗
· 紀錄不能刪除。不想再宣告一個帳號時，可以收回
· 拿到你的卡片和 PIN 的人，查得出這張卡片宣告過的帳號

沒有的
· 沒有帳號：不用註冊、不用登入，也不用登入 Threads
· 沒有廣告，app 裡沒有其他公司的分析或追蹤程式

我們收到的
· 過卡時連線的 IP 位址，我們和 Cloudflare 留 31 天。這段期間內，我們或依法調閱的機關，可以經電信業者查到一筆紀錄是從哪條網路線路送出的
· 為了知道 app 哪裡不好用，app 會送出計數，例如過卡走到哪一步、停在哪裡、幾個步驟花了多久、手機型號、系統和 app 的版本，帶著一個 31 天換一次的過卡裝置編號。所以同一支手機 31 天內過的卡，我們看得出是同一支手機過的
完整的說明在 {site}/privacy。

過卡提醒
可以讓 app 每一個月、三個月或六個月提醒你回來過卡。提醒由手機自己排，不經過我們的伺服器。

常見問題：{site}/faq
原始碼：github.com/iamreal-tw/iamreal
```

- 第一段排在最前面：看的人最容易誤會的是這是政府的 app（原則 2）。Google 不讓 app 假稱和政府有關（[Deceptive Behavior](https://support.google.com/googleplay/android-developer/answer/9888077)：「Don't falsely claim affiliation with a government or an established entity when not properly authorized to do so.」）。「個人開發和維護」和 `privacy.md` 第 1 段相同
- 島民證明是「公開的頁面」，不寫「網址」：`GLOSSARY.md`「島民證明」是證明和顯示它的頁面
- 「需要什麼」：本國國民的自然人憑證、行動自然人憑證不能用，和 `prepare.md` 第 2 段相同；第一代的卡片 app 不能用（`card-proof.md` 第 2 步的 app 停止原因）。「大約 3 分鐘」和過卡提醒的通知（`app.md`）相同
- 「怎麼過卡」是 app 八步裡要持卡人做事的五步，句子照 `card-proof.md` 第 2 到 6 步。不寫第幾步：商店頁不是過卡的畫面
- 「留在手機上的」前兩條和 `privacy.md` 第 2、3 段相同。家人那一句照 #154 的結論寫成一句事實，不當主打，也不另外警告在家人的手機上輸入 PIN：這和輸入在自己的手機上一樣，看那支手機可不可信。手機上存的三樣（廢止清冊的版本號、提醒、過卡裝置編號）都不是卡片的資料（`privacy.md` 第 3 段）
- 「公開的」：公開的內容照 `privacy.md` 第 4 段（底線 5）；證明和題目不寫，看的人看不懂，也不會因為它們改變要不要裝。「拿到你的卡片和 PIN 的人……」是 `privacy.md` 第 4 段「要知道的事」的第一條，app 在第 5 步確認時才講（`card-proof.md`）。商店頁也寫，是因為它會改變要不要裝
- 「沒有的」：Android 不帶第三方的程式庫、拿掉 `AD_ID`（`android/README.md`「建置時的檢查」），iOS 沒有第三方的套件、不連結 `AdSupport`（`ios/README.md`）。商店自己收的安裝數和當機報告不是 app 裡的程式（`privacy.md` 第 12 段）
- 「我們收到的」：IP 位址那一條和 `privacy.md`「先講結論」的第四條相同，那一條會改變要不要過卡。計數用「例如」，完整的清單在 `privacy.md` 第 7 段；過卡裝置編號照同一段。同一支手機連得起來那一句和 `privacy.md` 第 7 段「用自己的手機替家人過卡……」說的是同一件事：家人那一句寫在前面，這裡不寫，就是說得比實際多
- 這一份改了計數、保存期限、手機上存的東西時，和 `privacy.md` 一起改
- 字數：1,193 字；加上下面「上線之前」那一段是 1,252 字

### 上線之前

上線之前，正式 app 也連測試網站（ADR-0040），完整說明的最前面多這一段，上線那天拿掉，和 #491 同一天：

```
這個 app 現在連的是測試網站 test.iamreal.tw：換到的島民證明記在測試的證明紀錄裡，不定期清空。

```

「測試網站」「測試的證明紀錄」照 `GLOSSARY.md`，不寫「測試版」；「不定期清空」和 `test-site.md` 的標示相同。上線前「公開的」那幾句說的不能刪除，對測試的證明紀錄不成立，所以要有這一段。

## 4. 給審查人員的說明

Google Play 的 App access 按「+ Add new instructions」，貼在「Any other instructions」那一欄（[Prepare your app for review](https://support.google.com/googleplay/android-developer/answer/9859455)）。沒有帳號，所以沒有使用者名稱和密碼。Google 的說明頁沒有寫這一欄的字數上限；這一段 3,651 個字元，貼不下時回報，不要自己刪。不提供示範模式（會是一條不讀卡的路），不附影片；被退回才補 Android 的影片（#154 的結論）。之後 Apple 的審查備註也寫在這一段。

### Google Play

```
This app cannot be used without three things: a Taiwan Citizen Digital Certificate (自然人憑證, a physical smart card issued by Taiwan's Ministry of the Interior; the app accepts only the cards of nationals of Taiwan), the card's PIN, and an Android phone with NFC. There is no account, sign-up or sign-in in the app, so there is no username or password to give. There is no demo mode: past pressing 感應卡片 (Tap card) on step 2, nothing can be done without the card.

The app is not made by, and not affiliated with, the government of Taiwan or its Ministry of the Interior. It uses the Ministry's public list of revoked certificates.

What the app does: a cardholder taps the card on the phone to declare one Threads account for that card. The phone makes a zero-knowledge proof, and the server adds it to a public, append-only log (the proof log). The result is a public web page, {site}/p/ followed by 10 characters, that the cardholder links from their Threads profile. The page shows that a citizen card, valid when it signed, declared this account; it does not say who the cardholder is. The card's certificate, the PIN, the cardholder's name and the card's signatures stay on the phone. Before launch, the app talks to the test site test.iamreal.tw, whose proof log is cleared from time to time.

Without a card, you can see:
- Step 1, 開始之前 (Before you start): what is needed, and two questions that expand. 為什麼一定要實體的卡片？ (Why a physical card?) explains why the mobile version of the certificate cannot be used. 還沒有自然人憑證，怎麼申辦？ (No card yet?) explains how to get one; 找附近的戶政事務所 (Find a nearby household registration office) opens the phone's map app with that search, and the second link opens the Ministry's certificate authority site.
- 設定 (Settings), at the top right of step 1: a check-in reminder (every one, three or six months; a local notification the phone schedules, nothing goes to a server), the app's version, and links to the FAQ, the privacy page and the source code on GitHub.
- Step 2, 讀取卡片 (Read card): an animation of where to hold the card. 感應卡片 (Tap card) connects to the server, then opens a panel that waits for a card; 取消 (Cancel) closes it.
- On a phone without NFC, step 1 is replaced by 這支手機不能感應卡片 (This phone cannot read the card), which points to the website and a card reader instead.

With a card, the steps are:
1. 開始之前 (Before you start).
2. 讀取卡片 (Read card): the app reads the certificate from the card over NFC and checks it: issued by the Ministry of the Interior, a national's card, within its validity, not on the Ministry's revocation list (the app downloads the list).
3. 輸入 PIN (Enter PIN): the name on the certificate is shown on this screen only, so the cardholder can tell it is their card. After the PIN, the card signs once, and the app asks the server which Threads account this card has declared.
4. 你的帳號 (Your account): the cardholder enters a Threads username, or keeps, changes or withdraws the one already declared.
5. 確認 (Confirm): the screen lists what will be published. On confirming, the card signs a second time, the phone computes the zero-knowledge proof (about 10 seconds), and the app sends it. The proof log records it.
6. 掛上去 (Add to profile): the link of the card's page, a button to copy it, a button to open the account's Threads profile, and how to add the link to it.
7. 提醒 (Reminder): whether, and when, to be reminded to come back and do it again.
8. 完成和分享 (Done and share): a small card with the declared account, and 分享到 Threads (Share to Threads), which opens the phone's share sheet with a line of text and the link of the card's page.

Questions about the app: th33ts@gmail.com
```

- Google 要「specific instructions for accessing restricted areas of your app」，而且要英文（[Requirements for providing sign in details for review](https://support.google.com/googleplay/android-developer/answer/15748846)）。照票上的三件事寫：要什麼、沒有卡片時看得到哪些畫面、有卡片時每一步做什麼。只描述 app 做什麼，不說它安全、可信
- 中文的畫面名稱和按鈕照 `card-proof.md`、`app.md` 原樣寫，括號裡是英文：審查人員在畫面上看到的是中文
- 說到內政部，只寫一件事實：用的是內政部公開的廢止清冊（`privacy.md` 第 12 段「內政部」）
- 計算的秒數照 `card-proof.md` 第 5 步的 app 段，Android 寫 10
- 信箱和 `privacy.md` 第 1 段相同
- 「Before launch……」那一句上線那天拿掉，和完整說明的「上線之前」一起；`{site}` 和完整說明的相同

### App Store

還沒寫。iPhone 的感應是系統的面板（`card-proof.md`「app：感應的面板」）；#154 的結論是 Apple 要附實機的影片，送 TestFlight 對外審查之前，影片另外做，說明另外寫。

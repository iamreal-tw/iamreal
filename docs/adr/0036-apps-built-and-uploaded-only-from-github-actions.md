---
status: accepted（部分由 ADR-0037 取代）
---

# app 只從 GitHub Actions 建置和上傳；Android 的簽章金鑰自己產生，不放在 GitHub

> 只有一個 app `tw.iamreal.app`，連測試網站的是不上傳商店的開發用 build（ADR-0037）。這一份的「兩個 app」「誰建置、誰上傳」「例外：Google Play 的封閉測試」三段，金鑰分層裡「測試 app 和正式 app 各一個 environment」那一條，和金鑰表上 Android 簽章金鑰的「離線保管」，由 ADR-0037 取代。其餘有效。

手機 app（Android、iOS）傳到商店的每一個 build 都由 GitHub Actions 建置和上傳。正式 app 要營運者推標籤、核准才上傳，送審和對一般人發布由營運者在商店的後台手動做。這一份把 ADR-0029 對網站的做法接到 app 上，另外定：兩個 app 識別碼、金鑰分層、版本號、可重現的建置在兩個平台各做到哪裡。

金鑰誰保管、怎麼保管，不寫在這裡。

## 兩個 app

| | 測試 app | 正式 app |
|---|---|---|
| 識別碼（Android、iOS 相同） | `tw.iamreal.app.test` | `tw.iamreal.app` |
| 連哪裡 | 測試網站（ADR-0028） | 正式網站 |
| 簽的場合字串 | `iamreal-test:public:0` | `iamreal:public:0` |
| 發到哪裡 | TestFlight、Google Play 的測試軌道；永遠不發到正式軌道 | App Store、Google Play 的正式軌道 |

- **環境在建置時寫死。** app 裡沒有切換環境的設定，後台也不能叫 app 換環境（ADR-0035）。
- **兩個 app 能同時裝在一支手機上**，各自只認自己那個環境的連結主機。Android 的文件寫明不同的 application ID 是不同的 app（[Configure the app module](https://developer.android.com/build/configure-app-module)）；iOS 沒有明講，要實機測。
- **識別碼不帶服務的名稱。** 上架之後識別碼改不了，名稱可以改。

## 誰建置、誰上傳

| | 測試 app | 正式 app |
|---|---|---|
| 什麼時候 | 營運者手動觸發工作流程 | 營運者推一個標籤，在 GitHub 上核准之後 |
| 從哪裡 | 只從 GitHub Actions | 只從 GitHub Actions |
| 前提 | 無 | 標籤指到的提交，Actions 已經用測試 app 的識別碼建置並上傳過；沒有就直接失敗 |
| 上傳之後 | 直接到測試者手上 | 營運者在商店的後台送審、發布 |

- **營運者的電腦只做開發用的建置**，用線裝到自己的手機。電腦上不放任何能上傳到商店的金鑰。
- **合併到 `main` 不會上傳。** 測試者不需要每個提交都收到更新。
- **營運者電腦上的 coding agent 可以觸發測試 app 的上傳；不推正式 app 的標籤、不核准**，和 ADR-0029 對正式網站的規定相同。
- **建置和上傳是兩個工作。** 上傳的工作拿得到金鑰，建置的工作拿不到。

## 版本號和標籤

- **顯示的版本用日期**，例如 `2026.11.20`，月、日不補零（`2026.11.5`）。同一天上傳第二次，版本不變，靠 `build` 分：iOS 的版本只收三個整數（「The required format is three period-separated integers」，[CFBundleShortVersionString](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleshortversionstring)），`2026.11.20.1` 傳不上去；Android 跟著一樣。網站的標籤照 ADR-0029，同一天第二次加 `.1`。
- **`build` 是兩個 app 各自遞增的整數**（ADR-0035）。
- **標籤兩個 app 分開**：`android/v2026.11.20`、`ios/v2026.11.20`。不和網站的 `v*` 共用。
- **app 和網站的版本不互相對應。** 兩邊靠後台的介面和 `config` 相容。

## 金鑰分層

| 金鑰 | 是什麼 | 放在哪裡 |
|---|---|---|
| Android 的 app 簽章金鑰 | 手機靠它判斷一個更新和已經裝的是不是同一個 app。自己產生，交一份給 Google Play | 營運者離線保管。不放在 GitHub，CI 用不到它 |
| Android 的上傳金鑰 | 對 Google Play 證明這個 build 是我們傳的 | GitHub 的 environment |
| Google Play 的 API 金鑰 | 一個服務帳號，只給一個 app 的「Release apps to testing tracks」 | GitHub 的 environment |
| iOS 的發布憑證的私鑰 | 對 Apple 證明這個 build 是我們傳的 | GitHub 的 environment |
| App Store Connect 的 API 金鑰 | Developer 角色：能上傳，不能送審 | GitHub 的 environment |

- **測試 app 和正式 app 各一個 environment、各一組金鑰**，可以分別撤銷；正式的那個要營運者核准。測試 app 的 Android 簽章金鑰是另一把。
- **Android 的簽章金鑰自己產生。** Google Play 的說明：「You can have Google generate this key, or you can provide your own. This key cannot be reset if you manage it yourself and lose it.」；上傳金鑰「If compromised or lost, Google can reset it for you.」（[Use Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756)，2026-11-20 讀）。新的 app 預設由 Google 產生，要在第一次發到公開測試或正式軌道之前改成自己提供。
- **Google Play 的 API 金鑰發不了正式版。**「Release apps to testing tracks」的說明寫「Does not allow users to publish apps to production on Google Play」，權限可以只給一個 app（[Add developer account users and manage permissions](https://support.google.com/googleplay/android-developer/answer/9844686)）。
- **Apple 的 API 金鑰不能只給一個 app。**「Team API keys can access all apps, regardless of their role.」（[Creating API keys for App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)）。所以測試 app 的金鑰外流時，拿到的人能把 build 傳到正式 app 底下，但不能送審（[Program roles](https://developer.apple.com/help/account/access/roles/)）。擋在這裡的是送審由營運者手動做。
- **iOS 的私鑰能不能不放 CI，施工前實測。** Xcode 可以用 Apple 代管的憑證，CI 只拿 API 金鑰；文件寫這預設要 Admin 角色（[Xcode 13 release notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-13-release-notes)）。Developer 角色的金鑰做得到就用它，私鑰不放任何地方；做不到就照上面的表。不用 Admin 角色的金鑰。

## 可重現的建置

| | 做到哪裡 |
|---|---|
| Android | 任何人能拿一個標籤自己建置，和手機上從 Google Play 裝的逐檔比對。跳過哪些檔、哪些欄位，公開列出來。比對的步驟在正式上線前做好 |
| iOS | 比不了，對外照實寫，不給任何「可驗證」的說法 |

- **Android 只能逐檔比，不能整個檔比。** Google Play 把上傳的檔拆成幾個安裝檔、重新簽章，並在 manifest 加欄位（[Use Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756)：「it uses apksigner to add two stamps to your app's manifest」）。做法照 Signal 公開的流程：用 `bundletool` 照同一支手機拆開自己建置的檔，再逐檔比（[Signal-Android 的 reproducible-builds](https://github.com/signalapp/Signal-Android/blob/main/reproducible-builds/README.md)）。
- **iOS 比不了的原因**：App Store 會對執行檔加 DRM（[Reducing your app's size](https://developer.apple.com/documentation/xcode/reducing-your-app-s-size)：「adding DRM to prevent app piracy」）。Telegram 的說明寫要越獄的手機才拿得到執行檔，而且仍有檔案比不了（[Reproducible Builds for iOS and Android](https://core.telegram.org/reproducible-builds)）。
- **`device-core/` 和內建的電路檔**（ADR-0034、ADR-0035）在 Android 上比得到。iOS 用的是同一份原始碼，但裝到手機上的那一份沒有人能比對。
- **建置從第一版就釘死工具鏈的版本和路徑。**

## 例外：Google Play 的封閉測試

Google Play 新的個人帳號要先跑封閉測試，至少 12 位測試者連續加入 14 天，才能申請正式上架（[App testing requirements for new personal developer accounts](https://support.google.com/googleplay/android-developer/answer/14151465)）。官方沒有明講這是照 app 還是照帳號算，但句子都照 app 寫，申請的入口在每個 app 自己的頁面；同一頁寫明要求繼續測試的理由包含「insufficient tester engagement during the testing period」。

- **封閉測試用正式 app 的識別碼跑，那一段期間的 build 連測試網站**，畫面標明是測試。這是「正式 app 連正式網站」唯一的例外。
- **拿到正式上架的資格之後，建置的設定拿掉這一種組合。**
- **上線時**同一個識別碼發連正式網站的 build，測試者照一般的更新收到。測試網站的最低版本（ADR-0035）同時調高，還沒更新的 app 在要 PIN 之前停下來。
- 申請時照實寫測試期間連的是測試環境。

## 理由

- **能上傳的金鑰不放在跑 coding agent 的電腦上**，和 ADR-0029 相同。測試網站允許從營運者的電腦部署，是為了開發時直接看結果；app 用線裝到手機就看得到，不需要上傳的金鑰。
- **Android 的簽章金鑰是唯一丟了補不回來的。** 它外流時，拿到的人簽的安裝檔，手機會當成這個 app 的更新。CI 用不到它，所以不放在 CI。自己產生，任何人才能核對安裝檔是哪一把金鑰簽的，離開 Google Play 時也還能發更新。
- **iOS 沒有對應的金鑰。** 發布憑證可以撤銷重發，已經裝的 app 不受影響。
- **送審和發布留給營運者手動做**，CI 的金鑰就能縮到只能上傳。正式版不常發。
- **正式 app 的標籤要先有測試 app 的 build**：正式 app 的每一行程式都先在手機上用測試 app 跑過，兩個 build 只差識別碼、連的網站和場合字串。
- **iOS 不講做不到的事。** 說「可驗證」而實際上沒有人能比對，比不說更糟。
- **封閉測試連測試網站**：三個月過一次卡的 app，測試者在正式網站上過一次卡就沒事可做；在測試網站可以重複過卡、試各種錯誤，測試名冊可以清空。

## Considered Options

- **營運者的電腦也能上傳測試 app**：和測試網站一致，但電腦上會多一把 Apple 的金鑰，而那把金鑰碰得到正式 app。
- **合併到 `main` 就上傳測試 app**：測試者每個提交都收到更新；macOS 的建置慢。
- **Android 的簽章金鑰由 Google 產生**：不用自己保管。但沒有人能核對金鑰是哪一把，離開 Google Play 就發不了更新，而且註冊之後改不了。
- **Android 的簽章金鑰放 GitHub，自己簽好再上傳**：CI 外流就是簽章金鑰外流，而它不能重設。
- **CI 只放 Admin 角色的 Apple API 金鑰，憑證由 Apple 代管**：少放一把私鑰，但把能送審、能改帳號設定的權限放進了 CI。
- **CI 直接送審、發布**：少按一次，但 CI 的金鑰要能發正式版。
- **兩個 app 共用一個標籤**：常常只有一個 app 要修。
- **app 的標籤和網站共用 `v*`**：一個標籤會同時觸發網站的部署和 app 的上傳。
- **封閉測試用測試 app 的識別碼跑**：很可能不算數，正式 app 要再等 14 天。
- **封閉測試的 build 連正式網站**：正式名冊要在公開之前開張；測試者過一次卡就沒事可做。
- **封閉測試放一個過卡還沒開放的 build**：Google Play 不收沒有功能的 app（[Minimum Functionality](https://support.google.com/googleplay/android-developer/answer/9898783)），測試者也沒有東西可用。
- **iOS 也承諾可重現的建置**：做得到的只有「我們的建置是確定的」，沒有人能拿它和手機上的那一份比。

## Consequences

- **程式庫公開之前，GitHub 的 environment 還不能用**（ADR-0029 的 Consequences）。公開之前只有測試 app，它的金鑰先放在程式庫的 secrets。
- **正式 app 的識別碼有一段時間裝的是連測試網站的 build。** 那個 build 掃測試網站的 QR code 不會開 app，因為正式 app 的識別碼認的是正式的連結主機。
- **每次發正式 app 之前要先觸發一次測試 app 的上傳。**
- **iOS 的測試 app 和正式 app 沒有金鑰上的隔離。**
- **還沒驗證的**：兩個識別碼在 iPhone 上並存；Developer 角色的金鑰能不能用 Apple 代管的憑證；封閉測試照 app 算（推論）；TestFlight 的 build 有沒有加 DRM。
- **`CONTRIBUTING.md`「部署會執行到的東西」要加上 app 的建置**：Gradle、Xcode、Cargo 的設定和建置腳本會在拿著金鑰的工作流程裡執行。施工時補。

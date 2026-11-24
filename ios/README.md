# ios/：iPhone 的 app（Swift）

**這個目錄讓人檢查的事：憑證、公鑰、簽章、PIN 沒有離開手機，而且 app 算的和檢查的就是 `device-core/` 那一份。** 協定的算法、裝置上的檢查、算證明都在 `device-core/`（Rust，ADR-0034），這裡的 Swift 只呼叫它對外的 C 函式（`idc_` 開頭），不自己算。之後的畫面、讀卡、送出請求都寫在這個目錄；要看 PIN 去了哪裡，看這裡就夠，`device-core/` 沒有任何函式收 PIN。

這個目錄不引用 `protocol/`、`worker/`，沒有第三方的套件。

## 現在有什麼

過卡的六個畫面和流程（[#170](https://github.com/iamreal-tw/iamreal/issues/170)），照網頁版 `web/src/flow.ts` 的順序，卡片感應三次（[#133](https://github.com/iamreal-tw/iamreal/issues/133)）。讀卡還沒有：這個 build 的「卡片」每一次感應都回「沒有感應到卡片」，NFC 在 [#174](https://github.com/iamreal-tw/iamreal/issues/174) 接上。畫面和啟動畫面照 `design/screens/` 的定稿（[#296](https://github.com/iamreal-tw/iamreal/issues/296)），完成的畫面和網頁的結構相同；感應位置的示意圖在 #174，提醒和設定在 [#298](https://github.com/iamreal-tw/iamreal/issues/298)。

| 檔案 | 內容 |
|---|---|
| `App/DeviceCore.swift` | `device-core/` 的 C 函式包成 Swift：位元組進、位元組出；核心交出來的每一塊緩衝區複製後立刻還給核心（核心會先蓋成零）。一次過卡的 session 是 `DeviceCore.Session`，放掉時核心把憑證和算出來的東西蓋成零 |
| `App/Card.swift` | 「卡片」這一層：一次感應（`tap`）裡讀憑證、帶 PIN 簽章。`PIN` 也在這裡：只在記憶體，`clear()` 蓋成零 |
| `App/Backend.swift` | 「後台」這一層：`config`、清冊鏡像的兩種檔、查現況、題目、送出。位元組進出，請求和回應的內容由核心寫和讀 |
| `App/CardProofFlow.swift` | 一次過卡，沒有畫面的狀態機。每一步呼叫核心的哪個函式、PIN 和憑證和簽章各留到什麼時候，寫在檔頭 |
| `App/CardProofModel.swift`、`App/Screen.swift`、`App/Screens.swift` | 畫面看到的過卡：`Screen` 是一個畫面上從上到下的每一句話和每一個按鈕，`Screens` 決定 `design/copy/card-proof.md` 的哪一句放在哪裡，`CardProofModel` 做按鈕要做的事 |
| `App/CardProofView.swift` | 把 `Screen` 畫出來（SwiftUI，`ScreenView`），照 `design/screens/` 的 `card-proof-app-*`。它自己沒有任何句子，也不做任何判斷 |
| `App/Theme.swift` | 畫面用的數值：`design/tokens.json` 裡 app 用到的那幾個，有 `-phone` 的用 `-phone` 的值。標題用包進 app 的源流明體 TW（執行時向系統登記，`Info.plist` 是產生的，不在那裡列）；其他的字用系統的字型 |
| `App/Mark.swift` | 記號：斜放的卡片和從後面站起來的島，和 `web/src/ui/logo.ts` 同一張圖、同一份輪廓 |
| `App/SplashView.swift` | 啟動畫面：記號和「島民證明 │ iamreal.tw」（`design/copy/app.json`）。打開 app 時顯示一秒，同時向後台拿 `config`。系統自己的啟動畫面沒有改（它只能放圖片和底色，改它要動專案檔） |
| `App/Copy.swift`、`App/Platforms.swift` | 句子從 `design/copy/card-proof.json` 讀，不屬於過卡的從 `design/copy/app.json` 讀（兩個檔都原樣包進 app）；Threads 的名稱、`@`、怎麼整理輸入的帳號、個人檔案的網址寫死在 app |
| `App/CRLNumbers.swift` | 每一把發證金鑰用過的最高清冊編號。過卡之後 app 唯一留下來的東西，是公開的數字 |
| `App/AppEnvironment.swift` | 這個 build 連哪個網站、簽哪一份證明紀錄的場合字串。建置時寫死 |
| `App/BundledFile.swift` | 包進 app 的檔案 |
| `App/IamrealApp.swift` | app 的進入點：用上面那些組出這個 build 的過卡 |
| `App/Bridge.h` | Swift 看得到的 C：只有 `device-core/include/iamreal_device_core.h` |
| `App/Assets.xcassets` | app 的圖示。暫時的：網站的 `--teal`（`#226977`）一整片，沒有字和圖案，正式的圖示在 [#154](https://github.com/iamreal-tw/iamreal/issues/154) 定。App Store Connect 不收沒有圖示的 build |
| `Config/Shared.xcconfig`、`Config/Test.xcconfig` | 最低的 iOS 版本、只做 iPhone、連結哪一份核心；兩種 build 的識別碼和測試網站的環境 |
| `IamrealApp.xcodeproj` | 手寫的 Xcode 專案，兩個 target：`IamrealApp`、`IamrealAppTests`。`App/`、`Tests/` 是跟著資料夾走的群組，加檔案不用改專案檔 |
| `build-core.sh` | 編 `device-core/` 給 iOS 用，並下載、核對 Barretenberg 的靜態函式庫和參數檔 |
| `check-app.sh`、`check-app-test.sh` | 建置時的檢查，和它自己的測試 |
| `archive.sh`、`check-archive.sh`、`check-archive-test.sh`、`ExportOptions.plist` | 上傳到 TestFlight 的 archive、對它的檢查和檢查的測試、簽章和上傳的設定（「上傳到 TestFlight」） |
| `Tests/` | 在模擬器上跑的測試，包含假卡片（`Tests/FakeCard.swift`） |

### PIN、憑證、簽章在哪裡

要檢查它們有沒有離開手機，看這幾個檔就夠：

- **PIN**：從畫面的欄位（`CardProofView` 的 `SecureField`，值在 `CardProofModel.pinText`）進 `PIN`，按下「確認卡片」時欄位清空。`PIN` 交給 `CardProofFlow`，留到第三次感應送給卡片為止；完成、取消、停下來、卡片回 PIN 不正確時蓋成零。唯一收 PIN 的對外介面是 `CardConnection.sign`。`Backend`、`DeviceCore` 沒有任何函式收 PIN
- **第二、第三次感應**：`CardProofFlow.signTap` 先再讀一次憑證，第一次感應選定的那一張要在裡面，才把 PIN 交給卡片；不在就是 `CardFailure.otherCard`，PIN 沒有送
- **憑證和簽章**：選定的憑證和第一個簽章留在 `CardProofFlow`，證明算完就蓋成零；核心自己的那一份跟著 session 蓋掉
- **姓名**：核心檢查憑證後回傳，只交給「輸入 PIN」的畫面
- **不寫磁碟**：過卡做到一半的狀態只在 `CardProofModel` 和 `CardProofFlow` 的記憶體裡，沒有用系統保存畫面狀態的任何機制，app 被系統結束就從第 1 步來。`Tests/BuildTests.swift` 檢查 `App/` 的原始碼沒有寫檔、偏好設定、鑰匙圈、狀態保存的呼叫，例外只有 `CRLNumbers.swift` 的清冊編號和持卡人按「複製連結」時的剪貼簿

已知的限制：`SecureField` 交出來的是 Swift 的 `String`，欄位清空之後它在記憶體裡的那一份 app 蓋不到；`PIN` 自己的位元組會蓋成零。

### 還沒有的

- 讀卡（NFC，[#174](https://github.com/iamreal-tw/iamreal/issues/174)）：entitlement、`NFCReaderUsageDescription`、`Info.plist` 的 AID 清單、系統的讀卡面板和面板上的句子
- 中斷和錯誤（[#172](https://github.com/iamreal-tw/iamreal/issues/172)）：掉線後只重做那一次感應、送 PIN 時掉線、5 分鐘的上限、最低版本（`min_app`）、沒有 NFC。這裡已經有的只有：PIN 不正確時丟掉 PIN 再問一次、第二或第三次感應換了卡時不送 PIN 並可以再感應一次、手機的日期和題目的日期不同時在第三次感應之前停下、後台沒有回應時同一筆再送一次（網頁版在後台回 429、5xx 時也可以再送，再送被回「題目用過了」時會查現況確認那一筆是不是已經記下，這裡還沒有）
- 文字沒有對應句子的兩種情況，畫面只顯示代碼，和網頁版相同（`web/src/ui/messages.ts`）：核心回了 app 不認得的憑證原因代碼、app 自己把步驟的順序叫錯（`state`）。兩種都是程式的錯，不是持卡人會遇到的情況；要不要有一句話留給 #172
- 清冊的索引或檔案下載不到時，畫面一律寫「現在拿不到可用的內政部廢止清冊……（代碼 `crl_unavailable`）」，不分是連不上還是 HTTP 的錯誤：`spec/device-checks.md` 把兩種都歸在 `crl_unavailable`，網頁版也一樣
- `design/copy/card-proof.md` 標了「app 的寫法還沒有定」的句子，先用網頁的那一句：讀卡時的其他錯誤、讀到兩張都通過檢查的憑證、檔案的內容和預期的不同、算不出證明、後台列了而 app 不認得的平台那一列、完成的畫面讀不出後台回報每個帳號記成什麼時的那一句；要「再讀一次卡片」的地方，按鈕先用「再感應一次卡片」

主畫面上 app 的名稱，商店的 build 是「島民證明 測試」，開發用 build 是「島民證明 dev」（`design/copy/app.md`，第一版，Android 相同）；正式的名稱在商店頁的那張票定（[#154](https://github.com/iamreal-tw/iamreal/issues/154)）。每個畫面最上面有「測試的證明紀錄」的標示（`design/copy/test-site.md`）。

## 環境在建置時寫死

同一個 app 有兩種 build（ADR-0037），識別碼不同，可以同時裝在一支 iPhone 上。專案的兩個組態各做一種：

| | 商店的 build | 開發用 build |
|---|---|---|
| 組態 | Release | Debug |
| 識別碼 | `tw.iamreal.app` | `tw.iamreal.app.dev` |
| 圖示下面的名稱（`design/copy/app.md`） | 島民證明 測試 | 島民證明 dev |
| 連哪裡 | 上線前：`https://test.iamreal.tw`、`https://test-data.iamreal.tw`（ADR-0028） | 同左，上線後也是 |
| 卡片簽的場合字串 | 上線前：`iamreal-test:public:0`（核心的 `IDC_PROOF_LOG_TEST`） | 同左，上線後也是 |
| 怎麼裝 | TestFlight、App Store（從 GitHub Actions 上傳：「上傳到 TestFlight」） | 用線裝（「怎麼用線裝到手機」）；給少數測試者用 Ad Hoc，還沒有做 |

兩個組態都以 `Config/Test.xcconfig` 為底：這個檔照組態定識別碼，並定一個編譯條件 `IAMREAL_ENV_TEST`；`App/AppEnvironment.swift` 照編譯條件給網址和哪一份證明紀錄，沒有條件就編不過。名稱照組態寫在專案檔（`INFOPLIST_KEY_CFBundleDisplayName`）。app 裡沒有切換環境的設定，後台也不能叫 app 換環境。上線那天用一個 PR 讓 Release 改用正式網站的設定檔；正式網站的設定現在還沒有。

## 最低的 iOS 版本：15.0；只做 iPhone

最低版本取兩個要求裡較高的（[#98](https://github.com/iamreal-tw/iamreal/issues/98) 第 3 點），不往上加：

- **Barretenberg 預先編好的 iOS 函式庫：15.0。** 讀它的 `LC_BUILD_VERSION`：

  ```
  xcrun otool -l "$(../device-core/fetch-barretenberg.sh arm64-ios)/libbb-external.a" | grep -A4 LC_BUILD_VERSION | grep minos | sort -u
  ```

  2026-11-20 讀 `v6.0.0` 的 `arm64-ios` 和 `arm64-ios-sim`，每一個目的檔都是 `minos 15.0`。
- **用 NFC 讀 ISO 7816 的卡片：13.0**（[#85](https://github.com/iamreal-tw/iamreal/issues/85)）。

這個數字寫在 `Config/Shared.xcconfig` 的 `IPHONEOS_DEPLOYMENT_TARGET`，`build-core.sh` 編 Rust 時讀同一行。這台開發用的電腦上只有 iOS 18.3 和 26.0 的模擬器，15.0 的手機或模擬器上還沒有跑過。

只做 iPhone：`TARGETED_DEVICE_FAMILY = 1`（沒有 iPad 的介面），也不給 Mac 和 Vision Pro 當 iPhone app 裝（`SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD`、`SUPPORTS_XR_DESIGNED_FOR_IPHONE_IPAD` 都是 `NO`）。iPad 仍然能用相容模式裝 iPhone 的 app；要讓 iPad 裝不了，得在 `UIRequiredDeviceCapabilities` 要求 `nfc`，那一項和讀卡一起加（#174）。模擬器只支援 Apple 晶片的 Mac：Aztec 沒有給 Intel Mac 的 iOS 模擬器用的函式庫。

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

- 同一張卡片新宣告、再次過卡、隔天更換、收回各一次，每個畫面上的每一句話和預期的逐句相同，而且每一句都在 `design/copy/card-proof.md` 裡
- 第一次感應不送 PIN；第二、第三次感應換成另一張卡時，那張卡沒有收到 PIN，畫面請持卡人換回來，再感應一次就接著做
- 完成、取消、PIN 不正確之後，記憶體裡沒有 PIN
- app 一打開（畫面第一次畫出來）就向後台拿 `config`，過卡用的是那一份
- 手機的日期和後台差一天時，停在第三次感應之前，卡片沒有被要求簽第二次
- 完成的畫面複製的連結、「打開你的島民證明」開的網址（Worker 上那一頁真的列出帳號）、「打開 @alice 的 Threads 個人檔案」開的網址、「分享」交給分享面板的網址（只有這張島民證明的網址）
- 每個畫面的截圖寫到 `web/test-output/app/screens-ios/`

`ios/` 不引用 `worker/`：和那個腳本之間只有 `backend.json` 和 HTTP。拉取請求的檢查（`.github/workflows/checks-ios.yml`）沒有跑這一段。

### 模擬器的函式庫認測試金鑰

假卡片的憑證是測試金鑰簽的，app 的 session（`idc_session_open`）只認內政部的金鑰，第一步就不收。所以 `build-core.sh simulator` 多編一份測試用的函式庫：`device-core/` 開了 cargo feature `test-issuers`，多一個函式 `idc_testing_session_open`，開一個改認呼叫的人給的發證金鑰的 session。這個 feature 只多這一個函式；核心自己的測試用的 `testing`（會把 Poseidon2、建樹開出來）這裡不開。那一份編在自己的目錄 `device-core/target/test-issuers/`。

- 只有模擬器的 Debug 組態連結它（`Config/Shared.xcconfig`），也就是 `xcodebuild test` 跑的那一種
- 只有 `Tests/` 看得到那個函式（`Tests/Bridge.h`），`App/` 的橋接檔沒有它的宣告
- 模擬器的 Release、給手機的 Debug 和 Release 連結的都是沒有開 feature 的那一份。`check-app.sh` 擋下這幾種 app 裡出現這個函式的名稱或那個函式庫的記號；`check-app-test.sh` 有這兩案。拉取請求的檢查會建一次模擬器的 Release 和一次給手機的 archive，上傳的 build 都是給手機的 Release

### 測試讀什麼

測試在模擬器裡跑，直接讀這個程式庫在 Mac 上的檔案（模擬器看得到 Mac 的磁碟），不複製。

- `Tests/DeviceCoreTests.swift`：從 Swift 呼叫核心，對 `spec/vectors/scope.json`（兩份證明紀錄的場合字串）；連結進來的函式庫的版本等於標頭檔的；Barretenberg 有回應
- `Tests/BuildTests.swift`：這個 build 是開發用 build（識別碼、網址、場合字串；測試跑在 Debug；Release 的識別碼、名稱、網址由 `check-app.sh` 看）、只給 iPhone、內建的檔案都在而且就是上表的來源、參數檔的雜湊和網頁版下載時核對的相同、「測試的證明紀錄」的標示和 app 的名稱在 `design/copy/`、包進去的 `card-proof.json`、`app.json`、字型和程式庫裡的逐位元組相同；`App/` 的原始碼用到的每一句都在 `design/copy/card-proof.json`（啟動畫面的在 `app.json`）、自己沒有寫任何中文的句子；`App/` 的原始碼不寫磁碟
- `Tests/CardProofTests.swift`：用假卡片過卡（上面那一節）
- `Tests/ThemeTests.swift`：`App/Theme.swift` 的每一個數值和 `design/tokens.json` 同名的那一個相同；標題的字型是 `--font-display` 的第一個，而且就是包進 app 的那一份
- `Tests/ScreensTests.swift`：不用後台，拿 `design/copy/card-proof.md` 的例子（`@alice`、`7K2Q9FM4XD`、2026-11-16、王小明）做出第一次宣告的每一個畫面：每一句都在文字檔裡、沒有「了解更多」；照 app 畫的樣子拍成 390 點寬的整頁截圖，連同啟動畫面寫到 `web/test-output/app/screens-ios/`，檔名就是 `design/screens/` 裡對應的那一張（下面「截圖」）
- `Tests/DoneScreenTests.swift`：送出後後台的回應。`spec/vectors/records-response.json` 的每一案由核心讀（`idc_records_response`），app 拿到的和標準答案相同；完成的畫面說哪幾句：第一次宣告逐字照 `design/copy/card-proof.md` 第 6 步（含「app」那一節）、全部收回、已複製、和確認時相同、讀不出每個平台記成什麼、別的卡片也宣告了同一個帳號、和確認時不同的每一種。後台是誠實的時候用假卡片過卡遇不到最後一種，所以在這裡測
- `check-app-test.sh`：`check-app.sh` 讓建好的 app 通過，並擋下每一份改過的副本
- `check-archive-test.sh`：`check-archive.sh` 讓 `archive.sh` 做的 archive 通過，並擋下每一份改過的副本（「上傳到 TestFlight」）

### 截圖

`design/screens/` 裡 app 的截圖（`card-proof-app-1-before-phone.png`、`-3-pin`、`-4-accounts`、`-5-confirm`、`-5-progress`、`-6-done`、`app-splash-phone.png`）是 `Tests/ScreensTests.swift` 拍的：跑過 `xcodebuild test` 之後，從 `web/test-output/app/screens-ios/` 把同名的檔複製過去。畫面改了，就重拍、重新複製。讀取卡片的那一張（`card-proof-app-2-read-phone.png`）不複製：`design/screens/` 的 `card-proof-app-2-read-iphone-phone.png` 是感應位置的示意圖的定稿，等 [#174](https://github.com/iamreal-tw/iamreal/issues/174) 畫了示意圖再換。

## 建置時的檢查（`check-app.sh`）

app 的最後一個建置階段跑 `check-app.sh`，不過就是建置失敗。它檢查建出來的 `.app` 和 `App/` 的原始碼：

- 識別碼是這個組態的那一種 build 的（Debug 是 `tw.iamreal.app.dev`，Release 是 `tw.iamreal.app`；別的組態一律不過），圖示下面的名稱是 `design/copy/app.md` 給那一種 build 的；環境是 `IAMREAL_ENV_TEST`，執行檔裡有測試網站的兩個網址、沒有正式網站的。卡片簽的是不是測試的證明紀錄的場合字串，它從執行檔看不出來（兩條場合字串都寫死在核心裡），由 `Tests/BuildTests.swift` 檢查
- `UIDeviceFamily` 只有 iPhone
- 內建的電路檔、驗證金鑰和程式庫裡的逐位元組相同，參數檔的 SHA-256 等於 `device-core/crs.sha256`
- app 裡沒有任何執行檔連結 `AdSupport` 或 `AppTrackingTransparency`；沒有 `Frameworks/`；專案檔沒有 Swift 套件。這是「沒有第三方 SDK」能從建置看出來的部分
- 原始碼沒有 `identifierForVendor`
- `App/` 的原始碼沒有寫 log 或標準輸出的呼叫（`print`、`NSLog`、`os_log`、`Logger`、`FileHandle.standardError`、`fatalError` 等），Debug 也沒有；`device-core/` 兩個套件的 `src/` 沒有 `println!`、`eprintln!`、`dbg!`，也沒有拿 `stdout()`、`stderr()`。所以 release build 自己不輸出 log
- 模擬器的 Debug 以外的 app，執行檔裡沒有 `idc_testing_session_open` 和測試用函式庫的記號（上面「模擬器的函式庫認測試金鑰」）
- 原始碼只經過 `App/Bridge.h` 碰 C：它是 app 的 bridging header，內容只有引入 `device-core/` 標頭檔的那一行，`App/` 裡沒有別的 C、Objective-C 或 module map。測試的 target 另有 `Tests/Bridge.h`，內容只有引入測試用標頭檔的那一行。靜態函式庫裡還有 Barretenberg 自己的 C 函式，app 不准呼叫（`device-core/README.md`「Poseidon2 不開放成 C 函式」）

這些檢查是照字面找，防的是手誤，不能代替逐行看。看不到的有兩件：

- **Barretenberg 自己的程式會不會印東西。** 2026-11-20 在模擬器上跑 Release 的 build（只呼叫三個函式），系統的 log 裡沒有任何一行是 app 自己的執行檔寫的，`simctl launch --console` 也沒有收到輸出。2026-11-21 在模擬器上用假卡片算了四份證明（Debug 的 build，`xcodebuild test` 的輸出），那一段除了系統網路層自己的幾行之外沒有別的輸出；Release 的 build 算證明時還沒有看過
- **核心 panic 時 Rust 會印一行。** C 函式的邊界會接住 panic、回 `IDC_ERR_INTERNAL`，但 Rust 預設在接住之前先把 panic 的訊息和位置寫到標準錯誤。訊息是固定的字串（`device-core/README.md`「錯誤裡沒有值」），不含卡片、憑證、帳號的內容；要不要連這一行都不印，是 `device-core/` 的事

拉取請求的檢查另外建一次 Release 的組態，讓這些檢查也對 release build 跑過。

## 怎麼用線裝到手機

開發用 build（Debug，識別碼 `tw.iamreal.app.dev`），不經過商店（ADR-0037）。它和從 TestFlight、App Store 裝的商店 build 識別碼不同，兩個可以同時留在手機上。需要付費的 Apple 開發者帳號，Xcode 登入過；識別碼 `tw.iamreal.app.dev` 在帳號裡註冊過、開了 NFC Tag Reading（[#161](https://github.com/iamreal-tw/iamreal/issues/161)）。

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

## 上傳到 TestFlight

商店的 build（Release，`tw.iamreal.app`）只從 GitHub Actions 上傳（ADR-0036、ADR-0037），工作流程是 `.github/workflows/upload-ios.yml`。只能手動觸發，營運者或營運者電腦上的 coding agent 在 `main` 上觸發：

```
gh workflow run upload-ios.yml --repo iamreal-tw/iamreal --ref main
```

合併到 `main` 不會上傳。上傳成功之後，App Store Connect 處理完那個 build，TestFlight 的內部群組「營運者」自動收到（[#161](https://github.com/iamreal-tw/iamreal/issues/161)）。

### 兩個工作

| | `build` | `upload` |
|---|---|---|
| 拿得到金鑰 | 不能 | 能：environment `app-test` 的 App Store Connect API 金鑰（開發者角色的團隊金鑰，#161），那個 environment 只讓 `main` 上的執行拿 |
| 跑什麼 | 這個程式庫的程式：`build-core.sh device`，再 `archive.sh` | 不取出程式庫、不跑它的任何腳本：解開 `build` 交下來的 tar 檔，把團隊代號寫進 `ExportOptions.plist`，跑 Xcode 的 `xcodebuild -exportArchive` |
| 交出去的 | archive 包成一個 tar 檔（artifact 不保留檔案的權限），加 `ExportOptions.plist` | 上傳到 App Store Connect |

- **`archive.sh`** 做 Release 的 archive，不簽章（`CODE_SIGNING_ALLOWED=NO`；這個工作沒有能簽章的東西），最後跑 `check-archive.sh`。建置時 `check-app.sh` 照常當最後一個建置階段跑。
- **`check-archive.sh`** 確認要上傳的就是商店的 build：識別碼 `tw.iamreal.app`；版本和 build 是給它的那兩個數字，app 裡和 archive 自己的紀錄都是；app 有圖示（App Store Connect 不收沒有圖示的 build）；app 裡只有執行檔、Xcode 放的 `Info.plist`、`PkgInfo`、編好的圖示（`Assets.car` 和給舊版 iOS、給 iPad 相容模式的兩張 PNG）和「包進 app 的檔案」那九個，沒有測試（`PlugIns/`，假卡片在裡面）、沒有別的檔，執行檔裡沒有 `FakeCard`；再以 Release 跑一次 `check-app.sh`（連測試網站、沒有正式網站的網址、沒有測試用的函式庫 `idc_testing_session_open`、內建的檔和程式庫的相同）。卡片簽哪一份證明紀錄的場合字串，執行檔裡看不出來（兩條都寫死在核心）；它跟著網址走：`App/AppEnvironment.swift` 在同一個編譯條件底下定網址和證明紀錄，執行檔裡是測試網站的網址，所以編進去的是測試那一支，而 `Tests/BuildTests.swift` 確認那一支簽 `iamreal-test:public:0`。
- **簽章用 Apple 代管的發布憑證。** `ExportOptions.plist` 寫 `method` `app-store-connect`、`destination` `upload`、`signingStyle` `automatic`：Xcode 用 API 金鑰向 Apple 拿描述檔和代管的憑證，簽好直接上傳。發布憑證的私鑰不放在任何地方。開發者角色的金鑰能不能這樣做，是 [#143](https://github.com/iamreal-tw/iamreal/issues/143) 要實測的；做不到時，第一次執行的錯誤訊息記到 #143，再照 ADR-0036 把私鑰放進 `app-test`。
- **團隊代號**是 environment `app-test` 的 variable `APPLE_TEAM_ID`（不是 secret：每個簽過的 app 裡都看得到它）。archive 沒有簽章、沒有團隊，匯出要知道用哪個團隊（`xcodebuild -help`：`teamID`「Defaults to the team used to build the archive」）。沒有設這個 variable，`upload` 在拿到金鑰之前就失敗。團隊代號不寫進程式庫（「怎麼用線裝到手機」）。
- **`manageAppVersionAndBuildNumber` 是 `false`**：版本和 build 用 `archive.sh` 給的，Xcode 不另外改。`uploadSymbols` 是 `true`：Apple 收到當機報告時能還原成函式名稱（[#94](https://github.com/iamreal-tw/iamreal/issues/94)：當機只看商店自己的報告）。

### 版本和 build

- **版本是觸發那一天的台灣日期**，年.月.日、不補零，例如 `2026.11.5`、`2026.11.21`。App Store Connect 的版本只收三個整數（[`CFBundleShortVersionString`](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleshortversionstring)：「The required format is three period-separated integers」），所以同一天上傳第二次不加 `.1`（網站的標籤才加，ADR-0029），版本相同，靠 build 分（ADR-0036）。TestFlight 同一個版本可以有好幾個 build。
- **build 是這個工作流程的執行編號**（`GITHUB_RUN_NUMBER`），每次觸發加一，同一次執行重跑時不變。重跑一個已經傳上去的執行，App Store Connect 會拒收同一個 build；要再傳就重新觸發一次。
- **執行編號跟著工作流程走。** `upload-ios.yml` 改名、或刪掉再加回來，GitHub 當成新的工作流程，編號從 1 重來，比 App Store Connect 上已有的小，上傳會被拒。到那時候在 `upload-ios.yml` 給 `archive.sh` 的 build 加上一個固定的數（上一次的 build），並寫在這裡。沒有改成從 App Store Connect 讀最新的 build 再加一：`build` 沒有金鑰，build 要在建置時寫進 app。

### 合併後才驗得到的

這個工作流程只在 `main` 上、手動觸發才跑，拉取請求的檢查跑不到上傳的那一半：

- `build` 交下去的 tar 檔，和 `upload` 把團隊代號寫進 `ExportOptions.plist` 那一步，在本機試過，沒有在 runner 上跑過
- `build` 的指令：`checks-ios.yml` 每次用同樣的 `archive.sh` 做一次 archive、跑 `check-archive-test.sh`，所以拉取請求時就看得到；它沒有包成 tar 檔交下去
- `upload` 整個工作：開發者角色的金鑰能不能用代管的憑證簽章（#143）、App Store Connect 收不收這個 build
- 讀卡（[#174](https://github.com/iamreal-tw/iamreal/issues/174)）加了 entitlement（NFC）之後：archive 沒有簽章，裡面沒有 entitlement；Xcode 匯出時給的 entitlement 有沒有 NFC，要看第一個有讀卡的 build。沒有的話 `build` 改成在 archive 時帶 entitlement 的檔，或在 `upload` 匯出後檢查

### 上傳之後營運者做的

- **第一次觸發之前**：在 environment `app-test` 加 variable `APPLE_TEAM_ID`（團隊代號）。

- **出口管制的加密問題。** `Info.plist` 沒有寫 `ITSAppUsesNonExemptEncryption`，每個 build 在 App Store Connect 會先停在「Missing Compliance」，營運者回答過才會到測試者手上。app 和卡片之間的安全通道有加密，回答前先查 Apple 的說明（「[規格：手機 app 第一份](https://github.com/iamreal-tw/iamreal/issues/155)」）；答案定了可以寫進 `Info.plist`，之後的 build 就不用每次回答。
- **對外測試的群組**：第一個 build 上傳之後才能建，關掉截圖回饋（#161）。

## 工具和版本

版本都釘死；沒有任何套件管理工具裝進來的東西。

- **Xcode 27.2**（build 27B52）。拉取請求的檢查用 GitHub 的 `xcode-27` runner 上 `/Applications/Xcode_27.2.app` 那一份，同一個 build（來源見 `.github/README.md`）
- **Rust**：`device-core/rust-toolchain.toml` 的那一版，加 `aarch64-apple-ios-sim`、`aarch64-apple-ios` 兩個 target
- **Barretenberg 6.0.0 的靜態函式庫、參數檔**：下載後核對 `device-core/barretenberg.sha256`、`device-core/crs.sha256`
- 專案檔是手寫的，不用產生專案的工具；沒有 CocoaPods、Swift Package、Carthage

顯示的版本用日期（`MARKETING_VERSION`），`build`（`CURRENT_PROJECT_VERSION`）是遞增的整數（ADR-0036）。上傳的 build 由 `archive.sh` 在建置時給（「上傳到 TestFlight」）；專案檔裡的固定值只是用線裝的開發用 build 用的。

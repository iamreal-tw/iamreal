# ios/：iPhone 的 app（Swift）

**這個目錄讓人檢查的事：憑證、公鑰、簽章、PIN 沒有離開手機，而且 app 算的和檢查的就是 `device-core/` 那一份。** 協定的算法、裝置上的檢查、算證明都在 `device-core/`（Rust，ADR-0034），這裡的 Swift 只呼叫它對外的 C 函式（`idc_` 開頭），不自己算。之後的畫面、讀卡、送出請求都寫在這個目錄；要看 PIN 去了哪裡，看這裡就夠，`device-core/` 沒有任何函式收 PIN。

這個目錄不引用 `protocol/`、`worker/`、`server/`，沒有第三方的套件。

## 現在有什麼

這是殼（[#168](https://github.com/iamreal-tw/iamreal/issues/168)）：建置、連結、測試的路先通，畫面只顯示核心回傳的幾個值。

| 檔案 | 內容 |
|---|---|
| `App/DeviceCore.swift` | `device-core/` 的 C 函式包成 Swift：位元組進、位元組出；核心交出來的每一塊緩衝區複製後立刻還給核心（核心會先蓋成零） |
| `App/AppEnvironment.swift` | 這個 build 連哪個網站、簽哪一份名冊的場合字串。建置時寫死 |
| `App/BundledFile.swift` | 包進 app 的六個檔案 |
| `App/CoreReport.swift`、`App/IamrealApp.swift` | 殼的畫面：`idc_abi_version`、`idc_self_check`、`idc_scope_string` 的結果，讀得到幾個內建的檔案 |
| `App/Bridge.h` | Swift 看得到的 C：只有 `device-core/include/iamreal_device_core.h` |
| `Config/Shared.xcconfig`、`Config/Test.xcconfig` | 最低的 iOS 版本、只做 iPhone、連結哪一份核心；測試 app 的識別碼和環境 |
| `IamrealApp.xcodeproj` | 手寫的 Xcode 專案，兩個 target：`IamrealApp`、`IamrealAppTests`。`App/`、`Tests/` 是跟著資料夾走的群組，加檔案不用改專案檔 |
| `build-core.sh` | 編 `device-core/` 給 iOS 用，並下載、核對 Barretenberg 的靜態函式庫和參數檔 |
| `check-app.sh`、`check-app-test.sh` | 建置時的檢查，和它自己的測試 |
| `Tests/` | 在模擬器上跑的測試 |

還沒有的（各有自己的票）：過卡的畫面和流程、讀卡（NFC，[#174](https://github.com/iamreal-tw/iamreal/issues/174)）、上傳到 TestFlight（[#176](https://github.com/iamreal-tw/iamreal/issues/176)）。NFC 的 entitlement、`NFCReaderUsageDescription`、`Info.plist` 的 AID 清單在讀卡那張票加，這裡還沒有。

## 環境在建置時寫死

現在只有測試 app（ADR-0036）：

| | 值 |
|---|---|
| 識別碼 | `tw.iamreal.app.test` |
| 連哪裡 | `https://test.iamreal.tw`、`https://test-data.iamreal.tw`（ADR-0028） |
| 卡片簽的場合字串 | `iamreal-test:public:0`（核心的 `IDC_ROSTER_TEST`） |

專案的兩個組態（Debug、Release）都以 `Config/Test.xcconfig` 為底，所以每一個 build 都是測試 app。這個檔定識別碼和一個編譯條件 `IAMREAL_ENV_TEST`；`App/AppEnvironment.swift` 照編譯條件給網址和名冊，沒有條件就編不過。app 裡沒有切換環境的設定，後台也不能叫 app 換環境。

## 最低的 iOS 版本：15.0；只做 iPhone

最低版本取兩個要求裡較高的（[#98](https://github.com/iamreal-tw/iamreal/issues/98) 第 3 點），不往上加：

- **Barretenberg 預先編好的 iOS 函式庫：15.0。** 讀它的 `LC_BUILD_VERSION`：

  ```
  xcrun otool -l "$(../device-core/fetch-barretenberg.sh arm64-ios)/libbb-external.a" | grep -A4 LC_BUILD_VERSION | grep minos | sort -u
  ```

  2026-11-20 讀 `v6.0.0` 的 `arm64-ios` 和 `arm64-ios-sim`，每一個目的檔都是 `minos 15.0`。
- **用 NFC 讀 ISO 7816 的卡片：13.0**（[#85](https://github.com/iamreal-tw/iamreal/issues/85)）。

這個數字寫在 `Config/Shared.xcconfig` 的 `IPHONEOS_DEPLOYMENT_TARGET`，`build-core.sh` 編 Rust 時讀同一行。這台開發用的電腦上只有 iOS 18.3 和 26.0 的模擬器，15.0 的手機或模擬器上還沒有跑過。

只做 iPhone（`TARGETED_DEVICE_FAMILY = 1`）：iPad 沒有能讀這張卡的 NFC。模擬器只支援 Apple 晶片的 Mac：Aztec 沒有給 Intel Mac 的 iOS 模擬器用的函式庫。

## 包進 app 的檔案

app 算證明要的檔案都在安裝檔裡，執行時不下載（ADR-0035）：

| app 裡的檔名 | 來源 |
|---|---|
| `card_proof_rs2048.json`、`card_proof_rs4096.json` | `web/circuits/`（版控裡的檔，和網頁版同一份） |
| `card_proof_rs2048.vk`、`card_proof_rs4096.vk` | `verifier/vk/`（後台和重驗的人用的那兩把） |
| `bn254_g1_compressed_2p18.dat`、`bn254_g2.dat` | 參數檔。`device-core/fetch-crs.sh` 下載，核對 `device-core/crs.sha256`，和網頁版的 `web/scripts/fetch-crs.mjs` 是同樣的兩個檔 |

Xcode 專案直接引用這些位置，不另存一份。核心在用之前還會自己核對每個檔的 SHA-256（算證明的那張票）。

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

- `build-core.sh` 先下載 Barretenberg 的靜態函式庫（`device-core/fetch-barretenberg.sh`）和參數檔（`device-core/fetch-crs.sh`），兩者都核對 SHA-256 才用，再用 `cargo build --locked --release` 編出 `device-core/target/<target>/release/libiamreal_device_core.a`。Xcode 專案連結的就是那個位置的檔，所以改了 `device-core/` 要重跑它。它不放進 Xcode 的建置階段：下載不該發生在 Xcode 的建置裡，Xcode 給建置階段的環境變數（`SDKROOT` 等）也是給 iOS 的，不是給 cargo 在 Mac 上跑的建置腳本的。
- `xcodebuild test` 建置 app、跑 `check-app.sh`、在模擬器上跑 `Tests/`。
- 拉取請求的檢查（`.github/workflows/checks-ios.yml`）跑的就是上面三行，只在改到 `ios/`、`device-core/` 或那個工作流程檔時跑。

要在模擬器上看畫面：用 Xcode 打開 `IamrealApp.xcodeproj` 按執行，或 `xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/IamrealApp.app` 再 `xcrun simctl launch booted tw.iamreal.app.test`。

### 測試讀什麼

測試在模擬器裡跑，直接讀這個程式庫在 Mac 上的檔案（模擬器看得到 Mac 的磁碟），不複製。

- `Tests/DeviceCoreTests.swift`：從 Swift 呼叫核心，對 `spec/vectors/scope.json`（兩份名冊的場合字串）、`spec/vectors/declaration-code.json`（每一案的宣告碼）；連結進來的函式庫的版本等於標頭檔的；讀不懂的輸入得到核心的代碼
- `Tests/BuildTests.swift`：這個 build 是測試 app（識別碼、網址、場合字串）、只給 iPhone、六個內建的檔案都在而且就是上表的來源、畫面上的字在 `design/copy/`
- `check-app-test.sh`：`check-app.sh` 讓建好的 app 通過，並擋下每一份改過的副本

## 建置時的檢查（`check-app.sh`）

app 的最後一個建置階段跑 `check-app.sh`，不過就是建置失敗。它檢查建出來的 `.app` 和 `App/` 的原始碼：

- 識別碼是 `tw.iamreal.app.test`，執行檔裡有測試網站的兩個網址、沒有正式網站的
- `UIDeviceFamily` 只有 iPhone
- 內建的電路檔、驗證金鑰和程式庫裡的逐位元組相同，參數檔的 SHA-256 等於 `device-core/crs.sha256`
- app 裡沒有任何執行檔連結 `AdSupport` 或 `AppTrackingTransparency`；沒有 `Frameworks/`；專案檔沒有 Swift 套件。這是「沒有第三方 SDK」能從建置看出來的部分
- 原始碼沒有 `identifierForVendor`
- 原始碼沒有寫 log 的呼叫（`print`、`NSLog`、`os_log`、`Logger` 等），Debug 也沒有，所以 release build 不輸出 log
- 原始碼只經過 `App/Bridge.h` 碰 C，而它只引入 `device-core/` 的標頭檔。靜態函式庫裡還有 Barretenberg 自己的 C 函式，app 不准呼叫（`device-core/README.md`「Poseidon2 不開放成 C 函式」）

這些檢查是照字面找，防的是手誤，不能代替逐行看。它看不到 Barretenberg 和 Rust 自己會不會印東西：2026-11-20 在模擬器上跑 Release 的 build，app 自己的執行檔沒有寫出任何一行 log，標準輸出和標準錯誤也是空的；算證明加進來之後要再看一次。

## 怎麼用線裝到手機

開發用的建置，不經過商店（ADR-0036：營運者的電腦只做這一種）。需要付費的 Apple 開發者帳號，Xcode 登入過；識別碼 `tw.iamreal.app.test` 在帳號裡註冊過。

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

## 工具和版本

版本都釘死；沒有任何套件管理工具裝進來的東西。

- **Xcode 27.2**（build 27B52）。拉取請求的檢查用 GitHub 的 `xcode-27` runner 上 `/Applications/Xcode_27.2.app` 那一份
- **Rust**：`device-core/rust-toolchain.toml` 的那一版，加 `aarch64-apple-ios-sim`、`aarch64-apple-ios` 兩個 target
- **Barretenberg 6.0.0 的靜態函式庫、參數檔**：下載後核對 `device-core/barretenberg.sha256`、`device-core/crs.sha256`
- 專案檔是手寫的，不用產生專案的工具；沒有 CocoaPods、Swift Package、Carthage

顯示的版本用日期（`MARKETING_VERSION`，例如 `2026.11.20`），`build`（`CURRENT_PROJECT_VERSION`）是遞增的整數（ADR-0036）；現在專案檔裡是固定的值，上傳的那張票改成建置時給。

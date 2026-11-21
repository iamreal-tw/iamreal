# android/：Android 的 app（Kotlin）

**這個目錄讓人檢查的事：憑證、公鑰、簽章、PIN 沒有離開手機；手機上做的檢查和算法是 `device-core/` 那一份；發出去的安裝檔裡有什麼。** app 引用 `device-core/`（ADR-0034），不引用 `protocol/`、`worker/`、`server/`。

現在有過卡能通的路：照網頁版的六步（開始之前、讀取卡片、輸入 PIN、你的帳號、確認、完成），卡片感應三次，PIN 輸入一次（[#133](https://github.com/iamreal-tw/iamreal/issues/133)、[#134](https://github.com/iamreal-tw/iamreal/issues/134)）。畫面用 Jetpack Compose，文字逐字來自 `design/copy/card-proof.json`。在模擬器上用假卡片對著本機的 Worker 過得完（「模擬器上過一次卡」）。

還沒有的：

- **讀卡**。用 NFC 讀真卡片的程式還沒有搬進這個程式庫（[#163](https://github.com/iamreal-tw/iamreal/issues/163)）。在那之前，發出去的安裝檔和用線裝的建置裡，「卡片」的位置是一個永遠讀不到卡的東西（`app/src/real/…/Target.kt` 的 `NoCardReader`）：按「感應卡片」會停在「沒有感應到卡片」，PIN 送不到任何地方
- **中斷和錯誤**（[#171](https://github.com/iamreal-tw/iamreal/issues/171)）：掉線重來、送 PIN 時掉線、換了卡、PIN 不正確、5 分鐘的各種回來的路、最低版本（`min_app`）和沒有 NFC 的畫面。現在遇到這些會停下來並寫出 `design/copy/` 已經有的那一句；app 的句子還沒寫的情況只寫「停在這裡」。`config` 的 `min_app` 現在還沒有讀
- 完成畫面「名冊記下了這一筆」列的是確認畫面算的那幾列；後台回報每個平台記成什麼、和確認時不同的標示還沒有（[#221](https://github.com/iamreal-tw/iamreal/issues/221)）
- 完成畫面最上面的記號動畫；顏色、字級、間距（`design/tokens.json` 還沒有定，現在是墨色和紙色兩個顏色）

## 兩種 build

同一個 app 有兩種 build（ADR-0037），識別碼不同，可以同時裝在一支手機上：

| | 商店的 build | 開發用 build |
|---|---|---|
| build type | `release` | `debug` |
| 識別碼 | `tw.iamreal.app` | `tw.iamreal.app.dev`（`applicationIdSuffix = ".dev"`） |
| 圖示下面的名稱（`design/copy/app.md`） | 島民證明 測試（`src/main/res/`） | 島民證明 dev（`src/debug/res/`） |
| 連哪裡 | 上線前：`https://test.iamreal.tw`、`https://test-data.iamreal.tw` | 同左，上線後也是 |
| 簽的場合字串 | 上線前：`iamreal-test:public:0` | 同左，上線後也是 |
| 怎麼裝 | Google Play 的內部測試（營運者手動觸發 [`upload-android.yml`](../.github/workflows/upload-android.yml) 上傳，ADR-0036、ADR-0037；「上傳到 Google Play」） | 用線裝（「怎麼用線裝到手機」） |
| 版本 | 上傳時給：台灣的日期，同一天第二次起加 `.1`、`.2`；`versionCode` 是工作流程執行的編號 | `1`、`dev` |

環境寫死在 `app/src/main/kotlin/tw/iamreal/app/Environment.kt` 一個地方，兩種 build 共用；app 裡沒有切換的設定，後台也不能叫它換。Kotlin 呼叫核心時傳的名冊永遠是這一個（`core/DeviceCore.kt`），所以 app 的程式拿不到正式名冊的場合字串。上線那天用一個 PR 讓商店的 build 改連正式網站；正式網站的設定現在還沒有。

第三種 build type `fake` 只給模擬器的測試（「模擬器上過一次卡」）：它是開發用 build 換上假卡片和本機的後台，識別碼 `tw.iamreal.app.dev.fake`、名稱和開發用 build 相同，不會上傳到任何地方。

## 上傳到 Google Play

商店的 build 只從 GitHub Actions 上傳（ADR-0036）：營運者在 `main` 上手動觸發 [`.github/workflows/upload-android.yml`](../.github/workflows/upload-android.yml)，它建置 `bundleRelease`（連 `build.gradle.kts` 的 bundle 檢查，「建置時的檢查」），用上傳金鑰簽章，傳到內部測試。簽章、上傳、版本號怎麼算，見 [`.github/README.md`「上傳 Android 的 app」](../.github/README.md#上傳-android-的-app175)。

版本由兩個 Gradle 屬性給：`-Piamreal.versionName=2026.11.21.1 -Piamreal.versionCode=42`（`app/build.gradle.kts`）。沒給的時候是 `1`、`dev`，所以這台電腦上的建置和拉取請求的檢查都是這兩個值。

## PIN、憑證、簽章在哪裡

要檢查它們有沒有離開手機，看這幾個檔：

| 東西 | 在哪裡 | 什麼時候清掉 |
|---|---|---|
| PIN | 輸入時在 `ui/Model.kt` 的 `PinField`（一個字元陣列，不是字串；輸入欄位裡只有圓點）。第二次感應成功後，`flow/CardProof.kt` 留一份位元組，等第三次感應 | 第三次感應送出後、取消、停下來、卡片回 PIN 不正確、第二次感應後滿 5 分鐘；都是蓋成零。5 分鐘的計時在 app 的行程裡：行程在背景被系統凍結時不會跑，回到 app 的那一刻補查 |
| 憑證 | 第一次感應讀到的幾張交給核心；選中的那一張 `CardProof` 留一份，第二、第三次感應拿來比對是不是同一張卡，**比對相同才把 PIN 交給卡片** | 算完證明、取消、停下來 |
| 卡片上的姓名 | 核心回給畫面，只顯示在輸入 PIN 的畫面 | 離開過卡時 |
| 兩個簽章 | `CardProof`，到算完證明為止 | 算完證明、取消、停下來 |

- **不寫磁碟。** 做到一半的過卡只在行程的記憶體裡（`MainActivity` 的 `model`）：不放進系統的狀態保存（`onSaveInstanceState` 交出去的是空的），不寫檔案。app 被系統結束就從第 1 步來
- **唯一存下來的**是每把發證金鑰用過的最高清冊編號（`MainActivity.kt` 的 `StoredCrlNumbers`，app 自己的偏好設定檔）。清冊編號是公開的數字
- **連網路的只有 `backend/Backend.kt`**：後台的四個介面和清冊鏡像的兩種檔案，位置是建置時寫死的。請求不帶 cookie、不帶手機或 app 的任何識別、不回報 app 自己檢查的結果（ADR-0016）。送出去的內容由核心組；核心在檢查都通過之前不算匿名編號（`device-core/README.md`「檢查都通過了」），所以這裡的程式順序寫錯時，帶著匿名編號的請求送不出去
- **碰卡片的只有 `card/Card.kt` 這一層介面**：一次感應是一次 `tap`，裡面先 `readCertificates`（不用 PIN），再 `sign`（帶 PIN）
- 看島民證明、說明、Threads 都是開瀏覽器，app 裡不載入任何網頁

## 目錄

| 路徑 | 內容 |
|---|---|
| `app/src/main/kotlin/tw/iamreal/app/core/` | `DeviceCore`：Kotlin 呼叫核心的唯一入口，每個函式對應 `device-core/include/iamreal_device_core.h` 的一個 C 函式。失敗時丟 `DeviceCoreException`，裡面只有代碼 |
| `app/src/main/kotlin/tw/iamreal/app/flow/` | `CardProof`：一次過卡，沒有畫面，順序照 `web/src/flow.ts`；每一項檢查和計算都交給核心。`Platforms`：app 自己認得的平台（只有 Threads） |
| `app/src/main/kotlin/tw/iamreal/app/card/` | 「卡片」這一層介面 |
| `app/src/main/kotlin/tw/iamreal/app/backend/` | 送給後台和清冊鏡像的請求 |
| `app/src/main/kotlin/tw/iamreal/app/ui/` | 六步的畫面（Compose）、感應的面板、哪個情況顯示 `design/copy/` 的哪一句 |
| `app/src/real/` | 發出去的安裝檔和用線裝的建置接到什麼（`Target.kt`）：測試網站、核心自己的 session |
| `app/src/fake/` | 只給模擬器測試的建置（build type `fake`）：假卡片、本機的後台、認測試金鑰的 session |
| `app/src/testing/` | `TestingCore`：測試用的函式庫才有的那一個函式。只編進 `fake` 和單元測試 |
| `test/` | 模擬器上過卡的測試（Node），見「模擬器上過一次卡」 |
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

畫面的文字 `design/copy/card-proof.json` 建置時原樣複製進安裝檔的資源（`res/raw/card_proof_copy.json`，`copySentences`），app 的程式裡沒有給人看的句子。

## 建置時的檢查

`./gradlew build` 會跑；只做安裝檔時也會跑，不管做的是 APK（`assemble*`、`package*`）還是上傳到 Google Play 用的 bundle（`bundle*`，由 `checkBundle` 看 `.aab` 裡的 manifest、函式庫、內建的檔案和 dex，項目相同）。任何一項不過就失敗（`app/build.gradle.kts`）：

- **合併後的 manifest**（`checkManifest`）：識別碼不是這個 build type 該有的就失敗（`release` 是 `tw.iamreal.app`、`debug` 是 `tw.iamreal.app.dev`、`fake` 是 `tw.iamreal.app.dev.fake`，逐字寫在 `app/build.gradle.kts` 的 `ids`）；任何地方出現 `AD_ID` 就失敗；要的權限只能是 `app/build.gradle.kts` 裡 `allowedPermissions` 列的：網路（`INTERNET`），加上 `androidx.core` 替 app 自己宣告、只有這個 app 拿得到的那一個（`<識別碼>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`）；別的 app 叫得到的元件只能是 app 的那一個畫面。`AndroidManifest.xml` 另外寫了移除 `AD_ID`，之後有程式庫帶進來也會被拿掉；畫面的程式庫帶進來、app 一打開就會自己做的兩件事也在那裡拿掉：找 emoji 字型（手機上有 Google Play services 時會去問它）、安裝啟動用的 profile 和讓開發工具觸發它的接收器
- **安裝檔**（`checkApk`）：原生的函式庫只有我們的那一個，release 只有 `arm64-v8a`；`assets/` 裡的檔案和兩份清單完全相同，不多不少；`.so` 沒有連結 `liblog`。Compose 帶進來的 `androidx.graphics:graphics-path` 有自己的一個原生函式庫（Android 13 以前走訪路徑的線段用的），打包時排除掉；畫面沒有畫路徑，模擬器的測試走過每一個畫面。程式庫帶的啟動用 profile 也不放進去
- **沒有假卡片、不認測試的發證金鑰**（`checkApk`）：debug 和 release 的 dex 裡出現 `tw/iamreal/app/fake/` 或 `TestingCore`，或 `.so` 裡有測試用函式庫的記號（`device-core/prover/src/lib.rs` 的 `IDC_TESTING_MARK`），就失敗。這兩樣只在 build type `fake` 裡
- **上線前只連測試網站**（`checkApk`）：`debug` 和 `release` 的 dex 裡沒有測試網站的網址（`https://test.iamreal.tw`）就失敗；任何一種 build 的 dex 裡出現正式網站的網址（`//iamreal.tw`、`//data.iamreal.tw`）或正式名冊的場合字串（`iamreal:public:`）就失敗。場合字串本身不在 Kotlin 裡，由核心照名冊的數字給；單元測試核對核心給這個 app 的是 `spec/vectors/scope.json` 裡測試名冊的那一條。`.so` 裡兩份名冊的場合字串都有（核心是同一份），Kotlin 只傳得出測試名冊的數字
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

`./gradlew test`。測試在這台機器的 JVM 上跑，不需要模擬器：`build-native.sh host` 把同一份 Rust 和同一份 JNI 的程式編成這台機器的函式庫，Kotlin 的 `DeviceCore` 載入它。測試讀 `spec/vectors/` 的標準答案，不複製。`AppNameTest` 讀 `design/copy/app.md`，核對兩種 build 圖示下面的名稱各自和它寫的相同。

這台機器的函式庫是測試用的那一種（`build-native.sh` 的 `test-issuers`：`device-core/` 開 cargo feature `test-issuers`，多一個收測試發證金鑰開 session 的函式 `idc_testing_session_open`，其餘和 app 連結的相同）：標準答案裡的憑證是測試金鑰簽的，不是內政部簽的。`SessionTest` 用它拿 `circuit-inputs.json` 的一張卡片從 Kotlin 走完一次過卡在核心裡的每一步：檢查憑證、選清冊和檢查清冊、建樹、核對內建的檔案、查現況的請求和短編號、算證明和送出的請求，並跑 `list-consequence.json`、`card-status.json` 的每一案。

測到的：Kotlin 到 JNI 到核心這條路的每一個函式、代碼變成例外、傳進去的位元組呼叫後沒有被改、app 自己開的 session 不認測試金鑰。測不到的：Android 上的 `.so`（Zig 連結的那一個）和畫面。那兩樣由下面模擬器的測試看。

### 模擬器上過一次卡

`test/card-proof.ts`：在模擬器上照持卡人的方式（點按、打字）走完六步，四次：新宣告、再次過卡，隔天更換、收回。形狀照 `web/test/worker-card-proof.ts`，把瀏覽器換成模擬器。

- **後台和卡片的金鑰是 `web/test/app-backend.ts` 的**（Android 和 iOS 的測試共用）：它起本機的 Worker（`worker/test/harness.ts` 的測試建置：測試的發證金鑰、假的內政部、可調的時鐘），用 `web/test/fixtures` 當場產生卡片的金鑰和憑證，寫成 `web/test-output/app/backend.json`，再把這裡的測試當成它的指令跑起來。這裡的測試只讀那個檔、講 HTTP，不引用 `web/`、`worker/` 的程式
- **卡片是假的**：`app/src/fake/…/FakeCard.kt`，用那把測試金鑰簽章。每一次感應向測試問「現在貼上來的是哪一張卡」，所以測試決定什麼時候貼卡、貼哪一張
- **app 是 build type `fake`**：`src/fake/` 換掉 `src/real/`（假卡片、連 `127.0.0.1:18169`、認測試金鑰的 session），原生函式庫是測試用的那一種。其他的程式和發出去的 app 是同一份
- 測試關掉模擬器的網路，只把模擬器的 18169 埠轉到本機的伺服器（`adb reverse`）：app 連得到的只有它。「打開 Threads」開的瀏覽器因此不會真的連出去
- 畫面用 `uiautomator dump` 讀，預期的每一句從 `design/copy/card-proof.json` 讀，逐字比對
- 第二、第三次感應各貼一次「該放簽章憑證的位置是另一張憑證」的卡：畫面說不是同一張卡，假卡片沒有被交到 PIN
- 隔天的兩次：把後台的時鐘和模擬器的時鐘都調到明天（測試結束時把模擬器的調回來）
- 這裡的測試全過之後，`app-backend.ts` 讓 Worker 在下一個午夜公布名冊，抄下資料桶，用 Go 的 `iamreal-verify`（帶 `iamrealtest` 標籤建置，才收測試的發證金鑰）和原生的 `bb` 重驗：四筆紀錄都有效，每一筆的種類是新宣告、再次過卡、更換、收回
- 截圖留在 `test-output/screens/`

```
(cd ../worker && pnpm install)                                                  # app-backend.ts 要它們的套件
$ANDROID_HOME/emulator/emulator -avd iamreal-api29 -skin 1080x2280 -no-window &  # 見下面「模擬器」
cd ../web && pnpm install
IAMREAL_BB=<bb 6.0.0 的路徑> node --experimental-strip-types test/app-backend.ts \
  first,refresh,switch,withdraw -- node --experimental-strip-types ../android/test/card-proof.ts
```

需要 Node 22、go、`bb` 6.0.0（`verifier/README.md`）、一個開著的模擬器。**測試只對模擬器下指令**：每一道 `adb` 都帶模擬器的序號（`test/emulator.ts`，不是 `emulator-<數字>` 的序號不收），接著線的手機不會被碰到。同時開著幾個模擬器時用 `IAMREAL_EMULATOR=emulator-5554` 指定。拉取請求的檢查不跑這一個（那裡沒有模擬器）。

它不測的：會讓過卡停下來的每一種情況（[#171](https://github.com/iamreal-tw/iamreal/issues/171)），和真卡片的指令（營運者用真卡片照清單測）。

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

打開是過卡的第 1 步。讀卡的程式還沒有進來（上面「還沒有的」），按「感應卡片」會停在「沒有感應到卡片」。

同時接著手機、開著模擬器時，`adb` 要用 `-s <序號>` 指定裝到哪一個。

### 模擬器

```
sdkmanager "emulator" "system-images;android-29;default;arm64-v8a"    # x86-64 的電腦用 x86_64
avdmanager create avd -n iamreal-api29 -k "system-images;android-29;default;arm64-v8a"
$ANDROID_HOME/emulator/emulator -avd iamreal-api29 -skin 1080x2280
```

`-skin 1080x2280` 不能省。`avdmanager` 建的 AVD 預設螢幕是 320x640、密度 160；`test/card-proof.ts` 把密度設成手機常見的 420 之後，第 2 步的畫面只放得下標題和一段說明，「感應卡片」在畫面外，捲也捲不到，測試就停在那裡。`adb shell wm size` 只能放大到實體螢幕的兩倍，補不回來，所以要在啟動時給螢幕的大小。

之後和手機相同，`adb -s emulator-5554 install …`。要在模擬器上看 release 的建置，先用一把隨便產生的金鑰簽它（`apksigner sign`），沒有簽章的安裝檔裝不上去。

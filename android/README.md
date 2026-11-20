# android/：Android 的 app（Kotlin）

**這個目錄讓人檢查的事：憑證、公鑰、簽章、PIN 沒有離開手機；手機上做的檢查和算法是 `device-core/` 那一份；發出去的安裝檔裡有什麼。** app 引用 `device-core/`（ADR-0034），不引用 `protocol/`、`worker/`、`server/`。

現在是殼：建置的路通了，畫面只有兩行，顯示核心被呼叫到（`idc_self_check` 的代碼和核心給這個 app 的場合字串）。它不是過卡的畫面，沒有給持卡人看的句子；讀卡、連後台、過卡的畫面在後面的票。現在的 app 不要任何權限，不連網路，不收 PIN。

## 這是哪一個 app

測試 app（ADR-0036）：

| | |
|---|---|
| 識別碼 | `tw.iamreal.app.test` |
| 圖示下面的名稱 | 島民證明 測試（`design/copy/app.md`） |
| 連哪裡 | `https://test.iamreal.tw`、`https://test-data.iamreal.tw` |
| 簽的場合字串 | `iamreal-test:public:0` |

環境寫死在 `app/src/main/kotlin/tw/iamreal/app/Environment.kt` 一個地方，app 裡沒有切換的設定，後台也不能叫它換。Kotlin 呼叫核心時傳的名冊永遠是這一個（`core/DeviceCore.kt`），所以 app 的程式拿不到正式名冊的場合字串。正式 app 還沒有。

## 目錄

| 路徑 | 內容 |
|---|---|
| `app/src/main/kotlin/tw/iamreal/app/core/` | `DeviceCore`：Kotlin 呼叫核心的唯一入口，每個函式對應 `device-core/include/iamreal_device_core.h` 的一個 C 函式。失敗時丟 `DeviceCoreException`，裡面只有代碼 |
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
- `.so` 只開放 Java 執行環境要找的函式（`jni/exports.map`）：`JNI_OnLoad` 和 `DeviceCore` 的幾個。Barretenberg 自己的 C 函式和 `idc_` 的函式都在裡面，但從 `.so` 外面呼叫不到
- 不連結 `liblog`
- 連結時加 `-z defs`：有函式沒人定義，連結就停，不會等到手機上載入才失敗
- 分頁對齊 16 KB（`max-page-size=16384`）
- JNI 那一層載入時比對 `idc_abi_version()` 和標頭檔的 `IDC_ABI_VERSION`，不同就不載入

發出去的安裝檔（release）只有 `arm64-v8a`。開發用的建置（debug）多帶 `x86_64`，給 x86-64 電腦上的模擬器；Apple 晶片的 Mac 上，模擬器用的也是 `arm64-v8a`。

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

`bundled.sha256` 和 `device-core/crs.sha256` 列出每一個的 SHA-256，數字和 `web/circuits/README.md`、`web/src/prover/artifacts.ts` 相同。建置時每個檔案先核對再複製（`bundleFiles`），做出安裝檔後再核對一次裡面的檔案（`checkApk`）。app 用它們之前，核心還會照寫死在 `device-core/` 的 SHA-256 再核對一次（ADR-0035）；那是算證明的票，現在的殼還不讀這些檔案。

## 建置時的檢查

`./gradlew build` 會跑；只做安裝檔時也會跑，不管做的是 APK（`assemble*`、`package*`）還是上傳到 Google Play 用的 bundle（`bundle*`，由 `checkBundle` 看 `.aab` 裡的 manifest、函式庫、內建的檔案和 dex，項目相同）。任何一項不過就失敗（`app/build.gradle.kts`）：

- **合併後的 manifest**（`checkManifest`）：識別碼不是 `tw.iamreal.app.test` 就失敗；任何地方出現 `AD_ID` 就失敗；要的權限只能是 `app/build.gradle.kts` 裡 `allowedPermissions` 列的（現在是空的）。`AndroidManifest.xml` 另外寫了移除 `AD_ID`，之後有程式庫帶進來也會被拿掉
- **安裝檔**（`checkApk`）：原生的函式庫只有我們的那一個，release 只有 `arm64-v8a`；`assets/` 裡的檔案和兩份清單完全相同，不多不少；`.so` 沒有連結 `liblog`
- **測試 app 不提正式的環境**（`checkApk`）：dex 裡出現正式網站的網址（`//iamreal.tw`、`//data.iamreal.tw`）或正式名冊的場合字串（`iamreal:public:`）就失敗。場合字串本身不在 Kotlin 裡，由核心照名冊的數字給；單元測試核對核心給這個 app 的是 `spec/vectors/scope.json` 裡測試名冊的那一條。`.so` 裡兩份名冊的場合字串都有（核心是同一份），Kotlin 只傳得出測試名冊的數字
- **release build 不輸出 log**：R8 拿掉對 `android.util.Log` 的呼叫（`app/proguard-rules.pro`）；之後 `checkApk` 看 release 的 dex，還提到 `android.util.Log`、`java.io.PrintStream`（`System.out`、`System.err`、`println`）、`java.util.logging.Logger`、`printStackTrace` 就失敗
- **沒有第三方 SDK**（`checkLibraries`）：app 帶的程式庫只能是 `app/build.gradle.kts` 裡 `allowedLibraries` 列的，現在是 Kotlin 的標準函式庫和它引用的標註；以檔案加進來的 jar、aar 也算，同樣不過。沒有 AndroidX、沒有 Google Play services。畫面用 Android 內建的元件

這些檢查看的是寫錯和不小心加進來的東西。它們看不到的：Android 系統自己寫的 log（app 當掉時系統會記下例外的堆疊；核心的例外只有代碼）、C 函式庫的 `syslog`（Barretenberg 連結到它，在 libc 裡，拿不掉）、`.so` 裡的程式用系統呼叫直接做的事。`.so` 向 libc 要的函式裡有 `syslog`、`fprintf`、`socket`、`connect`（Barretenberg 和 libc++ 帶進來的），app 沒有網路的權限時 `socket` 連不出去。

安裝檔裡另外有 AGP 自己放的兩個小檔：`META-INF/com/android/build/gradle/app-metadata.properties`（AGP 的版本）和 `META-INF/version-control-info.textproto`（建置時的 git 提交）。

## 工具和套件

版本都釘死，選發布滿 7 天的（`CONTRIBUTING.md`「套件」）。

| 東西 | 版本 | 發布 | 釘在哪裡 |
|---|---|---|---|
| Gradle | 9.9.1 | 2026-11-10 | `gradle/wrapper/gradle-wrapper.properties`，連發行檔的 SHA-256；`gradle-wrapper.jar` 的 SHA-256 由 `worker/test/workflows.test.ts` 核對 |
| Android Gradle Plugin | 9.5.1 | 2026-11-05 | `build.gradle.kts` |
| Kotlin（Gradle 外掛和標準函式庫） | 2.4.21 | 2026-10-08 | `build.gradle.kts` |
| JUnit（只在測試） | 4.13.2 | 2021-02-13 | `app/build.gradle.kts` |
| `org.json:json`（只在測試：在 JVM 上讀 `spec/vectors/`；Android 內建同一套 JSON） | 20260814 | 2026-08-14 | `app/build.gradle.kts` |
| Zig | 0.15.1 | 2025-08-19 | `fetch-zig.sh`、`zig.sha256` |
| Android NDK | 29.0.14206865 | | `app/build.gradle.kts` |
| Android SDK：`build-tools;36.0.0`、`platforms;android-36` | | | `app/build.gradle.kts` |
| Rust、Barretenberg | 見 `device-core/README.md` | | |

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
2. 做出兩個安裝檔：`app/build/outputs/apk/debug/app-debug.apk`、`app/build/outputs/apk/release/app-release-unsigned.apk`（沒有簽章；簽章和上傳在 GitHub Actions，ADR-0036）
3. 跑單元測試、lint、上面的檢查

拉取請求的檢查（`.github/workflows/checks.yml` 的 `android`）在 Linux 上跑的就是這幾行。

### 測試

`./gradlew test`。測試在這台機器的 JVM 上跑，不需要模擬器：`build-native.sh host` 把同一份 Rust 和同一份 JNI 的程式編成這台機器的函式庫，Kotlin 的 `DeviceCore` 載入它。測試讀 `spec/vectors/` 的標準答案（`scope.json`、`declaration-code.json`），不複製。`AppNameTest` 讀 `design/copy/app.md`，核對圖示下面的名稱和它寫的相同。

測到的：Kotlin 到 JNI 到核心這條路、代碼變成例外、傳進去的位元組呼叫後沒有被改。測不到的：Android 上的 `.so`（Zig 連結的那一個）。那一個要在模擬器或手機上打開 app 看。

## 怎麼用線裝到手機

裝的是開發用的建置（debug），簽的是這台電腦上 Android 開發用的金鑰，不是商店的那一把；它和從 Google Play 裝的測試 app 識別碼相同、簽章不同，手機上只能留一個，要先移除另一個。

1. 手機：設定裡打開「開發人員選項」和「USB 偵錯」，接上線，在手機上允許這台電腦
2. `$ANDROID_HOME/platform-tools/adb devices` 看得到手機
3. 安裝並打開：

   ```
   ./gradlew assembleDebug
   $ANDROID_HOME/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk
   $ANDROID_HOME/platform-tools/adb shell am start -n tw.iamreal.app.test/tw.iamreal.app.MainActivity
   ```

畫面上是兩行：`idc_self_check 0` 和 `idc_scope_string 0 iamreal-test:public:0__________`（函式的名稱、它回的代碼、它給的值）。

同時接著手機、開著模擬器時，`adb` 要用 `-s <序號>` 指定裝到哪一個。

### 模擬器

```
sdkmanager "emulator" "system-images;android-29;default;arm64-v8a"    # x86-64 的電腦用 x86_64
avdmanager create avd -n iamreal-api29 -k "system-images;android-29;default;arm64-v8a"
$ANDROID_HOME/emulator/emulator -avd iamreal-api29
```

之後和手機相同，`adb -s emulator-5554 install …`。要在模擬器上看 release 的建置，先用一把隨便產生的金鑰簽它（`apksigner sign`），沒有簽章的安裝檔裝不上去。

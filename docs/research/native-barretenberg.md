# 原生的 app 怎麼呼叫 Barretenberg

對應 issue #86。查證日期：2026-11-19。

## 怎麼讀這份筆記

- 只查文件和原始碼，沒有安裝、編譯或執行任何東西，也沒有在手機上量。在手機上量是另一張票。
- 來源以程式庫本身為主：`AztecProtocol/aztec-packages`、`noir-lang/noir`、`zkmopro/mopro`，以及各個 Swift、Kotlin 包裝自己的程式庫。每個來源寫明標籤或 commit，列在文末的「來源」。
- 每一項標三種記號之一：
  - 【一手】來源的原始碼或文件明寫。
  - 【推論】來源沒有直接寫，是從原文推出來的；推論的依據寫在同一項。
  - 【查不到】在列出的來源裡找不到說法。
- 這個領域變得很快：Barretenberg 6.1.0 就是在查證當天發布的 [B1]。用之前重新查一次。
- 這份筆記只列查到的事實，不比較哪一種做法比較好。
- 發布檔的大小是把檔案下載下來列出內容得到的（沒有解開、沒有執行），SHA-256 是對下載到的檔案算的。

## 0. 這個程式庫現在釘的版本

| 項目 | 版本 | 寫在哪裡 |
|---|---|---|
| 電路的編譯 | `nargo` 1.0.0（`noirc` 1.0.0+275d3ab1a5c916c6ea73e8d6b943f685f574500c） | `web/circuits/README.md` |
| 網頁版的證明 | `@aztec-foundation/bb.js` 6.0.0 | `web/package.json` |
| 網頁版的見證 | `@noir-lang/noir_js` 1.0.0 | `web/package.json` |
| 原生的驗證 | `bb` 6.0.0 | `verifier/README.md`、`spec/proof-verification.md` |
| 證明的設定 | `noir-recursive`：Poseidon2 的 transcript、零知識；證明 14,656 個位元組 | `spec/proof-verification.md`、`web/src/prover/prover.ts` |
| 通用參數 | 壓縮格式的前 2^18 個 G1 點（8,388,608 個位元組）加 128 個位元組的 G2 點，SHA-256 寫死；用 `srsInitSrs` 交給 bb.js，不用 bb.js 自己的下載 | `web/src/prover/artifacts.ts`、`web/src/prover/engine.ts` |
| 建樹用的 Poseidon2 | bb.js 的 `poseidon2Hash` | `web/src/crl/hasher.ts` |
| 電路大小 | 232,239（上限 262,144） | ADR-0013 |

上游對應的發布：

- `AztecProtocol/aztec-packages` 的標籤 `v6.0.0` 指向 commit `0219f11d8133970df3974fe5ae65e006bf8c193a`，2026-10-22 發布。【一手】[B1]
- `v6.1.0` 在 2026-11-19 發布（commit `6595672787600ce14bb6dd0dd612b2ae6219b061`）。【一手】[B1]
- `noir-lang/noir` 的標籤 `v1.0.0` 指向 commit `275d3ab1a5c916c6ea73e8d6b943f685f574500c`，2026-10-29 發布，和 `web/circuits/README.md` 記的 `noirc` 版本相同。【一手】[N1]
- Barretenberg 自己的「Noir 版本對應哪一版 bb」的表（`barretenberg/bbup/bb-versions.json`），在 `v6.0.0` 和 `v6.1.0` 兩個標籤上最新的一列都是 `1.0.0-beta.22`，沒有 Noir 1.0.0 的列。【一手】[B2]。所以「Noir 1.0.0 配 bb 6.0.0」在這張表裡【查不到】；把這兩個版本配在一起的公開來源是 `zkpassport/noir_rs` 的 `v1.0.0-1`（見 1.3）。

## 1. 現成的手機包裝

### 1.1 Aztec 官方：`barretenberg-rs` 和預先編好的靜態函式庫

| 項目 | 內容 | 記號 |
|---|---|---|
| 是什麼 | `barretenberg/rust/barretenberg-rs`：Rust 的 crate，「Rust bindings for the Barretenberg cryptographic library using msgpack protocol」。有兩種後端：`PipeBackend`（啟動 `bb` 行程，用 stdin/stdout）和 `FfiBackend`（直接連結靜態函式庫；README 的標題寫「for mobile/embedded」）。 | 【一手】[B3] |
| 發布 | crates.io 上有 `barretenberg-rs` 6.0.0（2026-10-22 建立，沒有被撤回，檔案的 SHA-256 `1b2f6b4a…4fff72`）和 6.1.0（2026-11-19），另有每天的 nightly 版。 | 【一手】[B4] |
| 手機的靜態函式庫 | `v6.0.0` 的發布檔裡有 `barretenberg-static-arm64-ios.tar.gz`、`barretenberg-static-arm64-ios-sim.tar.gz`、`barretenberg-static-arm64-android.tar.gz`、`barretenberg-static-x86_64-android.tar.gz`，每個裡面只有一個 `libbb-external.a`。 | 【一手】[B1] |
| 怎麼編的 | `barretenberg/cpp/CMakePresets.json` 有 `arm64-ios`、`arm64-ios-sim`、`arm64-android`、`x86_64-android` 四個 preset，用 Zig 交叉編譯，只產生靜態函式庫，開了 `BB_LITE`。iOS 的兩個 preset 寫 `-mios-version-min=16.3`。 | 【一手】[B5] |
| `build.rs` 怎麼拿函式庫 | 有設 `BB_LIB_DIR` 就用那個目錄裡的 `libbb-external.a`；沒有設就用 `curl` 從 `https://github.com/AztecProtocol/barretenberg/releases/download/v{版本}/barretenberg-static-{平台}.tar.gz` 下載，再用 `tar` 解開。下載後沒有核對雜湊的程式。支援的目標寫了 `aarch64-apple-ios`、`aarch64-apple-ios-sim`、`aarch64-linux-android`、`x86_64-linux-android` 和桌機的四種。 | 【一手】[B6] |
| 兩個發布頁的檔案是否相同 | `AztecProtocol/barretenberg` 和 `AztecProtocol/aztec-packages` 兩邊 `v6.0.0` 的 `barretenberg-static-arm64-ios.tar.gz`，下載後大小和 SHA-256 相同（17,901,605 個位元組，`c7350fb2…7f671d`）。其他平台的檔案沒有比。 | 【一手】（2026-11-19 下載比對）[B1][B7] |
| 文件裡的平台清單 | crate 自己的 README「Supported Targets」只列 Linux、macOS、iOS，沒有列 Android；同一版的 `build.rs` 和發布檔有 Android。 | 【一手】[B3][B6] |
| 官方的 Swift 或 Kotlin 套件 | `barretenberg/` 底下的子目錄是 `cpp`、`rust`、`ts`、`sol`、`docs` 等，沒有 Swift 或 Kotlin 的目錄；`v6.0.0` 的文件 `how_to_guides/` 只有瀏覽器、Solidity 驗證器、遞迴三篇。 | 【查不到】官方的 Swift、Kotlin 套件和手機的教學 [B8] |
| 能不能釘在 6.0.0 | 可以寫 `barretenberg-rs = "=6.0.0"`；對應的四個手機靜態函式庫在 `v6.0.0` 的發布檔裡。 | 【一手】[B1][B4] |

### 1.2 Noir 官方

| 項目 | 內容 | 記號 |
|---|---|---|
| 官方的手機包裝 | `noir-lang` 組織底下沒有手機包裝的程式庫。和原生連結有關的 `noir-lang/barretenberg-sys` 已封存，最後推送是 2024-03-15。 | 【一手】（組織的程式庫清單，2026-11-19）[N2] |
| 官方文件 | Noir 1.0.0 的文件 `guides/` 只有 `building_a_web_app.md` 等四篇，沒有手機的教學。`building_a_web_app.md` 有一句「you have a working ZK app that runs in the browser (and on mobile too)」，上下文是網頁。 | 【一手】[N3] |
| 官方列的第三方工具 | `noir-lang/awesome-noir` 的「Mobile development」列四項：MoPro、Noir.rs（`zkpassport/noir_rs`）、Swoir、Noir Android。這份清單最後一次提交是 2026-07-06。 | 【一手】[N4] |

### 1.3 `zkpassport/noir_rs`（Rust）

| 項目 | 內容 | 記號 |
|---|---|---|
| 是什麼 | 「Rust crate to generate and verify proofs for Noir circuits」，用 `barretenberg-rs` 接 Barretenberg。README 建議手機上改用 Swoir 或 Noir Android。 | 【一手】[Z1] |
| 維護狀況 | 沒有封存；最後提交 2026-11-03（`239f1215…`，「Update to Noir 1.0.0 (#9)」）；沒有 GitHub release，用標籤發布，最新的標籤是 `v1.0.0-1`，指向同一個 commit。授權 Apache-2.0。README 寫的安裝方式是用 git 標籤引用。 | 【一手】[Z1] |
| 用的版本 | 標籤 `v1.0.0-1` 的 `Cargo.toml`：`acvm`、`acvm_blackbox_solver`、`bn254_blackbox_solver`、`nargo` 都取自 `noir-lang/noir` 的 `rev = "v1.0.0"`；`barretenberg-rs = { version = "=6.0.0", default-features = false, features = ["ffi"] }`。 | 【一手】[Z2] |
| 和這個程式庫的版本 | Noir 1.0.0、Barretenberg 6.0.0，和第 0 節的兩個版本相同。 | 【一手】[Z2] |
| 之前的版本 | 前一個標籤 `v1.0.0-beta.22-1` 是 2026-07-13 的提交（「update to noir beta 22 and bb 5.0.0」）。 | 【一手】[Z1] |
| 公開的函式 | `execute`（算見證）、`prove_ultra_honk`、`prove_ultra_honk_keccak`、`verify_ultra_honk`、取驗證金鑰、`setup_srs`、`setup_srs_from_bytecode`。沒有 Poseidon2 的函式。 | 【一手】[Z3] |
| 證明的設定 | `prove_ultra_honk` 用 `oracle_hash_type: "poseidon2"`、`disable_zk: false`、`ipa_accumulation: false`。bb.js 6.0.0 的 `noir-recursive` 對應同樣三個值。 | 【一手】[Z3][B9] |
| 回傳的格式 | `prove_ultra_honk` 回傳一串位元組：4 個位元組的公開輸入個數（big-endian）、公開輸入、證明。bb.js 的 `generateProof` 把 `proof` 和 `publicInputs` 分開回傳。 | 【一手】[Z3]；`web/src/prover/engine.ts` |
| 原生和網頁算出的證明能不能互換 | 兩邊送給 Barretenberg 的是同一個指令 `CircuitProve`、同樣的設定，版本相同。沒有找到公開的測試說兩邊的證明逐位元組的格式相同、能在同一把驗證金鑰下驗過。 | 【推論】指令和設定相同；實際互換【查不到】，要實測 |

### 1.4 Swoir 和 Swoirenberg（Swift）

| 項目 | 內容 | 記號 |
|---|---|---|
| 是什麼 | `Swoir/Swoir`：「a Swift package for creating and verifying Noir zero-knowledge proofs」。`Swoir/Swoirenberg` 是它的 Barretenberg 後端：Rust 的靜態函式庫加 swift-bridge 產生的 Swift 介面，包成 xcframework。 | 【一手】[S1][S2] |
| 維護狀況 | 兩個都沒有封存。Swoirenberg 最後提交 2026-11-04（`0be7e5e5…`），當天發布 `v1.0.0-2`。Swoir 最後提交 2026-11-04（`ec8442f4…`），有標籤 `v1.0.0-2`；GitHub release 最新的一筆是 `v1.0.0-beta.22-3`（2026-08-17），`v1.0.0-2` 只有標籤。它們共用的 `Swoir/SwoirCore` 最後提交是 2025-10-08。授權 Apache-2.0。 | 【一手】[S1][S2][S3] |
| 用的版本 | Swoirenberg 的 `Rust/Cargo.toml`：`noir_rs` 取 `zkpassport/noir_rs` 的 `tag = "v1.0.0-1"`，開 `barretenberg`。所以是 Noir 1.0.0、Barretenberg 6.0.0。 | 【一手】[S2] |
| 怎麼安裝 | Swift Package Manager。Swoir 的 `Package.swift` 用 `exact: "1.0.0-2"` 引用 Swoirenberg；Swoirenberg 的 `Package.swift` 用 `binaryTarget` 指向 release 的 `Swoirenberg.xcframework.zip`，寫了 `checksum: "543e1bba…df6418"`。下載到的檔案 SHA-256 和它相同。 | 【一手】[S1][S2] |
| 平台 | `Package.swift` 寫 `.iOS(.v15)`、`.macOS(.v13)`；README 寫 iOS `arm64`、macOS `arm64`。xcframework 裡有 `ios-arm64`、`ios-arm64-simulator`、`macos-arm64_x86_64` 三份。Aztec 的 iOS 靜態函式庫是用 `-mios-version-min=16.3` 編的（1.1）。 | 【一手】[S1][S2][B5] |
| 介面 | `Circuit(backend:manifest:size:lowMemoryMode:storageCap:)`、`setupSrs(srs_path:)`、`execute`、`prove(_:proof_type:vkey:)`、`verify`、`getVerificationKey`。`proof_type` 是 `"ultra_honk"` 或 `"ultra_honk_keccak"`。沒有 Poseidon2 的函式。 | 【一手】[S1][S2] |
| 電路檔的欄位 | Swoir 的 `CircuitManifest` 把 `hash` 宣告成必填的 `String`，`noir_version`、`debug_symbols`、`file_map`、`names` 是選填。這個程式庫的 `web/circuits/*.json` 只留 `noir_version`、`abi`、`bytecode` 三個欄位，沒有 `hash`。 | 【一手】[S1]；`web/circuits/README.md`。這裡的檔案直接交給 Swoir 會不會解析失敗：【推論】會（必填欄位不存在），沒有實測 |

### 1.5 Noir Android（Kotlin）

| 項目 | 內容 | 記號 |
|---|---|---|
| 是什麼 | `madztheo/noir_android`：「This library lets you generate and verify proofs with Noir on Android」。Kotlin 的 `Circuit` 類別加一個 Rust 的 JNI 函式庫（`noir_java`，`crate-type = ["cdylib"]`，用 `jni` 0.21.1）。 | 【一手】[A1] |
| 維護狀況 | 沒有封存；最後提交 2026-11-04（`de71e53b…`），同一天發布 `v1.0.0-1`。前一版 `v1.0.0-beta.22-2` 是 2026-07-15。授權 MIT。 | 【一手】[A1] |
| 用的版本 | `noir_java/Cargo.toml`：`noir_rs` 取 `zkpassport/noir_rs` 的 `tag = "v1.0.0-1"`。所以是 Noir 1.0.0、Barretenberg 6.0.0。 | 【一手】[A1] |
| 怎麼安裝 | README 寫經 JitPack：`implementation("com.github.madztheo:noir_android:1.0.0-1")`。release 另外附 `lib-release.aar` 和各 ABI 的 `.so`。 | 【一手】[A1] |
| 平台 | `minSdk = 24`、`compileSdk = 34`。AAR 裡只有 `arm64-v8a` 和 `x86_64` 兩種 ABI，沒有 32 位元的。 | 【一手】[A1] |
| libc++ | AAR 另外帶一個 `libc++.so`。`lib/build.gradle.kts` 的註解寫：預先編好的 Barretenberg 用的是標準 LLVM 的 libc++，不是 NDK 的 `__ndk1` 那一種，所以另外附上，避免和使用它的 app 裡 NDK 的 `libc++_shared.so` 衝突。 | 【一手】[A1] |
| 介面 | `Circuit.fromJsonManifest(jsonManifest, size, lowMemoryMode, storageCap)`、`setupSrs(srs_path)`、`execute`、`prove(initialWitness, vk, proofType)`、`verify`、`getVerificationKey`。沒有 Poseidon2 的函式。 | 【一手】[A1] |
| 電路檔的欄位 | Kotlin 的 `CircuitManifest` 宣告了 `hash`、`debug_symbols`、`file_map`、`names`，用 Gson 解析。這個程式庫的電路檔沒有這幾個欄位。 | 【一手】[A1]。直接交給它會怎樣：【查不到】，沒有實測 |

### 1.6 mopro 和 `zkmopro/noir-rs`

| 項目 | 內容 | 記號 |
|---|---|---|
| 是什麼 | `zkmopro/mopro`：用 UniFFI 替證明系統（Circom、Halo2、Noir）產生 Swift 和 Kotlin 的介面，附建置指令和 CLI；也支援 React Native、Flutter。 | 【一手】[M1] |
| 維護狀況 | 沒有封存；最後提交 2026-10-19（`4ffd3c89…`，文件）；最近的 release 是 `mopro-ffi-v0.3.7`、`mopro-cli-v0.3.7`（2026-07-14）。授權 Apache-2.0 和 MIT。 | 【一手】[M1] |
| Noir 用哪個函式庫 | 文件要使用者在自己的 `Cargo.toml` 引用 `zkmopro/noir-rs`（`package = "noir"`，`tag = "v1.0.0-beta.19"`）。文件寫：「Supports Noir `v1.0.0-beta.19` via the official `barretenberg-rs` crate (`=4.2.0-aztecnr-rc.2`)」。 | 【一手】[M2] |
| `zkmopro/noir-rs` 的狀況 | 沒有封存；最後提交 2026-06-09（`745dd155…`）；最新的 release 是 `v1.0.0-beta.19`（2026-04-21）。`noir/Cargo.toml`：Noir 的 crate 取 `rev = "v1.0.0-beta.19"`，`barretenberg-rs = "=4.2.0-aztecnr-rc.2"`。 | 【一手】[M3] |
| 能不能釘在 Noir 1.0.0、bb 6.0.0 | `zkmopro/noir-rs` 沒有對應 Noir 1.0.0 或 Barretenberg 6.0.0 的標籤。 | 【一手】[M3] |
| 把 mopro 接到 `zkpassport/noir_rs` 的 `v1.0.0-1` | mopro 的文件沒有寫這種用法。 | 【查不到】 |
| 介面 | `generateNoirProof(circuitPath, srsPath, inputs, onChain, vk, lowMemoryMode)`、`verifyNoirProof`、`getNoirVerificationKey`，Swift 和 Kotlin 各一份。`onChain = false` 用 Poseidon 的設定。沒有 Poseidon2 的函式。 | 【一手】[M2] |
| 平台 | Noir 支援 `aarch64-apple-ios`、`aarch64-apple-ios-sim`、`aarch64-linux-android`、`x86_64-linux-android`；32 位元的 Android 不支援。 | 【一手】[M2][M4] |

### 1.7 其他

- React Native 和 Flutter 的範本：`madztheo/noir-react-native-starter`（最後提交 2025-07-28）、`zkmopro/NoirReactNative`（2026-06-23）、`zkmopro/noir_flutter`（2026-06-23）。這張票問的是 Kotlin 和 Swift，沒有細讀。【一手】（只查了最後提交日期）[O1]
- 2026-11-19 在 GitHub 搜尋程式庫，「barretenberg swift」「barretenberg kotlin」「barretenberg uniffi」「ultrahonk mobile」都沒有結果。【查不到】1.1 到 1.6 以外的 Swift、Kotlin 包裝
- zkPassport 自己的 app（`zkpassport/mobile-app`，最後提交 2026-07-17）的 `android/app/build.gradle` 引用 `com.github.madztheo:noir_android:v1.0.0-beta.22-2`，iOS 的 `Podfile` 提到 Swoirenberg。【一手】[O2]
- PSE 的手機範例（`privacy-ethereum/openac-taiwan-citizen-digital-certificate-ios-example`、`…-android-example`）用的證明系統是 Spartan2（ADR-0012），不是 Barretenberg，這份筆記沒有細讀。

## 2. 包裝的形狀，和 app 會多大

### 2.1 一層一層是什麼

```
Swift（Swoir）            Kotlin（Noir Android）        Swift / Kotlin（mopro）
   │ swift-bridge            │ JNI                         │ UniFFI
   ▼                         ▼                             ▼
Swoirenberg（Rust，靜態）  noir_java（Rust，動態）       使用者自己的 Rust crate
   └────────────┬────────────┘                             │
                ▼                                          ▼
        zkpassport/noir_rs                         zkmopro/noir-rs
                │  見證：Noir 的 Rust crate（acvm、nargo）
                │  證明：barretenberg-rs 的 FfiBackend
                ▼
        libbb-external.a（C++，Aztec 預先編好）
        對外一個 C 函式：bbapi(輸入, 長度, &輸出, &長度)
```

- **C++ 和外面之間只有一個函式。** `bbapi` 收一段 msgpack 編碼的指令，回一段 msgpack 編碼的回應，輸出的記憶體由呼叫的一方用 `free` 釋放。`barretenberg-rs` 的 `FfiBackend` 就是宣告這個 `extern "C"` 函式再呼叫它。【一手】[B10][B11]
- **指令的型別是產生出來的。** `barretenberg-rs` 的 `api.rs` 和 `generated_types.rs` 由 `barretenberg/ts/bb.js` 的 `yarn generate` 從 msgpack 的 schema 產生；同一個目錄的產生器有 C++、Rust、TypeScript 三種（`cbind/cpp_codegen.ts`、`rust_codegen.ts`、`typescript_codegen.ts`），沒有 Swift 或 Kotlin 的。【一手】[B12]
- **不經 Rust、從 Swift 或 Kotlin 直接連結 C++：** 連結 `libbb-external.a` 後呼叫 `bbapi` 這一個 C 函式，指令和回應自己用 msgpack 編碼和解碼。【推論】依據是上面兩點。沒有找到這樣做的公開程式庫，【查不到】
- **`FfiBackend` 不是執行緒安全的。** 原始碼的說明寫每個執行緒各用一個，或由外面加鎖。【一手】[B11]
- **Barretenberg 的狀態是整個行程共用的。** 通用參數只有第一次初始化有效（見 4.1）。【一手】[B13]
- **執行緒數：** 環境變數 `HARDWARE_CONCURRENCY` 有設就用它，沒有設就取 32 和硬體核心數中較小的。【一手】[B14]
- **省記憶體的模式：** Barretenberg 讀環境變數 `BB_SLOW_LOW_MEMORY` 和 `BB_STORAGE_BUDGET`，多項式改放在檔案對應的記憶體。`noir_rs` 的 `low_memory_mode` 參數設的就是這兩個值，它的註解寫「significantly reduces RAM usage at the cost of slower proving (~2x)」。【一手】[B15][Z3]
- **原生驗證器遇到刻意做壞的證明可能丟例外或中止**，這一點 `spec/proof-verification.md` 已經記了（GHSA-73xc-j27q-wg75，受影響的套件包含 `barretenberg-rs`）。這張票問的是算證明，沒有再查。

### 2.2 發布檔的大小

| 檔案 | 下載的大小 | 裡面 | 記號 |
|---|---|---|---|
| `barretenberg-static-arm64-ios.tar.gz`（v6.0.0） | 17,901,605 | `libbb-external.a` 72,229,800 | 【一手】[B1] |
| `barretenberg-static-arm64-android.tar.gz`（v6.0.0），SHA-256 `f861c899…5112d3` | 20,854,945 | `libbb-external.a` 93,953,622 | 【一手】[B1] |
| `barretenberg-wasm.tar.gz`、`barretenberg-threads-wasm.tar.gz`（v6.0.0，網頁版用的，對照） | 4,094,252、4,099,488 | 沒有列內容 | 【一手】[B1] |
| Noir Android `lib-release.aar`（v1.0.0-1），SHA-256 `8ecf3ca6…714645` | 26,258,051 | `arm64-v8a/libnoir_java.so` 43,591,000（壓縮後 12,778,971）；`arm64-v8a/libc++.so` 1,109,112（壓縮後 388,021）；`x86_64` 另一份 48,182,488 和 1,632,144 | 【一手】[A1] |
| `Swoirenberg.xcframework.zip`（v1.0.0-2） | 56,783,392 | `ios-arm64` 的靜態函式庫 58,018,400（壓縮後 14,252,411）；模擬器 58,014,752；macOS（兩種架構）142,900,784 | 【一手】[S2] |

單位是位元組。

- `libnoir_java.so` 是已經連結好的動態函式庫，裡面有 Noir 的 Rust 程式和 Barretenberg；只留 `arm64-v8a` 時，APK 裡這一份壓縮後約 12.8 MB，加 `libc++.so` 約 0.4 MB。【推論】依據是 AAR 裡的壓縮後大小；商店實際給使用者的下載大小沒有來源，【查不到】
- Swoirenberg 的是靜態函式庫，要連結進 app 才知道最後多大。連結後 app 增加多少、App Store 顯示的大小，【查不到】
- Swoirenberg 的 `Cargo.toml` 為了縮小檔案，整體用 `opt-level = "z"`、`lto = true`、`strip = "symbols"`、`panic = "abort"`，但把 `acvm`、`acvm_blackbox_solver`、`bn254_blackbox_solver`、`brillig_vm`、`ark-bn254` 和幾個簽章、雜湊的 crate 留在 `opt-level = 3`。註解寫：「Witness generation is the on-device hot path … -Oz makes it hang for real circuits (e.g. ECDSA sig check)」。【一手】[S2]
- 它的 `Scripts/` 裡有一個 `strip-recursive-proving.sh`，沒有細讀。

## 3. 見證在手機上怎麼算

| 項目 | 內容 | 記號 |
|---|---|---|
| Barretenberg 算不算見證 | 不算。`CircuitProve` 的輸入是電路（`bytecode`、`verification_key`）、`witness`（位元組）和設定；見證要先算好再交給它。 | 【一手】[B16] |
| 原生的包裝怎麼算 | `noir_rs` 的 `execute` 呼叫 `nargo::ops::execute_program`，黑箱函式用 `Bn254BlackBoxSolver`。這些 crate 直接取自 `noir-lang/noir` 的 `v1.0.0`，編成原生的機器碼。是 ACVM 的原生版本，不是 WASM。Swoir、Noir Android 經過 `noir_rs`，做法相同。 | 【一手】[Z2][Z3] |
| 網頁版怎麼算 | `@noir-lang/noir_js` 1.0.0 依賴 `@noir-lang/acvm_js` 和 `@noir-lang/noirc_abi`。`acvm_js` 是同一個程式庫的 Rust crate 用 wasm-bindgen 編成的 WebAssembly（`crate-type = ["cdylib"]`），`bn254` 這個 feature 引用 `bn254_blackbox_solver`。 | 【一手】[N5] |
| 兩邊是不是同一份程式 | 原生和網頁用的 ACVM、黑箱函式的解法，是 `noir-lang/noir` 同一個標籤的同一份 Rust 原始碼，編譯的目標不同。 | 【推論】依據是上面兩列 |
| 輸入怎麼變成見證的起始值 | 網頁版由 `noirc_abi`（WASM）照電路的 `abi` 編碼。`noir_rs` 收的是已經排好的 `WitnessMap`（每個位置一個體元素）；Swoir 的 `Circuit.swift` 和 Noir Android 的 `Circuit.kt` 各自用 Swift、Kotlin 照 `abi` 把陣列、結構、字串攤平；mopro 的介面收 `inputs: Vec<String>`。`noir_rs` 的 README 請輸入複雜的人參考那兩份程式。 | 【一手】[Z1][S1][A1][M2] |
| 見證裡的 Poseidon2 是誰算的 | `bn254_blackbox_solver` 自己的 Rust 實作（`poseidon2.rs`、`poseidon2_constants.rs`，底下用 `ark-bn254`、`ark-ff`），不是 Barretenberg 的。網頁版和原生都是這樣。 | 【一手】[N6] |
| 交給 Barretenberg 的格式 | bb.js 把 noir_js 給的見證先解壓縮（`ungzip`）再送出，電路用解壓縮後的 ACIR。`noir_rs` 也是把見證序列化、把 `bytecode` 從 base64 解開並解壓縮後再送。 | 【一手】[B9][Z3] |
| 在原生 app 裡跑 WASM 版的 ACVM | 沒有找到這樣做的包裝或文件。 | 【查不到】 |

## 4. 通用參數和電路檔怎麼載入

### 4.1 Barretenberg 這一層（6.0.0）

| 項目 | 內容 | 記號 |
|---|---|---|
| 交參數的指令 | `SrsInitSrs`：`points_buf`（G1 的點）、`num_points`、`g2_point`（128 個位元組）。`barretenberg-rs` 6.0.0 對應的函式是 `srs_init_srs(points_buf, num_points, g2_point)`。網頁版用的 `srsInitSrs` 是同一個指令。 | 【一手】[B4][B17] |
| 壓縮格式（每點 32 個位元組） | 長度必須是 4 MB（131,072 個點）的整數倍；每一塊的 SHA-256 和函式庫內建的表（`BN254_G1_CHUNK_HASHES`）比對，不同就停下來。解開後回傳未壓縮的點，註解寫是給呼叫的一方存起來用。 | 【一手】[B17][B18] |
| 未壓縮格式（每點 64 個位元組） | 不做分塊的雜湊比對，只檢查前兩個點是不是固定的值。原始碼的註解：「Defense in depth on the compressed path; the only gate on the uncompressed (cached) path.」 | 【一手】[B17] |
| G2 的點 | 兩種格式都核對 SHA-256（內建的值是 `01797bfc…2b69c32f`），再檢查不是無窮遠點、在質數階的子群裡。這個值和 `web/src/prover/artifacts.ts` 寫死的 G2 雜湊相同。 | 【一手】[B17][B19] |
| 這個程式庫現在的參數檔符不符合分塊的規定 | 2^18 個點乘 32 是 8,388,608 個位元組，剛好兩塊。 | 【推論】算術 |
| 沒有先交參數就算證明 | 取參數的函式在沒有初始化時會丟出「You need to initialize the global CRS with a call to init_crs_factory(...)!」。`bbapi_ultra_honk.cpp` 裡沒有初始化參數的呼叫。 | 【一手】[B13][B16] |
| 只有第一次有效 | `init_bn254_mem_crs_factory` 在已經初始化過時直接返回。`noir_rs` 的註解：「Since barretenberg 5.x, only the first SRS initialization of the process takes effect」。 | 【一手】[B13][Z3] |
| Barretenberg 自己的下載 | 原生的程式另有一條自己下載的路：`http://crs.aztec-cdn.foundation/g1_compressed.dat`（備用 `http://crs.aztec-labs.com/…`），沒有 TLS，下載後逐塊比對內建的 SHA-256；存放的目錄是 `CRS_PATH` 或 `$HOME/.bb-crs`。經 `bbapi` 用 `SrsInitSrs` 交參數時不走這條路。 | 【一手】[B13][B20]；「不走這條路」是【推論】，依據是 `SrsInitSrs` 用的是記憶體裡的點（`init_bn254_mem_crs_factory`） |

### 4.2 `noir_rs` 和它上面的包裝

| 項目 | 內容 | 記號 |
|---|---|---|
| `setup_srs(circuit_size, srs_path)` | 點數取電路大小對應的子群大小加 1。`srs_path` 是 `None` 時，`noir_rs` 自己用 HTTPS 從 `https://crs.aztec.network/g1.dat` 下載未壓縮的點（Range 請求），下載後它自己沒有核對雜湊；G2 的點寫死在程式裡。 | 【一手】[Z4] |
| 給路徑時 | 路徑以 `.dat` 結尾：讀檔案開頭的 `num_points × 64` 個位元組當未壓縮的點。其他副檔名：當成 bincode 序列化的 `Srs` 結構。 | 【一手】[Z4] |
| 走的是哪一種格式 | 兩條路交給 Barretenberg 的都是未壓縮的點，所以 4.1 的分塊雜湊比對不會發生，只剩前兩個點和 G2 的檢查。 | 【推論】依據是 [Z4] 和 [B17] |
| `setup_srs_from_bytecode` | 先用 `circuit_stats` 從電路算出大小再呼叫 `setup_srs`。Noir Android 的 README 寫：已經知道電路大小時直接給，可以省去從 bytecode 建電路的時間和記憶體。 | 【一手】[Z4][A1] |
| 上層怎麼傳路徑 | Swoir：`setupSrs(srs_path:)`。Noir Android：`setupSrs(srs_path)`，README 寫不給路徑時「download the SRS from Aztec's server」。mopro：`srsPath`，另有 `srs_downloader` 指令在開發時先把參數抓下來。 | 【一手】[S1][A1][M2][M3] |
| app 自己下載並核對雜湊 | 三個包裝收的都是本機的檔案路徑，檔案從哪裡來由 app 決定：app 可以從自己的站下載、自己算 SHA-256、通過後把路徑交進去。 | 【推論】依據是上一列的介面；沒有找到包裝自己提供核對雜湊的選項，【查不到】 |
| 這個程式庫現有的壓縮參數檔能不能直接用 | `noir_rs` 的 `.dat` 路徑讀的是未壓縮的格式。要用壓縮格式和 Barretenberg 內建的分塊比對，得直接呼叫 `barretenberg-rs` 的 `srs_init_srs`。 | 【推論】依據是 [Z4][B17] |
| 未壓縮的參數有多大 | 2^18 加 1 個點乘 64 是 16,777,280 個位元組。 | 【推論】算術，前提是 232,239 的電路對應 2^18 的子群 |

### 4.3 電路檔和驗證金鑰

| 項目 | 內容 | 記號 |
|---|---|---|
| 電路怎麼交進去 | `noir_rs`：`circuit_bytecode: &str`（JSON 裡 `bytecode` 那一串 base64）。Swoir：`manifest: Data` 或 `URL`。Noir Android：`Circuit.fromJsonManifest(字串)`。mopro：`circuitPath`。都是執行時才給的值，不要求編進 app。 | 【一手】[Z3][S1][A1][M2] |
| app 自己下載並核對雜湊 | 可以：app 拿到位元組後自己算 SHA-256，再交給包裝。包裝本身不核對電路檔。 | 【推論】依據是上一列 |
| 精簡過的電路檔 | 見 1.4 和 1.5「電路檔的欄位」：Swoir 要 `hash`，Noir Android 的類別宣告了這裡拿掉的欄位。直接用 `noir_rs` 只需要 `bytecode` 那一串。 | 【一手】[Z3][S1][A1] |
| 驗證金鑰 | `CircuitProve` 的電路輸入帶一把驗證金鑰，原始碼的說明：「This could be derived, but it is more efficient to have it fixed ahead of time. As well, this guards against unexpected changes in the verification key.」`noir_rs` 的 `prove_ultra_honk` 有 `verification_key` 參數（說明寫第一次可以給空的）；Swoir 和 Noir Android 在沒有給時會先呼叫取驗證金鑰的函式。 | 【一手】[B21][Z3][S1][A1] |

## 5. Poseidon2 能不能從同一份函式庫呼叫

| 項目 | 內容 | 記號 |
|---|---|---|
| Barretenberg 有沒有這個指令 | 有。`bbapi_crypto.hpp` 定義 `Poseidon2Hash`（輸入一串體元素，輸出一個）、`Poseidon2Permutation`（狀態 4 個體元素）、`Poseidon2AbsorbChain`。 | 【一手】[B22] |
| Rust 這一層 | crates.io 上的 `barretenberg-rs` 6.0.0 的 `api.rs` 有 `poseidon2_hash(inputs: Vec<Vec<u8>>)`、`poseidon2_permutation(inputs: [Vec<u8>; 4])`、`poseidon2_absorb_chain`。程式庫裡有用 `FfiBackend` 呼叫 `poseidon2_hash` 的測試。 | 【一手】[B4][B23] |
| 和算證明是不是同一份函式庫 | `FfiBackend` 的每個指令都經同一個 `bbapi` 函式進到同一個 `libbb-external.a`；`CircuitProve` 和 `Poseidon2Hash` 是同一份函式庫裡的兩個指令。 | 【一手】[B10][B11] |
| 和網頁版是不是同一個指令 | 網頁版呼叫的 `poseidon2Hash` 和 Rust 的 `poseidon2_hash` 由同一份 schema 產生。 | 【一手】[B12]。兩邊對同樣的輸入給出同樣的值：【推論】，要用 `spec/vectors/poseidon2.json` 實測 |
| 現成的包裝有沒有開放 | `noir_rs` `v1.0.0-1`、Swoirenberg `v1.0.0-2`、Noir Android `v1.0.0-1`、mopro 的 Noir 介面，公開的函式裡都沒有 Poseidon2。 | 【一手】[Z3][S2][A1][M2] |
| 要用的話 | 要有一層自己的 Rust（或 C）程式，和算證明的程式連結在同一個函式庫裡，呼叫 `barretenberg-rs` 的 `poseidon2_hash`，再用 swift-bridge、JNI 或 UniFFI 開放給 Swift、Kotlin。 | 【推論】依據是上面幾列 |
| 一次呼叫的成本 | 每次呼叫都是一次 msgpack 編碼、一次 `bbapi`、一次解碼和一次 `free`。建一棵樹要呼叫很多次；`Poseidon2Hash` 一次只算一個雜湊。在手機上建一棵廢止清冊的樹要多久，沒有公開的數字。 | 【一手】呼叫的方式 [B11]；時間【查不到】 |
| 另一份 Rust 的 Poseidon2 | Noir 算見證用的 `bn254_blackbox_solver::poseidon2_permutation` 是另一份實作（見第 3 節），不是 Barretenberg 的。 | 【一手】[N6] |
| 舊的記載 | mopro 2025-05-12 的文章寫，當時找不到 Rust 的 Poseidon2，他們照 Noir 的原始碼自己寫了一份。那是 `barretenberg-rs` 出現之前（`FfiBackend` 在 2025-12-19 的提交加入）。 | 【一手】[M5][B24] |

## 6. 別人公開量過的手機證明時間和記憶體

這個程式庫自己的數字（對照用）：電路大小 232,239；iPhone 14 Pro 的 Safari 一次過卡 5.2 到 5.6 秒、記憶體峰值 749 MB；桌機原生約 1.07 秒、約 0.6 GB。原生的手機 app 沒有量（ADR-0012、ADR-0013）。

| 來源 | 量了什麼 | 數字 | 沒有寫的 | 記號 |
|---|---|---|---|---|
| mopro 文件的 Performance 頁，Noir 一節 | `nargo` 1.0.0-beta.3、`bb` 0.82.2。五個電路：Keccak256、RSA（`noir_rsa` 的 PKCS#1 v1.5、SHA-256）、zkEmail、Anon Aadhaar、Semaphore。「Android」是 Pixel 6（release 模式）；「iOS」那一欄是用「My Mac (Designed for iPad)」在 Mac 上跑的，不是 iPhone。取多次裡最快的一次。 | RSA：Android 1,091 ms、iOS 欄 312 ms、`bb` CLI 221 ms、網頁 2,068 ms。Anon Aadhaar：8,179 ms、2,225 ms、1,366 ms、17,030 ms。zkEmail：4,757 ms、1,309 ms、804 ms、6,590 ms。 | 各電路的大小、記憶體 | 【一手】[M6] |
| mopro 2025-05-12 的文章（StealthNote 的 JWT 電路） | 證明和驗證的時間 | 證明：iPhone 16 Pro 2.626 秒；Android 模擬器（Pixel 8）4.786 秒；Mac M1 Pro 2.02 秒；瀏覽器 37.292 秒 | 電路大小、記憶體、Noir 和 bb 的版本 | 【一手】[M5] |
| mopro 2026-10-16 的文章 | 三個電路，補齊前的大小 311,356、383,248、455,140（補齊後都是 2^19）。機器是 Apple M4、16 GiB。文章自己寫：「These are host measurements, not mobile benchmarks or isolated proving times.」 | 一次呼叫（含見證、證明、讀參數）的中位數 4.62、6.19、7.90 秒；行程記憶體峰值的中位數 2.17、2.26、2.35 GiB | 手機上的數字 | 【一手】[M7] |
| zkPassport 文件的 FAQ | 用 Barretenberg 的 UltraHonk 在手機上原生算。沒有寫是哪幾支手機、電路多大。 | 三份基礎證明合計「from 10s to 50s」；揭露用的證明「from less than 1s to 10s」。記憶體：RSA「should not go over 1GB (even for RSA 4096 bits with SHA-512)」；ECDSA 的大曲線「should not exceed 2GB」。 | 裝置型號、電路大小、量的方法 | 【一手】[Z5] |
| `ethereum/csp-benchmarks` | 有 Barretenberg 的項目（Noir 1.0.0-beta.25、Barretenberg 5.2.1），在 AWS 的 `mac2.metal`（Apple M1、8 核、16 GB）上跑。`mobile/` 目錄只有 binius 和 plonky2。README：「Our future plans include running the benchmarks in a cloud device farm (Android and iOS mobile devices).」 | 沒有抄數字（不是手機） | Barretenberg 在手機上的數字 | 【一手】[O3] |

- 原生的手機 app、UltraHonk、電路大小在 2^18 上下、同時有時間和記憶體、Barretenberg 6.0.0：沒有找到這樣的公開量測。【查不到】
- 上表裡電路的內容和過卡電路最接近的是 mopro 的 RSA 和 Anon Aadhaar（RSA 簽章加 SHA-256），但來源沒有寫它們的大小，版本是 bb 0.82.2。它們和 232,239 差多少，【查不到】

## 逐項回答票上的問題

1. **現成的手機包裝、維護狀況、版本、能不能釘**：Aztec 官方有 Rust 的 `barretenberg-rs` 和四個手機平台的靜態函式庫（6.0.0 有），沒有官方的 Swift、Kotlin 套件。Noir 官方沒有手機包裝。第三方：`zkpassport/noir_rs` `v1.0.0-1`（2026-11-03）、Swoir 和 Swoirenberg `v1.0.0-2`（2026-11-04）、Noir Android `v1.0.0-1`（2026-11-04），三者都是 Noir 1.0.0 加 Barretenberg 6.0.0，和這個程式庫相同。mopro 用的 `zkmopro/noir-rs` 停在 Noir 1.0.0-beta.19、Barretenberg 4.2.0-aztecnr-rc.2（2026-04 到 06）。
2. **形狀和大小**：C++ 的靜態函式庫對外只有 `bbapi` 一個 C 函式（msgpack 進出）；上面是 Rust（`barretenberg-rs`、`noir_rs`），再用 swift-bridge（Swoir）、JNI（Noir Android）或 UniFFI（mopro）接到 Swift、Kotlin。不經 Rust 直接連結是推論上可行，沒有現成的。Noir Android 的 `arm64-v8a` 函式庫 43.6 MB（在 AAR 裡壓縮後 12.8 MB）；Swoirenberg 的 iOS 靜態函式庫 58.0 MB（壓縮後 14.3 MB）。商店裡實際多大查不到。
3. **見證**：ACVM 的原生版本（Noir 的 Rust crate 直接編成原生碼），不是 WASM。輸入的 ABI 編碼在 Swoir、Noir Android 各有一份 Swift、Kotlin 的實作。
4. **通用參數和電路檔**：都是執行時交進去的值，app 可以自己下載、核對雜湊再交。Barretenberg 6.0.0 對壓縮格式的參數會逐塊比對內建的 SHA-256，對未壓縮的只檢查前兩個點；`noir_rs` 走的是未壓縮的格式，沒給路徑時會自己從 Aztec 的站下載、不核對雜湊。Swoir 的電路檔要有 `hash` 欄位，這裡的檔案沒有。
5. **Poseidon2**：同一份 `libbb-external.a` 有 `Poseidon2Hash`，`barretenberg-rs` 6.0.0 有 `poseidon2_hash`；現成的 Swift、Kotlin 包裝都沒有把它開放出來，要自己加一層。和網頁版的值相同是推論，要用 `spec/vectors/` 實測。建樹的時間查不到。
6. **公開的量測**：有 mopro 的兩組（bb 0.82.2，Pixel 6 和 iPhone 16 Pro，沒有電路大小和記憶體）和 zkPassport 的範圍（沒有裝置和電路大小）。大小接近 232,239、在手機上原生量、同時有時間和記憶體的，查不到。

## 來源

都在 2026-11-19 查證。GitHub 的內容用 API 讀指定的標籤或 commit；`HEAD` 表示當天預設分支的最新提交，commit 寫在後面。

**Aztec（Barretenberg）**

- [B1] `AztecProtocol/aztec-packages` 的發布：<https://github.com/AztecProtocol/aztec-packages/releases/tag/v6.0.0>（2026-10-22，commit `0219f11d8133970df3974fe5ae65e006bf8c193a`）、<https://github.com/AztecProtocol/aztec-packages/releases/tag/v6.1.0>（2026-11-19）
- [B2] `barretenberg/bbup/bb-versions.json`：<https://github.com/AztecProtocol/aztec-packages/blob/v6.0.0/barretenberg/bbup/bb-versions.json>、<https://github.com/AztecProtocol/aztec-packages/blob/v6.1.0/barretenberg/bbup/bb-versions.json>
- [B3] <https://github.com/AztecProtocol/aztec-packages/blob/v6.0.0/barretenberg/rust/README.md>、<https://github.com/AztecProtocol/aztec-packages/blob/v6.0.0/barretenberg/rust/barretenberg-rs/README.md>
- [B4] <https://crates.io/crates/barretenberg-rs/6.0.0>（下載的 crate 裡的 `src/api.rs`）
- [B5] <https://github.com/AztecProtocol/aztec-packages/blob/v6.0.0/barretenberg/cpp/CMakePresets.json>
- [B6] <https://github.com/AztecProtocol/aztec-packages/blob/v6.0.0/barretenberg/rust/barretenberg-rs/build.rs>
- [B7] <https://github.com/AztecProtocol/barretenberg/releases/tag/v6.0.0>
- [B8] <https://github.com/AztecProtocol/aztec-packages/tree/v6.0.0/barretenberg>、<https://github.com/AztecProtocol/aztec-packages/tree/v6.0.0/barretenberg/docs/docs/how_to_guides>
- [B9] <https://github.com/AztecProtocol/aztec-packages/blob/v6.0.0/barretenberg/ts/bb.js/src/barretenberg/backend.ts>
- [B10] <https://github.com/AztecProtocol/aztec-packages/blob/v6.0.0/barretenberg/cpp/src/barretenberg/bbapi/c_bind.cpp>
- [B11] <https://github.com/AztecProtocol/aztec-packages/blob/v6.0.0/barretenberg/rust/barretenberg-rs/src/backends/ffi.rs>
- [B12] <https://github.com/AztecProtocol/aztec-packages/tree/v6.0.0/barretenberg/ts/bb.js/src/cbind>、<https://github.com/AztecProtocol/aztec-packages/blob/v6.0.0/barretenberg/rust/bootstrap.sh>
- [B13] <https://github.com/AztecProtocol/aztec-packages/blob/v6.0.0/barretenberg/cpp/src/barretenberg/srs/global_crs.cpp>
- [B14] <https://github.com/AztecProtocol/aztec-packages/blob/v6.0.0/barretenberg/cpp/src/barretenberg/common/thread.cpp>
- [B15] <https://github.com/AztecProtocol/aztec-packages/blob/v6.0.0/barretenberg/cpp/src/barretenberg/polynomials/backing_memory.cpp>
- [B16] <https://github.com/AztecProtocol/aztec-packages/blob/v6.0.0/barretenberg/cpp/src/barretenberg/bbapi/bbapi_ultra_honk.hpp>、同目錄的 `bbapi_ultra_honk.cpp`
- [B17] <https://github.com/AztecProtocol/aztec-packages/blob/v6.0.0/barretenberg/cpp/src/barretenberg/bbapi/bbapi_srs.cpp>、同目錄的 `bbapi_srs.hpp`
- [B18] <https://github.com/AztecProtocol/aztec-packages/blob/v6.0.0/barretenberg/cpp/src/barretenberg/srs/factories/bn254_g1_chunk_hashes.hpp>
- [B19] <https://github.com/AztecProtocol/aztec-packages/blob/v6.0.0/barretenberg/cpp/src/barretenberg/srs/factories/bn254_crs_data.hpp>
- [B20] <https://github.com/AztecProtocol/aztec-packages/blob/v6.0.0/barretenberg/cpp/src/barretenberg/srs/factories/get_bn254_crs.cpp>
- [B21] <https://github.com/AztecProtocol/aztec-packages/blob/v6.0.0/barretenberg/cpp/src/barretenberg/bbapi/bbapi_shared.hpp>
- [B22] <https://github.com/AztecProtocol/aztec-packages/blob/v6.0.0/barretenberg/cpp/src/barretenberg/bbapi/bbapi_crypto.hpp>
- [B23] <https://github.com/AztecProtocol/aztec-packages/blob/v6.0.0/barretenberg/rust/tests/src/ffi/poseidon.rs>
- [B24] <https://github.com/AztecProtocol/aztec-packages/commit/2b954938d5>（「feat(bb): Add FfiBackend for direct C FFI calls to Barretenberg (#19124)」，2025-12-19）

**Noir**

- [N1] <https://github.com/noir-lang/noir/releases/tag/v1.0.0>（2026-10-29，commit `275d3ab1a5c916c6ea73e8d6b943f685f574500c`）
- [N2] <https://github.com/orgs/noir-lang/repositories>、<https://github.com/noir-lang/barretenberg-sys>
- [N3] <https://github.com/noir-lang/noir/tree/v1.0.0/docs/versioned_docs/version-v1.0.0/guides>
- [N4] <https://github.com/noir-lang/awesome-noir/blob/cc30bee604878107df1085b7e198cac2fa643584/README.md>
- [N5] <https://github.com/noir-lang/noir/blob/v1.0.0/tooling/noir_js/package.json>、<https://github.com/noir-lang/noir/blob/v1.0.0/acvm-repo/acvm_js/Cargo.toml>
- [N6] <https://github.com/noir-lang/noir/tree/v1.0.0/acvm-repo/bn254_blackbox_solver>

**zkPassport、Swoir、Noir Android**

- [Z1] <https://github.com/zkpassport/noir_rs>（`HEAD` 和標籤 `v1.0.0-1` 都是 `239f121563b8f2307ade5f890913105711596147`，2026-11-03）
- [Z2] <https://github.com/zkpassport/noir_rs/blob/v1.0.0-1/Cargo.toml>
- [Z3] <https://github.com/zkpassport/noir_rs/tree/v1.0.0-1/src>（`execute.rs`、`backends/barretenberg/prove.rs`、`backends/barretenberg/api.rs`）
- [Z4] <https://github.com/zkpassport/noir_rs/tree/v1.0.0-1/src/backends/barretenberg/srs>（`mod.rs`、`netsrs.rs`、`localsrs.rs`）
- [Z5] <https://github.com/zkpassport/zkpassport-docs/blob/a79c1f22285961df8e435f873b8ae411aeac1007/docs/faq.md>（這個檔案最後修改於 2026-10-07 的 `fb92f959…`）
- [S1] <https://github.com/Swoir/Swoir/tree/v1.0.0-2>（commit `ec8442f41f2fccb296bd1ed24a19642cb0db8643`，2026-11-04；`Package.swift`、`README.md`、`Sources/Swoir/Circuit.swift`、`Sources/Swoir/Swoir.swift`）
- [S2] <https://github.com/Swoir/Swoirenberg/tree/v1.0.0-2>（commit `0be7e5e5e83799f995dacb3356ed7a9d427c638c`，2026-11-04；`Package.swift`、`Rust/Cargo.toml`、`Rust/src/lib.rs`）、<https://github.com/Swoir/Swoirenberg/releases/tag/v1.0.0-2>
- [S3] <https://github.com/Swoir/SwoirCore>（`HEAD` `fb88807fd62dc9143dfac90e81442dd1e64e5a30`，2025-10-08）
- [A1] <https://github.com/madztheo/noir_android/tree/v1.0.0-1>（commit `de71e53b717679b0764ba72fa8519fc6f6a7e2b8`，2026-11-04；`README.md`、`lib/build.gradle.kts`、`lib/src/main/java/com/noirandroid/lib/`、`lib/src/main/java/noir_java/`）、<https://github.com/madztheo/noir_android/releases/tag/v1.0.0-1>

**mopro**

- [M1] <https://github.com/zkmopro/mopro>（`HEAD` `4ffd3c894f0374add8705312a27d63d07c16ea48`，2026-10-19；`README.md`）、<https://github.com/zkmopro/mopro/releases>
- [M2] <https://github.com/zkmopro/mopro/blob/4ffd3c894f0374add8705312a27d63d07c16ea48/docs/docs/adapters/noir.md>
- [M3] <https://github.com/zkmopro/noir-rs>（`HEAD` `745dd1553592b14455c12b2c94f32fa882a9014e`，2026-06-09；`noir/Cargo.toml`、`README.md`）
- [M4] <https://github.com/zkmopro/mopro/blob/4ffd3c894f0374add8705312a27d63d07c16ea48/docs/docs/architectures.md>
- [M5] <https://github.com/zkmopro/mopro/blob/4ffd3c894f0374add8705312a27d63d07c16ea48/docs/blog/2025-05-12-noir-integration.md>
- [M6] <https://github.com/zkmopro/mopro/blob/4ffd3c894f0374add8705312a27d63d07c16ea48/docs/docs/performance.md>（這個檔案最後修改於 2025-05-30 的 `56c1c36b…`）、<https://github.com/zkmopro/mopro/issues/414>
- [M7] <https://github.com/zkmopro/mopro/blob/4ffd3c894f0374add8705312a27d63d07c16ea48/docs/blog/2026-10-16-private-balance-proofs-eas-noir-mopro.md>

**其他**

- [O1] <https://github.com/madztheo/noir-react-native-starter>、<https://github.com/zkmopro/NoirReactNative>、<https://github.com/zkmopro/noir_flutter>
- [O2] <https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/android/app/build.gradle>、同一個 commit 的 `ios/Podfile`
- [O3] <https://github.com/ethereum/csp-benchmarks/tree/4ec2ff80c27542b5f2220262ddd9576c417539c1>（`README.MD`、`mobile/`）

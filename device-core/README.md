# device-core/：Android、iOS 共用的核心（Rust）

**這個目錄讓人檢查的事：兩個 app 在手機上做的檢查和算法是同一份，而且這一份不碰 PIN、網路、NFC、檔案。** `spec/` 的算法、裝置上的檢查、算證明，照 ADR-0034 寫成一份 Rust，Android（Kotlin）和 iOS（Swift）都連結它，不各寫一次。它是 `spec/` 的第三份實作：Go（`verifier/`、`roster/`、`crl/`）、TypeScript（`protocol/`）、Rust 互不引用，測試讀同一份 `spec/vectors/`，哪一份走樣了會在測試時出現。

要檢查 PIN 有沒有離開手機，不用看這裡：這裡沒有任何函式收 PIN。看的是兩個 app 裡畫面和讀卡的程式。

## 兩個套件

一個 cargo workspace，兩個套件（ADR-0034）：

| 目錄 | 套件 | 內容 | 依賴 |
|---|---|---|---|
| `checks/` | `iamreal-device-checks` | 不碰 Barretenberg 的一半：`spec/` 的算法，之後加上裝置上的檢查。不做 I/O，沒有 `unsafe`（`unsafe_code = "forbid"`）。SHA-256 和 Poseidon2 由呼叫的人傳進來（`src/hash.rs` 的兩個 trait），和 `protocol/` 的做法相同，所以之後編得成 wasm | 沒有執行期的套件 |
| `prover/` | `iamreal-device-core` | 算證明的一半：連結 Barretenberg 預先編好的靜態函式庫，提供 Poseidon2（Barretenberg）和 SHA-256（`sha2`），之後加上見證、證明、平行建樹。對 Kotlin、Swift 開放的 C 函式都在這裡，app 連結的是它編出來的 `libiamreal_device_core.a` | `checks/`、`barretenberg-rs`、`sha2`、`serde_json`、`serde` |

`checks/` 要能不帶 Barretenberg 單獨編譯和測試：`cargo test -p iamreal-device-checks` 不需要下面的靜態函式庫。

### 現在有什麼

這是骨架：`spec/` 裡簡單的算法先放進來，讓建置、連結、測試的路先通。

| 檔案（`checks/src/`） | 規格 | 內容 |
|---|---|---|
| `scope.rs` | `spec/scope.md` | 每份名冊的場合字串，寫死在這裡，不從後台來（ADR-0016、ADR-0035） |
| `challenge.rs` | `spec/challenge.md` | 題目的唯一寫法、它的日期、`current_time` |
| `declaration_code.rs` | `spec/declaration-code.md` | 整份帳號清單的原文和宣告碼 |
| `scoped_id.rs` | `spec/scoped-id.md` | 匿名編號（簽章切成 18 段、Poseidon2 串起來）、文字寫法、短編號 |
| `username_format.rs` | `spec/scope.md`「Platforms」 | 帳號名稱的格式 `[…]{m,n}`，自己逐字解析，不交給正規表示式引擎；平台代號；不認得的平台上帳號最低限度的檢查 |
| `date.rs` | | 日期、台灣的日期（UTC+8，不看裝置的時區） |
| `base32.rs` | `spec/README.md` | base32，只認一種寫法 |
| `field.rs` | `spec/scoped-id.md`、`spec/proof-verification.md` | BN254 的模數、公開輸入的 32 個位元組、31 個位元組打包成一個值 |
| `hash.rs` | | 呼叫的人要提供的兩個雜湊 |

還沒有的（各有自己的票）：選憑證和檢查憑證、廢止清冊、建樹、電路輸入、名冊規則、檢查後台的回應、「檢查都通過了」的結果、算見證和證明、Android 和 iOS 的建置。

## C 函式的慣例

對外是手寫的幾個 C 函式，位元組進、位元組出，沒有回呼，不用產生綁定的工具（[#90](https://github.com/iamreal-tw/iamreal/issues/90) 第 8 點）。宣告在 `include/iamreal_device_core.h`，實作在 `prover/src/lib.rs`，兩邊手寫、要一致；`prover/tests/c_link.rs` 會拿這份標頭檔編一支 C 程式去連結靜態函式庫。後面加的每一個函式都照這幾條：

**名稱。** 函式是 `idc_` 開頭，常數是 `IDC_` 開頭。

**進來的位元組：指標加長度。** 核心只在這一次呼叫裡讀，不留指標；函式的說明沒有寫「核心留一份」的，核心也不留複本。進來的緩衝區從頭到尾是呼叫的人的：誰配置誰釋放，裡面是簽章或憑證時，呼叫的人用完自己清掉。核心自己複製出來的，核心用完蓋成零；交給 Barretenberg 的那一份由 `barretenberg-rs` 配置和釋放，核心蓋不到（匿名編號的 C 函式那張票要處理）。沒有位元組可以傳 `(NULL, 0)`。

**出去的位元組：`idc_buf`。** 核心配置、填好 `ptr` 和 `len`。呼叫的人讀完（要留就自己複製一份），用 `idc_buf_free` 還給核心，每一塊還一次。`idc_buf_free` 先把內容蓋成零再釋放，並把 `idc_buf` 設成空的，所以同一個 `idc_buf` 再呼叫一次不會出事。不要用 `free()` 釋放它。

**回傳值是代碼。** 會失敗的函式都回 `int32_t`：

| 代碼 | 意思 |
|---|---|
| `IDC_OK`（0） | 做到了，`idc_buf` 裡是結果 |
| `IDC_ERR_ARGUMENT`（1） | 呼叫本身寫錯了：指標是 `NULL`、數字不是列出來的值。這是 app 程式的錯 |
| `IDC_ERR_INPUT`（2） | 傳進來的位元組不是這個函式讀得懂的 |
| `IDC_ERR_INTERNAL`（3） | 核心自己失敗：panic，或 Barretenberg 沒有回應 |

代碼不是 `IDC_OK` 時，`idc_buf` 一定是空的（`NULL`、0），沒有東西要釋放；呼叫前不必先初始化它。之後的函式需要新的代碼就往後加號碼，已經有的號碼不改意思。

**錯誤裡沒有值。** 錯誤只有上面的代碼。Rust 裡的錯誤是固定的名稱，panic 的訊息是固定的字串：不放從卡片、憑證、清冊讀到的值，也不放帳號（[#94](https://github.com/iamreal-tw/iamreal/issues/94) 第 5 點）。panic 在 C 函式的邊界被接住，變成 `IDC_ERR_INTERNAL`，不會穿過邊界。

**有結構的資料用 JSON。** 清單這類有結構的輸入是 UTF-8 的 JSON，形狀照 `spec/` 和 `docs/api/` 裡同一個東西的形狀（例如帳號清單就是紀錄的 `accounts`）。Kotlin 和 Swift 都有內建的 JSON，不用另外帶套件。

**名冊是數字。** `IDC_ROSTER_PRODUCTION`（0）、`IDC_ROSTER_TEST`（1）。一個 app 建置時就定了是哪一份（ADR-0036），每次呼叫都傳那一個；場合字串由核心照這個數字拿寫死的那一條。

**執行緒。** 每個函式可以在任何執行緒呼叫，做完才回來；這裡的 Rust 不保留跨呼叫的狀態，每次呼叫各自開一個 Barretenberg 的介面（`barretenberg-rs` 的說明：一個介面只給一個執行緒用）。會算很久的（之後的建樹、證明）由 app 放到背景的執行緒。

**不做 I/O。** 沒有函式收 PIN、開檔案、連網路、碰 NFC；核心也不讀時鐘，需要現在的時間時由呼叫的人傳進來。

**版本。** `IDC_ABI_VERSION` 在函式改了或拿掉時加一號；`idc_abi_version()` 回傳連結進來的函式庫是哪一版，app 可以在啟動時比對標頭檔的數字。

**Poseidon2 不開放成 C 函式。** 匿名編號要用 Poseidon2 算，`idc_` 的函式裡沒有 Poseidon2，app 就不能靠它們自己算匿名編號（ADR-0034「核心擋住的順序」）。這一條擋的是寫錯順序，不是擋存心繞過：靜態函式庫裡還有 Barretenberg 自己的 C 函式（`bbapi`），所以 app 的程式只准呼叫標頭檔裡 `idc_` 開頭的函式，審 `android/`、`ios/` 時要看這一點。現在匿名編號只在 Rust 裡（`checks/src/scoped_id.rs`），還沒有 C 函式：它要等「檢查都通過了」的結果做出來，收那個結果才算。`prover/src/hashes.rs` 在 Rust 裡是 `pub`，那是給這個目錄的測試用的，app 看不到。

Android 另外有一層 JNI，把這些 C 函式包成 Kotlin 呼叫得到的函式；那一層在 `android/`，照同樣的規矩釋放和清除。

### 現在的函式

| 函式 | 做什麼 |
|---|---|
| `idc_abi_version` | 連結進來的函式庫的 `IDC_ABI_VERSION` |
| `idc_buf_free` | 把 `idc_buf` 還給核心 |
| `idc_self_check` | 確認連結進來的 Barretenberg 有回應，算出的 Poseidon2 和 `spec/vectors/poseidon2.json` 的一個案例相同。不收輸入。給 app 啟動時和建置的檢查用 |
| `idc_scope_string` | 這份名冊的場合字串（31 個位元組），卡片第一次簽的就是它 |
| `idc_declaration_code` | 帳號清單和題目的宣告碼（31 個位元組），卡片第二次簽的就是它。清單沒照平台排序、同一個平台兩次、題目不是唯一的寫法，都是 `IDC_ERR_INPUT` |

## 套件和工具鏈

版本都釘死；套件的規則照 `CONTRIBUTING.md`「套件」。

- **Rust 1.99.1**（`rust-toolchain.toml`；2026-10-15 發布）。有 rustup 的機器在這個目錄下跑 `cargo` 就會用它
- **`barretenberg-rs` 6.0.0**（只開 `ffi`）：呼叫 Barretenberg。版本和 `web/` 釘的 `@aztec-foundation/bb.js` 相同（ADR-0034）
- **`sha2` 0.11.1**：SHA-256（宣告碼）。Noir `v1.0.0` 的 ACVM 用的也是這一版
- **`serde_json` 1.0.154**、**`serde` 1.0.229**（不開 `derive`）：讀 C 函式收到的 JSON，同一個鍵寫兩次、多出來的鍵都不收；測試讀 `spec/vectors/`。Noir `v1.0.0` 的 `Cargo.lock` 裡也是這兩版，`serde` 本來就由 `barretenberg-rs` 帶進來
- `checks/` 的測試另外用 `sha2`、`serde_json`（只在測試）
- 上面幾個帶進來的套件和版本在 `Cargo.lock`（進版控）。建置一律加 `--locked`

Noir 的 ACVM（算見證）在算證明的那張票才加，版本是 `v1.0.0`，和 `web/` 釘的 `@noir-lang/noir_js` 相同。

### Barretenberg 的靜態函式庫

`prover/` 連結的是 Aztec 在 [Barretenberg `v6.0.0` 的發布頁](https://github.com/AztecProtocol/barretenberg/releases/tag/v6.0.0)提供的 `barretenberg-static-<平台>.tar.gz`，裡面是 `libbb-external.a`。函式庫不進版控，進版控的是每個平台那一份的 SHA-256（`barretenberg.sha256`，取自發布頁）和下載的腳本：

```
./fetch-barretenberg.sh              # 這台機器的平台
./fetch-barretenberg.sh arm64-ios    # barretenberg.sha256 裡的任何一個平台
```

腳本下載、核對 SHA-256、解開到 `vendor/barretenberg/<平台>/`（`.gitignore` 排除），印出那個目錄。雜湊不對就停，不解開。

app 要包進安裝檔的參數檔（ADR-0035）也不進版控：`./fetch-crs.sh` 下載 Barretenberg 的通用參數前 2^18 個點（壓縮格式）和 G2 的那一個點，核對 `crs.sha256`，寫到 `vendor/crs/`，印出那個目錄。兩個檔和雜湊與網頁版的 `web/scripts/fetch-crs.mjs` 相同。

`barretenberg-rs` 的建置腳本在沒有設 `BB_LIB_DIR` 時會自己下載函式庫，而且不核對。所以 `.cargo/config.toml` 把 `BB_LIB_DIR` 預設成一個沒有函式庫的位置：忘了設的建置會停下來，不會去下載。建置時把它設成腳本印出來的目錄。

## 怎麼單獨建置和測試

需要 rustup、一個 C 編譯器（`cc`）、`curl`。Linux 另外要 LLVM 的 libc++（Ubuntu：`libc++-dev`、`libc++abi-dev`），Barretenberg 的靜態函式庫是用它編的；macOS 內建。不需要手機、卡片、後台、Node、Go。

```
cd device-core
BB_LIB_DIR="$(./fetch-barretenberg.sh)" && export BB_LIB_DIR
cargo fmt --check
cargo clippy --locked --release --all-targets -- -D warnings
cargo test --locked --release
```

只測不碰 Barretenberg 的一半（不用下載函式庫）：

```
cargo test --locked -p iamreal-device-checks
```

拉取請求的檢查（`.github/workflows/checks.yml` 的 `device-core`）在 Linux 上跑的就是上面那五行。

### 測試讀什麼

測試讀 `spec/vectors/` 的標準答案，不複製，也不從另一種語言產生。

- `checks/tests/vectors.rs`（不需要 Barretenberg）：`challenge.json`（唯一的寫法、日期、`current_time` 和它的公開輸入、亂數的位元組）、`scope.json`（兩個場合字串和打包值、每份名冊收和不收的平台、帳號名稱照它的平台的格式）、`declaration-code.json`（原文、SHA-256、宣告碼、打包值）、`scoped-id.json`（文字寫法、短編號、讀不懂的寫法、網址裡的短編號）
- 沒有讀的：`poseidon2-constants.json`（Poseidon2 的置換是 Barretenberg 的，這裡沒有自己實作）、`poseidon2.json` 的 `revocation_tree`（建樹的票）
- `prover/tests/vectors.rs`：`poseidon2.json` 的 `hash_2`、`hash_3`（Barretenberg 的 Poseidon2），和 `scoped_id`（簽章切出的 18 段、串起來的匿名編號）
- `prover/tests/c_api.rs`：C 函式，照 app 呼叫的方式（指標、長度、`idc_buf`、代碼）。場合字串和宣告碼對 `scope.json`、`declaration-code.json`；每一種讀不懂的輸入、`NULL`、代碼不是 `IDC_OK` 時 `idc_buf` 是空的
- `prover/tests/c_link.rs`：用 `cargo build` 編出靜態函式庫，拿 `include/iamreal_device_core.h` 編 `prover/tests/smoke.c`、連結、執行。標頭檔和函式庫對不上、函式庫裡沒有對外的函式時，這一個會失敗

## 連結 Barretenberg 時要注意的

[#88](https://github.com/iamreal-tw/iamreal/issues/88) 量測時碰到的三件事：

- **`strip = "symbols"` 會把靜態函式庫對外的函式也拿掉。** `Cargo.toml` 的 release 設定用 `strip = "debuginfo"`；符號由 app 自己的連結去掉。`panic = "unwind"` 也不能改：C 函式靠它接住 panic
- **Barretenberg 自己決定的執行緒數在 Mac 上偏低**，證明慢 2 到 3 倍；要由核心依核心數設定。這裡還沒有算證明，留給加上證明的那張票
- **Android 的 libc++。** Aztec 給 Android 的靜態函式庫用的是 LLVM 的 libc++（`std::__1`），NDK 的是 `std::__ndk1`，兩者連結不起來；量測時用 Aztec 編 Barretenberg 的同一版 Zig 連結，把 libc++ 靜態連進 `.so`。留給 Android 建置的那張票

Linux 的靜態函式庫同樣要 LLVM 的 libc++（不是 GCC 的 libstdc++），所以上面要裝 `libc++-dev`。檢查裡裝的是 Ubuntu 24.04 套件庫當時的版本，沒有釘：它只在 Linux 上跑測試時用到，不進 app。

# device-core/：Android、iOS 共用的核心（Rust）

**這個目錄讓人檢查的事：兩個 app 在手機上做的檢查和算法是同一份，而且這一份不碰 PIN、網路、NFC、檔案。** `spec/` 的算法、裝置上的檢查、算證明，照 ADR-0034 寫成一份 Rust，Android（Kotlin）和 iOS（Swift）都連結它，不各寫一次。它是 `spec/` 的第三份實作：Go（`verifier/`、`roster/`、`crl/`）、TypeScript（`protocol/`）、Rust 互不引用，測試讀同一份 `spec/vectors/`，哪一份走樣了會在測試時出現。

要檢查 PIN 有沒有離開手機，不用看這裡：這裡沒有任何函式收 PIN。看的是兩個 app 裡畫面和讀卡的程式。

## 兩個套件

一個 cargo workspace，兩個套件（ADR-0034）：

| 目錄 | 套件 | 內容 | 依賴 |
|---|---|---|---|
| `checks/` | `iamreal-device-checks` | 不碰 Barretenberg 的一半：`spec/` 的算法和裝置上的檢查（選憑證和檢查憑證、廢止清冊、樹）。不做 I/O，沒有 `unsafe`（`unsafe_code = "forbid"`）。SHA-256 和 Poseidon2 由呼叫的人傳進來（`src/hash.rs` 的兩個 trait），和 `protocol/` 的做法相同，所以之後編得成 wasm | 沒有執行期的套件 |
| `prover/` | `iamreal-device-core` | 算證明的一半：連結 Barretenberg 預先編好的靜態函式庫，提供 Poseidon2（Barretenberg）和 SHA-256（`sha2`）、4 個執行緒的建樹、「檢查都通過了」的結果，之後加上見證和證明。對 Kotlin、Swift 開放的 C 函式都在這裡，app 連結的是它編出來的 `libiamreal_device_core.a` | `checks/`、`barretenberg-rs`、`sha2`、`serde_json`、`serde` |

`checks/` 要能不帶 Barretenberg 單獨編譯和測試：`cargo test -p iamreal-device-checks` 不需要下面的靜態函式庫。

### 現在有什麼

`spec/` 的算法、讀到憑證之後的檢查、建樹、「檢查都通過了」的結果。

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
| `der.rs` | `spec/device-checks.md`「DER」 | 嚴格的 DER：一個位元組的標籤、最短的定長長度、不超出外層；UTCTime 和 GeneralizedTime |
| `rsa.rs` | `spec/device-checks.md`「Issuer」 | 驗 RSA 簽章（RSASSA-PKCS1-v1_5、SHA-256、指數 65537）。只有驗證，自己寫，見下面「RSA 驗章自己寫」 |
| `issuers.rs` | `spec/issuers.md` | 內政部的兩把發證金鑰，寫死在這裡（ADR-0035） |
| `certificate.rs` | `spec/device-checks.md`「The certificate」 | 檢查一張憑證（照電路的走法、日期、發證者的簽章）、從卡片回的幾張裡選一張、要顯示的姓名；檢查卡片自己的簽章 |
| `crl.rs` | `spec/revocation-tree.md`「Which CRLs」 | 讀廢止清冊、可不可用和原因代碼、清冊編號、清冊日期、每個序號的鍵 |
| `revocation.rs` | `spec/device-checks.md`「The CRL」 | 清冊多舊算過期（`L`）、從索引選哪個檔、檔案照順序檢查 |
| `key.rs`、`tree.rs` | `spec/revocation-tree.md`「Tree」 | 樹的鍵；樹和「不在樹裡」的路徑，可以分幾份建再合起來 |
| `hex.rs` | | 寫在程式裡的十六進位常數 |

| 檔案（`prover/src/`） | 內容 |
|---|---|
| `lib.rs` | C 函式 |
| `session.rs` | 一次過卡在核心裡的那一份，和「檢查都通過了」（見下面） |
| `tree.rs` | 分 4 份、4 個執行緒建樹，每個執行緒自己開一個 Barretenberg（[#88](https://github.com/iamreal-tw/iamreal/issues/88)「實作時要注意」） |
| `artifacts.rs` | 電路檔、驗證金鑰、參數檔的 SHA-256，寫死在這裡（ADR-0035） |
| `hashes.rs` | 兩個雜湊：`sha2` 的 SHA-256、Barretenberg 的 Poseidon2 |
| `alloc.rs` | 這個函式庫釋放的記憶體先蓋成零（見「清掉」） |
| `quiet.rs` | 核心裡的 panic 不印任何東西 |

還沒有的（各有自己的票）：電路輸入、名冊規則、檢查後台的回應、算見證和證明、組送出的請求、iOS 的建置。Android 的建置在 `android/`。

## 「檢查都通過了」

所有不需要簽章的檢查都通過之前，不能有請求帶著匿名編號送出去。流程由 Kotlin、Swift 各寫一次，所以這條順序由核心自己擋（ADR-0034「核心擋住的順序」）。

做法：一次過卡是核心裡的一個 **session**。app 手上只有一個數字（`idc_session`），檢查的結果留在核心裡，app 拿不到、也組不出來。檢查是 session 的幾個步驟，每一步只在它前面的步驟通過之後才做，否則回 `IDC_ERR_REFUSED`：

| 步驟 | 函式 | 通過的意思 |
|---|---|---|
| | `idc_session_open` | 開一個 session。它只認寫死的發證金鑰和寫死的檔案雜湊 |
| | `idc_session_add_certificate` | 卡片回的憑證，一張呼叫一次，照卡片的順序 |
| 1 | `idc_session_check_certificates` | 選出一張通過每一項檢查的憑證。回收不收、原因代碼、要顯示的姓名 |
| 2 | `idc_session_choose_crl`、`idc_session_check_crl` | 從鏡像的索引選出檔案；下載回來的檔案雜湊對、可用、編號沒有倒退、不過期，而且憑證的序號不在上面 |
| 3 | `idc_session_build_tree` | 樹建好了，憑證的序號有「不在樹裡」的路徑 |
| 4 | `idc_session_check_artifacts` | app 帶的電路檔、驗證金鑰、參數檔（兩個）就是寫死雜湊的那幾個。第 1 步之後任何時候都可以做 |
| | `idc_session_check_date` | 日期換了之後：憑證還在效期內、清冊還沒過期。通過的 session 才能在新的那一天繼續用 |
| | `idc_session_card_state_request` | **四步都通過、而且是在通過的那一天才做**：驗卡片對場合字串的簽章、算匿名編號、組出查現況的請求 |
| | `idc_session_close` | 關掉，清掉 |

- **只有通過四步的 session 算得出匿名編號。** 算匿名編號、組送後台的內容的函式都收 session；之後算證明、組送出的請求的函式也一樣，從同一個 `passed()` 拿憑證和路徑。
- **重做前面的步驟，後面的就不算。** 再檢查一次憑證，整個 session 從頭來；再選一次清冊，樹要重建。檔案核對失敗一次，就要重新核對到通過。
- **停下來的答案不是錯誤。** 檢查的結果是規格裡的原因代碼時（憑證過期、清冊太舊、被廢止），函式回 `IDC_OK` 和一段 JSON：`{"ok":false,"problem":"…"}`，加上規格說要回報的細節；通過時是 `{"ok":true,…}`。每個函式的 JSON 寫在 `prover/src/session.rs` 和標頭檔。
- **數字，不是指標。** `idc_session` 是核心表裡的編號，從 1 開始、不重複使用。關掉之後再拿它呼叫，或拿一個不存在的數字，得到 `IDC_ERR_ARGUMENT`，不會讀到釋放掉的記憶體。同一個 session 一次只跑一個呼叫，第二個會等。
- **核心不下載。** 索引和清冊由 app 下載後交進來；下載不到是 `crl_unavailable`，由 app 自己說，不問核心。後台的 `config` 整份交進來，核心自己讀 `crl_max_age_days`，取它和內建 7 天中較小的。
- **記住的清冊編號由 app 存。** 核心不寫檔案：`idc_session_check_crl` 收 app 記住的編號，回 `highest_after`，app 把它存起來。
- **時間由 app 給；通過只算在那一天。** `now` 是裝置的時鐘（1970 年起的秒數），核心換成台灣的日期，不看裝置的時區。`idc_session_check_certificates` 的那一天就是這個 session 的日期，清冊多舊算過期用同一天。算匿名編號的函式也收 `now`：日期和 session 的不同就回 `IDC_ERR_REFUSED`，要先用 `idc_session_check_date` 拿新的日期再核一次憑證的效期和清冊的日期（過卡可能跨過午夜；網頁版在拿題目之前和第二次簽章之前各核一次，app 照做）。核不過就停，session 從頭來。時鐘在 2000 到 2049 年之外時回 `IDC_ERR_ARGUMENT`：那不是 app 寫錯，是手機的時間不對，由 app 說；先前通過的也一起作廢。

這一道擋的是寫錯順序，不是存心繞過：見下面「Poseidon2 不開放成 C 函式」。

**關卡擋的是 Kotlin、Swift 經 C 函式寫錯順序，不擋存心引用 Rust 套件的人。** `prover/` 對外只有 C 函式：session、Poseidon2、建樹的模組在 Rust 裡都不是 `pub`，引用它的 Rust 程式（例如用 Rust 寫的 JNI 層）拿到的也只有 C 函式。但 `checks/` 的 `scoped_id` 是 `pub`（`prover/` 要用），收任何一個 Poseidon2；自己另外引用 `checks/` 和 `barretenberg-rs`、或自己開 `testing` 的 Rust 程式，不經過 session 也算得出匿名編號。那一種要靠審查 `android/`、`ios/` 引用了什麼。測試要用測試的發證金鑰（標準答案裡的憑證不是內政部簽的），所以有一個 cargo feature `testing`：開了它，這幾個模組才是 `pub`，`session::open` 才收得到別的發證金鑰。只有這個目錄的測試開它（`prover/Cargo.toml` 的 `[dev-dependencies]`）；`cargo build` 編出來給 app 連結的靜態函式庫沒有。測試用它開 session，之後每一步都走 C 函式。審 `android/`、`ios/` 的建置時要看：沒有人替 `iamreal-device-core` 開 `testing`。

### 清掉

- **進來的位元組是呼叫的人的**，核心不改它。憑證、簽章、PIN 以外的東西也一樣：誰配置誰釋放，用完自己清掉。
- **核心留下來的只有 session 裡的**：選中的那張憑證（含姓名）、從清冊算出來的鍵和路徑。`idc_session_add_certificate` 複製的憑證在 `idc_session_check_certificates` 做完時蓋成零，只留選中的那一張。`idc_session_close` 把 session 裡剩下的蓋成零再釋放；另一個執行緒正在這個 session 裡跑的話，等它回來才清。
- **簽章不留。** `idc_session_card_state_request` 驗完、算完就把自己的那一份蓋成零，session 裡沒有簽章。
- **`idc_buf` 還給核心時蓋成零。** `idc_session_check_certificates` 的 JSON 裡有姓名：姓名顯示出來之後就用 `idc_buf_free` 還掉。
- **這個函式庫釋放的每一塊記憶體都先蓋成零**（`prover/src/alloc.rs`）。`barretenberg-rs` 把 Poseidon2 的輸入複製進自己的緩衝區、用完直接釋放，`serde_json` 寫姓名時也一樣；這些複本核心的程式碰不到，所以在配置器那一層蓋。
- **蓋不到的**：Barretenberg（C++）自己配置的記憶體（算匿名編號時，簽章切出來的 18 段會進去），和執行緒的堆疊。要蓋到前者，得不經過 Barretenberg 算 Poseidon2，那是另一個決定。

### RSA 驗章自己寫

驗憑證和清冊的簽章（RSA 2048、4096，指數 65537）是 `checks/src/rsa.rs` 裡 200 行左右的 Montgomery 乘法，沒有用套件：

- 只有驗證：一次模冪（16 次平方、1 次乘法）和一段固定格式的比對，沒有私鑰、沒有亂數
- `checks/` 維持沒有執行期的套件，之後才編得成 wasm；現成的 RSA 套件會帶進大數、亂數等十幾個套件
- 規格把收不收寫得很死（長度、小於模數、整段格式逐位元組相同），標準答案有對應的案例；另外有一把測試用的 512 位元金鑰，簽了七種只差一處的格式，都要不收

憑證和清冊是公開的資料，但卡片對場合字串的簽章也用它驗，所以算式不依簽章的值分支，算完把中間值蓋成零。

## C 函式的慣例

對外是手寫的幾個 C 函式，位元組進、位元組出，沒有回呼，不用產生綁定的工具（[#90](https://github.com/iamreal-tw/iamreal/issues/90) 第 8 點）。宣告在 `include/iamreal_device_core.h`，實作在 `prover/src/lib.rs`，兩邊手寫、要一致；`prover/tests/c_link.rs` 會拿這份標頭檔編一支 C 程式去連結靜態函式庫。後面加的每一個函式都照這幾條：

**名稱。** 函式是 `idc_` 開頭，常數是 `IDC_` 開頭。

**進來的位元組：指標加長度。** 核心只在這一次呼叫裡讀，不留指標；函式的說明沒有寫「核心留一份」的，核心也不留複本。進來的緩衝區從頭到尾是呼叫的人的：誰配置誰釋放，裡面是簽章或憑證時，呼叫的人用完自己清掉。核心留下來的在 session 裡，關掉 session 時蓋成零；哪些蓋得到、哪些蓋不到，見「清掉」。沒有位元組可以傳 `(NULL, 0)`。

**出去的位元組：`idc_buf`。** 核心配置、填好 `ptr` 和 `len`。呼叫的人讀完（要留就自己複製一份），用 `idc_buf_free` 還給核心，每一塊還一次。`idc_buf_free` 先把內容蓋成零再釋放，並把 `idc_buf` 設成空的，所以同一個 `idc_buf` 再呼叫一次不會出事。不要用 `free()` 釋放它。

**回傳值是代碼。** 會失敗的函式都回 `int32_t`：

| 代碼 | 意思 |
|---|---|
| `IDC_OK`（0） | 做到了，`idc_buf` 裡是結果 |
| `IDC_ERR_ARGUMENT`（1） | 呼叫本身寫錯了：指標是 `NULL`、數字不是列出來的值。這是 app 程式的錯 |
| `IDC_ERR_INPUT`（2） | 傳進來的位元組不是這個函式讀得懂的 |
| `IDC_ERR_INTERNAL`（3） | 核心自己失敗：panic，或 Barretenberg 沒有回應 |
| `IDC_ERR_REFUSED`（4） | 這個 session 還沒通過這個函式要先通過的檢查（「檢查都通過了」） |

代碼不是 `IDC_OK` 時，`idc_buf` 一定是空的（`NULL`、0），沒有東西要釋放；呼叫前不必先初始化它。之後的函式需要新的代碼就往後加號碼，已經有的號碼不改意思。

**錯誤裡沒有值。** 錯誤只有上面的代碼。Rust 裡的錯誤是固定的名稱，panic 的訊息是固定的字串：不放從卡片、憑證、清冊讀到的值，也不放帳號（[#94](https://github.com/iamreal-tw/iamreal/issues/94) 第 5 點）。panic 在 C 函式的邊界被接住，變成 `IDC_ERR_INTERNAL`，不會穿過邊界；panic 帶的訊息不讀、不傳出去。Rust 預設在 panic 時往 stderr 印一行（訊息和位置），手機上 stderr 會進系統的 log，所以核心裡的 panic 一律不印（`prover/src/quiet.rs`）；不在核心裡的執行緒照原本的方式印。停下來的答案（`{"ok":false,…}`）只帶規格說要回報的東西：原因代碼、憑證的兩個日期、清冊編號、天數。

**有結構的資料用 JSON。** 清單這類有結構的輸入是 UTF-8 的 JSON，形狀照 `spec/` 和 `docs/api/` 裡同一個東西的形狀（例如帳號清單就是紀錄的 `accounts`）。Kotlin 和 Swift 都有內建的 JSON，不用另外帶套件。

**名冊是數字。** `IDC_ROSTER_PRODUCTION`（0）、`IDC_ROSTER_TEST`（1）。一個 app 建置時就定了是哪一份（ADR-0036），每次呼叫都傳那一個；場合字串由核心照這個數字拿寫死的那一條。

**執行緒。** 每個函式可以在任何執行緒呼叫，做完才回來。跨呼叫留下來的只有 session；每次呼叫各自開一個 Barretenberg 的介面（`barretenberg-rs` 的說明：一個介面只給一個執行緒用）。會算很久的（建樹，之後的證明）由 app 放到背景的執行緒；建樹自己再開 4 個執行緒，都做完才回來。

**不做 I/O。** 沒有函式收 PIN、開檔案、連網路、碰 NFC；核心也不讀時鐘，需要現在的時間時由呼叫的人傳進來。

**版本。** `IDC_ABI_VERSION` 在函式改了或拿掉時加一號；`idc_abi_version()` 回傳連結進來的函式庫是哪一版，app 可以在啟動時比對標頭檔的數字。

**Poseidon2 不開放成 C 函式。** 匿名編號要用 Poseidon2 算，`idc_` 的函式裡沒有 Poseidon2，app 就不能靠它們自己算匿名編號（ADR-0034「核心擋住的順序」）。這一條擋的是寫錯順序，不是擋存心繞過：靜態函式庫裡還有 Barretenberg 自己的 C 函式（`bbapi`），所以 app 的程式只准呼叫標頭檔裡 `idc_` 開頭的函式，審 `android/`、`ios/` 時要看這一點。算匿名編號的 C 函式只有 `idc_session_card_state_request`，它收一個四步都通過的 session。Rust 裡的 Poseidon2（`prover/src/hashes.rs`）不是 `pub`，只有測試用的 feature `testing` 開了才是（見「檢查都通過了」）。

Android 另外有一層 JNI，把這些 C 函式包成 Kotlin 呼叫得到的函式；那一層在 `android/`，照同樣的規矩釋放和清除。

### 現在的函式

| 函式 | 做什麼 |
|---|---|
| `idc_abi_version` | 連結進來的函式庫的 `IDC_ABI_VERSION` |
| `idc_buf_free` | 把 `idc_buf` 還給核心 |
| `idc_self_check` | 確認連結進來的 Barretenberg 有回應，算出的 Poseidon2 和 `spec/vectors/poseidon2.json` 的一個案例相同。不收輸入。給 app 啟動時和建置的檢查用 |
| `idc_scope_string` | 這份名冊的場合字串（31 個位元組），卡片第一次簽的就是它 |
| `idc_declaration_code` | 帳號清單和題目的宣告碼（31 個位元組），卡片第二次簽的就是它。清單沒照平台排序、同一個平台兩次、題目不是唯一的寫法，都是 `IDC_ERR_INPUT` |
| `idc_session_*` | 一次過卡的檢查和「檢查都通過了」，見上面那一節的表。每一塊緩衝區由誰釋放寫在標頭檔每個函式的說明裡 |

## 套件和工具鏈

版本都釘死；套件的規則照 `CONTRIBUTING.md`「套件」。

- **Rust 1.99.1**（`rust-toolchain.toml`；2026-10-15 發布）。有 rustup 的機器在這個目錄下跑 `cargo` 就會用它
- **`barretenberg-rs` 6.0.0**（只開 `ffi`）：呼叫 Barretenberg。版本和 `web/` 釘的 `@aztec-foundation/bb.js` 相同（ADR-0034）
- **`sha2` 0.11.1**：SHA-256（宣告碼）。Noir `v1.0.0` 的 ACVM 用的也是這一版
- **`serde_json` 1.0.154**、**`serde` 1.0.229**（不開 `derive`）：讀 C 函式收到的 JSON，同一個鍵寫兩次、多出來的鍵都不收；測試讀 `spec/vectors/`。Noir `v1.0.0` 的 `Cargo.lock` 裡也是這兩版，`serde` 本來就由 `barretenberg-rs` 帶進來
- `checks/` 的測試另外用 `sha2`、`serde_json`（只在測試）
- 上面幾個帶進來的套件和版本在 `Cargo.lock`（進版控）。建置一律加 `--locked`
- `prover/` 的 `[dev-dependencies]` 引用自己並開 feature `testing`（見「檢查都通過了」），`Cargo.lock` 裡因此多一行自己的名字，沒有多任何套件

Noir 的 ACVM（算見證）在算證明的那張票才加，版本是 `v1.0.0`，和 `web/` 釘的 `@noir-lang/noir_js` 相同。

### Barretenberg 的靜態函式庫

`prover/` 連結的是 Aztec 在 [Barretenberg `v6.0.0` 的發布頁](https://github.com/AztecProtocol/barretenberg/releases/tag/v6.0.0)提供的 `barretenberg-static-<平台>.tar.gz`，裡面是 `libbb-external.a`。函式庫不進版控，進版控的是每個平台那一份的 SHA-256（`barretenberg.sha256`，取自發布頁）和下載的腳本：

```
./fetch-barretenberg.sh              # 這台機器的平台
./fetch-barretenberg.sh arm64-ios    # barretenberg.sha256 裡的任何一個平台
```

腳本下載、核對 SHA-256、解開到 `vendor/barretenberg/<平台>/`（`.gitignore` 排除），印出那個目錄。雜湊不對就停，不解開。

`crs.sha256` 是參數檔（Barretenberg 的通用參數）兩個檔的 SHA-256，和 `web/src/prover/artifacts.ts` 的相同；`prover/src/artifacts.rs` 寫死的就是這兩個值，測試會比。

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
- 沒有讀的：`poseidon2-constants.json`（Poseidon2 的置換是 Barretenberg 的，這裡沒有自己實作）
- `prover/tests/vectors.rs`：`poseidon2.json` 的 `hash_2`、`hash_3`（Barretenberg 的 Poseidon2），和 `scoped_id`（簽章切出的 18 段、串起來的匿名編號）
- `prover/tests/c_api.rs`：C 函式，照 app 呼叫的方式（指標、長度、`idc_buf`、代碼）。場合字串和宣告碼對 `scope.json`、`declaration-code.json`；每一種讀不懂的輸入、`NULL`、代碼不是 `IDC_OK` 時 `idc_buf` 是空的
- `checks/tests/device_checks.rs`（不需要 Barretenberg）：`device-checks.json` 選憑證和檢查憑證的每一案（選到哪一張、發證者、序號、卡片的模數、兩個日期、姓名，或原因代碼）、`L`；`issuers.json`（寫死的兩把發證金鑰）；`crl/testdata/` 的每一份清冊可不可用、原因代碼、編號、清冊日期和 `expected.json` 相同
- `prover/tests/tree.rs`：`poseidon2.json` 的 `revocation_tree`、`revocation-tree.json`（整份清冊的樹根，每個序號的路徑或「在樹裡」）、`crl/testdata/` 每一份可用清冊的樹根。每一案都用 4 個執行緒建，也分 1、2、4 份各建一次，結果相同。`revocation-tree.json` 就是 `iamreal-crl prove` 印出來的（`cmd/iamreal-crl/vectors_test.go` 讀同一份）
- `prover/tests/session.rs`：從 C 函式走。`device-checks.json` 的憑證、索引、清冊每一案，結果的 JSON 和標準答案相同；`circuit-inputs.json` 的每一案走完四步，查現況的請求裡的匿名編號和標準答案的公開輸入相同；少任何一步、重做前面的步驟、檔案的雜湊不對、簽章不是這張卡片對這個場合字串簽的、日期不是通過的那一天，都拿不到匿名編號；換了日期再核一次，憑證過期、還沒生效、清冊太舊各停在對應的原因代碼；app 開的 session 不認測試金鑰。電路檔和驗證金鑰用這個程式庫裡的（`web/circuits/`、`verifier/vk/`），寫死的雜湊對它們和 `crs.sha256`；參數檔 8 MiB 不在程式庫裡，四步走完的案例用兩個短檔和它們的雜湊代替
- `prover/tests/no_values_in_errors.rs`：把一段記號寫進憑證、清冊、索引、`config`、記住的編號（各幾種寫法），走 C 函式，所有停下來的答案和錯誤裡都找不到那段記號
- `prover/tests/quiet.rs`：核心裡的 panic 什麼都不印（另開一個行程，讀它印出來的東西）
- `prover/tests/c_link.rs`：用 `cargo build` 編出靜態函式庫，拿 `include/iamreal_device_core.h` 編 `prover/tests/smoke.c`、連結、執行。標頭檔和函式庫對不上、函式庫裡沒有對外的函式時，這一個會失敗

## 連結 Barretenberg 時要注意的

[#88](https://github.com/iamreal-tw/iamreal/issues/88) 量測時碰到的三件事：

- **`strip = "symbols"` 會把靜態函式庫對外的函式也拿掉。** `Cargo.toml` 的 release 設定用 `strip = "debuginfo"`；符號由 app 自己的連結去掉。`panic = "unwind"` 也不能改：C 函式靠它接住 panic
- **Barretenberg 自己決定的執行緒數在 Mac 上偏低**，證明慢 2 到 3 倍；要由核心依核心數設定。這裡還沒有算證明，留給加上證明的那張票
- **Android 的 libc++。** Aztec 給 Android 的靜態函式庫用的是 LLVM 的 libc++（`std::__1`），NDK 的是 `std::__ndk1`，兩者連結不起來；量測時用 Aztec 編 Barretenberg 的同一版 Zig 連結，把 libc++ 靜態連進 `.so`。Android 的建置照這個做（`android/build-native.sh`、`android/README.md`「原生的函式庫」）

Linux 的靜態函式庫同樣要 LLVM 的 libc++（不是 GCC 的 libstdc++），所以上面要裝 `libc++-dev`。檢查裡裝的是 Ubuntu 24.04 套件庫當時的版本，沒有釘：它只在 Linux 上跑測試時用到，不進 app。

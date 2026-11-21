# device-core/：Android、iOS 共用的核心（Rust）

**這個目錄讓人檢查的事：兩個 app 在手機上做的檢查和算法是同一份，而且這一份不碰 PIN、網路、NFC、檔案。** `spec/` 的算法、裝置上的檢查、算證明，照 ADR-0034 寫成一份 Rust，Android（Kotlin）和 iOS（Swift）都連結它，不各寫一次。它是 `spec/` 的第三份實作：Go（`verifier/`、`roster/`、`crl/`）、TypeScript（`protocol/`）、Rust 互不引用，測試讀同一份 `spec/vectors/`，哪一份走樣了會在測試時出現。

要檢查 PIN 有沒有離開手機，不用看這裡：這裡沒有任何函式收 PIN。看的是兩個 app 裡畫面和讀卡的程式。

## 兩個套件

一個 cargo workspace，兩個套件（ADR-0034）：

| 目錄 | 套件 | 內容 | 依賴 |
|---|---|---|---|
| `checks/` | `iamreal-device-checks` | 不碰 Barretenberg 的一半：`spec/` 的算法和裝置上的檢查（選憑證和檢查憑證、廢止清冊、樹）。不做 I/O，沒有 `unsafe`（`unsafe_code = "forbid"`）。SHA-256 和 Poseidon2 由呼叫的人傳進來（`src/hash.rs` 的兩個 trait），和 `protocol/` 的做法相同，所以之後編得成 wasm | 沒有執行期的套件 |
| `prover/` | `iamreal-device-core` | 算證明的一半：連結 Barretenberg 預先編好的靜態函式庫，提供 Poseidon2（Barretenberg）和 SHA-256（`sha2`）、4 個執行緒的建樹、「檢查都通過了」的結果、見證（Noir 的 ACVM）和證明（Barretenberg）。對 Kotlin、Swift 開放的 C 函式都在這裡，app 連結的是它編出來的 `libiamreal_device_core.a` | `checks/`、`barretenberg-rs`、`acvm`、`bn254_blackbox_solver`、`sha2`、`serde_json`、`serde`、`base64`、`flate2` |

`checks/` 要能不帶 Barretenberg 單獨編譯和測試：`cargo test -p iamreal-device-checks` 不需要下面的靜態函式庫。

### 現在有什麼

`spec/` 的算法、讀到憑證之後的檢查、建樹、「檢查都通過了」的結果、電路輸入、見證和證明、送出的請求。

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
| `circuit_inputs.rs` | `spec/circuit-inputs.md` | 電路的輸入（憑證、發證金鑰、路徑、`current_time`、兩個簽章各自切成的段，和兩個 Barrett 參數），以及裝置預期證明帶的公開輸入 |
| `hex.rs` | | 寫在程式裡的十六進位常數 |
| `roster_rules.rs` | `spec/roster-rules.md` | 名冊規則：一筆紀錄的六項檢查（`apply_record`）、其中第 5、6 項（`apply_list`，裝置在簽章之前算的那一半）、從第一筆紀錄算起的現況（`MemoryRules`）、版本號 `RULES_VERSION` 和規則裡的數字。規則跟著版本號寫死在這裡（ADR-0035）；平台表不寫死，由呼叫的人傳進來 |
| `list_consequence.rs` | `spec/list-consequence.md` | 確認的畫面上每一列的後果：持卡人改過的清單在每個平台上是新宣告、再次過卡、更正、更換還是收回，更換之後還剩幾次；不認得的平台上的帳號照原樣留在清單裡 |

| 檔案（`prover/src/`） | 內容 |
|---|---|
| `lib.rs` | C 函式 |
| `session.rs` | 一次過卡在核心裡的那一份，和「檢查都通過了」（見下面） |
| `tree.rs` | 分 4 份、4 個執行緒建樹，每個執行緒自己開一個 Barretenberg（[#88](https://github.com/iamreal-tw/iamreal/issues/88)「實作時要注意」） |
| `artifacts.rs` | 電路檔、驗證金鑰、參數檔的 SHA-256，寫死在這裡（ADR-0035） |
| `hashes.rs` | 兩個雜湊：`sha2` 的 SHA-256、Barretenberg 的 Poseidon2 |
| `witness.rs` | 見證：讀編好的電路檔，把電路輸入交給 Noir 的 ACVM 解 |
| `proof.rs` | 證明：Barretenberg 的 UltraHonk，固定用紀錄驗證時的那一組設定（零知識、Poseidon2）；設定執行緒數、不讓 Barretenberg 印東西 |
| `alloc.rs` | 這個函式庫釋放的記憶體先蓋成零（見「清掉」） |
| `quiet.rs` | 核心裡的 panic 不印任何東西 |
| `json.rs` | 讀 C 函式收到的 JSON：同一個鍵寫兩次的不收，數字照它的值讀 |
| `server_state.rs` | 讀後台的平台表和 `card-state` 的回應（`spec/list-consequence.md`），見下面 |

讀後台回應的規則（`spec/list-consequence.md` 的「Reading the platform table」「Reading the card's state」）在 `prover/src/server_state.rs`，不在 `checks/`：它要讀 JSON，而 `checks/` 沒有執行期的套件。所以 `list-consequence.json` 的測試在 `prover/tests/`，要連結 Barretenberg 才跑得到。

還沒有的（各有自己的票）：檢查後台其他的回應（題目、送出的回應）。Android 的建置在 `android/`，iOS 的建置在 `ios/`（`ios/README.md`）。

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
| | `idc_session_records_request` | **四步都通過、而且題目的日期就是通過的那一天才做**：驗卡片的兩個簽章、算見證和證明、核對證明帶的公開輸入、組出送出的請求。見下面「算證明」 |
| | `idc_session_close` | 關掉，清掉 |

- **只有通過四步的 session 算得出匿名編號。** 算匿名編號、組送後台的內容的函式都收 session；算證明、組送出的請求的函式也一樣，從同一個 `passed()` 拿憑證和路徑。
- **重做前面的步驟，後面的就不算。** 再檢查一次憑證，整個 session 從頭來；再選一次清冊，樹要重建。檔案核對失敗一次，就要重新核對到通過。
- **停下來的答案不是錯誤。** 檢查的結果是規格裡的原因代碼時（憑證過期、清冊太舊、被廢止），函式回 `IDC_OK` 和一段 JSON：`{"ok":false,"problem":"…"}`，加上規格說要回報的細節；通過時是 `{"ok":true,…}`。每個函式的 JSON 寫在 `prover/src/session.rs` 和標頭檔。
- **數字，不是指標。** `idc_session` 是核心表裡的編號，從 1 開始、不重複使用。關掉之後再拿它呼叫，或拿一個不存在的數字，得到 `IDC_ERR_ARGUMENT`，不會讀到釋放掉的記憶體。同一個 session 一次只跑一個呼叫，第二個會等。
- **核心不下載。** 索引和清冊由 app 下載後交進來；下載不到是 `crl_unavailable`，由 app 自己說，不問核心。後台的 `config` 整份交進來，核心自己讀 `crl_max_age_days`，取它和內建 7 天中較小的。
- **記住的清冊編號由 app 存。** 核心不寫檔案：`idc_session_check_crl` 收 app 記住的編號，回 `highest_after`，app 把它存起來。
- **時間由 app 給；通過只算在那一天。** `now` 是裝置的時鐘（1970 年起的秒數），核心換成台灣的日期，不看裝置的時區。`idc_session_check_certificates` 的那一天就是這個 session 的日期，清冊多舊算過期用同一天。算匿名編號的函式也收 `now`：日期和 session 的不同就回 `IDC_ERR_REFUSED`，要先用 `idc_session_check_date` 拿新的日期再核一次憑證的效期和清冊的日期（過卡可能跨過午夜；網頁版在拿題目之前和第二次簽章之前各核一次，app 照做）。核不過就停，session 從頭來。時鐘在 2000 到 2049 年之外時回 `IDC_ERR_ARGUMENT`：那不是 app 寫錯，是手機的時間不對，由 app 說；先前通過的也一起作廢。 算證明的函式不收 `now`：紀錄的日期是題目的日期，題目的日期不是 session 的日期就回 `IDC_ERR_REFUSED`。

這一道擋的是寫錯順序，不是存心繞過：見下面「Poseidon2 不開放成 C 函式」。

**關卡擋的是 Kotlin、Swift 經 C 函式寫錯順序，不擋存心引用 Rust 套件的人。** `prover/` 對外只有 C 函式：session、Poseidon2、建樹的模組在 Rust 裡都不是 `pub`，引用它的 Rust 程式（例如用 Rust 寫的 JNI 層）拿到的也只有 C 函式。但 `checks/` 的 `scoped_id` 是 `pub`（`prover/` 要用），收任何一個 Poseidon2；自己另外引用 `checks/` 和 `barretenberg-rs`、或自己開 `testing` 的 Rust 程式，不經過 session 也算得出匿名編號。那一種要靠審查 `android/`、`ios/` 引用了什麼。測試要用測試的發證金鑰（標準答案裡的憑證不是內政部簽的），所以有一個 cargo feature `testing`：開了它，這幾個模組才是 `pub`，`session::open` 才收得到別的發證金鑰。只有這個目錄的測試開它（`prover/Cargo.toml` 的 `[dev-dependencies]`）；`cargo build` 編出來給 app 連結的靜態函式庫沒有。測試用它開 session，之後每一步都走 C 函式。審 `android/`、`ios/` 的建置時要看：沒有人替 `iamreal-device-core` 開 `testing`。

app 在模擬器上用假卡片過卡的測試也要測試的發證金鑰，但不該拿到 `testing` 開出來的那些模組。所以另有一個只做一件事的 feature `test-issuers`：開了它，靜態函式庫多一個 C 函式 `idc_testing_session_open`（`include/iamreal_device_core_testing.h`），開一個改認呼叫的人給的發證金鑰的 session，其餘和 `idc_session_open` 相同；Poseidon2、建樹、session 的 Rust 函式照舊不是 `pub`，之後每一步都走一般的 C 函式，核心擋的順序不變。開了它的函式庫裡有一段固定的記號（`iamreal-device-core:testing-issuer-keys`）。它只開測試名冊的 session，正式名冊的不開。`test-issuers` 只給模擬器上跑測試的那一份函式庫；發出去的 app 連結的那一份不開，沒有這個函式（`prover/tests/c_link.rs` 檢查不開 feature 編出來的函式庫裡沒有它），而且由 app 自己的建置檢查擋下帶著這個函式名稱或那段記號的安裝檔。開它的建置和擋它的檢查寫在各 app 的目錄，跟著各 app 的過卡一起加入。審 `android/`、`ios/` 的建置時要看：發出去的那一份沒有開 `test-issuers`，而且 app 自己的程式看不到 `iamreal_device_core_testing.h`。

Android 開它的是只給模擬器測試的建置（build type `fake`）和 JVM 上單元測試用的函式庫（`android/build-native.sh` 的第四個字 `test-issuers`）；debug 和 release 的安裝檔不開，`.so` 裡出現那段記號建置就失敗（`android/README.md`「建置時的檢查」）。JNI 那一層只在編測試用的函式庫時才引用 `iamreal_device_core_testing.h`。

### 算證明

`idc_session_records_request` 收四個檔、帳號清單、題目、卡片的兩個簽章，回 `POST /api/v1/records` 的內容（`spec/record.md` 的欄位，沒有 `seq`）。它照這個順序做，哪一步不過就停：

1. session 四步都通過，否則 `IDC_ERR_REFUSED`。
2. 四個檔再核對一次 SHA-256（ADR-0035）：第 4 步核對過之後核心沒有留下它們，這裡收到的是另一次交進來的位元組。不對是 `IDC_ERR_INPUT`，而且第 4 步要重新通過。
3. 題目是唯一的寫法；它的日期決定 `current_time`，也是紀錄的日期。它要和 session 的日期相同，否則 `IDC_ERR_REFUSED`：過卡跨過午夜時，app 在拿題目之前先用 `idc_session_check_date` 把 session 移到新的一天（上面「時間由 app 給」）。這個函式因此不收 `now`。
4. 帳號清單和題目算出宣告碼；兩個簽章分別是這張卡片對場合字串、對這個宣告碼簽的（`spec/device-checks.md`：卡片的每個簽章用之前都先驗）。不是就是 `IDC_ERR_INPUT`。清單裡的平台和帳號格式這裡只做每個平台都成立的檢查；名冊收不收，簽章之前由 `idc_list_consequence` 算（名冊規則的第 5、6 項），後台也會擋。
5. 電路輸入（`spec/circuit-inputs.md`）、見證、證明。電路解不出見證是 `IDC_ERR_INPUT`：前面都過了還解不出來，是電路自己的檢查不成立。
6. 證明帶的公開輸入和核心自己算的那一份逐一比對（發證金鑰、樹根、`current_time`、匿名編號、場合字串、宣告碼），有一個不同就什麼都不回（`IDC_ERR_INTERNAL`）。

證明的設定是固定的：零知識、Poseidon2，就是驗證紀錄時 `bb verify -t noir-recursive` 的那一組，呼叫的人和後台都選不了。證明 14,656 個位元組。

**通用參數交給 Barretenberg 一次。** 行程裡第一次算證明時，核對過的兩個參數檔交給 Barretenberg，它留著用到行程結束；之後的證明仍然每次核對四個檔，但不再交一次。

**Barretenberg 不印東西。** 它預設把每一步的時間和記憶體印到 stderr，手機上 stderr 會進系統的 log。核心在算證明前把它的 log 等級設成不輸出（`bb_log_level`，同樣是 `bbapi` 介面沒有的一項）。

### 清掉

- **進來的位元組是呼叫的人的**，核心不改它。憑證、簽章、PIN 以外的東西也一樣：誰配置誰釋放，用完自己清掉。
- **核心留下來的只有 session 裡的**：選中的那張憑證（含姓名）、從清冊算出來的鍵和路徑。`idc_session_add_certificate` 複製的憑證在 `idc_session_check_certificates` 做完時蓋成零，只留選中的那一張。`idc_session_close` 把 session 裡剩下的蓋成零再釋放；另一個執行緒正在這個 session 裡跑的話，等它回來才清。
- **簽章不留。** `idc_session_card_state_request` 驗完、算完就把自己的那一份蓋成零，session 裡沒有簽章。`idc_session_records_request` 兩個簽章都重新收一次，用完同樣不留：它自己的兩份、電路輸入（憑證的內容、簽章切成的段）、交給 Barretenberg 的見證，在回傳之前蓋成零；ACVM 解見證時自己配置的那些，由配置器在釋放時蓋。
- **`idc_buf` 還給核心時蓋成零。** `idc_session_check_certificates` 的 JSON 裡有姓名：姓名顯示出來之後就用 `idc_buf_free` 還掉。
- **這個函式庫釋放的每一塊記憶體都先蓋成零**（`prover/src/alloc.rs`）。`barretenberg-rs` 把 Poseidon2 的輸入複製進自己的緩衝區、用完直接釋放，`serde_json` 寫姓名時也一樣；這些複本核心的程式碰不到，所以在配置器那一層蓋。
- **蓋不到的**：Barretenberg（C++）自己配置的記憶體（算匿名編號時，簽章切出來的 18 段會進去；算證明時，整份見證會進去，裡面有憑證的內容和兩個簽章），和執行緒的堆疊。要蓋到前者，得不經過 Barretenberg 算 Poseidon2，那是另一個決定。

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

**執行緒。** 每個函式可以在任何執行緒呼叫，做完才回來。跨呼叫留下來的只有 session；每次呼叫各自開一個 Barretenberg 的介面（`barretenberg-rs` 的說明：一個介面只給一個執行緒用）。會算很久的（建樹、證明）由 app 放到背景的執行緒；建樹自己再開 4 個執行緒，證明由 Barretenberg 開和核心數一樣多的執行緒，都做完才回來。整個行程一次只算一個證明，第二個會等。

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
| `idc_list_consequence` | 持卡人改過的清單在每個平台上的後果（JSON），給確認的畫面（`spec/list-consequence.md`）。收 `config` 的 `platforms` 和 `card-state` 的回應（照後台送來的原樣）、app 有自己那一份的平台、持卡人的清單、裝置時鐘的現在；讀不懂的回應、清單裡不是提供改的平台，都是 `IDC_ERR_INPUT`。回傳卡片要簽的整份清單（交給 `idc_declaration_code`）和每一列，或不能簽的理由（`username`、`empty`、`switch_limit`、`daily_limit`）。形狀寫在標頭檔 |
| `idc_card_status` | 這張卡片的現況（JSON），給「你的帳號」那個畫面：上次過卡的日期和到今天幾天、今天是不是已經 3 筆、每個提供改的平台現在的帳號、上一次宣告的帳號、更換過幾次、還剩幾次、今天改是不是更正，以及裝置不認得的平台上原樣保留的帳號。輸入和讀法同 `idc_list_consequence`，算法是 `spec/list-consequence.md` 的「The card's state, as shown」。它不判斷任何一份清單收不收。讀不懂的回應是 `IDC_ERR_INPUT`，錯誤只有代碼。形狀寫在標頭檔 |
| `idc_short_id` | 匿名編號的短編號：文字形式的前 10 個字元（`spec/scoped-id.md`）。收查現況的請求裡那 52 個字元；不是唯一寫法的匿名編號是 `IDC_ERR_INPUT`。匿名編號本身只有 `idc_session_card_state_request` 算得出來 |
| `idc_session_*` | 一次過卡的檢查、「檢查都通過了」、查現況的請求、證明和送出的請求，見上面那一節的表。每一塊緩衝區由誰釋放寫在標頭檔每個函式的說明裡 |

## 套件和工具鏈

版本都釘死；套件的規則照 `CONTRIBUTING.md`「套件」。

- **Rust 1.99.1**（`rust-toolchain.toml`；2026-10-15 發布）。有 rustup 的機器在這個目錄下跑 `cargo` 就會用它
- **`barretenberg-rs` 6.0.0**（只開 `ffi`）：呼叫 Barretenberg。版本和 `web/` 釘的 `@aztec-foundation/bb.js` 相同（ADR-0034）
- **`sha2` 0.11.1**：SHA-256（宣告碼）。Noir `v1.0.0` 的 ACVM 用的也是這一版
- **`serde_json` 1.0.154**、**`serde` 1.0.229**（不開 `derive`）：讀 C 函式收到的 JSON，同一個鍵寫兩次的不收；多出來的鍵，帳號清單不收，後台的回應照 `docs/api/` 略過（`prover/src/json.rs`、`prover/src/server_state.rs`）；測試讀 `spec/vectors/`。Noir `v1.0.0` 的 `Cargo.lock` 裡也是這兩版，`serde` 本來就由 `barretenberg-rs` 帶進來
- `checks/` 的測試另外用 `sha2`、`serde_json`（只在測試）
- 上面幾個帶進來的套件和版本在 `Cargo.lock`（進版控）。建置一律加 `--locked`
- `prover/` 的 `[dev-dependencies]` 引用自己並開 feature `testing`（見「檢查都通過了」），`Cargo.lock` 裡因此多一行自己的名字，沒有多任何套件

- **`acvm` 1.0.0**、**`bn254_blackbox_solver` 1.0.0**（crates.io，2026-10-29 發布）：Noir `v1.0.0` 的 ACVM，解見證。版本和 `web/` 釘的 `@noir-lang/noir_js`、編 `web/circuits/` 的 Noir 相同（ADR-0034）。沒有用 `nargo`、`noirc_abi`：兩個電路都只有一個函式、不呼叫外面，參數怎麼排成見證在 `prover/src/witness.rs` 照電路檔的 `abi.parameters` 做，只認欄位、整數、布林和它們的陣列
- **`base64` 0.23.1**、**`flate2` 1.1.10**：電路檔的 `bytecode` 是 base64 包著的 gzip，ACVM 給的見證也是 gzip，Barretenberg 要沒壓縮的；送出的 `proof` 是 base64。這兩個本來就由 ACVM 帶進來，版本照 Noir `v1.0.0` 的 `Cargo.lock`
- ACVM 帶進來 116 個套件（橢圓曲線、msgpack、它支援但這兩個電路用不到的雜湊和簽章）。`Cargo.lock` 裡這些套件，Noir `v1.0.0` 的 `Cargo.lock` 有同一個相容版本的就用它的那一版，其餘用加進來當天最新的；每一個都發布滿 7 天

### Barretenberg 的靜態函式庫

`prover/` 連結的是 Aztec 在 [Barretenberg `v6.0.0` 的發布頁](https://github.com/AztecProtocol/barretenberg/releases/tag/v6.0.0)提供的 `barretenberg-static-<平台>.tar.gz`，裡面是 `libbb-external.a`。函式庫不進版控，進版控的是每個平台那一份的 SHA-256（`barretenberg.sha256`，取自發布頁）和下載的腳本：

```
./fetch-barretenberg.sh              # 這台機器的平台
./fetch-barretenberg.sh arm64-ios    # barretenberg.sha256 裡的任何一個平台
```

腳本下載、核對 SHA-256、解開到 `vendor/barretenberg/<平台>/`（`.gitignore` 排除），印出那個目錄。雜湊不對就停，不解開。

`crs.sha256` 是參數檔（Barretenberg 的通用參數）兩個檔的 SHA-256，和 `web/src/prover/artifacts.ts` 的相同；`prover/src/artifacts.rs` 寫死的就是這兩個值，測試會比。參數檔 8 MiB，不進版控；算證明的測試要它：

```
./fetch-crs.sh    # 下載到 vendor/crs/，核對 crs.sha256，印出那個目錄
```

和 `web/scripts/fetch-crs.mjs` 下載的是同樣兩個檔（Aztec 的 CDN，G1 只取前 2^18 個點）。app 帶的也是這兩個檔（ADR-0035）。

`barretenberg-rs` 的建置腳本在沒有設 `BB_LIB_DIR` 時會自己下載函式庫，而且不核對。所以 `.cargo/config.toml` 把 `BB_LIB_DIR` 預設成一個沒有函式庫的位置：忘了設的建置會停下來，不會去下載。建置時把它設成腳本印出來的目錄。

## 怎麼單獨建置和測試

需要 rustup、一個 C 編譯器（`cc`）、`curl`、`awk`。Linux 另外要 LLVM 的 libc++（Ubuntu：`libc++-dev`、`libc++abi-dev`），Barretenberg 的靜態函式庫是用它編的；macOS 內建。不需要手機、卡片、後台、Node、Go。

```
cd device-core
BB_LIB_DIR="$(./fetch-barretenberg.sh)" && export BB_LIB_DIR
./fetch-crs.sh
cargo fmt --check
cargo clippy --locked --release --all-targets -- -D warnings
cargo test --locked --release
```

只測不碰 Barretenberg 的一半（不用下載函式庫）：

```
cargo test --locked -p iamreal-device-checks
```

拉取請求的檢查（`.github/workflows/checks.yml` 的 `device-core`）在 Linux 上跑的就是上面那六行。

算出的證明另外拿 `bb` 和 Go 的 `verifier/` 驗一次：設 `IAMREAL_BB` 指到 `bb` 6.0.0 的執行檔（`verifier/README.md`），機器上要有 `go`。沒有設時這兩項不跑，測試會印一行說明；證明仍然由連結進來的 Barretenberg 驗。檢查裡的 `device-core` 不裝 `bb`，所以那裡不跑這兩項。

```
IAMREAL_BB=<bb 的路徑> cargo test --locked --release -p iamreal-device-core --test proof
```

### 測試讀什麼

測試讀 `spec/vectors/` 的標準答案，不複製，也不從另一種語言產生。

- `checks/tests/vectors.rs`（不需要 Barretenberg）：`challenge.json`（唯一的寫法、日期、`current_time` 和它的公開輸入、亂數的位元組）、`scope.json`（兩個場合字串和打包值、每份名冊收和不收的平台、帳號名稱照它的平台的格式）、`declaration-code.json`（原文、SHA-256、宣告碼、打包值）、`scoped-id.json`（文字寫法、短編號、讀不懂的寫法、網址裡的短編號）
- 沒有讀的：`poseidon2-constants.json`（Poseidon2 的置換是 Barretenberg 的，這裡沒有自己實作）
- `prover/tests/vectors.rs`：`poseidon2.json` 的 `hash_2`、`hash_3`（Barretenberg 的 Poseidon2），和 `scoped_id`（簽章切出的 18 段、串起來的匿名編號）
- `prover/tests/c_api.rs`：C 函式，照 app 呼叫的方式（指標、長度、`idc_buf`、代碼）。場合字串和宣告碼對 `scope.json`、`declaration-code.json`；每一種讀不懂的輸入、`NULL`、代碼不是 `IDC_OK` 時 `idc_buf` 是空的
- `checks/tests/roster_rules.rs`（不需要 Barretenberg）：`roster-rules.json` 的每一案，一筆一筆經過 `MemoryRules`，比對每一筆的結果和最後的現況；`RULES_VERSION` 和 `spec/roster-rules.md` 寫的、標準答案帶的版本號相同
- `prover/tests/c_list_consequence.rs`：`idc_list_consequence`，照 app 呼叫的方式。`list-consequence.json` 的每一案（讀平台表、讀現況、每一列）；`roster-rules.json` 裡走到第 5、6 項的每一筆，用它前面的現況當 `card-state` 的回應，後果和標準答案相同；只有 C 函式才有的：清單的形狀、同一個鍵寫兩次、裝置的時區、`NULL`
- `prover/tests/c_card_status.rs`：`idc_card_status`，照 app 呼叫的方式。`card-status.json` 的每一案，結果和標準答案相同；`list-consequence.json` 裡每一個讀不懂的回應都不收；只有 C 函式才有的：認得的平台的形狀、時鐘、`NULL`
- `prover/tests/c_short_id.rs`：`idc_short_id`。`scoped-id.json` 每一個匿名編號的短編號，和不是唯一寫法的都不收
- `checks/tests/device_checks.rs`（不需要 Barretenberg）：`device-checks.json` 選憑證和檢查憑證的每一案（選到哪一張、發證者、序號、卡片的模數、兩個日期、姓名，或原因代碼）、`L`；`issuers.json`（寫死的兩把發證金鑰）；`crl/testdata/` 的每一份清冊可不可用、原因代碼、編號、清冊日期和 `expected.json` 相同；`crl/testdata/times/` 的每一份（時間的各種寫法）哪些收、哪些是 `not_usable_der`，收的 `thisUpdate` 和清冊日期和 `times/expected.json` 相同
- `prover/tests/tree.rs`：`poseidon2.json` 的 `revocation_tree`、`revocation-tree.json`（整份清冊的樹根，每個序號的路徑或「在樹裡」）、`crl/testdata/` 每一份可用清冊的樹根。每一案都用 4 個執行緒建，也分 1、2、4 份各建一次，結果相同。`revocation-tree.json` 就是 `iamreal-crl prove` 印出來的（`cmd/iamreal-crl/vectors_test.go` 讀同一份）
- `prover/tests/session.rs`：從 C 函式走。`device-checks.json` 的憑證、索引、清冊每一案，結果的 JSON 和標準答案相同；`circuit-inputs.json` 的每一案走完四步，查現況的請求裡的匿名編號和標準答案的公開輸入相同；少任何一步、重做前面的步驟、檔案的雜湊不對、簽章不是這張卡片對這個場合字串簽的、日期不是通過的那一天，都拿不到匿名編號；換了日期再核一次，憑證過期、還沒生效、清冊太舊各停在對應的原因代碼；app 開的 session 不認測試金鑰。電路檔和驗證金鑰用這個程式庫裡的（`web/circuits/`、`verifier/vk/`），寫死的雜湊對它們和 `crs.sha256`；參數檔 8 MiB 不在程式庫裡，四步走完的案例用兩個短檔和它們的雜湊代替；`idc_testing_session_open`（feature `test-issuers`）：給它標準答案的測試金鑰，測試憑證通過第一步；不是金鑰清單的輸入、正式名冊都不開
- `prover/tests/no_values_in_errors.rs`：把一段記號寫進憑證、清冊、索引、`config`、記住的編號（各幾種寫法），走 C 函式，所有停下來的答案和錯誤裡都找不到那段記號
- `prover/tests/quiet.rs`：核心裡的 panic 什麼都不印（另開一個行程，讀它印出來的東西）
- `checks/tests/circuit_inputs.rs`（不需要 Barretenberg）：`circuit-inputs.json` 每一案的每一個電路輸入，和預期的公開輸入（匿名編號取標準答案的，它要 Poseidon2）
- `prover/tests/witness.rs`：`circuit-inputs.json` 每一案的輸入，`web/circuits/` 的電路都解得出見證；改掉任何一項（日期、宣告碼、場合字串、簽章、樹根、路徑、憑證、發證金鑰）就解不出來
- `prover/tests/proof.rs`：從 C 函式走，算真的證明。`circuit-inputs.json` 的每一案走完四步、拿查現況的請求、算證明：請求的每一個欄位、匿名編號和標準答案相同；證明配上標準答案的 `public_inputs` 驗得過，改掉後五個公開輸入的任何一個就驗不過；設了 `IAMREAL_BB` 時再用 `bb verify` 拿 `verifier/vk/` 的金鑰驗，並執行 Go 的 `go test ./verifier -run TestDeviceCoreRequests`（`verifier/device_core_test.go`），它把每個請求當成一筆紀錄，照 `spec/proof-verification.md` 重建公開輸入來驗。少任何一步、檔案的雜湊不對、簽章不是這張卡片對這份清單和這個題目簽的、題目的日期上檢查不成立，都拿不到證明。算證明時 stderr 沒有任何輸出；Barretenberg 的執行緒數在算完之後等於核心數。帳號和題目取自 `declaration-code.json` 裡宣告碼相同的那一案
- `prover/tests/c_link.rs`：用 `cargo build` 編出靜態函式庫，拿 `include/iamreal_device_core.h` 編 `prover/tests/smoke.c`、連結、執行。標頭檔和函式庫對不上、函式庫裡沒有對外的函式時，這一個會失敗

## 連結 Barretenberg 時要注意的

[#88](https://github.com/iamreal-tw/iamreal/issues/88) 量測時碰到的三件事：

- **`strip = "symbols"` 會把靜態函式庫對外的函式也拿掉。** `Cargo.toml` 的 release 設定用 `strip = "debuginfo"`；符號由 app 自己的連結去掉。`panic = "unwind"` 也不能改：C 函式靠它接住 panic
- **Barretenberg 的執行緒數由核心設定**，不留給它自己決定：量測時（[#88](https://github.com/iamreal-tw/iamreal/issues/88)）它自己決定的數字在 Mac 上偏低，證明慢 2 到 3 倍；寫這一段時在另一台 Mac 上沒有重現（沒設定時就是核心數），核心照樣自己設，不靠它的預設。核心在每次算證明之前，在算證明的那個執行緒上把它設成 `std::thread::available_parallelism()`（`prover/src/proof.rs`）。Barretenberg 的這個數字是每個執行緒各自的：它第一次用到時讀環境變數 `HARDWARE_CONCURRENCY`，沒有就用 `min(32, 核心數)`（`common/thread.cpp`）。核心不改環境變數（行程裡別的執行緒可能正在讀），直接呼叫 `bb::set_parallel_for_concurrency`；`bbapi` 的介面沒有這一項，所以是用 C++ 的符號名稱連結的，換 Barretenberg 的版本時這個名稱不在了，連結會失敗，不會悄悄失效
- **Android 的 libc++。** Aztec 給 Android 的靜態函式庫用的是 LLVM 的 libc++（`std::__1`），NDK 的是 `std::__ndk1`，兩者連結不起來；量測時用 Aztec 編 Barretenberg 的同一版 Zig 連結，把 libc++ 靜態連進 `.so`。Android 的建置照這個做（`android/build-native.sh`、`android/README.md`「原生的函式庫」）

Linux 的靜態函式庫同樣要 LLVM 的 libc++（不是 GCC 的 libstdc++），所以上面要裝 `libc++-dev`。檢查裡裝的是 Ubuntu 24.04 套件庫當時的版本，沒有釘：它只在 Linux 上跑測試時用到，不進 app。

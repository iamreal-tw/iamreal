# web/：網頁版的過卡引擎

**這個目錄讓人檢查的事：憑證、公鑰、簽章、PIN 沒有離開持卡人的裝置。** 這裡是從「讀到卡片上的憑證」到「送出證明」之間，在持卡人的瀏覽器裡做的每一件事，寫成不含畫面的程式庫。畫面和內政部元件的橋接是下一份工作，會建在這一層上面。

程式照 `spec/` 和 `docs/api/card-proof.md` 實作，不引用 `server/`。裝置上的保護照 ADR-0015、ADR-0016：保護持卡人、對抗伺服器的限制寫死在這裡，伺服器只能讓它更嚴。

## 每個值從哪裡來、送到哪裡去

| 值 | 從哪裡來 | 送到哪裡 |
|---|---|---|
| 憑證（含姓名、序號、公鑰） | 卡片（`Card.readCertificates`，不用 PIN） | 不送出。姓名只回給呼叫的程式顯示；序號只進建樹的 worker；整張憑證只進證明的私有輸入。送出後位元組清成 0 |
| PIN | 呼叫的程式（`confirmCard(pin)`） | 只交給卡片。存在記憶體裡到第二次簽章完成或流程停下為止。JavaScript 的字串不能清成 0，做得到的是不再持有它的參照 |
| 卡片的兩個簽章 | 卡片（`Card.sign`） | 只進證明的私有輸入。場合字串的簽章在裝置上算成匿名編號。送出後位元組清成 0 |
| 匿名編號 | 裝置自己算（`spec/scoped-id.ts`） | `POST /api/v1/card-state` 的內容（不放網址）；紀錄 |
| 場合字串 | 寫死的對照表（`src/spec/scope.ts`），由持卡人選的平台決定 | 卡片簽；紀錄 |
| `current_time` | 裝置的時鐘，絕對時間換成 UTC+8 的日期（`src/spec/date.ts`），不用裝置設定的時區 | 證明的公開輸入 |
| 失敗的原因 | 裝置自己的檢查 | 只回給呼叫的程式（`FlowStop`）。沒有任何請求帶著它，也不寫進任何紀錄（`test/flow.test.ts` 每一個失敗的測試都檢查） |

## 從伺服器拿到的值，裝置怎麼檢查（ADR-0016 落到程式上）

| 值 | 從哪裡拿 | 裝置怎麼檢查 | 程式 |
|---|---|---|---|
| 題目 | `POST /api/v1/challenges` | 整個字串符合唯一寫法（格式、字母表、最後一個字的補位是 0、日期存在、年份 2000 到 2049）；日期是裝置時鐘的台灣今天，否則停下，卡片不簽第二次。`current_time` 用裝置自己的日期 | `src/spec/challenge.ts`、`src/flow.ts` 的 `proceed` |
| 清冊可以多舊 `crl_max_age_days` | `GET /api/v1/config` | 非負整數；`L` = 它和內建的 7 取小（伺服器回 365 也只用 7）；讀不懂就停 | `src/api.ts` 的 `requestCrlMaxAge`、`src/crl/revocation.ts` 的 `crlMaxAge` |
| 存檔索引 | `/crl/index.jsonl` | 只用來找檔案：自己那把發證金鑰、可用、`crl_number` 最高的那一行的 `sha256`。樹根、日期等其他欄位都不讀。編號最高的有兩個不同檔案時停下 | `src/crl/revocation.ts` 的 `chooseFromIndex` |
| 廢止清冊 | `/crl/SHA256.crl` | 檔案的 SHA-256 等於檔名；嚴格的 DER；用寫死的發證金鑰（WebCrypto）驗內政部的章；「Which CRLs」的每一條，原因代碼和順序和 `crl/` 相同；編號不低於這台裝置記住的最高編號；台灣今天減清冊日期不超過 `L` 天；樹自己建 | `src/crl/crl.ts`、`src/crl/revocation.ts`、`src/crl/tree.ts` |
| 這張卡片的現況 | `POST /api/v1/card-state` | 格式（帳號照場合的格式、日期、`head` 64 個十六進位數字）。這次宣告會是哪一種、還剩幾次更換、下一次可以更換是哪天，由裝置從這些事實和今天的日期自己算（`spec/roster-rules.md`）。事實本身沒辦法檢查，見「已知的限制」 | `src/api.ts` 的 `requestCardState`、`src/spec/roster-rules.ts` |
| 收回時的帳號 | 上一列的 `current` | 照場合的帳號格式。收回不輸入帳號，所以宣告碼裡的帳號由伺服器的回答決定。伺服器換一個帳號，認不出持卡人：它已經知道這個匿名編號（是裝置剛送的），換帳號只會讓卡片簽一個收回別的帳號的宣告碼，而這張卡片目前宣告的不是那個帳號，紀錄會被名冊規則判 `not_current`，後台不會寫入，重驗的人也會判它無效。持卡人得先看到這個帳號：`proceed(帳號)` 要呼叫的程式傳回畫面上顯示、持卡人確認過的帳號，和現況的 `current` 不同就停，卡片不簽第二次 | `src/flow.ts` 的 `confirmCard`、`proceed` |
| 什麼時候向後台查現況 | （裝置決定） | 不需要簽章就能做的檢查全部通過之後，卡片才簽第一次、裝置才帶著匿名編號查現況：憑證的預先檢查、清冊下載並驗過、樹建完、序號不在樹裡、電路檔和通用參數的雜湊對。否則後台會看到「這個匿名編號查過現況、之後沒有下文」，能和它的鏡像給的清冊對起來（ADR-0015、ADR-0016）。檢查還沒完成時 `phase` 是 `checking`，畫面不顯示 PIN 欄位；`checksDone()` 通過後是 `ready_for_pin`。`confirmCard` 自己也先等這些檢查 | `src/flow.ts` 的 `startBackground`、`checksDone`、`confirmCard` |
| 電路 | `/circuits/card_proof_rs2048.json`、`card_proof_rs4096.json` | SHA-256 寫死（`circuits/README.md`）；不同就停，在卡片簽章之前 | `src/prover/artifacts.ts` |
| 通用參數 | `/crs/bn254_g1_compressed_2p18.dat`、`/crs/bn254_g2.dat` | SHA-256 寫死；核對過才交給 bb.js | `src/prover/artifacts.ts`、`src/prover/engine.ts` |
| 送出的結果 | `POST /api/v1/records` | 格式（`seq`、`record_hash`、`kind`）；只顯示 | `src/api.ts` 的 `submitRecord` |
| 錯誤代碼 | 每個介面 | 只收 `[a-z_]{1,40}`，其他寫成 `http_狀態碼`；只回給呼叫的程式。送出時，沒有回應、`429`、`crl_stale` 以外的 5xx（`internal`）可以用 `resubmit()` 原封不動再送；其他代碼（包括 `503` `crl_stale`）結束流程 | `src/api.ts`、`src/flow.ts` 的 `submit` |

**寫死在頁面裡的**：場合字串的對照表和這一階段用的名冊（`ROSTER = "test"`，`src/index.ts`）、G2 和 G3 的發證金鑰（`src/issuers.ts`，和 `spec/vectors/issuers.json`、`crl/` 的憑證檔比對過）、電路和通用參數的 SHA-256、內建的 7 天、證明的設定（零知識、`noir-recursive`，`src/prover/prover.ts`）、證明的執行緒上限。

**頁面本身**（HTML、JavaScript、bb.js 和 Noir 的 WebAssembly）和 API 從同一台伺服器來。這些檔案是同一次建置的產物，沒有另外核對；ADR-0016 的「代價」寫明了這個前提：用的頁面就是公開的這一份。

## 停止的原因

流程停下來時丟出 `FlowStop`，`stop` 是下表的一種（`src/flow.ts` 的 `Stop`）。每一種都要讓畫面顯示一句話；文字在 `design/copy/card-proof.md`，這裡只對到那份文件的列，沒有對應列的標「待補文字」。這些原因都只給呼叫的程式，不送給伺服器。`flow.stop` 是 `null` 的（PIN 錯、送出時的暫時失敗）可以重試同一步，其他的結束這次流程。

| `code` | 細項 | 什麼情況 | `design/copy/card-proof.md` 的哪一列 |
|---|---|---|---|
| `card` | `component_unreachable` | 連不上內政部的元件 | 2.「連不上元件」 |
| `card` | `no_card` | 讀卡機裡沒有卡片 | 2.「沒有卡片」 |
| `card` | `pin_incorrect` | PIN 錯（可以重試） | 2.「PIN 不正確」 |
| `card` | `card_locked` | 卡片鎖住了 | 待補文字 |
| `card` | `card_error` | 卡片或元件回了其他錯誤 | 待補文字 |
| `certificate` | `no_certificate` | 卡片沒有回任何憑證 | 待補文字 |
| `certificate` | `expired`（附 `notAfter`，台灣日期） | 憑證在今天之前到期 | 2.「憑證過期」 |
| `certificate` | `not_yet_valid` | 憑證還沒生效 | 待補文字 |
| `certificate` | `not_citizen_primary` | 憑證政策或主體目錄屬性不是國民正卡的（外來人口、附卡、行動自然人憑證、政策不同） | 2.「不是國民的正卡」 |
| `certificate` | `unsupported_format` | 電路的走法在其他地方不過 | 2.「憑證的格式電路不接受」 |
| `certificate` | `unknown_issuer` | 不是 G2、G3 簽發的 | 待補文字 |
| `certificate` | `ambiguous_certificate` | 卡片上有兩張不同的憑證都通過 | 待補文字 |
| `revocation` | `crl_stale`（附天數、`L`） | 清冊比 `L` 天舊 | 2.「廢止清冊太舊」 |
| `revocation` | `crl_unavailable` | 索引或清冊拿不到；索引沒有可用的行；編號最高的有兩個不同檔案 | 待補文字 |
| `revocation` | `crl_hash` | 清冊的 SHA-256 不是檔名 | 待補文字 |
| `revocation` | `crl_unusable`（附原因代碼） | 清冊不可用（章不對、分段、差異清冊……） | 待補文字 |
| `revocation` | `crl_rollback` | 清冊編號比這台裝置用過的低 | 待補文字 |
| `revoked` | | 序號在清冊上（廢止或暫時停用） | 2.「在廢止清冊上」 |
| `artifact` | 檔案路徑 | 電路檔或通用參數拿不到，或 SHA-256 不對 | 待補文字 |
| `engine` | | 證明引擎無法啟動或算不出證明 | 待補文字 |
| `card_signature` | | 卡片回的簽章用憑證的公鑰驗不過 | 待補文字 |
| `challenge_malformed` | | 題目不是唯一寫法 | 待補文字 |
| `challenge_not_today` | 題目的日期、今天 | 題目的日期不是裝置的台灣今天 | 2.「電腦的日期和題目的日期不同」 |
| `blocked` | `switch_limit` | 更換次數用完 | 3.「更換次數用完」（只有取消） |
| `blocked` | `not_current` | 收回，但這張卡片目前沒有宣告 | 收回的 3.「目前沒有宣告」（只有取消） |
| `proof_check` | | 證明不是 14,656 個位元組，或公開輸入和裝置重建的不同 | 待補文字 |
| `server` | `network`、`internal`、其他 5xx、`rate_limited`（送出時，可以重試） | 送出沒有到達或後台暫時失敗 | 4.「送不出去」 |
| `server` | `challenge_unknown` | 題目過期或不是這台後台發的 | 4.「停太久，題目過期」 |
| `server` | `scope`、`malformed`、`challenge_used`、`challenge_attempts`、`proof`、`crl_stale`、`root`、`date_order`、`not_current`、`switch_limit` | 後台沒有接受這份紀錄 | 4.「後台沒有接受」（顯示代碼） |
| `server` | 要題目、查現況、讀設定時的任何代碼；`malformed_response`；`not_found`、`method_not_allowed`；`http_狀態碼` | 後台沒有回答，或回答讀不懂 | 待補文字 |
| `username` | | 輸入的帳號不符合場合的格式 | 待補文字（畫面 1 輸入時就該擋下） |
| `state` | | 呼叫的程式步驟順序錯，或 `proceed` 傳的帳號不是畫面該顯示的那一個 | 不給持卡人看（程式錯誤） |

## 唯一存進瀏覽器的東西

每把發證金鑰用過的最高清冊編號：`localStorage` 的 `iamreal.highest_crl_number.G2`、`iamreal.highest_crl_number.G3`，值是十進位的編號（`src/storage.ts`）。憑證、簽章、PIN、匿名編號、帳號名稱都不存。

bb.js 平常會把通用參數存在 IndexedDB；這裡不用 bb.js 自己的下載（`skipSrsInit`），所以它不會存。無頭瀏覽器的測試在流程跑完後檢查：`localStorage` 只有清冊編號，`sessionStorage`、IndexedDB、Cache Storage、cookie 都是空的。

## 頁面需要的 `Content-Security-Policy`

伺服器送這個標頭。頁面只能連自己的網域；套件被動了手腳，瀏覽器也不讓它把東西送到別處。

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

- `'wasm-unsafe-eval'`：bb.js 和 Noir 要編譯 WebAssembly。
- `worker-src 'self'`：建樹的 worker 和 bb.js 自己的 worker 都是同一個網域的檔案。
- bb.js 原本把 WebAssembly 包成 `data:` 網址、把通用參數從 Aztec 的 CDN 下載。建置時把 WebAssembly 寫成檔案（`vite.config.ts`），通用參數改從自己的網域拿，所以 `connect-src` 只要 `'self'`。
- 下一份工作加上畫面和內政部元件的彈出視窗時，這份要跟著看（樣式、元件在 `localhost` 的視窗）。
- 多執行緒要頁面是跨來源隔離的：另外送 `Document-Isolation-Policy: isolate-and-credentialless`（Chromium 系的桌機版）。其他瀏覽器忽略它，證明用 1 個執行緒。

無頭瀏覽器的測試在這份標頭之下跑完整條流程，並檢查沒有任何違反（`securitypolicyviolation`），伺服器也沒有收到它不認得的請求。測試也檢查這份 README 引用的標頭和測試用的一字不差（`test/e2e/headers.ts`）。

## 怎麼單獨執行和測試

需要 Node 22（22.6 以上）、pnpm 10。

```
cd web
pnpm install --frozen-lockfile
pnpm fetch-crs        # 下載通用參數到 crs/（不進版控），核對 SHA-256
pnpm typecheck
pnpm test             # Node 裡的測試，約 10 秒
IAMREAL_BB=/path/to/bb pnpm test:e2e     # 無頭的 Chrome，約 2 分鐘
```

- `pnpm fetch-crs` 是這個目錄唯一對外的連線：從 `https://crs.aztec-cdn.foundation/` 下載 2^18 個點的 `g1_compressed.dat` 開頭 8 MiB（SHA-256 `5107a7926d504236331b4872b7218a1ca18921b5358d894822576e1aeb684934`）和 `g2.dat`（128 個位元組，`01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f`）。G1 的雜湊和 `bb` 自己下載、檢查過的兩份副本相同；G2 從 Aztec 的兩個網域下載的相同。頁面執行時從自己的網域拿這兩個檔案。
- `IAMREAL_BB` 是 `bb` 6.0.0（取得方式見 `verifier/README.md`）。`CHROME` 可以指定 Chrome 的路徑，預設是 macOS 的 Google Chrome。
- `pnpm test:e2e` 後面可以接設定，例如 `G3-dip G3-none G2-dip G3-dip-t4`：發證金鑰的大小、頁面是否跨來源隔離、證明的執行緒上限。

### Node 裡的測試（`pnpm test`）

| 檔案 | 測什麼 |
|---|---|
| `test/spec.test.ts` | `spec/vectors/` 的 `challenge.json`、`scope.json`、`declaration-code.json`、`scoped-id.json`、`issuers.json`（加上 `crl/` 的兩張發證憑證）、`roster-rules.json`（每個案例重播事件，每一筆宣告和收回事先算出的種類和結果相同）。標準答案直接讀那些檔案，不複製 |
| `test/crl.test.ts` | `spec/vectors/poseidon2.json`（`hash_2`、`hash_3`、匿名編號、廢止清冊的樹和「不在樹裡」的證明，分 1、2、4 份建）；`crl/testdata/` 的每一份清冊，可不可用、原因代碼、編號、清冊日期、樹根都和 `crl/testdata/expected.json`（Go 的結果）相同；分份建樹和一次建的結果相同；索引怎麼選 |
| `test/certificate.test.ts` | 照電路的走法預先檢查憑證：國民正卡通過；加密用憑證被跳過；過期（含到期日當天最後一秒）、還沒生效、外來人口、`cardHolderRank`、4096 位元的卡片金鑰、發證者名稱太長、金鑰用途不在第三個、不是兩把發證金鑰簽的，各自回對應的原因 |
| `test/flow.test.ts` | 伺服器或鏡像給了不該接受的值，每一個都停下來，之後沒有請求，沒有請求帶著原因：日期不是今天的題目、寫法不唯一的題目（6 種）、章不對的清冊、舊於 `L` 天的清冊、`/api/v1/config` 回 365、編號比記住的低的清冊、分段的清冊、索引指到不存在的檔案、內容和檔名的雜湊不符的清冊、雜湊不對的電路檔、序號在清冊上。另外：卡片簽的場合字串只來自對照表；更換用完時卡片不簽第二次、不要題目；收回的帳號；格式不對的現況；公開輸入和裝置自己重建的不同時不送出；過期的憑證在任何請求之前停下；PIN 錯可以重試。序號在清冊上、清冊不可用、電路檔或通用參數雜湊不對時（包括 PIN 在檢查完成前就交進來），卡片沒有被要求簽章，也沒有 `card-state` 的請求；`phase` 從 `checking` 到 `ready_for_pin`；`proceed` 傳的帳號不是現況的帳號時不簽第二次；`crl_stale` 結束流程，`internal` 可以原封不動再送 |

### 無頭瀏覽器的測試（`pnpm test:e2e`）

`test/e2e/run.ts` 用 Vite 建置測試頁（`test/e2e/`），在 127.0.0.1 上帶著上面的 CSP 提供頁面和一個照 `docs/api/card-proof.md` 回答的假伺服器，開無頭的 Chrome、全新的設定檔，用假卡片跑兩次過卡（同一次頁面載入、同一個證明引擎）。清冊是自製的，大小接近內政部的（G3 176,000 筆、G2 340,000 筆）。跑完檢查：

- 兩次都送出了，伺服器收到的紀錄就是頁面回報的；
- 從紀錄的欄位重建公開輸入，用原生的 `bb verify -t noir-recursive` 和 `verifier/vk/` 的驗證金鑰驗得過；改一個公開輸入就驗不過；
- `crossOriginIsolated`、引擎的執行緒數和 bb.js 自己說開的相同；
- 沒有違反 CSP，伺服器沒有收到它不認得的請求；
- 瀏覽器的儲存空間只有清冊編號。

測試的發證金鑰不是內政部的，所以這裡只驗證明本身；和真的後台對接是之後的整合工作。

### 假卡片

`src/card/fake.ts`：測試金鑰簽發的憑證（簽章用和加密用各一張，結構和國民正卡相同，做法照電路測試的 `cert.mjs`，在 `test/fixtures/certs.ts`）和對應的私鑰。`src/index.ts` 不匯出它。

## 時間

M1 Max（10 核）、Chrome 157 無頭模式，`pnpm test:e2e` 量的（2026-11-16）。「建樹」是 4 個 worker 從清冊的鍵建到自己的路徑；「證明」是見證加 UltraHonk 證明。同一次載入的第一次和第二次過卡用斜線分開。

| | 引擎初始化 | 建樹 | 證明 | 整次過卡（假卡片，不含人） |
|---|---|---|---|---|
| G3，跨來源隔離，8 個執行緒（上限） | 1.7 到 1.8 秒 | 2.8 / 2.5 秒 | 2.9 / 2.4 秒 | 6.4 / 5.3 秒 |
| G3，跨來源隔離，10 個執行緒 | 1.8 秒 | 2.9 / 2.5 秒 | 3.2 / 2.6 秒 | 6.7 / 5.6 秒 |
| G3，跨來源隔離，4 個執行緒 | 1.9 秒 | 2.6 / 2.5 秒 | 3.8 / 3.4 秒 | 7.0 / 6.3 秒 |
| G3，沒有隔離（1 個執行緒） | 4.1 到 4.5 秒 | 2.5 / 2.5 秒 | 9.3 / 9.0 秒 | 13.9 / 11.9 秒 |
| G2，跨來源隔離，8 個執行緒（上限） | 2.1 秒 | 5.1 / 4.7 秒 | 2.4 / 2.0 秒 | 8.6 / 7.6 秒 |
| G2，沒有隔離（1 個執行緒） | 4.2 到 5.0 秒 | 4.8 / 4.8 秒 | 8.0 / 7.7 秒 | 13.9 / 13.3 秒 |

- 引擎初始化從頁面開始算，大部分是把壓縮的通用參數展開（單執行緒約 3.9 秒）。它在進頁面時就開始，和讀卡、建樹同時進行。展開後的參數不存起來（見上面「唯一存進瀏覽器的東西」），所以每次載入都重做。
- 證明的執行緒上限是 8（`MAX_PROOF_THREADS`，`src/prover/engine.ts`）：這台電腦上多於 8 個沒有更快，少於 8 個變慢。每一格只量一次，只有這一台電腦。
- 頁面不是跨來源隔離時 bb.js 不報錯、安靜地用 1 個執行緒；引擎自己看 `crossOriginIsolated` 和 `SharedArrayBuffer` 決定，並把 bb.js 自己說開的執行緒數一起告訴呼叫的程式（`ThreadMode`）。

## 檔案

| 檔案 | 內容 |
|---|---|
| `src/index.ts` | 頁面的入口：`startEngine()`（進頁面就呼叫）、`createCardProof()`。寫死發證金鑰、場合的名冊、同網域的 fetch、時鐘、儲存 |
| `src/flow.ts` | 過卡的狀態機：`readCard` → `checksDone` → `confirmCard(pin)` → `proceed(帳號)` → 完成；`resubmit`、`cancel`；`phase` 說現在在哪一步。宣告和收回 |
| `src/spec/` | 規格裡的算法：base32、題目、日期、場合字串、宣告碼、匿名編號、名冊規則的事先計算 |
| `src/certificate.ts`、`src/der.ts` | 讀憑證、照電路的走法預先檢查、選出要用的那一張、驗發證金鑰的章 |
| `src/issuers.ts` | G2、G3 的發證金鑰，WebCrypto 的 RSA 驗章 |
| `src/crl/` | 讀清冊並判斷可不可用、從鏡像找清冊並檢查、樹、建樹的 worker |
| `src/prover/` | 證明引擎（bb.js、Noir）、電路的輸入、電路和通用參數的雜湊 |
| `src/api.ts` | 和後台之間的請求，嚴格讀回應 |
| `src/card/` | 卡片的介面和假卡片 |
| `src/storage.ts` | 唯一的儲存：清冊編號 |
| `circuits/` | 編譯好的電路，見裡面的 `README.md` |
| `scripts/` | 下載通用參數、從 `nargo` 的輸出寫出 `circuits/` 的檔案 |
| `test/` | 測試；`test/fixtures/` 是測試金鑰做的憑證、清冊和假伺服器 |

執行時的依賴只有 `@aztec-foundation/bb.js` 6.0.0 和 `@noir-lang/noir_js` 1.0.0（和電路的程式庫釘的相同）。開發用的只有 Vite、TypeScript 和 `@types/node`。全部是精確版本，`pnpm-workspace.yaml` 設了不安裝發布未滿 7 天的版本。沒有介面框架；DER 自己解析。

## 已知的限制

- **名冊上的現況照後台說的顯示，不檢查。** 後台謊報（宣告的是 @bob 卻說沒宣告過）會讓持卡人不知情地用掉一次更換。要擋得下載整份名冊自己算，太重。後台從這裡查不出持卡人是誰，謊報會被名冊上的紀錄揭穿。
- **清掉瀏覽器資料後，清冊編號的保護退回「清冊不能舊於 `L` 天」。** 換一個瀏覽器、無痕視窗也一樣。
- **頁面和 API 從同一台伺服器來時，這些檢查擋不住營運者本人**：改過的頁面可以不做這些檢查（ADR-0016）。
- PIN 是 JavaScript 的字串，沒辦法清成 0；做得到的是第二次簽章後（或流程停下時）不再持有它。
- 只在 macOS 上的 Chrome 測過。Safari、Firefox、手機沒有跑過這裡的測試。

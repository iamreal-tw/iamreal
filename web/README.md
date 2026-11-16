# web/：網頁版的過卡

**這個目錄讓人檢查的事：憑證、公鑰、簽章、PIN 沒有離開持卡人的裝置。** 這裡是從「讀到卡片上的憑證」到「送出證明」之間，在持卡人的瀏覽器裡做的每一件事：過卡的引擎（`src/`，不含畫面）、內政部元件的橋接（`src/card/hipki.ts`）、過卡的畫面（`src/ui/`）。

程式照 `spec/` 和 `docs/api/card-proof.md` 實作，不引用 `server/`。裝置上的保護照 ADR-0015、ADR-0016：保護持卡人、對抗伺服器的限制寫死在這裡，伺服器只能讓它更嚴。

## 在本機用真卡片過卡

需要 Node 22（22.6 以上）、pnpm 10、Go 1.26、`bb` 6.0.0（取得方式見 `verifier/README.md`）、讀卡機和內政部的元件（HiPKI，`http://localhost:61161`）。

```
cd web
pnpm install --frozen-lockfile
IAMREAL_BB=/path/to/bb pnpm local          # 可加 --port 8080、--data <目錄>
```

`pnpm local`（`scripts/local.ts`）依序：通用參數不在就下載（`pnpm fetch-crs`）、建置正式的頁面（`vite build --mode production`：內政部的發證金鑰、元件在 `http://localhost:61161`）、建置後台（不帶測試的建置標籤）、跑一次清冊鏡像（抓內政部真的 G2、G3 清冊）、用測試的名冊啟動後台並提供頁面，在 `http://localhost:8080/`。按 Ctrl-C 停止。名冊、清冊、後台的執行檔在 `web/local/`（不進版控）；刪掉這個目錄就從空的名冊重來。

用桌機的 Chrome 開 `http://localhost:8080/`。`localhost` 是瀏覽器認定的安全來源，不需要 HTTPS：在後台送的標頭之下，頁面是跨來源隔離的（多執行緒），也能和元件的視窗來回（2026-11-16 在這台 Mac 的 Chrome 157 實測，只送 `CheckEnvir`：`test/e2e/check-component.ts`）。Safari、Firefox 忽略 `Document-Isolation-Policy`，證明用 1 個執行緒；這一頁沒有在它們上面測過。

確認頁面本身沒問題、但還不想插卡時：`node --experimental-strip-types test/e2e/smoke.ts http://localhost:8080/` 用無頭 Chrome 開到第一個畫面為止（不按「讀取卡片」，元件不會收到任何請求），檢查標頭、跨來源隔離、證明引擎啟動、沒有違反 CSP、沒有連到別的網域。

## 畫面和引擎怎麼分層

| 層 | 檔案 | 做什麼 | 不做什麼 |
|---|---|---|---|
| 畫面 | `src/ui/` | `design/copy/card-proof.md` 的六節、三次點擊；把停止原因、這張卡片的現況和選了之後的後果對到 `design/copy/card-proof.json` 的句子（`messages.ts`）；在點擊裡開元件的視窗，被擋時不往下做 | 不檢查任何東西、不碰憑證和簽章的位元組；沒有自己的句子（`test/copy.test.ts` 檢查 `src/ui/` 和 HTML 裡沒有中日韓文字） |
| 引擎 | `src/flow.ts`、`src/index.ts` 和其他 | 全部的檢查、何時讓卡片簽、何時查現況、每個選項是哪一種、拒絕不能做的選項、PIN 留多久、算證明、送出 | 不知道有畫面 |
| 卡片 | `src/card/card.ts` 的介面；`hipki.ts`（元件）、`fake.ts`（測試金鑰） | 讀憑證（不用 PIN）、簽 31 個位元組（要 PIN），簽章附上實際簽章的憑證 | 不判斷憑證能不能用 |

畫面的文字在 `design/copy/card-proof.json`，是 `design/copy/card-proof.md` 的句子照畫面分組、例子換成 `{名稱}`。`test/copy.test.ts` 兩個方向都比：JSON 的每一句代入 Markdown 的例子後，在 Markdown 裡一字不差；Markdown 的每個畫面（程式碼區塊）和表格裡畫面寫的每一格，都由 JSON 的句子組成、沒有剩下的字。文件裡沒有的句子，畫面只顯示代碼（見「停止的原因」）。唯一不在那份 Markdown 裡的是說明頁的「待補」。

說明頁（「怎麼準備」「了解更多」「怎麼重驗」）是 `help.html?topic=…`，只有標題和「待補」，在新分頁開：離開這一頁，過卡就中斷了。

## 流程

先確認卡片，再選要做的事，最後才宣告（`docs/design/principles.md`「輸入 PIN 之前的畫面」）。三次點擊，每次開一次元件的視窗。

| `card-proof.md` | 畫面 | 點擊 | 引擎（`src/flow.ts`） |
|---|---|---|---|
| 1. 輸入 PIN 之前 | 平台、PIN 用來做什麼、什麼留在這台電腦 | 讀取卡片（開視窗） | `readCard()`：讀憑證、預先檢查；開始不需要簽章的檢查（清冊、建樹、電路檔、通用參數） |
| 2. 確認卡片 | 姓名、PIN 欄位（檢查都通過才出現） | 確認卡片（開視窗） | `confirmCard(pin)`：卡片簽場合字串、算匿名編號、查現況；從現況和今天的日期算出每個選項是哪一種（`CardStatus.options`）、過去一年更換過幾次、還剩幾次、下一次可以更換的日期 |
| 3. 現況和可以做的事 | 還沒宣告過：輸入帳號；宣告過：再次過卡、改成別的帳號、收回；收回過：宣告回同一個帳號、宣告別的帳號。更換用完時「改成別的帳號」「宣告別的帳號」不能按 | 不碰卡片 | `choose(選擇)`：算出後果。帳號格式不對、被上限擋住、沒有可收回的，引擎自己拒絕（`FlowStop`，流程不結束） |
| 4. 後果 | 名冊會公開記下的那一句、用掉幾次更換、紀錄不能刪除；「上一步」回到第 3 節 | 宣告給／再次過卡／改成／收回（開視窗） | `back()` 回到現況，不重新簽章、不重新查；`proceed(帳號)`：要題目、檢查、卡片簽宣告碼、丟掉 PIN、算證明、送出 |
| 5. 進行中、6. 完成 | | | `resubmit()`：送不出去時原封不動再送 |

第 3、4 節之間可以來回。從第一次簽章完成起 5 分鐘（`IDLE_MS`）內沒有完成第二次簽章，引擎丟掉 PIN、憑證和簽章，流程停下（`idle`），畫面回到第 1 節、顯示代碼 `idle`（文件還沒有這句）。

## PIN 經過哪些程式

1. 第 2 節（確認卡片）的欄位（`src/ui/app.ts` 的 `pinField`）：`type="password"`、`autocomplete="off"`、沒有 `name`、不在 `<form>` 裡。按「確認卡片」時讀一次欄位的值，**欄位立刻清空**，值只交給 `flow.confirmCard(pin)`。欄位是空的時候按鈕不能按，所以不會送出沒有 PIN 的請求。
2. 引擎（`src/flow.ts`）：第一次簽章成功後存在記憶體裡（PIN 錯、視窗被擋時不留），到第二次簽章完成、流程停下、或第一次簽章後 5 分鐘（`IDLE_MS`）為止，交給卡片兩次。5 分鐘由計時器（`setTimeout`）觸發；分頁在背景時瀏覽器可能把計時器延後（Chrome 在背景超過 5 分鐘後最慢每分鐘一次），所以 `choose`、`back`、`proceed` 也各自先看時鐘，過了就不用它、直接停下。持卡人在第 3、4 節來回、看後果的這段時間，PIN 一直在這裡。
3. 橋接（`src/card/hipki.ts` 的 `sign`）：放進一個請求字串，用 `postMessage` 送到元件的來源（`targetOrigin` 寫死），然後丟掉；這個物件沒有任何欄位存它。PIN 是空的、或含 `+`、`%`、非 ASCII 時不送（見下面）。
4. 元件的視窗，再到卡片。

沒有任何儲存空間、網址、紀錄、全域變數、DOM 的屬性存過它：`test/e2e/ui.ts` 在每次用過 PIN 之後，檢查欄位、整份 HTML、網址、`localStorage`、`sessionStorage`、`window` 上的每個值都沒有它。JavaScript 的字串不能清成 0，做得到的是不再持有它的參照。

PIN 錯（元件回 `ret_code` `0x76100006`、`last_error` `0xA0`）時，畫面顯示「PIN 不正確。……」、欄位是空的，持卡人重新輸入、再按一次才會再送；任何不成功的回應都不會自己重送。按「確認卡片」時視窗被擋，PIN 照樣在按下時從欄位清掉、沒有交給引擎：允許視窗之後重新輸入、再按一次。按最後一個按鈕時視窗被擋，PIN 留在引擎裡（本來就在兩次簽章之間），5 分鐘的上限照算。

## 元件的橋接信任什麼

`src/card/hipki.ts`。元件沒有 CORS 標頭，頁面不能用 `fetch` 呼叫它；它提供一頁 `/popupForm`，頁面用 `window.open` 開成視窗，視窗準備好時對開它的頁面送 `{"func":"getTbs"}`，頁面送一個請求，視窗做完把回應送回來、自己關掉。照 PSE 範例（`hipki-popup.ts`、`hipki-client.ts`）和 `web-isolation-bench` 量測頁的做法自己寫，沒有複製。

- **網址寫死**：`http://localhost:61161`（`src/target.ts`），不從伺服器的回應或網址參數來。測試的建置換成假元件的網址；`test/build.test.ts` 檢查正式的建置只有這個網址、沒有任何測試的東西。
- **只收元件來源的訊息**：`MessageEvent.origin` 不是 `http://localhost:61161`、或內容不是字串的訊息一律忽略（例如擴充功能送進來的）。送出時 `targetOrigin` 也寫死，視窗被導到別的網址就收不到請求（包括 PIN）。
- **一次點擊一個視窗**：瀏覽器一次點擊只讓開一個視窗。畫面在點擊的處理程式裡、還沒有任何 `await` 之前呼叫 `open()`，接下來的讀憑證或簽章用這個視窗；沒用到就關掉（例如題目的日期不對，第二次簽章前就停了）。
- **視窗被擋時什麼都不送**：`open()` 回傳視窗有沒有開成。沒開成時畫面顯示「瀏覽器擋下了內政部元件的視窗。……」，不叫引擎往下做，同一個按鈕允許之後再按一次就繼續；流程不結束。萬一引擎還是叫了卡片，橋接回 `popup_blocked`，請求沒有離開頁面，引擎也當成可以重試的同一步。
- **回應嚴格讀**：憑證只交給引擎自己檢查；簽章的回應附的憑證（`certb64`）交給引擎，和讀卡時選出的那一張不同就停（`card_error`、代碼 `certificate_mismatch`）。回應沒有附憑證也停（`no_certificate_in_reply`）。
- **只送簽得對的內容**：要簽的字是 31 個 `[A-Za-z0-9:_.-]` 的字元（場合字串和宣告碼都是），以文字送出（2026-11-11 實測元件簽的是文字的位元組）。PIN 含 `+` 或 `%` 時不送：中華電信的程式庫送出前把 `+` 改寫成 `%2B`，看起來元件會像網址一樣解碼請求，這種 PIN 可能變成別的字送到卡片、用掉一次錯誤次數。

| 情況 | 引擎的停止原因 | 怎麼得知 |
|---|---|---|
| 視窗被擋（`window.open` 回 `null` 或丟出例外） | `card` `popup_blocked`（流程不結束，同一步再按一次） | 程式的行為；`test/e2e/ui.ts` 用沒有使用者動作的點擊讓無頭 Chrome 真的擋下 |
| 視窗 8 秒內沒有說準備好（元件沒裝、沒啟動） | `card` `component_unreachable` | 實測（`ui.ts` 的假元件）；真元件沒啟動時的樣子沒有實測 |
| 準備好之後 30 秒沒有回應 | `card` `card_error`，代碼 `timeout` | 程式的行為 |
| 視窗被持卡人關掉 | 還沒準備好：`component_unreachable`；準備好之後：`card_error`，代碼 `popup_closed` | 程式的行為 |
| `GetUserCert` 沒有任何讀卡機有卡片，或 `ret_code` 是 `0x76000006`（未插入IC卡）、`0x76100003`（無可用讀卡機） | `card` `no_card` | 讀程式（中華電信的程式庫、PSE 範例、量測頁）；沒有實測 |
| `MakeSignature` 回 `0x76100006`（IC卡登入失敗）且 `last_error` 是 `0xA0`（PIN碼錯誤）、`0xA2`（PIN碼長度錯誤）、`0x80000001`／`0x80000002`（還剩一或兩次） | `card` `pin_incorrect` | 讀程式；**沒有實測**（沒有用錯的 PIN 試） |
| `0x76100006` 且 `last_error` 是 `0xA4`（已鎖卡） | `card` `card_locked` | 讀程式；沒有實測 |
| `0x76100006` 但 `last_error` 是 0（程式庫的註解：可能是鎖卡等） | `card_error`，代碼 `76100006`，不猜 | 讀程式 |
| 其他非 0 的 `ret_code`（例如 `0x7600000F` 禁止存取的網域） | `card_error`，代碼是十六進位的 `ret_code`（和 `last_error`） | 讀程式 |

## 每個值從哪裡來、送到哪裡去

| 值 | 從哪裡來 | 送到哪裡 |
|---|---|---|
| 憑證（含姓名、序號、公鑰） | 卡片（`Card.readCertificates`，不用 PIN） | 不送出。姓名只回給呼叫的程式顯示；序號只進建樹的 worker；整張憑證只進證明的私有輸入。送出後位元組清成 0 |
| PIN | 呼叫的程式（`confirmCard(pin)`） | 只交給卡片。存在記憶體裡到第二次簽章完成、流程停下、或第一次簽章後 5 分鐘為止。JavaScript 的字串不能清成 0，做得到的是不再持有它的參照 |
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
| 這張卡片的現況 | `POST /api/v1/card-state` | 格式（帳號照場合的格式、日期、`head` 64 個十六進位數字）。每個選項會是哪一種、過去一年更換過幾次、還剩幾次、下一次可以更換是哪天，由裝置從這些事實和今天的日期自己算（`spec/roster-rules.md`）；被上限擋住的選項，引擎在 `choose` 拒絕，`proceed` 簽之前用當下的日期再算一次。事實本身沒辦法檢查，見「已知的限制」 | `src/api.ts` 的 `requestCardState`、`src/spec/roster-rules.ts`、`src/flow.ts` 的 `confirmCard`（`options`）、`consequenceOf`、`proceed` |
| 收回時的帳號 | 上一列的 `current` | 照場合的帳號格式。收回不輸入帳號，所以宣告碼裡的帳號由伺服器的回答決定。伺服器換一個帳號，認不出持卡人：它已經知道這個匿名編號（是裝置剛送的），換帳號只會讓卡片簽一個收回別的帳號的宣告碼，而這張卡片目前宣告的不是那個帳號，紀錄會被名冊規則判 `not_current`，後台不會寫入，重驗的人也會判它無效。持卡人得先看到這個帳號：`choose({ action: "withdraw" })` 回的後果帶著這個帳號，第 4 節顯示它；`proceed(帳號)` 要呼叫的程式傳回畫面上顯示、持卡人確認過的帳號，和選的不同就停，卡片不簽第二次 | `src/flow.ts` 的 `consequenceOf`、`proceed` |
| 什麼時候向後台查現況 | （裝置決定） | 不需要簽章就能做的檢查全部通過之後，卡片才簽第一次、裝置才帶著匿名編號查現況：憑證的預先檢查、清冊下載並驗過、樹建完、序號不在樹裡、電路檔和通用參數的雜湊對。否則後台會看到「這個匿名編號查過現況、之後沒有下文」，能和它的鏡像給的清冊對起來（ADR-0015、ADR-0016）。檢查還沒完成時 `phase` 是 `checking`，畫面不顯示 PIN 欄位；`checksDone()` 通過後是 `ready_for_pin`。`confirmCard` 自己也先等這些檢查 | `src/flow.ts` 的 `startBackground`、`checksDone`、`confirmCard` |
| 電路 | `/circuits/card_proof_rs2048.json`、`card_proof_rs4096.json` | SHA-256 寫死（`circuits/README.md`）；不同就停，在卡片簽章之前 | `src/prover/artifacts.ts` |
| 通用參數 | `/crs/bn254_g1_compressed_2p18.dat`、`/crs/bn254_g2.dat` | SHA-256 寫死；核對過才交給 bb.js | `src/prover/artifacts.ts`、`src/prover/engine.ts` |
| 送出的結果 | `POST /api/v1/records` | 格式（`seq`、`record_hash`、`kind`）；只顯示 | `src/api.ts` 的 `submitRecord` |
| 錯誤代碼 | 每個介面 | 只收 `[a-z_]{1,40}`，其他寫成 `http_狀態碼`；只回給呼叫的程式。送出時，沒有回應、`429`、`crl_stale` 以外的 5xx（`internal`）可以用 `resubmit()` 原封不動再送；其他代碼（包括 `503` `crl_stale`）結束流程 | `src/api.ts`、`src/flow.ts` 的 `submit` |

**寫死在頁面裡的**：場合字串的對照表和這一階段用的名冊（`ROSTER = "test"`，`src/index.ts`）、G2 和 G3 的發證金鑰（`src/issuers.ts`，和 `spec/vectors/issuers.json`、`crl/` 的憑證檔比對過）、電路和通用參數的 SHA-256、內建的 7 天、證明的設定（零知識、`noir-recursive`，`src/prover/prover.ts`）、證明的執行緒上限。

**頁面本身**（HTML、JavaScript、bb.js 和 Noir 的 WebAssembly）和 API 從同一台伺服器來。這些檔案是同一次建置的產物，沒有另外核對；ADR-0016 的「代價」寫明了這個前提：用的頁面就是公開的這一份。

## 停止的原因

流程停下來時丟出 `FlowStop`，`stop` 是下表的一種（`src/flow.ts` 的 `Stop`）。畫面照 `src/ui/messages.ts` 顯示 `design/copy/card-proof.md` 的一句話；「代碼」是那句話裡的 `X`。後台的錯誤另外在那句話旁邊顯示回應標頭 `X-Request-Id` 的值（持卡人回報問題時說得出是哪一次）。這些原因都只給呼叫的程式，不送給伺服器。`flow.stop` 是 `null` 的（PIN 錯、視窗被擋、選了不能做的事或格式不對的帳號、送出時的暫時失敗）可以重試同一步，其他的結束這次流程；第 1、2 節停下時，「讀取卡片」再出現一次，按下去是新的一次過卡（讀卡不用 PIN）。下表最後一欄是 `card-proof.md` 的第幾節、哪一列。

| `code` | 細項 | 什麼情況 | `design/copy/card-proof.md` 的哪一列 |
|---|---|---|---|
| `card` | `component_unreachable` | 連不上內政部的元件 | 2.「連不上元件」，附「怎麼準備」 |
| `card` | `no_card` | 讀卡機裡沒有卡片 | 2.「沒有卡片」 |
| `card` | `pin_incorrect` | PIN 錯（可以重試） | 2.「PIN 不正確」 |
| `card` | `popup_blocked` | 瀏覽器擋了元件的視窗（可以重試；什麼都沒送） | 2.「瀏覽器擋下了元件的視窗」 |
| `card` | `card_locked` | 卡片鎖住了 | 2.「卡片鎖住了」 |
| `card` | `card_error`（附代碼，見上面橋接的表） | 卡片或元件回了其他錯誤 | 2.「讀卡或簽章時的其他錯誤」 |
| `certificate` | `no_certificate` | 卡片沒有回任何憑證 | 2.「卡片上讀不到憑證」 |
| `certificate` | `expired`（附 `notAfter`，台灣日期） | 憑證在今天之前到期 | 2.「憑證過期」 |
| `certificate` | `not_yet_valid`（附 `notBefore`，台灣日期） | 憑證還沒生效 | 2.「憑證還沒生效」 |
| `certificate` | `not_citizen_primary` | 憑證政策或主體目錄屬性不是國民正卡的（外來人口、附卡、行動自然人憑證、政策不同） | 2.「不是國民的正卡」 |
| `certificate` | `unsupported_format` | 電路的走法在其他地方不過 | 2.「憑證的格式電路不接受」 |
| `certificate` | `unknown_issuer` | 不是 G2、G3 簽發的 | 2.「憑證不是內政部簽發的」 |
| `certificate` | `ambiguous_certificate` | 卡片上有兩張不同的憑證都通過 | 2.「憑證的格式電路不接受」（文件的註） |
| `revocation` | `crl_stale`（附天數、`L`） | 清冊比 `L` 天舊 | 2.「廢止清冊太舊」 |
| `revocation` | `crl_unavailable`、`crl_hash`、`crl_unusable` | 索引或清冊拿不到；索引沒有可用的行；編號最高的有兩個不同檔案；清冊的 SHA-256 不是檔名；清冊不可用 | 2.「拿不到可用的廢止清冊」，代碼是這三個之一 |
| `revocation` | `crl_rollback` | 清冊編號比這台裝置用過的低 | 2.「拿到的廢止清冊比這台電腦上次用過的舊」 |
| `revoked` | | 序號在清冊上（廢止或暫時停用） | 2.「在廢止清冊上」 |
| `artifact` | 檔案路徑 | 電路檔或通用參數拿不到，或 SHA-256 不對 | 2.「電路檔或參數檔下載失敗，或內容和預期的不同」 |
| `engine` | | 證明引擎無法啟動或算不出證明 | 5.「這台電腦算不出證明」 |
| `card_signature` | | 卡片回的簽章用憑證的公鑰驗不過 | 5.「卡片回的簽章用憑證驗不過」，代碼 `card_signature` |
| `challenge_malformed` | | 題目不是唯一寫法 | 2.「伺服器沒有回應，或回應讀不懂」，代碼 `challenge_malformed` |
| `challenge_not_today` | 題目的日期、今天 | 題目的日期不是裝置的台灣今天 | 2.「電腦的日期和題目的日期不同」 |
| `blocked` | `switch_limit` | 選了更換，但次數用完（可以重新選） | 畫面不給按（3.「更換次數用完時」）；引擎的 `choose` 也拒絕，畫面只顯示代碼 `switch_limit` |
| `blocked` | `not_current` | 選了收回，但這張卡片目前沒有宣告（可以重新選） | 畫面不提供收回；引擎也拒絕，只顯示代碼 `not_current` |
| `idle` | | 第一次簽章後 5 分鐘沒有完成第二次簽章：PIN、憑證、簽章都丟掉 | 文件沒有這句；畫面回到第 1 節，只顯示代碼 `idle` |
| `proof_check` | | 證明不是 14,656 個位元組，或公開輸入和裝置重建的不同 | 5.「算出的證明沒有通過這一頁自己的檢查」 |
| `server` | `network`、`internal`、其他 5xx、`rate_limited`（送出時，可以重試） | 送出沒有到達或後台暫時失敗 | 5.「送不出去」，附「再試一次」 |
| `server` | `challenge_unknown` | 題目過期或不是這台後台發的 | 5.「停太久，題目過期」 |
| `server` | `scope`、`malformed`、`challenge_used`、`challenge_attempts`、`proof`、`crl_stale`、`root`、`date_order`、`not_current`、`switch_limit` | 後台沒有接受這份紀錄 | 5.「後台沒有接受」，代碼是後台的代碼 |
| `server` | 要題目、查現況、讀設定時的任何代碼；`malformed_response`；`not_found`、`method_not_allowed`；`http_狀態碼` | 後台沒有回答，或回答讀不懂 | 2.「伺服器沒有回應，或回應讀不懂」，代碼是後台的代碼 |
| `username` | | 輸入的帳號不符合場合的格式（可以重新輸入） | 3.「帳號的格式不對」（畫面先擋下，引擎的 `choose` 也拒絕） |
| `state` | | 呼叫的程式步驟順序錯，或 `proceed` 傳的帳號不是選的那一個 | 文件沒有這句；只顯示代碼 `state`（程式錯誤） |


## 唯一存進瀏覽器的東西

每把發證金鑰用過的最高清冊編號：`localStorage` 的 `iamreal.highest_crl_number.G2`、`iamreal.highest_crl_number.G3`，值是十進位的編號（`src/storage.ts`）。憑證、簽章、PIN、匿名編號、帳號名稱都不存。

bb.js 平常會把通用參數存在 IndexedDB；這裡不用 bb.js 自己的下載（`skipSrsInit`），所以它不會存。無頭瀏覽器的測試在流程跑完後檢查：`localStorage` 只有清冊編號，`sessionStorage`、IndexedDB、Cache Storage、cookie 都是空的。

## 頁面需要的 `Content-Security-Policy`

伺服器送這個標頭（`server/headers.go` 的 `pageHeaders`，`web/` 的每個檔案都帶；`server/` 的測試檢查這份 README 引用的和它一字不差）。頁面只能連自己的網域；套件被動了手腳，瀏覽器也不讓它把東西送到別處。

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

- `'wasm-unsafe-eval'`：bb.js 和 Noir 要編譯 WebAssembly。
- `worker-src 'self'`：建樹的 worker 和 bb.js 自己的 worker 都是同一個網域的檔案。
- bb.js 原本把 WebAssembly 包成 `data:` 網址、把通用參數從 Aztec 的 CDN 下載。建置時把 WebAssembly 寫成檔案（`vite.config.ts`），通用參數改從自己的網域拿，所以 `connect-src` 只要 `'self'`。
- 畫面的樣式是同一個網域的 CSS 檔（`style-src 'self'`）；畫面不用 `style` 屬性，也沒有內嵌的 `<script>`。
- **元件的視窗不需要多開任何東西。** `window.open` 開 `http://localhost:61161/popupForm`（頂層的導覽）和 `postMessage` 都不受 CSP 管；頁面本身不對 `localhost:61161` 發任何請求，那些請求是元件的頁面自己發的。`test/e2e/ui.ts` 在這份標頭之下跑完整條流程，沒有任何違反。
- 多執行緒要頁面是跨來源隔離的：另外送 `Document-Isolation-Policy: isolate-and-credentialless`（Chromium 系的桌機版）。它不像 `Cross-Origin-Opener-Policy` 會切斷頁面和元件視窗的關係。其他瀏覽器忽略它，證明用 1 個執行緒。

無頭瀏覽器的測試在這份標頭之下跑完整條流程，並檢查沒有任何違反，頁面和它的 worker 沒有連到自己的網域以外的地方。`test/e2e/run.ts` 也檢查這份 README 引用的標頭和測試用的一字不差（`test/e2e/headers.ts`）；`test/e2e/ui.ts` 檢查後台實際送的和 `test/e2e/headers.ts` 相同。

## 怎麼單獨執行和測試

需要 Node 22（22.6 以上）、pnpm 10。

```
cd web
pnpm install --frozen-lockfile
pnpm fetch-crs        # 下載通用參數到 crs/（不進版控），核對 SHA-256
pnpm typecheck
pnpm test             # Node 裡的測試，約 20 秒（含一次正式的建置）
IAMREAL_BB=/path/to/bb pnpm test:e2e     # 引擎，無頭的 Chrome，約 2 分鐘
IAMREAL_BB=/path/to/bb pnpm test:ui      # 畫面、橋接、真的後台，無頭的 Chrome，約 3 分鐘（要 Go）
pnpm build            # 正式的建置，到 dist/
```

- `pnpm fetch-crs` 是這個目錄的程式唯一對外的連線（`pnpm local` 另外讓後台的清冊鏡像抓內政部的清冊）：從 `https://crs.aztec-cdn.foundation/` 下載 2^18 個點的 `g1_compressed.dat` 開頭 8 MiB（SHA-256 `5107a7926d504236331b4872b7218a1ca18921b5358d894822576e1aeb684934`）和 `g2.dat`（128 個位元組，`01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f`）。G1 的雜湊和 `bb` 自己下載、檢查過的兩份副本相同；G2 從 Aztec 的兩個網域下載的相同。頁面執行時從自己的網域拿這兩個檔案。
- `IAMREAL_BB` 是 `bb` 6.0.0（取得方式見 `verifier/README.md`）。`CHROME` 可以指定 Chrome 的路徑，預設是 macOS 的 Google Chrome。
- `pnpm test:e2e` 後面可以接設定，例如 `G3-dip G3-none G2-dip G3-dip-t4`：發證金鑰的大小、頁面是否跨來源隔離、證明的執行緒上限。

### Node 裡的測試（`pnpm test`）

| 檔案 | 測什麼 |
|---|---|
| `test/spec.test.ts` | `spec/vectors/` 的 `challenge.json`、`scope.json`、`declaration-code.json`、`scoped-id.json`、`issuers.json`（加上 `crl/` 的兩張發證憑證）、`roster-rules.json`（每個案例重播事件，每一筆宣告和收回事先算出的種類和結果相同）。標準答案直接讀那些檔案，不複製 |
| `test/crl.test.ts` | `spec/vectors/poseidon2.json`（`hash_2`、`hash_3`、匿名編號、廢止清冊的樹和「不在樹裡」的證明，分 1、2、4 份建）；`crl/testdata/` 的每一份清冊，可不可用、原因代碼、編號、清冊日期、樹根都和 `crl/testdata/expected.json`（Go 的結果）相同；分份建樹和一次建的結果相同；索引怎麼選 |
| `test/certificate.test.ts` | 照電路的走法預先檢查憑證：國民正卡通過；加密用憑證被跳過；過期（含到期日當天最後一秒）、還沒生效、外來人口、`cardHolderRank`、4096 位元的卡片金鑰、發證者名稱太長、金鑰用途不在第三個、不是兩把發證金鑰簽的，各自回對應的原因 |
| `test/copy.test.ts` | `design/copy/card-proof.json` 和 `card-proof.md` 的句子兩個方向都相同（Markdown 的每個程式碼區塊和表格）；`src/ui/` 和 HTML 裡沒有中日韓文字 |
| `test/ui.test.ts` | 每一種停止原因、每一種現況（還沒宣告過、宣告過、收回過，更換用完時）、每一種後果（第一次、再次過卡、更換、宣告回同一個帳號、收回），畫面顯示哪一句、哪些按鈕不能按（`src/ui/messages.ts`）；後台的錯誤帶請求編號 |
| `test/hipki.test.ts` | 元件的回應怎麼讀：讀卡機有沒有卡片、憑證、簽章和附的憑證；PIN 錯、鎖卡、其他代碼（照讀程式得知的格式，見「元件的橋接信任什麼」） |
| `test/build.test.ts` | 正式的建置有內政部的發證金鑰和 `http://localhost:61161`，沒有假卡片、測試的發證金鑰、假元件，`localhost` 以外的本機網址一個都沒有 |
| `test/flow.test.ts` | 伺服器或鏡像給了不該接受的值，每一個都停下來，之後沒有請求，沒有請求帶著原因：日期不是今天的題目、寫法不唯一的題目（6 種）、章不對的清冊、舊於 `L` 天的清冊、`/api/v1/config` 回 365、編號比記住的低的清冊、分段的清冊、索引指到不存在的檔案、內容和檔名的雜湊不符的清冊、雜湊不對的電路檔、序號在清冊上。另外：卡片簽的場合字串只來自對照表；更換用完時引擎拒絕更換、卡片不簽第二次、不要題目；收回的帳號；格式不對的現況；公開輸入和裝置自己重建的不同時不送出；過期的憑證在任何請求之前停下；PIN 錯可以重試、PIN 不留。每個選項是哪一種（還沒宣告過、宣告過、收回過；365 天的窗）；沒有可收回的、格式不對的帳號，引擎拒絕而流程不結束；第 3、4 節來回不簽章、不發請求，送出的是最後選的；PIN 最多等 5 分鐘（換掉時鐘和計時器：差 1 毫秒照常，計時器觸發時丟掉 PIN、憑證、簽章並通知畫面，計時器沒觸發時下一步自己看時鐘）；三次點擊各被擋一次，卡片沒有收到任何東西、同一步再做一次就繼續，被擋不延長 5 分鐘。序號在清冊上、清冊不可用、電路檔或通用參數雜湊不對時（包括 PIN 在檢查完成前就交進來），卡片沒有被要求簽章，也沒有 `card-state` 的請求；`phase` 從 `checking` 到 `ready_for_pin`；`proceed` 傳的帳號不是現況的帳號時不簽第二次；`crl_stale` 結束流程，`internal` 可以原封不動再送；卡片的讀卡機說簽章的憑證不是選出的那一張時停下、不查現況；還沒生效的憑證附生效日 |

### 無頭瀏覽器的測試（`pnpm test:e2e`）

`test/e2e/run.ts` 用 Vite 建置測試頁（`test/e2e/`），在 127.0.0.1 上帶著上面的 CSP 提供頁面和一個照 `docs/api/card-proof.md` 回答的假伺服器，開無頭的 Chrome、全新的設定檔，用假卡片跑兩次過卡（同一次頁面載入、同一個證明引擎）。清冊是自製的，大小接近內政部的（G3 176,000 筆、G2 340,000 筆）。跑完檢查：

- 兩次都送出了，伺服器收到的紀錄就是頁面回報的；
- 從紀錄的欄位重建公開輸入，用原生的 `bb verify -t noir-recursive` 和 `verifier/vk/` 的驗證金鑰驗得過；改一個公開輸入就驗不過；
- `crossOriginIsolated`、引擎的執行緒數和 bb.js 自己說開的相同；
- 沒有違反 CSP，伺服器沒有收到它不認得的請求；
- 瀏覽器的儲存空間只有清冊編號。

測試的發證金鑰不是內政部的，所以這裡只驗證明本身；和真的後台對接在 `pnpm test:ui`。

### 畫面、橋接和真的後台（`pnpm test:ui`）

`test/e2e/ui.ts`：

1. 產生拋棄式的發證金鑰（G2、G3）、卡片和清冊（`test/fixtures/`）。
2. 用建置標籤 `iamrealtest` 建置後台（`server/testissuers.go` 的 `-test-issuers`、`-test-moica`），用這兩把金鑰、一個假的內政部（給鏡像抓清冊）、測試的名冊啟動；頁面用 `vite build --mode test` 建置（`test/e2e/target.ts` 換掉 `src/target.ts`：測試的發證金鑰、假元件在 `http://localhost:61171`、PIN 等第二次簽章的上限 25 秒），由後台提供。
3. 假元件（`test/e2e/fake-component.ts`）照真元件的訊息來回，用測試金鑰的卡片回答 `GetUserCert` 和 `MakeSignature`，PIN 錯、鎖卡回中華電信程式庫寫的代碼，並記下每一個請求。
4. 用無頭 Chrome（`test/e2e/cdp.ts`，Chrome DevTools Protocol，不用套件）從畫面上點，滑鼠事件是真的（瀏覽器當成持卡人的點擊）：第一次宣告（先輸入一次錯的 PIN、一次格式不對的帳號；三次點擊各先被瀏覽器擋一次，同一步再按就繼續）、再次過卡（不輸入帳號；第一次送出被丟掉，按「再試一次」）、改成別的帳號（中間「上一步」來回：沒有簽章、沒有查現況、沒有要題目）、收回、收回後宣告回同一個帳號（不算更換）、再收回、收回後宣告別的帳號（算更換）、更換用完（按鈕不能按；用程式把按鈕打開、輸入帳號，引擎拒絕，卡片沒簽、沒要題目）、送出被後台拒絕（中途改了帳號，畫面顯示代碼 `proof` 和請求編號，和回應標頭、後台的紀錄相同）、收回、收回後更換用完、PIN 等太久（測試的建置把 5 分鐘換成 25 秒：回到第 1 節、代碼 `idle`、沒有第二次簽章）、鎖卡、題目的日期不是今天；以及每一種在輸入 PIN 之前停下的情況：元件不回應、沒有卡片、卡片沒有憑證、過期、還沒生效、不是國民正卡、格式不支援、兩張憑證都通過、不是內政部簽發、在清冊上、清冊 5 天沒更新、鏡像沒有可用的清冊、電路檔內容不符、後台不回應、清冊比這台電腦用過的舊。每一種都檢查畫面上的句子、沒有 PIN 欄位、卡片沒有簽、沒有 `card-state` 請求。
5. 出每日快照，用 `iamreal-verify` 重驗：名冊成立，八筆的種類對（`first refresh switch withdraw refresh withdraw switch withdraw`），最後的現況（這張卡片目前沒有宣告、上次過卡是今天）和畫面顯示的相同，畫面上的短編號是這張卡片的。
6. 頁面的標頭、跨來源隔離、多執行緒；沒有違反 CSP；頁面和它的 worker 只連到自己的網域、元件的視窗只連到元件；一次元件的請求一個視窗（被擋的點擊沒有開出視窗）；沒有不帶 PIN 的簽章請求；用過 PIN 之後、PIN 等太久之後頁面上找不到它；姓名在第 2 節之後不在頁面上；瀏覽器的儲存空間只有清冊編號。

截圖在 `test-output/ui/screens/`，重驗的輸出在 `test-output/ui/verify.json`。

### 其他的小程式（不在測試裡）

| 指令 | 做什麼 |
|---|---|
| `node --experimental-strip-types test/e2e/check-component.ts` | 對**真的**元件只送 `CheckEnvir`（環境檢查，不讀憑證、不簽章），頁面在 `http://localhost:<埠>`、帶後台的兩個標頭：看頁面是不是跨來源隔離、元件能不能來回 |
| `node --experimental-strip-types test/e2e/smoke.ts <網址>` | 對跑著的頁面（例如 `pnpm local`）開到第一個畫面為止，不碰元件 |
| `node --experimental-strip-types test/e2e/background.ts [次數]` | 量分頁在背景時過卡的時間（見「時間」） |

### 假卡片

`src/card/fake.ts`：測試金鑰簽發的憑證（簽章用和加密用各一張，結構和國民正卡相同，做法照電路測試的 `cert.mjs`，在 `test/fixtures/certs.ts`）和對應的私鑰。`src/index.ts` 不匯出它，正式的建置不含它（`test/build.test.ts`）。畫面的測試不用它：卡片在假元件裡（`test/e2e/fake-component.ts`），頁面走的是真的橋接。

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
- **分頁在背景時慢很多。** `test/e2e/background.ts`（2026-11-16，同一台電腦、Chrome 157 無頭模式，G3、自製的 176,000 筆清冊，每格兩次頁面載入、每次兩次過卡）：另一個分頁在前景、這一頁從載入到算完都在背景（`document.visibilityState` 是 `hidden`）時，跨來源隔離（8 個執行緒）的證明從 2.6 到 3.5 秒變成 28.6 到 32.5 秒，建樹從 2.5 到 2.9 秒變成 20.6 到 31.1 秒，引擎初始化從 1.8 到 1.9 秒變成 13.5 到 19.4 秒，整次過卡從 6.2 到 7.1 秒變成 56.5 到 66.8 秒；沒有隔離（1 個執行緒）的證明從 9.2 到 9.6 秒變成 60.3 到 65.2 秒，整次過卡從 12.4 到 14.4 秒變成 92.5 到 96.5 秒。原因沒有查（推測是 Chrome 降低背景分頁行程的優先順序）；有畫面的 Chrome 沒有量。
- 頁面不是跨來源隔離時 bb.js 不報錯、安靜地用 1 個執行緒；引擎自己看 `crossOriginIsolated` 和 `SharedArrayBuffer` 決定，並把 bb.js 自己說開的執行緒數一起告訴呼叫的程式（`ThreadMode`）。

## 檔案

| 檔案 | 內容 |
|---|---|
| `index.html`、`help.html` | 過卡的頁面、說明頁 |
| `src/ui/` | 畫面：`main.ts`（進頁面就啟動引擎）、`app.ts`（`card-proof.md` 的六節）、`messages.ts`（停止原因、現況、後果對到哪一句）、`copy.ts`（讀 `design/copy/card-proof.json`）、`dom.ts`、`help.ts`、`style.css` |
| `src/index.ts` | 引擎的入口：`startEngine()`（進頁面呼叫一次）、`createCardProof()`（每次過卡，用同一個引擎）。寫死場合的名冊、同網域的 fetch、時鐘、儲存 |
| `src/target.ts` | 發證金鑰、元件的網址、PIN 等第二次簽章的上限；測試的建置換成 `test/e2e/target.ts` |
| `src/flow.ts` | 過卡的狀態機：`readCard` → `checksDone` → `confirmCard(pin)` → `choose(選擇)`（↔ `back()`）→ `proceed(帳號)` → 完成；`resubmit`、`cancel`；`phase` 說現在在哪一步；PIN 等第二次簽章的上限 `IDLE_MS`。宣告和收回 |
| `src/spec/` | 規格裡的算法：base32、題目、日期、場合字串、宣告碼、匿名編號、名冊規則的事先計算 |
| `src/certificate.ts`、`src/der.ts` | 讀憑證、照電路的走法預先檢查、選出要用的那一張、驗發證金鑰的章 |
| `src/issuers.ts` | G2、G3 的發證金鑰，WebCrypto 的 RSA 驗章 |
| `src/crl/` | 讀清冊並判斷可不可用、從鏡像找清冊並檢查、樹、建樹的 worker |
| `src/prover/` | 證明引擎（bb.js、Noir）、電路的輸入、電路和通用參數的雜湊 |
| `src/api.ts` | 和後台之間的請求，嚴格讀回應 |
| `src/card/` | 卡片的介面、元件的橋接（`hipki.ts`）、假卡片 |
| `src/storage.ts` | 唯一的儲存：清冊編號 |
| `circuits/` | 編譯好的電路，見裡面的 `README.md` |
| `scripts/` | 下載通用參數、從 `nargo` 的輸出寫出 `circuits/` 的檔案、在本機整條跑（`local.ts`） |
| `test/` | 測試；`test/fixtures/` 是測試金鑰做的憑證、清冊和假伺服器；`test/e2e/` 是無頭瀏覽器的測試、假元件、量測 |

執行時的依賴只有 `@aztec-foundation/bb.js` 6.0.0 和 `@noir-lang/noir_js` 1.0.0（和電路的程式庫釘的相同）。開發用的只有 Vite、TypeScript 和 `@types/node`。全部是精確版本，`pnpm-workspace.yaml` 設了不安裝發布未滿 7 天的版本。沒有介面框架；DER 自己解析。

## 已知的限制

- **名冊上的現況照後台說的顯示，不檢查。** 後台謊報（宣告的是 @bob 卻說沒宣告過）會讓持卡人不知情地用掉一次更換。要擋得下載整份名冊自己算，太重。後台從這裡查不出持卡人是誰，謊報會被名冊上的紀錄揭穿。
- **清掉瀏覽器資料後，清冊編號的保護退回「清冊不能舊於 `L` 天」。** 換一個瀏覽器、無痕視窗也一樣。
- **頁面和 API 從同一台伺服器來時，這些檢查擋不住營運者本人**：改過的頁面可以不做這些檢查（ADR-0016）。
- PIN 是 JavaScript 的字串，沒辦法清成 0；做得到的是第二次簽章後（或流程停下、等了 5 分鐘時）不再持有它。
- **PIN 在兩次簽章之間留得比較久**：持卡人看現況、選、看後果的這段時間都在記憶體裡，最多 5 分鐘。分頁在背景、計時器被瀏覽器延後時，實際丟掉的時間可能晚一點（Chrome 最慢約 1 分鐘）；這段時間引擎不會再用它（每一步先看時鐘）。第 3、4 節沒有「取消」（文件沒有）：不想繼續的人關掉或重新整理這一頁。
- **瀏覽器的密碼管理員會不會提議記住 PIN，沒有實測。** 欄位是 `autocomplete="off"`、沒有名稱、不在表單裡，但 Chrome 對密碼欄位不一定照 `autocomplete="off"`。無頭的 Chrome 沒有密碼管理員的提示可看。
- **元件的錯誤格式是讀程式得知的**（見「元件的橋接信任什麼」的表）。PIN 錯、鎖卡、沒有卡片的真實回應沒有實測；不認得的回應一律停下、顯示代碼，不猜、不重送。
- 只在 macOS 上的 Chrome 測過。Safari、Firefox、手機沒有跑過這裡的測試。

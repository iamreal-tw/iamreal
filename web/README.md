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
| 收回時的帳號 | 上一列的 `current` | 照場合的帳號格式；寫進宣告碼之前回給呼叫的程式顯示 | `src/flow.ts` 的 `confirmCard` |
| 電路 | `/circuits/card_proof_rs2048.json`、`card_proof_rs4096.json` | SHA-256 寫死（`circuits/README.md`）；不同就停，在卡片簽章之前 | `src/prover/artifacts.ts` |
| 通用參數 | `/crs/bn254_g1_compressed_2p18.dat`、`/crs/bn254_g2.dat` | SHA-256 寫死；核對過才交給 bb.js | `src/prover/artifacts.ts`、`src/prover/engine.ts` |
| 送出的結果 | `POST /api/v1/records` | 格式（`seq`、`record_hash`、`kind`）；只顯示 | `src/api.ts` 的 `submitRecord` |
| 錯誤代碼 | 每個介面 | 只收 `[a-z_]{1,40}`，其他寫成 `http_狀態碼`；只回給呼叫的程式 | `src/api.ts` |

**寫死在頁面裡的**：場合字串的對照表和這一階段用的名冊（`ROSTER = "test"`，`src/index.ts`）、G2 和 G3 的發證金鑰（`src/issuers.ts`，和 `spec/vectors/issuers.json`、`crl/` 的憑證檔比對過）、電路和通用參數的 SHA-256、內建的 7 天、證明的設定（零知識、`noir-recursive`，`src/prover/prover.ts`）、證明的執行緒上限。

**頁面本身**（HTML、JavaScript、bb.js 和 Noir 的 WebAssembly）和 API 從同一台伺服器來。這些檔案是同一次建置的產物，沒有另外核對；ADR-0016 的「代價」寫明了這個前提：用的頁面就是公開的這一份。

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
| `test/flow.test.ts` | 伺服器或鏡像給了不該接受的值，每一個都停下來，之後沒有請求，沒有請求帶著原因：日期不是今天的題目、寫法不唯一的題目（6 種）、章不對的清冊、舊於 `L` 天的清冊、`/api/v1/config` 回 365、編號比記住的低的清冊、分段的清冊、索引指到不存在的檔案、內容和檔名的雜湊不符的清冊、雜湊不對的電路檔、序號在清冊上。另外：卡片簽的場合字串只來自對照表；更換用完時卡片不簽第二次、不要題目；收回的帳號；格式不對的現況；公開輸入和裝置自己重建的不同時不送出；過期的憑證在任何請求之前停下；PIN 錯可以重試 |

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
| `src/flow.ts` | 過卡的狀態機：`readCard` → `confirmCard(pin)` → `proceed` → 完成；`resubmit`、`cancel`。宣告和收回 |
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

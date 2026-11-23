# ADR 索引

現在有效的結論，照主題排。施工前先看這一頁找到相關的 ADR，再讀 ADR 本身：理由、沒採用的做法和後果都在裡面。

- 每份 ADR 開頭的 `status` 寫它是有效、被哪一份取代，還是部分取代；部分取代的，標題下面的引言寫明是哪一段
- 新增或修改 ADR 時，同一個 PR 改這一頁
- 「程式還沒跟上」一節列的 ADR，現在的程式和各目錄的 README 講的還是舊做法；兩邊對不上時以 ADR 為準

## 電路和證明

- 電路用 Noir 自己寫，用 Barretenberg 的 UltraHonk；PSE 的 circom 電路只當對照，改電路後重跑逐案比對。[ADR-0012](0012-write-circuits-in-noir.md)（取代 [ADR-0001](0001-use-pse-circuits-unmodified.md)）
- 每次過卡卡片簽兩次：場合字串和宣告碼。[ADR-0002](0002-card-signs-twice-per-card-proof.md)
- 每次過卡一份證明；兩段字的種類由電路檢查；題目不是電路的輸入。[ADR-0013](0013-one-proof-per-card-proof.md)
- 電路檢查憑證在 `current_time` 當下在效期內。[ADR-0008](0008-add-validity-check-to-certificate-circuit.md)
- 公鑰的位置由電路從憑證的結構推導，不由裝置提供。[ADR-0009](0009-derive-public-key-offset-from-structure.md)
- 金鑰用途只能是簽章。[ADR-0010](0010-check-key-usage-in-certificate-circuit.md)
- 只認國民的正卡；附卡、行動自然人憑證、外來人口的憑證過不了卡。[ADR-0011](0011-accept-only-citizen-primary-card-certificates.md)
- 每次證明都要卡片在場，不做通行證和保活證明。[ADR-0006](0006-every-proof-requires-the-card.md)
- 電路的原始碼在這個程式庫的 `circuits/`，不帶先前的歷史；重建並比對的指令從原始碼重編，和 `web/circuits/`、`verifier/vk/` 逐位元組比對；CI 只在改到電路的 PR 上跑。[ADR-0038](0038-circuit-source-in-this-repository.md)

## 匿名編號和場合

- 場合字串 31 個位元組，公開名冊是 `iamreal:public:0`，測試名冊是 `iamreal-test:public:0`；第一個字元決定種類。[ADR-0007](0007-scope-string-format.md)
- 所有公開平台共用一個場合、一個匿名編號；同一張卡片宣告的帳號列在一起；一筆紀錄是整份帳號清單。[ADR-0017](0017-public-platforms-share-one-scope.md)
- 匿名編號、證明和公開輸入都公開在名冊上；對外承諾的精確說法在這一份。[ADR-0004](0004-scoped-ids-and-proofs-are-public.md)
- 匿名編號的算法上線後不動。[ADR-0012](0012-write-circuits-in-noir.md)

## 名冊的規則

- 名冊只記持卡人的宣告，不確認帳號主人是否承認；承認靠連回，由訪客自己看。[ADR-0003](0003-roster-records-declarations-only.md)
- 名冊只存事件，現況由公開規則算出；不設到期日、不提供刪除。[ADR-0005](0005-roster-is-an-append-only-event-log.md)
- 更換每個平台終身 5 次；當天的更正不計次；一張卡片同一個日期最多 3 筆有效紀錄。[ADR-0018](0018-five-switches-per-platform-for-life.md)
- 紀錄的日期：不晚於所用清冊發布日後 3 天，不早於名冊上最晚的有效日期前 4 天。[ADR-0015](0015-device-builds-revocation-tree.md)
- 一張卡片的紀錄，日期不早於它自己的上次過卡日。[ADR-0024](0024-card-dates-do-not-go-back.md)
- 上線後改規則，已經寫入的紀錄結果不變：逐筆相同才往回套用，否則用生效日；平台表只新增、只放寬。[ADR-0031](0031-rule-changes-keep-written-records.md)
- 規則有兩份實作（Go 和 TypeScript），改規則時規格、標準答案和兩份實作同一個 PR 改好。[ADR-0030](0030-go-reverifier-kept-without-end-date.md)

## 名冊的格式和公開的檔案

- 每一筆紀錄只有一種寫法，照樣板重寫後逐位元組比對；寫法錯整份不成立，證明或規則不過只是那一筆無效。[ADR-0014](0014-one-spelling-per-record.md)
- 紀錄不串成鏈；每天公布一次名冊指紋，另外公開雜湊清單。[ADR-0021](0021-roster-fingerprint-published-daily.md)
- 名冊目錄、雜湊清單、指紋檔、卡片狀態檔、清冊存檔放在 `data.iamreal.tw`；指紋檔另外由 `iamreal-tw/fingerprints` 每天抄一份。[ADR-0027](0027-public-files-on-data-subdomain.md)

## 重驗

- 每一筆紀錄公布後由 Go 的重驗指令驗一次，之後只確認雜湊沒有變；營運者每天在 GitHub Actions 跑；沒有通過時手動停止收過卡。[ADR-0025](0025-each-proof-reverified-once-by-a-second-implementation.md)
- Go 的重驗工具不設期限地留著；證明的密碼學驗證兩邊共用 Barretenberg，對外照實寫。[ADR-0030](0030-go-reverifier-kept-without-end-date.md)

## 持卡人的裝置

- 保護持卡人、對抗伺服器的限制寫死在裝置上；新的限制列進這一份的表。[ADR-0016](0016-device-protections-not-set-by-server.md)
- 廢止清冊的樹由裝置自己建，每把發證金鑰一棵；裝置用的清冊最多舊 7 天。[ADR-0015](0015-device-builds-revocation-tree.md)
- 平台表由後台給；顯示名稱和帳號的寫法寫死在裝置上；裝置不認得的平台原樣保留。[ADR-0019](0019-platform-table-from-server-names-on-device.md)
- Android 和 iOS 共用一份 Rust 核心（`device-core/`）：`spec/` 的算法、裝置上的檢查、算證明，不做 I/O、不碰 PIN；畫面、NFC、流程、讀卡的指令在 Kotlin、Swift；網頁版上線時維持 TypeScript。[ADR-0034](0034-apps-share-a-rust-device-core.md)
- 電路檔、驗證金鑰、參數檔和它們的雜湊、名冊規則都內建在 app 裡；後台用 `config` 公布每個平台的最低版本和起算日，太舊的 app 在要 PIN 之前自己停；用生效日的修改要等新版在兩個商店上架。[ADR-0035](0035-app-updates-and-minimum-version.md)

## 頁面和網址

- 島民證明的網址是 `iamreal.tw/p/` 加 10 個字元的短編號，一張卡片一張；`iamreal.tw/threads/@alice` 是查詢頁。[ADR-0020](0020-proof-url-uses-card-short-id.md)
- 頁面說「這張卡片宣告的帳號」，不說「同一個人的帳號」。[ADR-0017](0017-public-platforms-share-one-scope.md)
- 畫面和文字的原則不在 ADR，在 [`docs/design/principles.md`](../design/principles.md)。

## 後台和部署

- 後台全部放在 Cloudflare，用 TypeScript 重寫：一份名冊一個 Durable Object，紀錄的正本在 R2，證明在 Worker 裡驗。新的後台放 `worker/`，和裝置共用的 TypeScript 放 `protocol/`。[ADR-0023](0023-backend-runs-on-cloudflare.md)
- 限流分三層；被打時過卡先讓路；全站的總量上限擋在 `GET /api/v1/config`。[ADR-0026](0026-rate-limiting-in-three-layers.md)
- 測試網站是同一個 Worker 專案的另一個環境，只收真卡片，不定期清空。[ADR-0028](0028-test-site-is-a-second-environment.md)
- 正式網站只從 GitHub Actions 部署，推版本標籤、核准後才部署；部署權杖一個 Worker 一把；快取只有推到 `main` 的執行能存，部署碰不到快取。[ADR-0029](0029-production-deploys-only-from-github-actions.md)
- app 傳到商店的每一個 build 只從 GitHub Actions 建置和上傳；Android 的簽章金鑰自己產生、不放在 GitHub；Android 能逐檔比對，iOS 比不了。[ADR-0036](0036-apps-built-and-uploaded-only-from-github-actions.md)
- 手機 app 只有一個識別碼 `tw.iamreal.app`，上線前連測試網站、上線起連正式網站；連測試網站的是不上傳商店的開發用 build `tw.iamreal.app.dev`；CI 只上傳到測試軌道，正式版由營運者在商店的後台發布。[ADR-0037](0037-one-app-identifier.md)（部分取代 ADR-0036）
- 名冊目錄和清冊存檔每天抄一份副本到 Cloudflare 以外，其他的從名冊重算；重建卡片狀態走「從名冊重建」一個步驟；出事時照 `docs/playbooks/` 做。[ADR-0033](0033-off-site-copy-of-roster-and-crl-archive.md)

## 隱私和營運者看得到什麼

- 連線紀錄記 IP，留 31 天；失敗的請求連內文一起記；對外講到個人資料保護法第 8 條要求的程度。[ADR-0022](0022-connection-log-keeps-ip-for-31-days.md)
- 分析只數事件：不放 cookie、沒有第三方的程式；計數的欄位只能從寫死的表裡選。[ADR-0032](0032-analytics-counts-events-not-people.md)（部分由 ADR-0039 取代）
- 計數可以帶活不過一個月的隨機編號：造訪編號（一次造訪）、過卡裝置編號（31 天換）、嘗試編號（一次過卡）；31 天後對不回名冊上的紀錄；永久保存的只有加總。[ADR-0039](0039-counts-carry-ids-that-live-under-a-month.md)
- 過卡停在哪一步和錯誤代碼當成計數送給後台，裡面沒有匿名編號。[ADR-0032](0032-analytics-counts-events-not-people.md)、[ADR-0016](0016-device-protections-not-set-by-server.md)
- 平常不放 cookie；唯一的例外是緊急時的挑戰頁。[ADR-0026](0026-rate-limiting-in-three-layers.md)

## 程式還沒跟上

2026-11-20 的狀況。做完一項就從這裡拿掉。

| ADR | 程式現在還是 | 票 |
|---|---|---|
| 0022 | 不記 IP；`design/copy/` 還有「請經 VPN 過卡」 | [#20](https://github.com/iamreal-tw/iamreal/issues/20)、[#48](https://github.com/iamreal-tw/iamreal/issues/48) |
| 0025 | 沒有營運者每天的重驗（GitHub Actions 的排程）；Go 的舊後台出快照前自己重驗，已經跟著它刪掉 | 通知在 [#53](https://github.com/iamreal-tw/iamreal/issues/53) |
| 0026 | 沒有限流；`config` 在流程一開始就拿 | [#32](https://github.com/iamreal-tw/iamreal/issues/32) |
| 0027 | 指紋檔沒有另一份 | [#35](https://github.com/iamreal-tw/iamreal/issues/35) |
| 0028 | 每天的重驗沒有多跑一份測試名冊 | 第三份規格 |
| 0029 | 只有測試網站的部署（合併到 main）；沒有推版本標籤部署正式網站的工作流程、production environment、正式的權杖 | [#39](https://github.com/iamreal-tw/iamreal/issues/39) |
| 0033 | 沒有副本、沒有抄副本的工作流程、清冊檔沒有鎖、後台沒有「從名冊重建」、沒有 `docs/playbooks/` | [#102](https://github.com/iamreal-tw/iamreal/issues/102)、[#103](https://github.com/iamreal-tw/iamreal/issues/103)、[#105](https://github.com/iamreal-tw/iamreal/issues/105)、[#106](https://github.com/iamreal-tw/iamreal/issues/106)、[#107](https://github.com/iamreal-tw/iamreal/issues/107)、[#108](https://github.com/iamreal-tw/iamreal/issues/108)、[#109](https://github.com/iamreal-tw/iamreal/issues/109)、[#110](https://github.com/iamreal-tw/iamreal/issues/110)、[#111](https://github.com/iamreal-tw/iamreal/issues/111)；常見問題的那一句在 [#104](https://github.com/iamreal-tw/iamreal/issues/104) |
| 0034 | 沒有 `device-core/`、`android/`、`ios/`；裝置上的檢查（憑證、清冊、電路輸入、建樹的路徑）還沒有寫進 `spec/` | 地圖 [#83](https://github.com/iamreal-tw/iamreal/issues/83) |
| 0035 | `config` 沒有 `min_app`；`docs/api/`、`spec/` 沒有它的讀法；沒有放最低版本的檔案 | 地圖 [#83](https://github.com/iamreal-tw/iamreal/issues/83) |
| 0032、0016 | 頁面不送計數；`design/copy/card-proof.md` 和 `web/README.md` 還寫失敗的原因不回報後台 | [#54](https://github.com/iamreal-tw/iamreal/issues/54) |
| 0039 | 計數不帶編號、型號和版本；`worker/` 的常見問題頁還是「計數裡沒有認得出你的東西」和只寫「請經 VPN 過卡」；島民證明的「下載 app」連結沒有商店的參數 | 待開 |

`worker/` 還沒做完：清冊鏡像、過卡的四個介面、每一種訪客頁面、每天公布名冊有了，限流還沒有（[`worker/README.md`「現在有什麼」](../../worker/README.md#現在有什麼)）。2026-11-19 第一次部署到測試網站：從 Cloudflare 抓得到內政部的兩個清冊網址，只有 `Editor` 權限的權杖也跑得了 Durable Object 的 migration（[`worker/README.md`「第一次部署量到的」](../../worker/README.md#第一次部署量到的)）。測試網站跑的是 `worker/`；Go 的舊後台 `server/` 在 2026-11-22 刪掉了（[#74](https://github.com/iamreal-tw/iamreal/issues/74)）。

## 還沒定

施工時碰到這些，停下來問，不要自己定。

- 連線紀錄和每天的總數存在哪裡、誰讀得到、到期怎麼刪（ADR-0022、ADR-0032；[#20](https://github.com/iamreal-tw/iamreal/issues/20)）
- 重驗沒有通過、排程沒跑時怎麼通知營運者（ADR-0025、ADR-0027；[#53](https://github.com/iamreal-tw/iamreal/issues/53)）
- 頁面的資料撐不住時搬到 KV 還是 D1（ADR-0026）
- 正式名冊開張當天，測試名冊怎麼處理（ADR-0028）
- 其他服務的場合：格式保留了 `S` 開頭（ADR-0007），算式和整個做法還沒有設計；公開名冊和其他服務的場合之間要不要讓人自願連起來也沒有設計（ADR-0013）
- 可重現的建置和檔案雜湊，上線前做還是上線後做（ADR-0029）

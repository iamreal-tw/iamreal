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

## 頁面和網址

- 島民證明的網址是 `iamreal.tw/p/` 加 10 個字元的短編號，一張卡片一張；`iamreal.tw/threads/@alice` 是查詢頁。[ADR-0020](0020-proof-url-uses-card-short-id.md)
- 頁面說「這張卡片宣告的帳號」，不說「同一個人的帳號」。[ADR-0017](0017-public-platforms-share-one-scope.md)
- 畫面和文字的原則不在 ADR，在 [`docs/design/principles.md`](../design/principles.md)。

## 後台和部署

- 後台全部放在 Cloudflare，用 TypeScript 重寫：一份名冊一個 Durable Object，紀錄的正本在 R2，證明在 Worker 裡驗。新的後台放 `worker/`，和裝置共用的 TypeScript 放 `protocol/`。[ADR-0023](0023-backend-runs-on-cloudflare.md)
- 限流分三層；被打時過卡先讓路；全站的總量上限擋在 `GET /api/v1/config`。[ADR-0026](0026-rate-limiting-in-three-layers.md)
- 測試網站是同一個 Worker 專案的另一個環境，只收真卡片，不定期清空。[ADR-0028](0028-test-site-is-a-second-environment.md)
- 正式網站只從 GitHub Actions 部署，推版本標籤、核准後才部署；部署權杖一個 Worker 一把。[ADR-0029](0029-production-deploys-only-from-github-actions.md)

## 隱私和營運者看得到什麼

- 連線紀錄記 IP，留 31 天；失敗的請求連內文一起記；對外講到個人資料保護法第 8 條要求的程度。[ADR-0022](0022-connection-log-keeps-ip-for-31-days.md)
- 分析只數事件：不放 cookie、不放識別碼、沒有第三方的程式；計數的欄位只能從寫死的表裡選。[ADR-0032](0032-analytics-counts-events-not-people.md)
- 過卡停在哪一步和錯誤代碼當成計數送給後台，裡面沒有匿名編號。[ADR-0032](0032-analytics-counts-events-not-people.md)、[ADR-0016](0016-device-protections-not-set-by-server.md)
- 平常不放 cookie；唯一的例外是緊急時的挑戰頁。[ADR-0026](0026-rate-limiting-in-three-layers.md)

## 程式還沒跟上

2026-11-19 的狀況。做完一項就從這裡拿掉。

| ADR | 程式現在還是 | 票 |
|---|---|---|
| 0021 | `GET /api/v1/head` 和 `card-state` 的 `head` 回的是目前存著的全部紀錄的名冊指紋，不是最近一次公布的那一行 | [#70](https://github.com/iamreal-tw/iamreal/issues/70) |
| 0022 | 不記 IP；`design/copy/` 還有「請經 VPN 過卡」 | [#20](https://github.com/iamreal-tw/iamreal/issues/20)、[#48](https://github.com/iamreal-tw/iamreal/issues/48) |
| 0023 | `server/` 是 Go 加 SQLite | 地圖 [#1](https://github.com/iamreal-tw/iamreal/issues/1) |
| 0025 | 後台每天出快照時自己重驗 | 通知在 [#53](https://github.com/iamreal-tw/iamreal/issues/53)，備份在 [#51](https://github.com/iamreal-tw/iamreal/issues/51) |
| 0026 | 沒有限流；`config` 在流程一開始就拿 | [#32](https://github.com/iamreal-tw/iamreal/issues/32) |
| 0027 | 檔案在後台的 `/roster/` 底下 | [#34](https://github.com/iamreal-tw/iamreal/issues/34)、[#35](https://github.com/iamreal-tw/iamreal/issues/35) |
| 0028 | 測試網站只部署了 `worker/` 的骨架：每個網址回 `404`，不能過卡，沒有測試名冊和它的標示 | [#37](https://github.com/iamreal-tw/iamreal/issues/37) |
| 0029 | 沒有部署的工作流程 | [#39](https://github.com/iamreal-tw/iamreal/issues/39) |
| 0032、0016 | 頁面不送計數；`design/copy/card-proof.md` 和 `web/README.md` 還寫失敗的原因不回報後台 | [#54](https://github.com/iamreal-tw/iamreal/issues/54) |

`worker/` 現在只有骨架（每小時把內政部的清冊原始檔存進 R2、測試專用的建置），2026-11-19 第一次部署到測試網站：從 Cloudflare 抓得到內政部的兩個清冊網址，只有 `Editor` 權限的權杖也跑得了 Durable Object 的 migration（[`worker/README.md`「第一次部署量到的」](../../worker/README.md#第一次部署量到的)）。後台現在還是 Go 的 `server/`。

## 還沒定

施工時碰到這些，停下來問，不要自己定。

- 連線紀錄和每天的總數存在哪裡、誰讀得到、到期怎麼刪（ADR-0022、ADR-0032；[#20](https://github.com/iamreal-tw/iamreal/issues/20)）
- 重驗沒有通過、排程沒跑時怎麼通知營運者（ADR-0025、ADR-0027；[#53](https://github.com/iamreal-tw/iamreal/issues/53)）
- 備份放在哪裡、怎麼還原（ADR-0025；[#51](https://github.com/iamreal-tw/iamreal/issues/51)）
- 頁面的資料撐不住時搬到 KV 還是 D1（ADR-0026）
- 正式名冊開張當天，測試名冊怎麼處理（ADR-0028）
- 其他服務的場合：格式保留了 `S` 開頭（ADR-0007），算式和整個做法還沒有設計；公開名冊和其他服務的場合之間要不要讓人自願連起來也沒有設計（ADR-0013）
- 可重現的建置和檔案雜湊，上線前做還是上線後做（ADR-0029）
- 手機 app 的計數：步驟表、用不用第三方的 SDK（ADR-0032）

---
status: accepted
---

# 限流分三層，被打時過卡先讓路

> 補充：Worker 裡分開算的請求多一種，計數（ADR-0032）。
>
> 補充（2026-11-26，[#418](https://github.com/iamreal-tw/iamreal/issues/418)）：再多一種，公開的讀取（`GET /api/v1/config`、`fingerprint`、`rebuild`），三個合起來算。後兩個每次都問 Durable Object；`config` 不問，放在這一類是因為它同樣是誰都能隨時問的讀取。

會打到 Durable Object 的請求，由三層限流擋：Cloudflare 自動的 DDoS 防護、一條 WAF 的限流規則、Worker 裡的 Rate Limiting binding。請求多到撐不住時，先放掉過卡，留住訪客的頁面；全站的總量上限擋在「開始過卡」，持卡人在插卡之前就知道現在人太多。

ADR-0023 讓讀取和寫入擠在同一個 Durable Object：題目、卡片現況、送出不能快取，訪客的頁面在網址每個都不同時快取幫不上。一個 Durable Object 的軟上限是每秒 1,000 個請求，做的事越多越低（[limits](https://developers.cloudflare.com/durable-objects/platform/limits/)、[rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)）；用量估計的頁面尖峰也是每秒 1,000 個（[用量估計](https://github.com/iamreal-tw/iamreal/issues/2)）。

## 誰先讓路

用量估計定的是：訪客看島民證明、查詢頁一個月停不超過 1 小時；過卡可以停，最長 24 小時。所以**頁面優先，過卡先讓路**。已經接受的紀錄不受影響：Durable Object 寫完才回應（ADR-0023）。

這裡的頁面優先，指的是過卡的負擔不拖垮頁面。攻擊者輪著打每一張真的島民證明時，頁面和過卡會一起倒：短編號從公開的證明紀錄就拿得到，每一頁都是一次快取沒命中，照 IP 的上限也擋不住很多 IP。那時的做法在下面「緊急時的挑戰頁」和 Consequences。

## 三層

1. **Cloudflare 自動的 DDoS 防護**：每個方案都開著，不用設定。
2. **一條 WAF 的限流規則**，當外層：會打到 Durable Object 的路徑合起來，只照 IP 算，上限寬鬆。被 WAF 擋下的請求不再往下處理，Worker 的請求數也不算它（[feature interoperability](https://developers.cloudflare.com/waf/feature-interoperability/)、[Workers metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)）。
3. **Worker 裡的 Rate Limiting binding**（[文件](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)），做 WAF 在這個方案做不到的兩件事：
   - **四種請求分開算**：題目、卡片現況、送出、頁面（只算沒命中快取、跑到 Worker 的）。一次過卡只用約 4 個請求，看頁面的次數多得多，不放在同一個桶子裡。
   - **IPv4 照單一位址，IPv6 照 /64 前綴算。** 一台機器通常分到一整段 /64；WAF 的限流規則照完整的位址算（[`ip.src`](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/ip.src/)），等於沒有上限。

   計次的鍵由一個函式產生，現在是請求的種類加上 IP。之後的查詢介面發金鑰時，帶金鑰的請求改用金鑰當鍵。

每一種的上限是共用 IP 的家庭或辦公室也用不完的量：擋的是單一來源的大量請求，不是擋人。

## 全站的總量上限

照 IP 算的上限擋不住很多 IP 一起來，所以另外有一個不照 IP 的上限：**全站每分鐘開始過卡的次數**。

- **擋在 `GET /api/v1/config`。** 過卡的頁面在持卡人按下「開始」之後、讀卡之前先要設定（平台表、清冊可以多舊）；這個請求由 Worker 回答，不經過 Durable Object，擋在這裡不增加它的負擔。
- 被擋的人在插卡之前看到「現在人太多，請稍後再來」。
- 通過的人照常往下做。過卡途中 Durable Object 撐不住時，照下一節。
- Rate Limiting binding 是每個 Cloudflare 機房分開算的近似值；台灣的連線大多進同一個機房，實際上接近全站的量。

## Durable Object 撐不住時

Durable Object 回 `overloaded` 時（文件說這個錯誤不要重試，[error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)）：

- 過卡的介面回 `503`，畫面和被限流的相同。
- 頁面回一頁「現在人太多」的 HTML，附 `Retry-After`。

## 不碰 Durable Object 就能回答的先回答

- **格式不對的網址直接 `404`**：短編號照 ADR-0020 的讀法換算之後（不分大小寫，`O` 讀成 `0`，`I` 和 `L` 讀成 `1`）不是 10 個 Crockford base32 字元、帳號不合平台的格式，Worker 不問 Durable Object。
- **查不到的頁面和查得到的一樣快取 60 秒。** 回應自己帶 `Cache-Control`；沒帶時，Workers 的快取把 `404` 放 3 分鐘（[Workers cache](https://developers.cloudflare.com/workers/cache/configuration/)）。

## 被擋的人看到什麼

- **介面**：`429` `rate_limited`，附 `Retry-After`。題目、卡片現況、送出被擋時，過卡的頁面都顯示「送不出去」和「再試一次」，重試不必重新插卡。
- **頁面**：一頁 `429` 的 HTML，一句白話：這個網路送出的請求太多，請過一分鐘再試。不提 IP。
- 文字在 `design/copy/`。

## 緊急時的挑戰頁

限流和總量上限都開著，頁面還是撐不住時，營運者手動打開 Cloudflare 的挑戰頁，事後關掉，並公告開了多久。

- **事先做好**：一條 WAF 的自訂規則，動作是 Managed Challenge，平時關著。不用整站的 I'm Under Attack 模式。
- **只套在訪客的頁面**（首頁、島民證明、查詢頁、證明紀錄頁）。不套在 `/api/`、`/proof` 的檔案、證明紀錄和清冊的下載：挑戰頁回的是一整頁 HTML，頁面裡的 `fetch()` 會直接失敗（[challenge pages](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/)），過卡、重驗的工具和之後的擴充功能都會壞。
- **對外照實寫**：通過檢查後 Cloudflare 放一個 `cf_clearance` cookie，預設 30 分鐘後失效，只用來記得通過了檢查（[challenge passage](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/challenge-passage/)、[Cloudflare cookies](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/cloudflare-cookies/)）；這段時間用程式讀頁面會被擋，請改下載紀錄檔案。平常不放任何 cookie 的說法不變。

## 連線紀錄

被限流擋下的 `429` **不記連線紀錄**，什麼都不寫。連線紀錄只記被伺服器算了一次的送出一筆（ADR-0022）；被擋的請求在讀內文、問 Durable Object 之前就回答了，沒有被算，也不算進題目的 5 次。被打時量大的就是這一種，記了，紀錄的量就由送請求的人決定。Durable Object 撐不住時的 `503` 照同一條：還沒被算就撐不住的不記；算了一次之後才撐不住的那一筆，是沒有成功的送出，照 ADR-0022 記。被 WAF 擋下的請求不會跑到 Worker，只在 Cloudflare 的 Security Events。（2026-11-26 改，[#418](https://github.com/iamreal-tw/iamreal/issues/418)；原本寫的是「補充 ADR-0022：被限流擋下的 `429`、Durable Object 撐不住時的 `503` 不記內文，只記一般的欄位（請求編號、時間、介面、結果、錯誤代碼、IP、國家代碼、網路業者的編號）」，那是連線紀錄每個請求都記的時候。）

## 數字

每一種的上限、WAF 外層規則的上限、全站的總量上限都是推估的起始值，放在設定裡，照量測和 Cloudflare 的分析裡被擋的量調整（2026-11-26 改；原本寫的是「照連線紀錄裡被擋的量調整」，被擋的請求現在不進連線紀錄）。調整不寫 ADR。

理由：

- **能用 Cloudflare 的就用。** 擋大量的惡意流量是 Cloudflare 的專業；自己寫的只有它在這個方案做不到的部分（分種類、IPv6 的 /64、總量上限），而且用的也是它的 binding。
- **一條 WAF 規則就夠當外層。** Free 方案只有 1 條限流規則、計數期間 10 秒（[rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/)）；細的分法放在 Worker，不必為了規則的數量換方案。
- **總量上限擋在開始，不擋在題目。** 題目在第一次簽章之後才要，擋在那裡，持卡人已經插卡、輸入過 PIN 才失敗。

## Considered Options

- **只用 WAF 的規則**：每個方案都只能照完整的 IP 算，IPv6 擋不住；Free 方案只有一條規則，分不了種類。
- **只在 Worker 裡做**：被擋的請求每個都跑一次 Worker；單一來源的大量請求，在 WAF 擋最省。
- **只照 IP，不分種類**：一個上限要同時容得下看很多頁面的人和偶爾過卡的人，對過卡的請求太鬆。
- **全站的總量上限擋在題目**：頁面不用改請求的順序；被擋的人已經插卡、輸入過 PIN。
- **不設總量上限，只靠 Durable Object 自己回 `overloaded`**：撐不住時頁面和過卡一起失敗，沒有誰先讓路。
- **整站的 I'm Under Attack 模式**：過卡的介面、下載、程式化的讀取全部一起擋。
- **被擋的請求也記內文**：被打時量大，內文對查問題沒有用。

## Consequences

- **過卡的頁面改請求的順序**：`GET /api/v1/config` 移到按下「開始」之後、讀卡之前；它的 `503` 在讀卡之前顯示「現在人太多」。`docs/api/card-proof.md` 在 `config`、`card-state` 加上 `429`、`503`，每個 `429` 附 `Retry-After`。
- **通過開始那一關的人，之後仍可能遇到 Durable Object 撐不住。** 那時已經插過卡；畫面讓他重試，不必重新開始。
- **隱私權說明加挑戰頁的那一段**，和平常不放 cookie 的說法放在一起。
- **還沒查到、要在測試網站上看的**：WAF 的限流規則會不會連快取命中的請求一起算（所以外層的上限訂得比 Worker 寬很多）；Workers 的快取哪些方案能用、快取命中時 WAF 還跑不跑；Rate Limiting binding 的計數存在哪裡、留多久。
- **頁面真的被輪著打時**，先打開挑戰頁，再把頁面的資料搬出 Durable Object；搬到 KV 還是 D1（ADR-0023 寫的是 D1），到時候再定，資料都從紀錄重建得出來。讀取量量出來撐不到尖峰時也一樣。為了改得快，施工時頁面讀資料經過一個換得掉的介面。這一份的三層不變。
- **挑戰頁開著的期間**，訪客要先過一次檢查；平台抓連結預覽的程式過不了，那段時間貼出去的島民證明連結可能沒有預覽。
- 查詢介面的金鑰怎麼申請、額度多少，跟查詢介面一起定。

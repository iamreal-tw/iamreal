---
status: accepted
---

# 正式網站只從 GitHub Actions 部署，部署金鑰一個 Worker 一把

正式網站只從 GitHub Actions 部署：營運者推一個版本標籤，核准之後才部署。測試網站在合併到 `main` 時自動部署，營運者的電腦也可以直接部署。部署用的 Cloudflare 權杖照 Worker 分開，能部署正式網站的那一把只放在 GitHub 上。

金鑰誰保管、怎麼保管，不寫在這裡。

## 怎麼部署

| | 測試網站 | 正式網站 |
|---|---|---|
| 什麼時候 | 合併到 `main` 之後自動部署；營運者也可以從自己的電腦部署 | 營運者推一個版本標籤，在 GitHub 上核准之後 |
| 從哪裡 | GitHub Actions，或營運者的電腦 | 只從 GitHub Actions |
| 前提 | 無 | 標籤指到的提交，Actions 已經把它部署到測試網站；沒有就直接失敗 |

- **版本標籤用日期**，例如 `v2026.11.20`；同一天第二次加 `.1`。網站沒有「相容」的問題，用不到語意化版本號。
- **從營運者的電腦部署測試網站**，是為了開發時能直接部署、看結果。下一次合併到 `main` 時，Actions 部署的版本會蓋掉它，所以預演跑的仍然是 `main` 上的程式。
- **退回舊版**：對舊的標籤重跑一次部署的工作。

## 金鑰分層

Cloudflare 的 API 權杖可以只給一個 Worker 的 `Editor`，能部署那個 Worker、改它的設定和密鑰，碰不到同一個帳號裡的其他 Worker（[Workers authorization](https://developers.cloudflare.com/workers/authorization/workers/)）。兩個環境放在同一個帳號（ADR-0028），靠這個分開。

| 層 | 是什麼 | 放在哪裡 |
|---|---|---|
| 帳號 | GitHub 組織的 owner、Cloudflare 帳號的 Super Administrator、網域註冊商、註冊網域的信箱 | 營運者本人，用實體安全金鑰登入。不產生能代表這些帳號的長期權杖 |
| 正式部署 | Cloudflare 權杖，只有正式的 Worker 的 `Editor` | 只放在 GitHub 的 `production` environment |
| 測試部署 | Cloudflare 權杖，只有測試的 Worker 的 `Editor`，兩把 | 一把放 GitHub 的 `test` environment，一把放營運者電腦上的 `.env.local`；可以分別撤銷 |
| 不用金鑰 | PR 的檢查、每天的重驗（ADR-0025）、抄指紋檔（ADR-0027） | |

- **營運者的電腦上不用 `wrangler login`。** 它的授權不能只給一個 Worker（[Workers authorization](https://developers.cloudflare.com/workers/authorization/)）；電腦上跑的程式和 coding agent 就碰得到正式網站。
- **營運者電腦上的 coding agent 不推版本標籤、不核准正式部署。** 電腦上的 `gh` 登入的是營運者，GitHub 分不出核准的是人還是 agent，所以靠營運者本機的設定擋。
- **部署的權杖做不到的事，營運者在 Cloudflare 的儀表板手動做**：建立 Worker、自訂網域、R2 儲存桶和它的 CORS、WAF 和限流的規則。只給一個 Worker 的權杖建立不了新的 Worker，也改不了自訂網域（[Workers authorization](https://developers.cloudflare.com/workers/authorization/workers/)）。這些事一年做不到幾次，步驟寫在營運者的說明裡。要比 `Editor` 大的權限時，臨時做一把權杖，用完刪掉。
- **R2 只有 Worker 透過 binding 寫**，沒有 R2 的 API 權杖。部署本來就不需要 R2 的權限（[Workers authorization](https://developers.cloudflare.com/workers/authorization/)）。
- **`iamreal-tw/fingerprints` 只有它自己的排程用自己的 `GITHUB_TOKEN` 提交。** 外人對它開的 PR 不合併：那份檔案只該由排程寫。
- **GitHub 組織和 Cloudflare 帳號的 admin 只有營運者一個人。** 營運者自己進不去時，靠備用碼和實體安全金鑰。

## 外人的 PR

- **工作流程只用 `pull_request` 觸發，不用 `pull_request_target`。** 從 fork 開的 PR，`pull_request` 拿不到 secrets，`GITHUB_TOKEN` 只能讀（[events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)）。`pull_request_target` 跑的是 `main` 上的工作流程、拿得到 secrets；在裡面 checkout 再執行 PR 的程式，就是讓外人的程式拿到金鑰（[Preventing pwn requests](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/)）。
- **所有外部貢獻者的工作流程，都要營運者先核准才跑**（「Require approval for all external contributors」，[managing GitHub Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)）。
- **PR 上只跑 `CONTRIBUTING.md`「完成的定義」那些檢查**，端到端測試用假卡片、在 CI 裡跑，不打已經部署的網站。
- **建置和部署是兩個工作。** 部署的工作拿得到權杖，建置的工作拿不到。
- **合併之後，PR 的程式會在拿著權杖的工作裡執行**：合併到 `main` 就部署測試網站，推標籤時再部署正式網站。所以審外人的 PR 時，部署會執行到的東西逐行看，要看哪些寫在 `CONTRIBUTING.md`。

## 緊急時

只有兩件事可以不經過 Actions，直接在 Cloudflare 的儀表板做：

- **退回舊版。** 儀表板可以退回最近 100 個版本之一，不用重新上傳，Cloudflare 記下是誰退的（[rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)）。
- **停止收過卡**（ADR-0025）。

做完之後開一張公開的 issue，寫明做了什麼、為什麼。其他任何變更都經過 Actions。

## 理由

- **正式網站只從 Actions 部署，是為了不讓能部署它的金鑰放在跑 coding agent 的電腦上。** 營運者的電腦上，每個 agent、每次安裝套件時跑的腳本，都和那把金鑰在同一台機器上。放在 GitHub 上，只有部署的那一個工作拿得到，而且要營運者核准。
- **公開的部署紀錄不是用來讓人信任的。** 營運者是 Cloudflare 帳號的 admin，能從儀表板部署別的版本，Actions 的紀錄看不到；網頁也可能只對特定的人送改過的版本。後台的信任來自公開的名冊，收錯一筆，用另一份實作重驗會發現（ADR-0025）。過卡的頁面要能檢查，靠的是任何人能拿一個提交自己建置、和網站送出的檔案比對。Actions 的紀錄是順手得到的時間表。
- **測試網站要能從營運者的電腦部署**，開發時才能直接部署、直接看結果，不必每次都等合併。測試的權杖碰不到正式的 Worker，所以這樣做不會擴大正式網站的風險。
- **營運者只有一個人**，所以 admin 也只有一個人。多一個 admin 是多一個可以被攻破的帳號，對外也要說明這個人是誰。

## Considered Options

- **兩個環境都從營運者的電腦部署**：開發最快，但能部署正式網站的金鑰會放在跑 coding agent 的電腦上。
- **合併到 `main` 就連正式網站一起部署**：沒有人要按，但每一版沒有在測試網站上停留的時間，預演（ADR-0028）就沒有作用。
- **兩個環境共用一把部署的權杖**：Cloudflare 官方的 GitHub Actions 說明用的範本「Edit Cloudflare Workers」，涵蓋帳號裡所有的 Worker（[API token templates](https://developers.cloudflare.com/fundamentals/api/reference/template/)）。合併時自動部署測試網站的那個工作，就拿得到能部署正式網站的金鑰。
- **另開一個 Cloudflare 帳號給測試網站**：ADR-0028 沒有採用。只給一個 Worker 的權杖已經把兩個環境的部署分開。
- **用 Terraform 管 Cloudflare 的設定**：設定可以寫在程式庫裡，但要一把能改整個帳號的長期權杖，這些設定一年也改不了幾次。
- **Cloudflare 的 Workers Builds**：要在 GitHub 組織裝 Cloudflare 的 app（[GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)），文件沒有寫它對 fork 開的 PR 怎麼處理；部署前要人核准、確認部署過測試網站，也要另外想辦法。
- **找第二個人當 admin**：營運者不在時有人能處理。等營運轉給組織時重開。

## Consequences

- **程式庫公開之前，GitHub 的幾項設定還不能用。** 免費方案的私有程式庫沒有 environment 的 secrets、部署前要人核准、只允許標籤部署的規則（[deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)）。公開之前只有測試網站，測試的權杖先放在程式庫的 secrets；正式名冊開張當天建立兩個 environment、把測試的權杖搬進去、做正式的權杖。
- **Durable Object 的遷移要什麼權限，文件沒有寫。** 施工時實測；`Editor` 做不到時，用上面「臨時做一把」的做法。2026-11-19 實測：只有 `Editor` 權限的權杖跑得了建立類別的遷移，改名和刪除類別的沒有試過（[`worker/README.md`「第一次部署量到的」](../../worker/README.md#第一次部署量到的)）。
- **外人的 PR 在合併之前跑不到部署；合併之後才部署。** 有問題要等合併到 `main`、部署到測試網站才看得到。
- **可重現的建置和檔案雜湊**要做到「任何人能拿一個提交自己建置、和網站送出的檔案比對」，不靠部署紀錄。

# .github/：GitHub Actions 的工作流程

**這個目錄讓人檢查的事：PR 的檢查拿不到任何權杖，部署測試網站的權杖只在上傳的那一步。**（ADR-0029）

| 檔案 | 什麼時候跑 | 做什麼 |
|---|---|---|
| [`workflows/checks.yml`](workflows/checks.yml) | 每個 PR（`pull_request`） | `CONTRIBUTING.md`「完成的定義」的每一項；只能讀，不引用任何 secret |
| [`workflows/deploy-test.yml`](workflows/deploy-test.yml) | 推到 `main` | 打包、檢查，再把那一包上傳到測試網站 |

怎麼部署、上傳那一步還信任什麼：[`worker/README.md`「從 GitHub Actions 部署」](../worker/README.md#從-github-actions-部署)。

## 在本機檢查

工作流程本身在本機跑不起來。檢查它們的規則在 [`worker/test/workflows.ts`](../worker/test/workflows.ts)，測試在 `worker/test/workflows.test.ts`：

```sh
pnpm install --frozen-lockfile   # 在根目錄
cd worker
node --experimental-strip-types --test test/workflows.test.ts
```

`worker/` 的 `pnpm test` 也包括它。這些規則防手誤和明顯的改動，不能代替逐行看（`CONTRIBUTING.md`「部署會執行到的東西」）。

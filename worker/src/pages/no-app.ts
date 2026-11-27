// The page for a phone without the app, on the app domain (src/app-domain.ts):
// design/copy/app-domain.md. A document of its own, not the visitors'
// layout: the app domain has no other page, so there is no navigation bar
// and no foot, and its one link to the site is written whole. No script: it
// tells no device from another and sends nobody anywhere by itself. No link
// preview and no counts (#527). On a test log's site it has the mark of a
// test log above everything else (design/copy/test-site.md), as every page
// of the site has.
import { html } from "./html.ts";
import { CSS_PATH, FAVICON_PATH, type Site, testProofLogMark } from "./layout.ts";

/**
 * The store's test the test site's page links to (app-domain.md): before
 * launch, the production app's closed test on Google Play (ADR-0040). The
 * iPhone's, on TestFlight, is not there yet: the production app has no public
 * link of TestFlight yet (#535). Written whole, for the deploy build's check of
 * addresses (scripts/deploy-build-checks.ts, `PAGE_ADDRESSES`).
 */
export const GOOGLE_PLAY_TEST = "https://play.google.com/apps/testing/tw.iamreal.app";

/** The page of a test log's app domain: a site with the date its log was last cleared on. There is none of the production log's yet: it is made at launch (app-domain.md). */
export function noAppPage(site: Site & { readonly testProofLogClearedOn: string }): string {
  const title = "「島民證明」測試版 app";
  return html`<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}｜島民證明</title>
<link rel="stylesheet" href="${CSS_PATH}">
<link rel="icon" href="${FAVICON_PATH}">
</head>
<body class="no-app">
${testProofLogMark(site.testProofLogClearedOn)}
<main>
<h1 class="title">${title}</h1>
<p>用手機感應自然人憑證，換一張島民證明。不需要讀卡機。</p>
<p class="stores"><a class="button" href="${GOOGLE_PLAY_TEST}">Android：加入 Google Play 測試</a></p>
<p class="small">Android 要先被加進測試名單。</p>
<h2>已經裝了 app？</h2>
<p>直接從手機的主畫面打開「島民證明」。從哪裡打開，接下來的步驟都一樣。</p>
<p class="small">需要有 NFC 的手機：iPhone（iOS 15 以上）或 Android（10 以上）。</p>
<p class="back"><a href="https://${site.host}/">回到 ${site.host}</a></p>
</main>
</body>
</html>
`.text;
}

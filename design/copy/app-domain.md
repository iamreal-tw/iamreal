# 沒裝 app 時的那一頁

app 網域（`GLOSSARY.md`「app 網域」，ADR-0040）上給人看的那一頁。在手機上打開 app 網域的網址，裝了 app 就直接打開 app，看不到這一頁；沒裝 app、或系統沒有把網址交給 app 時落在這裡。原則在 `docs/design/principles.md`。

- app 網域上除了兩個給系統讀的檔（`/.well-known/assetlinks.json`、`/.well-known/apple-app-site-association`），每一個網址都是這一頁，狀態碼 `200`，帶查詢字串的也一樣。`/.well-known/` 底下的其他網址是 `404`
- 不看是哪一種手機、不自動轉址：兩個商店的連結都列出來，看的人自己選
- 沒有導覽列和頁尾：app 網域上除了這一頁沒有別的頁面，網站的連結都在「回到」那一行
- 不送計數，不放連結預覽
- 正式的那一頁（`app.iamreal.tw`）上線時才做，第一版的句子在 [#135](https://github.com/iamreal-tw/iamreal/issues/135)

## 測試網站（`test-app.iamreal.tw`）

最上面有測試的證明紀錄的標示（`test-site.md`）。

```
「島民證明」測試版 app

用手機感應自然人憑證，換一張島民證明。不需要讀卡機。

[ Android：加入 Google Play 測試 ](https://play.google.com/apps/testing/tw.iamreal.app)
Android 要先被加進測試名單。

已經裝了 app？
直接從手機的主畫面打開「島民證明」。從哪裡打開，接下來的步驟都一樣。

需要有 NFC 的手機：iPhone（iOS 15 以上）或 Android（10 以上）。

[ 回到 test.iamreal.tw ](https://test.iamreal.tw/)
```

- 第一行是標題，也是分頁的標題（`「島民證明」測試版 app｜島民證明`）
- 商店的連結畫成按鈕
- 上線前，連結是正式 app（`tw.iamreal.app`）的測試：Android 的測試者在正式 app 的封閉測試。上線那天換成測試 app（`tw.iamreal.app.test`）的
- iPhone 的那一顆「iPhone：加入 TestFlight 測試」和「要先裝好 TestFlight。」還沒有：正式 app 的 TestFlight 還沒有外部測試的群組，沒有公開連結。有了之後補回來（[#535](https://github.com/iamreal-tw/iamreal/issues/535)），放在 Android 那一顆之前，連到正式 app 的 TestFlight 公開連結（iPhone 的測試者用正式 app 的 TestFlight，ADR-0040「iOS 的測試 app 上線前不發給營運者以外的人」），「要先裝好 TestFlight。」放在「Android 要先被加進測試名單。」之前
- 系統版本的下限是兩個 app 建置的下限：iOS 15（`ios/Config/Shared.xcconfig`）、Android 10（API 29，`android/app/build.gradle.kts`）
- 「回到 test.iamreal.tw」連到測試網站的首頁

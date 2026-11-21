# app（Android、iOS）

只在手機 app 上出現、不屬於任何一個流程的文字。過卡的畫面在 `card-proof.md`。原則在 `docs/design/principles.md`。

## 主畫面上的名稱

手機主畫面上，app 圖示底下的名稱。同一個 app 有兩種 build（ADR-0037），兩個可以同時裝在一支手機上，各有一個名稱。

### 商店的 build

識別碼 `tw.iamreal.app`，從 Google Play、App Store 裝的那一個：

```
島民證明 測試
```

- 上線前它連的是測試網站，名稱要看得出是測試。上線那天改連正式網站時，這個名稱一起改

### 開發用 build

識別碼 `tw.iamreal.app.dev`，不上傳商店，營運者用線裝：

```
島民證明 dev
```

- 它永遠連測試網站。和商店的 build 裝在同一支手機上時，靠這個名稱分出哪一個是哪一個

### 兩種 build 都適用的

- 「島民證明」和後面的字之間是一個半形空格
- 這是第一版。正式的名稱在「[app 的名稱、商店頁和上架的地區](https://github.com/iamreal-tw/iamreal/issues/154)」定；定了之後改這裡，Android 和 iOS 一起改
- Android 和 iOS 的測試讀這一段，確認每一種 build 安裝檔裡的名稱和它相同

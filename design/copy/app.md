# app（Android、iOS）

只在手機 app 上出現、不屬於任何一個流程的文字。過卡的畫面在 `card-proof.md`。原則在 `docs/design/principles.md`。

`app.json` 是這一份給程式讀的形式，兩個 app 建置時原樣包進去。這裡每一個程式碼區塊的每一行是它的一個值，它的每一個值也都是這裡的一行，Android 的測試雙向核對（`AppCopyTest`），也核對每一種 build 的名稱在它自己的鍵底下（`AppNameTest`）。

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

## 啟動畫面

打開 app 時，畫面中間是記號，下面是服務的名稱和網站的名字，中間用一條線隔開（`design/DESIGN.md` 的導覽列）：

```
島民證明
iamreal.tw
```

- 測試網站的 build 也寫 `iamreal.tw`，和網頁的頁首相同（`test-site.md`）

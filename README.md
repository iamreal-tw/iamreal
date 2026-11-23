# iamreal

讓持卡人用一張有效的台灣自然人憑證換一張島民證明：把這張卡片在 Threads 的名額公開宣告給一個 Threads 帳號，用零知識證明保護持卡人的身分。

## 現在的狀態

**還沒上線。** 這個程式庫在上線前就公開，方便檢查和討論；程式還在開發中：

- 協定規格（`spec/`）、紀錄的格式、API 都還會改，改的時候不保證和舊版相容
- 測試網站 `test.iamreal.tw` 是上線前的封閉試用，不宣傳。它只收真的自然人憑證，證明紀錄不定期清空（ADR-0028）
- 正式的網站還沒開放

## 從哪裡開始讀

- `CLAUDE.md`：硬限制、目錄的分工（每個目錄讓人檢查哪一件事）
- `GLOSSARY.md`：用詞
- `docs/adr/README.md`：設計決策的索引
- `CONTRIBUTING.md`：每個變更要符合的規範

每個目錄的 `README.md` 寫了它讓人檢查什麼、怎麼單獨執行。

## 授權

Apache License 2.0，見 `LICENSE`。

`design/fonts/` 裡的字型不在這個授權裡，照它自己的授權（見下面的致謝）。

## 致謝

- 標題用的字型是[源流明體 TW](https://github.com/ButTaiwan/genryu-font)（GenRyuMin2 TW），柯志杰（ButTaiwan）製作，以 SIL Open Font License 1.1 授權。這裡用的是粗（B）一個字重的子集，授權和來源寫在 `design/fonts/`。

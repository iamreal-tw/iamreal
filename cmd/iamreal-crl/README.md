# iamreal-crl

檢查一份內政部的廢止清冊、重建它的樹根、算「不在樹裡」的證明。只引用 `crl/`；用法、輸出的欄位、拿內政部的清冊重算樹根的步驟，見 [`crl/README.md`](../../crl/README.md)。

```
go build -o iamreal-crl ./cmd/iamreal-crl
iamreal-crl check -issuer G3 MOICA-G3-complete.crl
```

測試時，`-key-g2 FILE`、`-key-g3 FILE` 讓測試用的金鑰代替內政部的 G2、G3 發證金鑰（`check`、`prove`、`index` 都可以用），標準錯誤會印一行 `WARNING`；索引裡用它驗過的行仍寫 `G2`、`G3`。見 `crl/README.md`「測試用的發證金鑰」。

# iamreal-crl

檢查一份內政部的廢止清冊、重建它的樹根、算「不在樹裡」的證明。只引用 `crl/`；用法、輸出的欄位、拿內政部的清冊重算樹根的步驟，見 [`crl/README.md`](../../crl/README.md)。

```
go build -o iamreal-crl ./cmd/iamreal-crl
iamreal-crl check -issuer G3 MOICA-G3-complete.crl
```

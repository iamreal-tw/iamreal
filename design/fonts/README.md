# design/fonts

標題用的源流明體 TW（GenRyuMin2 TW），粗（B）一個字重的子集。為什麼用它、怎麼用，見 `design/DESIGN.md`「字」。

| 檔 | 內容 |
|---|---|
| `GenRyuMin2TW-B.woff2` | 子集，正本 |
| `OFL.txt` | 授權（SIL Open Font License 1.1），源流明體的程式庫附的那一份 |
| `subset.sh` | 重新產生子集的腳本 |

## 從哪裡來

[ButTaiwan/genryu-font](https://github.com/ButTaiwan/genryu-font) 的 v2.100（2024-08-22），`otf/TW/GenRyuMin2TW-B.otf`，釘在那一版的 commit `b973b7bd3210a8651131046d9e0cfb9e1aa51b36`。腳本下載後先核對 SHA-256（`5e7d2c11…12d5da`）才讀。

子集收 `design/copy/` 每個檔的每一個字，加上可列印的 ASCII（U+0020 到 U+007E：帳號名稱、日期、數字不寫在 `design/copy/`）。字型的 name 表保留 13（授權說明）、14（授權網址）：OFL 要每一份散佈的字型都帶著授權。

## 改了 `design/copy/` 之後

```sh
design/fonts/subset.sh                                       # 要 curl、shasum、uv
cd worker && node --experimental-strip-types scripts/site-files.ts   # 拷一份到 worker/site/fonts/
```

腳本用 `fonttools` 4.68.0 和 `brotli` 1.2.1（`uv run --with`，釘精確的版本），不動程式庫的 `package.json` 和 lockfile。同一份 `design/copy/` 跑兩次，寫出來的檔逐位元組相同。部署和建置都不跑它：子集是提交進版控的這一份。

`worker/` 的 `pnpm test`（`test/font.test.ts`）檢查：`design/copy/` 的每一個字都在子集裡、子集帶著 name 表的 13 和 14、訪客頁面的那一份和這裡的逐位元組相同。`design/copy/` 加了新的字而沒重跑腳本，那個測試會列出缺的字。

## 誰用它

- 訪客的頁面：`worker/site/fonts/` 的拷貝，從網站自己的網域載入（`worker/README.md`「Static Assets」）
- 過卡的網頁：`web/src/ui/style.css` 從這裡引用，建置時打包進自己的檔案
- Android、iOS：建置時包進去（之後的票）

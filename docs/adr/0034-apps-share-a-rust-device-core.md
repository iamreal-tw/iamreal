---
status: accepted
---

# Android 和 iOS 共用一份 Rust 核心，網頁版上線時維持 TypeScript

Android 和 iOS 的 app 共用一份 Rust 寫的核心，放在 `device-core/`。Kotlin 和 Swift 不各寫一份協定的算法和裝置上的檢查。

核心放三類：

- `spec/` 的算法：場合字串、宣告碼、匿名編號、題目、名冊規則、帳號格式。
- 裝置上的檢查：選憑證和檢查憑證、廢止清冊的解析和驗章、清冊多舊算過期、建樹（ADR-0015）、電路輸入和預期的公開輸入、檢查後台的回應。
- 算見證、算證明、Poseidon2。

核心不做 I/O：呼叫的人給它位元組，它回位元組或結果。它不碰 PIN、網路、NFC、檔案。畫面、NFC、送出請求、存檔、流程的順序、讀卡的指令，由 Kotlin 和 Swift 寫。

核心拆成兩個套件：

- 不碰 Barretenberg 的一半：`spec/` 的算法和裝置上的檢查。不依賴原生的函式庫，雜湊由呼叫的人傳進來（和 `protocol/` 的做法相同），所以之後編得成 wasm。
- 算證明的一半：見證、證明、Poseidon2、建樹的平行處理，連結 Barretenberg 的原生函式庫，只有手機用。對 Kotlin、Swift 開放的函式在這裡。

## 核心擋住的順序

所有不需要簽章的檢查都通過之前，不能有請求帶著匿名編號送出去（ADR-0015、ADR-0016）。這條順序在網頁版由 `web/src/flow.ts` 保證；在 app 上流程由 Kotlin、Swift 各寫一次。

所以核心自己擋：沒交出「檢查都通過了」的結果（憑證、清冊、樹、電路檔和參數檔的雜湊），核心不算匿名編號，也不組出送後台的內容。匿名編號要用 Poseidon2 算，Poseidon2 只有核心有；原生的程式順序寫錯時，帶著匿名編號的請求送不出去。

核心擋不到的有兩件：太早叫卡片簽章，和兩次簽章之間 PIN 的時限。這兩件留在 Kotlin、Swift，都不會讓東西離開手機。

## 和 `spec/` 的關係

`device-core/` 是 `spec/` 的第三份實作，前兩份是 Go 的 `verifier/`、`roster/`、`crl/` 和 TypeScript 的 `protocol/`。每種語言的實作互不引用，只共用 `spec/`：Rust 的測試讀 `spec/vectors/`，不複製，也不從另一種語言產生程式。

裝置上的檢查現在只有網頁版一份，規則寫在程式和測試裡，不在 `spec/`。移植成 Rust 之前先補進 `spec/`（規格和標準答案）：選憑證和檢查憑證、清冊收不收和多舊算過期、電路輸入、建樹的路徑。TypeScript 和 Rust 都讀同一份標準答案。

## 網頁版

網頁版上線時維持 TypeScript，不改用同一份 Rust 編成的 wasm。app 的核心做完後實測，再決定網頁版的裝置檢查要不要換過去；核心拆成兩半，就是為了不堵住這條路。

## 讀卡的指令

讀卡的指令不放核心，Kotlin 和 Swift 各寫一份。

## 理由

- **一定會有一層自己的 Rust。** 原生的 app 呼叫 Barretenberg，每一條路都經過 Rust；建樹用的 Poseidon2 和網頁版同一份壓縮格式的通用參數，只能從 `barretenberg-rs` 叫到，現成的 Swift、Kotlin 包裝都沒有（[#86](https://github.com/iamreal-tw/iamreal/issues/86)、[#88](https://github.com/iamreal-tw/iamreal/issues/88)）。問題只剩這一層放多少東西。
- **實作少一份。** 放進核心，每個算法是 TypeScript、Go、Rust 三份；Kotlin、Swift 各寫是四份。裝置上的檢查多半沒有標準答案，各寫的話是兩份新的移植，各自去比網頁版。
- **PIN 不經過核心。** PIN 只走「Kotlin 或 Swift 到卡片」這一段。要檢查 PIN 有沒有離開裝置，看的是兩個 app 裡畫面和讀卡的程式，不用看核心。
- **不做 I/O 的核心，能單獨測。** 同一組標準答案在桌機上跑得了，不需要手機、卡片、後台。
- **流程和作業系統綁在一起。** iPhone 上卡片接上後約 20 秒系統就結束連線，中途掉線要能重新感應（[#89](https://github.com/iamreal-tw/iamreal/issues/89)）；app 會被切到背景。這些在兩個平台的處理不同，放進 Rust 再跨過 FFI 呼叫回原生，兩邊都變複雜。要緊的那一條順序由核心擋。
- **網頁版換成 wasm，TypeScript 也不會消失。** 後台用 `protocol/`（ADR-0023），網頁的畫面和流程也是 TypeScript；能合併的只有裝置上的檢查。網頁版算證明還是要用 bb.js：核心連結的是 Aztec 預先編好的原生函式庫，裡面沒有給瀏覽器的版本，瀏覽器裡的 Barretenberg 就是 bb.js。核心編成 wasm 多大、建樹跨 wasm 邊界呼叫幾十萬次雜湊會不會變慢，都還沒有量。封閉試用從網頁版開始，不讓它等 app 的核心。
- **讀卡的指令裡有 PIN。** 核心來組驗 PIN 的指令，PIN 就要進核心。網頁版走內政部的元件，不送這些指令，所以這一類沒有第三份要對齊。

## Considered Options

- **協定和檢查由 Kotlin、Swift 各寫一份，Rust 只放算證明和建樹**：Rust 那一層最薄，但實作多一份，改規則時多改一個地方；裝置上的檢查是安全上要緊的，兩份新的移植沒有標準答案可以對。
- **流程的順序也放進 Rust**，原生只提供畫面、NFC、傳輸：順序只寫一次，但核心要回頭呼叫原生，要處理非同步和兩個作業系統不同的中斷；核心也不再是「位元組進、位元組出」。
- **網頁版現在就改用同一份 Rust（wasm）**：裝置上的檢查只剩一份，長期比較好維護；但要賭兩件還沒量的事，還會讓網頁版的試用等 app 的核心。沒有排除，延到核心做完後實測。
- **讀卡的指令放核心，驗 PIN 的那一個留在原生**：一次感應的指令拆在兩邊，比各寫一份更難檢查。

## Consequences

- **多一種語言。** 這個程式庫有 Go、TypeScript、Noir，加上 Rust、Kotlin、Swift。Rust 的套件照 `CONTRIBUTING.md` 的套件規則；Barretenberg 和 Noir 的版本和 `web/` 釘的相同。
- **改 `spec/` 的算法時多改一份。** 名冊規則現在是規格、標準答案、Go、TypeScript 一起改（ADR-0030）；`device-core/` 建好後加上 Rust，`CONTRIBUTING.md` 那時一起改。裝了舊版 app 的手機照舊的規則算後果，要怎麼處理在 app 的更新那張票定。
- **裝置上的檢查在網頁版和 app 是兩份**，靠 `spec/vectors/` 對齊，直到實測後決定網頁版換不換。
- **「先檢查再簽章」寫兩次。** Kotlin、Swift 的流程照 `web/src/flow.ts` 的順序；核心只保證匿名編號不會在檢查通過前出現。
- **簽章和憑證會進核心。** 它們沒有離開手機，不違反 `CLAUDE.md` 的硬限制；核心用完要清掉。
- **`android/`、`ios/` 引用 `device-core/`，不引用 `protocol/`。** `CLAUDE.md` 的目錄表照改。
- **核心對外的介面不在這一份定。** 起點是手寫的幾個 C 函式，位元組進出，不用產生綁定的工具；理由和什麼時候換，記在 [#90](https://github.com/iamreal-tw/iamreal/issues/90)。

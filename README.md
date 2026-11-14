# 臺中市身障免銷單停車場地圖

網站：**https://roseamyclara.github.io/parking/**

把[臺中市停車資訊網「身障免銷單服務已上線停車場」](https://tcparking.taichung.gov.tw/ParkWeb/Pages/PublicService/LoveCardSchedule)
的表格每天自動爬下來、轉成經緯度，做成可以即時搜尋的地圖。

```
  臺中市停車資訊網
        │  ① scrape.py（每天 00:00 由 GitHub Actions 執行）
        ▼
  parking/cache/parkings_raw.json
        │  ② geocode.py（把地址轉座標，結果存快取，只查新增的）
        ▼
  parking/data/parkings.json ──► ③ parking/index.html（Google 地圖）
```

## 檔案在哪

| 路徑 | 用途 |
| --- | --- |
| `.github/workflows/update-parking.yml` | 每日排程（**一定要放在 `.github/workflows/` 裡才會執行**） |
| `parking/index.html` | 網站本體（入口） |
| `parking/app.js`、`parking/app.css` | 前端程式與樣式（ES module，無建置步驟） |
| `parking/availability.js` | 即時車位燈號：抓交通局開放資料、與本站停車場配對（不碰 DOM，可用 Node 測試） |
| `parking/config.js` | **前端設定：Google 地圖瀏覽器金鑰與 Map ID** |
| `parking/lib/` | 舊版 Leaflet 函式庫（目前已不使用，保留備查） |
| `parking/scripts/` | 爬蟲與地理編碼程式 |
| `parking/cache/` | 中繼檔與座標快取（自動產生、自動 commit） |
| `parking/data/parkings.json` | 網站讀取的資料檔（自動產生） |

## 功能

- 🔍 關鍵字搜尋停車場名稱、路名、行政區；打字時搜尋列下方出現**建議清單**：「停車場」（本站資料）＋「地點」（Google 自動完成）
- 📍 地點搜尋：輸入「臺中車站」「中國醫藥大學」等任意地點，找出附近停車場並依距離排序；地圖會放大到附近停車場都是個別標記（不會只剩一個分群圓圈）
- ⭐ 停車場詳情裡的「Google 的評分與評論」（只在打開詳情時載入，見下方說明）
- 🧭 「離我最近」瀏覽器定位排序
- 🏷 依行政區、免銷單進出場方式篩選（收在搜尋列右側的「篩選與設定」）
- 🚦 即時車位燈號（尚有車位／即將滿場／已滿），約每分鐘更新
- 🗺 Google 地圖標記自動分群，點選後在面板顯示詳情、一鍵開 Google 導航
- 📱 手機：全螢幕地圖＋浮動搜尋列＋可拖曳的底部面板（三段高度，Android 返回鍵會先收起面板）；
  桌機：左側面板＋右側地圖。深色模式（在「篩選與設定」切換外觀）、鍵盤操作、Windows 高對比、減少動態效果皆支援

## 前端地圖：Google Maps

地圖使用 **Google Maps JavaScript API**，以官方的動態載入方式（`google.maps.importLibrary`）載入，
語言 `zh-TW`、地區 `TW`：

- 標記：`AdvancedMarkerElement`（`marker` 程式庫）。進階標記一定要有 Map ID。
- 分群：[`@googlemaps/markerclusterer`](https://github.com/googlemaps/js-markerclusterer) 2.6.2，
  從 jsDelivr 載入並鎖定版本與 SRI 雜湊；萬一載不到，地圖照常顯示，只是不分群。
- 詳情：點標記或卡片後顯示在面板裡（不再用 InfoWindow），含「導航」按鈕；
  座標只推估到行政區的停車場，導航改用名稱＋地址搜尋，避免被帶到行政區中心。
- 深淺色：依頁面目前的外觀建立地圖（`colorScheme: DARK / LIGHT`），切換外觀時會自動重建地圖。
- 地點搜尋：有金鑰時先用 Places API（New）的文字搜尋，再試 Geocoding，
  都失敗或沒結果就退回 OpenStreetMap Nominatim（以臺中為優先範圍）。
- 分群：縮放 14（含）以下才分群（`SuperClusterAlgorithm` 的 `maxZoom: 14`），15 以上一律是個別標記。
  搜尋地點／離我最近時，鏡頭以起點為中心、只納入 400 公尺內最近幾座停車場，並至少放大到 15；
  選一座停車場時放大到 16。「顯示全部結果」（Enter、行政區篩選）仍維持全市範圍、可以分群。

### 搜尋建議（停車場＋地點）

- **停車場**：本機比對名稱／地址／位置／行政區（和清單同一套正規化，`台`＝`臺`），尊重目前的篩選，最多 6 筆，不連網。
- **地點**：`google.maps.importLibrary("places")` → `AutocompleteSuggestion.fetchAutocompleteSuggestions`，
  至少 2 個字、停止輸入 300ms 後才送；`locationBias` 是臺中市中心半徑 40 公里，`language: "zh-TW"`、`region: "tw"`、
  `includedRegionCodes: ["tw"]`，**不設** `includedPrimaryTypes`（車站、醫院、地址都要）。最多 5 筆，和停車場同名的略過。
  顯示的是預測本身的 `mainText`／`secondaryText`，不會為了顯示建議而查 Place Details。
- **Session token**：一次輸入共用一個 `AutocompleteSessionToken`；選了建議、清空輸入框、按 Esc／點外面放棄、
  或 Enter 只看停車場結果，這個 session 就結束，下次打字才建立新的 token。
- **選地點**：`placePrediction.toPlace().fetchFields({ fields: ["location", "displayName", "formattedAddress"] })`
  結束 session（只要 Essentials 欄位，**不要**評分、評論等），再設為起點。
- **最後一列「以「…」搜尋這個地點」／沒有符合的停車場時按 Enter**：session 裡已有這段文字的建議就用第一筆（同上，Essentials），
  否則走原本的 Places 文字搜尋（`displayName` + `location`）→ Geocoding → Nominatim。
- 鍵盤：combobox／listbox（`aria-expanded`、`aria-controls`、`aria-activedescendant`）。注音／倉頡選字時
  （`isComposing` 或 `keyCode 229`）Enter／方向鍵／Esc 都交給輸入法，也不會送自動完成；選字結束才開始計時。
  Android 返回鍵、Esc、點清單以外的地方都會先關掉建議清單。
- Google 不能用（沒有金鑰、地圖載入失敗、API 被拒）時只顯示停車場建議與後備列，搜尋照常可用。

### 停車場詳情：Google 的評分與評論

只有在**打開某一座停車場的詳情**時才載入；清單卡片、地圖標記、畫面外的停車場都不會抓，也不預先抓。

1. 停車場對應的 Google 地點：`parkings.json` 若有 `place_id`（每日排程會補，見下方）就直接用；
   沒有的話用 `Place.searchByText`（停車場名稱＋地址、以停車場座標為偏好、`maxResultCount: 1`），
   **`fields: ["id"]` 只要 id**，查到的 id 存在 localStorage（查不到的 3 天內不再查）。
2. `new Place({ id }).fetchFields({ fields: ["rating", "userRatingCount", "reviews", "googleMapsURI"] })`，只要這四個欄位。
3. 結果（評分、評論數、評論、Google 地圖連結）存在 localStorage **7 天**；同一座再打開完全不連網。快取 JSON 壞掉會自動丟掉重抓。
4. 安全閥：同一個瀏覽器每天（臺灣時間）最多 25 次評論查詢（只算真的打到 Place Details 的，不算快取），
   超過就顯示說明與「在 Google 地圖開啟」連結。
5. 版面：和本站／交通局資料分開的區塊，標題「Google 的評分與評論」、註明「資料來自 Google 地圖」；
   數字評分＋依分數比例填滿的星星＋評論數；每則評論有作者（有頭像與個人頁連結時一起顯示）、星等、相對時間、內文（長的可展開）、
   「在 Google 地圖查看這則評論」與「檢舉」連結；最下方「在 Google 地圖開啟」。
6. 沒有金鑰、地圖載入失敗、找不到對應地點、額度用盡或被拒時，只顯示一行說明與 Google 地圖搜尋連結；導航、車位燈號等其餘詳情不受影響。

> 評分與評論是 **Google 地圖使用者提供的內容**，可能缺漏或對應錯誤，**不是交通局的官方資料**。

### 用到的 Google API 與計費 SKU

| 時機 | 呼叫 | SKU |
| --- | --- | --- |
| 打字時的「地點」建議 | `AutocompleteSuggestion.fetchAutocompleteSuggestions`（帶 session token） | Autocomplete Requests；session 以選地點結束時改計 Autocomplete Session Usage |
| 選了一個「地點」 | `Place.fetchFields(["location","displayName","formattedAddress"])` | Place Details Essentials |
| 停車場 → Google 地點（瀏覽器，只在沒有 `place_id` 時） | `Place.searchByText`，`fields: ["id"]` | Text Search Essentials (IDs Only) |
| 停車場 → Google 地點（每日排程） | `POST places.googleapis.com/v1/places:searchText`，`X-Goog-FieldMask: places.id` | Text Search Essentials (IDs Only) |
| 詳情裡的評分與評論 | `Place.fetchFields(["rating","userRatingCount","reviews","googleMapsURI"])` | **Place Details Enterprise + Atmosphere**（`reviews` 屬於 Atmosphere，整次呼叫都以這個 SKU 計費；靠 7 天快取與每日上限控制用量） |
| 「以…搜尋這個地點」沒有建議可用時 | `Place.searchByText`（`displayName`、`location`）→ Geocoding → Nominatim | 原本就有的流程 |

瀏覽器金鑰需要啟用 **Maps JavaScript API** 與 **Places API (New)**。

### `parking/config.js`

```js
window.GOOGLE_MAPS_API_KEY = "AIza…";   // 瀏覽器端金鑰，會公開在網頁上
window.GOOGLE_MAPS_MAP_ID  = "DEMO_MAP_ID"; // 進階標記需要；可換成自己的 Map ID
```

- 使用 Google Cloud 專案 `taichung-parking-map` 的瀏覽器金鑰（已啟用帳單，HTTP 參照網址限制為 `https://roseamyclara.github.io/*`）。請勿與 `place.html`、`disablemap.html` 的舊金鑰混用。
- **沒有金鑰**（設成 `""`）：完全不載入 Google 的程式，地圖區改顯示「尚未設定 Google 地圖金鑰」說明。
  清單、關鍵字搜尋、篩選、離我最近、地點搜尋（Nominatim）、導航連結都照常可用。
- **有金鑰但載入失敗**（金鑰無效、網域未授權、帳單或 API 未啟用、網路斷線、逾時）：
  地圖區顯示看得懂的錯誤說明，清單與搜尋不受影響。

### 上線前的 Google Cloud 設定（瀏覽器金鑰）

1. 金鑰所屬的專案要**綁定帳單帳戶**（沒有帳單時地圖會出現「這個網頁無法正確載入 Google 地圖」並蓋上
   “For development purposes only” 浮水印，本站會改顯示錯誤說明）。
2. 「API 和服務 → 程式庫」啟用 **Maps JavaScript API**；想讓地點搜尋走 Google，再啟用
   **Places API (New)**（及選用的 **Geocoding API**）。沒啟用也沒關係，會自動改用 OpenStreetMap。
3. 金鑰的「應用程式限制」選 **HTTP 參照網址（網站）**，加入：
   - `https://roseamyclara.github.io/*`
   - （本機測試用，選用）`http://localhost:*`
4. 「API 限制」只勾上面用到的幾個 API。

> ⚠️ 這把**瀏覽器金鑰**和下方 GitHub Actions secret 裡給 `geocode.py` 用的 `GOOGLE_MAPS_API_KEY`
> 是兩回事。伺服器端那把只放在 Secrets、用 IP 限制或不設應用程式限制，**絕對不要**貼進 `config.js`。

## 即時車位燈號

來源：臺中市政府交通局「路外剩餘車位」開放資料
`https://motoretag.taichung.gov.tw/DataAPI/api/ParkingAPIV2/Opendata`
（免金鑰、`Access-Control-Allow-Origin: *`，瀏覽器直接抓；與 Google 地圖金鑰無關，沒有金鑰也照常運作）。

- 只有燈號 `AvailableCarRGB`：`G` 尚有車位、`Y` 即將滿場、`R` 已滿、`B` 無即時資料（約六成都是 B），
  外加總車位數 `TotalCar`。**沒有剩餘車位數字**，網頁也不會從顏色去推算。
- 頁面可見時約每 60 秒抓一次（約 350 KB），切到背景就暫停；失敗時保留上一筆資料，超過 10 分鐘就不再顯示。
- 配對（`availability.js` 的 `matchLots`）：官方 `Position` 是「行政區-管理單位-名稱P」，
  在同一行政區內比對正規化後的名稱（臺／台、去括號、去「停車場／附屬／地下…」、A／B 區保留），
  名稱必須唯一；地下、平面、立體不同的視為不同停車場。最後才用座標備援（45 公尺內唯一、且不能一對多）。
  目前約 266／290 座配得到，其餘顯示「無即時車位資料」，寧可不顯示也不顯示錯的。
- 想要**精確的剩餘車位數**：交通部 TDX 的 `Parking/OffStreet/ParkingAvailability/City/Taichung` 有數字、約每分鐘更新，
  但需要 client id／secret（未授權會 401）且有流量限制，**secret 不能放在 GitHub Pages 前端**。
  可行做法是另寫 GitHub Actions 定期把結果寫到 `parking/data/availability.json`，或架一個小型的授權代理；目前尚未實作。

離線檢查配對結果（把 API 回應存成檔案後）：

```bash
node -e 'import("./parking/availability.js").then(m=>{const fs=require("fs");const r=m.matchLots(JSON.parse(fs.readFileSync("parking/data/parkings.json")).items,JSON.parse(fs.readFileSync("/tmp/opendata.json")));console.log(r.size)})'
```

## 日常維護

- **每天臺灣時間 00:00 自動更新**，資料有變動才 commit。
- 要立刻更新：repo 上方 **Actions → 每日更新停車場資料 → Run workflow**。
- 每次跑完，Actions 的執行摘要會列出抓到幾筆、幾筆有座標、哪幾筆查不到。

> GitHub 的排程有時會延遲幾分鐘到半小時才觸發，這是正常現象。

## 資料座標目前使用免費的 OpenStreetMap 定位

（這一節講的是每日排程產生座標用的**伺服器端**金鑰，和上面網頁地圖用的瀏覽器金鑰無關。）

現在座標是用 OpenStreetMap Nominatim（免費、不需金鑰）查出來的，準確度夠用但不是最好。
想換成更準的 Google：

1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案、綁定帳單帳戶
   （每月有 200 美元免費額度，本專案用量遠低於此）。
2. 「API 和服務 → 程式庫」啟用 **Places API** 與 **Geocoding API**。
3. 「憑證 → 建立憑證 → API 金鑰」，複製金鑰。設定限制：
   應用程式限制選「無」或「IP 位址」（金鑰只在 GitHub 伺服器上用，不會出現在網頁裡，
   所以不需要設 HTTP 參照網址限制）；API 限制只勾這兩個 API。
4. 回到這個 repo：**Settings → Secrets and variables → Actions → New repository secret**
   - Name：`GOOGLE_MAPS_API_KEY`
   - Secret：貼上金鑰
5. 刪掉 `parking/cache/geocache.json`，再手動跑一次 workflow，就會用 Google 全部重查一遍。

### 自動補上 Google `place_id`（選用）

有 `GOOGLE_MAPS_API_KEY` secret 時，`geocode.py` 在處理完座標之後，會替**還沒有 `place_id`** 的停車場補上一個：

- 用 **Places API (New)** 的 Text Search：`POST https://places.googleapis.com/v1/places:searchText`，
  `X-Goog-FieldMask: places.id`（只有 id → SKU「Text Search Essentials IDs Only」，不計費），
  `textQuery` 是名稱＋地址、`languageCode: zh-TW`、`regionCode: TW`、`maxResultCount: 1`，以快取座標為 `locationBias`。
- 結果寫進 `geocache.json` 那一筆的 `place_id`，並輸出到 `parkings.json` 的同名欄位（選用欄位，前端沒有也照常運作）。
  查不到的記下 `place_id_miss`，30 天後才再試。
- **不會重查既有座標**，也不需要 `--refresh-all`；不想補就加 `--no-place-ids`。
- 伺服器金鑰要另外啟用 **Places API (New)**。沒啟用、被拒或超額（401／403／429）只會印警告並略過，照常輸出資料；
  **不會**退回舊版（計費的）Places Text Search。
- 有了 `place_id`，網頁打開詳情時就不必再做 Text Search，直接查評分與評論。

## 本機測試（選用）

```bash
pip install -r parking/scripts/requirements.txt

python parking/scripts/test_scrape.py     # 離線測試解析邏輯與 place_id 補值，不連網
python parking/scripts/scrape.py          # 抓表格
python parking/scripts/geocode.py         # 產生 parking/data/parkings.json
python parking/scripts/geocode.py --limit 20   # 只先處理 20 筆，測試用

cd parking && python -m http.server 8000  # 開 http://localhost:8000
```

本機看地圖時，若瀏覽器金鑰的參照網址沒加 `http://localhost:*`，地圖區會顯示「暫時無法顯示」，
這是預期行為；清單與搜尋仍可測試。想測「沒有金鑰」的畫面，把 `config.js` 的金鑰暫時改成 `""` 即可。

```text
本機快速檢查清單
- 清單出現 290 筆、輸入「大里」會篩選並出現「停車場」建議、Enter 在注音選字時不會送出
- 建議清單可用上下鍵移動、Enter 選取、Esc 關閉；選停車場會打開詳情並放大到該處
- （本機若 Google 不能用）建議只有停車場與「以「…」搜尋這個地點」；詳情的「Google 的評分與評論」顯示一行說明
- 輸入「臺中車站」→ 點搜尋列下方「以「臺中車站」為地點搜尋附近」（或直接按 Enter）→ 依距離排序並出現起點
- 「離我最近」會要求定位權限；拒絕時顯示提示
- 手機寬度（≤ 820px）是全螢幕地圖＋底部面板：拖曳把手可在三段高度間切換；點卡片或標記會打開詳情；
  返回鍵依序關閉篩選 → 詳情 → 把面板降回最低，不會直接離開本頁；Esc 也一樣
- 「篩選與設定 → 外觀」切換深色時，地圖也變深色
- 清單標題下方出現「車位 HH:MM 更新」，部分卡片顯示燈號；封鎖 motoretag.taichung.gov.tw 時其他功能照常
```

## 疑難排解

| 症狀 | 處理 |
| --- | --- |
| 網頁顯示「資料載入失敗」 | `parking/data/parkings.json` 還沒產生，去 Actions 手動跑一次。 |
| Actions 在 commit 那步失敗，寫 permission denied | Settings → Actions → General → Workflow permissions 要設成 **Read and write**。 |
| 爬蟲失敗「只解析到 N 筆」 | 對方網站改版了。`scripts/scrape.py` 的 `COLUMN_MAP` 是用表頭文字比對，把新欄位名稱加進去即可。程式刻意在這種情況中止，不會覆蓋掉原本正確的資料。 |
| 某幾個停車場座標偏掉 | 原始資料的「位置」欄常常只有路名沒門牌，只能定位到路段。可以直接編輯 `parking/cache/geocache.json` 裡那一筆的 `lat`／`lng`，之後更新會沿用你改的值。 |
| 詳情顯示「找不到對應地點」或沒有評論 | Google 上沒有這個停車場、或名稱對不上。可以等每日排程補上 `place_id`；也可清除瀏覽器的網站資料重試。 |
| 評分區塊說「沒有開放給這個網站使用」 | 瀏覽器金鑰沒有啟用 Places API (New)，或參照網址限制不含目前網址。 |
| 地點搜尋沒反應 | 沒有可用的 Google Places 時會改用 OpenStreetMap 免費服務，偶爾限流，稍等再試。 |
| 地圖區顯示「尚未設定 Google 地圖金鑰」 | `parking/config.js` 的 `GOOGLE_MAPS_API_KEY` 是空的。 |
| 地圖區顯示「Google 地圖暫時無法顯示」 | 括號內會寫原因：帳單未啟用、API 未啟用、網址未列在參照網址限制中、金鑰無效等，照上面「上線前的 Google Cloud 設定」檢查。 |

## 資料來源與免責

- 資料來源：[臺中市停車資訊網 — 身障免銷單服務已上線停車場](https://tcparking.taichung.gov.tw/ParkWeb/Pages/PublicService/LoveCardSchedule)
- 地點建議、評分與評論：Google 地圖（Places API (New)），屬於 Google 使用者內容，非官方資料
- 地圖：[Google 地圖](https://www.google.com/maps)（Maps JavaScript API）、[@googlemaps/markerclusterer](https://github.com/googlemaps/js-markerclusterer)
- 座標（每日排程）與備援地點搜尋：[OpenStreetMap](https://www.openstreetmap.org/copyright) 貢獻者（Nominatim）
- 座標為地理編碼推估結果，實際位置以現場標示為準；免銷單服務內容一律以臺中市政府交通局公告為準。
- 本專案為民間製作的資料整理工具，非官方網站。

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
| `parking/config.js` | **前端設定：Google 地圖瀏覽器金鑰與 Map ID** |
| `parking/lib/` | 舊版 Leaflet 函式庫（目前已不使用，保留備查） |
| `parking/scripts/` | 爬蟲與地理編碼程式 |
| `parking/cache/` | 中繼檔與座標快取（自動產生、自動 commit） |
| `parking/data/parkings.json` | 網站讀取的資料檔（自動產生） |

## 功能

- 🔍 關鍵字搜尋停車場名稱、路名、行政區
- 📍 地點搜尋：輸入「臺中車站」「中國醫藥大學」等任意地點，找出附近停車場並依距離排序
- 🧭 「離我最近」瀏覽器定位排序
- 🏷 依行政區、免銷單進出場方式篩選
- 🗺 Google 地圖標記自動分群，點選可看詳情、一鍵開 Google 導航
- 📱 手機（清單／地圖分頁）與桌機（左右並排）、深色模式（可在「關於本站與免責」切換外觀）、鍵盤操作、Windows 高對比、減少動態效果皆支援

## 前端地圖：Google Maps

地圖使用 **Google Maps JavaScript API**，以官方的動態載入方式（`google.maps.importLibrary`）載入，
語言 `zh-TW`、地區 `TW`：

- 標記：`AdvancedMarkerElement`（`marker` 程式庫）。進階標記一定要有 Map ID。
- 分群：[`@googlemaps/markerclusterer`](https://github.com/googlemaps/js-markerclusterer) 2.6.2，
  從 jsDelivr 載入並鎖定版本與 SRI 雜湊；萬一載不到，地圖照常顯示，只是不分群。
- 資訊視窗：`google.maps.InfoWindow`，含「在 Google 地圖導航」連結。
- 深淺色：依頁面目前的外觀建立地圖（`colorScheme: DARK / LIGHT`），切換外觀時會自動重建地圖。
- 地點搜尋：有金鑰時先用 Places API（New）的文字搜尋，再試 Geocoding，
  都失敗或沒結果就退回 OpenStreetMap Nominatim（以臺中為優先範圍）。

### `parking/config.js`

```js
window.GOOGLE_MAPS_API_KEY = "AIza…";   // 瀏覽器端金鑰，會公開在網頁上
window.GOOGLE_MAPS_MAP_ID  = "DEMO_MAP_ID"; // 進階標記需要；可換成自己的 Map ID
```

- 目前沿用本 repo 其他頁面（`place.html`、`disablemap.html`）已公開的同一把瀏覽器金鑰。
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

## 本機測試（選用）

```bash
pip install -r parking/scripts/requirements.txt

python parking/scripts/test_scrape.py     # 離線測試解析邏輯，不連網
python parking/scripts/scrape.py          # 抓表格
python parking/scripts/geocode.py         # 產生 parking/data/parkings.json
python parking/scripts/geocode.py --limit 20   # 只先處理 20 筆，測試用

cd parking && python -m http.server 8000  # 開 http://localhost:8000
```

本機看地圖時，若瀏覽器金鑰的參照網址沒加 `http://localhost:*`，地圖區會顯示「暫時無法顯示」，
這是預期行為；清單與搜尋仍可測試。想測「沒有金鑰」的畫面，把 `config.js` 的金鑰暫時改成 `""` 即可。

```text
本機快速檢查清單
- 清單出現 290 筆、輸入「大里」會篩選、Enter 在注音選字時不會送出
- 輸入「臺中車站」→「搜尋這個地點附近的停車場」→ 依距離排序並出現起點
- 「離我最近」會要求定位權限；拒絕時顯示提示
- 手機寬度（< 820px）出現「清單／地圖」分頁，可用左右方向鍵切換
- 「關於本站與免責 → 外觀」切換深色時，地圖也變深色
```

## 疑難排解

| 症狀 | 處理 |
| --- | --- |
| 網頁顯示「資料載入失敗」 | `parking/data/parkings.json` 還沒產生，去 Actions 手動跑一次。 |
| Actions 在 commit 那步失敗，寫 permission denied | Settings → Actions → General → Workflow permissions 要設成 **Read and write**。 |
| 爬蟲失敗「只解析到 N 筆」 | 對方網站改版了。`scripts/scrape.py` 的 `COLUMN_MAP` 是用表頭文字比對，把新欄位名稱加進去即可。程式刻意在這種情況中止，不會覆蓋掉原本正確的資料。 |
| 某幾個停車場座標偏掉 | 原始資料的「位置」欄常常只有路名沒門牌，只能定位到路段。可以直接編輯 `parking/cache/geocache.json` 裡那一筆的 `lat`／`lng`，之後更新會沿用你改的值。 |
| 地點搜尋沒反應 | 沒有可用的 Google Places 時會改用 OpenStreetMap 免費服務，偶爾限流，稍等再試。 |
| 地圖區顯示「尚未設定 Google 地圖金鑰」 | `parking/config.js` 的 `GOOGLE_MAPS_API_KEY` 是空的。 |
| 地圖區顯示「Google 地圖暫時無法顯示」 | 括號內會寫原因：帳單未啟用、API 未啟用、網址未列在參照網址限制中、金鑰無效等，照上面「上線前的 Google Cloud 設定」檢查。 |

## 資料來源與免責

- 資料來源：[臺中市停車資訊網 — 身障免銷單服務已上線停車場](https://tcparking.taichung.gov.tw/ParkWeb/Pages/PublicService/LoveCardSchedule)
- 地圖：[Google 地圖](https://www.google.com/maps)（Maps JavaScript API）、[@googlemaps/markerclusterer](https://github.com/googlemaps/js-markerclusterer)
- 座標（每日排程）與備援地點搜尋：[OpenStreetMap](https://www.openstreetmap.org/copyright) 貢獻者（Nominatim）
- 座標為地理編碼推估結果，實際位置以現場標示為準；免銷單服務內容一律以臺中市政府交通局公告為準。
- 本專案為民間製作的資料整理工具，非官方網站。

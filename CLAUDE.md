# ACG 檔期靜態網站

純靜態網站（HTML + CSS + JS，無建置步驟），用可縮放的時間軸呈現 ACG 活動，可依縣市、類型、地點篩選。
**本專案獨立運作，與 Google 日曆無關**：不讀寫任何日曆，資料只來自 `data/`。

## 目錄結構

```
ACG-Site/
├── CLAUDE.md          # 本檔：專案規則
├── prompt.md          # 更新活動資料的提示詞
├── index.html         # 頁面骨架
├── style.css          # 樣式（顏色都是 :root 的 token，含深色模式）
├── app.js             # 讀資料並渲染
├── scripts/
│   └── data.py        # 資料工具：list／merge／validate／prune（見 prompt.md）
└── data/
    ├── meta.json      # 網站名稱、更新日、活動類型、縣市
    ├── places.json    # 地點庫（跨活動共用）
    └── events.json    # 所有活動
```

## 頁面行為

- **時間軸**：預設顯示「上個月 1 日」起的 3 個月（總範圍仍涵蓋所有活動，可捲動或縮小），月份上方用色帶標出季度（2026 Q4…）。可用 −／＋、1／3／6／12 個月、Ctrl + 滾輪縮放，左右捲動可以移動時間。放大後會出現「日」的格子：週六（藍）週日（粉紅）底色、每日格線、日期列，門檻在 `app.js` 的 `DAY_LEVEL`。總範圍會自動延伸到涵蓋所有活動。
- **不顯示的活動**：沒有 `start` 或 `end` 的，以及在上個月 1 日之前就結束的。
- **Inspector**：時間軸右側的面板（類似 Unity Inspector），點活動列或橫條就顯示該活動。密集屬性表，不分區塊、不收合，依序為：日期（開始 → 結束 · 天數，同一行）、位置（位置、捷運、地址同一行）、連結、特色、作品。時間軸上按 ↑↓ 鍵切換活動。開頁時預設選「今天進行中、最早結束」的活動。寬度 900px 以下 Inspector 移到時間軸下方。
- **版面**：寬度 901px 以上時整頁固定為視窗大小，不會整頁捲動；活動太多時時間軸內部上下捲動（月份標頭固定在上方），Inspector 內容太長時自己捲動。滑鼠拖曳時間軸可以上下左右移動。900px 以下改回一般的整頁捲動。
- **地圖**：Inspector 最下方（上緣可拖曳調整高度），Leaflet + Esri 灰階畫布底圖（極簡風格、免費、免金鑰，淺色／深色兩套跟著系統主題切換；CARTO 需要金鑰，不要用），上面固定疊一層 OpenRailwayMap 透明圖層顯示台鐵、高鐵、捷運、輕軌路線。只標目前縣市、通過篩選的活動地點，點的大小代表活動數；點標記等於篩選該地點，選取的活動地點會放大並顯示名稱。可收合，狀態記在瀏覽器。
- 頁面標題不帶地區，縣市只當成篩選條件。

## 資料格式

### `data/meta.json`

| 欄位 | 說明 |
|---|---|
| `site` | 網站名稱 |
| `updated` | 全站最後更新日（YYYY-MM-DD）；各縣市另有自己的 `cities.<代碼>.updated` |
| `types` | 類型代碼 → `label`。顏色在 `app.js` 的 `TYPE_COLOR` 與 `style.css` 的 `--t-*` |
| `cities` | 縣市代碼（英文小寫，例如 `kaohsiung`、`taipei`）→ `label`、`center`（[緯度, 經度]，地圖預設中心與座標檢查用）、`updated`（該縣市最後更新日，`merge` 只會更新這次有資料的縣市）、`coveredUntil`（AI 查詢涵蓋到哪一天，時間軸畫界線；用 `scripts/data.py covered` 更新）。兩者顯示在分頁列右側 |

### `data/places.json`

地點代碼 → `city`（縣市代碼）、`label`、`mrt`（捷運／輕軌站代號，可空）、`addr`（用來產生 Google Maps 連結）、`lat`／`lng`（地圖標記用，由 `scripts/data.py geocode` 補，離縣市中心超過 30 km 視為查錯）。
篩選列只顯示「已選縣市」裡有活動的地點。

### `data/events.json`

活動陣列，每筆：

| 欄位 | 說明 |
|---|---|
| `title` | 活動名稱（不含縣市前綴） |
| `city` | 縣市代碼，對應 `meta.json` 的 `cities` |
| `type` / `place` | 對應 `types` / `places` 的代碼 |
| `spot` | 細部位置，例如「夢時代 8F 時代會館」 |
| `start` / `end` | YYYY-MM-DD，`end` 為最後一天（含）。沒有日期的活動不會顯示 |
| `startUnknown` | 報導只寫「即日起」時為 `true`，`start` 填資料更新當天 |
| `works` | 出現的作品，**全部列出作品名**；只有官方未公布完整名單時，才在最後加一行「等 N 部以上（其餘作品官方未公布名稱）」 |
| `highlights` | 特別標註（限定商品、簽名會、只辦一天…），以強調色顯示在最上面 |
| `url` | 官方網址（沒有官方頁時用列出最完整資訊的報導） |

## 規則

- **省 token**：更新資料照 `prompt.md` 的流程，查詢交給 haiku subagent；資料改動只用 `python scripts/data.py validate` 驗證，不截圖、不開瀏覽器。只有改到 `index.html`／`style.css`／`app.js` 的版面時才需要看畫面。

- 改內容只動 `data/`；新增類型時同時在 `app.js` 的 `TYPE_COLOR` 和 `style.css` 加顏色 token。
- 新縣市：在 `meta.json` 的 `cities` 加代碼，地點加到 `places.json` 並填 `city`。
- 不引入框架或建置工具，保持可直接部署到任何靜態主機。
- 外部資源只用 Google Fonts；其他都放在本專案內。
- 本機預覽：直接雙擊 `index.html` 讀不到 `data/`，要在專案資料夾跑 `python -m http.server 8000` 再開 http://localhost:8000。
- 部署：整個資料夾就是網站根目錄，可直接放 GitHub Pages（repo：`frs-tw/acg-event-tw`）、Cloudflare Pages 或 Netlify，不需要建置。
- 手機與直拿的平板（螢幕寬度不到 1000px）用 66% 縮放顯示（等同電腦瀏覽器縮放 66%），比例在 `index.html` 開頭的 `SCALE`。

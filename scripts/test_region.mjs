// 離線測試：只收臺中市的地點（region.js），以及 app.js 送給 Autocomplete 的參數
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  TC_BOUNDS, taichungFromText, keepPrediction, isTaichungPlace, inTaichungBounds, autocompleteRequest,
} from "../region.js";

const pred = (main, sub, full) => ({
  mainText: { text: main },
  secondaryText: sub == null ? null : { text: sub },
  text: { text: full ?? [main, sub].filter(Boolean).join(", ") },
});

test("保留臺中的建議", () => {
  assert.ok(keepPrediction(pred("臺中市政府", "臺中市西屯區臺灣大道三段99號")));
  assert.ok(keepPrediction(pred("臺中市政府", "台灣台中市西屯區")));
  assert.ok(keepPrediction(pred("臺中車站", "東區")));                 // 只有區名
  assert.ok(keepPrediction(pred("臺中車站", "臺中市東區")));
  assert.ok(keepPrediction(pred("新光三越", "西屯區臺灣大道三段301號"))); // 臺灣大道不是國名
  assert.ok(keepPrediction(pred("台北路", "臺中市北區")));              // 路名有別的縣市名
  assert.ok(keepPrediction(pred("彰化路一段", "臺中市北屯區")));
  assert.ok(keepPrediction(pred("大甲鎮瀾宮", "臺中市大甲區")));
  assert.ok(keepPrediction(pred("梧棲漁港", null, "梧棲漁港")));
  assert.ok(keepPrediction(pred("Taichung Station", "Taichung City, Taiwan")));
});

test("丟掉別的縣市", () => {
  assert.equal(keepPrediction(pred("臺北市政府", "臺北市信義區市府路1號")), false);
  assert.equal(keepPrediction(pred("市政府", "台灣台北市信義區")), false);
  assert.equal(keepPrediction(pred("新竹火車站", "新竹市東區")), false);
  assert.equal(keepPrediction(pred("彰化市公所", "彰化縣彰化市")), false);
  assert.equal(keepPrediction(pred("彰化火車站", "彰化市三民路")), false);
  assert.equal(keepPrediction(pred("新北市政府", "新北市板橋區")), false);
  assert.equal(keepPrediction(pred("草屯", "南投縣草屯鎮")), false);
  assert.equal(keepPrediction(pred("苑裡車站", "苗栗縣苑裡鎮")), false);
  assert.equal(keepPrediction(pred("臺南車站", "台南市東區")), false);
  assert.equal(keepPrediction(pred("火車站", "臺灣")), false);           // 完整格式卻沒有臺中
  assert.equal(keepPrediction(pred("Taipei Main Station", "Taipei City, Taiwan")), false);
  assert.equal(keepPrediction(pred("市政府", null, "市政府, 高雄市苓雅區")), false); // 只有全文
});

test("taichungFromText 看不出來就回 null", () => {
  assert.equal(taichungFromText("東區"), null);
  assert.equal(taichungFromText("文心路"), null);
  assert.equal(taichungFromText(""), null);
});

test("選定地點：地址要寫臺中市、座標要在範圍內", () => {
  const ok = { lat: 24.1618, lng: 120.6469, address: "407台灣臺中市西屯區臺灣大道三段99號" };
  assert.ok(isTaichungPlace(ok));
  assert.ok(isTaichungPlace({ ...ok, address: "407台灣台中市西屯區臺灣大道三段99號" }));
  assert.ok(isTaichungPlace({ ...ok, address: "" }));                      // 沒地址只看座標
  assert.equal(isTaichungPlace({ lat: 25.0375, lng: 121.5637, address: "110台灣臺北市信義區市府路1號" }), false);
  assert.equal(isTaichungPlace({ lat: 24.0816, lng: 120.5386, address: "500台灣彰化縣彰化市中山路二段416號" }), false);
  assert.equal(isTaichungPlace({ ...ok, address: "500台灣彰化縣彰化市" }), false);   // 座標在框內但地址是彰化
  assert.equal(isTaichungPlace({ lat: 25.0375, lng: 121.5637, address: "臺中市西屯區" }), false); // 座標在框外
  assert.equal(isTaichungPlace({ ...ok, address: "臺中市政府, 臺灣大道三段, 西屯區, 臺中市, 407, 臺灣" }), true); // Nominatim 格式
});

test("TC_BOUNDS 包住臺中市的邊緣地區", () => {
  const edges = {
    大甲: [24.3489, 120.6227], 大安海岸: [24.3800, 120.5600], 梧棲港: [24.2700, 120.5050],
    龍井: [24.1950, 120.5300], 霧峰: [24.0617, 120.7006], 大里: [24.0995, 120.6779],
    和平谷關: [24.2020, 121.0040], 和平梨山: [24.2550, 121.2500], 雪山: [24.3833, 121.2317],
    南湖大山: [24.3610, 121.4390], 后里: [24.3080, 120.7110],
  };
  for (const [name, [lat, lng]] of Object.entries(edges)) assert.ok(inTaichungBounds(lat, lng), name);
  assert.equal(inTaichungBounds(25.0478, 121.5170), false);   // 臺北車站
  assert.equal(inTaichungBounds(22.9971, 120.2126), false);   // 臺南車站
});

test("Autocomplete 參數：locationRestriction 長方形，沒有 locationBias", () => {
  const token = { t: 1 };
  const req = autocompleteRequest("市政府", token);
  assert.deepEqual(req.locationRestriction, TC_BOUNDS);
  assert.ok(!("locationBias" in req));
  assert.equal(req.sessionToken, token);
  assert.deepEqual(req.includedRegionCodes, ["tw"]);
  assert.equal(req.language, "zh-TW");
  assert.equal(req.region, "tw");
});

test("stub fetchAutocompleteSuggestions：app.js 的 fetchPlaces 用 restriction、過濾臺北", async () => {
  // 從 app.js 抽出 fetchPlaces，接上假的 google.maps，確定實際送出的參數與過濾結果
  const src = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const start = src.indexOf("async function fetchPlaces(");
  const end = src.indexOf("\nfunction selectRow(", start);
  assert.ok(start > 0 && end > start, "找不到 fetchPlaces");
  let sent = null;
  const fake = (main, sub) => ({ placePrediction: { placeId: main, ...pred(main, sub) } });
  const lib = {
    AutocompleteSessionToken: class {},
    AutocompleteSuggestion: {
      async fetchAutocompleteSuggestions(req) {
        sent = req;
        return { suggestions: [fake("臺中市政府", "臺中市西屯區"), fake("臺北市政府", "臺北市信義區"), fake("臺中車站", "東區")] };
      },
    },
  };
  const sg = { seq: 1, token: null, places: [], placesQ: "", open: false };
  const el = { q: { value: "市政府" } };
  const google = { maps: { importLibrary: async () => lib } };
  const run = new Function("google", "sg", "el", "autocompleteRequest", "keepPrediction", "renderSugg",
    src.slice(start, end) + "\nreturn fetchPlaces;")(google, sg, el, autocompleteRequest, keepPrediction, () => {});
  await run("市政府", 1);
  assert.ok(sent, "沒有呼叫 fetchAutocompleteSuggestions");
  assert.deepEqual(sent.locationRestriction, TC_BOUNDS);
  assert.ok(!("locationBias" in sent));
  assert.ok(sent.sessionToken instanceof lib.AutocompleteSessionToken);
  assert.deepEqual(sg.places.map((p) => p.main), ["臺中市政府", "臺中車站"]);
});

test("狀態列不再出現「小型車」", () => {
  const src = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.ok(!src.includes("小型車"));
});

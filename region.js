/* 只收臺中市的地點：Google 地點建議的請求參數，以及前端的地址／座標檢查。
 * 純函式、不碰 DOM，可以用 Node 測試（scripts/test_region.mjs）。
 */

// 涵蓋整個臺中市（西：大甲／大安／梧棲／龍井海岸；東：和平區到雪山、南湖大山；南：霧峰／大里；北：大甲／后里／和平北界）。
// 長方形會包到一點彰化、南投、苗栗、新竹，所以另外用地址文字過濾。
export const TC_BOUNDS = { south: 23.90, west: 120.35, north: 24.60, east: 121.50 };

const ZH_CITIES = "臺北|新北|桃園|臺中|臺南|高雄|基隆|新竹|嘉義|彰化|南投|苗栗|雲林|屏東|宜蘭|花蓮|臺東|澎湖|金門|連江";
// 直轄市／縣／市（「臺北路」「彰化路」這種路名沒有 市／縣，不算）
const ADMIN_RE = new RegExp("(" + ZH_CITIES + ")(市|縣)", "g");
const EN_OTHER_RE = /\b(new taipei|taipei|taoyuan|tainan|kaohsiung|keelung|hsinchu|chiayi|changhua|nantou|miaoli|yunlin|pingtung|yilan|hualien|taitung|penghu|kinmen|lienchiang)\b/i;
const EN_TC_RE = /\btaichung\b/i;
// 看起來是完整地址：有國名或郵遞區號（這種格式一定會寫到縣市）
// 「臺灣大道」是臺中的路名，不算國名
const FULL_ADDR_RE = /(臺灣(?!大道)|中華民國|taiwan|^\s*\d{3}(\d{2,3})?(?=\D))/i;

const toTai = (s) => String(s || "").replace(/台/g, "臺");

/**
 * 一段地址文字是不是臺中市：
 *   true  —— 明確在臺中市（第一個出現的縣市是臺中）
 *   false —— 明確在別的縣市，或是完整地址卻沒寫臺中
 *   null  —— 看不出來（例如只有「東區」或路名），交給 locationRestriction 決定
 */
export function taichungFromText(text) {
  const t = toTai(text);
  if (!t.trim()) return null;
  const admins = [...t.matchAll(ADMIN_RE)].map((m) => m[1]);
  if (admins.length) return admins[0] === "臺中";
  if (EN_TC_RE.test(t)) return true;
  if (EN_OTHER_RE.test(t)) return false;
  if (/臺中/.test(t)) return true;            // 例：「臺中」但沒寫市
  if (FULL_ADDR_RE.test(t)) return false;     // 完整地址卻沒有臺中
  return null;
}

/** Autocomplete 的一筆 placePrediction 要不要留著（看不出來的就留） */
export function keepPrediction(pp) {
  if (!pp) return false;
  const sub = (pp.secondaryText && pp.secondaryText.text) ||
    (pp.structuredFormat && pp.structuredFormat.secondaryText && pp.structuredFormat.secondaryText.text) || "";
  const full = (pp.text && pp.text.text) || "";
  const a = taichungFromText(sub);
  if (a !== null) return a;
  return taichungFromText(full) !== false;
}

export function inTaichungBounds(lat, lng, b = TC_BOUNDS) {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;
}

/**
 * 選定的地點（已有座標、地址）是不是臺中市。
 * 有地址就必須明確寫到臺中市；沒有地址才只看座標。座標一定要在 TC_BOUNDS 內。
 */
export function isTaichungPlace({ lat, lng, address }) {
  if (!inTaichungBounds(lat, lng)) return false;
  if (!address || !String(address).trim()) return true;
  return taichungFromText(address) === true;
}

/** fetchAutocompleteSuggestions 的參數：只用 locationRestriction（不能和 locationBias 同時送） */
export function autocompleteRequest(input, sessionToken) {
  return {
    input,
    sessionToken,
    locationRestriction: { ...TC_BOUNDS },
    includedRegionCodes: ["tw"],
    language: "zh-TW",
    region: "tw",
  };
}

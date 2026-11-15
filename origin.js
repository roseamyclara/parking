// 起點與導航：純函式，app.js 和離線測試共用（scripts/test_origin.mjs）
// origin：{ lat, lng, label, kind: "place" | "gps" } 或 null
//   place：搜尋／點選的地點 → 距離與導航都從這裡算
//   gps：離我最近 → 導航不帶 origin，讓 Google 地圖用裝置目前位置

export const hasGeo = (it) => it.lat != null && it.lng != null;

export const fmtDist = (km) => km == null ? "" : km < 1 ? Math.round(km * 1000) + " 公尺" : km.toFixed(1) + " 公里";

const isPlace = (o) => !!(o && o.kind === "place" && o.lat != null && o.lng != null);

/** 「距離 臺中車站 1.2 公里」；GPS 起點只寫「距離 1.2 公里」；沒有距離就回傳空字串 */
export function distLabel(km, origin) {
  if (km == null || !origin) return "";
  return "距離 " + (isPlace(origin) && origin.label ? origin.label + " " : "") + fmtDist(km);
}

// 座標只推估到行政區中心的停車場，目的地改用名稱＋地址，免得把人帶到區公所附近
export function navUrl(it, origin = null) {
  const dest = hasGeo(it) && it.precision !== "DISTRICT"
    ? it.lat + "," + it.lng
    : [it.name, it.address || it.location].filter(Boolean).join(" ");
  const from = isPlace(origin) ? "&origin=" + Number(origin.lat) + "," + Number(origin.lng) : "";
  return "https://www.google.com/maps/dir/?api=1" + from + "&destination=" + encodeURIComponent(dest);
}

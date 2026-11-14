/* 臺中市身障免銷單停車場地圖 — 前端程式
 *
 * 地圖：Google Maps JavaScript API（動態載入 importLibrary）
 *       + AdvancedMarkerElement + @googlemaps/markerclusterer
 * 沒有金鑰或載入失敗時，清單／搜尋／篩選／離我最近／地點搜尋（Nominatim）照常可用。
 */

const DATA_URL = "./data/parkings.json";
const API_KEY = String(window.GOOGLE_MAPS_API_KEY || "").trim();
const MAP_ID = String(window.GOOGLE_MAPS_MAP_ID || "").trim() || "DEMO_MAP_ID";
const CLUSTERER_URL = "https://cdn.jsdelivr.net/npm/@googlemaps/markerclusterer@2.6.2/dist/index.min.js";
const CLUSTERER_SRI = "sha256-5CYbkAYIv0kYxvYTBB1AFQz4ajAqlmZ/gUIXFtaWgv8=";
const TC_CENTER = { lat: 24.1477, lng: 120.6736 };
const TC_BOUNDS = { south: 23.90, west: 120.35, north: 24.60, east: 121.50 };
const MAX_FIT_ZOOM = 16;

const $ = (id) => document.getElementById(id);
const el = {};
["q", "clearQ", "searchForm", "btnNear", "fDistrict", "fSort", "accessChips", "accessCount",
 "placeHint", "placeHintText", "placeSearchBtn", "originBar", "originName", "clearOrigin",
 "list", "resultCount", "geoNote", "metaCount", "footMeta", "footDates", "toast",
 "tabbar", "tabList", "tabMap", "listpane", "mappane", "map", "mapMsg",
 "themeSel", "themeSystemOpt"].forEach((id) => { el[id] = $(id); });

const state = {
  items: [],
  byId: new Map(),
  filtered: [],
  query: "",
  district: "",
  access: new Set(),
  sort: "default",
  origin: null,        // { lat, lng, label }
  activeId: null,
  dataReady: false,
};

const mqDark = matchMedia("(prefers-color-scheme: dark)");
const mqNarrow = matchMedia("(max-width: 51.25em)");
const mqReduce = matchMedia("(prefers-reduced-motion: reduce)");

/* =====================================================================
 * helpers
 * ===================================================================== */
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add("on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.remove("on"), 3200);
}

function haversine(a, b, c, d) {
  const R = 6371, p = Math.PI / 180;
  const dLat = (c - a) * p, dLng = (d - b) * p;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const fmtDist = (km) => km == null ? "" : km < 1 ? Math.round(km * 1000) + " 公尺" : km.toFixed(1) + " 公里";
const norm = (s) => (s || "").replace(/台/g, "臺").toLowerCase();
const hasGeo = (it) => it.lat != null && it.lng != null;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function navUrl(it) {
  const dest = hasGeo(it) ? it.lat + "," + it.lng : (it.address || it.name);
  return "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(dest);
}

function h(tag, props, ...children) {
  const n = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v; else if (k === "text") n.textContent = v; else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}

/* =====================================================================
 * 外觀（跟隨系統／淺色／深色）
 * ===================================================================== */
const schemeMeta = document.querySelector('meta[name="color-scheme"]');
const themeColorMetas = [...document.querySelectorAll('meta[name="theme-color"]')];
const THEME_COLORS = { light: "#0d5a8a", dark: "#121a22" };

function storedScheme() {
  const v = schemeMeta.content;
  return v === "light" || v === "dark" ? v : "light dark";
}
function resolvedScheme() {
  const v = storedScheme();
  return v === "light dark" ? (mqDark.matches ? "dark" : "light") : v;
}
function syncThemeUI() {
  el.themeSel.value = storedScheme();
  el.themeSystemOpt.textContent = "跟隨系統（目前：" + (mqDark.matches ? "深色" : "淺色") + "）";
  const v = storedScheme();
  themeColorMetas.forEach((m) => {
    const isDarkMeta = (m.media || "").includes("dark");
    m.content = v === "light dark" ? THEME_COLORS[isDarkMeta ? "dark" : "light"] : THEME_COLORS[v];
  });
}
function setScheme(v) {
  schemeMeta.content = v;
  try {
    if (v === "light dark") localStorage.removeItem("color-scheme");
    else localStorage.setItem("color-scheme", v);
  } catch (e) { /* 無法儲存時仍套用到本頁 */ }
  syncThemeUI();
  onSchemeChange();
}
el.themeSel.addEventListener("change", () => setScheme(el.themeSel.value));
mqDark.addEventListener("change", () => { syncThemeUI(); onSchemeChange(); });
window.addEventListener("storage", (e) => {
  if (e.key !== "color-scheme") return;
  schemeMeta.content = e.newValue || "light dark";
  syncThemeUI();
  onSchemeChange();
});
syncThemeUI();

/* =====================================================================
 * Google Maps
 * ===================================================================== */
const G = {
  ready: null,         // Promise<boolean>
  failed: false,
  map: null,
  scheme: null,
  libs: null,          // { Map, InfoWindow, LatLngBounds, AdvancedMarkerElement, PinElement }
  MC: null,            // markerClusterer UMD namespace
  clusterer: null,
  info: null,
  markers: new Map(),  // id -> AdvancedMarkerElement (per map instance)
  originMarker: null,
  pendingFit: null,    // function to run when the map becomes visible
  placesBroken: false,
  geocoderBroken: false,
};

function showMapMsg(title, html) {
  el.mapMsg.replaceChildren(h("h2", { text: title }));
  el.mapMsg.insertAdjacentHTML("beforeend", html);
  el.mapMsg.hidden = false;
  document.body.classList.add("nomap");
}

function bootstrapMapsLoader(opts) {
  // Google 官方的動態載入 bootstrap（https://developers.google.com/maps/documentation/javascript/load-maps-js-api）
  /* eslint-disable */
  (g=>{var h,a,k,p="The Google Maps JavaScript API",c="google",l="importLibrary",q="__ib__",m=document,b=window;b=b[c]||(b[c]={});var d=b.maps||(b.maps={}),r=new Set,e=new URLSearchParams,u=()=>h||(h=new Promise(async(f,n)=>{await (a=m.createElement("script"));e.set("libraries",[...r]+"");for(k in g)e.set(k.replace(/[A-Z]/g,t=>"_"+t[0].toLowerCase()),g[k]);e.set("callback",c+".maps."+q);a.src=`https://maps.${c}apis.com/maps/api/js?`+e;d[q]=f;a.onerror=()=>h=n(Error(p+" could not load."));a.nonce=m.querySelector("script[nonce]")?.nonce||"";m.head.append(a)}));d[l]?console.warn(p+" only loads once. Ignoring:",g):d[l]=(f,...n)=>r.add(f)&&u().then(()=>d[l](f,...n))})(opts);
  /* eslint-enable */
}

function loadScript(src, integrity) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    if (integrity) { s.integrity = integrity; s.crossOrigin = "anonymous"; }
    s.onload = resolve;
    s.onerror = () => reject(new Error("無法載入 " + src));
    document.head.append(s);
  });
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("載入逾時")), ms))]);
}

function mapLoadError(detail) {
  G.failed = true;
  showMapMsg("Google 地圖暫時無法顯示",
    "<p>地圖載入失敗" + (detail ? "（" + esc(detail) + "）" : "") +
    "。可能是金鑰無效、此網域未獲授權，或網路連線問題。</p>" +
    "<p>停車場清單、搜尋、篩選與「在 Google 地圖導航」連結仍可正常使用。</p>");
}

function initMaps() {
  // 金鑰錯誤、網域限制（RefererNotAllowedMapError）時 Google 會呼叫這個函式
  window.gm_authFailure = () => { if (!G.failed) mapLoadError("金鑰驗證失敗"); };
  watchMapsConsoleErrors();

  bootstrapMapsLoader({ key: API_KEY, v: "weekly", language: "zh-TW", region: "TW" });
  const imp = google.maps.importLibrary;

  const clustererP = loadScript(CLUSTERER_URL, CLUSTERER_SRI)
    .then(() => window.markerClusterer || null)
    .catch((e) => { console.warn("markerclusterer 載入失敗，改為不分群", e); return null; });

  G.ready = withTimeout(Promise.all([imp("maps"), imp("marker"), imp("core")]), 20000)
    .then(async ([maps, marker, core]) => {
      G.libs = {
        Map: maps.Map, InfoWindow: maps.InfoWindow, LatLngBounds: core.LatLngBounds,
        AdvancedMarkerElement: marker.AdvancedMarkerElement, PinElement: marker.PinElement,
      };
      G.MC = await clustererP;
      if (G.failed) return false;
      buildMap();
      return true;
    })
    .catch((err) => {
      console.error(err);
      mapLoadError(err && err.message === "載入逾時" ? "載入逾時" : "無法連線到 Google 地圖");
      return false;
    });
}

// 帳單未啟用、API 未啟用、網域未授權等錯誤，Google 只會在 console 印出
// 「Google Maps JavaScript API error: XxxMapError」（部分才會呼叫 gm_authFailure），
// 地圖本身會變成灰底浮水印。這裡攔截那行訊息，改顯示看得懂的說明。
const MAP_ERROR_HINTS = {
  BillingNotEnabledMapError: "Google Cloud 專案尚未啟用帳單",
  ApiNotActivatedMapError: "尚未啟用 Maps JavaScript API",
  RefererNotAllowedMapError: "此網址未列在金鑰允許的 HTTP 參照網址中",
  InvalidKeyMapError: "金鑰無效",
  ExpiredKeyMapError: "金鑰已失效",
  DeletedApiProjectMapError: "金鑰所屬的專案已刪除",
  ApiProjectMapError: "金鑰或專案設定有誤",
};
function watchMapsConsoleErrors() {
  const orig = console.error;
  console.error = function (...args) {
    const m = /Google Maps JavaScript API error:\s*(\w+MapError)/.exec(args.map(String).join(" "));
    if (m && !G.failed) mapLoadError(MAP_ERROR_HINTS[m[1]] || m[1]);
    return orig.apply(this, args);
  };
}

function pinColors(active) {
  const dark = resolvedScheme() === "dark";
  if (active) return { background: "#e8590c", borderColor: dark ? "#ffffff" : "#7a2a00", glyphColor: "#ffffff", scale: 1.3 };
  return dark
    ? { background: "#6cb8ec", borderColor: "#e3f2fd", glyphColor: "#0b1a26", scale: 1 }
    : { background: "#0f5c8c", borderColor: "#083a5a", glyphColor: "#ffffff", scale: 1 };
}
function makePin(active) {
  const pin = new G.libs.PinElement(pinColors(active));
  return pin instanceof Element ? pin : pin.element;
}

function buildMap() {
  const { Map, InfoWindow } = G.libs;
  const prev = G.map ? { center: G.map.getCenter(), zoom: G.map.getZoom() } : null;

  if (G.clusterer) { G.clusterer.clearMarkers(); G.clusterer.setMap(null); G.clusterer = null; }
  if (G.info) G.info.close();
  G.markers.forEach((m) => { m.map = null; });
  G.markers.clear();
  if (G.originMarker) { G.originMarker.map = null; G.originMarker = null; }

  const holder = h("div", { style: "width:100%;height:100%" });
  el.map.replaceChildren(holder);

  const scheme = resolvedScheme();
  const CS = google.maps.ColorScheme;
  G.scheme = scheme;
  G.map = new Map(holder, {
    center: prev ? prev.center : TC_CENTER,
    zoom: prev ? prev.zoom : 12,
    mapId: MAP_ID,
    colorScheme: CS ? (scheme === "dark" ? CS.DARK : CS.LIGHT) : undefined,
    clickableIcons: false,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: true,
  });
  G.info = new InfoWindow({ maxWidth: 300 });

  if (G.MC && G.MC.MarkerClusterer) {
    const algorithm = G.MC.SuperClusterAlgorithm
      ? new G.MC.SuperClusterAlgorithm({ radius: 60, maxZoom: MAX_FIT_ZOOM - 1 })
      : undefined;
    G.clusterer = new G.MC.MarkerClusterer({ map: G.map, algorithm, renderer: { render: renderCluster } });
  }

  if (state.origin) placeOriginMarker();
  if (state.dataReady) {
    renderMarkers();
    if (!prev) fitToResults();
  }
}

function renderCluster({ count, position }) {
  const size = count < 10 ? 2.4 : count < 50 ? 2.9 : 3.4;
  const div = h("div", { class: "cluster", style: "--s:" + size + "rem", text: String(count) });
  return new G.libs.AdvancedMarkerElement({
    position, content: div, zIndex: 1000 + count,
    title: "這一區有 " + count + " 座停車場，點一下放大",
  });
}

function getMarker(it) {
  let m = G.markers.get(it.id);
  if (m) return m;
  m = new G.libs.AdvancedMarkerElement({
    position: { lat: it.lat, lng: it.lng },
    title: it.name,
    content: makePin(it.id === state.activeId),
    gmpClickable: true,
  });
  m.addEventListener("gmp-click", () => setActive(it.id, { fromMap: true }));
  G.markers.set(it.id, m);
  return m;
}

function renderMarkers() {
  if (!G.map) return;
  const visible = state.filtered.filter(hasGeo).map(getMarker);
  if (G.clusterer) {
    G.clusterer.clearMarkers(true);
    G.clusterer.addMarkers(visible);
  } else {
    const keep = new Set(visible);
    G.markers.forEach((m) => { m.map = keep.has(m) ? G.map : null; });
  }
  if (state.activeId && !visible.some((m) => m === G.markers.get(state.activeId))) G.info.close();
}

function infoContent(it) {
  const d = it._d != null ? h("p", { text: "距離約 " + fmtDist(it._d) }) : null;
  return h("div", { class: "iw" },
    h("p", { text: it.location || it.address }),
    h("p", { class: "iw-access", text: "進出場方式：" + (it.access || "—") }),
    d,
    h("a", { href: navUrl(it), target: "_blank", rel: "noopener", text: "在 Google 地圖導航 →" }),
  );
}

function openInfo(it, focus) {
  if (!G.map || !hasGeo(it)) return;
  G.info.setOptions({
    headerContent: h("h3", { class: "iw-title", text: it.name }),
    content: infoContent(it),
    position: { lat: it.lat, lng: it.lng },
    pixelOffset: new google.maps.Size(0, -54),
    ariaLabel: it.name,
  });
  G.info.open({ map: G.map, shouldFocus: !!focus });
}

function placeOriginMarker() {
  if (!G.map) return;
  if (G.originMarker) G.originMarker.map = null;
  G.originMarker = new G.libs.AdvancedMarkerElement({
    map: G.map,
    position: { lat: state.origin.lat, lng: state.origin.lng },
    content: h("div", { class: "origin-dot" }),
    title: "起點：" + state.origin.label,
    zIndex: 5000,
  });
}

function mapVisible() {
  return el.map.offsetWidth > 0 && el.map.offsetHeight > 0;
}

function fitPoints(pts) {
  if (!G.map || !pts.length) return;
  const run = () => {
    if (pts.length === 1) { G.map.setCenter(pts[0]); G.map.setZoom(15); return; }
    const b = new G.libs.LatLngBounds();
    pts.forEach((p) => b.extend(p));
    G.map.fitBounds(b, 48);
    google.maps.event.addListenerOnce(G.map, "idle", () => {
      if (G.map.getZoom() > MAX_FIT_ZOOM) G.map.setZoom(MAX_FIT_ZOOM);
    });
  };
  if (mapVisible()) { G.pendingFit = null; run(); } else G.pendingFit = run;
}

function fitToResults() {
  const pts = state.filtered.filter(hasGeo).map((i) => ({ lat: i.lat, lng: i.lng }));
  if (state.origin) pts.push({ lat: state.origin.lat, lng: state.origin.lng });
  fitPoints(pts);
}

function onSchemeChange() {
  // colorScheme 只能在建立地圖時指定，所以外觀改變時重建地圖（保留中心與縮放）
  if (G.map && G.scheme !== resolvedScheme()) {
    buildMap();
    if (state.activeId) openInfo(state.byId.get(state.activeId), false);
  }
}

/* =====================================================================
 * 篩選與清單
 * ===================================================================== */
function applyFilters() {
  const q = norm(state.query.trim());
  const out = state.items.filter((it) => {
    if (state.district && it.district !== state.district) return false;
    if (state.access.size && !state.access.has(it.access)) return false;
    if (q && norm(it.name + " " + it.location + " " + it.district + " " + it.access).indexOf(q) === -1) return false;
    return true;
  });

  out.forEach((it) => {
    it._d = state.origin && hasGeo(it) ? haversine(state.origin.lat, state.origin.lng, it.lat, it.lng) : null;
  });

  const sort = state.sort === "distance" && !state.origin ? "default" : state.sort;
  if (sort === "distance") {
    out.sort((a, b) => (a._d == null) - (b._d == null) || a._d - b._d);
  } else if (sort === "name") {
    out.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
  } else {
    out.sort((a, b) => (parseInt(a.seq, 10) || 9999) - (parseInt(b.seq, 10) || 9999));
  }

  state.filtered = out;
  renderList();
  renderMarkers();
  updatePlaceHint();
}

function cardHTML(it) {
  const geo = hasGeo(it);
  const active = state.activeId === it.id;
  return '<li class="card' + (active ? " active" : "") + '" data-id="' + esc(it.id) + '">' +
    '<h3><button type="button" class="main" data-act="select"' + (active ? ' aria-current="true"' : "") + ">" + esc(it.name) + "</button></h3>" +
    '<p class="loc">' + esc(it.location || it.address) + "</p>" +
    '<div class="tags">' +
      (it._d != null ? '<span class="badge dist">距離約 ' + fmtDist(it._d) + "</span>" : "") +
      '<span class="badge"><span class="visually-hidden">進出場方式：</span>' + esc(it.access || "—") + "</span>" +
      (geo ? "" : '<span class="badge nogeo">座標待補</span>') +
    "</div>" +
    '<div class="cardactions">' +
      (geo ? '<button type="button" class="btn locate" data-act="locate"><span aria-hidden="true">🗺️</span> 在地圖上看</button>' : "") +
      '<a class="btn" href="' + esc(navUrl(it)) + '" target="_blank" rel="noopener"><span aria-hidden="true">🧭</span> 在 Google 地圖導航<span class="visually-hidden">（另開新分頁）</span></a>' +
    "</div>" +
  "</li>";
}

function renderList() {
  if (!state.filtered.length) {
    el.list.innerHTML = '<li class="empty">找不到符合的停車場。<br>試試換個關鍵字，或把它當成「地點」搜尋附近停車場。</li>';
  } else {
    el.list.innerHTML = state.filtered.map(cardHTML).join("");
  }
  el.resultCount.textContent = "顯示 " + state.filtered.length + " / " + state.items.length + " 座停車場";
}

function setActive(id, { pan = false, fromMap = false } = {}) {
  const prevId = state.activeId;
  state.activeId = id;

  for (const card of el.list.querySelectorAll(".card.active")) {
    card.classList.remove("active");
    card.querySelector(".main")?.removeAttribute("aria-current");
  }
  const card = el.list.querySelector('.card[data-id="' + CSS.escape(id) + '"]');
  if (card) {
    card.classList.add("active");
    card.querySelector(".main").setAttribute("aria-current", "true");
    if (fromMap) card.scrollIntoView({ block: "nearest", behavior: mqReduce.matches ? "auto" : "smooth" });
  }

  if (!G.map) return;
  if (prevId && prevId !== id && G.markers.has(prevId)) {
    const pm = G.markers.get(prevId);
    pm.content = makePin(false); pm.zIndex = null;
  }
  const it = state.byId.get(id);
  const m = G.markers.get(id);
  if (m) { m.content = makePin(true); m.zIndex = 4000; }
  if (it && hasGeo(it)) {
    if (pan) {
      G.map.panTo({ lat: it.lat, lng: it.lng });
      if (G.map.getZoom() < MAX_FIT_ZOOM) G.map.setZoom(MAX_FIT_ZOOM);
    }
    openInfo(it, fromMap);
  }
}

/* =====================================================================
 * 起點（離我最近／地點搜尋）
 * ===================================================================== */
function setOrigin(lat, lng, label) {
  state.origin = { lat, lng, label };
  el.originName.textContent = label;
  el.originBar.hidden = false;
  state.sort = "distance";
  el.fSort.value = "distance";
  placeOriginMarker();
  applyFilters();

  const pts = state.filtered.filter((i) => i._d != null).slice(0, 8).map((i) => ({ lat: i.lat, lng: i.lng }));
  pts.push({ lat, lng });
  fitPoints(pts);
  el.list.scrollTop = 0;
}

function clearOrigin() {
  state.origin = null;
  el.originBar.hidden = true;
  if (G.originMarker) { G.originMarker.map = null; G.originMarker = null; }
  if (state.sort === "distance") { state.sort = "default"; el.fSort.value = "default"; }
  applyFilters();
  fitToResults();
  el.q.focus();
}

function setNearBusy(busy) {
  el.btnNear.disabled = busy;
  el.btnNear.querySelector(".lbl").textContent = busy ? "定位中…" : "離我最近";
}

function locateMe() {
  if (!navigator.geolocation) { toast("此瀏覽器不支援定位功能"); return; }
  setNearBusy(true);
  navigator.geolocation.getCurrentPosition((pos) => {
    setNearBusy(false);
    setOrigin(pos.coords.latitude, pos.coords.longitude, "我的位置");
  }, (err) => {
    setNearBusy(false);
    toast(err.code === 1
      ? "已拒絕定位權限，請在瀏覽器設定中開啟，或改用地點搜尋"
      : "無法取得目前位置，請改用地點搜尋");
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
}

async function googlePlaces(q) {
  const { Place } = await google.maps.importLibrary("places");
  const { places } = await Place.searchByText({
    textQuery: q,
    fields: ["displayName", "location"],
    locationBias: { center: TC_CENTER, radius: 40000 },
    language: "zh-TW",
    region: "tw",
    maxResultCount: 1,
  });
  const p = places && places[0];
  return p && p.location ? { lat: p.location.lat(), lng: p.location.lng() } : null;
}

async function googleGeocode(q) {
  const { Geocoder } = await google.maps.importLibrary("geocoding");
  const { results } = await new Geocoder().geocode({ address: q, bounds: TC_BOUNDS, region: "tw", language: "zh-TW" });
  const r = results && results[0];
  return r ? { lat: r.geometry.location.lat(), lng: r.geometry.location.lng() } : null;
}

async function nominatim(q) {
  const query = q.includes("臺中") || q.includes("台中") ? q : "臺中市 " + q;
  const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=tw" +
              "&accept-language=zh-TW&viewbox=120.35,24.60,121.50,23.90&q=" + encodeURIComponent(query);
  const rows = await (await fetch(url)).json();
  return rows && rows.length ? { lat: parseFloat(rows[0].lat), lng: parseFloat(rows[0].lon) } : null;
}

// 有金鑰時優先用 Google（Places → Geocoding），失敗或沒結果再退回 OpenStreetMap Nominatim
async function geocodePlace(q) {
  if (API_KEY && G.ready && (await G.ready) && !G.failed) {
    if (!G.placesBroken) {
      try { const r = await googlePlaces(q); if (r) return r; }
      catch (e) { G.placesBroken = true; console.warn("Places 搜尋失敗，改用其他方式", e); }
    }
    if (!G.geocoderBroken) {
      try { const r = await googleGeocode(q); if (r) return r; }
      catch (e) { if (!/ZERO_RESULTS/.test(String(e && (e.code || e.message)))) G.geocoderBroken = true; console.warn("Geocoder 失敗", e); }
    }
  }
  return nominatim(q);
}

let placeBusy = false;
async function searchPlace(text) {
  const q = text.trim();
  if (!q || placeBusy) return;
  placeBusy = true;
  el.placeSearchBtn.disabled = true;
  el.placeSearchBtn.textContent = "搜尋中…";
  try {
    const r = await geocodePlace(q);
    if (!r) { toast("找不到「" + q + "」這個地點"); return; }
    state.query = "";
    el.q.value = "";
    el.clearQ.hidden = true;
    setOrigin(r.lat, r.lng, q);
    toast("已定位到「" + q + "」，依距離排序");
  } catch (e) {
    console.error(e);
    toast("地點搜尋服務暫時無法使用");
  } finally {
    placeBusy = false;
    el.placeSearchBtn.disabled = false;
    el.placeSearchBtn.textContent = "搜尋這個地點附近的停車場";
  }
}

function updatePlaceHint() {
  const q = state.query.trim();
  if (q.length >= 2) {
    el.placeHint.hidden = false;
    el.placeHintText.textContent = state.filtered.length
      ? "把「" + q + "」當成地點？"
      : "沒有符合的停車場。把「" + q + "」當成地點試試？";
  } else {
    el.placeHint.hidden = true;
  }
}

/* =====================================================================
 * 清單／地圖分頁（小螢幕）
 * ===================================================================== */
const tabs = [
  { btn: el.tabList, pane: el.listpane, name: "list" },
  { btn: el.tabMap, pane: el.mappane, name: "map" },
];

function selectTab(name, focus) {
  document.body.dataset.tab = name;
  tabs.forEach((t) => {
    const on = t.name === name;
    t.btn.setAttribute("aria-selected", String(on));
    t.btn.tabIndex = on ? 0 : -1;
  });
  if (focus) tabs.find((t) => t.name === name).btn.focus();
  if (name === "map" && G.pendingFit) requestAnimationFrame(() => { const f = G.pendingFit; G.pendingFit = null; f && f(); });
}

function setupTabs() {
  if (mqNarrow.matches) {
    // 只有在真的是分頁介面時才套用 tab 語意
    el.tabbar.setAttribute("role", "tablist");
    tabs.forEach((t) => {
      t.btn.setAttribute("role", "tab");
      t.pane.setAttribute("role", "tabpanel");
      t.pane.setAttribute("aria-labelledby", t.btn.id);
    });
    selectTab(document.body.dataset.tab === "map" ? "map" : "list");
  } else {
    el.tabbar.removeAttribute("role");
    tabs.forEach((t) => {
      t.btn.removeAttribute("role"); t.btn.removeAttribute("aria-selected"); t.btn.removeAttribute("tabindex");
      t.pane.removeAttribute("role");
    });
    el.listpane.setAttribute("aria-labelledby", "listTitle");
    el.mappane.removeAttribute("aria-labelledby");
    document.body.dataset.tab = "both";
    if (G.pendingFit) requestAnimationFrame(() => { const f = G.pendingFit; G.pendingFit = null; f && f(); });
  }
}
document.querySelector(".skip").addEventListener("click", () => { if (mqNarrow.matches) selectTab("list"); });
el.tabList.addEventListener("click", () => { if (mqNarrow.matches) selectTab("list"); });
el.tabMap.addEventListener("click", () => { if (mqNarrow.matches) selectTab("map"); });
el.tabbar.addEventListener("keydown", (e) => {
  if (!mqNarrow.matches) return;
  const keys = { ArrowLeft: -1, ArrowRight: 1, Home: "first", End: "last" };
  if (!(e.key in keys)) return;
  e.preventDefault();
  const cur = tabs.findIndex((t) => t.btn === document.activeElement);
  let i = keys[e.key] === "first" ? 0 : keys[e.key] === "last" ? tabs.length - 1
        : (cur + keys[e.key] + tabs.length) % tabs.length;
  selectTab(tabs[i].name, true);
});
mqNarrow.addEventListener("change", setupTabs);

/* =====================================================================
 * 事件
 * ===================================================================== */
let debounce;
el.q.addEventListener("input", () => {
  state.query = el.q.value;
  el.clearQ.hidden = !el.q.value;
  clearTimeout(debounce);
  debounce = setTimeout(applyFilters, 150);
});
el.q.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  // 注音／倉頡等輸入法選字時按 Enter 只是確認候選字，不能當成送出
  if (e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  clearTimeout(debounce);
  state.query = el.q.value;
  applyFilters();
  if (state.query.trim() && !state.filtered.length) searchPlace(state.query);
  else if (mqNarrow.matches) el.q.blur();   // 手機上收起鍵盤，讓結果露出來
});
el.searchForm.addEventListener("submit", (e) => e.preventDefault());
el.clearQ.addEventListener("click", () => {
  el.q.value = ""; state.query = ""; el.clearQ.hidden = true;
  clearTimeout(debounce); applyFilters(); el.q.focus();
});
el.placeSearchBtn.addEventListener("click", () => searchPlace(state.query));
el.btnNear.addEventListener("click", locateMe);
el.clearOrigin.addEventListener("click", clearOrigin);
el.fDistrict.addEventListener("change", () => { state.district = el.fDistrict.value; applyFilters(); fitToResults(); });
el.fSort.addEventListener("change", () => {
  if (el.fSort.value === "distance" && !state.origin) {
    toast("請先按「離我最近」或搜尋一個地點");
    el.fSort.value = state.sort;
    return;
  }
  state.sort = el.fSort.value;
  applyFilters();
});

el.list.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = btn.closest(".card").dataset.id;
  if (btn.dataset.act === "locate") {
    if (mqNarrow.matches) selectTab("map");
    requestAnimationFrame(() => setActive(id, { pan: true }));
  } else {
    setActive(id, { pan: true });
  }
});

/* =====================================================================
 * 啟動
 * ===================================================================== */
setupTabs();

if (API_KEY) {
  initMaps();
} else {
  G.ready = Promise.resolve(false);
  showMapMsg("尚未設定 Google 地圖金鑰",
    "<p>請在 <code>parking/config.js</code> 設定 <code>GOOGLE_MAPS_API_KEY</code> 後重新整理，地圖就會出現。</p>" +
    "<p>在那之前，停車場清單、搜尋、篩選、離我最近與「在 Google 地圖導航」連結都可以正常使用。</p>");
}

fetch(DATA_URL, { cache: "no-cache" })
  .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
  .then((data) => {
    state.items = data.items || [];
    state.items.forEach((it) => state.byId.set(it.id, it));

    el.fDistrict.append(...(data.districts || []).map((d) => h("option", { value: d, text: d })));

    (data.access_types || []).forEach((a) => {
      const b = h("button", { type: "button", class: "chip", "aria-pressed": "false", text: a });
      b.addEventListener("click", () => {
        const on = !state.access.has(a);
        on ? state.access.add(a) : state.access.delete(a);
        b.setAttribute("aria-pressed", String(on));
        el.accessCount.textContent = state.access.size ? "（已選 " + state.access.size + "）" : "";
        applyFilters();
      });
      el.accessChips.append(b);
    });

    const count = data.count ?? state.items.length;
    const missing = count - (data.geocoded ?? state.items.filter(hasGeo).length);
    const gen = (data.generated_at || "").replace("T", " ").slice(0, 16);
    el.metaCount.textContent = "共 " + count + " 座";
    el.geoNote.textContent = missing ? missing + " 筆座標待補" : "";
    el.footMeta.textContent = "資料更新：" + (gen || "未知") + "（每日 00:00 自動更新）";
    el.footDates.textContent = "官網公告更新日：" + (data.page_updated || "未知") +
      "；本站資料產生時間：" + (gen || "未知") + "。";

    state.dataReady = true;
    applyFilters();
    if (G.map) fitToResults();
  })
  .catch((err) => {
    el.list.innerHTML = '<li class="empty">資料載入失敗（' + esc(err.message) +
      '）。<br>若是剛建立網站，請先在 GitHub Actions 手動執行一次「每日更新停車場資料」。</li>';
    el.metaCount.textContent = "資料載入失敗";
  });

/* 臺中市身障免銷單停車場地圖 — 前端程式
 *
 * 版面：手機是全螢幕地圖＋浮動搜尋列＋可拖曳的底部面板（清單／詳情／篩選），
 *       桌機是左側面板＋右側地圖。同一套 DOM，用 CSS 斷點切換。
 * 地圖：Google Maps JavaScript API（動態載入 importLibrary）
 *       + AdvancedMarkerElement + @googlemaps/markerclusterer
 * 即時車位：臺中市交通局開放資料（availability.js），與 Google 金鑰無關。
 * 沒有金鑰或載入失敗時，清單／搜尋／篩選／離我最近／地點搜尋（Nominatim）照常可用。
 */
import { createAvailability, STATUS } from "./availability.js";

const DATA_URL = "./data/parkings.json";
const API_KEY = String(window.GOOGLE_MAPS_API_KEY || "").trim();
const MAP_ID = String(window.GOOGLE_MAPS_MAP_ID || "").trim() || "DEMO_MAP_ID";
const CLUSTERER_URL = "https://cdn.jsdelivr.net/npm/@googlemaps/markerclusterer@2.6.2/dist/index.min.js";
const CLUSTERER_SRI = "sha256-5CYbkAYIv0kYxvYTBB1AFQz4ajAqlmZ/gUIXFtaWgv8=";
const TC_CENTER = { lat: 24.1477, lng: 120.6736 };
const TC_BOUNDS = { south: 23.90, west: 120.35, north: 24.60, east: 121.50 };
const MAX_FIT_ZOOM = 16;          // 「顯示全部結果」時最多放大到這裡
const CLUSTER_MAX_ZOOM = 14;      // 這個縮放（含）以下才分群；15 以上一律顯示個別標記
const FOCUS_ZOOM = CLUSTER_MAX_ZOOM + 1;
const FOCUS_MAX_ZOOM = 17;        // 搜尋地點時最多放大到這裡（避免只剩一棟樓）
const LOT_ZOOM = 16;              // 選一座停車場時的縮放
const NEAR_KM = 0.4;              // 搜尋地點後，用來決定畫面範圍的「附近」半徑（手機面板在中段時，地圖可見高度只剩約 160px）
const CLUSTER_PX = 40;            // 估算會不會被分群的距離（SuperCluster radius 60 / extent 512 ≈ 30px，取寬一點）
const PLACES_BIAS = { center: TC_CENTER, radius: 40000 };   // 以臺中市中心 40 公里為優先範圍

// 搜尋建議
const SUGG_LOTS = 6, SUGG_PLACES = 5, SUGG_MIN = 2, SUGG_DEBOUNCE = 300;
// Google 評分與評論（localStorage 快取；保護每月免費額度）
const LS = { pid: "pk:pid:", rv: "pk:rv:", day: "pk:rv-day" };
const RV_TTL = 7 * 864e5;         // 評分／評論快取 7 天
const PID_MISS_TTL = 3 * 864e5;   // 找不到對應地點：3 天內不再查
const RV_DAILY_CAP = 25;          // 這個瀏覽器每天（臺灣時間）最多呼叫幾次 Place Details（不含快取）
const RV_SHOW = 3;                // 先顯示幾則評論

const $ = (id) => document.getElementById(id);
const el = {};
["q", "clearQ", "searchForm", "searchbar", "btnNear", "btnFilter", "filterBadge", "fDistrict", "sortSeg", "sortHint",
 "accessChips", "accessCount", "placeSearchBtn", "placeHintText", "originBar", "originName", "clearOrigin",
 "sheet", "sheetHead", "sheetBody", "grab", "grabLabel", "list", "listTitle", "resultCount", "listSub", "resetFilters",
 "detail", "detailBack", "dName", "filtersTitle", "filtersDone", "aboutLink", "about", "availNote",
 "metaCount", "footDates", "toast", "liveCount", "mappane", "map", "mapMsg", "themeSeg", "themeSystemLbl",
 "sugg", "suggList", "suggFoot", "suggStatus",
].forEach((id) => { el[id] = $(id); });
el.heads = { list: el.sheet.querySelector(".head-list"), detail: el.sheet.querySelector(".head-detail"), filters: el.sheet.querySelector(".head-filters") };
el.views = { list: el.sheet.querySelector(".view-list"), detail: el.detail, filters: el.sheet.querySelector(".view-filters") };

const state = {
  items: [],
  byId: new Map(),
  filtered: [],
  query: "",
  district: "",
  access: new Set(),      // 原始進出場方式字串
  accessGroups: [],       // [{ label, values: [...] }]
  sort: "default",
  origin: null,           // { lat, lng, label }
  activeId: null,
  dataReady: false,
};

const ui = { view: "list", snap: "peek", filtersFrom: null, listScroll: 0 };

// 搜尋建議的狀態（Google 自動完成的 session token 也在這裡）
const sg = {
  open: false, rows: [], active: -1, activeKey: null,
  places: [], placesQ: "", seq: 0, timer: 0,
  token: null,            // AutocompleteSessionToken：一次輸入工作階段共用，結束就丟掉
  composing: false, broken: false,
};

const root = document.documentElement;
const mqDark = matchMedia("(prefers-color-scheme: dark)");
const mqNarrow = matchMedia("(max-width: 51.25em)");
const mqReduce = matchMedia("(prefers-reduced-motion: reduce)");
const isSheet = () => mqNarrow.matches;

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
const fmtTime = (d) => d ? d.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
const norm = (s) => (s || "").replace(/台/g, "臺").toLowerCase();
const hasGeo = (it) => it.lat != null && it.lng != null;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 座標只推估到行政區中心的停車場，導航改用名稱＋地址，免得把人帶到區公所附近
function navUrl(it) {
  const dest = hasGeo(it) && it.precision !== "DISTRICT"
    ? it.lat + "," + it.lng
    : [it.name, it.address || it.location].filter(Boolean).join(" ");
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

/** 只接受 https 連結（Google 回傳的網址也不直接信任） */
const safeUrl = (u) => (typeof u === "string" && /^https:\/\//i.test(u) ? u : "");

/** localStorage：讀到壞掉的 JSON 就刪掉；滿了就先清掉舊的評論快取再試一次 */
const store = {
  get(k) {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : null;
    } catch (e) { store.del(k); return null; }
  },
  set(k, v) {
    let s;
    try { s = JSON.stringify(v); } catch (e) { return false; }
    try { localStorage.setItem(k, s); return true; } catch (e) { /* 容量不足或被停用 */ }
    pruneReviewCache(true);
    try { localStorage.setItem(k, s); return true; } catch (e) { return false; }
  },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};

function pruneReviewCache(aggressive) {
  try {
    const rows = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LS.rv)) continue;
      const v = store.get(k);
      rows.push([k, (v && v.fetchedAt) || 0]);
    }
    rows.sort((a, b) => a[1] - b[1]);
    const now = Date.now();
    rows.forEach(([k, t], i) => {
      if (now - t > RV_TTL || (aggressive && i < Math.ceil(rows.length / 2))) store.del(k);
    });
  } catch (e) { /* ignore */ }
}

/** 臺灣時間的今天（YYYY-MM-DD），給每日上限用 */
const taipeiDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());

/** 進出場方式的短標籤（卡片、篩選用）；完整文字留在詳情 */
function shortAccess(a) {
  let s = String(a || "").trim();
  if (!s) return "—";
  const rest = /其餘\s*(.+)$/.exec(s);
  if (/致電/.test(s) && rest) return rest[1].trim() + "（部分區域需致電）";
  return s.replace(/\s*-\s*$/, "").replace(/\s+-\s+/g, "・")
    .replace(/\s*\(\s*/g, "（").replace(/\s*\)\s*/g, "）");
}

/** 只抓文字裡明確寫出的電話號碼，不自己編 */
function findPhones(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/(?<!\d)(09\d{2}-?\d{3}-?\d{3}|0\d{1,2}-\d{3,4}-\d{3,4})(?!\d)/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

const SEP = '<span class="sep" aria-hidden="true">·</span><span class="visually-hidden">，</span>';
const ICON_NAV = '<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path d="M12 2.5 20.5 21 12 16.8 3.5 21 12 2.5Z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const ICON_PHONE = '<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><path d="M6.6 3.5h3l1.4 4.2-2 1.3a12 12 0 0 0 6 6l1.3-2 4.2 1.4v3a2 2 0 0 1-2.2 2A17.5 17.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

/* =====================================================================
 * 外觀（跟隨系統／淺色／深色）
 * ===================================================================== */
const schemeMeta = document.querySelector('meta[name="color-scheme"]');
const themeColorMetas = [...document.querySelectorAll('meta[name="theme-color"]')];
const THEME_COLORS = { light: "#f4f6f9", dark: "#14171c" };

function storedScheme() {
  const v = schemeMeta.content;
  return v === "light" || v === "dark" ? v : "light dark";
}
function resolvedScheme() {
  const v = storedScheme();
  return v === "light dark" ? (mqDark.matches ? "dark" : "light") : v;
}
function syncThemeUI() {
  const v = storedScheme();
  for (const r of el.themeSeg.querySelectorAll("input")) r.checked = r.value === v;
  el.themeSystemLbl.parentElement.title = "跟隨系統（目前：" + (mqDark.matches ? "深色" : "淺色") + "）";
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
el.themeSeg.addEventListener("change", (e) => { if (e.target.name === "theme") setScheme(e.target.value); });
mqDark.addEventListener("change", () => { syncThemeUI(); onSchemeChange(); });
window.addEventListener("storage", (e) => {
  if (e.key !== "color-scheme") return;
  schemeMeta.content = e.newValue || "light dark";
  syncThemeUI();
  onSchemeChange();
});
syncThemeUI();

/* =====================================================================
 * 即時車位燈號
 * ===================================================================== */
const avail = createAvailability({
  getItems: () => state.items,
  onChange: paintAvailability,
});

function statusOf(id) {
  const a = avail.lookup(id);
  return a ? { ...STATUS[a.code], code: a.code, total: a.total } : null;
}

function statusHTML(id, detailed) {
  const s = statusOf(id);
  if (!s) {
    return detailed ? '<p class="status" data-s="none"><i class="sdot" aria-hidden="true"></i>無即時車位資料</p>' : "";
  }
  if (!detailed && s.code === "B") return "";   // 卡片上不顯示「無即時資料」，保持簡潔
  const total = detailed && s.total ? '<span class="muted">・共 ' + s.total + " 格</span>" : "";
  return '<p class="status" data-s="' + s.key + '"><i class="sdot" aria-hidden="true"></i>' +
    "<span><span class=\"visually-hidden\">即時車位：</span>" + s.label + total + "</span></p>";
}

function paintAvailability() {
  for (const card of el.list.querySelectorAll(".card")) {
    const old = card.querySelector(".status");
    const html = statusHTML(card.dataset.id, false);
    if (old) { if (html) old.outerHTML = html; else old.remove(); }
    else if (html) card.querySelector(".c-main").insertAdjacentHTML("beforeend", html);
  }
  G.markers.forEach((m, id) => {
    const s = statusOf(id);
    m.content.dataset.s = s ? s.key : "";
    const it = state.byId.get(id);
    if (it) m.title = it.name + (s && s.code !== "B" ? "（" + s.label + "）" : "");
  });
  if (ui.view === "detail") {
    const box = el.detail.querySelector(".d-status");
    if (box) box.innerHTML = detailStatusInner(state.byId.get(state.activeId));
  }
  renderListHead();
  el.availNote.textContent = avail.updatedAt
    ? "目前有 " + avail.matchedCount + " 座停車場對應到即時資料，最後更新 " + fmtTime(avail.updatedAt) + "。"
    : "";
}

/* =====================================================================
 * 底部面板（手機）：量測、吸附點、拖曳、鍵盤
 * ===================================================================== */
const geo = { vh: 0, kb: 0, topReserve: 0, sheetH: 0, vis: 0, snaps: { peek: 0, mid: 0, full: 0 } };
const SNAP_ORDER = ["peek", "mid", "full"];

function layout() {
  const vv = window.visualViewport;
  const vh = vv ? vv.height : innerHeight;
  const vvTop = vv ? vv.offsetTop : 0;
  const kb = vv ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) : 0;
  root.style.setProperty("--vv-top", vvTop + "px");
  root.style.setProperty("--kb", kb + "px");
  root.style.setProperty("--vvh", Math.round(vh) + "px");
  geo.kb = kb;
  if (!isSheet()) {
    root.style.removeProperty("--sheet-vis");
    root.style.removeProperty("--map-bottom");
    return;
  }
  const rem = parseFloat(getComputedStyle(root).fontSize) || 16;
  const sbBottom = el.searchbar.getBoundingClientRect().bottom - vvTop;
  const topReserve = Math.round(sbBottom + 0.5 * rem);
  const sheetH = Math.max(12 * rem, Math.round(vh - topReserve));
  const peek = Math.min(sheetH, Math.round(Math.min(Math.max(12.5 * rem, vh * 0.3), 19 * rem)));
  const mid = Math.min(sheetH, Math.max(peek + 4 * rem, Math.round(vh * 0.56)));
  Object.assign(geo, { vh, kb, topReserve, sheetH, snaps: { peek, mid, full: sheetH } });
  root.style.setProperty("--top-reserve", topReserve + "px");
  root.style.setProperty("--sheet-h", sheetH + "px");
  root.style.setProperty("--map-bottom", (peek + kb) + "px");
  if (!drag.on) applySheet(geo.snaps[ui.snap]);
}

function applySheet(vis) {
  geo.vis = vis;
  root.style.setProperty("--sheet-vis", Math.round(vis) + "px");
}

function setSnap(name, { history: syncHist = true } = {}) {
  ui.snap = name;
  el.sheet.dataset.snap = name;
  document.body.classList.toggle("sheet-full", isSheet() && name === "full");
  el.grab.setAttribute("aria-expanded", String(name !== "peek"));
  el.grabLabel.textContent = name === "full" ? "收合面板" : "展開面板";
  if (isSheet()) applySheet(geo.snaps[name]);
  if (syncHist) syncHistory();
}

function nextSnap(dir) {
  const i = SNAP_ORDER.indexOf(ui.snap);
  return SNAP_ORDER[Math.max(0, Math.min(SNAP_ORDER.length - 1, i + dir))];
}

// ---- 拖曳：把手與標題列隨時可拖；清單在面板未全開時往上拖就是拉高面板 ----
const drag = { on: false, pid: null, startY: 0, startVis: 0, lastY: 0, lastT: 0, v: 0, moved: false, suppressUntil: 0 };

function dragBegin(y, pid) {
  Object.assign(drag, { on: true, pid, startY: y, startVis: geo.vis, lastY: y, lastT: performance.now(), v: 0, moved: false });
}
function dragMove(y) {
  const dy = y - drag.startY;
  if (!drag.moved) {
    if (Math.abs(dy) < 6) return;
    drag.moved = true;
    el.sheet.classList.add("dragging");
  }
  const { peek, full } = geo.snaps;
  let vis = drag.startVis - dy;
  if (vis > full) vis = full + (vis - full) * 0.15;
  if (vis < peek) vis = peek - (peek - vis) * 0.35;
  const now = performance.now(), dt = now - drag.lastT;
  if (dt > 0) drag.v = 0.7 * ((drag.lastY - y) / dt) + 0.3 * drag.v;   // 往上為正（px/ms）
  drag.lastY = y; drag.lastT = now;
  applySheet(vis);
}
function dragEnd() {
  if (!drag.on) return false;
  drag.on = false;
  el.sheet.classList.remove("dragging");
  if (!drag.moved) return false;
  const vis = geo.vis;
  let target;
  if (Math.abs(drag.v) > 0.4 && performance.now() - drag.lastT < 120) {
    const vals = SNAP_ORDER.map((k) => [k, geo.snaps[k]]);
    target = drag.v > 0
      ? (vals.find(([, v]) => v > vis + 4) || vals[vals.length - 1])[0]
      : ([...vals].reverse().find(([, v]) => v < vis - 4) || vals[0])[0];
  } else {
    target = SNAP_ORDER.reduce((a, k) => Math.abs(geo.snaps[k] - vis) < Math.abs(geo.snaps[a] - vis) ? k : a, "peek");
  }
  setSnap(target);
  drag.suppressUntil = performance.now() + 350;   // 拖完放開不要觸發卡片點擊
  return true;
}

el.sheet.addEventListener("pointerdown", (e) => {
  if (!isSheet() || drag.on || (e.pointerType === "mouse" && e.button !== 0)) return;
  const inHead = el.sheetHead.contains(e.target);
  const inBody = el.sheetBody.contains(e.target);
  if (!inHead && !(inBody && ui.snap !== "full")) return;
  if (e.target.closest("input, select")) return;
  dragBegin(e.clientY, e.pointerId);
});
window.addEventListener("pointermove", (e) => { if (drag.on && e.pointerId === drag.pid) dragMove(e.clientY); });
const endPointer = (e) => { if (drag.on && e.pointerId === drag.pid) dragEnd(); };
window.addEventListener("pointerup", endPointer);
window.addEventListener("pointercancel", endPointer);
el.sheet.addEventListener("click", (e) => {
  if (performance.now() < drag.suppressUntil) { e.preventDefault(); e.stopPropagation(); }
}, true);

// 面板全開時：清單捲到最頂再往下拉，就是把面板拉下來（觸控事件才能在捲動開始前攔截）
let tg = null;
el.sheetBody.addEventListener("touchstart", (e) => {
  tg = isSheet() && ui.snap === "full" && e.touches.length === 1 ? { y: e.touches[0].clientY, mode: null } : null;
}, { passive: true });
el.sheetBody.addEventListener("touchmove", (e) => {
  if (!tg) return;
  const y = e.touches[0].clientY;
  if (tg.mode === null) {
    const dy = y - tg.y;
    if (Math.abs(dy) < 6) return;
    tg.mode = dy > 0 && el.sheetBody.scrollTop <= 0 ? "drag" : "scroll";
    if (tg.mode === "drag") dragBegin(tg.y, null);
  }
  if (tg.mode === "drag") { if (e.cancelable) e.preventDefault(); dragMove(y); }
}, { passive: false });
const endTouch = () => { if (tg && tg.mode === "drag") dragEnd(); tg = null; };
el.sheetBody.addEventListener("touchend", endTouch);
el.sheetBody.addEventListener("touchcancel", endTouch);

// 滑鼠滾輪：面板未全開時往下滾＝拉高面板
let wheelLock = 0;
el.sheetBody.addEventListener("wheel", (e) => {
  if (!isSheet() || ui.snap === "full" || e.deltaY <= 0) return;
  e.preventDefault();
  if (performance.now() < wheelLock) return;
  wheelLock = performance.now() + 400;
  setSnap(nextSnap(1));
}, { passive: false });

// 把手：點一下循環切換；方向鍵上下調整
el.grab.addEventListener("click", () => {
  setSnap(ui.snap === "full" ? "peek" : nextSnap(1));
});
el.grab.addEventListener("keydown", (e) => {
  const map = { ArrowUp: 1, ArrowDown: -1 };
  if (e.key in map) { e.preventDefault(); setSnap(nextSnap(map[e.key])); }
  else if (e.key === "Home") { e.preventDefault(); setSnap("peek"); }
  else if (e.key === "End") { e.preventDefault(); setSnap("full"); }
});

// 鍵盤移到被面板遮住的卡片時，自動把面板拉高
el.sheetBody.addEventListener("focusin", (e) => {
  if (!isSheet() || ui.snap === "full" || e.target === el.list) return;
  if (!e.target.matches(":focus-visible")) return;   // 只處理鍵盤移動焦點，程式設定的焦點不算
  const r = e.target.getBoundingClientRect();
  if (r.bottom > innerHeight - geo.kb - 8) setSnap("full");
});

// 搜尋框有焦點時（虛擬鍵盤開著）收起浮動按鈕
el.q.addEventListener("focus", () => document.body.classList.add("kb-open"));
el.q.addEventListener("blur", () => document.body.classList.remove("kb-open"));

let layoutRaf = 0;
const queueLayout = () => { cancelAnimationFrame(layoutRaf); layoutRaf = requestAnimationFrame(layout); };
window.addEventListener("resize", queueLayout);
if (window.visualViewport) {
  visualViewport.addEventListener("resize", queueLayout);
  visualViewport.addEventListener("scroll", queueLayout);
}
if (window.ResizeObserver) new ResizeObserver(queueLayout).observe(el.searchbar);

/* =====================================================================
 * 面板內容：清單／詳情／篩選，以及「返回鍵」歷史紀錄
 * ===================================================================== */
const VIEW_LABEL = { list: "停車場清單", detail: "停車場詳情", filters: "篩選與設定" };

function setView(v) {
  if (ui.view === "list" && v !== "list") ui.listScroll = el.sheetBody.scrollTop;
  ui.view = v;
  el.sheet.dataset.view = v;
  el.sheet.setAttribute("aria-label", VIEW_LABEL[v]);
  for (const k of Object.keys(el.views)) {
    el.views[k].hidden = k !== v;
    el.heads[k].hidden = k !== v;
  }
  el.btnFilter.setAttribute("aria-expanded", String(v === "filters"));
  if (v === "list") el.sheetBody.scrollTop = ui.listScroll;
  else el.sheetBody.scrollTop = 0;
  queueLayout();
}

function focusNoScroll(node) { if (node) node.focus({ preventScroll: true }); }

function openDetail(id, { fromMap = false, focus = true } = {}) {
  const it = state.byId.get(id);
  if (!it) return;
  const prevId = state.activeId;
  state.activeId = id;
  markActive(prevId, id);
  setView("detail");
  renderDetail();
  if (isSheet() && ui.snap === "peek") setSnap("mid", { history: false });
  syncHistory();
  panToItem(it, fromMap);
  if (focus) focusNoScroll(el.dName);
}

function closeDetail({ focus = true } = {}) {
  const id = state.activeId;
  state.activeId = null;
  markActive(id, null);
  setView("list");
  syncHistory();
  if (focus) {
    const btn = id && el.list.querySelector('.card[data-id="' + CSS.escape(id) + '"] .main');
    focusNoScroll(btn || el.list);
  }
}

function openFilters() {
  if (ui.view === "filters") return;
  if (sg.open) closeSugg({ abandon: true, history: false });
  ui.filtersFrom = { view: ui.view, snap: ui.snap };
  setView("filters");
  if (isSheet()) setSnap("full", { history: false });
  syncHistory();
  focusNoScroll(el.filtersTitle);
}

function closeFilters({ focus = true } = {}) {
  if (ui.view !== "filters") return;
  const from = ui.filtersFrom || { view: "list", snap: "peek" };
  ui.filtersFrom = null;
  const back = from.view === "detail" && state.activeId ? "detail" : "list";
  setView(back);
  if (back === "detail") renderDetail();
  if (isSheet()) setSnap(from.snap === "peek" ? "mid" : from.snap, { history: false });
  syncHistory();
  if (focus) focusNoScroll(el.btnFilter);
}

document.querySelector(".skip").addEventListener("click", () => { if (isSheet() && ui.snap === "peek") setSnap("mid"); });
el.btnFilter.addEventListener("click", () => (ui.view === "filters" ? closeFilters() : openFilters()));
el.filtersDone.addEventListener("click", () => closeFilters());
el.detailBack.addEventListener("click", () => closeDetail());
el.aboutLink.addEventListener("click", () => {
  openFilters();
  requestAnimationFrame(() => { el.about.scrollIntoView({ block: "start" }); focusNoScroll(el.about); });
});

/** 依目前狀態關掉最上層：篩選 → 詳情 → 面板高度。沒有可關的就回傳 false */
function closeTop({ focus = true } = {}) {
  if (sg.open) { closeSugg({ abandon: true, history: false }); return true; }
  if (ui.view === "filters") { closeFilters({ focus }); return true; }
  if (state.activeId) { closeDetail({ focus }); return true; }
  if (isSheet() && ui.snap !== "peek") { setSnap("peek"); return true; }
  return false;
}

// ---- 歷史紀錄：每開一層就 pushState，返回鍵（Android／瀏覽器）一次關一層，不會直接離開本頁 ----
let histDepth = 0;
let ignorePops = 0;
let histResync = false;   // history.go() 是非同步的：還沒回來之前先不要 pushState，等 popstate 後再對齊
function desiredDepth() {
  return (sg.open ? 1 : 0) + (ui.view === "filters" ? 1 : 0) + (state.activeId ? 1 : 0) + (isSheet() && ui.snap !== "peek" ? 1 : 0);
}
function syncHistory() {
  if (ignorePops > 0) { histResync = true; return; }
  const d = desiredDepth();
  while (histDepth < d) history.pushState({ pk: ++histDepth }, "");
  if (histDepth > d) {
    const n = histDepth - d;
    histDepth = d;
    ignorePops++;
    history.go(-n);
  }
}
window.addEventListener("popstate", () => {
  if (ignorePops > 0) {
    ignorePops--;
    if (!ignorePops && histResync) { histResync = false; syncHistory(); }
    return;
  }
  histDepth = Math.max(0, histDepth - 1);
  if (!closeTop({ focus: false })) {
    // 重新整理後殘留的舊紀錄：沒有東西可關就繼續往回
    if (history.state && history.state.pk) history.back();
    return;
  }
  syncHistory();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (e.target === el.q && el.q.value) return;   // 讓搜尋框自己清除文字
  if (closeTop()) e.preventDefault();
});

/* =====================================================================
 * Google Maps
 * ===================================================================== */
const G = {
  ready: null,         // Promise<boolean>
  failed: false,
  map: null,
  scheme: null,
  libs: null,          // { Map, LatLngBounds, AdvancedMarkerElement }
  MC: null,            // markerClusterer UMD namespace
  clusterer: null,
  markers: new Map(),  // id -> AdvancedMarkerElement (per map instance)
  originMarker: null,
  camSeq: 0,           // 每次移動鏡頭 +1，舊的 idle 回呼就不再動作
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
    "<p>下方清單、搜尋、篩選、即時車位與「導航」仍可正常使用。</p>");
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
      G.libs = { Map: maps.Map, LatLngBounds: core.LatLngBounds, AdvancedMarkerElement: marker.AdvancedMarkerElement };
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

function mapControlOptions() {
  const CP = google.maps.ControlPosition;
  return {
    zoomControl: !isSheet(),          // 手機用雙指縮放，畫面保持乾淨
    zoomControlOptions: CP ? { position: CP.RIGHT_TOP } : undefined,
  };
}

function buildMap() {
  const { Map } = G.libs;
  const prev = G.map ? { center: G.map.getCenter(), zoom: G.map.getZoom() } : null;

  if (G.clusterer) { G.clusterer.clearMarkers(); G.clusterer.setMap(null); G.clusterer = null; }
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
    disableDefaultUI: true,
    gestureHandling: "greedy",       // 整頁不捲動，單指即可拖曳地圖
    ...mapControlOptions(),
  });
  // 點地圖空白處：先收起詳情，再把面板降回最低
  G.map.addListener("click", () => {
    if (sg.open) closeSugg({ abandon: true });
    else if (state.activeId) closeDetail({ focus: false });
    else if (ui.view === "filters") closeFilters({ focus: false });
    else if (isSheet() && ui.snap !== "peek") setSnap("peek");
  });

  if (G.MC && G.MC.MarkerClusterer) {
    const algorithm = G.MC.SuperClusterAlgorithm
      ? new G.MC.SuperClusterAlgorithm({ radius: 60, maxZoom: CLUSTER_MAX_ZOOM })
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
  const size = count < 10 ? 2.25 : count < 50 ? 2.75 : 3.25;
  const div = h("div", { class: "cluster", style: "--s:" + size + "rem", text: String(count) });
  return new G.libs.AdvancedMarkerElement({
    position, content: div, zIndex: 1000 + count,
    title: "這一區有 " + count + " 座停車場，點一下放大",
  });
}

function pinContent(it) {
  const s = statusOf(it.id);
  const d = h("div", { class: "pin" + (it.id === state.activeId ? " active" : "") }, h("b", { text: "P" }), h("i"));
  d.dataset.s = s ? s.key : "";
  return d;
}

function getMarker(it) {
  let m = G.markers.get(it.id);
  if (m) return m;
  const s = statusOf(it.id);
  m = new G.libs.AdvancedMarkerElement({
    position: { lat: it.lat, lng: it.lng },
    title: it.name + (s && s.code !== "B" ? "（" + s.label + "）" : ""),
    content: pinContent(it),
    gmpClickable: true,
    zIndex: it.id === state.activeId ? 4000 : null,
  });
  m.addEventListener("gmp-click", () => openDetail(it.id, { fromMap: true }));
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
}

function markActive(prevId, id) {
  for (const card of el.list.querySelectorAll(".card.active")) {
    card.classList.remove("active");
    card.querySelector(".main")?.removeAttribute("aria-current");
  }
  if (id) {
    const card = el.list.querySelector('.card[data-id="' + CSS.escape(id) + '"]');
    if (card) {
      card.classList.add("active");
      card.querySelector(".main").setAttribute("aria-current", "true");
    }
  }
  if (!G.map) return;
  if (prevId && G.markers.has(prevId)) {
    const pm = G.markers.get(prevId);
    pm.content.classList.remove("active"); pm.zIndex = null;
  }
  if (id && G.markers.has(id)) {
    const m = G.markers.get(id);
    m.content.classList.add("active"); m.zIndex = 4000;
  }
}

/** 地圖上沒被搜尋列和面板蓋住的區域（像素） */
function mapPadding() {
  if (!isSheet()) return { top: 48, right: 48, bottom: 48, left: 48 };
  const cover = Math.max(0, geo.vis - geo.snaps.peek);
  return { top: geo.topReserve + 8, right: 24, bottom: cover + 24, left: 24 };
}

/* ---------- 鏡頭：用 Web Mercator 世界座標自己算，一次移到位，不用 fitBounds 再修正 ---------- */
function worldPx(lat, lng) {
  const sin = Math.min(Math.max(Math.sin(lat * Math.PI / 180), -0.9999), 0.9999);
  return { x: (lng + 180) / 360 * 256, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 256 };
}
function fromWorld(x, y) {
  const n = Math.PI - 2 * Math.PI * y / 256;
  return { lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lng: x / 256 * 360 - 180 };
}

/** 讓 pt 落在「搜尋列以下、面板以上」那塊可見區域正中間時，地圖中心該在哪 */
function paddedCenter(pt, zoom, pad = mapPadding()) {
  const w = worldPx(pt.lat, pt.lng), k = 2 ** zoom;
  return fromWorld(w.x - (pad.left - pad.right) / 2 / k, w.y - (pad.top - pad.bottom) / 2 / k);
}

/** 能把所有點放進可見區域（扣掉 padding 與標記本身的大小）的最大整數縮放，以及中心點 */
function fitFor(pts, pad) {
  const div = G.map.getDiv();
  const M = 28;   // 標記約 2rem 高，邊緣留一點
  const aw = Math.max(80, div.clientWidth - pad.left - pad.right - 2 * M);
  const ah = Math.max(80, div.clientHeight - pad.top - pad.bottom - 2 * M);
  const ws = pts.map((p) => worldPx(p.lat, p.lng));
  const xs = ws.map((w) => w.x), ys = ws.map((w) => w.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const zx = x1 > x0 ? Math.log2(aw / (x1 - x0)) : 99;
  const zy = y1 > y0 ? Math.log2(ah / (y1 - y0)) : 99;
  return { zoom: Math.floor(Math.min(zx, zy)), mid: fromWorld((x0 + x1) / 2, (y0 + y1) / 2) };
}

function moveCam(center, zoom) {
  G.camSeq++;
  if (!mqReduce.matches && zoom === G.map.getZoom()) G.map.panTo(center);   // 同縮放時平移；減少動態效果時直接跳過去
  else if (typeof G.map.moveCamera === "function") G.map.moveCamera({ center, zoom });
  else G.map.setOptions({ center, zoom });
}

/** 以這幾座停車場估算：在 zoom 下會不會和別的標記被分到同一群 */
function wouldCluster(near, zoom) {
  if (!G.clusterer || zoom > CLUSTER_MAX_ZOOM) return false;
  const k = 2 ** zoom;
  const pool = state.filtered.filter(hasGeo).map((i) => [i, worldPx(i.lat, i.lng)]);
  return near.some((a) => {
    const wa = worldPx(a.lat, a.lng);
    return pool.some(([b, wb]) => b !== a && Math.hypot((wa.x - wb.x) * k, (wa.y - wb.y) * k) < CLUSTER_PX);
  });
}

/** 停好之後再確認一次：附近的停車場、或可見範圍內還有分群圓圈，就放大到不分群的縮放 */
function ensureUnclustered(near, pt, seq) {
  if (seq !== G.camSeq || !G.clusterer || G.map.getZoom() > CLUSTER_MAX_ZOOM) return;
  const mine = new Set(near.map((i) => G.markers.get(i.id)).filter(Boolean));
  const z = G.map.getZoom(), k = 2 ** z, pad = mapPadding(), div = G.map.getDiv();
  const c0 = G.map.getCenter(), cw = worldPx(c0.lat(), c0.lng());
  const inView = (pos) => {
    if (!pos) return false;
    const w = worldPx(typeof pos.lat === "function" ? pos.lat() : pos.lat, typeof pos.lng === "function" ? pos.lng() : pos.lng);
    const x = (w.x - cw.x) * k + div.clientWidth / 2, y = (w.y - cw.y) * k + div.clientHeight / 2;
    return x > pad.left && x < div.clientWidth - pad.right && y > pad.top && y < div.clientHeight - pad.bottom;
  };
  const stuck = (G.clusterer.clusters || []).some((c) => c.markers && c.markers.length > 1 &&
    (c.markers.some((m) => mine.has(m)) || inView(c.position)));
  if (stuck) moveCam(paddedCenter(pt, FOCUS_ZOOM), FOCUS_ZOOM);
}

/** 搜尋地點／離我最近：附近少數幾座停車場（不是前 8 座，免得縮到半個城市） */
function nearbyLots(lat, lng) {
  const pool = state.filtered.filter(hasGeo)
    .map((it) => [it, haversine(lat, lng, it.lat, it.lng)])
    .sort((a, b) => a[1] - b[1]);
  let near = pool.filter(([, d]) => d <= NEAR_KM).slice(0, 5);
  if (!near.length) near = pool.filter(([, d]) => d <= 2.5).slice(0, 3);
  if (!near.length) near = pool.slice(0, 1);
  return near.map(([it]) => it);
}

/** 把起點和附近停車場放進可見區域，而且放大到它們都是個別標記 */
function focusArea(pt, near) {
  if (!G.map) return;
  const pad = mapPadding();
  const f = fitFor([pt, ...near], pad);
  let zoom = Math.max(11, Math.min(FOCUS_MAX_ZOOM, f.zoom));
  let center = f.mid;
  // 起點附近就有停車場（市區）或估計會分群：直接用不分群的縮放，以起點為中心
  const close = near.length && haversine(pt.lat, pt.lng, near[0].lat, near[0].lng) <= 1.5;
  if (zoom < FOCUS_ZOOM && (close || wouldCluster(near, zoom))) { zoom = FOCUS_ZOOM; center = pt; }
  moveCam(paddedCenter(center, zoom, pad), zoom);
  const seq = G.camSeq;
  google.maps.event.addListenerOnce(G.map, "idle", () => setTimeout(() => ensureUnclustered(near, pt, seq), 60));
}

/** 手機鍵盤收起、面板高度變好之後再執行（最多等 600ms） */
function whenSettled(fn) {
  const t0 = performance.now();
  const tick = () => {
    layout();
    if (geo.kb > 0 && performance.now() - t0 < 600) { setTimeout(tick, 50); return; }
    requestAnimationFrame(fn);
  };
  tick();
}

function panToItem(it, fromMap) {
  if (!G.map || !hasGeo(it)) return;
  const cur = G.map.getZoom();
  // 從清單或搜尋建議選：放大到 16（> CLUSTER_MAX_ZOOM，周圍停車場都是個別標記）；在地圖上點的保持原縮放
  const zoom = fromMap ? cur : Math.max(cur, LOT_ZOOM);
  moveCam(paddedCenter({ lat: it.lat, lng: it.lng }, zoom), zoom);
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

function fitPoints(pts) {
  if (!G.map || !pts.length) return;
  const seq = ++G.camSeq;
  if (pts.length === 1) { G.map.setCenter(pts[0]); G.map.setZoom(15); return; }
  const b = new G.libs.LatLngBounds();
  pts.forEach((p) => b.extend(p));
  G.map.fitBounds(b, mapPadding());
  google.maps.event.addListenerOnce(G.map, "idle", () => {
    // 之後若已經有別的鏡頭移動（例如選了搜尋建議），就不要再把縮放壓回來
    if (seq === G.camSeq && G.map.getZoom() > MAX_FIT_ZOOM) G.map.setZoom(MAX_FIT_ZOOM);
  });
}

function fitToResults() {
  const pts = state.filtered.filter(hasGeo).map((i) => ({ lat: i.lat, lng: i.lng }));
  if (state.origin) pts.push({ lat: state.origin.lat, lng: state.origin.lng });
  fitPoints(pts);
}

function onSchemeChange() {
  // colorScheme 只能在建立地圖時指定，所以外觀改變時重建地圖（保留中心與縮放）
  if (G.map && G.scheme !== resolvedScheme()) buildMap();
}

/* =====================================================================
 * 篩選與清單
 * ===================================================================== */
function filtersActive() {
  return (state.district ? 1 : 0) + state.accessGroups.filter((g) => g.values.some((v) => state.access.has(v))).length;
}

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
  if (state.activeId && !out.some((it) => it.id === state.activeId) && ui.view === "detail") closeDetail({ focus: false });
  renderList();
  renderMarkers();
  updatePlaceHint();
  syncFilterUI();
}

function cardHTML(it) {
  const active = state.activeId === it.id;
  const meta = [];
  if (it._d != null) meta.push('<span class="dist">' + fmtDist(it._d) + "</span>");
  meta.push(esc(it.district));
  meta.push('<span class="visually-hidden">進出場方式：</span>' + esc(shortAccess(it.access)));
  if (!hasGeo(it)) meta.push("座標待補");
  return '<li class="card' + (active ? " active" : "") + '" data-id="' + esc(it.id) + '">' +
    '<div class="c-main">' +
      '<h3><button type="button" class="main" data-act="select"' + (active ? ' aria-current="true"' : "") + ">" + esc(it.name) + "</button></h3>" +
      '<p class="c-meta">' + meta.join(SEP) + "</p>" +
      statusHTML(it.id, false) +
    "</div>" +
    '<a class="nav" href="' + esc(navUrl(it)) + '" target="_blank" rel="noopener" aria-label="導航到' + esc(it.name) + '（Google 地圖，另開新分頁）">' +
      ICON_NAV + '<span aria-hidden="true">導航</span></a>' +
  "</li>";
}

function renderList() {
  if (!state.filtered.length) {
    const q = state.query.trim();
    el.list.innerHTML = '<li class="empty">' +
      (q ? "沒有名稱或路名含「" + esc(q) + "」的停車場。<br>按 Enter 或點上方建議，改找這個地點附近的停車場。"
         : "沒有符合篩選條件的停車場。") +
      (filtersActive() ? '<br><button type="button" class="btn tonal" data-act="reset">清除篩選</button>' : "") +
      "</li>";
  } else {
    el.list.innerHTML = state.filtered.map(cardHTML).join("");
  }
  renderListHead();
  announceCount();
}

function renderListHead() {
  const n = state.filtered.length, total = state.items.length;
  if (!state.dataReady) return;
  const narrowed = n !== total || state.query.trim();
  el.resultCount.textContent = narrowed ? "找到 " + n + " 座停車場" : total + " 座停車場";
  const sort = state.sort === "distance" && state.origin ? "依距離（" + state.origin.label + "）"
    : state.sort === "name" ? "依名稱" : "依公告順序";
  const parts = [sort];
  if (avail.updatedAt) parts.push("車位 " + fmtTime(avail.updatedAt) + " 更新");
  el.listSub.textContent = parts.join("・");
  el.resetFilters.hidden = !filtersActive();
  el.filtersDone.textContent = "顯示 " + n + " 座";
}

let announceT;
function announceCount() {
  clearTimeout(announceT);
  announceT = setTimeout(() => {
    el.liveCount.textContent = "顯示 " + state.filtered.length + " / " + state.items.length + " 座停車場";
  }, 700);
}

function syncFilterUI() {
  const n = filtersActive();
  el.filterBadge.hidden = !n;
  el.filterBadge.textContent = n ? String(n) : "";
  el.btnFilter.setAttribute("aria-label", "篩選與設定" + (n ? "（已套用 " + n + " 項篩選）" : ""));
  const sel = state.accessGroups.filter((g) => g.values.some((v) => state.access.has(v))).length;
  el.accessCount.textContent = sel ? "（已選 " + sel + "）" : "";
  const distRadio = el.sortSeg.querySelector('input[value="distance"]');
  distRadio.disabled = !state.origin;
  el.sortHint.hidden = !!state.origin;
  const effective = state.sort === "distance" && !state.origin ? "default" : state.sort;
  for (const r of el.sortSeg.querySelectorAll("input")) r.checked = r.value === effective;
}

function resetFilters() {
  state.district = "";
  el.fDistrict.value = "";
  state.access.clear();
  for (const c of el.accessChips.querySelectorAll(".chip")) c.setAttribute("aria-pressed", "false");
  applyFilters();
  fitToResults();
}

/* ---------- 詳情 ---------- */
function detailStatusInner(it) {
  if (!it) return "";
  const s = statusOf(it.id);
  const when = s && avail.updatedAt ? "<small>" + fmtTime(avail.updatedAt) + " 更新・交通局開放資料</small>" : "";
  return statusHTML(it.id, true) + when;
}

function renderDetail() {
  const it = state.byId.get(state.activeId);
  if (!it) return;
  el.dName.textContent = it.name;
  const meta = [];
  if (it._d != null) meta.push('<span class="dist">距離約 ' + fmtDist(it._d) + "</span>");
  meta.push(esc(it.district));
  const phones = findPhones(it.access + " " + (it.location || ""));
  el.detail.innerHTML =
    '<p class="d-meta">' + meta.join(SEP) + "</p>" +
    '<div class="d-status">' + detailStatusInner(it) + "</div>" +
    '<div class="d-actions">' +
      '<a class="btn primary" href="' + esc(navUrl(it)) + '" target="_blank" rel="noopener">' + ICON_NAV +
        '導航<span class="visually-hidden">到' + esc(it.name) + "（Google 地圖，另開新分頁）</span></a>" +
      phones.map((p) => '<a class="btn tonal" href="tel:' + p.replace(/-/g, "") + '">' + ICON_PHONE + "撥打 " + esc(p) + "</a>").join("") +
    "</div>" +
    '<dl class="d-info">' +
      "<div><dt>地址</dt><dd>" + esc(it.location || it.address || "—") + "</dd></div>" +
      "<div><dt>進出場方式</dt><dd>" + esc(it.access || "—") + "</dd></div>" +
    "</dl>" +
    (it.precision === "DISTRICT"
      ? '<p class="d-note">地圖位置只推估到行政區，僅供參考；導航會改用名稱與地址搜尋。</p>'
      : '<p class="d-note">座標由地理編碼推估，實際位置請以現場標示為準。</p>') +
    googleBoxShell(it);
  loadGoogle(it);
}

/* ---------- 詳情：Google 的評分與評論（只在打開詳情時載入，不預先抓） ---------- */
const GR = { inflight: new Set(), broken: "" };
const PID_NONE = "-";

const lotPlaceId = (it) => it.place_id || it.placeId || null;
function mapsSearchUrl(it, pid) {
  const q = [it.name, it.address || it.location].filter(Boolean).join(" ");
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q) +
    (pid ? "&query_place_id=" + encodeURIComponent(pid) : "");
}

function cachedPid(lotId) {
  const v = store.get(LS.pid + lotId);
  if (!v || typeof v.id !== "string") return null;
  if (v.id === PID_NONE && Date.now() - (v.at || 0) > PID_MISS_TTL) { store.del(LS.pid + lotId); return null; }
  return v.id;
}

function cachedReviews(pid) {
  const k = LS.rv + pid;
  const v = store.get(k);
  if (!v) return null;
  if (v.v !== 1 || v.place_id !== pid || !Array.isArray(v.reviews) || !(Date.now() - (v.fetchedAt || 0) < RV_TTL)) {
    store.del(k);
    return null;
  }
  return v;
}

function dailyCount() {
  const v = store.get(LS.day);
  return v && v.d === taipeiDay() ? Number(v.n) || 0 : 0;
}
function bumpDaily() { store.set(LS.day, { d: taipeiDay(), n: dailyCount() + 1 }); }

/** Place → 只留畫面需要的欄位（也是存進 localStorage 的樣子） */
function serializePlace(place, pid) {
  const pick = (o, ...ks) => { for (const k of ks) if (o && o[k]) return o[k]; return ""; };
  const reviews = (place.reviews || []).map((r) => {
    const a = r.authorAttribution || {};
    const t = r.publishTime ? new Date(r.publishTime).getTime() : 0;
    return {
      author: a.displayName || "Google 使用者",
      authorUri: safeUrl(pick(a, "uri")),
      photo: safeUrl(pick(a, "photoURI", "photoUri")),
      rating: typeof r.rating === "number" ? r.rating : null,
      when: r.relativePublishTimeDescription || "",
      time: Number.isFinite(t) ? t : 0,
      text: (typeof r.text === "string" ? r.text : r.text && r.text.text) || "",
      uri: safeUrl(pick(r, "googleMapsURI", "googleMapsUri")),
      flag: safeUrl(pick(r, "flagContentURI", "flagContentUri")),
    };
  });
  return {
    v: 1, place_id: pid,
    rating: typeof place.rating === "number" ? place.rating : null,
    count: place.userRatingCount || 0,
    uri: safeUrl(pick(place, "googleMapsURI", "googleMapsUri")),
    reviews, fetchedAt: Date.now(),
  };
}

const fmtRating = (r) => (Math.round(r * 10) / 10).toFixed(1);
const starsHTML = (r, cls = "") => '<span class="stars' + cls + '" style="--r:' + Math.max(0, Math.min(5, r)) + '" aria-hidden="true"></span>';
const openLinkHTML = (href) =>
  '<a class="btn tonal g-open" href="' + esc(href) + '" target="_blank" rel="noopener">' + ICON_PIN +
  '在 Google 地圖開啟<span class="visually-hidden">（另開新分頁）</span></a>';

function googleBoxShell(it) {
  return '<section class="g-box" data-id="' + esc(it.id) + '" aria-labelledby="gTitle" aria-busy="true">' +
    '<div class="g-head"><h3 id="gTitle">Google 的評分與評論</h3><span class="g-attr">資料來自 Google 地圖</span></div>' +
    '<div class="g-body"><p class="g-msg g-loading">正在載入 Google 評分…</p></div></section>';
}

function paintGoogle(it, html) {
  const box = el.detail.querySelector(".g-box");
  if (!box || box.dataset.id !== it.id) return;   // 已經換到別座停車場
  box.querySelector(".g-body").innerHTML = html;
  box.removeAttribute("aria-busy");
  // 沒有真的被截斷的評論就不需要「更多」
  requestAnimationFrame(() => {
    for (const t of box.querySelectorAll(".g-text.clamp")) {
      if (t.scrollHeight <= t.clientHeight + 2) {
        t.classList.remove("clamp");
        box.querySelector('.g-more[aria-controls="' + t.id + '"]')?.remove();
      }
    }
  });
}

const gMsg = (text, href) => '<p class="g-msg">' + esc(text) + "</p>" + (href ? '<p class="g-foot">' + openLinkHTML(href) + "</p>" : "");

function reviewsHTML(it, d) {
  const href = d.uri || mapsSearchUrl(it, d.place_id);
  let sum;
  if (d.rating != null) {
    sum = '<div class="g-sum"><span class="g-num" aria-hidden="true">' + fmtRating(d.rating) + "</span>" + starsHTML(d.rating) +
      '<span class="g-count" aria-hidden="true">' + d.count.toLocaleString("zh-TW") + " 則評論</span>" +
      '<span class="visually-hidden">Google 評分：5 分中的 ' + fmtRating(d.rating) + " 分，共 " + d.count + " 則評論</span></div>";
  } else {
    sum = '<p class="g-msg">Google 地圖上還沒有評分。</p>';
  }
  const revs = [...d.reviews].sort((a, b) => (b.time || 0) - (a.time || 0));
  let list = "";
  if (!revs.length) {
    list = '<p class="g-msg">目前沒有評論。</p>';
  } else {
    list = '<ol class="g-reviews">' + revs.map((r, i) => {
      const long = r.text.length > 60;     // 先截成 4 行，畫完再量，沒被截斷就拿掉「更多」
      const name = r.authorUri
        ? '<a class="g-author" href="' + esc(r.authorUri) + '" target="_blank" rel="noopener">' + esc(r.author) + "</a>"
        : '<span class="g-author">' + esc(r.author) + "</span>";
      const av = r.photo
        ? '<img class="g-av" src="' + esc(r.photo) + '" alt="" width="36" height="36" loading="lazy" decoding="async" referrerpolicy="no-referrer">'
        : '<span class="g-av g-av-empty" aria-hidden="true">' + esc(r.author.slice(0, 1)) + "</span>";
      const links = [
        r.uri ? '<a href="' + esc(r.uri) + '" target="_blank" rel="noopener">在 Google 地圖查看這則評論</a>' : "",
        r.flag ? '<a href="' + esc(r.flag) + '" target="_blank" rel="noopener">檢舉</a>' : "",
      ].filter(Boolean).join(SEP);
      return '<li class="g-rv"' + (i >= RV_SHOW ? " hidden" : "") + ">" +
        '<div class="g-rv-head">' + av + '<div class="g-rv-who">' + name +
          '<div class="g-rv-meta">' + (r.rating != null ? starsHTML(r.rating, " sm") + '<span class="visually-hidden">' + r.rating + " 顆星，</span>" : "") +
          "<span>" + esc(r.when) + "</span></div></div></div>" +
        (r.text ? '<p class="g-text' + (long ? " clamp" : "") + '" id="gt-' + i + '">' + esc(r.text) + "</p>" : "") +
        (long ? '<button type="button" class="linkbtn g-more" aria-expanded="false" aria-controls="gt-' + i + '">更多</button>' : "") +
        (links ? '<p class="g-rv-links">' + links + "</p>" : "") +
      "</li>";
    }).join("") + "</ol>" +
    (revs.length > RV_SHOW ? '<button type="button" class="textbtn g-all">顯示其他 ' + (revs.length - RV_SHOW) + " 則評論</button>" : "");
  }
  return sum + list + '<p class="g-foot">' + openLinkHTML(href) + "</p>";
}

function googleErrText(e) {
  const s = String((e && e.code) || "") + " " + String((e && e.message) || "");
  if (/OVER_QUERY_LIMIT|RESOURCE_EXHAUSTED|quota|429/i.test(s)) return "Google 服務的用量已達上限，暫時無法顯示評分與評論。";
  if (/REQUEST_DENIED|PERMISSION_DENIED|denied|403|not.?(enabled|activated|authorized)|billing|referer/i.test(s)) {
    GR.broken = "Google 地點服務目前沒有開放給這個網站使用，暫時無法顯示評分與評論。";
    return GR.broken;
  }
  return "暫時無法載入 Google 評分與評論，請稍後再試。";
}

/** 打開詳情時呼叫：有快取就不連網；沒有 place_id 才用 Text Search（只要 id） */
async function loadGoogle(it) {
  const search = mapsSearchUrl(it, lotPlaceId(it));
  let pid = lotPlaceId(it) || cachedPid(it.id);
  if (pid && pid !== PID_NONE) {
    const c = cachedReviews(pid);
    if (c) { paintGoogle(it, reviewsHTML(it, c)); return; }
  }
  if (!API_KEY) { paintGoogle(it, gMsg("這個網站沒有設定 Google 地圖金鑰，無法顯示評分與評論。", search)); return; }
  if (pid === PID_NONE) { paintGoogle(it, gMsg("在 Google 地圖上找不到對應地點。", search)); return; }
  if (GR.broken) { paintGoogle(it, gMsg(GR.broken, pid ? mapsSearchUrl(it, pid) : search)); return; }
  if (GR.inflight.has(it.id)) return;   // 同一座正在載入，回來時會畫到目前的區塊

  GR.inflight.add(it.id);
  try {
    const ok = G.ready ? await G.ready : false;
    if (!ok || G.failed) { paintGoogle(it, gMsg("Google 地圖目前無法載入，暫時無法顯示評分與評論。", search)); return; }
    const { Place } = await google.maps.importLibrary("places");
    if (!pid) {
      // Text Search Essentials（IDs Only）：fields 只能有 id，否則會升級成較貴的 SKU
      const precise = hasGeo(it) && it.precision !== "DISTRICT";
      const { places } = await Place.searchByText({
        textQuery: [it.name, it.address || it.location].filter(Boolean).join(" "),
        fields: ["id"],
        locationBias: precise ? { center: { lat: it.lat, lng: it.lng }, radius: 800 }
          : hasGeo(it) ? { center: { lat: it.lat, lng: it.lng }, radius: 5000 } : PLACES_BIAS,
        language: "zh-TW",
        region: "tw",
        maxResultCount: 1,
      });
      pid = (places && places[0] && places[0].id) || null;
      store.set(LS.pid + it.id, { id: pid || PID_NONE, at: Date.now() });
      if (!pid) { paintGoogle(it, gMsg("在 Google 地圖上找不到對應地點。", search)); return; }
      const c = cachedReviews(pid);
      if (c) { paintGoogle(it, reviewsHTML(it, c)); return; }
    }
    if (dailyCount() >= RV_DAILY_CAP) {
      paintGoogle(it, gMsg("今天在這台裝置上已載入很多次 Google 評論，為了節省共用額度先暫停，請直接到 Google 地圖查看。", mapsSearchUrl(it, pid)));
      return;
    }
    // Place Details：reviews 屬於 Enterprise + Atmosphere，只要這四個欄位
    const place = new Place({ id: pid });
    await place.fetchFields({ fields: ["rating", "userRatingCount", "reviews", "googleMapsURI"] });
    bumpDaily();
    const data = serializePlace(place, pid);
    store.set(LS.rv + pid, data);
    paintGoogle(it, reviewsHTML(it, data));
  } catch (e) {
    console.warn("Google 評分與評論載入失敗", e);
    paintGoogle(it, gMsg(googleErrText(e), pid && pid !== PID_NONE ? mapsSearchUrl(it, pid) : search));
  } finally {
    GR.inflight.delete(it.id);
  }
}

el.detail.addEventListener("click", (e) => {
  const more = e.target.closest(".g-more");
  if (more) {
    const p = $(more.getAttribute("aria-controls"));
    const open = more.getAttribute("aria-expanded") !== "true";
    p.classList.toggle("clamp", !open);
    more.setAttribute("aria-expanded", String(open));
    more.textContent = open ? "收合" : "更多";
    return;
  }
  const all = e.target.closest(".g-all");
  if (all) {
    const hidden = [...el.detail.querySelectorAll(".g-rv[hidden]")];
    hidden.forEach((li) => { li.hidden = false; });
    all.remove();
    const first = hidden[0] && hidden[0].querySelector("a, button");
    if (first) focusNoScroll(first);
  }
});

/* =====================================================================
 * 起點（離我最近／地點搜尋）
 * ===================================================================== */
function setOrigin(lat, lng, label) {
  state.origin = { lat, lng, label };
  el.originName.textContent = label;
  el.originBar.hidden = false;
  state.sort = "distance";
  placeOriginMarker();
  if (ui.view === "detail") closeDetail({ focus: false });
  ui.listScroll = 0;
  applyFilters();
  el.sheetBody.scrollTop = 0;
  if (isSheet() && ui.snap === "peek") setSnap("mid");
  queueLayout();
  // 鍵盤收起、起點標籤出現後再移鏡頭，padding 才會是對的
  whenSettled(() => focusArea({ lat, lng }, nearbyLots(lat, lng)));
}

function clearOrigin() {
  state.origin = null;
  el.originBar.hidden = true;
  if (G.originMarker) { G.originMarker.map = null; G.originMarker = null; }
  if (state.sort === "distance") state.sort = "default";
  applyFilters();
  fitToResults();
  queueLayout();
  // 按鈕消失了，焦點要有去處；手機上不要因此跳出鍵盤
  if (isSheet()) focusNoScroll(el.list); else el.q.focus();
}

function setNearBusy(busy) {
  el.btnNear.disabled = busy;
  el.btnNear.setAttribute("aria-busy", String(busy));
  el.btnNear.setAttribute("aria-label", busy ? "定位中…" : "離我最近");
  el.btnNear.querySelector(".fab-lbl").textContent = busy ? "定位中…" : "離我最近";
}

function locateMe() {
  if (!navigator.geolocation) { toast("此瀏覽器不支援定位功能"); return; }
  setNearBusy(true);
  navigator.geolocation.getCurrentPosition((pos) => {
    setNearBusy(false);
    setOrigin(pos.coords.latitude, pos.coords.longitude, "我的位置");
    toast("已依離你最近排序");
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

/** 自動完成的某一筆建議 → 座標。這一步用 Place.fetchFields 結束 session，只要 Essentials 欄位 */
async function placeFromPrediction(p) {
  const place = p.pred.toPlace();   // 會帶著同一個 session token
  await place.fetchFields({ fields: ["location", "displayName", "formattedAddress"] });
  const loc = place.location;
  return loc ? { lat: loc.lat(), lng: loc.lng(), label: place.displayName || p.main } : null;
}

let placeBusy = false;
/**
 * 把一段文字當成地點，設為起點。
 * pred：使用者在建議清單點選的 Google 地點。沒有的話，若目前 session 已有這段文字的建議就用第一筆；
 * 否則走原本的 Places 文字搜尋 → Geocoding → Nominatim。
 */
async function searchPlace(text, { pred = null } = {}) {
  const q = text.trim();
  if (!q || placeBusy) return;
  placeBusy = true;
  el.placeSearchBtn.disabled = true;
  el.placeHintText.textContent = "正在搜尋「" + (pred ? pred.main : q) + "」…";
  const p = pred || (sg.token && sg.placesQ === q && sg.places[0]) || null;
  try {
    let r = null;
    if (p) {
      try { r = await placeFromPrediction(p); }
      catch (e) { console.warn("無法取得 Google 地點座標，改用其他方式", e); }
    }
    if (!r) r = await geocodePlace(p ? [p.main, p.sub].filter(Boolean).join(" ") : q);
    if (!r) { toast("找不到「" + q + "」這個地點"); return; }
    const label = r.label || (p ? p.main : q);
    state.query = "";
    el.q.value = "";
    el.clearQ.hidden = true;
    if (isSheet()) el.q.blur();
    setOrigin(r.lat, r.lng, label);
    toast("已定位到「" + label + "」，依距離排序");
  } catch (e) {
    console.error(e);
    toast("地點搜尋服務暫時無法使用");
  } finally {
    endSession();            // 不論成功與否，這次輸入工作階段都結束了
    placeBusy = false;
    el.placeSearchBtn.disabled = false;
    updatePlaceHint();
    syncHistory();
  }
}

function updatePlaceHint() {
  if (placeBusy) return;
  const q = state.query.trim();
  const show = q.length >= 2 && !sg.open;   // 建議清單開著時，最後一列就是同一個動作
  el.placeSearchBtn.hidden = !show;
  if (show) {
    el.placeHintText.innerHTML = "以「<strong>" + esc(q) + "</strong>」為地點搜尋附近";
  }
}

/* =====================================================================
 * 搜尋建議：停車場（本站資料，免費）＋地點（Google Places 自動完成）
 * combobox / listbox：焦點留在輸入框，用 aria-activedescendant 標示目前選項
 * ===================================================================== */
const mapsUsable = () => !!(API_KEY && G.map && !G.failed);
const sameName = (a, b) => norm(a).replace(/[\s()（）]/g, "") === norm(b).replace(/[\s()（）]/g, "");

/** 結束這次自動完成工作階段：丟掉 token、取消進行中的請求 */
function endSession() {
  clearTimeout(sg.timer);
  sg.seq++;
  sg.token = null;
  sg.places = [];
  sg.placesQ = "";
}

/** 和 applyFilters 同一套正規化，並尊重目前的行政區／進出場方式篩選 */
function lotSuggestions(text) {
  const q = norm(text.trim());
  if (!q) return [];
  const out = [];
  for (const it of state.items) {
    if (state.district && it.district !== state.district) continue;
    if (state.access.size && !state.access.has(it.access)) continue;
    const n = norm(it.name);
    const rank = n.startsWith(q) ? 0 : n.includes(q) ? 1
      : norm([it.address, it.location, it.district].join(" ")).includes(q) ? 2 : -1;
    if (rank < 0) continue;
    const d = state.origin && hasGeo(it) ? haversine(state.origin.lat, state.origin.lng, it.lat, it.lng) : null;
    out.push({ it, rank, d });
  }
  out.sort((a, b) => a.rank - b.rank || (a.d ?? 1e9) - (b.d ?? 1e9) || a.it.name.length - b.it.name.length);
  return out.slice(0, SUGG_LOTS);
}

function buildRows() {
  const q = el.q.value.trim();
  const rows = lotSuggestions(q).map(({ it, d }) => ({ kind: "lot", key: "lot:" + it.id, it, d }));
  // 地點：等 debounce 回來前，先保留上一批結果，避免每打一個字整組閃一下
  if (q.length >= SUGG_MIN && sg.places.length) {
    let n = 0;
    for (const p of sg.places) {
      if (n >= SUGG_PLACES) break;
      if (rows.some((r) => r.kind === "lot" && sameName(r.it.name, p.main))) continue;   // 和停車場同名就不重複列
      rows.push({ kind: "place", key: "pl:" + (p.id || p.main), p });
      n++;
    }
  }
  if (q.length >= SUGG_MIN) rows.push({ kind: "fallback", key: "fb", q });
  return rows;
}

function hl(name, q) {
  const nq = norm(q.trim()), nn = norm(name);
  const i = nq && nn.length === name.length ? nn.indexOf(nq) : -1;
  if (i < 0) return esc(name);
  return esc(name.slice(0, i)) + "<mark>" + esc(name.slice(i, i + nq.length)) + "</mark>" + esc(name.slice(i + nq.length));
}

const ICON_PIN = '<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="10" r="2.3" fill="currentColor"/></svg>';
const ICON_SEARCH = '<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m15.5 15.5 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

function optionHTML(r, i, q) {
  const head = '<div class="sg-opt" role="option" id="sgo-' + i + '" data-i="' + i + '" aria-selected="false">';
  if (r.kind === "lot") {
    const sub = [r.d != null ? fmtDist(r.d) : "", r.it.district, r.it.location || r.it.address].filter(Boolean).map(esc).join("・");
    return head + '<span class="sg-ico lot" aria-hidden="true">P</span><span class="sg-txt"><span class="sg-main">' +
      hl(r.it.name, q) + '</span><span class="sg-sub">' + sub + "</span></span></div>";
  }
  if (r.kind === "place") {
    return head + '<span class="sg-ico">' + ICON_PIN + '</span><span class="sg-txt"><span class="sg-main">' +
      hl(r.p.main, q) + "</span>" + (r.p.sub ? '<span class="sg-sub">' + esc(r.p.sub) + "</span>" : "") + "</span></div>";
  }
  return head + '<span class="sg-ico">' + ICON_SEARCH + '</span><span class="sg-txt"><span class="sg-main">以「<strong>' +
    esc(r.q) + '</strong>」搜尋這個地點</span><span class="sg-sub">找這附近的停車場，依距離排序</span></span></div>';
}

function renderSugg() {
  const q = el.q.value;
  const rows = sg.rows = buildRows();
  if (!rows.length) { closeSugg(); return; }
  sg.active = rows.findIndex((r) => r.key === sg.activeKey);
  if (sg.active < 0) sg.activeKey = null;
  const groups = [["lot", "停車場"], ["place", "地點"], ["fallback", ""]];
  let html = "";
  for (const [kind, label] of groups) {
    const idx = rows.map((r, i) => (r.kind === kind ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    html += '<div class="sg-group" role="group" ' + (label ? 'aria-labelledby="sgl-' + kind + '"' : 'aria-label="其他搜尋方式"') + ">" +
      (label ? '<div class="sg-label" id="sgl-' + kind + '" role="presentation">' + label + "</div>" : "") +
      idx.map((i) => optionHTML(rows[i], i, q)).join("") + "</div>";
  }
  el.suggList.innerHTML = html;
  el.suggFoot.hidden = !rows.some((r) => r.kind === "place");
  paintActive();
  if (!sg.open) {
    sg.open = true;
    el.sugg.hidden = false;
    el.q.setAttribute("aria-expanded", "true");
    updatePlaceHint();
    syncHistory();
  }
  const nl = rows.filter((r) => r.kind === "lot").length, np = rows.filter((r) => r.kind === "place").length;
  clearTimeout(renderSugg._t);
  renderSugg._t = setTimeout(() => {
    el.suggStatus.textContent = sg.open ? nl + " 座停車場" + (np ? "、" + np + " 個地點" : "") + "建議" : "";
  }, 500);
}

function paintActive() {
  for (const o of el.suggList.querySelectorAll('[aria-selected="true"]')) o.setAttribute("aria-selected", "false");
  const node = sg.active >= 0 ? $("sgo-" + sg.active) : null;
  if (node) {
    node.setAttribute("aria-selected", "true");
    el.q.setAttribute("aria-activedescendant", node.id);
    node.scrollIntoView({ block: "nearest" });
  } else {
    el.q.removeAttribute("aria-activedescendant");
  }
}

function moveActive(dir) {
  const n = sg.rows.length;
  if (!n) return;
  let i = sg.active + dir;
  if (i >= n) i = 0;
  if (i < -1) i = n - 1;
  sg.active = i;
  sg.activeKey = i >= 0 ? sg.rows[i].key : null;
  paintActive();
}

function closeSugg({ abandon = false, history: syncHist = true } = {}) {
  clearTimeout(sg.timer);
  if (abandon) endSession();
  sg.active = -1; sg.activeKey = null;
  if (!sg.open) return;
  sg.open = false;
  el.sugg.hidden = true;
  el.suggList.replaceChildren();
  el.q.setAttribute("aria-expanded", "false");
  el.q.removeAttribute("aria-activedescendant");
  el.suggStatus.textContent = "";
  updatePlaceHint();
  if (syncHist) syncHistory();
}

/** 輸入框內容變了：停車場建議立刻更新；Google 地點等 debounce，且選字（composition）中不送出 */
function onSuggInput(e) {
  if (!el.q.value.trim()) { endSession(); closeSugg(); return; }
  sg.activeKey = null;
  const composing = sg.composing || (e && e.isComposing);
  refreshSugg({ fetch: !composing });
}

function refreshSugg({ fetch = true } = {}) {
  if (document.activeElement !== el.q && !sg.open) return;
  if (!el.q.value.trim()) { closeSugg(); return; }
  renderSugg();
  if (fetch) schedulePlaces();
}

function schedulePlaces() {
  clearTimeout(sg.timer);
  sg.seq++;                         // 進行中的請求作廢（回來時忽略）
  const q = el.q.value.trim();
  if (sg.composing || q.length < SUGG_MIN || sg.broken || !mapsUsable()) {
    if (q.length < SUGG_MIN && sg.places.length) { sg.places = []; sg.placesQ = ""; if (sg.open) renderSugg(); }
    return;
  }
  if (q === sg.placesQ) return;     // 同一段文字已經有結果
  const seq = sg.seq;
  sg.timer = setTimeout(() => fetchPlaces(q, seq), SUGG_DEBOUNCE);
}

async function fetchPlaces(q, seq) {
  try {
    const lib = await google.maps.importLibrary("places");
    if (seq !== sg.seq) return;
    if (!sg.token) sg.token = new lib.AutocompleteSessionToken();   // 新的工作階段才建立新 token
    const { suggestions } = await lib.AutocompleteSuggestion.fetchAutocompleteSuggestions({
      input: q,
      sessionToken: sg.token,
      locationBias: PLACES_BIAS,
      includedRegionCodes: ["tw"],
      language: "zh-TW",
      region: "tw",
    });
    if (seq !== sg.seq || el.q.value.trim() !== q) return;
    sg.places = (suggestions || []).map((s) => s.placePrediction).filter(Boolean).map((pp) => ({
      id: pp.placeId,
      main: (pp.mainText && pp.mainText.text) || (pp.text && pp.text.text) || "",
      sub: (pp.secondaryText && pp.secondaryText.text) || "",
      pred: pp,
    })).filter((p) => p.main);
    sg.placesQ = q;
    if (sg.open) renderSugg();
  } catch (err) {
    if (seq !== sg.seq) return;
    console.warn("Google 地點建議無法使用，只顯示停車場建議", err);
    const msg = String((err && (err.code || "")) + " " + (err && err.message || ""));
    if (/denied|permission|not.?(enabled|activated|authorized)|billing|403|referer/i.test(msg)) sg.broken = true;
    sg.places = []; sg.placesQ = q;
    if (sg.open) renderSugg();
  }
}

function selectRow(i) {
  const r = sg.rows[i];
  if (!r) return;
  if (r.kind === "lot") pickLot(r.it);
  else if (r.kind === "place") { closeSugg(); searchPlace(r.p.main, { pred: r.p }); }
  else { closeSugg(); searchPlace(r.q); }
}

/** 選停車場：清掉搜尋文字（清單維持完整），打開詳情並放大到該處 */
function pickLot(it) {
  const kbWasOpen = geo.kb > 0;
  endSession();                       // 沒用到 Google 地點，這次 session 就此結束
  closeSugg({ history: false });
  clearTimeout(debounce);
  el.q.value = ""; state.query = ""; el.clearQ.hidden = true;
  applyFilters();
  openDetail(it.id);                  // 焦點移到詳情標題 → 手機鍵盤收起；openDetail 會同步歷史紀錄
  if (kbWasOpen) whenSettled(() => panToItem(it, false));   // 鍵盤收起後面板高度變了，再對準一次
}

// 點選建議：pointerdown 時不要讓輸入框失焦（鍵盤不會先收起，click 一定收得到）
el.sugg.addEventListener("pointerdown", (e) => { if (e.target.closest(".sg-opt")) e.preventDefault(); });
el.sugg.addEventListener("mousedown", (e) => e.preventDefault());
el.sugg.addEventListener("click", (e) => {
  const o = e.target.closest(".sg-opt");
  if (o) selectRow(Number(o.dataset.i));
});
el.sugg.addEventListener("pointermove", (e) => {
  if (e.pointerType !== "mouse") return;
  const o = e.target.closest(".sg-opt");
  if (!o || Number(o.dataset.i) === sg.active) return;
  sg.active = Number(o.dataset.i);
  sg.activeKey = sg.rows[sg.active] ? sg.rows[sg.active].key : null;
  paintActive();
});
// 點建議清單和搜尋列以外的地方就關起來
document.addEventListener("pointerdown", (e) => {
  if (sg.open && !el.searchForm.contains(e.target)) closeSugg({ abandon: true });
}, true);

/* =====================================================================
 * 事件
 * ===================================================================== */
let debounce;
el.q.addEventListener("input", (e) => {
  state.query = el.q.value;
  el.clearQ.hidden = !el.q.value;
  if (ui.view === "detail") closeDetail({ focus: false });
  else if (ui.view === "filters") closeFilters({ focus: false });
  clearTimeout(debounce);
  debounce = setTimeout(applyFilters, 150);
  onSuggInput(e);
});
el.q.addEventListener("compositionstart", () => { sg.composing = true; });
el.q.addEventListener("compositionend", () => { sg.composing = false; refreshSugg(); });
el.q.addEventListener("focus", () => { if (el.q.value.trim()) refreshSugg({ fetch: false }); });
el.q.addEventListener("blur", () => {
  // 延後一點：點選建議時（pointerdown 已 preventDefault，通常不會 blur）仍要讓 click 先處理
  setTimeout(() => {
    if (sg.open && document.activeElement !== el.q && !el.sugg.contains(document.activeElement)) closeSugg({ abandon: true });
  }, 180);
});
el.q.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Escape") return;
  // 注音／倉頡等輸入法選字時，Enter／方向鍵／Esc 都是給輸入法用的：先檢查，再 preventDefault
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!sg.open) {
      if (el.q.value.trim()) { e.preventDefault(); refreshSugg({ fetch: false }); }
      return;
    }
    e.preventDefault();
    moveActive(e.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (e.key === "Escape") {
    if (sg.open) { e.preventDefault(); closeSugg({ abandon: true }); }
    return;   // 沒有建議清單時，讓 type=search 自己清除文字（原本的行為）
  }
  e.preventDefault();
  if (sg.open && sg.active >= 0) { selectRow(sg.active); return; }
  if (sg.open) closeSugg({ history: false });
  clearTimeout(debounce);
  state.query = el.q.value;
  applyFilters();
  // 沒有符合的停車場：把文字當地點（session 開著就用第一筆 Google 建議）
  if (state.query.trim() && !state.filtered.length) { searchPlace(state.query); return; }
  endSession();                                    // 只是看清單結果：這次自動完成 session 放棄
  if (isSheet()) {
    el.q.blur();                                   // 手機上收起鍵盤，讓結果露出來
    if (ui.snap === "peek" && state.query.trim()) setSnap("mid", { history: false });
  }
  syncHistory();
  if (state.query.trim()) fitToResults();
});
el.searchForm.addEventListener("submit", (e) => e.preventDefault());
el.clearQ.addEventListener("click", () => {
  el.q.value = ""; state.query = ""; el.clearQ.hidden = true;
  clearTimeout(debounce); applyFilters();
  endSession(); closeSugg();
  el.q.focus();
});
el.placeSearchBtn.addEventListener("click", () => searchPlace(state.query));
el.btnNear.addEventListener("click", locateMe);
el.clearOrigin.addEventListener("click", clearOrigin);
el.resetFilters.addEventListener("click", resetFilters);
el.fDistrict.addEventListener("change", () => { state.district = el.fDistrict.value; applyFilters(); fitToResults(); });
el.sortSeg.addEventListener("change", (e) => {
  if (e.target.name !== "sort") return;
  if (e.target.value === "distance" && !state.origin) {
    toast("請先按「離我最近」或搜尋一個地點");
    syncFilterUI();
    return;
  }
  state.sort = e.target.value;
  ui.listScroll = 0;
  applyFilters();
});

el.list.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  if (btn.dataset.act === "reset") { resetFilters(); return; }
  const id = btn.closest(".card").dataset.id;
  openDetail(id);
});

mqNarrow.addEventListener("change", () => {
  layout();
  setSnap(ui.snap, { history: false });
  syncHistory();
  if (G.map) G.map.setOptions(mapControlOptions());
});

/* =====================================================================
 * 啟動
 * ===================================================================== */
setView("list");
setSnap("peek", { history: false });
layout();

if (API_KEY) {
  initMaps();
} else {
  G.ready = Promise.resolve(false);
  showMapMsg("尚未設定 Google 地圖金鑰",
    "<p>請在 <code>parking/config.js</code> 設定 <code>GOOGLE_MAPS_API_KEY</code> 後重新整理，地圖就會出現。</p>" +
    "<p>在那之前，停車場清單、搜尋、篩選、離我最近、即時車位與「導航」連結都可以正常使用。</p>");
}

function buildAccessChips(types) {
  const groups = new Map();
  for (const a of types) {
    const label = shortAccess(a);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(a);
  }
  state.accessGroups = [...groups].map(([label, values]) => ({ label, values }));
  for (const g of state.accessGroups) {
    const b = h("button", { type: "button", class: "chip", "aria-pressed": "false", text: g.label });
    if (g.values.length === 1 && g.values[0] !== g.label) b.title = g.values[0];
    b.addEventListener("click", () => {
      const on = !g.values.some((v) => state.access.has(v));
      g.values.forEach((v) => (on ? state.access.add(v) : state.access.delete(v)));
      b.setAttribute("aria-pressed", String(on));
      applyFilters();
    });
    el.accessChips.append(b);
  }
}

fetch(DATA_URL, { cache: "no-cache" })
  .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
  .then((data) => {
    state.items = data.items || [];
    state.items.forEach((it) => state.byId.set(it.id, it));

    el.fDistrict.append(...(data.districts || []).map((d) => h("option", { value: d, text: d })));
    buildAccessChips(data.access_types || []);

    const count = data.count ?? state.items.length;
    const missing = count - (data.geocoded ?? state.items.filter(hasGeo).length);
    const gen = (data.generated_at || "").replace("T", " ").slice(0, 16);
    el.metaCount.textContent = "共 " + count + " 座停車場" + (missing ? "（" + missing + " 筆座標待補）" : "") +
      "。資料更新：" + (gen || "未知") + "（每日 00:00 自動更新）。";
    el.footDates.textContent = "官網公告更新日：" + (data.page_updated || "未知") + "。";

    state.dataReady = true;
    applyFilters();
    if (G.map) fitToResults();
    avail.start();      // 即時車位：與 Google 地圖金鑰無關，載不到也不影響其他功能
  })
  .catch((err) => {
    el.list.innerHTML = '<li class="empty">資料載入失敗（' + esc(err.message) +
      '）。<br>若是剛建立網站，請先在 GitHub Actions 手動執行一次「每日更新停車場資料」。</li>';
    el.resultCount.textContent = "資料載入失敗";
    el.metaCount.textContent = "資料載入失敗";
  });

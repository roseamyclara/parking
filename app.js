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
const MAX_FIT_ZOOM = 16;

const $ = (id) => document.getElementById(id);
const el = {};
["q", "clearQ", "searchForm", "searchbar", "btnNear", "btnFilter", "filterBadge", "fDistrict", "sortSeg", "sortHint",
 "accessChips", "accessCount", "placeSearchBtn", "placeHintText", "originBar", "originName", "clearOrigin",
 "sheet", "sheetHead", "sheetBody", "grab", "grabLabel", "list", "listTitle", "resultCount", "listSub", "resetFilters",
 "detail", "detailBack", "dName", "filtersTitle", "filtersDone", "aboutLink", "about", "availNote",
 "metaCount", "footDates", "toast", "liveCount", "mappane", "map", "mapMsg", "themeSeg", "themeSystemLbl",
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
  if (ui.view === "filters") { closeFilters({ focus }); return true; }
  if (state.activeId) { closeDetail({ focus }); return true; }
  if (isSheet() && ui.snap !== "peek") { setSnap("peek"); return true; }
  return false;
}

// ---- 歷史紀錄：每開一層就 pushState，返回鍵（Android／瀏覽器）一次關一層，不會直接離開本頁 ----
let histDepth = 0;
let ignorePops = 0;
function desiredDepth() {
  return (ui.view === "filters" ? 1 : 0) + (state.activeId ? 1 : 0) + (isSheet() && ui.snap !== "peek" ? 1 : 0);
}
function syncHistory() {
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
  if (ignorePops > 0) { ignorePops--; return; }
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
    if (state.activeId) closeDetail({ focus: false });
    else if (ui.view === "filters") closeFilters({ focus: false });
    else if (isSheet() && ui.snap !== "peek") setSnap("peek");
  });

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

function panToItem(it, fromMap) {
  if (!G.map || !hasGeo(it)) return;
  if (!fromMap && G.map.getZoom() < MAX_FIT_ZOOM) G.map.setZoom(MAX_FIT_ZOOM);
  let target = new google.maps.LatLng(it.lat, it.lng);
  const proj = G.map.getProjection();
  if (isSheet() && proj) {
    // 讓標記落在「搜尋列以下、面板以上」那塊可見區域的中間
    const pad = mapPadding();
    const scale = 2 ** G.map.getZoom();
    const p = proj.fromLatLngToPoint(target);
    target = proj.fromPointToLatLng(new google.maps.Point(p.x, p.y - (pad.top - pad.bottom) / 2 / scale));
  }
  G.map.panTo(target);
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
  if (pts.length === 1) { G.map.setCenter(pts[0]); G.map.setZoom(15); return; }
  const b = new G.libs.LatLngBounds();
  pts.forEach((p) => b.extend(p));
  G.map.fitBounds(b, mapPadding());
  google.maps.event.addListenerOnce(G.map, "idle", () => {
    if (G.map.getZoom() > MAX_FIT_ZOOM) G.map.setZoom(MAX_FIT_ZOOM);
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
      : '<p class="d-note">座標由地理編碼推估，實際位置請以現場標示為準。</p>');
}

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
  requestAnimationFrame(() => {
    const pts = state.filtered.filter((i) => i._d != null).slice(0, 8).map((i) => ({ lat: i.lat, lng: i.lng }));
    pts.push({ lat, lng });
    fitPoints(pts);
  });
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

let placeBusy = false;
async function searchPlace(text) {
  const q = text.trim();
  if (!q || placeBusy) return;
  placeBusy = true;
  el.placeSearchBtn.disabled = true;
  el.placeHintText.textContent = "正在搜尋「" + q + "」…";
  try {
    const r = await geocodePlace(q);
    if (!r) { toast("找不到「" + q + "」這個地點"); return; }
    state.query = "";
    el.q.value = "";
    el.clearQ.hidden = true;
    if (isSheet()) el.q.blur();
    setOrigin(r.lat, r.lng, q);
    toast("已定位到「" + q + "」，依距離排序");
  } catch (e) {
    console.error(e);
    toast("地點搜尋服務暫時無法使用");
  } finally {
    placeBusy = false;
    el.placeSearchBtn.disabled = false;
    updatePlaceHint();
  }
}

function updatePlaceHint() {
  if (placeBusy) return;
  const q = state.query.trim();
  const show = q.length >= 2;
  el.placeSearchBtn.hidden = !show;
  if (show) {
    el.placeHintText.innerHTML = "以「<strong>" + esc(q) + "</strong>」為地點搜尋附近";
  }
}

/* =====================================================================
 * 事件
 * ===================================================================== */
let debounce;
el.q.addEventListener("input", () => {
  state.query = el.q.value;
  el.clearQ.hidden = !el.q.value;
  if (ui.view === "detail") closeDetail({ focus: false });
  else if (ui.view === "filters") closeFilters({ focus: false });
  clearTimeout(debounce);
  debounce = setTimeout(applyFilters, 150);
});
el.q.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  // 注音／倉頡等輸入法選字時按 Enter 只是確認候選字，不能當成送出（先檢查，再 preventDefault）
  if (e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  clearTimeout(debounce);
  state.query = el.q.value;
  applyFilters();
  if (state.query.trim() && !state.filtered.length) { searchPlace(state.query); return; }
  if (isSheet()) {
    el.q.blur();                                   // 手機上收起鍵盤，讓結果露出來
    if (ui.snap === "peek" && state.query.trim()) setSnap("mid");
  }
  if (state.query.trim()) fitToResults();
});
el.searchForm.addEventListener("submit", (e) => e.preventDefault());
el.clearQ.addEventListener("click", () => {
  el.q.value = ""; state.query = ""; el.clearQ.hidden = true;
  clearTimeout(debounce); applyFilters(); el.q.focus();
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

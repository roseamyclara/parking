/* 臺中市身障免銷單停車場地圖 — 即時車位燈號
 *
 * 來源：臺中市政府交通局「路外剩餘車位」開放資料（免金鑰、CORS 開放）
 *   https://motoretag.taichung.gov.tw/DataAPI/api/ParkingAPIV2/Opendata
 * 這支 API 只有燈號（AvailableCarRGB：G／Y／R／B）與總車位數，沒有「剩餘幾格」的數字，
 * 所以畫面上只顯示燈號文字，絕不從顏色推算剩餘車位。
 * 剩餘「數字」另外來自 TDX（見本檔下方 createCounts），有數字時以數字為準。
 *
 * 本檔不碰 DOM，可以直接用 Node 測試配對結果。
 */

export const AVAIL_URL = "https://motoretag.taichung.gov.tw/DataAPI/api/ParkingAPIV2/Opendata";
export const AVAIL_SOURCE_NAME = "臺中市政府交通局「路外剩餘車位」開放資料";

/** 燈號 → 繁中狀態。B 很常見（約六成），代表沒有即時資料，不是「空的」。 */
export const STATUS = {
  G: { key: "ok", label: "尚有車位" },
  Y: { key: "few", label: "即將滿場" },
  R: { key: "full", label: "已滿" },
  B: { key: "none", label: "無即時資料" },
};

const tc = (s) => String(s || "").replace(/台/g, "臺");
const NOISE = /停車場|停車塔|附屬|附設|共享|地下|立體|平面|公有|市立|臺中市/g;
const PAREN = /[（(]([^）)]*)[）)]/g;

/** 樓層型態：地下、平面、立體是「不同的停車場」，名稱相同也不能混在一起 */
function levelOf(s) {
  const m = /地下|平面|立體/.exec(s);
  return m ? m[0] : "";
}

/**
 * 名稱正規化（用於配對）。
 * - 台→臺；括號內容去掉（但「A 區」這種分區代號保留成尾碼，別名另外收集）
 * - 去尾端 P、行政區前綴、「停車場／附屬／地下／立體／平面」等通用字、標點空白
 * @returns {{ n: string, level: string, aliases: string[] }}
 */
export function normName(raw, districts, stripShort) {
  let s = tc(raw);
  let section = "";
  const aliases = [];
  s = s.replace(PAREN, (_, inner) => {
    const sec = /^\s*([A-Za-z])\s*區\s*$/.exec(inner);
    if (sec) section = sec[1].toLowerCase();
    else if (/停/.test(inner)) aliases.push(inner);   // 例：( 停四停車場 )、( 大肚區廣停二 )
    return " ";
  });
  const level = levelOf(s);
  const clean = (x) => {
    x = x.trim().replace(/\s*[Pp]\d*\s*$/, "").replace(NOISE, "").replace(/[\s、，,.\-‧·_／/]/g, "").toLowerCase();
    // 去掉開頭的行政區（「大里區崇光」→「崇光」），但剩不到兩個字就不去（「南屯停車場」仍是「南屯」）。
    // 簡稱（「烏日廣停七」的「烏日」）只對我們的名稱去掉：官方的民營「北屯景賢」和公有「景賢」是不同停車場。
    for (const d of districts || []) {
      const short = d.replace(/區$/, "");
      const pre = x.startsWith(d) ? d : stripShort && short.length >= 2 && x.startsWith(short) ? short : "";
      if (pre) { if (x.length - pre.length >= 2) x = x.slice(pre.length); break; }
    }
    return x;
  };
  const n = clean(s);
  return { n: n ? n + section : "", level, aliases: aliases.map(clean).filter((a) => a.length >= 2) };
}

/** "北區-民營-金逢源-漢口P" → { district: "北區", name: "金逢源-漢口P" } */
export function parsePosition(pos) {
  const parts = String(pos || "").split("-");
  if (parts.length >= 3) return { district: tc(parts[0]), name: parts.slice(2).join("-") };
  return { district: "", name: String(pos || "") };
}

function meters(a, b, c, d) {
  const R = 6371000, p = Math.PI / 180;
  const dLat = (c - a) * p, dLng = (d - b) * p;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const COORD_MAX_M = 45;    // 只靠座標時的上限（80 m 會把北屯區公所那一群配錯）

/**
 * 把我們的停車場配對到官方即時車位資料。寧可不配，也不要配錯。
 * 1. 同行政區、正規化後名稱完全相同（或括號內的「停X」別名相同），且只有一個候選
 * 2. 保守的包含比對（較短一方至少佔一半長度），同區唯一
 * 3. 座標備援：45 公尺內唯一一個官方停車場，且它沒有同時被我們好幾筆認領
 * 地下／平面／立體不同者一律不配。名稱相符時座標也要大致合理（推估座標只到行政區時放寬）。
 * @param {Array<{id,name,district,lat,lng,precision}>} ours
 * @param {Array<{ID,Position,Lat,Lng}>} official
 * @returns {Map<string, string>} 我們的 id → 官方 ID
 */
export function matchLots(ours, official) {
  const districts = [...new Set(official.map((o) => parsePosition(o && o.Position).district).filter((d) => /區$/.test(d)))]
    .sort((a, b) => b.length - a.length);
  const recs = official
    .filter((o) => o && o.ID != null && o.Position && !/機車|大客車/.test(o.Position))
    .map((o) => {
      const p = parsePosition(o.Position);
      const nn = normName(p.name, districts);
      return { id: String(o.ID), district: p.district, n: nn.n, level: nn.level, lat: +o.Lat, lng: +o.Lng };
    })
    .filter((r) => r.n);

  const byDistrict = new Map();
  for (const r of recs) {
    if (!byDistrict.has(r.district)) byDistrict.set(r.district, []);
    byDistrict.get(r.district).push(r);
  }

  const out = new Map();
  const pending = [];
  for (const it of ours) {
    const name = tc(it.name);
    // 原始資料偶有行政區寫錯（例：沙鹿區「大肚區榮華停車場」），名稱開頭若是行政區就以名稱為準
    const named = districts.find((d) => name.startsWith(d));
    const dist = named || tc(it.district);
    const known = byDistrict.has(dist);
    const pool = known ? byDistrict.get(dist) : recs;   // 行政區不存在（打錯字）時只做全市精確比對
    const me = normName(name, districts, true);
    // 我們的座標是地理編碼推估的（有一半只到行政區中心，有些甚至差好幾公里），
    // 所以同區唯一的精確名稱不再看距離；較寬鬆的包含比對才要求座標大致合理。
    const maxM = it.precision === "DISTRICT" ? 15000 : 4000;
    const near = (r) => it.lat == null || !isFinite(r.lat) || meters(it.lat, it.lng, r.lat, r.lng) <= maxM;
    const ok = (r) => !(me.level && r.level && me.level !== r.level);
    const pick = (cands, needNear) => {
      cands = cands.filter((r) => ok(r) && (!needNear || near(r)));
      if (cands.length > 1) {   // 同名多筆：用樓層型態分辨（健康公園「地下」與「附設」）
        const same = cands.filter((r) => r.level === me.level);
        if (same.length === 1) return same[0];
      }
      return cands.length === 1 ? cands[0] : null;
    };

    let hit = me.n ? pick(pool.filter((r) => r.n === me.n)) : null;
    for (const a of me.aliases) { if (hit) break; hit = pick(pool.filter((r) => r.n === a)); }
    if (!hit && known && me.n.length >= 3) {
      // 包含比對：較短一方至少 3 個字且佔較長一方一半以上（「停三」不能對到「廣兼停三」）
      // 多出來的部分若是分區（「第五區」「B 區」），可能是別的區塊，不配。
      const zoneOnly = (a, b) => /第|區|^[a-z]$|[a-z]$/.test(a.replace(b, ""));
      hit = pick(pool.filter((r) => r.n.length >= 3 && (r.n.includes(me.n) || me.n.includes(r.n)) &&
        Math.min(r.n.length, me.n.length) >= Math.ceil(Math.max(r.n.length, me.n.length) / 2) &&
        !zoneOnly(r.n.length > me.n.length ? r.n : me.n, r.n.length > me.n.length ? me.n : r.n)), true);
    }
    if (hit) out.set(it.id, hit.id);
    else pending.push(it);
  }

  // 座標備援
  const used = new Set(out.values());
  const claims = new Map();
  for (const it of pending) {
    if (it.lat == null || it.lng == null || it.precision === "DISTRICT") continue;
    const close = recs.filter((r) => isFinite(r.lat) && meters(it.lat, it.lng, r.lat, r.lng) <= COORD_MAX_M);
    if (close.length !== 1 || used.has(close[0].id)) continue;
    const k = close[0].id;
    if (!claims.has(k)) claims.set(k, []);
    claims.get(k).push(it.id);
  }
  for (const [k, ids] of claims) if (ids.length === 1) out.set(ids[0], k);

  return out;
}

/**
 * 定期抓即時車位：頁面可見時每 60 秒一次，切到背景就暫停，回來時若資料已舊才立刻抓（避免一窩蜂）。
 * 失敗時保留上一筆資料（若還不太舊），太舊就清掉，不影響搜尋／地圖／清單。
 */
export function createAvailability({ getItems, onChange, interval = 60000, staleAfter = 10 * 60000, fetchImpl }) {
  const doFetch = fetchImpl || ((u, o) => fetch(u, o));
  const st = { byOurId: new Map(), at: 0, tried: 0, matchKey: "", match: new Map(), timer: 0, inflight: null, started: false };

  function lookup(id) {
    if (!st.at) return null;
    return st.byOurId.get(id) || null;
  }

  async function refresh() {
    if (st.inflight) return st.inflight;
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const kill = ctrl ? setTimeout(() => ctrl.abort(), 20000) : 0;
    st.tried = Date.now();
    st.inflight = (async () => {
      try {
        const res = await doFetch(AVAIL_URL, { cache: "no-store", signal: ctrl && ctrl.signal });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const rows = await res.json();
        if (!Array.isArray(rows) || !rows.length) throw new Error("格式不符");
        const items = getItems();
        const key = items.length + ":" + rows.length;
        if (key !== st.matchKey) { st.match = matchLots(items, rows); st.matchKey = key; }
        const byOfficial = new Map(rows.map((r) => [String(r.ID), r]));
        const next = new Map();
        for (const [ourId, offId] of st.match) {
          const r = byOfficial.get(offId);
          if (!r) continue;
          const code = String(r.AvailableCarRGB || "B").toUpperCase();
          next.set(ourId, {
            code: STATUS[code] ? code : "B",
            total: Number.isFinite(+r.TotalCar) && +r.TotalCar > 0 ? +r.TotalCar : null,
            official: r.Position,
          });
        }
        st.byOurId = next;
        st.at = Date.now();
        onChange();
      } catch (e) {
        console.warn("即時車位資料暫時無法取得", e);
        if (st.at && Date.now() - st.at > staleAfter) { st.at = 0; st.byOurId = new Map(); onChange(); }
      } finally {
        clearTimeout(kill);
        st.inflight = null;
      }
    })();
    return st.inflight;
  }

  function schedule() {
    clearTimeout(st.timer);
    if (document.hidden) return;
    const wait = st.tried ? Math.max(0, interval - (Date.now() - st.tried)) : 0;
    st.timer = setTimeout(async () => { await refresh(); schedule(); }, wait);
  }

  function start() {
    if (st.started) return;
    st.started = true;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) clearTimeout(st.timer);
      else schedule();
    });
    schedule();
  }

  return {
    start,
    lookup,
    get updatedAt() { return st.at ? new Date(st.at) : null; },
    get matchedCount() { return st.match.size; },
  };
}

/* =====================================================================
 * 剩餘車位「數字」：TDX（交通部運輸資料流通服務平臺）
 *
 * 瀏覽器不直接呼叫 TDX（需要金鑰）。GitHub Actions 約每 5 分鐘用 scripts/tdx_availability.mjs
 * 抓一次、配對好，寫成同站的 data/availability.json；這裡只讀那個靜態檔。
 * 數字是「自小客車位」，不含機車。檔案不存在（剛部署、Actions 還沒跑）時安靜地什麼都不做，畫面照舊用燈號。
 * ===================================================================== */
export const COUNTS_URL = "data/availability.json";
export const COUNTS_SOURCE_NAME = "交通部運輸資料流通服務平臺（TDX）";

/**
 * GitHub Pages 的 CDN 會快取 10 分鐘；用「每分鐘換一次」的查詢字串避開舊快取，
 * 同一分鐘內的請求仍共用同一份 CDN 快取。
 */
export function countsUrl(now = Date.now(), bucketMs = 60000, base = COUNTS_URL) {
  return base + "?t=" + Math.floor(now / bucketMs);
}

/** 剩餘數 → 燈號鍵（只拿來配顏色；文字一律是數字本身）。燈號說「即將滿／已滿」時至少顯示黃色。 */
export function countKey(avail, total, lightCode) {
  if (avail <= 0) return "full";
  const low = total ? Math.max(3, Math.ceil(total * 0.1)) : 3;
  if (avail <= low || lightCode === "Y" || lightCode === "R") return "few";
  return "ok";
}

/**
 * 解析 availability.json；個別停車場的回報時間太舊（maxAgeMs）就不給數字。
 * @returns {Map<string, {avail:number,total:number|null,time:Date}>}
 */
export function parseCounts(json, now = Date.now(), maxAgeMs = 30 * 60000) {
  const out = new Map();
  const items = json && json.items;
  if (!items || typeof items !== "object") return out;
  const fileTime = Date.parse(json.update_time || json.generated_at);
  for (const [id, v] of Object.entries(items)) {
    if (!v || !Number.isFinite(v.avail) || v.avail < 0) continue;
    const t = Date.parse(v.time) || fileTime;
    if (!Number.isFinite(t) || now - t > maxAgeMs) continue;
    out.set(id, { avail: v.avail, total: Number.isFinite(v.total) && v.total > 0 ? v.total : null, time: new Date(t) });
  }
  return out;
}

/**
 * 定期讀 data/availability.json：頁面可見時每 60 秒，背景暫停；失敗時保留上一份
 * （每次查詢時仍依各場回報時間判斷是否過舊，所以斷線很久也不會一直顯示舊數字）。
 */
export function createCounts({ onChange, interval = 60000, maxAgeMs = 30 * 60000, fetchImpl, url = COUNTS_URL }) {
  const doFetch = fetchImpl || ((u, o) => fetch(u, o));
  const st = { json: null, map: new Map(), parsedAt: 0, tried: 0, timer: 0, inflight: null, started: false, missing: false };

  function current() {
    // 每分鐘重算一次過舊判斷（不用等下一次抓檔）
    if (st.json && Date.now() - st.parsedAt > 60000) { st.map = parseCounts(st.json, Date.now(), maxAgeMs); st.parsedAt = Date.now(); }
    return st.map;
  }

  async function refresh() {
    if (st.inflight) return st.inflight;
    st.tried = Date.now();
    st.inflight = (async () => {
      try {
        const res = await doFetch(countsUrl(Date.now(), 60000, url), { cache: "no-store" });
        if (res.status === 404) { st.missing = true; return; }   // 尚未產生：只用燈號
        if (!res.ok) throw new Error("HTTP " + res.status);
        const json = await res.json();
        if (!json || typeof json.items !== "object") throw new Error("格式不符");
        st.missing = false;
        st.json = json;
        st.map = parseCounts(json, Date.now(), maxAgeMs);
        st.parsedAt = Date.now();
        onChange();
      } catch (e) {
        console.warn("剩餘車位數字暫時無法取得", e);
        const before = st.map.size;
        if (st.json && current().size !== before) onChange();
      } finally {
        st.inflight = null;
      }
    })();
    return st.inflight;
  }

  function schedule() {
    clearTimeout(st.timer);
    if (document.hidden) return;
    const wait = st.tried ? Math.max(0, interval - (Date.now() - st.tried)) : 0;
    st.timer = setTimeout(async () => { await refresh(); schedule(); }, wait);
  }

  function start() {
    if (st.started) return;
    st.started = true;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) clearTimeout(st.timer);
      else schedule();
    });
    schedule();
  }

  return {
    start,
    refresh,
    lookup: (id) => current().get(id) || null,
    get size() { return current().size; },
    /** TDX 整體更新時間（TDX 的時鐘） */
    get updateTime() { const t = st.json && Date.parse(st.json.update_time || st.json.generated_at); return t && current().size ? new Date(t) : null; },
    get matched() { return st.json ? +st.json.matched || 0 : 0; },
  };
}

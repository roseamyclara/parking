#!/usr/bin/env node
/* 臺中市身障免銷單停車場地圖 — 從 TDX 抓「剩餘車位數」
 *
 * 來源：交通部運輸資料流通服務平臺（TDX）
 *   路外停車場即時剩餘車位 /api/basic/v1/Parking/OffStreet/ParkingAvailability/City/Taichung
 *
 * 用法（金鑰只從環境變數讀取，本程式不會印出金鑰或 access token）：
 *   TDX_CLIENT_ID=… TDX_CLIENT_SECRET=… node scripts/tdx_availability.mjs
 *
 * 輸出 data/availability.json，以 parkings.json 的 id 為鍵：
 *   { generated_at, source, update_time, matched, count, items: { "<id>": { avail, total, time } } }
 *   matched = 名稱／座標配對到 TDX 的座數；count = 其中有新鮮小型車數字、寫進 items 的座數。
 * 數字一律是「自小客車位」（SpaceType 1），不是含機車的總數。
 *
 * 抓不到或配對異常時直接以非 0 結束，不覆蓋原本的好檔案。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { matchLots } from "../availability.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PARKING = path.resolve(HERE, "..");
export const DEFAULT_PARKINGS = path.join(PARKING, "data", "parkings.json");
export const DEFAULT_OUT = path.join(PARKING, "data", "availability.json");

export const TOKEN_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
export const DATA_URL = "https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet/ParkingAvailability/City/Taichung?$format=JSON";
// 臺中市交通局開放資料（免金鑰），只用來補 TDX 沒有的座標，讓 45 公尺座標備援也能用
export const MOTO_URL = "https://motoretag.taichung.gov.tw/DataAPI/api/ParkingAPIV2/Opendata";
export const SOURCE = "交通部運輸資料流通服務平臺（TDX）路外停車場即時剩餘車位";

const CAR = 1;   // SpaceType 1 = 自小客車
// 個別停車場的 DataCollectTime 比 TDX 整體 UpdateTime 舊超過這麼久，就當作設備沒在回報，不給數字
// （實測有幾座停在好幾個月前，例如剩 0 格的舊值）
export const STALE_MS = 60 * 60e3;

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(+v) ? null : +v);

/**
 * 取「小型車」的總車位與剩餘車位。有 SpaceType 1 就用它；沒有才退回頂層（可能含機車）。
 * 負數（TDX 用來表示未知）視為沒有數字。
 * @returns {{ avail: number|null, total: number|null, carType: boolean }}
 */
export function carSpaces(row) {
  const list = Array.isArray(row && row.Availabilities) ? row.Availabilities : [];
  const car = list.find((a) => a && +a.SpaceType === CAR);
  const src = car ? { total: car.NumberOfSpaces, avail: car.AvailableSpaces } : { total: row && row.TotalSpaces, avail: row && row.AvailableSpaces };
  let total = num(src.total), avail = num(src.avail);
  if (total !== null && total <= 0) total = null;
  if (avail !== null && avail < 0) avail = null;
  return { avail, total, carType: !!car };
}

/** TDX 列 → matchLots 需要的形狀；座標從交通局開放資料依「區-機關-名稱P」完全相同的字串借用 */
export function toOfficial(rows, motoRows) {
  const coord = new Map();
  for (const m of motoRows || []) {
    if (!m || !m.Position) continue;
    const k = String(m.Position).trim();
    // 同一個名稱出現兩次以上就不借座標，免得放錯位置
    coord.set(k, coord.has(k) ? null : { Lat: m.Lat, Lng: m.Lng });
  }
  return rows
    .filter((r) => r && r.CarParkID && r.CarParkName && r.CarParkName.Zh_tw)
    .map((r) => {
      const pos = String(r.CarParkName.Zh_tw).trim();
      const c = coord.get(pos);
      return { ID: String(r.CarParkID), Position: pos, Lat: c ? c.Lat : undefined, Lng: c ? c.Lng : undefined };
    });
}

/**
 * 組出 availability.json 的內容（純函式，方便測試）。
 * matchLots 本身保證「一筆官方資料只配給我們一筆」（座標備援時）；這裡再保險檢查一次，
 * 名稱比對若把同一個 TDX 停車場配給好幾筆，就全部不顯示數字。
 */
export function buildAvailability({ ours, tdx, moto, now = new Date() }) {
  const rows = (tdx && tdx.ParkingAvailabilities) || [];
  const official = toOfficial(rows, moto);
  const match = matchLots(ours, official);

  const owners = new Map();
  for (const [ourId, tdxId] of match) owners.set(tdxId, (owners.get(tdxId) || 0) + 1);

  const byId = new Map(rows.map((r) => [String(r.CarParkID), r]));
  const items = {};
  const ref = Date.parse(tdx && tdx.UpdateTime) || now.getTime();
  let numeric = 0, dup = 0, stale = 0;
  for (const [ourId, tdxId] of match) {
    if (owners.get(tdxId) > 1) { dup++; continue; }
    const r = byId.get(tdxId);
    if (!r) continue;
    const { avail, total } = carSpaces(r);
    if (avail === null) continue;
    if (r.ServiceStatus !== undefined && +r.ServiceStatus !== 1) continue;   // 非營業中不報數字
    const time = r.DataCollectTime || tdx.UpdateTime || null;
    const t = Date.parse(time);
    if (!Number.isFinite(t) || ref - t > STALE_MS) { stale++; continue; }
    items[ourId] = { avail, total, time };
    numeric++;
  }
  return {
    data: {
      generated_at: isoTaipei(now),
      source: SOURCE,
      update_time: tdx.UpdateTime || null,
      matched: match.size - dup,
      count: numeric,
      items,
    },
    stats: { tdxRows: rows.length, ours: ours.length, matched: match.size - dup, numeric, stale, dup },
  };
}

/** 2026-11-14T23:54:00+08:00 這種格式（與 parkings.json 的 generated_at 一致） */
export function isoTaipei(d) {
  const t = new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 19);
  return t + "+08:00";
}

async function getJSON(fetchImpl, url, opts, what) {
  const res = await fetchImpl(url, opts);
  if (!res.ok) throw new Error(what + " HTTP " + res.status);   // 不印回應內容，避免帶出任何認證資訊
  return res.json();
}

/** 取得 access token。錯誤訊息只含 HTTP 狀態碼。 */
export async function getToken({ clientId, clientSecret, fetchImpl = fetch }) {
  if (!clientId || !clientSecret) throw new Error("缺少 TDX_CLIENT_ID / TDX_CLIENT_SECRET 環境變數");
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
  const j = await getJSON(fetchImpl, TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  }, "TDX token");
  if (!j || !j.access_token) throw new Error("TDX token 回應沒有 access_token");
  return j.access_token;
}

export async function fetchTdx({ token, fetchImpl = fetch }) {
  const j = await getJSON(fetchImpl, DATA_URL, {
    headers: { authorization: "Bearer " + token, accept: "application/json" },
  }, "TDX ParkingAvailability");
  if (!j || !Array.isArray(j.ParkingAvailabilities) || !j.ParkingAvailabilities.length) {
    throw new Error("TDX 回應格式不符或沒有資料");
  }
  return j;
}

export async function fetchMoto({ fetchImpl = fetch } = {}) {
  try {
    const j = await getJSON(fetchImpl, MOTO_URL, {}, "交通局開放資料");
    return Array.isArray(j) ? j : [];
  } catch (e) {
    console.warn("交通局座標資料暫時無法取得，只用名稱比對：" + e.message);
    return [];
  }
}

/**
 * 整個流程；寫檔前做健全性檢查，任何一步失敗都 throw，不碰原檔。
 * @returns {Promise<{ changed: boolean, stats: object }>}
 */
export async function run({
  env = process.env, fetchImpl = fetch, parkingsPath = DEFAULT_PARKINGS, outPath = DEFAULT_OUT,
  now = new Date(), minMatched = 50, log = console.log,
} = {}) {
  const ours = JSON.parse(fs.readFileSync(parkingsPath, "utf8")).items;
  if (!Array.isArray(ours) || !ours.length) throw new Error("parkings.json 沒有停車場");

  const token = await getToken({ clientId: env.TDX_CLIENT_ID, clientSecret: env.TDX_CLIENT_SECRET, fetchImpl });
  const [tdx, moto] = await Promise.all([fetchTdx({ token, fetchImpl }), fetchMoto({ fetchImpl })]);
  const { data, stats } = buildAvailability({ ours, tdx, moto, now });
  stats.moto = moto.length;

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(outPath, "utf8")); } catch {}
  if (data.count < minMatched) throw new Error("只有 " + data.count + " 座有數字（下限 " + minMatched + "），不覆蓋原檔");
  if (prev && prev.count && data.count < prev.count * 0.5) {
    throw new Error("有數字的停車場從 " + prev.count + " 掉到 " + data.count + "，疑似資料異常，不覆蓋原檔");
  }

  // 只有時間戳記變動（資料其實一樣）時也照寫：time 欄位本身就是新資料。
  // 但 TDX 沒更新（UpdateTime 與各場時間都一樣）時，內容除了 generated_at 相同，就不重寫，避免空 commit。
  const same = prev && prev.update_time === data.update_time && JSON.stringify(prev.items) === JSON.stringify(data.items);
  if (same) {
    log("TDX 資料沒有變動（" + data.update_time + "），不重寫檔案");
    return { changed: false, stats };
  }
  const tmp = outPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data) + "\n");
  fs.renameSync(tmp, outPath);
  log("已寫入 " + path.relative(process.cwd(), outPath) + "：TDX " + stats.tdxRows + " 筆，配對 " + stats.matched +
    " / " + stats.ours + "，有小型車數字 " + stats.numeric + "，回報過舊略過 " + stats.stale + "（TDX 更新 " + data.update_time + "）");
  return { changed: true, stats };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  run().then(
    (r) => {
      if (process.env.GITHUB_STEP_SUMMARY) {
        const s = r.stats;
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
          "### TDX 剩餘車位\n\n| 項目 | 數量 |\n|---|---|\n" +
          "| TDX 停車場 | " + s.tdxRows + " |\n| 我們的停車場 | " + s.ours + " |\n" +
          "| 配對成功 | " + s.matched + " |\n| 有小型車數字 | " + s.numeric + " |\n| 回報過舊略過 | " + s.stale + " |\n" +
          "| 檔案有變動 | " + (r.changed ? "是" : "否") + " |\n");
      }
    },
    (e) => { console.error("TDX 剩餘車位更新失敗：" + e.message); process.exit(1); },
  );
}

// TDX 剩餘車位配對與計算模組（與專案根目錄 availability.js 及 scripts/tdx_availability.mjs 邏輯完全一致）。
// 放在 supabase/functions/tdx-availability/ 內，確保 supabase functions deploy tdx-availability 獨立打包。

export const TOKEN_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
export const DATA_URL = "https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet/ParkingAvailability/City/Taichung?$format=JSON";
export const MOTO_URL = "https://motoretag.taichung.gov.tw/DataAPI/api/ParkingAPIV2/Opendata";
export const PARKINGS_URL = "https://roseamyclara.github.io/parking/data/parkings.json";
export const SOURCE = "交通部運輸資料流通服務平臺（TDX）路外停車場即時剩餘車位";

const CAR = 1;               // SpaceType 1 = 自小客車
export const STALE_MS = 60 * 60e3;
const COORD_MAX_M = 45;

export interface OurLot {
  id: string;
  name: string;
  district?: string;
  lat?: number | null;
  lng?: number | null;
  precision?: string;
}

export interface OfficialLot {
  ID: string | number;
  Position: string;
  Lat?: number | string;
  Lng?: number | string;
}

export interface MotoRow {
  ID?: string | number;
  Position?: string;
  Lat?: number | string;
  Lng?: number | string;
}

export interface TdxSpaceAvailability {
  SpaceType?: number | string;
  NumberOfSpaces?: number | string | null;
  AvailableSpaces?: number | string | null;
}

export interface TdxAvailabilityRow {
  CarParkID?: string | number;
  CarParkName?: { Zh_tw?: string; En?: string };
  ServiceStatus?: number | string;
  FullStatus?: number | string;
  TotalSpaces?: number | string | null;
  AvailableSpaces?: number | string | null;
  Availabilities?: TdxSpaceAvailability[];
  DataCollectTime?: string;
}

export interface TdxResponse {
  UpdateTime?: string;
  ParkingAvailabilities?: TdxAvailabilityRow[];
}

export interface AvailabilityItem {
  avail: number;
  total: number | null;
  time: string | null;
}

export interface AvailabilityPayload {
  generated_at: string;
  source: string;
  update_time: string | null;
  matched: number;
  count: number;
  items: Record<string, AvailabilityItem>;
}

const tc = (s: unknown): string => String(s || "").replace(/台/g, "臺");
const NOISE = /停車場|停車塔|附屬|附設|共享|地下|立體|平面|公有|市立|臺中市/g;
const PAREN = /[（(]([^）)]*)[）)]/g;

function levelOf(s: string): string {
  const m = /地下|平面|立體/.exec(s);
  return m ? m[0] : "";
}

export function normName(
  raw: unknown,
  districts?: string[],
  stripShort?: boolean,
): { n: string; level: string; aliases: string[] } {
  let s = tc(raw);
  let section = "";
  const aliases: string[] = [];
  s = s.replace(PAREN, (_m: string, inner: string) => {
    const sec = /^\s*([A-Za-z])\s*區\s*$/.exec(inner);
    if (sec) section = sec[1].toLowerCase();
    else if (/停/.test(inner)) aliases.push(inner);
    return " ";
  });
  const level = levelOf(s);
  const clean = (x: string): string => {
    x = x.trim().replace(/\s*[Pp]\d*\s*$/, "").replace(NOISE, "").replace(/[\s、，,.\-‧·_／/]/g, "").toLowerCase();
    for (const d of districts || []) {
      const short = d.replace(/區$/, "");
      const pre = x.startsWith(d) ? d : stripShort && short.length >= 2 && x.startsWith(short) ? short : "";
      if (pre) {
        if (x.length - pre.length >= 2) x = x.slice(pre.length);
        break;
      }
    }
    return x;
  };
  const n = clean(s);
  return { n: n ? n + section : "", level, aliases: aliases.map(clean).filter((a) => a.length >= 2) };
}

export function parsePosition(pos: unknown): { district: string; name: string } {
  const parts = String(pos || "").split("-");
  if (parts.length >= 3) return { district: tc(parts[0]), name: parts.slice(2).join("-") };
  return { district: "", name: String(pos || "") };
}

function meters(a: number, b: number, c: number, d: number): number {
  const R = 6371000;
  const p = Math.PI / 180;
  const dLat = (c - a) * p;
  const dLng = (d - b) * p;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

interface ParsedOfficial {
  id: string;
  district: string;
  n: string;
  level: string;
  lat: number;
  lng: number;
}

export function matchLots(ours: OurLot[], official: OfficialLot[]): Map<string, string> {
  const districts = [...new Set(official.map((o) => parsePosition(o && o.Position).district).filter((d) => /區$/.test(d)))]
    .sort((a, b) => b.length - a.length);
  const recs: ParsedOfficial[] = official
    .filter((o) => o && o.ID != null && o.Position && !/機車|大客車/.test(o.Position))
    .map((o) => {
      const p = parsePosition(o.Position);
      const nn = normName(p.name, districts);
      return {
        id: String(o.ID),
        district: p.district,
        n: nn.n,
        level: nn.level,
        lat: +(o.Lat as number),
        lng: +(o.Lng as number),
      };
    })
    .filter((r) => r.n);

  const byDistrict = new Map<string, ParsedOfficial[]>();
  for (const r of recs) {
    if (!byDistrict.has(r.district)) byDistrict.set(r.district, []);
    byDistrict.get(r.district)!.push(r);
  }

  const out = new Map<string, string>();
  const pending: OurLot[] = [];
  for (const it of ours) {
    const name = tc(it.name);
    const named = districts.find((d) => name.startsWith(d));
    const dist = named || tc(it.district);
    const known = byDistrict.has(dist);
    const pool = known ? byDistrict.get(dist)! : recs;
    const me = normName(name, districts, true);
    const maxM = it.precision === "DISTRICT" ? 15000 : 4000;
    const near = (r: ParsedOfficial) =>
      it.lat == null || it.lng == null || !Number.isFinite(r.lat) || meters(it.lat, it.lng, r.lat, r.lng) <= maxM;
    const ok = (r: ParsedOfficial) => !(me.level && r.level && me.level !== r.level);
    const pick = (cands: ParsedOfficial[], needNear = false): ParsedOfficial | null => {
      cands = cands.filter((r) => ok(r) && (!needNear || near(r)));
      if (cands.length > 1) {
        const same = cands.filter((r) => r.level === me.level);
        if (same.length === 1) return same[0];
      }
      return cands.length === 1 ? cands[0] : null;
    };

    let hit = me.n ? pick(pool.filter((r) => r.n === me.n)) : null;
    for (const a of me.aliases) {
      if (hit) break;
      hit = pick(pool.filter((r) => r.n === a));
    }
    if (!hit && known && me.n.length >= 3) {
      const zoneOnly = (a: string, b: string) => /第|區|^[a-z]$|[a-z]$/.test(a.replace(b, ""));
      hit = pick(
        pool.filter(
          (r) =>
            r.n.length >= 3 &&
            (r.n.includes(me.n) || me.n.includes(r.n)) &&
            Math.min(r.n.length, me.n.length) >= Math.ceil(Math.max(r.n.length, me.n.length) / 2) &&
            !zoneOnly(r.n.length > me.n.length ? r.n : me.n, r.n.length > me.n.length ? me.n : r.n),
        ),
        true,
      );
    }
    if (hit) out.set(it.id, hit.id);
    else pending.push(it);
  }

  const used = new Set(out.values());
  const claims = new Map<string, string[]>();
  for (const it of pending) {
    if (it.lat == null || it.lng == null || it.precision === "DISTRICT") continue;
    const close = recs.filter((r) => Number.isFinite(r.lat) && meters(it.lat!, it.lng!, r.lat, r.lng) <= COORD_MAX_M);
    if (close.length !== 1 || used.has(close[0].id)) continue;
    const k = close[0].id;
    if (!claims.has(k)) claims.set(k, []);
    claims.get(k)!.push(it.id);
  }
  for (const [k, ids] of claims) {
    if (ids.length === 1) out.set(ids[0], k);
  }

  return out;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(+v) ? null : +v);

export function carSpaces(
  row: TdxAvailabilityRow | null | undefined,
): { avail: number | null; total: number | null; carType: boolean } {
  const list = Array.isArray(row && row.Availabilities) ? row!.Availabilities! : [];
  const car = list.find((a) => a && Number(a.SpaceType) === CAR);
  const src = car
    ? { total: car.NumberOfSpaces, avail: car.AvailableSpaces }
    : { total: row && row.TotalSpaces, avail: row && row.AvailableSpaces };
  let total = num(src.total);
  let avail = num(src.avail);
  if (total !== null && total <= 0) total = null;
  if (avail !== null && avail < 0) avail = null;
  return { avail, total, carType: !!car };
}

export function toOfficial(rows: TdxAvailabilityRow[], motoRows?: MotoRow[] | null): OfficialLot[] {
  const coord = new Map<string, { Lat: number | string | undefined; Lng: number | string | undefined } | null>();
  for (const m of motoRows || []) {
    if (!m || !m.Position) continue;
    const k = String(m.Position).trim();
    coord.set(k, coord.has(k) ? null : { Lat: m.Lat, Lng: m.Lng });
  }
  return rows
    .filter((r) => r && r.CarParkID && r.CarParkName && r.CarParkName.Zh_tw)
    .map((r) => {
      const pos = String(r.CarParkName!.Zh_tw).trim();
      const c = coord.get(pos);
      return {
        ID: String(r.CarParkID),
        Position: pos,
        Lat: c ? c.Lat : undefined,
        Lng: c ? c.Lng : undefined,
      };
    });
}

export function isoTaipei(d: Date): string {
  const t = new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 19);
  return t + "+08:00";
}

export function buildAvailability({
  ours,
  tdx,
  moto,
  now = new Date(),
}: {
  ours: OurLot[];
  tdx: TdxResponse;
  moto?: MotoRow[];
  now?: Date;
}): {
  data: AvailabilityPayload;
  stats: { tdxRows: number; ours: number; matched: number; numeric: number; stale: number; dup: number };
} {
  const rows = (tdx && tdx.ParkingAvailabilities) || [];
  const official = toOfficial(rows, moto);
  const match = matchLots(ours, official);

  const owners = new Map<string, number>();
  for (const [, tdxId] of match) owners.set(tdxId, (owners.get(tdxId) || 0) + 1);

  const byId = new Map(rows.map((r) => [String(r.CarParkID), r]));
  const items: Record<string, AvailabilityItem> = {};
  const ref = Date.parse(tdx && tdx.UpdateTime ? tdx.UpdateTime : "") || now.getTime();
  let numeric = 0;
  let dup = 0;
  let stale = 0;
  for (const [ourId, tdxId] of match) {
    if ((owners.get(tdxId) || 0) > 1) {
      dup++;
      continue;
    }
    const r = byId.get(tdxId);
    if (!r) continue;
    const { avail, total } = carSpaces(r);
    if (avail === null) continue;
    if (r.ServiceStatus !== undefined && +r.ServiceStatus !== 1) continue;
    const time = r.DataCollectTime || tdx.UpdateTime || null;
    const t = time ? Date.parse(time) : NaN;
    if (!Number.isFinite(t) || ref - t > STALE_MS) {
      stale++;
      continue;
    }
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

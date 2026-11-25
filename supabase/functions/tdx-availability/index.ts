// tdx-availability：臺中市身障免銷單停車場地圖的 TDX 剩餘車位即時代理。
// 前端點擊「即時更新」時呼叫；金鑰只存在 Supabase Edge Function Secrets，絕不外洩到前端或錯誤訊息。
// 內建 90 秒共用快取（記憶體 + Supabase DB）、同執行個體併發合併，以及每日（臺灣時間）90 次上限。
//
// 部署：supabase functions deploy tdx-availability
// Secrets：TDX_CLIENT_ID、TDX_CLIENT_SECRET
// 環境變數（Supabase 自動提供）：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  TOKEN_URL,
  DATA_URL,
  MOTO_URL,
  PARKINGS_URL,
  buildAvailability,
  type AvailabilityPayload,
  type MotoRow,
  type OurLot,
  type TdxResponse,
} from "./tdx.ts";

const ALLOWED_ORIGIN = "https://roseamyclara.github.io";
const CACHE_TTL_MS = 90_000;            // 90 秒共用快取
const DAILY_CAP = 90;                   // 臺灣時間每日最多向 TDX 查詢 90 次
const MIN_MATCHED = 50;                 // 健全性檢查下限
const PARKINGS_CACHE_TTL_MS = 6 * 3600_000;
const TOKEN_MARGIN_MS = 120_000;        // token 到期前 120 秒重抓

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Vary": "Origin",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

interface CacheEntry {
  payload: AvailabilityPayload;
  fetchedAtMs: number;
}

interface TokenEntry {
  accessToken: string;
  expiresAtMs: number;
}

interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

// 執行個體內快取（降低 DB 與外部請求次數；若 DB 尚未執行 migration 也可作為安全備援）
let memCache: CacheEntry | null = null;
let memToken: TokenEntry | null = null;
let memParkings: { items: OurLot[]; fetchedAtMs: number } | null = null;
let memDaily = { day: "", fetches: 0 };
let lastDaily: { day: string; fetches: number } | null = null;
let inFlight: Promise<HandlerResult> | null = null;

function jsonResp(body: unknown, status = 200, headers: Record<string, string> = CORS): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function taipeiDay(nowMs = Date.now()): string {
  return new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10);
}

function nextRefreshSeconds(fetchedAtMs: number, nowMs = Date.now()): number {
  const rem = fetchedAtMs + CACHE_TTL_MS - nowMs;
  return rem > 0 ? Math.max(1, Math.ceil(rem / 1000)) : 0;
}

function isMissingSchemaError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "42883" || err.code === "PGRST202" || err.code === "PGRST205") {
    return true;
  }
  const msg = String(err.message || "");
  return /does not exist|schema cache|Could not find the (table|function)/i.test(msg);
}

function getDb(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function claimInMemoryDaily(nowMs: number, cap: number): { allowed: boolean; fetches: number } {
  const day = taipeiDay(nowMs);
  if (memDaily.day !== day) memDaily = { day, fetches: 0 };
  if (memDaily.fetches < cap) {
    memDaily.fetches++;
    return { allowed: true, fetches: memDaily.fetches };
  }
  return { allowed: false, fetches: memDaily.fetches };
}

function validPayload(v: unknown): v is AvailabilityPayload {
  return !!v && typeof v === "object" && typeof (v as AvailabilityPayload).items === "object" && (v as AvailabilityPayload).items !== null;
}

async function readDbCache(db: SupabaseClient): Promise<CacheEntry | null> {
  const { data, error } = await db
    .from("tdx_availability_cache")
    .select("payload, fetched_at")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) {
      console.warn("tdx_availability_cache 尚未建立，退回記憶體快取");
    } else {
      console.warn("讀取 tdx_availability_cache 失敗：" + (error.code || error.message));
    }
    return null;
  }
  if (!data || !validPayload(data.payload)) return null;
  const fetchedAtMs = Date.parse(String(data.fetched_at || ""));
  if (!Number.isFinite(fetchedAtMs)) return null;
  return { payload: data.payload, fetchedAtMs };
}

async function writeDbCache(db: SupabaseClient, payload: AvailabilityPayload, fetchedAtIso: string): Promise<void> {
  const { error } = await db
    .from("tdx_availability_cache")
    .upsert({ id: 1, payload, fetched_at: fetchedAtIso }, { onConflict: "id" });
  if (error) {
    if (isMissingSchemaError(error)) {
      console.warn("tdx_availability_cache 尚未建立，僅存於記憶體快取");
    } else {
      console.warn("寫入 tdx_availability_cache 失敗：" + (error.code || error.message));
    }
  }
}

async function claimDailyQuota(db: SupabaseClient | null, nowMs: number): Promise<{ allowed: boolean; fetches: number }> {
  if (!db) return claimInMemoryDaily(nowMs, DAILY_CAP);
  const { data, error } = await db.rpc("claim_tdx_fetch", { p_cap: DAILY_CAP });
  if (error) {
    if (isMissingSchemaError(error)) {
      console.warn("claim_tdx_fetch 尚未建立，退回記憶體每日上限計數");
    } else {
      console.warn("呼叫 claim_tdx_fetch 失敗，退回記憶體每日上限計數：" + (error.code || error.message));
    }
    return claimInMemoryDaily(nowMs, DAILY_CAP);
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.allowed !== "boolean") {
    return claimInMemoryDaily(nowMs, DAILY_CAP);
  }
  const fetches = Number(row.fetches) || 0;
  // 同步記憶體計數，讓同一執行個體在需要退回時不重複歸零
  const day = taipeiDay(nowMs);
  if (memDaily.day !== day || fetches > memDaily.fetches) {
    memDaily = { day, fetches };
  }
  return { allowed: row.allowed, fetches };
}

async function fetchParkings(nowMs: number): Promise<OurLot[]> {
  if (memParkings && nowMs - memParkings.fetchedAtMs < PARKINGS_CACHE_TTL_MS) {
    return memParkings.items;
  }
  try {
    const res = await fetch(PARKINGS_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error("parkings.json HTTP " + res.status);
    const json = await res.json();
    const items = json && Array.isArray(json.items) ? (json.items as OurLot[]) : null;
    if (!items || !items.length) throw new Error("parkings.json 沒有停車場資料");
    memParkings = { items, fetchedAtMs: nowMs };
    return items;
  } catch (e) {
    if (memParkings && memParkings.items.length) {
      console.warn("重讀 parkings.json 失敗，改用記憶體備份");
      return memParkings.items;
    }
    throw e;
  }
}

async function readDbToken(db: SupabaseClient, nowMs: number): Promise<TokenEntry | null> {
  const { data, error } = await db
    .from("tdx_token_cache")
    .select("access_token, expires_at")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    if (!isMissingSchemaError(error)) {
      console.warn("讀取 tdx_token_cache 失敗：" + (error.code || error.message));
    }
    return null;
  }
  if (!data || typeof data.access_token !== "string" || !data.access_token) return null;
  const expiresAtMs = Date.parse(String(data.expires_at || ""));
  if (!Number.isFinite(expiresAtMs) || expiresAtMs - nowMs <= TOKEN_MARGIN_MS) return null;
  return { accessToken: data.access_token, expiresAtMs };
}

async function writeDbToken(db: SupabaseClient, entry: TokenEntry): Promise<void> {
  const { error } = await db
    .from("tdx_token_cache")
    .upsert(
      { id: 1, access_token: entry.accessToken, expires_at: new Date(entry.expiresAtMs).toISOString() },
      { onConflict: "id" },
    );
  if (error && !isMissingSchemaError(error)) {
    console.warn("寫入 tdx_token_cache 失敗：" + (error.code || error.message));
  }
}

async function requestNewToken(clientId: string, clientSecret: string, nowMs: number): Promise<TokenEntry> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // 僅帶入狀態碼，絕不印出回應內容或任何憑證
    throw new Error("TDX token HTTP " + res.status);
  }
  const j = await res.json();
  if (!j || typeof j.access_token !== "string" || !j.access_token) {
    throw new Error("TDX token 回應缺少 access_token");
  }
  const expiresInSec = Number(j.expires_in) > 0 ? Number(j.expires_in) : 86400;
  return { accessToken: j.access_token, expiresAtMs: nowMs + expiresInSec * 1000 };
}

async function getAccessToken(
  db: SupabaseClient | null,
  clientId: string,
  clientSecret: string,
  nowMs: number,
  forceRefresh = false,
): Promise<{ token: string; fromCache: boolean }> {
  if (!forceRefresh && memToken && memToken.expiresAtMs - nowMs > TOKEN_MARGIN_MS) {
    return { token: memToken.accessToken, fromCache: true };
  }
  if (!forceRefresh && db) {
    const dbTok = await readDbToken(db, nowMs);
    if (dbTok) {
      memToken = dbTok;
      return { token: dbTok.accessToken, fromCache: true };
    }
  }
  const fresh = await requestNewToken(clientId, clientSecret, nowMs);
  memToken = fresh;
  if (db) await writeDbToken(db, fresh);
  return { token: fresh.accessToken, fromCache: false };
}

async function fetchTdxData(token: string): Promise<{ status: number; data: TdxResponse | null }> {
  const res = await fetch(DATA_URL, {
    headers: { authorization: "Bearer " + token, accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return { status: res.status, data: null };
  const j = await res.json();
  if (!j || !Array.isArray(j.ParkingAvailabilities) || !j.ParkingAvailabilities.length) {
    throw new Error("TDX 回應格式不符或沒有資料");
  }
  return { status: res.status, data: j as TdxResponse };
}

async function fetchMotoData(): Promise<MotoRow[]> {
  try {
    const res = await fetch(MOTO_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    return Array.isArray(j) ? (j as MotoRow[]) : [];
  } catch (e) {
    console.warn("交通局座標資料暫時無法取得，只用名稱比對：" + (e instanceof Error ? e.message : "錯誤"));
    return [];
  }
}

async function resolveAvailability(clientId: string, clientSecret: string): Promise<HandlerResult> {
  const nowMs = Date.now();
  const db = getDb();

  let latestCached: CacheEntry | null = memCache;
  if (db) {
    const dbCached = await readDbCache(db);
    if (dbCached && (!latestCached || dbCached.fetchedAtMs >= latestCached.fetchedAtMs)) {
      latestCached = dbCached;
      memCache = dbCached;
    }
  }

  // 共用 90 秒快取命中
  if (latestCached && nowMs - latestCached.fetchedAtMs <= CACHE_TTL_MS) {
    const today = taipeiDay(nowMs);
    const dailyFetches = lastDaily && lastDaily.day === today ? lastDaily.fetches : undefined;
    return {
      status: 200,
      body: {
        ...latestCached.payload,
        cached: true,
        capped: false,
        stale: false,
        ...(dailyFetches !== undefined ? { daily_fetches: dailyFetches } : {}),
        daily_cap: DAILY_CAP,
        next_refresh_in_seconds: nextRefreshSeconds(latestCached.fetchedAtMs, nowMs),
      },
    };
  }

  // 扣抵每日額度
  const quota = await claimDailyQuota(db, nowMs);
  lastDaily = { day: taipeiDay(nowMs), fetches: quota.fetches };
  if (!quota.allowed) {
    if (latestCached) {
      return {
        status: 200,
        body: {
          ...latestCached.payload,
          cached: true,
          capped: true,
          stale: true,
          daily_fetches: quota.fetches,
          daily_cap: DAILY_CAP,
          next_refresh_in_seconds: nextRefreshSeconds(latestCached.fetchedAtMs, nowMs),
        },
      };
    }
    return {
      status: 429,
      body: {
        error: "今日即時更新次數已達上限",
        capped: true,
        daily_fetches: quota.fetches,
        daily_cap: DAILY_CAP,
      },
    };
  }

  // 向 TDX 取得即時資料
  const [ours, tok] = await Promise.all([
    fetchParkings(nowMs),
    getAccessToken(db, clientId, clientSecret, nowMs),
  ]);

  let [tdxRes, moto] = await Promise.all([
    fetchTdxData(tok.token),
    fetchMotoData(),
  ]);

  // 若快取 token 提早失效（401），自動重抓一次 token 再試
  if (tdxRes.status === 401 && tok.fromCache) {
    memToken = null;
    const fresh = await getAccessToken(db, clientId, clientSecret, Date.now(), true);
    tdxRes = await fetchTdxData(fresh.token);
  }

  if (tdxRes.status < 200 || tdxRes.status >= 300 || !tdxRes.data) {
    throw new Error("TDX ParkingAvailability HTTP " + tdxRes.status);
  }

  const fetchedAt = new Date();
  const { data } = buildAvailability({ ours, tdx: tdxRes.data, moto, now: fetchedAt });
  if (data.count < MIN_MATCHED) {
    throw new Error("TDX 有效停車場數量過少（" + data.count + " < " + MIN_MATCHED + "）");
  }

  memCache = { payload: data, fetchedAtMs: fetchedAt.getTime() };
  if (db) await writeDbCache(db, data, fetchedAt.toISOString());

  return {
    status: 200,
    body: {
      ...data,
      cached: false,
      capped: false,
      stale: false,
      daily_fetches: quota.fetches,
      daily_cap: DAILY_CAP,
      next_refresh_in_seconds: Math.ceil(CACHE_TTL_MS / 1000),
    },
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (origin && origin !== ALLOWED_ORIGIN) {
    return new Response(JSON.stringify({ error: "Origin not allowed" }), {
      status: 403,
      headers: { "Vary": "Origin", "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: CORS });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return jsonResp({ error: "Method not allowed" }, 405);
  }

  const clientId = (Deno.env.get("TDX_CLIENT_ID") || "").trim();
  const clientSecret = (Deno.env.get("TDX_CLIENT_SECRET") || "").trim();
  if (!clientId || !clientSecret) {
    return jsonResp({ error: "TDX credentials not configured", code: "NOT_CONFIGURED" }, 503);
  }

  // 快速路徑：記憶體快取仍在 90 秒內時直接回應
  const nowMs = Date.now();
  if (memCache && nowMs - memCache.fetchedAtMs <= CACHE_TTL_MS) {
    const today = taipeiDay(nowMs);
    const dailyFetches = lastDaily && lastDaily.day === today ? lastDaily.fetches : undefined;
    return jsonResp({
      ...memCache.payload,
      cached: true,
      capped: false,
      stale: false,
      ...(dailyFetches !== undefined ? { daily_fetches: dailyFetches } : {}),
      daily_cap: DAILY_CAP,
      next_refresh_in_seconds: nextRefreshSeconds(memCache.fetchedAtMs, nowMs),
    }, 200);
  }

  try {
    if (!inFlight) {
      inFlight = resolveAvailability(clientId, clientSecret).finally(() => {
        inFlight = null;
      });
    }
    const result = await inFlight;
    return jsonResp(result.body, result.status);
  } catch (e) {
    // 僅記錄安全摘要，不印出憑證或 token
    const detail = e instanceof Error ? e.message : "unknown error";
    console.error("tdx-availability 失敗：" + detail);
    return jsonResp({ error: "TDX 暫時無法連線，請稍後再試", code: "UPSTREAM_ERROR" }, 502);
  }
});

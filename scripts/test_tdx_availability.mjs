// 離線測試：node --test parking/scripts/
// 不需要網路或真的 TDX 金鑰；HTTP 層全部用假的 fetch。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  carSpaces, toOfficial, buildAvailability, run, getToken, TOKEN_URL, DATA_URL, MOTO_URL,
} from "./tdx_availability.mjs";

const FAKE_ID = "fake-client-id";
const FAKE_SECRET = "fake-client-secret";
const FAKE_TOKEN = "fake-access-token";
const UPD = "2026-11-14T23:54:00+08:00";

const ours = [
  { id: "a", name: "自由一期立體停車場", district: "中區", lat: 24.1402, lng: 120.6820, precision: "ROOFTOP" },
  { id: "b", name: "大誠立體停車場", district: "中區", lat: 24.1430, lng: 120.6790, precision: "ROOFTOP" },
  { id: "c", name: "只有燈號的停車場", district: "北區", lat: 24.16, lng: 120.68, precision: "ROOFTOP" },
  { id: "d", name: "很舊停車場", district: "西區", lat: 24.15, lng: 120.66, precision: "ROOFTOP" },
];

const row = (id, name, extra) => ({
  CarParkID: id, CarParkName: { Zh_tw: name }, ServiceStatus: 1, FullStatus: 0,
  DataCollectTime: "2026-11-14T23:51:01+08:00", ...extra,
});

const tdx = {
  UpdateTime: UPD,
  ParkingAvailabilities: [
    row("01P0C0001E", "中區-交通局-自由一期立體P(B1F-6F)", {
      TotalSpaces: 470, AvailableSpaces: 199,
      Availabilities: [
        { SpaceType: 2, NumberOfSpaces: 180, AvailableSpaces: 120 },
        { SpaceType: 1, NumberOfSpaces: 290, AvailableSpaces: 79 },
      ],
    }),
    // 沒有 SpaceType 1 → 退回頂層
    row("01P0C0002E", "中區-交通局-大誠立體P", { TotalSpaces: 272, AvailableSpaces: 47, Availabilities: [] }),
    row("01P0W0009E", "西區-交通局-很舊P", {
      TotalSpaces: 20, AvailableSpaces: 0,
      Availabilities: [{ SpaceType: 1, NumberOfSpaces: 20, AvailableSpaces: 0 }],
      DataCollectTime: "2026-07-27T00:50:11+08:00",
    }),
  ],
};
const moto = [
  { ID: "999", Position: "中區-交通局-自由一期立體P(B1F-6F)", Lat: 24.1402, Lng: 120.6821 },
  { ID: "998", Position: "北區-交通局-只有燈號P", Lat: 24.16, Lng: 120.68 },
];

test("carSpaces 優先用 SpaceType 1（自小客車），不用含機車的總數", () => {
  assert.deepEqual(carSpaces(tdx.ParkingAvailabilities[0]), { avail: 79, total: 290, carType: true });
});

test("carSpaces 沒有 SpaceType 1 時退回頂層數字", () => {
  assert.deepEqual(carSpaces(tdx.ParkingAvailabilities[1]), { avail: 47, total: 272, carType: false });
});

test("carSpaces 負數或缺值不當成數字", () => {
  const r = { Availabilities: [{ SpaceType: 1, NumberOfSpaces: 0, AvailableSpaces: -1 }] };
  assert.deepEqual(carSpaces(r), { avail: null, total: null, carType: true });
  assert.equal(carSpaces({}).avail, null);
});

test("toOfficial 依完全相同的名稱借用交通局座標", () => {
  const o = toOfficial(tdx.ParkingAvailabilities, moto);
  assert.equal(o[0].ID, "01P0C0001E");
  assert.equal(o[0].Position, "中區-交通局-自由一期立體P(B1F-6F)");
  assert.equal(o[0].Lat, 24.1402);
  assert.equal(o[1].Lat, undefined);
});

test("toOfficial 名稱重複時不借座標", () => {
  const o = toOfficial(tdx.ParkingAvailabilities.slice(0, 1), [moto[0], { ...moto[0], Lat: 1, Lng: 1 }]);
  assert.equal(o[0].Lat, undefined);
});

test("buildAvailability 輸出形狀、以我們的 id 為鍵、略過過舊回報", () => {
  const { data, stats } = buildAvailability({ ours, tdx, moto, now: new Date("2026-11-14T15:55:00Z") });
  assert.equal(data.generated_at, "2026-11-14T23:55:00+08:00");
  assert.equal(data.update_time, UPD);
  assert.match(data.source, /TDX/);
  assert.deepEqual(data.items.a, { avail: 79, total: 290, time: "2026-11-14T23:51:01+08:00" });
  assert.deepEqual(data.items.b, { avail: 47, total: 272, time: "2026-11-14T23:51:01+08:00" });
  assert.equal(data.items.c, undefined);   // TDX 沒有 → 前端繼續用燈號
  assert.equal(data.items.d, undefined);   // 配到了但 DataCollectTime 太舊
  assert.equal(data.count, 2);
  assert.equal(stats.stale, 1);
  assert.equal(data.matched, 3);
  for (const v of Object.values(data.items)) assert.deepEqual(Object.keys(v).sort(), ["avail", "time", "total"]);
});

test("buildAvailability 一個 TDX 停車場不會同時給我們兩筆", () => {
  const twins = [
    { id: "x1", name: "雙胞停車場", district: "南區", lat: 24.12, lng: 120.66, precision: "ROOFTOP" },
    { id: "x2", name: "雙胞停車場", district: "南區", lat: 24.12, lng: 120.66, precision: "ROOFTOP" },
  ];
  const t = { UpdateTime: UPD, ParkingAvailabilities: [row("01P0S0001E", "南區-交通局-雙胞P", {
    Availabilities: [{ SpaceType: 1, NumberOfSpaces: 10, AvailableSpaces: 3 }] })] };
  const { data } = buildAvailability({ ours: twins, tdx: t, moto: [] });
  const ids = Object.keys(data.items);
  assert.ok(ids.length <= 1, "同一個 TDX 停車場被配給 " + ids.length + " 筆");
});

/* ---------- 假 HTTP 層 ---------- */
function fakeFetch({ tokenStatus = 200, dataStatus = 200, data = tdx } = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (url === TOKEN_URL) {
      const b = new URLSearchParams(String(opts.body));
      assert.equal(opts.method, "POST");
      assert.equal(b.get("grant_type"), "client_credentials");
      if (b.get("client_id") !== FAKE_ID || b.get("client_secret") !== FAKE_SECRET) return json(401, { error: "invalid_client" });
      return json(tokenStatus, { access_token: FAKE_TOKEN, token_type: "Bearer", expires_in: 86400 });
    }
    if (url === DATA_URL) {
      if (opts.headers?.authorization !== "Bearer " + FAKE_TOKEN) return json(401, {});
      return json(dataStatus, data);
    }
    if (url === MOTO_URL) return json(200, moto);
    throw new Error("unexpected url " + url);
  };
  fn.calls = calls;
  return fn;
}

function tmpFiles(prev) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdx-test-"));
  const parkingsPath = path.join(dir, "parkings.json");
  const outPath = path.join(dir, "availability.json");
  fs.writeFileSync(parkingsPath, JSON.stringify({ items: ours }));
  if (prev !== undefined) fs.writeFileSync(outPath, prev);
  return { parkingsPath, outPath };
}
const env = { TDX_CLIENT_ID: FAKE_ID, TDX_CLIENT_SECRET: FAKE_SECRET };
const quiet = () => {};

test("getToken 缺環境變數時報錯", async () => {
  await assert.rejects(getToken({ clientId: "", clientSecret: "", fetchImpl: fakeFetch() }), /TDX_CLIENT_ID/);
});

test("run 用 Bearer token 抓資料並寫檔", async () => {
  const f = tmpFiles();
  const fetchImpl = fakeFetch();
  const r = await run({ env, fetchImpl, ...f, minMatched: 1, log: quiet });
  assert.equal(r.changed, true);
  const out = JSON.parse(fs.readFileSync(f.outPath, "utf8"));
  assert.equal(out.items.a.avail, 79);
  assert.ok(fetchImpl.calls.some((c) => c.url === DATA_URL));
  assert.ok(!JSON.stringify(out).includes(FAKE_TOKEN));
  assert.ok(!JSON.stringify(out).includes(FAKE_SECRET));
});

test("run 資料沒變時不重寫（避免空 commit）", async () => {
  const f = tmpFiles();
  await run({ env, fetchImpl: fakeFetch(), ...f, minMatched: 1, log: quiet, now: new Date("2026-11-14T15:55:00Z") });
  const before = fs.readFileSync(f.outPath, "utf8");
  const r = await run({ env, fetchImpl: fakeFetch(), ...f, minMatched: 1, log: quiet, now: new Date("2026-11-14T16:00:00Z") });
  assert.equal(r.changed, false);
  assert.equal(fs.readFileSync(f.outPath, "utf8"), before);
});

for (const [name, opts, re] of [
  ["token 401", { tokenStatus: 401 }, /token HTTP 401/],
  ["資料 500", { dataStatus: 500 }, /HTTP 500/],
  ["資料空陣列", { data: { UpdateTime: UPD, ParkingAvailabilities: [] } }, /沒有資料/],
]) {
  test("run 失敗時不覆蓋原檔：" + name, async () => {
    const good = JSON.stringify({ count: 2, items: { a: { avail: 1, total: 2, time: UPD } } });
    const f = tmpFiles(good);
    await assert.rejects(run({ env, fetchImpl: fakeFetch(opts), ...f, minMatched: 1, log: quiet }), re);
    assert.equal(fs.readFileSync(f.outPath, "utf8"), good);
  });
}

test("run 配對數太少時不覆蓋原檔", async () => {
  const good = JSON.stringify({ count: 200, items: {} });
  const f = tmpFiles(good);
  await assert.rejects(run({ env, fetchImpl: fakeFetch(), ...f, minMatched: 1, log: quiet }), /掉到/);
  await assert.rejects(run({ env, fetchImpl: fakeFetch(), ...tmpFiles(), minMatched: 50, log: quiet }), /下限/);
  assert.equal(fs.readFileSync(f.outPath, "utf8"), good);
});

test("錯誤訊息不含金鑰", async () => {
  const f = tmpFiles();
  try {
    await run({ env: { TDX_CLIENT_ID: FAKE_ID, TDX_CLIENT_SECRET: "wrong-secret" }, fetchImpl: fakeFetch(), ...f, log: quiet });
    assert.fail("應該失敗");
  } catch (e) {
    assert.ok(!e.message.includes("wrong-secret"));
    assert.ok(!e.message.includes(FAKE_ID));
  }
});

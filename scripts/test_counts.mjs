// 離線測試：node --test scripts/test_*.mjs
// availability.js 讀 data/availability.json 的部分（parseCounts / createCounts），
// 以及 bump-asset-version.mjs 的版本字串。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseCounts, createCounts } from "../availability.js";
import { taipeiStamp, applyVersion } from "./bump-asset-version.mjs";

const SHIZHENG = "臺灣大道市政大樓附屬地下停車場|臺中市西屯區臺灣大道、文心路、惠中路";
const STALE = "陽明大樓停車場|臺中市豐原區陽明街 36 號";   // 幾個月前的回報（假資料）
const MAX = 30 * 60000;

// 真實檔案裡那一筆（2026-11-15 00:05 的 avail 143 / total 144）
const fixtureItem = { avail: 143, total: 144, time: "2026-11-15T00:05:01+08:00" };
const fixture = {
  update_time: "2026-11-15T00:06:01+08:00",
  generated_at: "2026-11-15T00:06:53+08:00",
  items: {
    [SHIZHENG]: fixtureItem,
    [STALE]: { avail: 50, total: 100, time: "2026-07-01T10:00:00+08:00" },
  },
};
const at = (s) => Date.parse(s);
const T = at(fixtureItem.time);

test("市政大樓：回報後幾分鐘、00:13 都保留 143 格", () => {
  for (const now of [T + 3 * 60000, at("2026-11-15T00:13:00+08:00"), T + MAX]) {
    const c = parseCounts(fixture, now, MAX).get(SHIZHENG);
    assert.ok(c, "應該有數字 @ " + new Date(now).toISOString());
    assert.equal(c.avail, 143);
    assert.equal(c.total, 144);
    assert.equal(c.time.getTime(), T);
  }
});

test("市政大樓：超過 30 分鐘才不給數字", () => {
  assert.equal(parseCounts(fixture, T + MAX + 1000, MAX).has(SHIZHENG), false);
  assert.equal(parseCounts(fixture, at("2026-11-15T01:00:00+08:00"), MAX).has(SHIZHENG), false);
});

test("幾個月前的回報（陽明大樓）一律不給數字 → 畫面退回燈號", () => {
  assert.equal(parseCounts(fixture, at("2026-11-15T00:13:00+08:00"), MAX).has(STALE), false);
});

test("磁碟上的 data/availability.json：該筆在它自己的回報時間後 8 分鐘仍有數字", () => {
  const url = new URL("../data/availability.json", import.meta.url);
  if (!fs.existsSync(url)) return;   // 尚未產生
  const json = JSON.parse(fs.readFileSync(url, "utf8"));
  const v = json.items[SHIZHENG];
  assert.ok(v, "檔案裡應該有市政大樓這一筆");
  const now = Date.parse(v.time) + 8 * 60000;
  const c = parseCounts(json, now, MAX).get(SHIZHENG);
  assert.ok(c);
  assert.equal(c.avail, v.avail);
  assert.equal(c.total, v.total);
});

test("createCounts：抓檔後 lookup 有 143；時間超過 30 分鐘後 lookup 變 null", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: at("2026-11-15T00:13:00+08:00") });
  const urls = [];
  const counts = createCounts({
    onChange() {},
    fetchImpl: async (u) => { urls.push(u); return { ok: true, status: 200, json: async () => fixture }; },
  });
  await counts.refresh();
  assert.match(urls[0], /^data\/availability\.json\?t=\d+$/);
  const c = counts.lookup(SHIZHENG);
  assert.equal(c.avail, 143);
  assert.equal(c.total, 144);
  assert.equal(counts.lookup(STALE), null);
  assert.equal(counts.size, 1);

  t.mock.timers.setTime(T + MAX + 2 * 60000);   // 沒有新檔，回報已超過 30 分鐘
  assert.equal(counts.lookup(SHIZHENG), null);
  assert.equal(counts.size, 0);
});

test("createCounts().start() 只在啟動時讀一次靜態檔，不排程定時輪詢也不註冊 visibilitychange", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: at("2026-11-15T00:13:00+08:00") });
  const prevDoc = globalThis.document;
  let visListeners = 0;
  globalThis.document = {
    hidden: false,
    addEventListener(ev) { if (ev === "visibilitychange") visListeners++; },
  };
  try {
    const urls = [];
    let changes = 0;
    const counts = createCounts({
      onChange() { changes++; },
      fetchImpl: async (u) => { urls.push(u); return { ok: true, status: 200, json: async () => fixture }; },
    });
    counts.start();
    counts.start();   // 重複呼叫也不會多抓
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(urls.length, 1);
    assert.equal(changes, 1);
    assert.equal(visListeners, 0);

    // 即使經過 10 分鐘，也不會自動重新抓 TDX 檔
    t.mock.timers.tick(10 * 60000);
    await Promise.resolve();
    assert.equal(urls.length, 1);
  } finally {
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
  }
});

test("createCounts().refreshLive 成功時更新數字並觸發 onChange；失敗時保留既有資料", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: at("2026-11-15T00:13:00+08:00") });
  const liveFixture = {
    update_time: "2026-11-15T00:14:00+08:00",
    generated_at: "2026-11-15T00:14:05+08:00",
    cached: false,
    capped: false,
    next_refresh_in_seconds: 90,
    items: {
      [SHIZHENG]: { avail: 88, total: 144, time: "2026-11-15T00:13:50+08:00" },
    },
  };
  const calls = [];
  let mode = "static";
  let changes = 0;
  const counts = createCounts({
    onChange() { changes++; },
    fetchImpl: async (u, opts) => {
      calls.push({ u, opts });
      if (mode === "static") return { ok: true, status: 200, json: async () => fixture };
      if (mode === "live-ok") return { ok: true, status: 200, json: async () => liveFixture };
      if (mode === "live-503") return { ok: false, status: 503, json: async () => ({ error: "TDX credentials not configured", code: "NOT_CONFIGURED" }) };
      if (mode === "live-net") throw new TypeError("fetch failed");
      throw new Error("unexpected mode " + mode);
    },
  });

  // 1. 先讀靜態檔
  await counts.refresh();
  assert.equal(counts.lookup(SHIZHENG).avail, 143);
  assert.equal(changes, 1);

  // 2. 按需即時更新失敗（503）→ 既有資料不動
  mode = "live-503";
  await assert.rejects(
    counts.refreshLive("https://example.supabase.co/functions/v1/tdx-availability", {
      headers: { apikey: "anon", Authorization: "Bearer anon" },
    }),
    (err) => err.status === 503 && err.code === "NOT_CONFIGURED",
  );
  assert.equal(counts.lookup(SHIZHENG).avail, 143);
  assert.equal(changes, 1);

  // 3. 按需即時更新成功 → 更新為 88 並觸發 onChange
  mode = "live-ok";
  const res = await counts.refreshLive("https://example.supabase.co/functions/v1/tdx-availability", {
    headers: { apikey: "anon", Authorization: "Bearer anon" },
  });
  assert.equal(res.next_refresh_in_seconds, 90);
  assert.equal(counts.lookup(SHIZHENG).avail, 88);
  assert.equal(changes, 2);
  assert.equal(calls.at(-1).opts.method, "POST");
  assert.equal(calls.at(-1).opts.headers.apikey, "anon");

  // 4. 網路錯誤 → 仍保留最新資料 88
  mode = "live-net";
  await assert.rejects(
    counts.refreshLive("https://example.supabase.co/functions/v1/tdx-availability"),
    /fetch failed/,
  );
  assert.equal(counts.lookup(SHIZHENG).avail, 88);
  assert.equal(changes, 2);
});

test("bump-asset-version：臺灣時間 14 碼，並改寫所有 ?v=", () => {
  assert.equal(taipeiStamp(new Date("2026-11-14T16:13:05Z")), "20261115001305");
  const html = '<link href="./app.css"><script src="./config.js?v=1"></script><script src="./app.js?v=20260101000000" type="module">';
  const [out, n] = applyVersion(html, ["app.css", "config.js", "app.js"], "20261115001305");
  assert.equal(out, '<link href="./app.css?v=20261115001305"><script src="./config.js?v=20261115001305"></script>' +
    '<script src="./app.js?v=20261115001305" type="module">');
  assert.deepEqual(n, { "app.css": 1, "config.js": 1, "app.js": 1 });
  const js = 'import { a } from "./availability.js";\n// 註解裡的 availability.js 不動';
  assert.equal(applyVersion(js, ["availability.js"], "X")[0],
    'import { a } from "./availability.js?v=X";\n// 註解裡的 availability.js 不動');
});

test("index.html／app.js 的 ?v= 與 ASSET_VERSION 一致", () => {
  const v = fs.readFileSync(new URL("../ASSET_VERSION", import.meta.url), "utf8").trim();
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  for (const a of ["app.css", "config.js", "app.js"]) assert.ok(html.includes(`"./${a}?v=${v}"`), a);
  assert.ok(app.includes(`from "./availability.js?v=${v}"`));
});

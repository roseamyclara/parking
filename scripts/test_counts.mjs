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

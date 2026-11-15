// 離線測試：導航網址的起點規則與距離文字（origin.js）
import test from "node:test";
import assert from "node:assert/strict";
import { navUrl, distLabel } from "../origin.js";

const lot = { name: "府後停車場", lat: 24.1375, lng: 120.6845, precision: "ROOFTOP", address: "臺中市西區府後街" };
const districtLot = { name: "某停車場", lat: 24.1, lng: 120.6, precision: "DISTRICT", address: "臺中市北屯區某路1號" };
const place = { lat: 24.1372, lng: 120.6869, label: "臺中車站", kind: "place" };
const gps = { lat: 24.15, lng: 120.66, label: "我的位置", kind: "gps" };
const BASE = "https://www.google.com/maps/dir/?api=1";

test("搜尋的地點 → origin=lat,lng", () => {
  assert.equal(navUrl(lot, place), BASE + "&origin=24.1372,120.6869&destination=24.1375%2C120.6845");
});

test("GPS 或沒有起點 → 不帶 origin", () => {
  const want = BASE + "&destination=24.1375%2C120.6845";
  assert.equal(navUrl(lot, gps), want);
  assert.equal(navUrl(lot, null), want);
  assert.equal(navUrl(lot), want);
});

test("行政區中心推估的停車場用名稱＋地址當目的地", () => {
  assert.equal(navUrl(districtLot, place),
    BASE + "&origin=24.1372,120.6869&destination=" + encodeURIComponent("某停車場 臺中市北屯區某路1號"));
  assert.ok(!navUrl(districtLot, gps).includes("origin="));
});

test("距離文字", () => {
  assert.equal(distLabel(1.234, place), "距離 臺中車站 1.2 公里");
  assert.equal(distLabel(0.237, place), "距離 臺中車站 237 公尺");
  assert.equal(distLabel(1.234, gps), "距離 1.2 公里");
  assert.equal(distLabel(0.237, gps), "距離 237 公尺");
  assert.equal(distLabel(1.2, null), "");
  assert.equal(distLabel(null, place), "");
});

#!/usr/bin/env node
// 前端靜態檔快取破壞：產生新的版本字串（臺灣時間 YYYYMMDDHHmmss），
// 寫進 parking/ASSET_VERSION，並更新 index.html 與 app.js 裡所有 ?v=。
//
//   node parking/scripts/bump-asset-version.mjs          # 用現在的臺灣時間
//   node parking/scripts/bump-asset-version.mjs --check  # 只檢查是否一致，不改檔（不一致時以非 0 結束）
//
// 改了 index.html／app.js／availability.js／app.css／config.js 要 commit 時執行一次。
// 不要放進每 5 分鐘的 TDX 工作流程（availability.json 自己有 ?t= 每分鐘換一次）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_FILE = path.join(ROOT, "ASSET_VERSION");

// 每個檔案裡要加版本的資源，以及預期出現幾次（少了就報錯，避免默默漏掉）
const TARGETS = {
  "index.html": { "app.css": 1, "config.js": 1, "app.js": 1 },
  "app.js": { "availability.js": 1 },
};

export function taipeiStamp(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Taipei", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return parts.year + parts.month + parts.day + parts.hour + parts.minute + parts.second;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 把 "./asset" 或 "./asset?v=舊" （含引號）換成 "./asset?v=version"；回傳 [新內容, 各資源次數, 舊版本集合] */
export function applyVersion(text, assets, version) {
  const counts = {};
  const seen = new Set();
  let out = text;
  for (const asset of assets) {
    const re = new RegExp("([\"'])\\./" + esc(asset) + "(?:\\?v=([^\"']*))?\\1", "g");
    counts[asset] = 0;
    out = out.replace(re, (_m, q, old) => {
      counts[asset]++;
      seen.add(old ?? "");
      return q + "./" + asset + "?v=" + version + q;
    });
  }
  return [out, counts, seen];
}

function main() {
  const check = process.argv.includes("--check");
  const version = check ? fs.readFileSync(VERSION_FILE, "utf8").trim() : taipeiStamp();
  if (!/^\d{14}$/.test(version)) throw new Error("ASSET_VERSION 格式不對：" + version);
  let ok = true;
  for (const [file, want] of Object.entries(TARGETS)) {
    const p = path.join(ROOT, file);
    const before = fs.readFileSync(p, "utf8");
    const [after, counts, seen] = applyVersion(before, Object.keys(want), version);
    for (const [asset, n] of Object.entries(want)) {
      if (counts[asset] !== n) throw new Error(`${file} 裡 ./${asset} 出現 ${counts[asset]} 次，預期 ${n} 次`);
    }
    if (check) {
      if (after !== before) { ok = false; console.error(`${file}：?v= 與 ASSET_VERSION（${version}）不一致：${[...seen].join(", ")}`); }
    } else if (after !== before) {
      fs.writeFileSync(p, after);
    }
  }
  if (check) {
    if (!ok) process.exit(1);
    console.log("ASSET_VERSION 一致：" + version);
    return;
  }
  fs.writeFileSync(VERSION_FILE, version + "\n");
  console.log("ASSET_VERSION → " + version);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

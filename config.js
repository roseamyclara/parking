/* 臺中市身障免銷單停車場地圖 — 前端設定
 *
 * 這是「瀏覽器端」的 Google Maps JavaScript API 金鑰，會公開在網頁上，
 * 請務必在 Google Cloud Console 設定 HTTP 參照網址限制。
 * 它和 GitHub Actions 裡給 geocode.py 用的 GOOGLE_MAPS_API_KEY secret 是不同的東西，
 * 千萬不要把伺服器端那把金鑰貼到這裡。
 */

// Browser Maps JavaScript API key (already used by other pages in this repo).
// Leave as "" to show a friendly fallback instead of a broken map.
// Restrict in Google Cloud Console to HTTP referrers: https://roseamyclara.github.io/*
window.GOOGLE_MAPS_API_KEY = "AIzaSyC1qbK8BJfV7IZqYf0wxLGQvyDdCt3Pv7E";

// Map ID — required for Advanced Markers. "DEMO_MAP_ID" is Google's public
// placeholder; replace with your own Map ID from Cloud Console if you like.
window.GOOGLE_MAPS_MAP_ID = "DEMO_MAP_ID";

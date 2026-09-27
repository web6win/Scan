// 無瀏覽器層驗證：直接匯入前端 verifyapi.js 的 fetchStats()，打到真實後端 5099，
// 確認前端資料層能正確解析 /api/stats（總量/銷毀/地址數/續掃進度）。
globalThis.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

const { fetchStats, fetchContracts, isEnabled } = await import("file:///C:/Users/usewe/Documents/web6win/scan/Scan/assets/js/verifyapi.js");

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); c ? pass++ : fail++; };

ok(isEnabled(), "isEnabled() 為 true（config 已設 baseUrl=5099）");
const st = await fetchStats();
ok(st !== null, "fetchStats() 回傳非 null");
if (st) {
  ok(typeof st.totalSupplyWei === "string" && st.totalSupplyWei !== "0", `總量非空字串 (${st.totalSupplyWei})`);
  ok(typeof st.burnedWei === "string", `銷毀量為字串 (${st.burnedWei})`);
  ok(typeof st.addressCount === "number" && st.addressCount > 0, `地址數為正整數 (${st.addressCount})`);
  ok(typeof st.lastScannedBlock === "number", `游標為數字 (${st.lastScannedBlock})`);
  ok(typeof st.latestBlock === "number", `鏈頭為數字 (${st.latestBlock})`);
  ok(typeof st.scanning === "boolean", `scanning 為布林 (${st.scanning})`);
  // 一致性：總量 = 地址數 × 平均？不必要；改驗總量與銷毀都是合法大整數
  ok(BigInt(st.totalSupplyWei) > 0n, "總量 > 0");
  ok(BigInt(st.burnedWei) >= 0n, "銷毀量 >= 0");
  console.log("  fetchStats =>", JSON.stringify({ totalSupplyWei: st.totalSupplyWei, burnedWei: st.burnedWei, addressCount: st.addressCount, lastScannedBlock: st.lastScannedBlock, latestBlock: st.latestBlock, scanning: st.scanning }));
}
// 順帶確認合約目錄介面（同層）也能用
const c = await fetchContracts(1, 5);
ok(c !== null && Array.isArray(c.items), `fetchContracts() 回傳 items 陣列 (total=${c && c.total})`);

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);

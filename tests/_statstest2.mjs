// 後端「鏈上統計」端到端驗證（確定性版本）：
//   1) /api/stats 初始為空
//   2) 有界續掃 toBlock=2000：地址集合==獨立掃描、總量==DB地址餘額之和（無重複計數）、銷毀量精確、地址數==DB 筆數
//   3) 斷點續掃 toBlock=3000：同上（驗證 2001..3000 增量接著算，不重複不漏算）
//   4) 游標持久化：DB 中 LastScannedBlock == 3000（程序重啟後能從這裡續掃）
//   5) reset：清表歸零；reset 後再掃 toBlock=2000 結果與步驟2一致（reset→重算可用）
//
// 關於「總量精確比對」：服務與獨立計算都用 eth_getBalance(...,"latest")（當前高度餘額），
// 而本鏈持續出塊，掃描期間驗證人地址餘額會緩慢增長，因此「掃描時快照」與「測試稍後重算的 latest」
// 必然有微小漂移。故總量改採「服務總量 == DB 地址餘額之和」（檢查增量累計無重複，確定性）為主，
// 並以容差交叉比對獨立計算（抓 gross 錯誤）。銷毀量只依賴不可變的區塊資料，可精確比對。
import pg from "file:///c:/Users/usewe/.workbuddy/binaries/node/workspace/node_modules/pg/lib/index.js";
const { Client } = pg;

const API = "http://127.0.0.1:5099";
// 公開倉庫：管理員金鑰一律走環境變數（VERIFY_ADMIN_KEY），不要寫死在這裡
const KEY = process.env.VERIFY_ADMIN_KEY || "";
const RPC = "https://chain.web6.win";
const ZERO = "0x0000000000000000000000000000000000000000";
const TOL = 10n ** 19n; // 10 CNT 容差：容納活鏈漂移（掃描期間驗證人獎勵累積），但遠小於單一遺漏地址（~1582 CNT），足以抓 gross 錯誤

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); c ? pass++ : fail++; };
const absDiff = (a, b) => { const x = BigInt(a), y = BigInt(b); return x > y ? x - y : y - x; };

const rpc = async (method, params) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || [] }) });
  const o = await r.json(); if (o.error) throw new Error(method + ": " + JSON.stringify(o.error)); return o.result;
};
const hexBig = (h) => (h ? BigInt(h) : 0n);
const batch = async (calls) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params }))) });
  const o = await r.json(); return o.map((e) => e.result);
};

// 獨立計算：掃 [from,to]，回傳 { supplyWei, burnedWei, addrs[] }
async function independent(from, to) {
  const addrs = new Set();
  let burned = 0n;
  for (let start = from; start <= to; start += 300) {
    const end = Math.min(start + 299, to);
    const nums = []; for (let n = start; n <= end; n++) nums.push(n);
    const blocks = await batch(nums.map((n) => ({ method: "eth_getBlockByNumber", params: ["0x" + n.toString(16), true] })));
    const recHashes = [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.baseFeePerGas && b.gasUsed) burned += hexBig(b.baseFeePerGas) * hexBig(b.gasUsed);
      if (b.miner) addrs.add(b.miner.toLowerCase());
      for (const tx of (b.transactions || [])) {
        if (typeof tx === "string") continue;
        const f = tx.from?.toLowerCase(), t = tx.to?.toLowerCase(), v = tx.value;
        if (f) addrs.add(f);
        if (t) { addrs.add(t); if (t === ZERO && v) burned += hexBig(v); }
        else if (tx.hash) recHashes.push(tx.hash);
      }
    }
    if (recHashes.length) {
      const receipts = await batch(recHashes.map((h) => ({ method: "eth_getTransactionReceipt", params: [h] })));
      for (const r of receipts) if (r && r.contractAddress && r.contractAddress !== ZERO) addrs.add(r.contractAddress.toLowerCase());
    }
  }
  // 真正計算供應量：對發現的地址抓當前餘額並求和（與服務端邏輯平行，作為交叉驗證）
  const arr = [...addrs];
  let supply = 0n;
  for (let i = 0; i < arr.length; i += 200) {
    const slice = arr.slice(i, i + 200);
    const bals = await batch(slice.map((a) => ({ method: "eth_getBalance", params: [a, "latest"] })));
    for (const b of bals) supply += hexBig(b);
  }
  return { supplyWei: supply.toString(), burnedWei: burned.toString(), addrs: arr };
}

// ---- DB 讀取 ----
// 公開倉庫：連線資訊一律走環境變數（PG_*），不要寫死在這裡
const dbClient = () => new Client({
  host: process.env.PG_HOST || "127.0.0.1",
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE || "besu-scan",
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "",
});
async function dbAddresses() {
  const c = dbClient(); await c.connect();
  const rows = (await c.query("SELECT \"Address\",\"BalanceWei\" FROM address_balances WHERE \"ChainId\"='2520'")).rows;
  await c.end();
  return rows;
}
async function dbCursor() {
  const c = dbClient(); await c.connect();
  const r = await c.query("SELECT \"LastScannedBlock\",\"TotalSupplyWei\",\"BurnedWei\",\"AddressCount\" FROM chain_stats WHERE \"ChainId\"='2520'");
  await c.end();
  return r.rows[0];
}

function setEq(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(a.map((x) => x.toLowerCase()));
  return b.every((x) => s.has(x.toLowerCase()));
}

async function getStats() {
  const r = await fetch(API + "/api/stats?chainId=2520"); return r.json();
}
async function triggerScan(toBlock) {
  const r = await fetch(API + "/api/stats/scan", { method: "POST",
    headers: { "content-type": "application/json", "X-Api-Key": KEY },
    body: JSON.stringify(toBlock == null ? {} : { toBlock }) });
  return r.status;
}
async function postReset() {
  const r = await fetch(API + "/api/stats/reset", { method: "POST", headers: { "X-Api-Key": KEY } });
  return r.status;
}
async function waitScanDone(target) {
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    const s = await getStats();
    if (s.scanning === false && (target == null || s.lastScannedBlock >= target)) return s;
    await new Promise((r) => setTimeout(r, 500));
  }
  return getStats();
}

// 對一段區塊做「斷點續掃 + 斷言」的共用流程
async function verifyScan(label, toBlock, indepFrom, indepTo) {
  const st = await triggerScan(toBlock);
  ok(st === 200, `觸發 scan toBlock=${toBlock} 回 200 (got ${st})`);
  const s = await waitScanDone(toBlock);
  ok(s.lastScannedBlock >= toBlock, `${label} 續掃到 ${toBlock} (scanned=${s.lastScannedBlock})`);

  const rows = await dbAddresses();
  const dbAddrs = rows.map((r) => r.Address);
  const dbSum = rows.reduce((acc, r) => acc + BigInt(r.BalanceWei), 0n);
  const ind = await independent(indepFrom, indepTo);

  ok(setEq(dbAddrs, ind.addrs), `${label} 地址集合一致（db=${dbAddrs.length}, indep=${ind.addrs.length}）`);
  ok(s.totalSupplyWei === dbSum.toString(), `${label} 總量==DB地址餘額之和（無重複計數）(service=${s.totalSupplyWei} vs dbSum=${dbSum})`);
  ok(s.burnedWei === ind.burnedWei, `${label} 銷毀量一致 (service=${s.burnedWei} vs indep=${ind.burnedWei})`);
  ok(s.addressCount === dbAddrs.length, `${label} 地址數==DB筆數 (service=${s.addressCount} vs db=${dbAddrs.length})`);
  ok(absDiff(s.totalSupplyWei, ind.supplyWei) <= TOL, `${label} 總量與獨立計算接近（drift 容差內）(diff=${absDiff(s.totalSupplyWei, ind.supplyWei)})`);
  console.log(`   ${label}: 總量 ${s.totalSupplyWei} wei, 銷毀 ${s.burnedWei} wei, 地址 ${s.addressCount}`);
  return s;
}

(async () => {
  // 1) 初始為空
  let s = await getStats();
  ok(s.totalSupplyWei === "0" && s.burnedWei === "0" && s.addressCount === 0 && s.lastScannedBlock === 0,
    `初始 /api/stats 為空 (supply=${s.totalSupplyWei}, addr=${s.addressCount}, scanned=${s.lastScannedBlock})`);

  // 2) 有界續掃到 2000
  await verifyScan("@2000", 2000, 1, 2000);

  // 3) 斷點續掃到 3000
  await verifyScan("@3000", 3000, 1, 3000);

  // 4) 游標持久化（斷點續掃的關鍵：DB 裡的游標要落在 3000）
  const cur = await dbCursor();
  ok(cur && cur.LastScannedBlock === "3000", `游標持久化於 3000 (db=${cur?.LastScannedBlock})`);

  // 5) reset 清表歸零
  const rs = await postReset();
  ok(rs === 200, `reset 回 200 (got ${rs})`);
  const s2 = await getStats();
  ok(s2.totalSupplyWei === "0" && s2.burnedWei === "0" && s2.addressCount === 0 && s2.lastScannedBlock === 0,
    `reset 後為空 (supply=${s2.totalSupplyWei}, addr=${s2.addressCount}, scanned=${s2.lastScannedBlock})`);
  const rowsAfter = await dbAddresses();
  ok(rowsAfter.length === 0, `reset 後地址表已清空 (count=${rowsAfter.length})`);

  // 6) reset 後再掃 toBlock=2000，結果應與步驟2一致（reset→重算可用）
  await verifyScan("reset→@2000", 2000, 1, 2000);

  console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("ERR", e); process.exit(2); });

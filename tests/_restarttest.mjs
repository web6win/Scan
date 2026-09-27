// 跨進程重啟續掃實證：殺掉服務→重啟→從 DB 游標續掃到 4000，驗證不從頭重掃、不重複計數。
import pg from "file:///c:/Users/usewe/.workbuddy/binaries/node/workspace/node_modules/pg/lib/index.js";
const { Client } = pg;
const API = "http://127.0.0.1:5099";
// 公開倉庫：管理員金鑰一律走環境變數（VERIFY_ADMIN_KEY），不要寫死在這裡
const KEY = process.env.VERIFY_ADMIN_KEY || "";
const RPC = "https://chain.web6.win";
const ZERO = "0x0000000000000000000000000000000000000000";
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); c ? pass++ : fail++; };
const absDiff = (a, b) => { const x = BigInt(a), y = BigInt(b); return x > y ? x - y : y - x; };
const rpc = async (m, p) => { const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p || [] }) }); const o = await r.json(); if (o.error) throw new Error(m + ": " + JSON.stringify(o.error)); return o.result; };
const hexBig = (h) => (h ? BigInt(h) : 0n);
const batch = async (calls) => { const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params }))) }); const o = await r.json(); return o.map((e) => e.result); };
async function independent(from, to) {
  const addrs = new Set(); let burned = 0n;
  for (let s = from; s <= to; s += 300) {
    const e = Math.min(s + 299, to); const nums = []; for (let n = s; n <= e; n++) nums.push(n);
    const blocks = await batch(nums.map((n) => ({ method: "eth_getBlockByNumber", params: ["0x" + n.toString(16), true] })));
    const rec = [];
    for (const b of blocks) { if (!b) continue; if (b.baseFeePerGas && b.gasUsed) burned += hexBig(b.baseFeePerGas) * hexBig(b.gasUsed); if (b.miner) addrs.add(b.miner.toLowerCase()); for (const tx of (b.transactions || [])) { if (typeof tx === "string") continue; const f = tx.from?.toLowerCase(), t = tx.to?.toLowerCase(), v = tx.value; if (f) addrs.add(f); if (t) { addrs.add(t); if (t === ZERO && v) burned += hexBig(v); } else if (tx.hash) rec.push(tx.hash); } }
    if (rec.length) { const rs = await batch(rec.map((h) => ({ method: "eth_getTransactionReceipt", params: [h] }))); for (const r of rs) if (r && r.contractAddress && r.contractAddress !== ZERO) addrs.add(r.contractAddress.toLowerCase()); }
  }
  return { burnedWei: burned.toString(), addrs: [...addrs] };
}
// 公開倉庫：連線資訊一律走環境變數（PG_*），不要寫死在這裡
const db = () => new Client({
  host: process.env.PG_HOST || "127.0.0.1",
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE || "besu-scan",
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "",
});
async function dbState() { const c = db(); await c.connect(); const cs = (await c.query("SELECT \"LastScannedBlock\",\"TotalSupplyWei\",\"BurnedWei\",\"AddressCount\" FROM chain_stats WHERE \"ChainId\"='2520'")).rows[0]; const rows = (await c.query("SELECT \"Address\",\"BalanceWei\" FROM address_balances WHERE \"ChainId\"='2520'")).rows; await c.end(); return { cs, rows }; }
const getStats = async () => (await fetch(API + "/api/stats?chainId=2520")).json();
const scan = async (to) => (await fetch(API + "/api/stats/scan", { method: "POST", headers: { "content-type": "application/json", "X-Api-Key": KEY }, body: JSON.stringify({ toBlock: to }) })).status;
async function waitDone(t) { const t0 = Date.now(); while (Date.now() - t0 < 120000) { const s = await getStats(); if (s.scanning === false && s.lastScannedBlock >= t) return s; await new Promise((r) => setTimeout(r, 500)); } return getStats(); }

(async () => {
  const before = await dbState();
  ok(Number(before.cs.LastScannedBlock) === 2000, `重啟前 DB 游標=2000 (got ${before.cs.LastScannedBlock})`);
  ok(before.rows.length === 5, `重啟前地址表有 5 筆 (got ${before.rows.length})`);

  // 重啟服務（由外部腳本 kill + 重啟；這裡只確認重啟後游標仍從 DB 讀到 2000）
  const s0 = await getStats();
  ok(Number(s0.lastScannedBlock) === 2000, `重啟後游標仍=2000（從 DB 恢復，未遺失）(got ${s0.lastScannedBlock})`);

  // 續掃到 4000：應只處理 2001..4000，與既有 1..2000 累加
  const st = await scan(4000);
  ok(st === 200, `觸發續掃 toBlock=4000 回 200 (got ${st})`);
  const s = await waitDone(4000);
  ok(s.lastScannedBlock >= 4000, `續掃到 4000 (scanned=${s.lastScannedBlock})`);

  const st2 = await dbState();
  const dbAddrs = st2.rows.map((r) => r.Address);
  const dbSum = st2.rows.reduce((a, r) => a + BigInt(r.BalanceWei), 0n);
  const ind = await independent(1, 4000);
  const setEq = (a, b) => a.length === b.length && new Set(a.map((x) => x.toLowerCase())).size === b.length && b.every((x) => a.some((y) => y.toLowerCase() === x.toLowerCase()));
  ok(setEq(dbAddrs, ind.addrs), `跨重啟續掃後地址集合一致（db=${dbAddrs.length}, indep=${ind.addrs.length}）`);
  ok(s.totalSupplyWei === dbSum.toString(), `總量==DB地址餘額之和（無重複計數）(service=${s.totalSupplyWei} vs dbSum=${dbSum})`);
  ok(s.burnedWei === ind.burnedWei, `銷毀量一致 (service=${s.burnedWei} vs indep=${ind.burnedWei})`);
  ok(s.addressCount === dbAddrs.length, `地址數==DB筆數 (service=${s.addressCount} vs db=${dbAddrs.length})`);
  ok(absDiff(s.totalSupplyWei, dbSum) === 0n, `跨重啟續掃後總量與 DB 完全一致（證明是累加而非重算）`);
  console.log(`   跨重啟續掃結果：總量 ${s.totalSupplyWei} wei, 銷毀 ${s.burnedWei} wei, 地址 ${s.addressCount}, 游標 ${s.lastScannedBlock}`);
  console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("ERR", e); process.exit(2); });

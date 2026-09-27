// ===== 網路統計：ETH 總量 + 唯一地址數（用戶數）=====
// 純前端無索引器，作法：分批掃描鏈上區塊，收集 miner / 交易 from,to / 合約建立地址，
// 對這些唯一地址的「當前餘額」求和即為 ETH 總量。
//
// 為什麼「求和當前餘額」是正確的：鏈上轉帳只是把 ETH 在地址間搬動，全體地址餘額總和不變
// （守恒）。所以只要對「目前已知的所有地址」取一次當前餘額求和，得到的就是總量；
// 只有新增地址（或鑄造／銷毀，本聯盟鏈通常沒有）才會改變總量，因此我們在「地址集合有變化時」
// 重新求和即可，平常不重抓。
// 唯一會漏算的是「從未出現在任何區塊裡的休眠創世帳號」——本鏈的供應量幾乎都在驗證人手上
// （驗證人每塊都出現），故影響極小。
//
// 結果依 chainId 快取在 localStorage，支援斷點續掃與「只掃新區塊」的增量更新：
// 第一次跑會掃完全部區塊（一次性的重活，之後快取），之後每次只補掃新長出來的區塊。
import { batch, rpc } from "./api.js";
import { chainIdNum } from "./config.js";
import { hexToNum } from "./utils.js";

const PAGE = 300;                  // 每個批次請求掃描的區塊數
const CONCURRENCY = 3;             // 同時進行的區塊批次請求數
const RESCAN_STALE_MS = 10 * 60 * 1000;
const MAX_RETRY = 3;
const BAL_CHUNK = 100;             // 餘額求和時每批 getBalance 數

let _scanning = false;

function k(cid) { return `web6.stats.${cid}`; }
function load(cid) { try { return JSON.parse(localStorage.getItem(k(cid))); } catch { return null; } }
function save(cid, st) { try { localStorage.setItem(k(cid), JSON.stringify(st)); } catch { /* 容量超限則忽略 */ } }

// 同步讀取快取（首屏即時顯示用）；沒有則 null
export function getCachedStats() {
  const cid = chainIdNum();
  const st = load(cid);
  if (!st) return null;
  return snap(st);
}

function snap(st) {
  return {
    accounts: (st.addresses || []).length,
    totalWei: st.totalWei || "0",
    scannedTo: st.scannedTo == null ? -1 : st.scannedTo,
    latest: st.latest || 0,
    updatedAt: st.updatedAt || 0,
  };
}

// 對一批地址取當前餘額並求和（批次進行，避免大量 RPC）
async function sumBalances(addrs) {
  let total = 0n;
  for (let i = 0; i < addrs.length; i += BAL_CHUNK) {
    const slice = addrs.slice(i, i + BAL_CHUNK);
    const res = await batch(slice.map((a) => ({ method: "eth_getBalance", params: [a, "latest"] })));
    for (const b of res) if (b) total += BigInt(b);
  }
  return total;
}

// 掃描一個區塊區間 [from,to]，回傳此區間出現過的唯一地址集合
async function scanRange(from, to) {
  const nums = [];
  for (let n = from; n <= to; n++) nums.push(n);
  const blocks = await batch(nums.map((n) => ({
    method: "eth_getBlockByNumber", params: ["0x" + n.toString(16), true],
  })));
  const addrs = new Set();
  const txHashes = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.miner) addrs.add(b.miner.toLowerCase());
    const txs = b.transactions || [];
    for (const tx of txs) {
      const from = typeof tx === "string" ? null : tx.from;
      const to = typeof tx === "string" ? null : tx.to;
      const hash = typeof tx === "string" ? tx : tx.hash;
      if (from) addrs.add(from.toLowerCase());
      if (to) addrs.add(to.toLowerCase());
      if (hash) txHashes.push(hash);
    }
  }
  // 合約建立地址在 receipt 的 contractAddress，需另外取
  if (txHashes.length) {
    const receipts = await batch(txHashes.map((h) => ({
      method: "eth_getTransactionReceipt", params: [h],
    })));
    for (const r of receipts) {
      if (r && r.contractAddress) addrs.add(r.contractAddress.toLowerCase());
    }
  }
  return addrs;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function scanRangeWithRetry(from, to) {
  let lastErr;
  for (let i = 0; i < MAX_RETRY; i++) {
    try { return await scanRange(from, to); }
    catch (e) { lastErr = e; await sleep(200 * (i + 1)); }
  }
  console.warn(`stats: 區塊 ${from}-${to} 掃描失敗，略過`, lastErr && lastErr.message);
  return new Set();
}

// 掃描並更新統計；onProgress 回傳快照。已經在掃時直接回傳快取（冪等）。
export async function scanStats({ onProgress, force = false } = {}) {
  const cid = chainIdNum();
  if (_scanning) { onProgress && onProgress(getCachedStats()); return getCachedStats(); }

  const st = load(cid) || { scannedTo: -1, addresses: [], totalWei: "0", latest: 0, updatedAt: 0 };
  const addrs = new Set(st.addresses);

  const latest = hexToNum(await rpc("eth_blockNumber"));
  st.latest = latest;

  // 已掃到最新且未過期 → 不重掃，只更新時間
  if (!force && st.scannedTo >= latest) {
    st.updatedAt = Date.now();
    save(cid, st);
    const s = snap(st);
    onProgress && onProgress(s);
    return s;
  }

  _scanning = true;
  try {
    let cursor = st.scannedTo + 1;
    while (cursor <= latest) {
      const ranges = [];
      for (let c = 0; c < CONCURRENCY && cursor <= latest; c++) {
        const to = Math.min(cursor + PAGE - 1, latest);
        ranges.push([cursor, to]);
        cursor = to + 1;
      }
      const results = await Promise.all(ranges.map(([f, t]) => scanRangeWithRetry(f, t)));
      let grew = false;
      for (const set of results) {
        for (const a of set) if (!addrs.has(a)) { addrs.add(a); grew = true; }
      }
      st.scannedTo = Math.max(...ranges.map(([f, t]) => t));
      st.addresses = [...addrs];
      // 地址集合有變化（或有強制標記）才重新求和；否則總量不變（轉帳守恒）
      if (grew || force) {
        st.totalWei = (await sumBalances([...addrs])).toString();
      }
      st.updatedAt = Date.now();
      save(cid, st);
      onProgress && onProgress(snap(st));
      await sleep(40);
    }
    const s = snap(st);
    onProgress && onProgress(s);
    return s;
  } finally {
    _scanning = false;
  }
}

// wei（十進位字串）→ 人類可讀 ETH，附千分位與原生符號
export function formatEther(weiStr, symbol = "ETH") {
  const wei = BigInt(weiStr || "0");
  if (wei === 0n) return `0 ${symbol}`;
  const intPart = wei / 10n ** 18n;
  const frac = wei % 10n ** 18n;
  const intStr = intPart.toLocaleString("en-US");
  if (frac === 0n) return `${intStr} ${symbol}`;
  const f = frac.toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  return `${intStr}.${f} ${symbol}`;
}

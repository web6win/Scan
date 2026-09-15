// ===== JSON-RPC 客户端（直连联盟链节点，支持批量请求）=====
import { hexToNum } from "./utils.js";
import { setLiveChainId } from "./config.js";

export const RPC_URL = "https://chain.web6.win/";

const _cache = new Map(); // 简单 TTL 缓存
function cacheGet(key, ttl = 3000) {
  const v = _cache.get(key);
  if (v && Date.now() - v.t < ttl) return v.v;
  return undefined;
}
function cacheSet(key, v, ttl = 3000) {
  _cache.set(key, { t: Date.now(), v });
}

// 单个调用
export async function rpc(method, params = [], opts = {}) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "RPC error");
  return data.result;
}

// 批量调用：传入 [{method, params}]，返回结果数组（保持顺序）
export async function batch(calls, opts = {}) {
  if (!calls.length) return [];
  const payload = calls.map((c, i) => ({
    jsonrpc: "2.0", id: i, method: c.method, params: c.params || [],
  }));
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  // 按 id 排序，保证与请求顺序一致
  data.sort((a, b) => a.id - b.id);
  const err = data.find((d) => d.error);
  if (err) throw new Error(err.error.message || "RPC batch error");
  return data.map((d) => d.result);
}

// ===== 區塊快取（本檔最重要的效能機制）=====
// 已經上鏈的區塊是「不可變」的：同一個區塊號問第二次，答案必然一樣
// （QBFT 有終局性，不會像 PoW 那樣深度重組）。所以同一區塊只值得抓一次。
//
// 為什麼關鍵：自動刷新是每 3 秒一次，而「驗證人統計掃 200 塊」＋「交易掃 300 塊」
// 若每次都真的向節點要，等於每個分頁每 ~6 秒送出 500+ 次 method 呼叫
// （實測：12 秒內 1038 次，其中 1016 次是 eth_getBlockByNumber）。
// 幾十個分頁同時開著就會把被監控的節點自己打掛 —— 對瀏覽器來說這是營運級缺陷。
// 有了這層快取，刷新時只有「新產生的那幾個區塊」需要真的走網路。
const _blockCache = new Map();          // "l:123" / "f:123" → block
const TIP_STALE_MS = 4000;              // 最頂端幾塊：可能還在長，短 TTL
const DEEP_STALE_MS = 60 * 60 * 1000;   // 已經在下面 3 塊以上的：不變，長 TTL
const TIP_DEPTH = 3;

// 快取上限用「估算位元組」而不是「筆數」：
// 位址頁會掃到 2000 塊，且要完整交易內文（full=true）。若只按筆數設上限（例如 600），
// 掃描途中就會把自己剛存進去的東西淘汰掉，等於白掃。
// 閒置鏈上每塊只有幾 KB，上限足夠裝下 2000 塊；一旦鏈變忙（每塊上百筆交易），
// 就會提前淘汰，避免長期開著的分頁吃掉上百 MB 記憶體。
const _CACHE_BUDGET = 24 * 1024 * 1024;
let _cacheWeight = 0;
function weigh(b) {
  const ntx = b && Array.isArray(b.transactions) ? b.transactions.length : 0;
  return 420 + ntx * 220;
}
function blockCacheSet(k, b) {
  const old = _blockCache.get(k);
  if (old) _cacheWeight -= old.w;
  const w = weigh(b);
  _blockCache.set(k, { t: Date.now(), b, w });
  _cacheWeight += w;
  while (_cacheWeight > _CACHE_BUDGET && _blockCache.size > 1) {
    const oldest = _blockCache.keys().next().value;
    const victim = _blockCache.get(oldest);
    _blockCache.delete(oldest);
    _cacheWeight -= victim.w;
  }
}

// 取一批區塊（依傳入的區塊號順序回傳）。命中快取的不再向節點要；
// 未命中的合併成「一次」批量請求 —— 往返次數與區塊數無關。
export async function getBlocksByNumbers(numbers, full = false, latest = null) {
  const now = Date.now();
  const out = new Array(numbers.length).fill(null);
  const miss = [];
  numbers.forEach((n, i) => {
    const v = _blockCache.get(full ? "f:" + n : "l:" + n);
    const isTip = latest != null && n > latest - TIP_DEPTH;
    const ttl = isTip ? TIP_STALE_MS : DEEP_STALE_MS;
    if (v && now - v.t < ttl) out[i] = v.b;
    else miss.push(i);
  });
  if (miss.length) {
    const res = await batch(miss.map((i) => ({
      method: "eth_getBlockByNumber", params: ["0x" + numbers[i].toString(16), !!full],
    })));
    miss.forEach((i, k) => {
      const b = res[k];
      if (b) blockCacheSet((full ? "f:" : "l:") + numbers[i], b);
      out[i] = b;
    });
  }
  return out;
}

// 清快取（供測試或「手動刷新」時強制重抓）
export function clearBlockCache() { _blockCache.clear(); _cacheWeight = 0; }

// 快取現況（測試用：確認真的命中、且重量沒有失控）
export function blockCacheStats() { return { size: _blockCache.size, bytes: _cacheWeight }; }

// ===== 高层封装 =====

export async function getChainInfo() {
  const key = "chaininfo";
  const c = cacheGet(key, 4000);
  if (c) return c;
  // 不取 web3_clientVersion：節點客戶端與版本號不對外展示，省一次 RPC。
  const [blockNumber, peerCount, chainId, netVersion, gasPrice] =
    await batch([
      { method: "eth_blockNumber", params: [] },
      { method: "net_peerCount", params: [] },
      { method: "eth_chainId", params: [] },
      { method: "net_version", params: [] },
      { method: "eth_gasPrice", params: [] },
    ]);
  const info = {
    blockNumber: hexToNum(blockNumber),
    peerCount: hexToNum(peerCount),
    chainId: hexToNum(chainId),
    netVersion,
    gasPrice,
  };
  // 讓 config.js 的 chainIdNum() / chainIdHex() 拿到節點的真實值：
  // 錢包加鏈參數必須與此一致，否則錢包會視為不匹配而拒絕。
  setLiveChainId(info.chainId);
  cacheSet(key, info, 4000);
  return info;
}

// 確保 chainId 已是節點實際值（錢包流程在送出前呼叫，避免用到過期的兜底常數）
export async function ensureChainId() {
  return (await getChainInfo()).chainId;
}

export async function getLatestBlockNumber() {
  return hexToNum(await rpc("eth_blockNumber"));
}

// 获取一批区块（从高到低），返回有序数组
export async function getBlocksDesc(startNumber, count) {
  const nums = [];
  for (let i = 0; i < count; i++) {
    const n = startNumber - i;
    if (n < 0) break;
    nums.push(n);
  }
  const blocks = await getBlocksByNumbers(nums, false, startNumber);
  return blocks.filter(Boolean);
}

export async function getBlock(numberOrTag, full = false) {
  return rpc("eth_getBlockByNumber", [
    typeof numberOrTag === "number" ? "0x" + numberOrTag.toString(16) : numberOrTag,
    full,
  ]);
}

export async function getBlockByHash(hash, full = false) {
  return rpc("eth_getBlockByHash", [hash, full]);
}

export async function getTx(hash) {
  return rpc("eth_getTransactionByHash", [hash]);
}

export async function getTxReceipt(hash) {
  return rpc("eth_getTransactionReceipt", [hash]);
}

// 账户
export async function getAccount(addr) {
  const [balance, nonce, code] = await batch([
    { method: "eth_getBalance", params: [addr, "latest"] },
    { method: "eth_getTransactionCount", params: [addr, "latest"] },
    { method: "eth_getCode", params: [addr, "latest"] },
  ]);
  return { balance, nonce: hexToNum(nonce), code, isContract: code && code !== "0x" };
}

// 验证人（QBFT）
export async function getValidators() {
  const key = "validators";
  const c = cacheGet(key, 30000);
  if (c) return c;
  let vals = [];
  try {
    vals = await rpc("qbft_getValidatorsByBlockNumber", ["latest"]);
  } catch {
    try { vals = await rpc("ibft_getValidatorsByBlockNumber", ["latest"]); } catch { vals = []; }
  }
  cacheSet(key, vals, 30000);
  return vals;
}

// 扫描最近若干区块，收集交易（联盟链交易稀少，向后扫描）
// offset 用于分页：跳过前 offset 笔交易
// 注意：memo 必须带 TTL —— 旧版只在 getAddressTransactions 里写、这里只读，
// 等于「永不写入、每 3 秒重扫 300 块」；即使写了，永久 memo 也会让「最新交易」永远停在首次载入的状态。
const _txMemo = new Map();
const TX_MEMO_TTL = 6000;
function txMemoGet(key) {
  const v = _txMemo.get(key);
  if (v && Date.now() - v.t < TX_MEMO_TTL) return v.v;
  return undefined;
}
function txMemoSet(key, v) { _txMemo.set(key, { t: Date.now(), v }); }

export async function getRecentTransactions(limit = 25, maxBlocks = 300, offset = 0) {
  const key = `recent-${limit}-${maxBlocks}-${offset}`;
  const hit = txMemoGet(key);
  if (hit) return hit;
  const latest = await getLatestBlockNumber();
  const txs = [];
  let scanned = 0;
  const BATCH = 250; // 該節點可接受大批量，減少往返次數
  while (txs.length < limit + offset && scanned < maxBlocks) {
    const take = Math.min(BATCH, maxBlocks - scanned);
    const start = latest - scanned;
    const nums = [];
    for (let i = 0; i < take; i++) {
      const n = start - i;
      if (n < 0) break;
      nums.push(n);
    }
    const blocks = await getBlocksByNumbers(nums, true, latest);
    for (const b of blocks) {
      if (!b) continue;
      for (const t of b.transactions || []) {
        txs.push({ ...t, blockNumber: b.number, blockTimestamp: b.timestamp });
        if (txs.length >= limit + offset) break;
      }
    }
    scanned += take;
    if (start - take < 0) break;
  }
  const out = txs.slice(offset, offset + limit);
  txMemoSet(key, out);
  return out;
}

// 扫描最近区块，收集与某地址相关的交易（from / to）
export async function getAddressTransactions(addr, limit = 25, maxBlocks = 800, offset = 0) {
  const a = addr.toLowerCase();
  const mkey = `addr-${a}-${limit}-${maxBlocks}-${offset}`;
  const hit = txMemoGet(mkey);
  if (hit) return hit;
  const latest = await getLatestBlockNumber();
  const txs = [];
  let scanned = 0;
  const BATCH = 250; // 該節點可接受大批量，減少往返次數（地址頁掃 2000 塊由 ~40 次降到 8 次）
  while (txs.length < limit + offset && scanned < maxBlocks) {
    const take = Math.min(BATCH, maxBlocks - scanned);
    const start = latest - scanned;
    const nums = [];
    for (let i = 0; i < take; i++) {
      const n = start - i;
      if (n < 0) break;
      nums.push(n);
    }
    const blocks = await getBlocksByNumbers(nums, true, latest);
    for (const b of blocks) {
      if (!b) continue;
      for (const t of b.transactions || []) {
        const from = (t.from || "").toLowerCase();
        const to = (t.to || "").toLowerCase();
        if (from === a || to === a) {
          txs.push({ ...t, blockNumber: b.number, blockTimestamp: b.timestamp, direction: from === a ? (to === a ? "self" : "out") : "in" });
          if (txs.length >= limit + offset) break;
        }
      }
    }
    scanned += take;
    if (start - take < 0) break;
  }
  const out = txs.slice(offset, offset + limit);
  txMemoSet(mkey, out);
  return out;
}

// 扫描最近区块，统计各验证人出块数
export async function getValidatorStats(recentBlocks = 1000) {
  const latest = await getLatestBlockNumber();
  const n = Math.min(recentBlocks, latest + 1);
  const nums = [];
  for (let i = 0; i < n; i++) nums.push(latest - i);
  const blocks = await getBlocksByNumbers(nums, false, latest);
  const stats = {};
  let totalGas = 0n, totalTime = 0, pairs = 0, lastTs = null;
  for (const b of blocks) {
    if (!b) continue;
    const m = (b.miner || "0x0").toLowerCase();
    stats[m] = (stats[m] || 0) + 1;
    totalGas += BigInt(b.gasUsed || "0x0");
    const ts = parseInt(b.timestamp, 16);
    if (lastTs != null) { totalTime += (lastTs - ts); pairs++; }
    lastTs = ts;
  }
  const avgBlockTime = pairs ? totalTime / pairs : 0;
  return { stats, avgBlockTime, scanned: blocks.filter(Boolean).length };
}

// 搜索路由
export async function search(q) {
  q = (q || "").trim();
  const { isTxHash, isAddress, isBlockNum } = await import("./utils.js");
  if (isTxHash(q)) {
    const tx = await getTx(q);
    if (tx) return { type: "tx", value: q };
  }
  if (isAddress(q)) return { type: "address", value: q.toLowerCase() };
  if (isBlockNum(q)) {
    const num = q.startsWith("0x") ? parseInt(q, 16) : Number(q);
    const b = await getBlock(num, false);
    if (b) return { type: "block", value: num };
  }
  return { type: "notfound", value: q };
}

// ===== 写操作（部署合约 / 发送交易，本地签名后广播）=====
export async function getNonce(addr) {
  return hexToNum(await rpc("eth_getTransactionCount", [addr, "latest"]));
}

export async function estimateGas(tx) {
  return hexToNum(await rpc("eth_estimateGas", [tx]));
}

export async function sendRawTransaction(raw) {
  return rpc("eth_sendRawTransaction", [raw]);
}

// ===== 合约相关 RPC =====

// 事件日志：按 filter 查询（address / topics / fromBlock / toBlock）
export async function getLogs(filter) {
  return rpc("eth_getLogs", [filter]);
}

// 读取存储槽（slotHex 形如 "0x0"）
export async function getStorageAt(addr, slotHex, tag = "latest") {
  return rpc("eth_getStorageAt", [addr, slotHex, tag]);
}

// 批量读取一段连续存储槽
export async function getStorageRange(addr, fromSlot, count, tag = "latest") {
  const calls = [];
  for (let i = 0; i < count; i++) {
    calls.push({ method: "eth_getStorageAt", params: [addr, "0x" + (fromSlot + i).toString(16), tag] });
  }
  return batch(calls);
}

// 合约只读调用（eth_call）
export async function callContract(to, data, tag = "latest") {
  return rpc("eth_call", [{ to, data }, tag]);
}

// 内部交易：Besu / OpenEthereum 的 trace_block（返回该块全部调用轨迹）
export async function traceBlock(n) {
  try {
    return await rpc("trace_block", ["0x" + n.toString(16)]);
  } catch {
    return null; // 节点未启用 trace API 时返回 null
  }
}

// 回推合约部署信息：从最新块向后扫描，找到 to=null 且 receipt.contractAddress == addr 的交易。
// 纯前端无索引服务，这是「尽力而为」的回推；命中后按地址缓存。
const _creationCache = new Map();
export async function getContractCreation(addr, cap = 50000) {
  const a = addr.toLowerCase();
  if (_creationCache.has(a)) return _creationCache.get(a);
  const result = await (async () => {
    const latest = await getLatestBlockNumber();
    const BATCH = 250;
    let scanned = 0;
    while (scanned <= latest && scanned < cap) {
      const take = Math.min(BATCH, latest - scanned + 1, cap - scanned);
      if (take <= 0) break;
      const nums = [];
      for (let i = 0; i < take; i++) nums.push(latest - scanned - i);
      const blocks = await getBlocksByNumbers(nums, true, latest);
      const rcCalls = [];
      const meta = [];
      for (const b of blocks) {
        if (!b) continue;
        for (const tx of b.transactions || []) {
          if (tx.to == null) {
            rcCalls.push({ method: "eth_getTransactionReceipt", params: [tx.hash] });
            meta.push({ tx, num: b.number, ts: b.timestamp });
          }
        }
      }
      if (rcCalls.length) {
        const receipts = await batch(rcCalls);
        for (let k = 0; k < receipts.length; k++) {
          const rc = receipts[k];
          if (rc && (rc.contractAddress || "").toLowerCase() === a) {
            const { tx, num, ts } = meta[k];
            return { deployer: tx.from, tx: tx.hash, block: num, time: ts };
          }
        }
      }
      scanned += take;
    }
    return null;
  })();
  _creationCache.set(a, result);
  return result;
}

// 分塊抓取事件日誌（避免 eth_getLogs 的「range exceeds maximum」限制）。
// 遇錯自動二分收縮區間，直到區塊長度為 1 仍失敗則放棄該段。
async function getLogsChunked(addr, fromBlock, toBlock, topics, chunk = 4000, cap = 30000) {
  const logs = [];
  let from = fromBlock;
  while (from <= toBlock && logs.length < cap) {
    let size = chunk;
    let to = Math.min(from + size - 1, toBlock);
    let done = false;
    while (!done) {
      try {
        const filter = { address: addr, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) };
        if (topics) filter.topics = topics;
        const r = await getLogs(filter);
        if (r && r.length) logs.push(...r);
        done = true;
      } catch (e) {
        if (size <= 1) break; // 單塊仍失敗，放棄
        size = Math.floor(size / 2);
        to = from + size - 1;
      }
    }
    if (to >= toBlock) break;
    from = to + 1;
  }
  return logs;
}

// 合約交易列表（所有以該合約為目標地址的交易）。
// 策略：① 用事件日誌反推所有「發過事件的外部呼叫」的交易哈希（覆蓋全部歷史區塊，代價極低）；
//       ② 再掃描最近 recentScan 個區塊，補抓「無事件 / 失敗」的交易（to==addr）。
// 兩者合併去重後，批量取交易與回執，附上區塊時間戳；結果按 10 秒快取。
const _ctxMemo = new Map();
const CTX_TTL = 10000;
export async function getContractTransactions(addr, limit = 100, recentScan = 800) {
  const a = addr.toLowerCase();
  const key = `ctx-${a}-${limit}-${recentScan}`;
  const hit = _ctxMemo.get(key);
  if (hit && Date.now() - hit.t < CTX_TTL) return hit.v;
  const latest = await getLatestBlockNumber();
  const seen = new Set();
  const hashes = [];
  const add = (h) => { if (h && !seen.has(h)) { seen.add(h); hashes.push(h); } };

  // ① 事件日誌 → 唯一交易哈希
  try {
    const logs = await getLogsChunked(a, 0, latest, null, 4000, 30000);
    for (const l of logs) if (l.address && l.address.toLowerCase() === a) add(l.transactionHash);
  } catch { /* 節點不支援時忽略，僅靠 ② 兜底 */ }

  // ② 近期區塊掃描（抓無事件 / 失敗交易）
  const startN = Math.max(0, latest - recentScan);
  const nums = [];
  for (let n = latest; n >= startN; n--) nums.push(n);
  try {
    const blocks = await getBlocksByNumbers(nums, true, latest);
    for (const b of blocks) {
      if (!b) continue;
      for (const t of b.transactions || []) if ((t.to || "").toLowerCase() === a) add(t.hash);
    }
  } catch { /* 忽略 */ }

  const picks = hashes.slice(0, limit);
  if (!picks.length) { _ctxMemo.set(key, { t: Date.now(), v: [] }); return []; }

  // 批量取交易 + 回執
  const rawTxs = await batch(picks.map((h) => ({ method: "eth_getTransactionByHash", params: [h] })));
  const receipts = await batch(picks.map((h) => ({ method: "eth_getTransactionReceipt", params: [h] })));
  // 區塊時間戳（按唯一區塊號批量取，full=false 減少傳輸）
  const bnSet = new Set();
  rawTxs.forEach((tx) => { if (tx && tx.blockNumber) bnSet.add(parseInt(tx.blockNumber, 16)); });
  const bns = [...bnSet];
  let tsMap = {};
  if (bns.length) {
    const bts = await getBlocksByNumbers(bns, false, latest);
    bns.forEach((n, i) => { if (bts[i]) tsMap[n] = bts[i].timestamp; });
  }
  const out = picks.map((h, i) => {
    const tx = rawTxs[i];
    if (!tx) return null;
    const rc = receipts[i];
    const bn = tx.blockNumber ? parseInt(tx.blockNumber, 16) : null;
    const ok = rc ? parseInt(rc.status, 16) === 1 : null;
    return {
      hash: h,
      from: tx.from,
      to: tx.to,
      input: tx.input,
      value: tx.value,
      blockNumber: bn,
      blockTimestamp: bn != null ? tsMap[bn] : null,
      status: ok,
      gasUsed: rc ? rc.gasUsed : null,
      revertReason: ok === false && rc ? (rc.revertReason || null) : null,
    };
  }).filter(Boolean);
  _ctxMemo.set(key, { t: Date.now(), v: out });
  return out;
}


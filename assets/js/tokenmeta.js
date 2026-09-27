// ===== 通證（Token）標準識別與資料讀取 =====
// 支援 ERC-20 / ERC-721 / ERC-1155 三種標準。之所以要獨立成一個模組：
// 通證列表頁（tokens.html）與合約詳情頁（address.html）都要「這是什麼代幣」的答案，
// 若各寫一份，ERC-1155 這種「沒有 decimals、沒有 totalSupply」的非典型標準遲早會在某一邊漏掉。
//
// 兩個關鍵設計：
//  1. 一次 HTTP 打包多個 eth_call（JSON-RPC batch），並**逐筆容忍失敗**。
//     直接用 api.batch 不行：它遇到任何一筆 revert 就整批丟錯，而 ERC-1155
//     合約沒有 decimals() / totalSupply()，必然 revert —— 每一次都會整包報銷。
//     這裡改寫成「失敗的那筆回傳 null，其他照樣用」的 tolerant batch。
//  2. 標準識別結果長期快取（localStorage）——執行碼不可變，判定一次就永久有效；
//     只有總供應量這種會變的欄位才用短 TTL 重複讀取。
//     沒有這層快取，通證頁每次重整都要對目錄裡每個合約打 8 次 eth_call。
import { RPC_URL } from "./api.js";

// 標準代碼 → 顯示標籤（合約頁標籤與列表欄位共用同一份，避免兩邊寫法不一致）
export const STANDARD_LABEL = { erc20: "ERC-20", erc721: "ERC-721", erc1155: "ERC-1155" };

// ERC-165 interface id：判別標準的正規做法（遠比「試著呼叫 decimals()」可靠）
const IFACE = { erc20: "0x36372b4e", erc721: "0x80ac58cd", erc1155: "0xd9b67a26" };

// 固定 selector：本模組刻意不依賴 ethers（500KB+），手動編碼即可，
// 解碼也只需要處理 bool / uint / string 三種回傳型別。
const SEL = {
  supportsInterface: "0x01ffc9a7",
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
  uri: "0x0e89341c", // ERC-1155 MetadataURI：uri(uint256)
};

// 每個地址固定送出這 8 筆呼叫：3 次 supportsInterface + 4 個 ERC-20 欄位 + uri(0)。
// CALL_KINDS 的順序就是連線出去的順序，CALL_INDEX 是同一套順序的具名索引；
const CALL_KINDS = ["iface1155", "iface721", "iface20", "name", "symbol", "decimals", "totalSupply", "uri"];
const CALL_INDEX = { iface1155: 0, iface721: 1, iface20: 2, name: 3, symbol: 4, decimals: 5, totalSupply: 6, uri: 7 };
// 兩者必須對齊，否則解碼會全部錯位（而且不會報錯，只會悄悄變成 null）。
// 這裡用 console.error 而不是 throw：這是寫程式時的自保裝置，
// 不該因為一個常數筆誤就把整頁 JS 打死。
const CALLS_PER_ADDR = CALL_KINDS.length;
if (Object.keys(CALL_INDEX).length !== CALLS_PER_ADDR) {
  console.error("[tokenmeta] CALL_INDEX 與 CALL_KINDS 長度不符，代幣識別結果將全部錯位");
}

// ABI 編碼：bytes4 是靜態型別，值佔用 word 的**前** 4 bytes（靠左），剩下補 0。
// 用 padStart 會把 interface id 推到右邊，等於傳了 0x00000000 → supportsInterface
// 永遠回 false，也就永遠偵測不到任何代幣標準（這個坑 debug 起來很安靜）。
function padWord(hexNo0x) { return String(hexNo0x).replace(/^0x/, "").padEnd(64, "0"); }

function callDataFor(addr, kind) {
  switch (kind) {
    case "iface1155": return { to: addr, data: SEL.supportsInterface + padWord(IFACE.erc1155) };
    case "iface721": return { to: addr, data: SEL.supportsInterface + padWord(IFACE.erc721) };
    case "iface20": return { to: addr, data: SEL.supportsInterface + padWord(IFACE.erc20) };
    case "uri": return { to: addr, data: SEL.uri + "0".repeat(64) }; // uri(0)
    default: return { to: addr, data: SEL[kind] };
  }
}

// ---------- eth_call 批量請求（容忍單筆失敗）----------
async function multiCall(calls, timeoutMs = 12000) {
  if (!calls.length) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(calls.map((c, i) => ({
        jsonrpc: "2.0", id: i, method: "eth_call", params: [{ to: c.to, data: c.data }, "latest"],
      }))),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    // 節點異常時可能回單一物件（例如整包錯誤），統一轉成陣列處理
    const arr = Array.isArray(data) ? data : [data];
    const out = new Array(calls.length).fill(null);
    for (const r of arr) {
      const i = Number(r && r.id);
      if (!Number.isInteger(i) || i < 0 || i >= calls.length) continue;
      // revert / 執行失敗 → null，等同「這筆讀不到」，不影響同批其他呼叫
      out[i] = r && !r.error && typeof r.result === "string" && r.result.length > 2 ? r.result : null;
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- ABI 解碼（只需要三種回傳型別）----------
function wordAt(hex, i) {
  if (!hex || hex === "0x") return null;
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const s = i * 64;
  if (h.length < s + 64) return null;
  return h.slice(s, s + 64);
}
function decBool(hex) {
  const w = wordAt(hex, 0);
  if (!w) return null;
  return BigInt("0x" + w) !== 0n;
}
function decUint(hex) {
  const w = wordAt(hex, 0);
  if (!w) return null;
  try { return BigInt("0x" + w); } catch { return null; }
}
function decString(hex) {
  try {
    const h = (hex || "").startsWith("0x") ? hex.slice(2) : hex || "";
    // ABI string：32 bytes offset + 32 bytes 長度 + 資料本體
    if (h.length < 128) return null;
    const len = parseInt(h.slice(64, 128), 16);
    if (!Number.isFinite(len) || len <= 0) return null;
    const bytes = h.slice(128, 128 + len * 2);
    if (bytes.length < len * 2) return null;
    const arr = [];
    for (let i = 0; i < bytes.length; i += 2) arr.push(parseInt(bytes.substr(i, 2), 16));
    const s = new TextDecoder().decode(new Uint8Array(arr));
    return s.trim() || null;
  } catch { return null; }
}

// ---------- 標準判定 ----------
// priority：ERC-165 宣告優先；都沒宣告（老式 ERC-20 沒實作 ERC-165）
// 才退回「有 name/symbol 且讀得到 decimals 或 totalSupply」的經驗法則。
// featured=true 的手動精選放寬到「只要有 name 或 symbol」，維持舊行為以免精選清單漏列。
function pickStandard(v, featured) {
  if (v.iface1155 === true) return "erc1155";
  if (v.iface721 === true) return "erc721";
  if (v.iface20 === true) return "erc20";
  const named = !!(v.name || v.symbol);
  if (!named) return null;
  if (featured) return "erc20";
  return (v.decimals != null || v.totalSupply != null) ? "erc20" : null;
}

// ---------- 標準快取（長期，localStorage）----------
// 「不是代幣」也是結論，一樣要記住 —— 否則每次重整都得把整個合約目錄重掃一遍。
const STD_KEY = "web6.tokstd.";
const STD_TTL = 24 * 60 * 60 * 1000;
const _stdMem = new Map();

// 存 { v, t } 而不是純字串：要能辨識「多久以前判定的」，才有 TTL 可言
//（否則一個開了三天的分頁會永遠拿著兩天前的結論）。
export function cachedStandard(addr) {
  const k = String(addr).toLowerCase();
  const read = (entry) => {
    if (!entry) return undefined;
    if (Date.now() - entry.t > STD_TTL) return undefined; // 過期視同沒探測過
    return entry.v;
  };
  const mem = read(_stdMem.get(k));
  if (mem !== undefined) return mem;

  let raw = null;
  try { raw = localStorage.getItem(STD_KEY + k); } catch { /* 私密模式：只用記憶體快取 */ }
  let parsed = null;
  if (raw) { try { parsed = JSON.parse(raw); } catch { parsed = null; } }
  // 舊版格式（裸字串）相容：升級前的資料直接沿用
  const legacy = parsed == null && raw ? (raw === "-" ? null : raw) : undefined;
  if (legacy !== undefined) { _stdMem.set(k, { v: legacy, t: Date.now() }); return legacy; }
  const v = read(parsed);
  if (v !== undefined) _stdMem.set(k, { v, t: Date.now() });
  return v;
}
function rememberStandard(addr, std) {
  const k = String(addr).toLowerCase();
  const entry = { v: std, t: Date.now() };
  _stdMem.set(k, entry);
  try { localStorage.setItem(STD_KEY + k, JSON.stringify(entry)); } catch { /* 寫不進去不影響本次結果 */ }
}

// ---------- 資料讀取 ----------
// 一次 HTTP 打包所有 eth_call（每地址 8 筆）。N 個地址也只有 1 次往返，
// 這是讓「掃整個合約目錄」在前端負擔得起的前提。
function buildCalls(addrs) {
  const calls = [];
  for (const a of addrs) for (const k of CALL_KINDS) calls.push(callDataFor(a, k));
  return calls;
}

function shape(addr, results, featured) {
  const i = CALL_INDEX;
  const raw = {
    iface1155: decBool(results[i.iface1155]),
    iface721: decBool(results[i.iface721]),
    iface20: decBool(results[i.iface20]),
    name: decString(results[i.name]),
    symbol: decString(results[i.symbol]),
    decimals: decUint(results[i.decimals]),
    totalSupply: decUint(results[i.totalSupply]),
    uri: decString(results[i.uri]),
  };
  const standard = pickStandard(raw, featured);
  if (!standard) {
    // 不是代幣也要回傳一份「已知如此」的資料，呼叫端才知道可以長期不再探測
    return { address: addr, standard: null, name: raw.name, symbol: raw.symbol, decimals: null, totalSupply: null, uri: null, ok: true };
  }
  const is20 = standard === "erc20";
  return {
    address: addr,
    standard,
    name: raw.name,
    symbol: raw.symbol,
    // 精度只有 ERC-20 有定義；1155/721 就算合約剛好有同名函數也不該顯示
    decimals: is20 ? (raw.decimals != null ? Number(raw.decimals) : 18) : null,
    // ERC-1155 標準本身沒有 totalSupply()，但若用了 Supply 擴充套件就讀得到，照實顯示
    totalSupply: raw.totalSupply,
    uri: standard === "erc1155" ? raw.uri : null,
    ok: true,
  };
}

// 元資料短期快取：名稱 / 精度不變，但總供應量會動，留住 60 秒省掉重整時的整批請求。
const _metaCache = new Map();
const META_TTL = 60000;

/**
 * 讀取一組地址的代幣資料（含標準識別）。回傳陣列，順序與輸入相同。
 * @param {string[]} addrs
 * @param {{featured?: Set<string>}} [opts] featured：手動精選的地址集合，判定條件較寬
 */
export async function readTokenMetas(addrs, opts = {}) {
  const featured = opts.featured || new Set();
  const list = (addrs || []).map((x) => (x == null ? "" : String(x)));
  const out = new Array(list.length).fill(null);
  const missIdx = [];
  list.forEach((a, i) => {
    // 站位保底：即便傳進來的是空值 / 壞值，也要在原位留一筆「探測失敗」，
    // 讓回傳陣列永遠與輸入等長對齊（呼叫端拿 index 對應才不會錯位）。
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) {
      out[i] = { address: a, standard: null, name: null, symbol: null, decimals: null, totalSupply: null, uri: null, ok: false };
      return;
    }
    const hit = _metaCache.get(a.toLowerCase());
    if (hit && Date.now() - hit.t < META_TTL) out[i] = hit.meta;
    else missIdx.push(i);
  });
  if (!missIdx.length) return out;

  // 每批最多 20 個地址（=160 筆呼叫）：節點對單次 batch 的大小有上限，
  // 一次塞整份目錄（上千筆）會被直接拒絕；分批後失敗的影響範圍也小。
  const CHUNK = 20;
  const CONCURRENCY = 3;
  const chunks = [];
  for (let s = 0; s < missIdx.length; s += CHUNK) chunks.push(missIdx.slice(s, s + CHUNK));

  let cursor = 0;
  const worker = async () => {
    while (cursor < chunks.length) {
      const idxs = chunks[cursor++];
      const group = idxs.map((i) => list[i]);
      const results = await multiCall(buildCalls(group)).catch(() => null);
      if (!results) {
        // 整包失敗（節點掛了 / 逾時）：這一組標記為「探測失敗」，
        // 不寫入標準快取 —— 網路問題不能被記成「這不是代幣」。
        idxs.forEach((i) => { out[i] = { address: list[i], standard: null, name: null, symbol: null, decimals: null, totalSupply: null, uri: null, ok: false }; });
        continue;
      }
      idxs.forEach((i, n) => {
        const meta = shape(list[i], results.slice(n * CALLS_PER_ADDR, (n + 1) * CALLS_PER_ADDR), featured.has(String(list[i]).toLowerCase()));
        if (meta.ok) {
          rememberStandard(list[i], meta.standard);
          _metaCache.set(String(list[i]).toLowerCase(), { t: Date.now(), meta });
        }
        out[i] = meta;
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  return out.map((m, i) => m || { address: list[i], standard: null, name: null, symbol: null, decimals: null, totalSupply: null, uri: null, ok: false });
}

// 清空本模組的記憶體快取（標準 + 元資料）。
// 用途：使用者主動重整 / 鏈重置後同一地址換了別份合約，不想拿著舊結論。
// localStorage 那份留著不管：跨分頁共享才是它被寫下去的理由，
// 真要重來請用瀏覽器的清除儲存空間。
export function clearTokenCaches() {
  _stdMem.clear();
  _metaCache.clear();
}

// 單筆版（合約詳情頁用）
export async function readTokenMeta(addr, opts = {}) {
  const [m] = await readTokenMetas([addr], opts);
  return m || null;
}

// 只問「是哪一種標準」，給需要快速判斷但又不想付一次完整讀取成本的地方用。
// 有長期快取時幾乎是零成本。
export async function detectStandard(addr) {
  const c = cachedStandard(String(addr).toLowerCase());
  if (c !== undefined) return c;
  const m = await readTokenMeta(addr);
  return m && m.ok ? m.standard : null;
}

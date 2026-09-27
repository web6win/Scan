// ===== Solidity 依賴庫自動解析（@openzeppelin / @chainlink / solmate …）=====
//
// 目的：使用者只要在 .sol 裡寫
//     import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
// 就不必自己上傳整套 OpenZeppelin 原始碼 —— 這裡會從 npm CDN 把整棵依賴樹
// 遞迴抓回來，丟給 solc 一起編譯。
//
// 路徑規則（實測 npm 包佈局，3.x / 4.x / 5.x 都成立）：
//   "@openzeppelin/contracts/token/ERC20/ERC20.sol"
//     └─ 套件名 ─┘ └─────── 套件內路徑 ──────┘
//   → https://cdn.jsdelivr.net/npm/@openzeppelin/contracts@<版本>/token/ERC20/ERC20.sol
//
// ⚠️ OpenZeppelin 的 npm 包是「扁平」佈局：套件根目錄本身就是 contracts 目錄，
//    所以 **不要再補一層 contracts/**（補了會 404）。這點和 GitHub 倉庫的目錄結構不同。
//
// 本模組是純邏輯：不碰 DOM、不吃 i18n、不 import 其他專案模組，
// 所以 Node 可以直接 import 來跑測試（見 _sollibs_test.mjs）。

/**
 * 已知套件。
 *   versions —— 離線備援清單（抓不到 npm 版本清單時還有得選）
 *   pick     —— 沒有版本清單時，依 pragma 下界挑預設版本
 *   range    —— 該版本要求的 solc 區間 {min, max}，max 為「不含」（如 OZ 3.x 的 <0.8.0）。
 *               ⚠️ 這些數字是實測各版本 .sol 的 pragma 來的，不是猜的；
 *                  抓不到 / 沒實測過的一律回傳 null（不顯示提示，勝過顯示錯的）。
 */
const ozRange = (v) => {
  if (cmpVer(v, "5.0.0") >= 0) return { min: "0.8.20" };                 // ^0.8.20
  if (cmpVer(v, "4.0.0") >= 0) return { min: "0.8.0" };                  // ^0.8.0
  if (cmpVer(v, "3.0.0") >= 0) return { min: "0.6.0", max: "0.8.0" };    // >=0.6.0 <0.8.0
  if (cmpVer(v, "2.0.0") >= 0) return { min: "0.5.0", max: "0.6.0" };    // ^0.5.0
  return null;
};

export const LIBS = [
  {
    pkg: "@openzeppelin/contracts",
    label: "OpenZeppelin Contracts",
    versions: ["5.6.1", "5.0.2", "4.9.6", "3.4.2"],
    pick: (v) => (cmpVer(v, "0.8.20") >= 0 ? "5.6.1" : cmpVer(v, "0.8.0") >= 0 ? "4.9.6" : "3.4.2"),
    range: ozRange,
  },
  {
    pkg: "@openzeppelin/contracts-upgradeable",
    label: "OpenZeppelin Upgradeable",
    versions: ["5.6.1", "5.0.2", "4.9.6", "3.4.2"],
    pick: (v) => (cmpVer(v, "0.8.20") >= 0 ? "5.6.1" : cmpVer(v, "0.8.0") >= 0 ? "4.9.6" : "3.4.2"),
    range: ozRange,
  },
  {
    pkg: "@chainlink/contracts",
    label: "Chainlink Contracts",
    versions: ["1.5.0", "1.3.0", "0.8.0"],
    pick: (v) => (cmpVer(v, "0.8.0") >= 0 ? "1.5.0" : "0.8.0"),
    range: (v) => (cmpVer(v, "1.0.0") >= 0 ? { min: "0.8.0" } : null),
  },
  {
    pkg: "solmate",
    label: "Solmate",
    versions: ["6.8.0"],
    pick: () => "6.8.0",
    range: () => ({ min: "0.8.0" }),                                     // >=0.8.0
  },
  {
    pkg: "@uniswap/v2-core",
    label: "Uniswap V2 Core",
    versions: ["1.0.1"],
    pick: () => "1.0.1",
    range: () => ({ min: "0.5.16", max: "0.5.17" }),                     // =0.5.16
  },
  {
    // 沒實測到 pragma（抓不到檔案），所以不給區間，免得顯示錯的提示
    pkg: "@uniswap/v3-core",
    label: "Uniswap V3 Core",
    versions: ["1.0.1"],
    pick: () => "1.0.1",
    range: null,
  },
  {
    pkg: "@prb/math",
    label: "PRB Math",
    versions: ["4.2.0"],
    pick: () => "4.2.0",
    range: (v) => (cmpVer(v, "4.0.0") >= 0 ? { min: "0.8.19" } : cmpVer(v, "3.0.0") >= 0 ? { min: "0.8.13" } : null),
  },
  {
    pkg: "forge-std",
    label: "Forge Std",
    versions: ["1.1.2"],
    pick: () => "1.1.2",
    range: null,
  },
  {
    pkg: "@openzeppelin/contracts-v4",
    label: "OpenZeppelin Contracts v4 (legacy)",
    versions: ["4.9.6"],
    pick: () => "4.9.6",
    range: () => ({ min: "0.8.0" }),
  },
];

export const LIB_BY_PKG = new Map(LIBS.map((l) => [l.pkg, l]));

const CDN = (pkg, ver, rest) =>
  `https://cdn.jsdelivr.net/npm/${pkg}${ver && ver !== "latest" ? `@${ver}` : ""}/${rest}`;

// 未知套件時，套件根目錄不一定等於 import 的根，依序試這幾個前綴
const FALLBACK_PREFIXES = ["", "contracts/", "src/", "lib/"];

// ---------- 小工具 ----------

/** 版本號比較（補零對齊，避免 "0.8.9" > "0.8.30" 的字串比較陷阱） */
export function cmpVer(a, b) {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 取出原始碼裡所有 import 的路徑（涵蓋 import "x" / import {A} from "x" / import * as B from "x"） */
export function parseImports(src) {
  const out = [];
  const re = /import\s+(?:[^;]*?\bfrom\s+)?["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(String(src || "")))) {
    const p = m[1];
    if (p) out.push(p);
  }
  return out;
}

/**
 * 抓出 pragma solidity 的「下界版本」。
 * ^0.8.20 → 0.8.20；>=0.8.0 <0.9.0 → 0.8.0；0.8.20 → 0.8.20
 * 用下界挑 OZ 版本比用 solc 版本準（使用者可能用 solc 0.8.37 但 pragma 只寫 ^0.8.0）。
 */
export function detectPragma(src) {
  const m = /pragma\s+solidity\s+([^;]+);/.exec(String(src || ""));
  if (!m) return null;
  const expr = m[1];
  const hit = /\^\s*(\d+\.\d+(?:\.\d+)?)/.exec(expr)     // ^0.8.20
    || /=\s*(\d+\.\d+(?:\.\d+)?)/.exec(expr)             // >=0.8.0  (>= 的等號)
    || /(\d+\.\d+(?:\.\d+)?)/.exec(expr);                // 0.8.20 或其它寫法的第一個版本
  return hit ? hit[1] : null;
}

/** 拆成「套件名 + 套件內路徑」；不是裸套件路徑就回傳 null */
export function splitPkg(spec) {
  const s = String(spec || "").trim();
  if (!s || s.startsWith(".") || s.startsWith("/")) return null;
  const parts = s.split("/").filter(Boolean);
  if (s.startsWith("@")) {
    if (parts.length < 3) return null;   // 至少要 @scope/name/file.sol
    return { pkg: `${parts[0]}/${parts[1]}`, rest: parts.slice(2).join("/") };
  }
  if (parts.length < 2) return null;
  return { pkg: parts[0], rest: parts.slice(1).join("/") };
}

/** 相對路徑 join（"a/b/C.sol" + "../../d/E.sol" → "d/E.sol"） */
export function joinPath(base, rel) {
  const b = String(base || "");
  const dir = b.includes("/") ? b.slice(0, b.lastIndexOf("/")) : "";
  const parts = dir ? dir.split("/") : [];
  for (const seg of String(rel || "").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join("/");
}

const isRelative = (spec) => /^\.\.?\//.test(String(spec || ""));

/** 把 import 原文換成統一的 key（相對 → 相對於引用者的絕對路徑；裸套件 → 原樣） */
function absolutize(spec, fromKey) {
  const s = String(spec || "").trim();
  if (!s) return null;
  // Windows 上傳的檔案可能出現反斜線，統一成正斜線
  return isRelative(s) ? joinPath(fromKey, s.replace(/\\/g, "/")) : s.replace(/\\/g, "/");
}

/** 依檔名在既有檔案表裡找（上傳時只保留了檔名，沒有目錄結構） */
function findByBasename(files, key) {
  if (files.has(key)) return key;
  const base = String(key).replace(/^.*\//, "");
  for (const k of files.keys()) {
    if (k === base || k.endsWith("/" + base)) return k;
  }
  return null;
}

// ---------- 快取（記憶體 + localStorage）----------
const _mem = new Map();                 // url -> source
const LS_PREFIX = "web6.sollib.";
const LS_INDEX = "web6.sollib.index";   // url -> { ts, size }
const LS_MAX_BYTES = 2 * 1024 * 1024;   // 別把 localStorage 5MB 撐爆

function lsGet(key) {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch { return null; }
}
function lsSet(key, val) {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(key, val);
    return true;
  } catch { return false; }
}
function lsIndex() {
  try { return JSON.parse(lsGet(LS_INDEX) || "{}"); } catch { return {}; }
}
/** 寫入並在超量時淘汰最舊的（簡單 LRU，依賴樹小，不需要精確） */
function cachePut(url, src) {
  _mem.set(url, src);
  if (src.length > 200000) return;         // 單檔太大不進 localStorage
  const idx = lsIndex();
  if (!idx[url]) {
    idx[url] = { ts: Date.now(), size: src.length };
    let total = Object.values(idx).reduce((a, b) => a + (b.size || 0), 0);
    while (total > LS_MAX_BYTES) {
      const oldest = Object.entries(idx).sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0))[0];
      if (!oldest) break;
      try { localStorage.removeItem(LS_PREFIX + oldest[0]); } catch { /* 忽略 */ }
      total -= oldest[1].size || 0;
      delete idx[oldest[0]];
    }
    lsSet(LS_INDEX, JSON.stringify(idx));
  }
  lsSet(LS_PREFIX + url, src);
}
function cacheGet(url) {
  if (_mem.has(url)) return _mem.get(url);
  const v = lsGet(LS_PREFIX + url);
  if (v != null) { _mem.set(url, v); return v; }
  return null;
}
/** 清掉所有快取的原始碼（UI 的「清除快取」或測試用） */
export function clearLibCache() {
  _mem.clear();
  try {
    if (typeof localStorage === "undefined") return 0;
    const idx = lsIndex();
    for (const url of Object.keys(idx)) localStorage.removeItem(LS_PREFIX + url);
    localStorage.removeItem(LS_INDEX);
    return Object.keys(idx).length;
  } catch { return 0; }
}

async function defaultFetch(url) {
  const r = await fetch(url, { cache: "force-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

/** 併發控制（不引外部套件，自己寫一個小的） */
async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const cur = i++;
      out[cur] = await fn(items[cur], cur);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 從一批原始碼裡推出「用哪個版本挑套件」的參考版本：
 * 使用者自己寫的 pragma 優先（比 solc 版本貼近意圖），取所有檔案裡最高的下界。
 */
export function detectRefVersion(files, solcVersion = "") {
  let pragmaV = null;
  for (const src of (files instanceof Map ? files.values() : Object.values(files || {}))) {
    const p = detectPragma(src);
    if (p && (!pragmaV || cmpVer(p, pragmaV) > 0)) pragmaV = p;
  }
  return pragmaV || solcVersion || "0.8.20";
}

/** 某個套件會用哪個版本（考慮手動覆蓋；有版本清單時優先用清單挑） */
export function chooseVersion(pkg, refV, overrides = {}, versions = null, latest = null) {
  if (overrides[pkg]) return overrides[pkg];
  if (versions && versions.length) return pickVersion(pkg, refV, versions, latest);
  const lib = LIB_BY_PKG.get(pkg);
  return lib ? lib.pick(refV) : "latest";
}

// ---------- npm 版本清單 ----------
//
// 內建清單只有三、四個版本，使用者想選別的就沒得選。這裡去問 npm 實際發行過哪些版本，
// 讓下拉框列出真實版本（過濾掉 -rc / -beta 這類預發布）。
// 兩個來源都開了 CORS（Access-Control-Allow-Origin: *），先走 jsdelivr、失敗退 registry.npmjs.org。

const VER_TTL = 6 * 60 * 60 * 1000;      // 版本清單 6 小時內視為新鮮
const LS_VER = "web6.sollibver.";        // localStorage 前綴（與原始碼快取分開）
const _verMem = new Map();               // pkg -> { ts, versions, latest }

/** 從 jsdelivr / npm registry 的回應裡取出版本陣列（兩種形狀都吃） */
export function parseVersionList(json) {
  if (!json || !json.versions) return [];
  if (Array.isArray(json.versions)) {
    return json.versions.map((v) => (typeof v === "string" ? v : v && v.version)).filter(Boolean);
  }
  if (typeof json.versions === "object") return Object.keys(json.versions);
  return [];
}

/** 正式版（排除 5.7.0-rc.0 / 2.0.0-beta.0 這類預發布） */
export function isStableVersion(v) {
  return /^\d+\.\d+(\.\d+)?$/.test(String(v || "").trim());
}

function readVerCache(pkg) {
  const raw = lsGet(LS_VER + pkg);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j && j.versions) ? j : null;
  } catch { return null; }
}
function writeVerCache(pkg, rec) {
  if (typeof localStorage === "undefined") return;
  try { lsSet(LS_VER + pkg, JSON.stringify(rec)); } catch { /* 空間不足就算了 */ }
}

async function defaultFetchJson(url) {
  const r = await fetch(url, {
    headers: { Accept: "application/json, application/vnd.npm.install-v1+json" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

/**
 * 取得套件發行過的版本（新到舊）
 * @returns {Promise<{pkg:string, versions:string[], latest:string|null, ok:boolean, error:string|null, cached?:boolean}>}
 *          失敗時 versions 回傳內建清單（離線備援），ok=false 但不會丟例外——
 *          版本清單抓不到不該擋住整条編譯流程。
 */
export async function fetchVersions(pkg, { fetchFn, ttl = VER_TTL, max = 300 } = {}) {
  const now = Date.now();
  const hit = _verMem.get(pkg) || readVerCache(pkg);
  if (hit && now - (hit.ts || 0) < ttl && Array.isArray(hit.versions)) {
    return { pkg, versions: hit.versions, latest: hit.latest || null, ok: true, error: null, cached: true };
  }

  const doFetch = fetchFn || defaultFetchJson;
  let versions = [];
  let latest = null;
  let error = null;

  const sources = [
    `https://data.jsdelivr.com/v1/packages/npm/${pkg}`,
    `https://registry.npmjs.org/${pkg}`,
  ];
  // 「套件不存在」時不要再去問第二個來源：registry.npmjs.org 對不存在的套件
  // 回的 404 **沒有 CORS 頭**，瀏覽器會噴一條阻擋訊息（功能沒壞，但 console 很吵）。
  // jsdelivr 的 404 有 CORS，所以只要它明確回 404 就沒必要再試。
  let skipFallback = false;
  for (const url of sources) {
    if (skipFallback) break;
    try {
      const json = JSON.parse(await doFetch(url));
      const list = parseVersionList(json);
      if (list.length) {
        versions = list;
        latest = (json.tags && json.tags.latest) || (json["dist-tags"] && json["dist-tags"].latest) || null;
        break;
      }
      error = "empty";
      skipFallback = true;      // 回了東西卻沒有版本 → 套件不存在
    } catch (e) {
      error = String((e && e.message) || e);
      if (/404/.test(error)) skipFallback = true;
    }
  }

  // 過濾預發布 → 由新到舊
  const stable = [...new Set(versions.filter(isStableVersion))]
    .sort((a, b) => cmpVer(b, a))
    .slice(0, max);

  const lib = LIB_BY_PKG.get(pkg);
  if (!stable.length) {
    // 抓不到就用內建清單頂著，UI 仍能選、仍能編譯
    const fallback = lib ? [...lib.versions].sort((a, b) => cmpVer(b, a)) : [];
    return { pkg, versions: fallback, latest: null, ok: false, error: error || "unavailable" };
  }

  const rec = { ts: now, versions: stable, latest };
  _verMem.set(pkg, rec);
  writeVerCache(pkg, rec);
  return { pkg, versions: stable, latest, ok: true, error: null };
}

/** 清掉版本清單快取（「清除快取」或測試用） */
export function clearVersionCache() {
  _verMem.clear();
  try {
    if (typeof localStorage === "undefined") return 0;
    let n = 0;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_VER)) { localStorage.removeItem(k); n++; }
    }
    return n;
  } catch { return 0; }
}

// ---------- 版本 ↔ solc 相容性 ----------

/** 該版本要求的 solc 區間；沒實測過 → null（不顯示提示） */
export function solcRange(pkg, ver) {
  const lib = LIB_BY_PKG.get(pkg);
  if (!lib || typeof lib.range !== "function") return null;
  try { return lib.range(ver) || null; } catch { return null; }
}

/** 區間轉成人話："^0.8.20" / ">=0.6.0 <0.8.0" */
export function formatRange(r) {
  if (!r) return null;
  if (r.min && r.max) return `>=${r.min} <${r.max}`;
  if (r.min) return `^${r.min}`;
  if (r.max) return `<${r.max}`;
  return null;
}

/**
 * 選的版本跟原始碼 pragma 合不合。
 * @returns {{state:"ok"|"need-newer"|"too-new"|"unknown", min:string|null, max:string|null}}
 *          need-newer = 版本要求比 pragma 新；too-new = 版本只吃舊版（例如 OZ 3.x 的 <0.8.0）
 */
export function versionCompat(pkg, ver, refV) {
  const r = solcRange(pkg, ver);
  if (!r || !refV) return { state: "unknown", min: null, max: null };
  if (r.min && cmpVer(refV, r.min) < 0) return { state: "need-newer", min: r.min, max: r.max || null };
  if (r.max && cmpVer(refV, r.max) >= 0) return { state: "too-new", min: r.min || null, max: r.max };
  return { state: "ok", min: r.min || null, max: r.max || null };
}

/**
 * 從真實版本清單裡挑預設版本：挑「相容 pragma 的最新版」，
 * 但 npm 的 latest tag 優先——新發行的版本常掛在 dev tag（例如 OZ 的 5.7.0），
 * 直接挑最新版可能挑到還沒推上 latest 的。
 */
export function pickVersion(pkg, refV, versions = [], latest = null) {
  const list = [...versions].sort((a, b) => cmpVer(b, a));
  if (!list.length) {
    const lib = LIB_BY_PKG.get(pkg);
    return lib ? lib.pick(refV) : "latest";
  }
  const compat = list.filter((v) => versionCompat(pkg, v, refV).state !== "need-newer"
                              && versionCompat(pkg, v, refV).state !== "too-new");
  if (!compat.length) return list[0];                 // 全都合不來就給最新的，讓 solc 自己報錯
  if (latest && compat.includes(latest)) return latest;
  return compat[0];
}

// ---------- 主流程 ----------

/**
 * 遞迴解析依賴樹
 * @param {object}   opt
 * @param {Map}      opt.files        使用者上傳的檔案（路徑 -> 原始碼）
 * @param {string}   opt.solcVersion  solc 版本（pragma 抓不到時用來挑套件版本）
 * @param {object}   opt.overrides    套件名 -> 指定版本（覆蓋自動挑選）
 * @param {function} [opt.fetchFn]    自訂 fetch（測試用）
 * @param {function} [opt.onProgress] (已抓取數, 待處理數) => void
 * @param {number}   [opt.maxFiles]   依賴檔案數上限
 * @param {number}   [opt.maxBytes]   依賴總位元組上限
 * @returns {Promise<{sources:Map<string,string>, libs:Array, failures:Array, bytes:number, urls:Map}>}
 */
export async function resolveImports({
  files = new Map(),
  solcVersion = "",
  overrides = {},
  fetchFn,
  onProgress,
  maxFiles = 240,
  maxBytes = 4 * 1024 * 1024,
} = {}) {
  const doFetch = fetchFn || defaultFetch;
  const sources = new Map();   // key -> source（自動抓回來的依賴）
  const urls = new Map();      // key -> 實際抓取的網址（除錯 / 顯示用）
  const failures = [];
  const pkgVer = new Map();    // pkg -> 版本
  const pkgPrefix = new Map(); // pkg -> 成功的套件根前綴
  const seen = new Set();
  let bytes = 0;

  // pragma 優先（比 solc 版本更貼近使用者的意圖）；取所有檔案裡最高的下界
  let pragmaV = null;
  for (const src of files.values()) {
    const p = detectPragma(src);
    if (p && (!pragmaV || cmpVer(p, pragmaV) > 0)) pragmaV = p;
  }
  const refV = pragmaV || solcVersion || "0.8.20";

  const versionFor = (pkg) => {
    if (overrides[pkg]) return overrides[pkg];
    const lib = LIB_BY_PKG.get(pkg);
    return lib ? lib.pick(refV) : "latest";
  };

  // 抓單一檔案：依序試候選前綴，成功就記住該套件的前綴供後續檔案沿用
  async function fetchOne(key) {
    const sp = splitPkg(key);
    if (!sp) throw new Error(t_err("notPackage", key));
    const ver = versionFor(sp.pkg);
    pkgVer.set(sp.pkg, ver);
    const prefixes = pkgPrefix.has(sp.pkg)
      ? [pkgPrefix.get(sp.pkg)]
      : FALLBACK_PREFIXES;
    let lastErr = "HTTP 404";
    for (const pre of prefixes) {
      const url = CDN(sp.pkg, ver, pre + sp.rest);
      const cached = cacheGet(url);
      if (cached != null) {
        pkgPrefix.set(sp.pkg, pre);
        urls.set(key, url);
        return cached;
      }
      try {
        const src = await doFetch(url);
        if (src == null || /^Couldn't find the requested file/.test(src)) {
          lastErr = "HTTP 404";
          continue;
        }
        pkgPrefix.set(sp.pkg, pre);
        cachePut(url, src);
        urls.set(key, url);
        return src;
      } catch (e) {
        lastErr = String((e && e.message) || e);
        if (!/404/.test(lastErr)) break;   // 非 404（例如斷網）就不必再試別的前綴
      }
    }
    throw new Error(`${lastErr} · ${sp.pkg}${ver !== "latest" ? `@${ver}` : ""}/${sp.rest}`);
  }

  // 展開一層：把源碼裡的 import 換成待辦清單
  function expand(fromKey, src) {
    const next = [];
    for (const spec of parseImports(src)) {
      const key = absolutize(spec, fromKey);
      if (!key) continue;
      if (seen.has(key)) continue;
      if (findByBasename(files, key)) continue;   // 使用者自己上傳了，不要重抓
      next.push(key);
    }
    return next;
  }

  // 第一層：使用者上傳的檔案
  let queue = [];
  for (const [path, src] of files) queue.push(...expand(path, src));
  queue = [...new Set(queue)];

  // 併發批次裡每個 worker 都會在 await 之前讀到同一個 sources.size，
  // 所以要用「同步遞增的槽位」來卡上限，不能用抓取後的實際數量。
  let claimed = 0;
  let overBytes = false;
  let depth = 0;
  while (queue.length) {
    if (sources.size >= maxFiles) {
      failures.push({ path: `(+${queue.length})`, error: "maxFiles" });
      break;
    }
    depth++;
    const batch = queue.filter((k) => !seen.has(k));
    batch.forEach((k) => seen.add(k));
    queue = [];
    if (!batch.length) break;

    let done = 0;
    await mapLimit(batch, 6, async (key) => {
      try {
        const slot = claimed++;            // 同步佔位，避免並發一起通過檢查
        if (slot >= maxFiles) throw new Error("maxFiles");
        if (overBytes) throw new Error("maxBytes");
        const src = await fetchOne(key);
        if (bytes + src.length > maxBytes) { overBytes = true; throw new Error("maxBytes"); }
        sources.set(key, src);
        bytes += src.length;
        queue.push(...expand(key, src));
      } catch (e) {
        failures.push({ path: key, error: String((e && e.message) || e) });
      } finally {
        done++;
        if (onProgress) onProgress(sources.size, ++done === batch.length ? 0 : batch.length - done);
      }
    });
    queue = [...new Set(queue)];
    if (depth > 12) break;   // 依賴樹不該這麼深，防呆
  }

  const libs = [...pkgVer.entries()].map(([pkg, version]) => ({
    pkg,
    version,
    label: (LIB_BY_PKG.get(pkg) || {}).label || pkg,
    known: LIB_BY_PKG.has(pkg),
  }));

  return { sources, libs, failures, bytes, urls };
}

// 統一的錯誤文案 key（給 UI 翻譯用；這裡只回傳識別碼）
function t_err(code, path) {
  return code === "notPackage" ? `unresolved import: ${path}` : String(path);
}

/** 只掃描、不抓取：回傳原始碼裡用到的裸套件（給 UI 先渲染版本選單） */
export function scanPackages(files) {
  const pkgs = new Set();
  for (const [path, src] of files) {
    for (const spec of parseImports(src)) {
      if (isRelative(spec)) continue;
      const sp = splitPkg(absolutize(spec, path));
      if (sp) pkgs.add(sp.pkg);
    }
  }
  return [...pkgs];
}

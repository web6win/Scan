// ===== 合約驗證服務客戶端（後端：.NET 10 + EF Core 10 + PostgreSQL）=====
//
// 為什麼需要它：純靜態站沒有後端，ABI / 原始碼只能存在使用者自己的瀏覽器裡
// （contractmeta.js = localStorage）。換瀏覽器、換電腦、給別人看就沒了。
// 這個模組讓站點「選用」一個外部驗證服務，把驗證資料變成所有人可見。
//
// 三條硬規則：
//   1. 服務沒設定 / 連不上 / 逾時 / 回 404 —— 一律靜默降級成本機模式，不拋錯、不擋首屏。
//   2. 讀取不需要任何金鑰。寫入有兩條路：
//      ① 合約建立者（部署者）用錢包簽名提交驗證 —— submitVerify()，一般使用者走這條（推薦）
//      ② 管理員金鑰（X-Api-Key）—— publishContract()，營運補資料用。金鑰只存在本機 localStorage，
//         永遠不會被寫進程式碼或送到任何第三方。
//   3. 地址一律小寫，chainId 用節點當下回報的值（chainIdNum()），避免寫死常數對不上。
import { VERIFY_API, chainIdNum } from "./config.js";

const LS_URL = "web6.verifyApiUrl";   // 本機覆寫用（臨時換後端、本機聯調）
const LS_KEY = "web6.verifyAdminKey"; // 管理員金鑰

// ---------- 設定 ----------
export function baseUrl() {
  try {
    const ov = (localStorage.getItem(LS_URL) || "").trim();
    if (ov) return ov.replace(/\/+$/, "");
  } catch { /* 私密模式 */ }
  return String((VERIFY_API && VERIFY_API.baseUrl) || "").replace(/\/+$/, "");
}

export function setBaseUrl(v) {
  try {
    if (v && v.trim()) localStorage.setItem(LS_URL, v.trim());
    else localStorage.removeItem(LS_URL);
  } catch { /* 忽略 */ }
}

export function adminKey() {
  try { return localStorage.getItem(LS_KEY) || ""; } catch { return ""; }
}

export function setAdminKey(v) {
  try {
    if (v && v.trim()) localStorage.setItem(LS_KEY, v.trim());
    else localStorage.removeItem(LS_KEY);
  } catch { /* 忽略 */ }
}

/** 沒設定服務網址就等於關閉這個功能 */
export function isEnabled() { return !!baseUrl(); }

// ---------- 內部工具 ----------
function timeoutOpts(ms) {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, cleanup: () => clearTimeout(timer) };
}

function normAddr(addr) {
  const s = String(addr || "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null;
}

function toLocalMeta(j) {
  // ⚠️ 只有「帶得動 ABI」的紀錄才算得上驗證資料。
  //    後端索引器自動收錄的合約只有地址 / 部署者，abi 是空陣列、source 是 null；
  //    若把空 ABI 當成有效資料往外送，合約頁會拿它覆蓋使用者剛部署時存在本機的 ABI / 源碼
  //    （症狀：代碼 & ABI 分頁變成空的 [] ）。空 ABI 一律正規化成 null ＝「這份紀錄沒有 ABI」。
  const abi = Array.isArray(j.abi) && j.abi.length > 0 ? j.abi : null;
  return {
    abi,
    name: j.name || "",
    compiler: j.compiler || "",
    optimize: !!j.optimize,
    optimizeRuns: j.optimizeRuns != null ? String(j.optimizeRuns) : "",
    evmVersion: j.evmVersion || "",
    license: j.license || "",
    source: j.source || "",
    sourceFiles: j.sourceFiles || null,
    verified: !!j.verified,
    submitter: j.submitter || "",
    updatedAt: j.updatedAt || "",
    // 部署元資料（索引器或部署證明寫入）：合約頁可用來做「是不是本人」的前置檢查與免等索引的提交
    creator: j.creator || "",
    deployTxHash: j.deployTxHash || "",
    deployBlock: j.deployBlock != null ? j.deployBlock : null,
    // 標記來源：合約頁可以分辨這份資料是服務端的還是本機的
    remote: true,
  };
}

// ---------- 讀取（公開）----------
/**
 * 取服務端上的驗證資料。任何情況失敗都回傳 null（呼叫端直接當作「沒有」）。
 * @returns {Promise<object|null>}
 */
export async function fetchVerified(addr) {
  const base = baseUrl();
  const a = normAddr(addr);
  if (!base || !a) return null;

  const url = `${base}/api/contracts/${a}?chainId=${chainIdNum()}`;
  const t = timeoutOpts((VERIFY_API && VERIFY_API.timeoutMs) || 4000);
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: t.signal });
    if (r.status === 404) return null;      // 尚未驗證，正常情況
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !Array.isArray(j.abi)) return null;  // 沒有 ABI 的紀錄對前端沒用
    return toLocalMeta(j);
  } catch {
    return null;                             // 逾時 / 斷線 / CORS：靜默降級
  } finally {
    t.cleanup();
  }
}

// ---------- 合約目錄（分頁列表，公開讀取）----------
/**
 * 從後端分頁取得合約清單。
 * @param {number} page 從 1 開始
 * @param {number} size 每頁筆數
 * @returns {Promise<{total:number,page:number,size:number,items:Array}|null>}
 *          任何失敗（未設定 / 逾時 / 非 2xx）都回傳 null，呼叫端視為「暫時拿不到」。
 */
export async function fetchContracts(page = 1, size = 25) {
  const base = baseUrl();
  if (!base) return null;
  const url = `${base}/api/contracts?page=${page}&size=${size}&chainId=${chainIdNum()}`;
  const t = timeoutOpts((VERIFY_API && VERIFY_API.timeoutMs) || 4000);
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: t.signal });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !Array.isArray(j.items)) return null;
    return j;
  } catch {
    return null;
  } finally {
    t.cleanup();
  }
}

// ---------- 鏈上統計（公開讀取）----------
// 後端把鏈上 ETH 總量 / 銷毀量 / 地址數掃描並持久化在 PostgreSQL；
// 首頁「網路統計」面板優先採用這份後端資料（支援斷點續掃、自動增量）。
// 任何失敗（未設定 / 逾時 / 非 2xx）都回傳 null，呼叫端靜默降級成本機掃描。
export async function fetchStats() {
  const base = baseUrl();
  if (!base) return null;
  const url = `${base}/api/stats?chainId=${chainIdNum()}`;
  const t = timeoutOpts((VERIFY_API && VERIFY_API.timeoutMs) || 4000);
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: t.signal });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || typeof j.totalSupplyWei !== "string") return null;
    return {
      chainId: j.chainId,
      totalSupplyWei: j.totalSupplyWei,
      burnedWei: j.burnedWei,
      addressCount: j.addressCount,
      lastScannedBlock: j.lastScannedBlock,
      latestBlock: j.latestBlock,
      scanning: !!j.scanning,
      updatedAt: j.updatedAt,
    };
  } catch {
    return null;
  } finally {
    t.cleanup();
  }
}

// 觸發後端增量續掃（管理員金鑰；可選 toBlock）。失敗（未設金鑰 / 401 / 網路）回傳 false，呼叫端靜默忽略。
export async function triggerStatsScan(toBlock) {
  const base = baseUrl();
  if (!base) return false;
  const key = adminKey();
  if (!key) return false;
  const t = timeoutOpts((VERIFY_API && VERIFY_API.timeoutMs) || 4000);
  try {
    const r = await fetch(`${base}/api/stats/scan`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Api-Key": key },
      body: JSON.stringify(toBlock == null ? {} : { toBlock }),
      signal: t.signal,
    });
    return r.ok;
  } catch {
    return false;
  } finally {
    t.cleanup();
  }
}

// ---------- 寫入（需要管理員金鑰）----------
/**
 * 把驗證資料寫到服務端（upsert）。
 * @param {string} addr 合約地址
 * @param {object} payload { name, compiler, optimize, optimizeRuns, evmVersion, license,
 *                           abi, source, sourceFiles, verified, submitter }
 * @returns {Promise<{ok:boolean,error?:string,detail?:string,data?:object}>}
 */
export async function publishContract(addr, payload) {
  const base = baseUrl();
  const a = normAddr(addr);
  if (!base) return { ok: false, error: "no_api" };
  if (!a) return { ok: false, error: "bad_address" };

  const key = adminKey();
  if (!key) return { ok: false, error: "no_key" };

  const t = timeoutOpts(15000);
  try {
    const r = await fetch(`${base}/api/contracts/${a}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "X-Api-Key": key },
      body: JSON.stringify(Object.assign({ chainId: chainIdNum() }, payload)),
      signal: t.signal,
    });
    let j = null;
    try { j = await r.json(); } catch { /* 非 JSON 回應 */ }

    if (r.status === 401 || r.status === 403) return { ok: false, error: "unauthorized", detail: j && j.detail };
    if (r.status === 503) return { ok: false, error: "no_server_key", detail: j && j.detail };
    if (!r.ok) return { ok: false, error: (j && j.error) || "failed", detail: j && j.detail };
    return { ok: true, data: j };
  } catch (e) {
    return { ok: false, error: "network", detail: String((e && e.message) || e) };
  } finally {
    t.cleanup();
  }
}

// ---------- 建立者簽名提交驗證（免管理員金鑰）----------
/**
 * 產生要簽名的驗證訊息。
 * ⚠️ 格式必須與後端 `Services/EthSignature.cs` 的 `BuildMessage()` 逐字一致
 *    （改一邊就要改另一邊；`_creatorverify_test.mjs` 會用真實簽名抓出漂移）。
 * 訊息裡帶 payload 的雜湊 → 簽章綁定這份 payload，竄改任何內容都會讓簽章失效。
 * @param {number|string} chainId 鏈 ID
 * @param {string} address 合約地址（會轉小寫）
 * @param {string} hash payload 的 keccak256（0x + 64 hex）
 */
export function verifyMessage(chainId, address, hash) {
  return "WEB6 Contract Verification\n"
    + `chainId: ${chainId}\n`
    + `contract: ${String(address || "").toLowerCase()}\n`
    + `payload: ${hash}`;
}

/**
 * 以合約建立者的錢包簽名，把驗證資料提交到後端（POST /api/contracts/{addr}/verify）。
 * 後端會還原簽名者並比對鏈上索引到的 creator —— 只有建立者本人會通過。
 * @param {string} addr 合約地址
 * @param {string} payloadStr 驗證資料的原始 JSON 字串（呼叫端自行 stringify 後原樣帶上）
 * @param {string} signature 錢包對 verifyMessage() 簽出的簽章
 * @param {string} [txHash] 部署交易雜湊（選填）。索引器有週期延遲，剛部署完可能還沒進資料庫；
 *        帶上它，後端可直接向節點確認「這筆部署交易 from === 簽名者」，不必等索引器。
 * @returns {Promise<{ok:boolean,error?:string,detail?:string,data?:object}>}
 */
export async function submitVerify(addr, payloadStr, signature, txHash) {
  const base = baseUrl();
  const a = normAddr(addr);
  if (!base) return { ok: false, error: "no_api" };
  if (!a) return { ok: false, error: "bad_address" };
  if (!payloadStr) return { ok: false, error: "empty_payload" };
  if (!signature) return { ok: false, error: "no_signature" };

  const t = timeoutOpts(15000);
  try {
    const body = { chainId: chainIdNum(), payload: payloadStr, signature };
    if (txHash) body.txHash = txHash;
    const r = await fetch(`${base}/api/contracts/${a}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // payload 用「字串」傳：伺服器要拿到與簽名時一模一樣的位元組才能重算雜湊驗簽
      body: JSON.stringify(body),
      signal: t.signal,
    });
    let j = null;
    try { j = await r.json(); } catch { /* 非 JSON 回應 */ }

    if (!r.ok) return { ok: false, error: (j && j.error) || "failed", detail: j && j.detail };
    return { ok: true, data: j };
  } catch (e) {
    return { ok: false, error: "network", detail: String((e && e.message) || e) };
  } finally {
    t.cleanup();
  }
}

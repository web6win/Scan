// ===== 瀏覽器端 Solidity 編譯器（solc，跑在 Web Worker 裡）=====
// 用途：把上傳的 .sol 原始碼在本機瀏覽器裡編譯成 bytecode + ABI，
//       全程不把原始碼送到任何伺服器（本專案是純靜態站）。
//
// 三個關鍵設計：
//   1. soljson.js 是 emscripten 產物（`var Module = Module || {}`），只能用 <script>/importScripts 載，
//      不是 ESM，所以不能 import。
//   2. npm 上的 solc/wrapper.js 依賴 fs / semver 等 Node 模組，瀏覽器跑不動；
//      這裡改寫一份「最小可用版」，只綁 0.6+ 版本的 solidity_compile（做法同官方 bindings/compile.js）。
//   3. ⚠️ 一定要在 Worker 裡載：Chrome 禁止「主執行緒」同步編譯超過 8MB 的 wasm，
//      而 soljson 內嵌的 wasm 解壓後超過 8MB，在主執行緒載會直接噴
//      "WebAssembly.Compile is disallowed on the main thread"。
//
// 載入順序：站內自託管 → CDN。需要內網／離線使用時，把 soljson-<版本>.js
// 丟到 assets/vendor/solc/ 即可，不必改程式碼。
import { t } from "./i18n.js";

// 常用版本（UI 也會動態拉最新版本，這份是抓不到清單時的兜底）
export const SOLC_VERSIONS = [
  "0.8.37", "0.8.36", "0.8.35", "0.8.34", "0.8.33", "0.8.32",
  "0.8.30", "0.8.28", "0.8.26", "0.8.24", "0.8.20",
  "0.7.6", "0.6.12",
];
export const DEFAULT_SOLC_VERSION = "0.8.37";

// EVM 版本選項（solc 的 settings.evmVersion 接受的值）。"default" 不放進這裡，
// 由各頁面自行放在清單最前面，表示「交給編譯器決定」（標準 JSON 不寫 evmVersion）。
export const EVM_VERSIONS = [
  "homestead", "tangerineWhistle", "spuriousDragon", "byzantium",
  "constantinople", "petersburg", "istanbul", "berlin",
  "london", "paris", "shanghai", "cancun",
];

// Worker 是從 blob: URL 產生的，裡面的相對路徑會以 blob: 為基準解析而失效，
// 所以站內那份一定要換成絕對網址。
const VENDOR = (v) => `assets/vendor/solc/soljson-${v}.js`;
const absVendor = (v) => new URL(VENDOR(v), location.href).href;
const CDN = (v) => `https://cdn.jsdelivr.net/npm/solc@${v}/soljson.js`;
const INIT_TIMEOUT = 120000;  // 9MB 下載 + wasm 編譯，慢機器要給夠
const COMPILE_TIMEOUT = 180000;

const _cache = new Map(); // version -> Promise<compiler>
let _lastSource = "";
let _lastRaw = "";

/** 上一次載入的 soljson 網址（站內自託管或 CDN），除錯 / 測試用 */
export function lastCompilerSource() { return _lastSource; }
/** 最近一次編譯的原始 JSON 字串，除錯 / 測試用 */
export function lastCompileRaw() { return _lastRaw; }

export function solcUrl(version) { return CDN(version); }

// 從 CDN 拉版本清單（失敗就沿用內建清單）
export async function fetchSolcVersions() {
  try {
    const r = await fetch("https://data.jsdelivr.com/v1/packages/npm/solc", { cache: "force-cache" });
    const j = await r.json();
    const list = (j.versions || []).map((x) => x.version).filter((v) => /^0\.[678]\.\d+$/.test(v));
    if (!list.length) return SOLC_VERSIONS;
    // 字串排序會把 "0.8.9" 排在 "0.8.30" 後面，補零再比
    const key = (v) => v.split(".").map((n) => n.padStart(3, "0")).join(".");
    return [...new Set([...list, ...SOLC_VERSIONS])].sort((a, b) => (key(a) < key(b) ? 1 : -1)).slice(0, 24);
  } catch {
    return SOLC_VERSIONS;
  }
}

// ---------- Worker 原始碼（字串：Worker 只能吃獨立檔案或 Blob，不能 import 本模組）----------
const WORKER_SRC = String.raw`
let solc = null;

// 以「檔案表」為來源的 import 回調：solc 找不到 import 時會回頭問我們
function makeResolver(files) {
  return function (path) {
    if (files && Object.prototype.hasOwnProperty.call(files, path)) return { contents: files[path] };
    const base = String(path).replace(/^.*[\\/]/, "");
    if (files) {
      const keys = Object.keys(files);
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] === base || keys[i].endsWith("/" + base)) return { contents: files[keys[i]] };
      }
    }
    return { error: "File not found: " + path };
  };
}

function wrap(m) {
  const version = m.cwrap("solidity_version", "string", []);
  const alloc = m._solidity_alloc ? m.cwrap("solidity_alloc", "number", ["number"]) : m._malloc;
  const reset = m._solidity_reset ? m.cwrap("solidity_reset", null, []) : null;
  // 0.6+：(input, callback, callbackContext) -> json
  const compileInternal = m._solidity_compile
    ? m.cwrap("solidity_compile", "string", ["string", "number", "number"])
    : m.cwrap("compileStandard", "string", ["string", "number"]);

  const addFunction = m.addFunction || m.Runtime.addFunction;
  const removeFunction = m.removeFunction || m.Runtime.removeFunction;
  const fromCString = m.UTF8ToString || m.Pointer_stringify;

  function copyToCString(str, ptr) {
    const len = m.lengthBytesUTF8(str);
    const buf = alloc(len + 1);
    m.stringToUTF8(str, buf, len + 1);
    m.setValue(ptr, buf, "*");
  }

  function compile(inputJson, files) {
    const read = makeResolver(files);
    const cb = function (context, kindPtr, dataPtr, contentsPtr, errorPtr) {
      if (context !== 0) return;                        // 官方 wrapper 斷言 ctx 必須是 null
      if (fromCString(kindPtr) !== "source") return;    // smt-query 等其他回調忽略
      const data = fromCString(dataPtr);
      try {
        const res = read(data);
        if (res && typeof res.contents === "string") copyToCString(res.contents, contentsPtr);
        if (res && typeof res.error === "string") copyToCString(res.error, errorPtr);
      } catch (e) {
        copyToCString(String((e && e.message) || e), errorPtr);
      }
    };
    const ptr = addFunction(cb, "viiiii");
    let out;
    try {
      out = compileInternal(inputJson, ptr, 0);
    } finally {
      removeFunction(ptr);
      // cwrap 會把回傳指標複製成 JS 字串，無法 free；用 reset() 清掉所有配置
      if (reset) reset();
    }
    return out;
  }

  return { version: function () { return version(); }, compile: compile };
}

function waitReady(m, timeout) {
  return new Promise(function (resolve, reject) {
    const t0 = Date.now();
    (function poll() {
      if (m && typeof m.cwrap === "function" && m.calledRun) return resolve(m);
      if (Date.now() - t0 > timeout) return reject(new Error("solc init timeout"));
      setTimeout(poll, 50);
    })();
  });
}

self.onmessage = function (e) {
  const msg = e.data || {};
  if (msg.type === "init") {
    (async function () {
      try {
        self.Module = {};
        importScripts(msg.url);
        await waitReady(self.Module, msg.timeout || 120000);
        solc = wrap(self.Module);
        self.postMessage({ type: "ready", version: solc.version() });
      } catch (err) {
        self.postMessage({ type: "error", error: String((err && err.message) || err) });
      }
    })();
    return;
  }
  if (msg.type === "compile") {
    try {
      const out = solc.compile(msg.input, msg.files || {});
      self.postMessage({ type: "result", id: msg.id, output: out });
    } catch (err) {
      self.postMessage({ type: "error", id: msg.id, error: String((err && err.message) || err) });
    }
  }
};
`;

function spawnWorker() {
  const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  return w;
}

// 讓 Worker 依序嘗試每個來源；某個來源失敗就換一顆乾淨的 Worker 再試
async function initWorker(urls, onStatus) {
  let lastErr = "unknown";
  for (let i = 0; i < urls.length; i++) {
    const worker = spawnWorker();
    try {
      const version = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("solc init timeout")), INIT_TIMEOUT);
        worker.onmessage = (e) => {
          const m = e.data || {};
          if (m.type === "ready") { clearTimeout(timer); resolve(m.version); }
          else if (m.type === "error") { clearTimeout(timer); reject(new Error(m.error)); }
        };
        worker.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message || "worker error")); };
        worker.postMessage({ type: "init", url: urls[i], timeout: INIT_TIMEOUT });
      });
      return { worker, version, url: urls[i] };
    } catch (e) {
      lastErr = (e && e.message) || e;
      worker.terminate();
      if (onStatus && i < urls.length - 1) onStatus(t("dep.compilerFallback"));
    }
  }
  throw new Error(lastErr);
}

/**
 * 取用編譯器（同一版本只會載一次）
 * @param {string} version solc 版本號
 * @param {(msg:string)=>void} [onStatus] 進度回呼
 */
export function loadCompiler(version = DEFAULT_SOLC_VERSION, onStatus) {
  const v = String(version || DEFAULT_SOLC_VERSION);
  if (_cache.has(v)) return _cache.get(v);
  const p = (async () => {
    onStatus && onStatus(t("dep.compilerLoading"));
    const { worker, version: ver, url: used } = await initWorker([absVendor(v), CDN(v)], onStatus);
    _lastSource = used;
    let seq = 0;
    const pending = new Map();
    worker.onmessage = (e) => {
      const m = e.data || {};
      const entry = pending.get(m.id);
      if (!entry) return;
      pending.delete(m.id);
      clearTimeout(entry.timer);
      if (m.type === "error") { _lastRaw = "ERR:" + m.error; entry.reject(new Error(m.error)); }
      else {
        _lastRaw = typeof m.output === "string" ? m.output : "MSG:" + JSON.stringify(m);
        entry.resolve(m.output);
      }
    };
    worker.onerror = (e) => {
      for (const [, entry] of pending) { clearTimeout(entry.timer); entry.reject(new Error(e.message || "worker error")); }
      pending.clear();
    };
    return {
      version: () => ver,
      /** @param {object} input 標準 JSON 輸入物件 @param {object} files 路徑 -> 原始碼（給 import 回調） */
      async compileInput(input, files = {}) {
        const id = ++seq;
        const out = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(new Error("compile timeout")); }, COMPILE_TIMEOUT);
          pending.set(id, { resolve, reject, timer });
          worker.postMessage({ type: "compile", id, input: JSON.stringify(input), files });
        });
        return typeof out === "string" ? JSON.parse(out) : out;
      },
    };
  })();
  p.catch(() => _cache.delete(v)); // 失敗別留壞的 Promise，讓使用者可以重試
  _cache.set(v, p);
  return p;
}

/** 目前是否已經載過某個版本（供 UI 顯示「已就緒」） */
export function isCompilerReady(version = DEFAULT_SOLC_VERSION) {
  return _cache.has(String(version || DEFAULT_SOLC_VERSION));
}

// ---------- 標準 JSON input / output ----------
/**
 * 組出標準 JSON 輸入。只需要 bin + abi；要多種產出時用 outputSelection 擴充即可。
 */
export function standardInput({ sources, optimize = true, runs = 200, evmVersion }) {
  const settings = {
    optimizer: { enabled: !!optimize, runs: parseInt(runs, 10) || 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode"] } },
  };
  if (evmVersion && evmVersion !== "default") settings.evmVersion = evmVersion;
  return { language: "Solidity", sources, settings };
}

/**
 * 從標準 JSON 輸出抽出可部署的合約清單
 * @returns {{key:string, file:string, name:string, abi:any[], bytecode:string}[]}
 */
export function collectContracts(output) {
  const list = [];
  const contracts = (output && output.contracts) || {};
  for (const [file, entries] of Object.entries(contracts)) {
    for (const [name, art] of Object.entries(entries || {})) {
      const bc = art && art.evm && art.evm.bytecode && art.evm.bytecode.object;
      if (!bc) continue; // 抽象合約 / interface 沒有部署 bytecode
      list.push({ key: `${file}:${name}`, file, name, abi: art.abi || [], bytecode: bc });
    }
  }
  return list;
}

/** 把 solc 的診斷訊息（error / warning）攤平成陣列 */
export function collectDiagnostics(output) {
  const errs = (output && output.errors) || [];
  return errs.map((e) => ({
    severity: e.severity || "error",
    text: (e.formattedMessage || `${e.type}: ${e.message}` || "").trim(),
  }));
}

// ===== 合約部署：① 上傳 .sol → 瀏覽器內編譯 ② 錢包插件或私鑰簽名 → 廣播 =====
// 兩條簽名路徑都「不上傳私密資料」：
//   - 錢包插件：私鑰與助記詞全程留在錢包裡，本頁只收到授權後的帳號與交易雜湊
//   - 私鑰：只在本瀏覽器內用 ethers 簽名，送出的是已簽名的交易資料（既有行為）
import * as API from "./api.js";
import {
  el, mono, shortHash, fmtNum, toast, errorBox, spinner,
} from "./utils.js";
import { t } from "./i18n.js";
import {
  getProvider, hasWallet, walletName, isMobile, walletDeepLink,
  getAccounts, requestAccounts, isOnChain, sendTransaction, signMessage,
  addOrSwitchChain, asWalletError, WalletError,
} from "./wallet.js";
import {
  loadCompiler, standardInput, collectContracts, collectDiagnostics,
  fetchSolcVersions, SOLC_VERSIONS, DEFAULT_SOLC_VERSION, EVM_VERSIONS,
} from "./compiler.js";
import {
  resolveImports as resolveLibImports, scanPackages, chooseVersion,
  detectRefVersion, LIB_BY_PKG, fetchVersions, pickVersion,
  versionCompat, formatRange,
} from "./sollibs.js";
import { saveMeta } from "./contractmeta.js";
import { chainIdNum } from "./config.js";
import * as VERIFY from "./verifyapi.js";

// 站內自帶的 ethers（address.html 也是用這份）；拿不到才退回 CDN
const VENDOR_ETHERS = "assets/vendor/ethers.umd.min.js";
const ETHERS_URL = "https://esm.sh/ethers@6.13.4";

let _ethers = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("script load failed"));
    document.head.appendChild(s);
  });
}
async function loadEthers() {
  if (_ethers) return _ethers;
  if (typeof window !== "undefined" && window.ethers) { _ethers = window.ethers; return _ethers; }
  try {
    await loadScript(new URL(VENDOR_ETHERS, location.href).href);
    if (window.ethers) { _ethers = window.ethers; return _ethers; }
  } catch { /* 站內沒有這份，退回 CDN */ }
  toast(t("dep.loadingLib"));
  _ethers = await import(/* @vite-ignore */ ETHERS_URL);
  return _ethers;
}

const $ = (id) => document.getElementById(id);

// ---------- 頁面狀態 ----------
const state = {
  files: new Map(),   // 路徑 -> 原始碼（使用者自己上傳的）
  libFiles: new Map(),// 路徑 -> 原始碼（自動從 npm CDN 抓回來的第三方庫，如 @openzeppelin）
  libVersions: {},    // 套件名 -> 使用者手動指定的版本（""= 交給程式自動挑；覆蓋自動挑選）
  verLists: {},       // 套件名 -> 從 npm 抓回來的版本清單 { versions, latest, ok, error }
  verP: new Map(),    // 套件名 -> 抓取中的 Promise（同一個套件不要重複發請求）
  libInfo: null,      // 最近一次解析結果 { libs, failures, bytes }
  contracts: [],      // 編譯出來的可部署合約
  picked: null,       // 目前選中的合約
  account: "",        // 錢包授權後的帳號
  compileInfo: {      // 最近一次編譯的設定（部署成功後一起寫進合約頁）
    version: "",
    optimize: false,
    runs: "200",
    evmVersion: "default",
  },
  deployedAddr: "",   // 最近一次部署出來的合約地址（給「發布到驗證服務」用）
  signCtx: null,      // 這次部署的簽名方式：{kind:"wallet",provider,account} 或 {kind:"key",wallet}
                      // 部署成功後要用同一個身分對驗證訊息簽名（證明自己是建立者）
};

// ---------- 小工具 ----------
function kv(key, val) {
  return el("div", { class: "kv-row" }, [
    el("div", { class: "kv-key" }, [key]),
    el("div", { class: "kv-val" }, [val]),
  ]);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function pollReceipt(hash, tries = 40, intervalMs = 3000) {
  return (async () => {
    for (let i = 0; i < tries; i++) {
      const r = await API.getTxReceipt(hash);
      if (r) return r;
      await new Promise((res) => setTimeout(res, intervalMs));
    }
    return null;
  })();
}

// 部署成功後把 ABI / 原始碼寫進本機，合約頁的「讀取 / 寫入 / 代碼」才認得這個合約。
// 沒有這一步，新部署出來的合約點進去只會看到「尚無 ABI，請上傳」，等於剛佈完不能用。
function rememberDeployed(addr) {
  const c = state.picked;
  if (!addr || !c || !c.abi) return false;
  state.deployedAddr = addr.toLowerCase();
  try {
    saveMeta(addr, {
      abi: c.abi,
      name: c.name,
      compiler: state.compileInfo.version,
      optimize: state.compileInfo.optimize,
      optimizeRuns: state.compileInfo.runs,
      evmVersion: state.compileInfo.evmVersion,
      source: sourceBundle(c),
      // 這份 bytecode 就是從上面的原始碼編出來並成功佈上去的，直接視為已驗證
      verified: true,
    });
    return true;
  } catch { return false; }
}

// 自動引入的第三方庫原始碼也要附上，否則別人拿到這份原始碼根本編不出同一份 bytecode，
// 「已驗證」就失去意義。但整套塞進來可能很大，超過上限時退化成「只記版本」。
const LIB_SOURCE_LIMIT = 400 * 1024;

function libSourceText() {
  if (!state.libFiles.size) return "";
  return [...state.libFiles.entries()].map(([k, v]) => `// ===== ${k} =====\n${v}`).join("\n\n");
}

function libVersionNote() {
  const libs = (state.libInfo && state.libInfo.libs) || [];
  return libs.map((l) => `${l.pkg}@${l.version}`).join("\n");
}

// 合約頁的「原始碼」是單一字串。多檔案專案時把被 import 的檔案附在後面，
// 才不會只看得到主合約、import 的那幾份不見。
function sourceBundle(c) {
  const main = state.files.get(c.file) || "";
  const others = [...state.files.keys()].filter((k) => k !== c.file);
  const parts = [];
  if (others.length) {
    parts.push(others.map((k) => `// ===== ${k} =====\n${state.files.get(k)}`).join("\n\n"));
  }
  const lib = libSourceText();
  if (lib) {
    parts.push(lib.length <= LIB_SOURCE_LIMIT
      ? lib
      : `/* 第三方函式庫原始碼過大（${fmtBytes(lib.length)}），僅記錄版本：\n${libVersionNote()}\n*/`);
  }
  if (!parts.length) return main;
  return `${main}\n\n/* ===== 其餘來源檔 ===== */\n\n${parts.join("\n\n")}`;
}

/** 送給驗證服務的檔案表：使用者上傳的 + 自動引入的（太大就只送使用者那份） */
function verificationSourceFiles() {
  if (!state.libFiles.size) return Object.fromEntries(state.files);
  const libBytes = [...state.libFiles.values()].reduce((a, s) => a + s.length, 0);
  if (libBytes > LIB_SOURCE_LIMIT) return Object.fromEntries(state.files);
  return Object.fromEntries(allSourceFiles());
}

function buildSuccess(hash, receipt) {
  const num = receipt.blockNumber ? parseInt(receipt.blockNumber, 16) : null;
  const ok = receipt.status === "0x1";
  const addr = receipt.contractAddress;
  const abiSaved = rememberDeployed(addr);

  // 自動把 ABI / 原始碼送上驗證服務的狀態列。先建好、預設隱藏，稍後由非同步流程填字。
  // 失敗完全不影響上面的部署結果 —— 資料仍寫在本機，合約頁的「提交驗證」可以重來。
  const verifyState = el("p", { class: "hint verify-state", style: "flex-basis:100%; padding:0" });
  verifyState.hidden = true;
  if (ok && addr) {
    // buildSuccess 是在 replaceChildren 的參數位置被呼叫的，此刻節點還沒進 DOM；
    // 用 microtask 排到本輪同步流程（含 insert）之後再跑，狀態列才改得到。
    queueMicrotask(() => { void autoSubmitVerification(addr, hash, verifyState); });
  }

  return el("div", { class: "panel" }, [
    el("div", { class: "panel-head" }, [
      el("h2", {}, [ok ? t("dep.ok") : t("dep.packedFailed")]),
    ]),
    el("div", { class: "kv" }, [
      kv(t("dep.txHash"), el("a", { class: "link", href: `txs.html#/tx/${hash}` }, [mono(hash)])),
      kv(t("dep.contractAddr"), addr
        ? el("a", { class: "link", href: `address.html#/address/${addr}` }, [mono(addr)])
        : el("span", { class: "muted" }, ["—"])),
      kv(t("dep.block"), num != null
        ? el("a", { class: "link", href: `blocks.html#/block/${num}` }, ["#" + fmtNum(num)])
        : el("span", { class: "muted" }, ["—"])),
      kv(t("dep.gasUsed"), receipt.gasUsed ? fmtNum(parseInt(receipt.gasUsed, 16)) : "—"),
      kv(t("dep.status"), ok
        ? el("span", { class: "tag tag-ok" }, [t("dep.okTag")])
        : el("span", { class: "tag tag-fail" }, [t("dep.failTag")])),
    ]),
    addr
      ? el("div", { class: "panel-foot" }, [
        abiSaved ? el("p", { class: "hint", style: "padding:0 0 10px" }, [t("dep.abiSaved")]) : null,
        verifyState,
        el("a", { class: "btn btn-ghost btn-sm", href: `address.html#/address/${addr}` }, [t("dep.viewContract")]),
      ])
      : null,
  ]);
}

// 部署成功後自動提交驗證（ABI + 原始碼 + 編譯設定）到後端。
//
// 為什麼要簽名：後端只認「合約建立者」提交的驗證，而證明自己是建立者的唯一方式是錢包簽名
// （前端自稱的地址可以隨便填）。簽章綁定 payload 雜湊，所以資料內容無法被中途替換。
// 錢包路徑會在部署後再彈一次簽名確認；私鑰路徑不彈窗（金鑰本來就在本頁）。
async function autoSubmitVerification(addr, txHash, statusEl) {
  const say = (msg, hidden) => {
    if (!statusEl) return;
    if (hidden) { statusEl.hidden = true; return; }
    statusEl.textContent = msg;
    statusEl.hidden = false;
  };

  // 沒設定驗證服務就整段跳過（純本機模式，跟既有行為一致）
  if (!VERIFY.isEnabled()) { say("", true); return; }
  const c = state.picked;
  const ctx = state.signCtx;
  if (!addr || !c || !c.abi || !ctx) { say("", true); return; }

  try {
    say(t("dep.autoVerifySigning"));
    const eth = await loadEthers();

    // payload 只序列化一次：算雜湊用的字串與送出的字串必須完全相同，否則簽章對不上。
    const payloadStr = JSON.stringify({
      name: c.name || "",
      compiler: state.compileInfo.version || "",
      optimize: !!state.compileInfo.optimize,
      optimizeRuns: parseInt(state.compileInfo.runs, 10) || null,
      evmVersion: state.compileInfo.evmVersion || "",
      abi: c.abi,
      source: sourceBundle(c),
      sourceFiles: verificationSourceFiles(),
      verified: true,
    });
    const hash = eth.keccak256(eth.toUtf8Bytes(payloadStr));
    const message = VERIFY.verifyMessage(chainIdNum(), addr, hash);

    const signature = ctx.kind === "wallet"
      ? await signMessage(message, ctx.account, ctx.provider)
      : await ctx.wallet.signMessage(message);

    // 索引器是週期掃描，剛部署完可能還沒進庫 → 帶上部署交易雜湊讓後端直接向節點求證；
    // 還是不行（節點一時連不上等）就退避重試。not_creator / bad_signature 重試沒意義。
    const waits = [0, 2000, 5000, 10000];
    let res = null;
    for (let i = 0; i < waits.length; i++) {
      if (waits[i]) await new Promise((r) => setTimeout(r, waits[i]));
      res = await VERIFY.submitVerify(addr, payloadStr, signature, txHash);
      if (res.ok) break;
      if (res.error !== "not_found" && res.error !== "creator_unknown" && res.error !== "network") break;
    }

    if (res && res.ok) say(t("dep.autoVerifyOk"));
    else if (res && res.error === "not_creator") say(t("dep.autoVerifyNotCreator"));
    else if (res && res.error === "no_api") say("", true);
    else say(t("dep.autoVerifyFail") + " " + ((res && (res.detail || res.error)) || ""));
  } catch (e) {
    // 使用者在錢包按「拒絕」→ WalletError code = rejected；這不是錯誤，只是這輪不提交
    if (e && e.code === "rejected") say(t("dep.autoVerifyCancelled"));
    else say(t("dep.autoVerifyFail") + " " + ((e && e.message) || e));
  }
}

function buildBroadcasted(hash) {
  return el("div", { class: "panel" }, [
    el("div", { class: "panel-head" }, [el("h2", {}, [t("dep.broadcasted")])]),
    el("div", { class: "kv" }, [
      kv(t("dep.txHash"), el("a", { class: "link", href: `txs.html#/tx/${hash}` }, [mono(hash)])),
    ]),
    el("div", { class: "hint", style: "padding:0 16px 16px" }, [t("dep.broadcastHint")]),
  ]);
}

// ---------- ① 原始碼上傳 ----------
function renderFileList() {
  const box = $("fileList");
  box.replaceChildren();
  if (!state.files.size) return;
  for (const [path, content] of state.files) {
    box.appendChild(el("div", { class: "file-item" }, [
      el("span", { class: "file-name", title: path }, [path]),
      el("span", { class: "file-size" }, [fmtBytes(content.length)]),
      el("button", {
        class: "file-del",
        type: "button",
        "aria-label": `${t("common.close")} ${path}`,
        onclick: () => { state.files.delete(path); renderFileList(); renderLibPicker(); },
      }, ["✕"]),
    ]));
  }
}

async function addFiles(list) {
  let added = 0;
  for (const f of Array.from(list || [])) {
    if (!/\.(sol|json|txt)$/i.test(f.name)) continue;
    // 同名覆蓋（重傳同一個檔案時以新內容為準）
    state.files.set(f.name, await f.text());
    added++;
  }
  renderFileList();
  renderLibPicker();   // 上傳後立刻顯示「偵測到的第三方庫」與版本選單
  return added;
}

// ---------- ①-b 第三方函式庫（@openzeppelin 等）----------
// 偵測到 import "@openzeppelin/contracts/…" 這類裸套件路徑時，編譯前自動從 npm CDN
// 把整棵依賴樹抓回來，使用者不必自己上傳整套 .sol。
function currentSolcVersion() {
  const sel = $("solcVer");
  return (sel && sel.value) || DEFAULT_SOLC_VERSION;
}

/** 版本清單（抓一次就快取；同一個套件併發只發一個請求） */
function verListPromise(pkg) {
  if (!state.verP.has(pkg)) {
    state.verP.set(pkg, fetchVersions(pkg).then((r) => {
      state.verLists[pkg] = r;
      return r;
    }).catch(() => {
      const r = { pkg, versions: [], latest: null, ok: false, error: "network" };
      state.verLists[pkg] = r;
      return r;
    }));
  }
  return state.verP.get(pkg);
}

/** 這一列目前會用哪個版本：手動指定 > 依 pragma 從真實清單挑 > 內建規則 */
function versionFor(pkg, refV) {
  if (state.libVersions[pkg]) return state.libVersions[pkg];
  const list = state.verLists[pkg];
  return chooseVersion(pkg, refV, {}, list ? list.versions : null, list ? list.latest : null);
}

/** 下拉框：第一項是「自動」（顯示會挑到哪個版本），其餘是 npm 上真實發行過的版本 */
function fillVersionSelect(sel, pkg, refV) {
  const list = state.verLists[pkg];
  const cur = state.libVersions[pkg] || "";              // "" = 自動
  const autoV = pickVersion(pkg, refV, list ? list.versions : [], list ? list.latest : null);

  sel.replaceChildren();
  // ⚠️ 不能用 el 的 selected 屬性：el 走 setAttribute，寫 false 也會留下這個屬性，
  //    結果「每一個」option 都被標成 selected，選中的會變成清單最後一項。
  const add = (value, label, cls) => {
    const o = el("option", { value }, [label]);
    if (cls) o.className = cls;
    o.selected = value === cur;
    sel.appendChild(o);
  };
  add("", t("dep.libAuto", { v: autoV }), "lib-ver-auto");

  if (!list) {
    add(cur || autoV, t("dep.libLoading"));   // 清單還沒回來，先給個佔位
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const v of list.versions) add(v, v);
  // 手動選過的版本若不在清單裡（例如被 unmirror），要補回來才不會「選了卻顯示別的版本」
  if (cur && !list.versions.includes(cur)) add(cur, cur);
  sel.value = cur;
}

/** 版本旁邊的說明：需要哪個 solc 版本 / 與 pragma 合不合 */
function libNoteNode(pkg, refV) {
  const list = state.verLists[pkg];
  if (!list) return el("span", { class: "lib-note" }, [t("dep.libLoading")]);
  if (!list.ok) return el("span", { class: "lib-note lib-note-warn" }, [t("dep.libVerFail")]);

  const ver = versionFor(pkg, refV);
  const c = versionCompat(pkg, ver, refV);
  if (c.state === "need-newer" || c.state === "too-new") {
    return el("span", { class: "lib-note lib-note-warn" }, [t("dep.libMismatch", { ref: refV })]);
  }
  const r = formatRange({ min: c.min, max: c.max });
  if (r) return el("span", { class: "lib-note" }, [t("dep.libNeed", { r })]);
  return el("span", { class: "lib-note" }, [t("dep.libCount", { n: list.versions.length })]);
}

function renderLibPicker() {
  const box = $("libPicker");
  if (!box) return;
  const pkgs = scanPackages(state.files);
  if (!pkgs.length) {
    box.replaceChildren();
    box.hidden = true;
    return;
  }
  box.hidden = false;

  const refV = detectRefVersion(state.files, currentSolcVersion());
  const nodes = pkgs.map((pkg) => {
    const lib = LIB_BY_PKG.get(pkg);
    const sel = el("select", {
      class: "lib-ver",
      "aria-label": `${pkg} version`,
      onchange: (e) => {
        state.libVersions[pkg] = e.target.value;   // "" = 回到自動
        state.libFiles.clear();                    // 換版本就要重抓
        state.libInfo = null;
        renderLibPicker();                         // 說明文字要跟著換（例如改成需要 ^0.8.0）
      },
    });
    fillVersionSelect(sel, pkg, refV);

    const note = libNoteNode(pkg, refV);
    const row = el("div", { class: "lib-row" }, [
      el("span", { class: "lib-name" }, [lib ? lib.label : pkg]),
      el("code", { class: "lib-pkg" }, [pkg]),
      sel,
      note,
      lib ? null : el("span", { class: "lib-unknown" }, [t("dep.libUnknown")]),
    ]);

    // 清單是非同步的：回來後就地更新這一個 select 與說明（不整塊重建，免得閃爍 / 掉焦點）
    if (!state.verLists[pkg]) {
      verListPromise(pkg).then(() => {
        if (!row.isConnected) return;              // 期間使用者把檔案刪了
        fillVersionSelect(sel, pkg, detectRefVersion(state.files, currentSolcVersion()));
        note.replaceWith(libNoteNode(pkg, detectRefVersion(state.files, currentSolcVersion())));
      });
    }
    return row;
  });

  box.replaceChildren(
    el("div", { class: "lib-head" }, [t("dep.libDetected")]),
    ...nodes,
    el("div", { class: "hint" }, [t("dep.libHint", { ref: refV })]),
  );
}

/** 把第三方庫抓回來；回傳 { sources, libs, failures }（失敗不丟例外，交給 UI 顯示） */
async function resolveLibs(onProgress) {
  // 先把版本清單等回來，才能把「畫面上顯示的版本」原樣傳給解析器——
  // 否則畫面顯示 5.6.1、實際卻用內建規則挑到別的版本，使用者會一頭霧水。
  const pkgs = scanPackages(state.files);
  if (pkgs.length) await Promise.all(pkgs.map(verListPromise));

  const refV = detectRefVersion(state.files, currentSolcVersion());
  const overrides = {};
  for (const pkg of pkgs) overrides[pkg] = versionFor(pkg, refV);

  const r = await resolveLibImports({
    files: state.files,
    solcVersion: currentSolcVersion(),
    overrides,
    onProgress,
  });
  state.libFiles = r.sources;
  state.libInfo = r;
  return r;
}

/** 使用者上傳的 + 自動抓回來的，全部餵給 solc */
function allSourceFiles() {
  return new Map([...state.files, ...state.libFiles]);
}

// ---------- ② 編譯 ----------
async function compile() {
  const out = $("compileOut");
  const btn = $("compileBtn");
  if (!state.files.size) {
    out.replaceChildren(errorBox(t("dep.noSourceFiles")));
    return;
  }
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = t("dep.compiling");
  out.replaceChildren(spinner(t("dep.compiling")));

  try {
    // 先補齊第三方庫（@openzeppelin / @chainlink / solmate …）：
    // 抓不到不會中斷，失敗清單會顯示在結果區，讓使用者知道缺哪一份。
    const lib = await resolveLibs((n) => {
      out.replaceChildren(spinner(t("dep.resolvingLibs", { n })));
    });

    const all = allSourceFiles();
    const sources = {};
    for (const [path, content] of all) sources[path] = { content };
    const input = standardInput({
      sources,
      optimize: $("optimize").checked,
      runs: $("optRuns").value,
      evmVersion: $("evmVersion").value,
    });
    const solc = await loadCompiler($("solcVer").value, (msg) => { out.replaceChildren(spinner(msg)); });
    const output = await solc.compileInput(input, Object.fromEntries(all));

    // 記下這次用的是哪個版本 / 優化設定：合約頁的「編譯器」欄位要照實顯示
    state.compileInfo = {
      version: (typeof solc.version === "function" ? solc.version() : solc.version)
        || output.solcVersion || $("solcVer").value,
      optimize: $("optimize").checked,
      runs: $("optRuns").value,
      evmVersion: $("evmVersion").value,
    };

    state.contracts = collectContracts(output);
    renderCompileOut(output);
  } catch (e) {
    out.replaceChildren(errorBox(t("dep.compilerFail") + (e && e.message ? " — " + e.message : "")));
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/** 依賴庫解析結果：成功就一行摘要，抓不到就把缺的檔案列出來（這種錯誤 solc 只會說「找不到」） */
function libReportNodes() {
  const info = state.libInfo;
  if (!info) return [];
  const nodes = [];
  if (info.sources.size) {
    const names = info.libs.map((l) => `${l.label} @ ${l.version}`).join("、");
    nodes.push(el("div", { class: "diag diag-ok lib-ok" }, [
      t("dep.libResolved", { n: info.sources.size, libs: names, size: fmtBytes(info.bytes) }),
    ]));
  }
  if (info.failures.length) {
    nodes.push(el("div", { class: "diag diag-err" }, [
      el("strong", {}, [t("dep.libFailed")]),
      el("pre", { class: "code-box" }, [
        info.failures.slice(0, 8).map((f) => `${f.path}\n  ${f.error}`).join("\n"),
      ]),
      el("div", { class: "hint" }, [t("dep.libFailedHint")]),
    ]));
  }
  return nodes;
}

function renderCompileOut(output) {
  const out = $("compileOut");
  const diags = collectDiagnostics(output);
  const errors = diags.filter((d) => d.severity === "error");
  const warns = diags.filter((d) => d.severity !== "error");

  const nodes = [];
  nodes.push(...libReportNodes());
  if (errors.length) {
    nodes.push(el("div", { class: "diag diag-err" }, [
      el("strong", {}, [t("dep.compileFail")]),
      el("pre", { class: "code-box" }, [errors.map((d) => d.text).join("\n\n")]),
    ]));
  }
  if (warns.length) {
    nodes.push(el("details", { class: "diag diag-warn" }, [
      el("summary", {}, [`${t("dep.compileOk")} · ⚠ ${warns.length}`]),
      el("pre", { class: "code-box" }, [warns.map((d) => d.text).join("\n\n")]),
    ]));
  }
  if (!state.contracts.length) {
    if (!errors.length) nodes.push(el("div", { class: "hint" }, [t("dep.compileFail")]));
    out.replaceChildren(...nodes);
    return;
  }

  if (!errors.length) nodes.push(el("div", { class: "diag diag-ok" }, [t("dep.compileOk")]));

  // 合約選擇器：檔案:合約名
  const opts = state.contracts.map((c) => el("option", { value: c.key }, [`${c.name}  (${c.file})`]));
  const sel = el("select", {
    id: "contractPick",
    onchange: (e) => pickContract(e.target.value),
  }, opts);
  nodes.push(el("div", { class: "field" }, [
    el("label", { for: "contractPick" }, [t("dep.selectContract")]),
    sel,
  ]));

  out.replaceChildren(...nodes);
  pickContract(state.contracts[0].key);
}

// 選中合約：把 bytecode / ABI / 建構函數表單帶進下方部署參數
function pickContract(key) {
  const c = state.contracts.find((x) => x.key === key) || state.contracts[0];
  if (!c) return;
  state.picked = c;

  const bc = c.bytecode.startsWith("0x") ? c.bytecode : "0x" + c.bytecode;
  $("bytecode").value = bc;
  $("ctorAbi").value = JSON.stringify(c.abi);

  const auto = $("bytecodeAuto");
  auto.textContent = t("dep.autoFilled") + ` · ${((bc.length - 2) / 2).toFixed(0)} bytes`;
  auto.hidden = false;

  const ctor = (c.abi || []).find((x) => x.type === "constructor");
  const inputs = (ctor && ctor.inputs) || [];
  const fields = $("ctorFields");
  fields.replaceChildren();

  if (!inputs.length) {
    fields.hidden = true;
    $("ctorMode").value = "none";
    $("ctorHexField").hidden = true;
    $("ctorAbiField").hidden = true;
    return;
  }

  // 有建構函數：走「ABI 自動編碼」，但把每個參數拆成獨立輸入框，使用者不用手寫 JSON
  $("ctorMode").value = "abi";
  $("ctorHexField").hidden = true;
  $("ctorAbiField").hidden = false;
  fields.hidden = false;

  fields.appendChild(el("label", {}, [t("dep.ctorFormHint")]));
  inputs.forEach((inp, i) => {
    fields.appendChild(el("div", { class: "ctor-row" }, [
      el("span", { class: "ctor-name" }, [inp.name || `arg${i}`]),
      el("input", {
        class: "ctor-input",
        type: "text",
        spellcheck: "false",
        "data-abi-type": inp.type,
        placeholder: placeholderFor(inp.type),
        oninput: syncCtorArgs,
      }),
      el("span", { class: "ctor-type" }, [inp.type]),
    ]));
  });
  syncCtorArgs();
}

// 把建構函數輸入框的值同步成 #ctorArgs（JSON 陣列），沿用既有的編碼流程
function syncCtorArgs() {
  const inputs = Array.from($("ctorFields").querySelectorAll("input[data-abi-type]"));
  const vals = inputs.map((i) => i.value);
  $("ctorArgs").value = JSON.stringify(vals);
}

function placeholderFor(type) {
  if (type === "bool") return "true";
  if (type === "address") return "0x…";
  if (/^u?int/.test(type)) return "0";
  if (/^string/.test(type)) return "hello";
  if (/^bytes/.test(type)) return "0x";
  return "[…]";
}

// 使用者輸入 -> ABI 值（數字用字串傳給 ethers，避免超過 Number 精度）
function parseAbiValue(type, raw) {
  const s = String(raw || "").trim();
  if (type === "bool") {
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0" || s === "") return false;
    throw new Error(`${type}: ${s}`);
  }
  if (type.endsWith("[]") || type.startsWith("tuple")) return JSON.parse(s || "[]");
  if (/^u?int\d*$/.test(type)) {
    if (!/^-?\d+$/.test(s)) throw new Error(`${type}: ${s}`);
    return s;
  }
  return s;
}

// ---------- ③ 部署 ----------
async function deploy() {
  const result = $("deployResult");
  const btn = $("deployBtn");

  const bcRaw = $("bytecode").value.trim();
  if (!bcRaw) { toast(t("dep.needInput")); return; }
  let bytecode = bcRaw.startsWith("0x") ? bcRaw.slice(2) : bcRaw;
  if (!/^[0-9a-fA-F]*$/.test(bytecode)) {
    result.replaceChildren(errorBox(t("dep.badBytecode")));
    return;
  }

  // 拼接構造函數參數
  const ctorMode = $("ctorMode").value;
  try {
    if (ctorMode === "hex") {
      let h = $("ctorHex").value.trim();
      h = h.startsWith("0x") ? h.slice(2) : h;
      if (h && !/^[0-9a-fA-F]*$/.test(h)) throw new Error(t("dep.badCtorHex"));
      bytecode += h;
    } else if (ctorMode === "abi") {
      const abiText = $("ctorAbi").value.trim();
      if (abiText) {
        const mod = await loadEthers();
        const iface = new mod.Interface(JSON.parse(abiText));
        // 有拆分輸入框時以輸入框為準，否則沿用 #ctorArgs 的 JSON
        const fields = Array.from($("ctorFields").querySelectorAll("input[data-abi-type]"));
        const args = fields.length
          ? fields.map((i) => parseAbiValue(i.dataset.abiType, i.value))
          : ($("ctorArgs").value.trim() ? JSON.parse($("ctorArgs").value) : []);
        bytecode += iface.encodeDeploy(args).replace(/^0x/, "");
      }
    }
  } catch (e) {
    result.replaceChildren(errorBox(t("dep.ctorFailed") + (e && e.message ? e.message : e)));
    return;
  }

  btn.disabled = true;
  btn.textContent = t("dep.submitting");
  try {
    const mode = $("signMode").value;
    if (mode === "wallet") await deployWithWallet("0x" + bytecode, result);
    else await deployWithKey("0x" + bytecode, result);
  } catch (e) {
    result.replaceChildren(errorBox(describeError(e)));
  } finally {
    btn.disabled = false;
    btn.textContent = t("dep.submit");
  }
}

function describeError(e) {
  if (e instanceof WalletError || (e && e.name === "WalletError")) {
    const code = e.code;
    if (code === "rejected") return t("wallet.errRejected");
    if (code === "noWallet") return t("wallet.notDetected");
    return t("wallet.errFailed") + (e.message || "");
  }
  return t("dep.failed") + (e && e.message ? e.message : e);
}

// 錢包插件簽名：私鑰不出錢包
async function deployWithWallet(data, result) {
  const p = getProvider();
  if (!p) {
    result.replaceChildren(errorBox(isMobile() ? t("wallet.notDetectedHint") : t("wallet.errNoWallet")));
    return;
  }

  // 已授權過就不再彈窗
  let accs = await getAccounts(p);
  if (!accs.length) accs = await requestAccounts(p);
  const from = accs[0];
  state.account = from;
  // 記下「這次部署的簽名身分」：部署成功後要用同一顆錢包對驗證訊息簽名，
  // 證明自己就是合約建立者（後端只認建立者提交的驗證）。
  state.signCtx = { kind: "wallet", provider: p, account: from };
  renderWalletState();

  // 錢包不在本鏈上：先切換 / 添加，否則簽出來的 chainId 不對
  await API.ensureChainId().catch(() => {});
  if (!(await isOnChain(p))) {
    await addOrSwitchChain();
    if (!(await isOnChain(p))) throw new WalletError("failed", t("wallet.errFailed"));
  }

  result.replaceChildren(spinner(t("dep.gettingParams")));
  const { gasLimit, gasPrice } = await resolveGas(from, data);

  toast(t("dep.confirmInWallet"));
  result.replaceChildren(spinner(t("dep.walletSigning")));
  const hash = await sendTransaction({
    from,
    data,
    gas: "0x" + gasLimit.toString(16),
    gasPrice: "0x" + gasPrice.toString(16),
  }, p);

  result.replaceChildren(spinner(t("dep.broadcastedWait")));
  const receipt = await pollReceipt(hash);
  result.replaceChildren(receipt ? buildSuccess(hash, receipt) : buildBroadcasted(hash));
}

// 私鑰本地簽名（既有行為）
async function deployWithKey(data, result) {
  const privRaw = $("privKey").value.trim();
  if (!privRaw) { result.replaceChildren(errorBox(t("dep.needInput"))); return; }

  let mod;
  try { mod = await loadEthers(); } catch { result.replaceChildren(errorBox(t("dep.libFailed"))); return; }
  const { Wallet } = mod;
  let wallet;
  try { wallet = new Wallet(privRaw); } catch { result.replaceChildren(errorBox(t("dep.badKey"))); return; }
  const from = wallet.address;
  // 私鑰路徑：私鑰就在本頁，之後對驗證訊息簽名不會再彈任何視窗。
  state.signCtx = { kind: "key", wallet };

  result.replaceChildren(spinner(t("dep.gettingParams")));
  const info = await API.getChainInfo();
  const { gasLimit, gasPrice } = await resolveGas(from, data, info.gasPrice);
  const nonce = await API.getNonce(from);

  const raw = await wallet.signTransaction({
    type: 0,
    nonce,
    gasPrice: "0x" + gasPrice.toString(16),
    gasLimit,
    to: null,
    value: "0x0",
    data,
    chainId: info.chainId,
  });
  const hash = await API.sendRawTransaction(raw);

  result.replaceChildren(spinner(t("dep.broadcastedWait")));
  const receipt = await pollReceipt(hash);
  result.replaceChildren(receipt ? buildSuccess(hash, receipt) : buildBroadcasted(hash));
}

// gas：手動就用輸入值，自動則向節點估算（含 20% 餘量）
async function resolveGas(from, data, fallbackPriceHex) {
  let gasPrice = BigInt(fallbackPriceHex || "0x0");
  if (gasPrice <= 0n) {
    const info = await API.getChainInfo();
    gasPrice = BigInt(info.gasPrice || "0x0");
  }
  if ($("priceMode").value === "manual") {
    const g = parseFloat($("gasPrice").value);
    if (!g || g <= 0) throw new Error(t("dep.badGasPrice"));
    gasPrice = BigInt(Math.floor(g * 1e9));
  }
  if (gasPrice <= 0n) gasPrice = 1000000000n; // 兜底 1 Gwei

  let gasLimit;
  if ($("gasMode").value === "manual") {
    gasLimit = parseInt($("gasLimit").value, 10);
    if (!gasLimit || gasLimit <= 0) throw new Error(t("dep.badGasLimit"));
  } else {
    try {
      const est = await API.estimateGas({ from, data, value: "0x0" });
      gasLimit = Math.max(21000, Math.floor(est * 1.2));
    } catch (e) {
      gasLimit = 3000000;
      toast(t("dep.gasFallback", { n: gasLimit }));
    }
  }
  return { gasLimit, gasPrice };
}

// ---------- 錢包狀態 ----------
async function renderWalletState() {
  const box = $("walletState");
  const sw = $("switchNetBtn");
  if (!box) return;
  const p = getProvider();
  if (!p) {
    box.textContent = isMobile() ? t("wallet.notDetectedHint") : t("wallet.notDetected");
    sw.hidden = true;
    return;
  }
  const name = walletName(p);
  const acc = state.account || (await getAccounts(p))[0] || "";
  const onChain = await isOnChain(p);
  box.textContent = acc
    ? `${t("wallet.detected", { name })} · ${t("dep.connectedAs", { addr: shortHash(acc, 6, 4) })}`
    : t("wallet.detected", { name });
  sw.hidden = !onChain;
}

async function connectWallet() {
  const box = $("walletState");
  if (!hasWallet()) {
    const link = walletDeepLink();
    box.textContent = isMobile() && link
      ? `${t("wallet.notDetectedHint")} ${link}`
      : t("wallet.notDetectedHint");
    return;
  }
  try {
    const accs = await requestAccounts(getProvider());
    state.account = accs[0];
    await renderWalletState();
  } catch (e) {
    const err = asWalletError(e);
    box.textContent = err.code === "rejected" ? t("wallet.errRejected") : t("wallet.errFailed") + (err.message || "");
  }
}

async function switchNetwork() {
  try {
    await addOrSwitchChain();
    await renderWalletState();
    toast(t("wallet.statusSwitched"));
  } catch (e) {
    const err = asWalletError(e);
    toast(err.code === "rejected" ? t("wallet.errRejected") : t("wallet.errFailed"));
  }
}

// ---------- 初始化 ----------
let _inited = false;

export function initDeploy() {
  if (!$("deployBtn")) return;
  if (_inited) return; // 避免重複綁定事件（語言切換時會被再次呼叫）
  _inited = true;

  // 語言切換時清掉動態結果（靜態表單文字由 i18n 的 data-i18n 統一刷新）
  window.addEventListener("langchange", () => {
    const r = $("deployResult");
    if (r) r.replaceChildren();
    const b = $("deployBtn");
    if (b && !b.disabled) b.textContent = t("dep.submit");
    const c = $("compileBtn");
    if (c && !c.disabled) c.textContent = t("dep.compileBtn");
    renderLibPicker();   // 版本選單的標題/提示文字要跟著換語言
    renderWalletState();
  });

  // ① 上傳
  const dz = $("dropzone");
  const pick = () => $("solFiles").click();
  dz.addEventListener("click", pick);
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
  });
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); dz.classList.add("dz-over");
  }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); dz.classList.remove("dz-over");
  }));
  // 拖進來就直接收下：檔案清單本身就是回饋，不再多彈一次 toast
  dz.addEventListener("drop", async (e) => {
    await addFiles(e.dataTransfer && e.dataTransfer.files);
  });
  $("solFiles").addEventListener("change", async (e) => {
    await addFiles(e.target.files);
    e.target.value = ""; // 允許再次選同一個檔案
  });
  $("compileBtn").addEventListener("click", compile);

  // 編譯器版本：先用內建清單開場，再非同步換成 CDN 上的最新版本表
  const verSel = $("solcVer");
  const fillVersions = (list) => {
    verSel.replaceChildren(...list.map((v) => el("option", { value: v }, [v])));
    verSel.value = list.includes(DEFAULT_SOLC_VERSION) ? DEFAULT_SOLC_VERSION : list[0];
  };
  fillVersions(SOLC_VERSIONS);
  fetchSolcVersions().then((list) => {
    const cur = verSel.value;
    fillVersions(list);
    if (list.includes(cur)) verSel.value = cur;
  }).catch(() => {});

  // EVM 版本：default 放最前面，表示「交給編譯器決定」（標準 JSON 不寫 evmVersion）
  const evmSel = $("evmVersion");
  if (evmSel) {
    evmSel.replaceChildren(
      el("option", { value: "default" }, ["default"]),
      ...EVM_VERSIONS.map((v) => el("option", { value: v }, [v])),
    );
  }

  // ② 簽名方式
  $("signMode").addEventListener("change", (e) => {
    const wallet = e.target.value === "wallet";
    $("walletBox").hidden = !wallet;
    $("keyBox").hidden = wallet;
    if (wallet) renderWalletState();
  });
  $("connectBtn").addEventListener("click", connectWallet);
  $("switchNetBtn").addEventListener("click", switchNetwork);

  $("genWallet").addEventListener("click", async () => {
    try {
      const { Wallet } = await loadEthers();
      const w = Wallet.createRandom();
      $("privKey").value = w.privateKey;
      toast(t("dep.walletCreated", { addr: w.address }));
    } catch (e) {
      toast(t("dep.walletFailed") + (e.message || e));
    }
  });

  // ③ 參數
  $("ctorMode").addEventListener("change", (e) => {
    const m = e.target.value;
    $("ctorHexField").hidden = m !== "hex";
    $("ctorAbiField").hidden = m !== "abi";
  });
  $("gasMode").addEventListener("change", (e) => { $("gasLimit").hidden = e.target.value !== "manual"; });
  $("priceMode").addEventListener("change", (e) => { $("gasPrice").hidden = e.target.value !== "manual"; });

  $("deployBtn").addEventListener("click", deploy);

  // ④ 發布到驗證服務：網址 / 金鑰都只存在本機，沒填就不會發任何請求
  const apiBase = $("apiBase");
  if (apiBase) {
    apiBase.value = VERIFY.baseUrl();
    apiBase.addEventListener("change", () => VERIFY.setBaseUrl(apiBase.value));
  }
  const apiKey = $("apiKey");
  if (apiKey) {
    apiKey.value = VERIFY.adminKey();
    apiKey.addEventListener("change", () => VERIFY.setAdminKey(apiKey.value));
  }
  if ($("publishBtn")) $("publishBtn").addEventListener("click", publishVerification);

  renderWalletState();
}

// 把這一筆的 ABI / 原始碼送上驗證服務，讓所有人看得到（本機那份仍然照寫）
async function publishVerification() {
  const out = $("publishState");
  if (!out) return;
  const c = state.picked;
  const addr = state.deployedAddr;

  if (!addr || !c) { out.textContent = t("dep.publishNeedDeploy"); return; }
  if (!VERIFY.baseUrl()) { out.textContent = t("dep.publishNoApi"); return; }
  if (!VERIFY.adminKey()) { out.textContent = t("dep.publishFail") + " — " + t("dep.publishKey"); return; }

  out.textContent = t("dep.publishing");
  const res = await VERIFY.publishContract(addr, {
    name: c.name,
    compiler: state.compileInfo.version,
    optimize: state.compileInfo.optimize,
    optimizeRuns: parseInt(state.compileInfo.runs, 10) || 200,
    evmVersion: state.compileInfo.evmVersion || "default",
    license: "",
    abi: c.abi,
    source: sourceBundle(c),
    sourceFiles: verificationSourceFiles(),
    verified: true,
    submitter: state.account || "deploy-page",
  });

  out.textContent = res.ok
    ? t("dep.publishOk")
    : t("dep.publishFail") + " — " + (res.detail || res.error || "");
}

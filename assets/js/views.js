// ===== 视图渲染层：被各独立页面（index/blocks/txs/validators/address）复用 =====
import {
  el, hashLink, mono, copyBtn, shortHash, fmtNum, fmtWei, fmtGwei, fmtTime, fmtAge, fmtDateTime, ago,
  hexToNum, isAddress, isTxHash, isBlockNum, spinner, errorBox, emptyBox,
  pagination, setTitle, toast, NATIVE_TOKEN, CHAIN_NAME, codeBlock, skeletonRows, skeletonCards,
  fillSkeletonCards,
} from "./utils.js";
import * as API from "./api.js";
import { t } from "./i18n.js";
import { CHAIN, chainIdNum } from "./config.js";
import { fetchContracts, isEnabled as isVerifyApiEnabled, fetchStats, triggerStatsScan } from "./verifyapi.js";
import { addToWalletButton, openNetworkModal } from "./network.js";
import { copyText } from "./ui.js";
import { getCachedStats, scanStats, formatEther } from "./stats.js";
import { readTokenMetas, cachedStandard, STANDARD_LABEL } from "./tokenmeta.js";
import * as GOV from "./gov.js";
import { getProvider, requestAccounts } from "./wallet.js";

let _refreshTimer = null;
export function clearTimer() { clearInterval(_refreshTimer); _refreshTimer = null; }

// ---------- 路由解析（解析 location.hash 的 path + location.search 的 query）----------
export function parseHash() {
  let h = location.hash.replace(/^#\/?/, "");
  const [path, qs] = h.split("?");
  const parts = path.split("/").filter(Boolean);
  const query = {};
  const merge = (s) => { if (s) s.split("&").forEach((kv) => { const [k, v] = kv.split("="); query[k] = decodeURIComponent(v || ""); }); };
  merge(qs);
  merge(location.search.replace(/^\?/, ""));
  return { name: parts[0] || "home", parts, query };
}

// ---------- 通用组件 ----------
function statCard(label, value, sub, accent, icon) {
  return el("div", { class: "stat-card" + (accent ? " accent-" + accent : "") }, [
    icon ? el("span", { class: "stat-ico", "aria-hidden": "true" }, [icon]) : null,
    el("div", { class: "stat-body" }, [
      el("div", { class: "stat-label" }, [label]),
      el("div", { class: "stat-value" }, [value]),
      sub ? el("div", { class: "stat-sub" }, [sub]) : null,
    ]),
  ]);
}

// 與 statCard 同款，但回傳 { card, value } 以便後續就地更新數值（網路統計會隨掃描進度變動）
function statCardRef(label, value, sub, accent, icon) {
  const valueEl = el("div", { class: "stat-value" }, [value]);
  const card = el("div", { class: "stat-card" + (accent ? " accent-" + accent : "") }, [
    icon ? el("span", { class: "stat-ico", "aria-hidden": "true" }, [icon]) : null,
    el("div", { class: "stat-body" }, [
      el("div", { class: "stat-label" }, [label]),
      valueEl,
      sub ? el("div", { class: "stat-sub" }, [sub]) : null,
    ]),
  ]);
  return { card, value: valueEl };
}

// 數值含單位（如「103.3 ETH」）時，把單位拆成小號淺色字（.stat-unit），版面更精緻
function setStatValue(valueEl, text) {
  const s = String(text ?? "");
  const suffix = " " + CHAIN.nativeSymbol;
  if (s.endsWith(suffix)) {
    valueEl.replaceChildren(s.slice(0, -suffix.length), el("span", { class: "stat-unit" }, [CHAIN.nativeSymbol]));
  } else {
    valueEl.textContent = s;
  }
}

// 首屏 Hero：鏈身分 + 實時高度 + 「一鍵添加到錢包」主 CTA
// info 允許為 null：首屏要先「同步」把 Hero 畫出來（h1 與主 CTA 立即可見），
// 高度先顯示「—」，等 getChainInfo() 回來再填真值。
// 注意：此處不顯示節點客戶端名稱與版本號（對外不暴露 Besu / vX.Y.Z）。
function hero(info, onRefresh) {
  const known = !!(info && info.blockNumber != null);
  const height = el("span", { class: "hero-height-value num", id: "heroHeight" },
    [known ? fmtNum(info.blockNumber) : "—"]);
  // 用 chainIdNum()：節點真值優先，取不到才退回設定值（info 可能為 null，首屏殼層就是這情況）
  const cid = (info && info.chainId) || chainIdNum();

  return el("section", { class: "hero" }, [
    el("div", { class: "hero-glow", "aria-hidden": "true" }),

    el("div", { class: "hero-top" }, [
      el("div", { class: "hero-id" }, [
        el("span", { class: "hero-logo", "aria-hidden": "true" }, ["◈"]),
        el("div", { class: "hero-id-text" }, [
          el("h1", { class: "hero-title" }, [
            CHAIN.name,
            el("span", { class: "hero-tag" }, [t("hero.tag")]),
          ]),
          el("p", { class: "hero-meta", id: "heroMeta" }, [
            t("hero.meta", { id: fmtNum(cid) }),
          ]),
        ]),
      ]),
      el("div", { class: "hero-top-right" }, [
        el("span", { class: "badge badge-qbft" }, [t("home.consensus")]),
        el("button", {
          class: "icon-btn", type: "button",
          title: t("home.refreshTitle"), "aria-label": t("home.refreshTitle"),
          onclick: onRefresh,
        }, ["↻"]),
      ]),
    ]),

    el("div", { class: "hero-live" }, [
      el("span", { class: "dot-live", "aria-hidden": "true" }),
      el("span", { class: "hero-live-label" }, [t("hero.height")]),
      el("span", { class: "hero-live-hash", "aria-hidden": "true" }, ["#"]),
      height,
      el("span", { class: "hero-live-state" }, [t("hero.live")]),
    ]),

    el("div", { class: "hero-actions" }, [
      addToWalletButton("hero"),
      el("button", {
        class: "btn btn-ghost-on-dark", type: "button",
        onclick: openNetworkModal,
      }, [t("hero.params")]),
      el("button", {
        class: "btn btn-ghost-on-dark", type: "button",
        onclick: () => copyText(CHAIN.rpcUrl, t("wallet.copiedRpc")),
      }, [t("hero.copyRpc")]),
    ]),
  ]);
}

// 响应式表格：headers = [字符串]，rows = [[DOM,...]]
function rtable(headers, rows, opts = {}) {
  const cols = opts.cols || `repeat(${headers.length}, minmax(0, 1fr))`;
  const wrap = el("div", { class: "rtable-wrap" });
  const table = el("div", { class: "rtable" });
  table.style.setProperty("--cols", cols);
  const head = el("div", { class: "rhead" }, headers.map((h) => el("div", { class: "rcell" }, [h])));
  table.appendChild(head);
  if (!rows.length) {
    table.appendChild(el("div", { class: "rempty" }, [opts.emptyText || t("common.noData")]));
  }
  for (const r of rows) {
    table.appendChild(el("div", { class: "rrow" },
      r.map((c, i) => el("div", { class: "rcell", "data-label": headers[i] || "" }, [c]))));
  }
  wrap.appendChild(table);
  return wrap;
}

function kvTable(pairs) {
  const t_ = el("div", { class: "kv" });
  for (const [k, v] of pairs) {
    t_.appendChild(el("div", { class: "kv-row" }, [
      el("div", { class: "kv-key" }, [k]),
      el("div", { class: "kv-val" }, [v == null ? "—" : v]),
    ]));
  }
  return t_;
}

// 表格列头（按当前语言取词）
function blockHeaders() {
  return [t("th.block"), t("th.validator"), t("th.time"), t("th.txCount"), t("th.gasUsed")];
}
function txHeaders() {
  return [t("th.txHash"), t("th.block"), t("th.time"), t("th.from"), "", t("th.to"), t("th.value")];
}

function blockRow(b) {
  const num = hexToNum(b.number);
  return [
    el("a", { class: "link", href: `blocks.html#/block/${num}` }, ["#" + fmtNum(num)]),
    hashLink(b.miner, "address", { head: 6, tail: 4 }),
    el("span", { class: "muted", title: fmtDateTime(b.timestamp) }, [fmtAge(b.timestamp)]),
    el("span", {}, [String((b.transactions || []).length)]),
    el("span", { class: "muted" }, [fmtNum(hexToNum(b.gasUsed))]),
  ];
}

function txRow(tx) {
  const num = hexToNum(tx.blockNumber);
  return [
    hashLink(tx.hash, "tx", { head: 6, tail: 4 }),
    el("a", { class: "link", href: `blocks.html#/block/${num}` }, ["#" + fmtNum(num)]),
    el("span", { class: "muted", title: fmtDateTime(tx.blockTimestamp) }, [fmtAge(tx.blockTimestamp)]),
    hashLink(tx.from, "address", { head: 6, tail: 4 }),
    el("span", { class: "muted" }, ["→"]),
    tx.to ? hashLink(tx.to, "address", { head: 6, tail: 4 }) : el("span", { class: "tag tag-contract" }, [t("tx.contractCreation")]),
    el("span", { class: "num" }, [fmtWei(tx.value)]),
  ];
}

function section(title, right) {
  return el("section", { class: "panel" }, [
    el("div", { class: "panel-head" }, [
      el("h2", {}, [title]),
      right || null,
    ]),
  ]);
}

// 只替換面板內容、保留面板標題（自動刷新時不重建整個面板）
function setPanelBody(panel, content) {
  let body = panel.querySelector(":scope > .panel-body");
  if (!body) {
    body = el("div", { class: "panel-body" });
    panel.appendChild(body);
  }
  body.replaceChildren(content);
}

// 頁面標題列（標題 + 可選右側動作）
function pageHead(title, right) {
  return el("div", { class: "page-title" }, [
    el("h1", {}, [title]),
    right ? el("div", { class: "title-actions" }, [].concat(right)) : null,
  ]);
}

// 自動刷新指示燈（帶文字，讓用戶知道資料是活的）
function livePill(textKey) {
  return el("span", { class: "live-pill" }, [
    el("span", { class: "dot-live", "aria-hidden": "true" }),
    t(textKey),
  ]);
}

// ---------- 通证（tokens.html）----------
// 資料來源有兩個，合併去重：
//   ① config.js 的 CHAIN.featuredTokens：手動精選（永遠優先，也可用 name / symbol 覆寫鏈上值）
//   ② 驗證後端（VerifyApi）的合約目錄：後端 ContractIndexer **部署即收錄**，
//      所以「剛部署完的通證找不到」不再是常態 —— 新合約不用再手動改白名單。
//
// 為什麼不是純前端自己掃鏈：要列舉全鏈合約得逐塊找 to=null 的建立交易再讀回執，
// 成本與延遲都不可接受（詳細設計見 api.js 的區塊快取註解）。後端做過一次、
// 前端只需要對目錄裡每個地址問一句「你是不是 ERC-165 宣告的代幣」。
//
// 識別交給 tokenmeta.js（支援 ERC-20 / 721 / 1155）：
//   1. 每 20 個合約才一個 HTTP 往返（20×8 = 160 筆 eth_call 打成一批）；
//   2. 標準結果長期快取，第二次載入只對「已知是代幣」的那些重讀元數據。
// 本頁刻意不載入 ethers（500KB+）：只讀幾個固定欄位，為此引入整個套件並不划算。

// 掃描後端目錄時最多考慮幾個合約（防止目錄成千上萬時這一頁被拖垮）。
const TOKEN_SCAN_CAP = 200;

// 向後端合約目錄要「候選清單」；後端沒設定就只用手動精選那一批。
async function discoverTokenAddresses() {
  if (!isVerifyApiEnabled()) return [];
  const out = [];
  const SIZE = 100;
  for (let page = 1; out.length < TOKEN_SCAN_CAP; page++) {
    // 取目錄失敗（後端掛了 / CORS）不該整頁報錯：用手動精選繼續畫就好
    const data = await fetchContracts(page, SIZE).catch(() => null);
    if (!data || !Array.isArray(data.items) || !data.items.length) break;
    for (const it of data.items) {
      if (it && it.address) out.push(String(it.address));
      if (out.length >= TOKEN_SCAN_CAP) break;
    }
    if (out.length >= (data.total || 0)) break;
  }
  return out.slice(0, TOKEN_SCAN_CAP);
}

// 抓每個候選的標準 + 資料，回傳「確定是代幣」的那些（順序：精選在前，其次後端目錄）。
async function getTokenMetas() {
  const featuredRaw = (CHAIN.featuredTokens || [])
    .map((e) => (typeof e === "string" ? { address: e } : e))
    .filter((e) => e && e.address);
  const featuredSet = new Set(featuredRaw.map((e) => String(e.address).toLowerCase()));

  const discovered = await discoverTokenAddresses();
  const addrs = [];
  const seen = new Set();
  for (const addr of featuredRaw.map((e) => e.address).concat(discovered)) {
    const k = String(addr).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    // 24 小時內已判定「不是代幣」的就別再問一次（這是讓本頁能常態掃目錄的前提）；
    // 精選名單例外：手動列的就算還探不到也要試。
    const cached = cachedStandard(k);
    if (cached === null && !featuredSet.has(k)) continue;
    addrs.push(addr);
  }
  if (!addrs.length) return [];

  const metas = await readTokenMetas(addrs, { featured: featuredSet });
  const override = new Map(featuredRaw.filter((e) => e.name || e.symbol).map((e) => [String(e.address).toLowerCase(), e]));
  const out = [];
  for (const m of metas) {
    if (!m || !m.standard) continue;
    const ov = override.get(String(m.address).toLowerCase());
    out.push(ov ? Object.assign({}, m, { name: ov.name || m.name, symbol: ov.symbol || m.symbol }) : m);
  }
  return out;
}

// 將 uint256 + decimals 轉成人類可讀字串（本頁未載入 ethers，這裡用純 BigInt；
// ethers 的 formatUnits 也是同樣的「整數除法 + 補零」，數值不會失真）
function fmtTokenAmount(value, decimals) {
  try {
    if (value == null) return "—";
    const v = typeof value === "bigint" ? value : BigInt(value || "0x0");
    const d = decimals == null ? 18 : Number(decimals);
    if (d <= 0) return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const base = 10n ** BigInt(d);
    const whole = v / base;
    const frac = v % base;
    const fracStr = frac.toString().padStart(d, "0").replace(/0+$/, "");
    const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return fracStr ? `${wholeStr}.${fracStr}` : wholeStr;
  } catch {
    return "—";
  }
}

// 名稱 + 符號：名稱連到該合約的地址頁（會由 contract.js 接手渲染合約 / 代幣詳情）
// 沒名字（有些合約只實作標準介面、沒寫 name()）就退回顯示截短的地址，
// 不再顯示「未實現代幣介面」—— 能出現在這一列的都已經是符合標準的代幣了。
function tokenRowCell(meta) {
  return el("div", { class: "token-name-cell" }, [
    el("div", { class: "token-name-line" }, [
      el("a", { class: "link", href: `address.html#/address/${meta.address}` },
        [meta.name || el("span", { class: "muted" }, [shortHash(meta.address, 8, 6)])]),
      meta.symbol ? el("span", { class: "tag token-sym" }, [meta.symbol]) : null,
    ]),
  ]);
}

// ---------- 概览（index.html）----------
// 快取最近一次資料：切換語言會重新執行 viewHome，若已有資料就直接用快取渲染，
// 不再閃一次骨架屏（僅首次載入才顯示骨架）。
let _homeData = null;

export async function viewHome() {
  clearTimer();
  const view = document.getElementById("view");
  if (!view) return;

  const node = el("div", { class: "container" });

  // ⚡ 首屏「同步」先上：Hero（含 h1 與「一鍵添加到錢包」主 CTA）+ 統計格 + 兩個面板。
  // 取得鏈資料要等兩趟 RPC（實測約 4 秒），若等資料回來才畫 Hero，使用者會先盯著一片空白，
  // h1 與主 CTA 也會整整晚 4 秒才出現（SEO 與首印像都受損）。
  // 所以 Hero 先以「無數字」狀態上畫面，資料到了只更新數字，不重建任何節點。
  const heroEl = hero(null, () => render().catch((e) => console.error(t("home.refreshFailed"), e)));
  const gridEl = el("div", { class: "stat-grid" });

  // 網路統計面板：ETH 總量 + 銷毀量 + 地址數（用戶數）；優先採用後端持久化資料，
  // 後端未設定時回退本機掃描。掃描進度會隨背景掃描即時更新。
  const supplyRef = statCardRef(t("home.totalSupply"), "—", t("home.totalSupplySub"), "blue", "Ξ");
  const burnedRef = statCardRef(t("home.burned"), "—", t("home.burnedSub"), "red", "🔥");
  const accountsRef = statCardRef(t("home.accounts"), "—", t("home.accountsSub"), "teal", "👥");
  const statsGrid = el("div", { class: "stat-grid three" }, [supplyRef.card, burnedRef.card, accountsRef.card]);
  // 掃描進度：進度條 + 狀態列（掃描中有脈動圓點與流光；完成後轉為 ✓ 綠字）。
  // 結構固定、只更新文字與 class —— 遵守「原地更新、不整塊重建」的慣例。
  const statsProg = el("div", { class: "stats-progress idle" });
  const progFill = el("div", { class: "prog-fill" });
  const progBar = el("div", { class: "prog-bar" }, [progFill]);
  const progState = el("span", { class: "prog-state" }, [t("home.scanStale")]);
  const statsSource = el("span", { class: "stats-source" }, [""]);
  const progMeta = el("div", { class: "prog-meta" }, [progState, statsSource]);
  statsProg.replaceChildren(progBar, progMeta);
  const rescanBtn = el("button", {
    class: "more rescan-btn", type: "button",
    title: t("home.rescan"), "aria-label": t("home.rescan"),
    onclick: () => startScan(true),
  }, [el("span", { class: "rescan-ico", "aria-hidden": "true" }, ["↻"]), t("home.rescan")]);
  const statsSec = section(t("home.networkStats"), rescanBtn);
  setPanelBody(statsSec, el("div", { class: "stats-wrap" }, [statsGrid, statsProg]));

  const blkSec = section(t("home.latestBlocks"), el("a", { class: "more", href: "blocks.html" }, [t("common.viewAll")]));
  const txSec = section(t("home.latestTxs"), el("a", { class: "more", href: "txs.html" }, [t("common.viewAll")]));
  node.replaceChildren(heroEl, gridEl, statsSec, blkSec, txSec);
  view.replaceChildren(node);
  setTitle(t("home.title"));

  // 面板先掛骨架（有快取時，下面那次 paint 會在同一輪同步覆蓋，不會閃）
  fillSkeletonCards(gridEl, 4);
  setPanelBody(blkSec, skeletonRows(6, 5));
  setPanelBody(txSec, skeletonRows(4, 5));

  async function render() {
    const info = await API.getChainInfo();
    // 通證清單已獨立成 tokens.html（導航「資料 → 通證」），首頁不再讀代幣元資料，
    // 少一組 RPC 也讓首屏更快。
    const [latestBlocks, txs, valStats] = await Promise.all([
      API.getBlocksDesc(info.blockNumber, 8),
      API.getRecentTransactions(12, 300).catch(() => []),
      API.getValidatorStats(200).catch(() => null),
    ]);
    _homeData = { info, latestBlocks, txs, valStats };
    paint(info, latestBlocks, txs, valStats);
  }

  function paint(info, latestBlocks, txs, valStats) {
    // Hero 是同步建好的，這裡只把資料填進去
    const h = node.querySelector("#heroHeight");
    if (h) h.textContent = fmtNum(info.blockNumber);
    const meta = node.querySelector("#heroMeta");
    if (meta) meta.textContent = t("hero.meta", { id: fmtNum(info.chainId) });

    const avgTime = valStats ? valStats.avgBlockTime : 0;
    gridEl.replaceChildren(
      statCard(t("home.avgBlockTime"), avgTime ? avgTime.toFixed(2) + " " + t("unit.sec") : "—", t("home.avgBlockTimeSub"), "green", "⏱"),
      statCard(t("home.gasPrice"), fmtGwei(info.gasPrice), t("home.gasPriceSub"), "purple", "⛽"),
      statCard(t("home.peers"), fmtNum(info.peerCount), t("home.peersSub"), "orange", "🌐"),
      statCard(t("home.validators"), valStats ? String(Object.keys(valStats.stats).length) : "—", t("home.validatorsSub"), "red", "🛡"),
    );

    setPanelBody(blkSec, rtable(
      blockHeaders(),
      latestBlocks.map(blockRow),
      { cols: "1.2fr 1.5fr 1fr 0.8fr 1.1fr" },
    ));

    setPanelBody(txSec, txs.length
      ? rtable(txHeaders(), txs.map(txRow), { cols: "1.6fr 0.9fr 1fr 1.4fr 0.4fr 1.4fr 1.2fr" })
      : emptyBox(t("home.noTxs")));

    setTitle(t("home.title"));
  }

  // 有快取（語言切換 / 返回本頁）→ 立刻用快取填滿，連骨架都不會出現
  if (_homeData) paint(_homeData.info, _homeData.latestBlocks, _homeData.txs, _homeData.valStats);

  try {
    await render();
  } catch (e) {
    console.error(e);
    // 節點不可用時，Hero 必須留在畫面上——這正是最需要「一鍵添加到錢包」的時刻：
    // 瀏覽器本身還連不上鏈，但使用者仍要能把這條網絡加進錢包。
    // 只把錯誤塞進區塊面板，其他面板保持骨架；3 秒後的重試會自動把它換回真資料。
    if (!_homeData) setPanelBody(blkSec, errorBox(e.message || String(e)));
  }

  // ---------- 網路統計（ETH 總量 / 銷毀量 / 地址數）----------
  // 後端優先：設定了驗證後端就讀 /api/stats（總量/銷毀/地址數 + 續掃進度），
  // 後端未設定或暫時取不到則靜默回退本機掃描（純前端）。
  // 進度區統一渲染：掃描中→進度條+百分比；完成→✓ 與最後更新時間（只改文字與 class）。
  function renderProgress(scanned, latest, updatedAt) {
    if (latest > 0 && scanned < latest) {
      const pct = latest > 0 ? Math.min(100, Math.floor(((scanned + 1) / Math.max(1, latest + 1)) * 100)) : 0;
      progFill.style.width = pct + "%";
      progState.className = "prog-state";
      progState.textContent = t("home.scanning") + ` ${pct}%  (${fmtNum(scanned + 1)} / ${fmtNum(latest + 1)})`;
      statsProg.className = "stats-progress scanning";
    } else {
      progFill.style.width = "100%";
      const when = updatedAt ? new Date(updatedAt).toLocaleTimeString() : "";
      progState.className = "prog-state";
      progState.textContent = t("home.scanDone") + (when ? " · " + t("home.lastUpdate") + " " + when : "");
      statsProg.className = "stats-progress done";
    }
  }
  function renderProgressIdle() {
    progFill.style.width = "0%";
    progState.className = "prog-state";
    progState.textContent = t("home.scanStale");
    statsProg.className = "stats-progress idle";
  }
  function renderProgressError() {
    progFill.style.width = "0%";
    progState.className = "prog-state warn";
    progState.textContent = t("home.statsFetchFailed");
    statsProg.className = "stats-progress idle";
  }
  function renderBackendProgress(st) { renderProgress(st.lastScannedBlock, st.latestBlock, st.updatedAt); }
  function renderBackendStats(st) {
    setStatValue(supplyRef.value, formatEther(st.totalSupplyWei, CHAIN.nativeSymbol));
    setStatValue(burnedRef.value, formatEther(st.burnedWei, CHAIN.nativeSymbol));
    accountsRef.value.textContent = fmtNum(st.addressCount);
    renderBackendProgress(st);
    statsSource.textContent = t("home.sourceBackend");
  }
  function renderLocalProgress(c) { renderProgress(c.scannedTo, c.latest, c.updatedAt); }
  function renderLocalStats() {
    const c = getCachedStats();
    if (!c) {
      supplyRef.value.textContent = "—";
      burnedRef.value.textContent = "—";
      accountsRef.value.textContent = "—";
      renderProgressIdle();
      return;
    }
    setStatValue(supplyRef.value, formatEther(c.totalWei, CHAIN.nativeSymbol));
    burnedRef.value.textContent = "—";
    accountsRef.value.textContent = fmtNum(c.accounts);
    renderLocalProgress(c);
    statsSource.textContent = t("home.sourceLocal");
  }
  async function updateFromScan(s) {
    setStatValue(supplyRef.value, formatEther(s.totalWei, CHAIN.nativeSymbol));
    accountsRef.value.textContent = fmtNum(s.accounts);
    renderLocalProgress(s);
  }
  // 後端優先刷新；後端不可用時回退本機緩存顯示
  async function refreshStats() {
    if (isVerifyApiEnabled()) {
      const st = await fetchStats();
      if (st) { renderBackendStats(st); return; }
      statsSource.textContent = t("home.sourceBackend");
      renderProgressError();
      return;
    }
    renderLocalStats();
  }
  async function startScan(force) {
    // 進行中防重入；按鈕轉忙碌態（圖示旋轉、不可點）
    if (rescanBtn.classList.contains("busy")) return;
    rescanBtn.classList.add("busy");
    try {
      if (isVerifyApiEnabled()) {
        // 後端模式：只有手動「重新掃描」(force) 才觸發增量續掃，平常只讀取自動掃描的結果
        if (force) await triggerStatsScan();
        await refreshStats();
      } else {
        // 本機模式：原有純前端掃描（冪等，只在過期時增量補掃）
        renderLocalStats();
        try { await scanStats({ onProgress: updateFromScan, force: !!force }); }
        catch (e) { console.error("stats scan failed", e); }
      }
    } finally {
      rescanBtn.classList.remove("busy");
    }
  }

  refreshStats();
  startScan(false);

  let busy = false;
  _refreshTimer = setInterval(() => {
    if (busy) return;
    busy = true;
    render().catch((e) => console.error(t("home.refreshFailed"), e))
      .then(() => refreshStats()).catch((e) => console.error("stats refresh failed", e))
      .finally(() => { busy = false; });
  }, 3000);
}

// ---------- 区块列表（blocks.html）----------
export async function viewBlocks(query) {
  clearTimer();
  const view = document.getElementById("view");
  if (!view) return;
  const page = Math.max(1, parseInt(query.page || "1", 10));
  const SIZE = 25;

  // 首屏骨架必須「同步」先上：取得列表要等兩次 RPC（最新高度 + 區塊批次），
  // 若等資料回來才畫骨架，使用者會先盯著一整片空白。骨架 → 再填資料。
  const headLabel = el("span", {});
  const sec = section(headLabel);
  sec.querySelector(".panel-head").appendChild(livePill("hero.live"));
  setPanelBody(sec, skeletonRows(8, 5));
  const node = el("div", { class: "container" }, [pageHead(t("blocks.title")), sec]);
  view.replaceChildren(node);
  setTitle(t("blocks.title"));

  const render = async () => {
    const latest = await API.getLatestBlockNumber();
    const totalPages = Math.max(1, Math.ceil(latest / SIZE));
    const start = latest - (page - 1) * SIZE;
    const blocks = await API.getBlocksDesc(start, SIZE);

    headLabel.textContent = t("blocks.listTitle", { page, total: fmtNum(totalPages) });

    // 分頁與表格一起替換，避免重複堆疊
    const body = el("div", {});
    body.appendChild(rtable(
      blockHeaders(),
      blocks.map(blockRow),
      { cols: "1.2fr 1.5fr 1fr 0.8fr 1.1fr" },
    ));
    body.appendChild(pagination({
      page, totalPages,
      onPage: (p) => { location.href = `blocks.html?page=${p}`; },
    }));
    setPanelBody(sec, body);
  };

  await render().catch((e) => {
    console.error(e);
    view.replaceChildren(errorBox(e.message || String(e)));
  });

  let busy = false;
  _refreshTimer = setInterval(() => {
    if (busy) return;
    busy = true;
    render().catch((e) => console.error(t("blocks.refreshFailed"), e)).finally(() => { busy = false; });
  }, 3000);
}

// ---------- 区块详情（blocks.html#/block/<ref>）----------
export async function viewBlock(ref) {
  clearTimer();
  const view = document.getElementById("view");
  if (!view) return;
  await withSpinner(view, async () => {
    let b;
    if (/^0x[0-9a-fA-F]{64}$/.test(ref)) {
      b = await API.getBlockByHash(ref, true);
    } else {
      const num = isBlockNum(ref) ? (ref.startsWith("0x") ? parseInt(ref, 16) : Number(ref)) : NaN;
      b = await API.getBlock(num, true);
    }
    if (!b) throw new Error(t("block.notFound"));
    const num_ = hexToNum(b.number);
    const node = el("div", { class: "container" });
    node.appendChild(pageHead(t("block.title", { n: fmtNum(num_) }), [
      el("a", { class: "btn btn-ghost btn-sm", href: `blocks.html#/block/${num_ - 1}` }, [t("block.prev")]),
      el("a", { class: "btn btn-ghost btn-sm", href: `blocks.html#/block/${num_ + 1}` }, [t("block.next")]),
    ]));
    const baseFee = b.baseFeePerGas ? fmtGwei(b.baseFeePerGas) : "—";
    const gasLimit_ = hexToNum(b.gasLimit), gasUsed_ = hexToNum(b.gasUsed);
    const gasPct = gasLimit_ ? ((gasUsed_ / gasLimit_) * 100).toFixed(2) + "%" : "—";
    node.appendChild(kvTable([
      [t("block.height"), el("span", { class: "num" }, [fmtNum(num_)])],
      [t("block.timestamp"), fmtTime(b.timestamp, { relative: true })],
      [t("block.hash"), mono(b.hash)],
      [t("block.miner"), hashLink(b.miner, "address", { head: 10, tail: 8 })],
      [t("block.parent"), hashLink(b.parentHash, "block", { head: 10, tail: 8 })],
      [t("block.gas"), `${fmtNum(gasUsed_)} / ${fmtNum(gasLimit_)} (${gasPct})`],
      [t("block.baseFee"), baseFee],
      [t("block.size"), fmtNum(hexToNum(b.size)) + " bytes"],
      [t("block.difficulty"), fmtNum(hexToNum(b.difficulty))],
      [t("block.totalDifficulty"), fmtNum(hexToNum(b.totalDifficulty))],
      [t("block.nonce"), b.nonce],
      [t("block.extraData"), mono(b.extraData, false)],
      [t("block.stateRoot"), mono(b.stateRoot, false)],
      [t("block.receiptsRoot"), mono(b.receiptsRoot, false)],
    ]));

    const txSec = section(t("block.txsInBlock", { n: b.transactions.length }));
    if (b.transactions.length) {
      txSec.appendChild(rtable(
        txHeaders(),
        b.transactions.map((tx) => txRow({ ...tx, blockNumber: b.number, blockTimestamp: b.timestamp })),
        { cols: "1.6fr 0.9fr 1fr 1.4fr 0.4fr 1.4fr 1.2fr" },
      ));
    } else {
      txSec.appendChild(emptyBox(t("block.emptyBlock")));
    }
    node.appendChild(txSec);
    setTitle(t("block.title", { n: fmtNum(num_) }));
    return node;
  });
}

// ---------- 交易列表（txs.html）----------
export async function viewTxs(query) {
  clearTimer();
  const view = document.getElementById("view");
  if (!view) return;
  const page = Math.max(1, parseInt(query.page || "1", 10));
  const SIZE = 25;

  const node = el("div", { class: "container" });
  const sec = section(t("txs.title"));
  setPanelBody(sec, skeletonRows(8, 7));
  node.replaceChildren(pageHead(t("txs.title")), sec);
  view.replaceChildren(node);

  try {
    const all = await API.getRecentTransactions(50, 600).catch(() => []);
    const totalPages = Math.max(1, Math.ceil(all.length / SIZE));
    const p = Math.min(page, totalPages);
    const slice = all.slice((p - 1) * SIZE, p * SIZE);
    sec.querySelector("h2").textContent = t("txs.listTitle", { n: fmtNum(all.length) });

    const body = el("div", {});
    if (slice.length) {
      body.appendChild(rtable(
        txHeaders(),
        slice.map(txRow),
        { cols: "1.6fr 0.9fr 1fr 1.4fr 0.4fr 1.4fr 1.2fr" },
      ));
    } else {
      body.appendChild(emptyBox(t("home.noTxs")));
    }
    body.appendChild(pagination({
      page: p, totalPages,
      onPage: (pp) => { location.href = `txs.html?page=${pp}`; },
    }));
    setPanelBody(sec, body);
    setTitle(t("txs.title"));
  } catch (e) {
    console.error(e);
    setPanelBody(sec, errorBox(e.message || String(e)));
  }
}

// ---------- 交易详情（txs.html#/tx/<hash>）----------
export async function viewTx(hash) {
  clearTimer();
  const view = document.getElementById("view");
  if (!view) return;
  await withSpinner(view, async () => {
    if (!isTxHash(hash)) throw new Error(t("tx.badHash"));
    const [tx, receipt] = await Promise.all([
      API.getTx(hash),
      API.getTxReceipt(hash).catch(() => null),
    ]);
    if (!tx) throw new Error(t("tx.notFound"));
    const block = receipt ? await API.getBlock(hexToNum(tx.blockNumber), false).catch(() => null) : null;
    const node = el("div", { class: "container" });
    const ok = receipt ? hexToNum(receipt.status) === 1 : null;
    const statusText = ok === null ? t("tx.pending") : ok ? t("tx.ok") : t("tx.fail");
    const statusCls = ok === null ? "pending" : ok ? "ok" : "fail";
    node.appendChild(el("div", { class: "page-title" }, [
      el("h1", {}, [t("tx.title")]),
      el("span", { class: "tag tag-" + statusCls }, [statusText]),
    ]));
    const effGas = receipt && receipt.effectiveGasPrice ? receipt.effectiveGasPrice : tx.gasPrice;
    const fee = receipt ? (BigInt(receipt.gasUsed || "0x0") * BigInt(effGas || "0x0")) : 0n;
    node.appendChild(kvTable([
      [t("th.txHash"), mono(tx.hash)],
      [t("tx.status"), el("span", { class: "tag tag-" + statusCls }, [statusText])],
      [t("tx.block"), el("a", { class: "link", href: `blocks.html#/block/${hexToNum(tx.blockNumber)}` }, ["#" + fmtNum(hexToNum(tx.blockNumber))])],
      [t("tx.timestamp"), block ? fmtTime(block.timestamp, { relative: true }) : "—"],
      [t("tx.from"), hashLink(tx.from, "address", { head: 10, tail: 8 })],
      [t("tx.to"), tx.to ? hashLink(tx.to, "address", { head: 10, tail: 8 }) : el("span", { class: "tag tag-contract" }, [t("tx.contractCreation")])],
      [t("tx.value"), fmtWei(tx.value)],
      [t("tx.gasLimit"), fmtNum(hexToNum(tx.gas || "0x0"))],
      [t("tx.gasUsed"), receipt ? fmtNum(hexToNum(receipt.gasUsed)) : "—"],
      [t("tx.gasPrice"), tx.gasPrice ? fmtGwei(tx.gasPrice) : "—"],
      [t("tx.fee"), fee ? fmtWei("0x" + fee.toString(16)) : "—"],
      [t("tx.nonce"), fmtNum(hexToNum(tx.nonce))],
      [t("tx.input"), mono(tx.input && tx.input !== "0x" ? tx.input : "0x", false)],
    ]));
    if (receipt && receipt.logs && receipt.logs.length) {
      const logSec = section(t("tx.logs", { n: receipt.logs.length }));
      const rows = receipt.logs.map((l) => [
        el("span", { class: "num" }, [String(l.logIndex ? hexToNum(l.logIndex) : 0)]),
        hashLink(l.address, "address", { head: 6, tail: 4 }),
        el("span", { class: "mono small" }, [(l.topics || []).map((tp) => shortHash(tp, 10, 6)).join(" ") || "—"]),
      ]);
      logSec.appendChild(rtable([t("th.index"), t("th.contract"), t("th.topics")], rows, { cols: "0.5fr 1.4fr 2.2fr" }));
      node.appendChild(logSec);
    }
    setTitle(t("txs.title"));
    return node;
  });
}

// ---------- 通证列表（tokens.html）----------
export async function viewTokens(query) {
  clearTimer();
  const view = document.getElementById("view");
  if (!view) return;
  const page = Math.max(1, parseInt(query.page || "1", 10));
  const SIZE = 25;

  // 與區塊 / 交易列表同一套節奏：骨架同步先上，資料回來只換面板內容（不重建面板）。
  const headLabel = el("span", {});
  const sec = section(headLabel);
  sec.querySelector(".panel-head").appendChild(livePill("hero.live"));
  setPanelBody(sec, skeletonRows(4, 4));
  const node = el("div", { class: "container" }, [pageHead(t("tokens.title")), sec]);
  view.replaceChildren(node);
  setTitle(t("tokens.title"));

  const render = async () => {
    const metas = await getTokenMetas();
    const totalPages = Math.max(1, Math.ceil(metas.length / SIZE));
    const p = Math.min(page, totalPages);
    const slice = metas.slice((p - 1) * SIZE, p * SIZE);
    headLabel.textContent = t("tokens.listTitle", { n: fmtNum(metas.length) });

    if (!slice.length) { setPanelBody(sec, emptyBox(t("tokens.empty"))); return; }

    const body = el("div", {});
    body.appendChild(rtable(
      [t("tokens.col"), t("tokens.standard"), t("tokens.contract"), t("token.totalSupply"), t("token.decimals")],
      slice.map((m) => [
        tokenRowCell(m),
        el("span", { class: "tag tag-std" }, [STANDARD_LABEL[m.standard] || m.standard]),
        hashLink(m.address, "address", { head: 10, tail: 8 }),
        // ERC-1155 / 721 沒有精度概念：721 用張數（=小數 0），1155 讀不到就直接留白
        el("span", { class: "num" }, [fmtTokenAmount(m.totalSupply, m.decimals != null ? m.decimals : 0)]),
        el("span", { class: "num" }, [m.decimals != null ? String(m.decimals) : "—"]),
      ]),
      { cols: "1.9fr 0.9fr 1.7fr 1.1fr 0.6fr" },
    ));
    if (totalPages > 1) {
      body.appendChild(pagination({
        page: p, totalPages,
        onPage: (pp) => { location.href = `tokens.html?page=${pp}`; },
      }));
    }
    setPanelBody(sec, body);
  };

  await render().catch((e) => {
    console.error(e);
    setPanelBody(sec, errorBox(e.message || String(e)));
  });

  // 刷新間隔比區塊 / 交易列表長（那邊 3 秒）：代幣中繼資料幾乎不變，會動的只有總供應量；
  // 而 getTokenMetas 本身有 60 秒快取，這裡只是為了「增發 / 重新部署」後不必手動重整。
  let busy = false;
  _refreshTimer = setInterval(() => {
    if (busy) return;
    busy = true;
    render().catch((e) => console.error(t("tokens.refreshFailed"), e)).finally(() => { busy = false; });
  }, 15000);
}

// ---------- 合約目錄（contracts.html）----------
// 資料來源是驗證後端（VerifyApi）的 contracts 表：鏈上部署 / 驗證過的合約都會被登記進去，
// 前端只負責分頁列出（與 tokens 不同——tokens 是前端人工精選，合約目錄是後端全量）。
// 後端未設定（VERIFY_API.baseUrl 為空）就顯示提示，不報錯、不卡首屏。
export async function viewContracts(query) {
  clearTimer();
  const view = document.getElementById("view");
  if (!view) return;
  const page = Math.max(1, parseInt(query.page || "1", 10));
  const SIZE = 25;

  // 與其他列表同一套節奏：骨架同步先上，資料回來只換面板內容。
  const headLabel = el("span", {});
  const sec = section(headLabel);
  sec.querySelector(".panel-head").appendChild(livePill("hero.live"));
  setPanelBody(sec, skeletonRows(4, 4));
  const node = el("div", { class: "container" }, [pageHead(t("contracts.title")), sec]);
  view.replaceChildren(node);
  setTitle(t("contracts.title"));

  // 沒設定後端：直接提示，不嘗試請求（避免 CORS / 逾時干擾首屏）
  if (!isVerifyApiEnabled()) {
    setPanelBody(sec, emptyBox(t("contracts.noBackend")));
    return;
  }

  const render = async () => {
    const data = await fetchContracts(page, SIZE);
    if (data == null) { setPanelBody(sec, errorBox(t("contracts.refreshFailed"))); return; }
    const items = data.items || [];
    const total = data.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / SIZE));
    const p = Math.min(page, totalPages);
    headLabel.textContent = t("contracts.listTitle", { n: fmtNum(total) });

    if (!items.length) { setPanelBody(sec, emptyBox(t("contracts.empty"))); return; }

    const body = el("div", {});
    body.appendChild(rtable(
      [t("contracts.colName"), t("contracts.colAddress"), t("contract.deployer"), t("contracts.colVerified"), t("contracts.colUpdated")],
      items.map((c) => {
        // updatedAt 是 ISO 字串，轉成秒級 unix 再走既有的 fmtDateTime（支援 {age} 類格式化）
        let when = "—";
        try {
          const secs = Math.floor(new Date(c.updatedAt).getTime() / 1000);
          when = fmtDateTime("0x" + secs.toString(16));
        } catch { /* 日期解析失敗就留 — */ }
        return [
          el("div", { class: "token-name-cell" }, [
            el("a", { class: "link", href: `address.html#/address/${c.address}` },
              [c.name || el("span", { class: "muted" }, [shortHash(c.address, 8, 6)])]),
          ]),
          hashLink(c.address, "address", { head: 10, tail: 8 }),
          c.creator
            ? hashLink(c.creator, "address", { head: 8, tail: 6 })
            : el("span", { class: "muted" }, ["—"]),
          c.verified
            ? el("span", { class: "tag tag-ok" }, [t("contract.verified")])
            : el("span", { class: "tag" }, [t("contract.unverified")]),
          el("span", { class: "num" }, [when]),
        ];
      }),
      { cols: "1.5fr 1.5fr 1.3fr 0.9fr 1.1fr" },
    ));
    if (totalPages > 1) {
      body.appendChild(pagination({
        page: p, totalPages,
        onPage: (pp) => { location.href = `contracts.html?page=${pp}`; },
      }));
    }
    setPanelBody(sec, body);
  };

  await render().catch((e) => {
    console.error(e);
    setPanelBody(sec, errorBox(e.message || String(e)));
  });

  // 後端資料是「活」的（新的部署 / 驗證會持續寫入），定時刷新當前頁。
  let busy = false;
  _refreshTimer = setInterval(() => {
    if (busy) return;
    busy = true;
    render().catch((e) => console.error(t("contracts.refreshFailed"), e)).finally(() => { busy = false; });
  }, 20000);
}

// ---------- 验证人（validators.html）----------
export async function viewValidators() {
  clearTimer();
  const view = document.getElementById("view");
  if (!view) return;

  // 骨架
  const node = el("div", { class: "container" });
  node.appendChild(pageHead(t("val.title")));
  node.appendChild(skeletonCards(4, "valid-grid sk-grid"));
  node.appendChild(el("section", { class: "panel" }, [
    el("div", { class: "panel-head" }, [el("h2", {}, [t("val.addressList")])]),
    skeletonRows(4, 4),
  ]));
  view.replaceChildren(node);

  try {
    const [vals, stats] = await Promise.all([
      API.getValidators(),
      API.getValidatorStats(1000).catch(() => null),
    ]);

    const totalBlocks = stats ? stats.scanned : 0;
    const grid = el("div", { class: "valid-grid" });
    for (const v of vals) {
      const count = stats ? (stats.stats[v.toLowerCase()] || 0) : 0;
      const pct = totalBlocks ? ((count / totalBlocks) * 100).toFixed(1) : "0.0";
      grid.appendChild(el("div", { class: "valid-card" }, [
        el("div", { class: "valid-avatar" }, [v.slice(2, 4).toUpperCase()]),
        el("div", { class: "valid-body" }, [
          el("div", { class: "valid-addr" }, [mono(v, true)]),
          el("div", { class: "valid-meta" }, [
            el("span", {}, [t("val.nearBlocks", { blocks: fmtNum(totalBlocks), count: fmtNum(count) })]),
            el("span", { class: "muted" }, [t("val.share", { pct })]),
          ]),
          el("div", { class: "valid-bar" }, [el("div", { class: "valid-bar-fill", style: `width:${pct}%` })]),
        ]),
      ]));
    }

    const statRow = el("div", { class: "stat-grid small" }, [
      statCard(t("val.total"), String(vals.length), t("val.totalSub"), "red", "🛡"),
      statCard(t("val.scanned"), fmtNum(totalBlocks), t("val.scannedSub"), "blue", "🧱"),
      statCard(t("val.avgTime"), stats && stats.avgBlockTime ? stats.avgBlockTime.toFixed(2) + " " + t("unit.sec") : "—", t("val.avgTimeSub"), "green", "⏱"),
      statCard(t("val.consensus"), "QBFT", t("val.consensusSub"), "purple", "⚙"),
    ]);

    const sec = section(t("val.addressList"));
    setPanelBody(sec, rtable(
      [t("th.index"), t("th.address"), t("th.blocksProposed"), t("th.share")],
      vals.map((v, i) => {
        const count = stats ? (stats.stats[v.toLowerCase()] || 0) : 0;
        const pct = totalBlocks ? ((count / totalBlocks) * 100).toFixed(1) : "0.0";
        return [
          el("span", { class: "num" }, [String(i + 1)]),
          hashLink(v, "address", { head: 10, tail: 8 }),
          el("span", {}, [fmtNum(count)]),
          el("span", { class: "muted" }, [pct + "%"]),
        ];
      }),
      { cols: "0.5fr 2.2fr 1fr 0.8fr" },
    ));

    node.replaceChildren(
      pageHead(t("val.title"), [
        el("span", { class: "badge badge-qbft" }, [t("val.badge", { n: vals.length })]),
        livePill("hero.live"),
      ]),
      grid,
      statRow,
      sec,
    );
    setTitle(t("val.titleTag"));
  } catch (e) {
    console.error(e);
    view.replaceChildren(errorBox(e.message || String(e)));
  }
}

// ---------- 验证人治理（gov.html）----------
// 工具：验证人提议新增 / 移除，其它验证人审批（approve），达到 ¾ 多数自动执行。
// 合约未部署时只提示；部署后在 config.js 填 CHAIN.validatorGovernance（或 ?addr=0x…）。
export async function viewGovernance() {
  clearTimer();
  const view = document.getElementById("view");
  if (!view) return;

  const node = el("div", { class: "container" });
  node.appendChild(pageHead(t("gov.title")));

  // 未部署：直接提示，不再往下讀鏈
  if (!GOV.govConfigured()) {
    node.appendChild(section(t("gov.title")));
    const sec = node.querySelector(".panel");
    setPanelBody(sec, el("div", { class: "gov-notdeployed" }, [
      el("p", { class: "gov-warn" }, [t("gov.notDeployed")]),
      el("p", { class: "muted" }, [t("gov.notDeployedHint")]),
      el("div", { class: "kv" }, [
        el("div", { class: "kv-row" }, [el("div", { class: "kv-key" }, [t("gov.contractAddr")]),
          el("div", { class: "kv-val" }, [mono(GOV.govAddress() || "—")])]),
      ]),
    ]));
    view.replaceChildren(node);
    setTitle(t("gov.title"));
    return;
  }

  view.replaceChildren(node);

  // 當前錢包狀態橫幅（連接后即重繪）
  const banner = el("div", { class: "gov-banner" });
  // 非驗證人提示（僅顯示給非驗證人 / 未連接者）
  const note = el("p", { class: "muted tab-desc gov-note" });
  // 當前驗證人面板
  const vSec = section(t("gov.currentValidators"));
  // 提案列表面板
  const propSec = section(t("gov.proposalsTitle"));
  // 提議新增表單（僅驗證人可見）
  const addForm = buildProposeAddForm();
  // 提議移除表單（僅驗證人可見）
  const removeForm = buildProposeRemoveForm();

  node.appendChild(banner);
  node.appendChild(note);
  node.appendChild(vSec);
  node.appendChild(propSec);
  node.appendChild(addForm);
  node.appendChild(removeForm);

  async function refresh() {
    try {
      const [vals, req, propCount] = await Promise.all([
        GOV.getValidators(), GOV.getRequiredApprovals(), GOV.getProposalCount(),
      ]);
      const p = getProvider();
      let me = null;
      if (p) { try { const a = await p.request({ method: "eth_accounts" }); if (a && a.length) me = a[0].toLowerCase(); } catch { /* 未连接 */ } }
      const meIsValidator = me ? vals.includes(me) : false;

      // 横幅
      banner.replaceChildren(
        me
          ? (meIsValidator
              ? el("span", { class: "tag tag-ok" }, [t("gov.youAreValidator")])
              : el("span", { class: "tag tag-warn" }, [t("gov.youAreNotValidator")]))
          : el("button", { class: "btn btn-sm", type: "button", onclick: connect }, [t("gov.connectWallet")]),
      );

      // 非驗證人提示
      note.textContent = meIsValidator ? "" : t("gov.notValidatorCantVote");
      note.style.display = meIsValidator ? "none" : "";
      // 提議表單：僅驗證人可見
      addForm.style.display = meIsValidator ? "" : "none";
      removeForm.style.display = meIsValidator ? "" : "none";

      // 當前驗證人列表（升序顯示，便於對照）
      const sorted = [...vals].sort();
      setPanelBody(vSec, rtable(
        [t("th.index"), t("th.address")],
        sorted.map((v, i) => [
          el("span", { class: "num" }, [String(i + 1)]),
          el("span", { class: "addr-cell" }, [
            hashLink(v, "address", { head: 10, tail: 8 }),
            v === me ? el("span", { class: "tag tag-ok gov-you" }, [t("gov.youAreValidator")]) : null,
          ]),
        ]),
        { cols: "0.5fr 3fr" },
      ));

      // 提案列表（含已執行歷史；進行中的可審批）
      const props = [];
      for (let i = 0; i < propCount; i++) props.push(await GOV.getProposal(i));
      const rows = props.map((x) => proposalRow(x, req, meIsValidator));
      setPanelBody(propSec, rows.length
        ? rtable(
            [t("gov.colId"), t("gov.colTarget"), t("gov.colAction"), t("gov.colApprovals"), t("gov.colStatus"), ""],
            rows,
            { cols: "0.4fr 2.4fr 1.2fr 1.4fr 1fr 1fr" },
          )
        : emptyBox(t("gov.proposalsEmpty")));

      setTitle(t("gov.title"));
    } catch (e) {
      console.error(e);
      toast(t("gov.actionFail") + " " + (e.shortMessage || e.message || e));
    }
  }

  async function connect() {
    try { await requestAccounts(); await refresh(); }
    catch (e) { toast(t("wallet.rejected") || String(e.message || e)); }
  }

  function proposalRow(x, req, canApprove) {
    const action = el("span", { class: "tag " + (x.isAdd ? "tag-ok" : "tag-danger") },
      [x.isAdd ? t("gov.actionAdd") : t("gov.actionRemove")]);
    const status = x.executed
      ? el("span", { class: "tag tag-ok" }, [t("gov.statusExecuted")])
      : el("span", { class: "tag tag-warn" }, [t("gov.statusOpen")]);
    const approvals = el("span", { class: "num" }, [`${x.approvals} / ${req}`]);
    const actionCell = (!x.executed && canApprove)
      ? el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: () => doApprove(x.id) }, [t("gov.approve")])
      : null;
    return [
      el("span", { class: "num" }, [String(x.id)]),
      hashLink(x.target, "address", { head: 10, tail: 8 }),
      action,
      approvals,
      status,
      actionCell,
    ];
  }

  async function doApprove(id) {
    try {
      const hash = await GOV.approve(id);
      toast(t("gov.approveSuccess") + " " + shortHash(hash));
      await refresh();
    } catch (e) {
      toast(t("gov.actionFail") + " " + (e.shortMessage || e.message || e));
    }
  }

  function buildProposeAddForm() {
    const addr = el("input", { class: "fld", type: "text", placeholder: t("gov.proposeAddAddr") });
    const btn = el("button", { class: "btn btn-primary", type: "button" }, [t("gov.proposeAddSubmit")]);
    btn.addEventListener("click", async () => {
      const a = addr.value.trim();
      if (!isAddress(a)) { toast(t("addr.badAddr")); return; }
      try {
        const hash = await GOV.proposeAddValidator(a);
        toast(t("gov.proposeAddSuccess") + " " + shortHash(hash));
        await refresh();
      } catch (e) {
        toast(t("gov.actionFail") + " " + (e.shortMessage || e.message || e));
      }
    });
    return el("section", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", {}, [t("gov.proposeAddTitle")])]),
      el("div", { class: "form-grid sm" }, [
        el("label", {}, [t("gov.proposeAddAddr")]), addr,
      ]),
      el("div", { class: "form-actions" }, [btn]),
    ]);
  }

  function buildProposeRemoveForm() {
    const addr = el("input", { class: "fld", type: "text", placeholder: t("gov.proposeRemoveAddr") });
    const btn = el("button", { class: "btn btn-danger", type: "button" }, [t("gov.proposeRemoveSubmit")]);
    btn.addEventListener("click", async () => {
      const a = addr.value.trim();
      if (!isAddress(a)) { toast(t("addr.badAddr")); return; }
      try {
        const hash = await GOV.proposeRemoveValidator(a);
        toast(t("gov.proposeRemoveSuccess") + " " + shortHash(hash));
        await refresh();
      } catch (e) {
        toast(t("gov.actionFail") + " " + (e.shortMessage || e.message || e));
      }
    });
    return el("section", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", {}, [t("gov.proposeRemoveTitle")])]),
      el("p", { class: "muted tab-desc" }, [t("gov.minValidatorsNote")]),
      el("div", { class: "form-grid sm" }, [
        el("label", {}, [t("gov.proposeRemoveAddr")]), addr,
      ]),
      el("div", { class: "form-actions" }, [btn]),
    ]);
  }

  await refresh();
}

// ---------- 地址 / 账户（address.html）----------
// 兩段式渲染：帳戶資訊（餘額/Nonce/型別/程式碼）先出，相關交易掃描完再補上，
// 避免在慢節點上為了掃 2000 個區塊而讓整頁卡在 spinner。
export async function viewAddress(addr) {
  clearTimer();
  const view = document.getElementById("view");
  if (!view) return;
  const node = el("div", { class: "container" });
  node.appendChild(pageHead(t("addr.title")));
  node.appendChild(el("section", { class: "panel" }, [skeletonRows(5, 2)]));
  view.replaceChildren(node);

  try {
    if (!isAddress(addr)) throw new Error(t("addr.badAddr"));
    const acc = await API.getAccount(addr);

    // 合约：委托给合约浏览器（含 概览/代码/读取/写入/事件/交易/存储/审计/代币）
    if (acc.isContract) {
      const { viewContract } = await import("./contract.js");
      return viewContract(addr);
    }

    // 相關交易：先放骨架，非同步補上
    const txHead = el("div", { class: "panel-head" }, [el("h2", {}, [t("addr.relatedTxs", { n: "…" })])]);
    const txBody = el("div", { class: "panel-body" }, [skeletonRows(4, 7)]);

    node.replaceChildren(
      pageHead(t("addr.title"), [
        acc.isContract
          ? el("span", { class: "tag tag-contract" }, [t("addr.contract")])
          : el("span", { class: "tag" }, [t("addr.eoa")]),
      ]),
      el("section", { class: "panel" }, [kvTable([
        [t("th.address"), mono(addr)],
        [t("addr.balance"), el("span", { class: "balance-value num" }, [fmtWei(acc.balance)])],
        [t("addr.nonce"), fmtNum(acc.nonce)],
        [t("addr.type"), acc.isContract ? el("span", { class: "tag tag-contract" }, [t("addr.contract")]) : t("addr.eoa")],
        [t("addr.code"), acc.isContract ? codeBlock(acc.code) : el("span", { class: "muted" }, [t("addr.noCode")])],
      ])]),
      el("section", { class: "panel" }, [txHead, txBody]),
    );
    setTitle(t("addr.titleTag"));

    API.getAddressTransactions(addr, 50, 2000)
      .catch(() => [])
      .then((txs) => {
        txHead.replaceChildren(el("h2", {}, [t("addr.relatedTxs", { n: fmtNum(txs.length) })]));
        if (!txs.length) { txBody.replaceChildren(emptyBox(t("addr.noTxs"))); return; }
        const rows = txs.map((tx) => {
          const r = txRow(tx);
          const dir = tx.direction === "out" ? el("span", { class: "tag tag-out" }, ["OUT"])
            : tx.direction === "in" ? el("span", { class: "tag tag-in" }, ["IN"])
            : el("span", { class: "tag" }, ["SELF"]);
          r.splice(4, 1, dir);
          return r;
        });
        txBody.replaceChildren(rtable(
          [t("th.txHash"), t("th.block"), t("th.time"), t("th.from"), t("th.direction"), t("th.to"), t("th.value")],
          rows,
          { cols: "1.6fr 0.9fr 1fr 1.4fr 0.8fr 1.4fr 1.2fr" },
        ));
      });
  } catch (e) {
    console.error(e);
    view.replaceChildren(errorBox(e.message || String(e)));
  }
}

// 空状态页（address.html 未给地址时）
export function viewAddressEmpty() {
  clearTimer();
  const view = document.getElementById("view");
  if (!view) return;
  view.replaceChildren(el("div", { class: "container" }, [
    pageHead(t("addr.title")),
    emptyBox(t("addr.empty")),
  ]));
  setTitle(t("addr.titleTag"));
}

// 显示 spinner 后再异步渲染（详情/列表页首屏用）
async function withSpinner(view, renderFn) {
  view.replaceChildren(spinner());
  try {
    const node = await renderFn();
    view.replaceChildren(node);
  } catch (e) {
    console.error(e);
    view.replaceChildren(errorBox(e.message || String(e)));
  }
}

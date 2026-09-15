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
import { addToWalletButton, openNetworkModal } from "./network.js";
import { copyText } from "./ui.js";

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
// 通證清單是「人工精選」而非鏈上全量列舉：純前端沒有索引器，無法反推「鏈上所有 ERC-20 合約」
// （那需要逐塊掃 to=null 的部署交易再讀回執，成本與延遲都不可接受）。
// 因此來源是 config.js 的 CHAIN.featuredTokens——要收錄新代幣就往那裡加一個地址。
//
// 本頁刻意不載入 ethers（500KB+）：只讀 name/symbol/decimals/totalSupply 四個欄位，
// 為此引入整個套件並不划算，改用固定的 ERC-20 selector 手動編解碼。
const ERC20_SEL = {
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
};

// 解 ABI 編碼的 string：前 32 bytes 是 offset、接著 32 bytes 是長度、再來才是資料本體。
// 解析失敗回空字串而不是拋錯——非標準代幣（用 bytes32 存名稱的舊合約）會落到這條路。
function decErc20String(hex) {
  try {
    const h = (hex || "").startsWith("0x") ? hex.slice(2) : hex;
    if (h.length < 128) return "";
    const len = parseInt(h.slice(64, 128), 16);
    const bytes = h.slice(128, 128 + len * 2);
    const arr = [];
    for (let i = 0; i < bytes.length; i += 2) arr.push(parseInt(bytes.substr(i, 2), 16));
    return new TextDecoder().decode(new Uint8Array(arr));
  } catch { return ""; }
}

function decErc20Uint(hex) {
  try {
    const h = (hex || "").startsWith("0x") ? hex.slice(2) : hex;
    return BigInt("0x" + h);
  } catch { return null; }
}

// 元資料快取（地址 -> {t, meta}）：名稱 / 精度幾乎不變，不快取的話每次刷新
// 都要對每個代幣打 4 次 eth_call，代幣一多就會壓垮節點。
const _tokenMetaCache = new Map();
const TOKEN_TTL = 60000;

// 固定 4 條並行讀取：清單一長，一次全開會同時打出上百個 eth_call，
// 有些節點對單一來源的並發設有上限（本鏈就對無 UA 的請求回 403，可見有防護層）。
async function getTokenMetas() {
  const raw = (CHAIN.featuredTokens || [])
    .map((e) => (typeof e === "string" ? { address: e } : e))
    .filter((e) => e && e.address);
  if (!raw.length) return [];
  const out = new Array(raw.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < raw.length) {
      const i = next++;
      out[i] = await getOneToken(raw[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, raw.length) }, worker));
  return out.filter(Boolean);
}

async function getOneToken(e) {
  const addr = e.address;
  const key = String(addr).toLowerCase();
  const hit = _tokenMetaCache.get(key);
  if (hit && Date.now() - hit.t < TOKEN_TTL) return hit.meta;
  try {
    const [nameR, symR, decR, supR] = await Promise.all([
      API.callContract(addr, ERC20_SEL.name).catch(() => null),
      API.callContract(addr, ERC20_SEL.symbol).catch(() => null),
      API.callContract(addr, ERC20_SEL.decimals).catch(() => null),
      API.callContract(addr, ERC20_SEL.totalSupply).catch(() => null),
    ]);
    const meta = {
      address: addr,
      // config 裡可寫 name / symbol 覆寫鏈上值（例如鏈上名稱是雜訊時）
      name: e.name || (nameR ? decErc20String(nameR) : null),
      symbol: e.symbol || (symR ? decErc20String(symR) : null),
      decimals: decR ? decErc20Uint(decR) : null,
      totalSupply: supR ? decErc20Uint(supR) : null,
    };
    _tokenMetaCache.set(key, { t: Date.now(), meta });
    return meta;
  } catch {
    // 單一代幣讀取失敗（例如地址其實不是合約）不影響其他代幣
    return null;
  }
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
function tokenRowCell(meta) {
  return el("div", { class: "token-name-cell" }, [
    el("div", { class: "token-name-line" }, [
      el("a", { class: "link", href: `address.html#/address/${meta.address}` },
        [meta.name || el("span", { class: "muted" }, [t("token.notToken")])]),
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
  const blkSec = section(t("home.latestBlocks"), el("a", { class: "more", href: "blocks.html" }, [t("common.viewAll")]));
  const txSec = section(t("home.latestTxs"), el("a", { class: "more", href: "txs.html" }, [t("common.viewAll")]));
  node.replaceChildren(heroEl, gridEl, blkSec, txSec);
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

  let busy = false;
  _refreshTimer = setInterval(() => {
    if (busy) return;
    busy = true;
    render().catch((e) => console.error(t("home.refreshFailed"), e)).finally(() => { busy = false; });
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
      [t("tokens.col"), t("tokens.contract"), t("token.totalSupply"), t("token.decimals")],
      slice.map((m) => [
        tokenRowCell(m),
        hashLink(m.address, "address", { head: 10, tail: 8 }),
        el("span", { class: "num" }, [fmtTokenAmount(m.totalSupply, m.decimals)]),
        el("span", { class: "num" }, [m.decimals != null ? String(m.decimals) : "—"]),
      ]),
      { cols: "1.9fr 1.7fr 1.1fr 0.6fr" },
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

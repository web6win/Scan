// ===== 通用工具：格式化 + DOM 辅助 =====
import { t } from "./i18n.js";
import { CHAIN } from "./config.js";

// 由 config.js 統一提供（單一事實來源），此處僅為相容既有引用而再導出
export const NATIVE_TOKEN = CHAIN.nativeSymbol;
export const CHAIN_NAME = CHAIN.name;

// 大整数安全转换
export function hexToBigInt(hex) {
  if (hex == null) return 0n;
  try { return BigInt(hex); } catch { return 0n; }
}

export function hexToNum(hex) {
  return Number(hexToBigInt(hex));
}

// 千分位
export function fmtNum(n) {
  if (n == null) return "—";
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// wei -> 人类可读（自动选单位）
export function fmtWei(weiHex, opts = {}) {
  const wei = hexToBigInt(weiHex);
  const sym = opts.symbol ?? NATIVE_TOKEN;
  if (wei === 0n) return `0 ${sym}`;
  // 以太
  const ether = Number(wei) / 1e18;
  if (ether >= 0.000001) {
    const v = ether.toLocaleString("en-US", { maximumFractionDigits: 6 });
    return `${v} ${sym}`;
  }
  // gwei
  const gwei = Number(wei) / 1e9;
  if (gwei >= 0.000001) {
    return `${gwei.toLocaleString("en-US", { maximumFractionDigits: 4 })} Gwei`;
  }
  return `${fmtNum(wei.toString())} wei`;
}

// 纯数值（不带单位），用于 gas 等
export function fmtGwei(weiHex) {
  const wei = hexToBigInt(weiHex);
  const gwei = Number(wei) / 1e9;
  if (gwei === 0) return "0 Gwei";
  return `${gwei.toLocaleString("en-US", { maximumFractionDigits: 6 })} Gwei`;
}

// 本地化绝对时间（避免 toLocaleString 的时区/格式差异）
export function fmtDateTime(unixHex) {
  const ts = hexToNum(unixHex);
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 区块/交易列表用的“多久以前”：区块时间戳可能略领先本地时钟，负数按“刚刚”处理
export function fmtAge(unixHex) {
  const ts = hexToNum(unixHex);
  if (!ts) return "—";
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 0) return t("time.justNow");
  return ago(diff); // <60s 显示 “Xs ago”，1h 内 “Xm ago”，以此类推
}

// 时间戳（详情页）：绝对时间 + 相对
export function fmtTime(unixHex, opts = {}) {
  const ts = hexToNum(unixHex);
  if (!ts) return "—";
  const abs = fmtDateTime(unixHex);
  if (opts.relative) {
    const diff = Math.floor(Date.now() / 1000) - ts;
    return `${abs} (${diff < 0 ? t("time.justNow") : ago(diff)})`;
  }
  return abs;
}

export function ago(sec) {
  if (sec < 0) sec = 0;
  if (sec < 60) return t("time.seconds", { n: sec });
  if (sec < 3600) return t("time.minutes", { n: Math.floor(sec / 60) });
  if (sec < 86400) return t("time.hours", { n: Math.floor(sec / 3600) });
  return t("time.days", { n: Math.floor(sec / 86400) });
}

// 缩短哈希
export function shortHash(h, head = 6, tail = 4) {
  if (!h) return "—";
  if (h.length <= head + tail + 2) return h;
  return `${h.slice(0, head + 2)}…${h.slice(-tail)}`;
}

// 校验
export function isTxHash(s) {
  return /^0x[0-9a-fA-F]{64}$/.test(s.trim());
}
export function isAddress(s) {
  return /^0x[0-9a-fA-F]{40}$/.test(s.trim());
}
export function isBlockNum(s) {
  s = s.trim();
  if (/^\d+$/.test(s)) return true;
  if (/^0x[0-9a-fA-F]+$/.test(s)) return true;
  if (["latest", "pending", "earliest"].includes(s)) return true;
  return false;
}

// ===== DOM 辅助 =====
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// 复制按钮 + 短哈希链接（指向独立页面）
export function hashLink(hash, type, opts = {}) {
  const pageMap = { block: "blocks.html", tx: "txs.html", address: "address.html" };
  const page = pageMap[type] || "index.html";
  const a = el("a", {
    class: "hash-link",
    href: `${page}#/${type}/${hash}`,
    title: hash,
  }, [shortHash(hash, opts.head ?? 8, opts.tail ?? 6)]);
  return a;
}

export function copyBtn(text) {
  const b = el("button", {
    class: "copy-btn",
    type: "button",
    title: t("common.copy"),
    onclick: async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
        toast(t("common.copied"));
      } catch {
        toast(t("common.copyFailed"));
      }
    },
  }, ["⧉"]);
  return b;
}

export function mono(text, withCopy = true) {
  const wrap = el("span", { class: "mono-wrap" });
  wrap.appendChild(el("span", { class: "mono", title: text }, [text]));
  if (withCopy) wrap.appendChild(copyBtn(text));
  return wrap;
}

// 可滚动的代码块（合约字节码等）
export function codeBlock(text) {
  return el("pre", { class: "code-box" }, [text || "0x"]);
}

let toastTimer = null;
export function toast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

export function spinner(text) {
  return el("div", { class: "spinner-box" }, [
    el("div", { class: "spinner" }),
    el("p", { class: "spinner-text" }, [text || t("common.loading")]),
  ]);
}

export function errorBox(msg) {
  return el("div", { class: "error-box" }, [
    el("strong", {}, [t("common.errorTitle")]),
    el("p", {}, [msg]),
  ]);
}

export function emptyBox(msg) {
  return el("div", { class: "empty-box" }, [msg || t("common.noData")]);
}

// 骨架屏：表格列（首屏載入時取代 spinner，讓版面不跳動）
export function skeletonRows(rows = 5, cols = 5) {
  const wrap = el("div", { class: "sk-table", "aria-hidden": "true" });
  for (let r = 0; r < rows; r++) {
    const row = el("div", { class: "sk-row" });
    for (let c = 0; c < cols; c++) {
      row.appendChild(el("div", { class: "sk-bar", style: `width:${58 + ((r + c) % 4) * 12}%` }));
    }
    wrap.appendChild(row);
  }
  return wrap;
}

// 骨架屏：卡片格（統計卡 / 驗證人卡）
export function skeletonCards(n = 4, cls = "sk-grid") {
  const wrap = el("div", { class: cls, "aria-hidden": "true" });
  for (let i = 0; i < n; i++) wrap.appendChild(el("div", { class: "sk-card" }));
  return wrap;
}

// 骨架屏：把骨架卡塞進「已經存在的容器」。
// 給首屏同步渲染用——容器本身之後會裝真實資料，所以不能對容器掛 aria-hidden
// （否則資料填進去之後，整格統計卡仍會被輔助技術忽略）；aria-hidden 只掛在骨架卡上。
export function fillSkeletonCards(parent, n = 4) {
  for (let i = 0; i < n; i++) parent.appendChild(el("div", { class: "sk-card", "aria-hidden": "true" }));
  return parent;
}

// 分页控件
export function pagination({ page, totalPages, onPage }) {
  const wrap = el("div", { class: "pagination" });
  const mk = (label, p, disabled, active) =>
    el("button", {
      class: "page-btn" + (active ? " active" : ""),
      disabled: disabled ? "" : null,
      onclick: () => !disabled && onPage(p),
    }, [label]);

  wrap.appendChild(mk(t("common.page.first"), 1, page <= 1));
  wrap.appendChild(mk(t("common.page.prev"), page - 1, page <= 1));

  const start = Math.max(1, page - 2);
  const end = Math.min(totalPages, page + 2);
  for (let p = start; p <= end; p++) wrap.appendChild(mk(String(p), p, false, p === page));

  wrap.appendChild(mk(t("common.page.next"), page + 1, page >= totalPages));
  wrap.appendChild(mk(t("common.page.last"), totalPages, page >= totalPages));
  return wrap;
}

export function setTitle(s) {
  const sub = `${CHAIN_NAME} ${t("brand.sub")}`;
  document.title = s ? `${s} · ${sub}` : sub;
}

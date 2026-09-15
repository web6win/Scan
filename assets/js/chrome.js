// ===== 共享外殼：頂欄 / 導航 / 語言切換 / 底部 Tab / 頁腳狀態 =====
// 由 JS 統一渲染，避免各頁面 HTML 重複與漂移（先前「部署」連結曾落在 <nav> 之外）。
import * as API from "./api.js";
import { toast, fmtNum, el } from "./utils.js";
import { t, getLang, setLang, LANGS, initI18n } from "./i18n.js";
import { addToWalletButton, openNetworkModal } from "./network.js";
import { getProvider, walletName } from "./wallet.js";

// 導航結構：桌面頂欄與行動端底部 Tab 共用同一份定義。
// 「資料」收鏈上瀏覽類頁面（區塊 / 通證 / 交易 / 驗證人），「工具」收操作類頁面（部署），
// 兩者都是下拉分組；「概覽」維持直達連結（它本身就是首頁，分組反而多一次點擊）。
// 「通證」刻意排在「區塊」與「交易」之間：三者同屬「看鏈上資料」的主線，
// 由粗到細（區塊 → 代幣 → 交易），與營運文件裡給的順序一致。
const NAV_HOME = { route: "home", href: "index.html", key: "nav.home", icon: "🏠" };
const NAV_GROUPS = [
  {
    id: "data", key: "nav.data", icon: "📊",
    items: [
      { route: "blocks", href: "blocks.html", key: "nav.blocks", icon: "🧱" },
      { route: "tokens", href: "tokens.html", key: "nav.tokens", icon: "🪙" },
      { route: "txs", href: "txs.html", key: "nav.txs", icon: "💸" },
      { route: "validators", href: "validators.html", key: "nav.validators", icon: "🛡️" },
    ],
  },
  {
    id: "tools", key: "nav.tools", icon: "🧰",
    items: [
      { route: "deploy", href: "deploy.html", key: "nav.deploy", icon: "📦" },
    ],
  },
];
// 扁平表：給需要「所有路由」的地方（例如高亮比對）使用
const NAV = [NAV_HOME, ...NAV_GROUPS.flatMap((g) => g.items)];
const routesOf = (g) => g.items.map((i) => i.route).join(",");

let _active = "home";
let _rerender = null;
let _openGroup = null;   // 目前展開的分組 id；頂欄與底部 Tab 共用，同一時刻只會有一個可見
let _dismissWired = false;

// 窄螢幕判定（與 CSS 的 560px 斷點一致）：決定搜尋框用長/短佔位文字
const NARROW_Q = "(max-width: 560px)";
function isNarrow() {
  return typeof matchMedia === "function" ? matchMedia(NARROW_Q).matches : false;
}

// 刻意不做「懸停展開」：滑鼠移入會先展開，接著那一次點擊就被當成「再點一次＝收合」，
// 桌面使用者會覺得「點一下反而關掉」。統一為點擊開合，鍵盤（Enter/Space）與觸控行為一致。

// 展開狀態以 _openGroup 為唯一來源：頂欄與底部 Tab 的同名分組會一起同步，
// 這樣切換斷點（例如旋轉螢幕）時不會留下「按鈕說已展開、面板卻是關的」的狀態。
function setOpenGroup(id) {
  _openGroup = id;
  document.querySelectorAll("[data-group]").forEach((n) => {
    const on = n.getAttribute("data-group") === id;
    n.classList.toggle("is-open", on);
    const btn = n.querySelector("[aria-expanded]");
    if (btn) btn.setAttribute("aria-expanded", on ? "true" : "false");
  });
}

// 分組的開合行為：點擊切換、（桌機）懸停開合、鍵盤焦點移出即收合
function wireGroup(node) {
  const id = node.getAttribute("data-group");
  const btn = node.querySelector("[aria-expanded]");
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    setOpenGroup(_openGroup === id ? null : id);
  });
  node.addEventListener("focusout", (e) => {
    // relatedTarget 為 null 表示焦點跑出了文件（例如切到網址列），這種情況也該收合
    if (!e.relatedTarget || !node.contains(e.relatedTarget)) {
      if (_openGroup === id) setOpenGroup(null);
    }
  });
}

// 全域收合：點到分組以外、或按下 Esc。只需掛一次，故用旗標保護。
function wireGlobalDismiss() {
  if (_dismissWired) return;
  _dismissWired = true;
  document.addEventListener("click", (e) => {
    if (_openGroup && !(e.target instanceof Element && e.target.closest("[data-group]"))) setOpenGroup(null);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !_openGroup) return;
    const node = document.querySelector(`[data-group="${_openGroup}"]`);
    setOpenGroup(null);
    // 收合後把焦點還給觸發按鈕，否則鍵盤使用者會「掉」回文件開頭
    const btn = node && node.querySelector("[aria-expanded]");
    if (btn) btn.focus();
  });
}

export function setupChrome(active, rerender) {
  _active = active;
  _rerender = typeof rerender === "function" ? rerender : null;

  initI18n(); // 先翻譯 HTML 裡的靜態 data-i18n 文字（含 placeholder / aria）
  wireGlobalDismiss();
  renderHeader();
  renderTabbar();
  renderFooter();

  window.addEventListener("langchange", () => {
    setOpenGroup(null); // 重繪會換掉整個分組節點，先歸零避免殘留「已展開」狀態
    renderHeader();
    renderTabbar();
    renderFooter();
    refreshFooterStatus();
    if (_rerender) _rerender();
  });

  // 跨越窄螢幕斷點時重繪頂欄（切換短/長搜尋佔位文字）
  if (typeof matchMedia === "function") {
    const mq = matchMedia(NARROW_Q);
    const onMq = () => { renderHeader(); wireSearch(); };
    if (mq.addEventListener) mq.addEventListener("change", onMq);
    else if (mq.addListener) mq.addListener(onMq);
  }

  wireSearch();
  startFooterPolling();

  // 可分享的「一鍵加鏈」深鏈接：#add-chain（例：https://…/index.html#add-chain）
  // 運營可直接把這個連結發到公告 / IM。這裡刻意「只開彈窗、不主動呼叫錢包」——
  // 未經使用者手勢就呼叫 wallet_addEthereumChain，可能被瀏覽器/錢包攔截，
  // 因此彈窗內那顆「添加到錢包」按鈕就是那一次必要的手勢。
  handleAddChainHash();
  window.addEventListener("hashchange", handleAddChainHash);

  // 首屏渲染交給各頁面自己的渲染函式
  if (_rerender) _rerender();
}

// 解析 #add-chain 深鏈接（與 #/block/N 這類路由 hash 互不干擾）
function handleAddChainHash() {
  if (String(location.hash || "").replace(/^#\/?/, "") === "add-chain") openNetworkModal();
}

// ---------- 導航分組（資料 / 工具）----------

// 桌面頂欄的下拉：按鈕 + 絕對定位面板。面板用 <ul> 是純導航清單，
// 不加 role="menu"——那會讓螢幕閱讀器預期方向鍵操作，這裡不需要。
function navGroupEl(g) {
  const id = `navgroup-${g.id}`;
  const btn = el("button", {
    class: "nav-group-btn", type: "button", id: `${id}-btn`,
    "aria-haspopup": "true", "aria-expanded": "false", "aria-controls": `${id}-menu`,
  }, [
    t(g.key),
    el("span", { class: "nav-caret", "aria-hidden": "true" }, ["▾"]),
  ]);
  const menu = el("ul", { class: "nav-menu", id: `${id}-menu`, "aria-labelledby": `${id}-btn` },
    g.items.map((n) => el("li", {}, [
      el("a", { href: n.href, "data-route": n.route }, [
        el("span", { class: "nav-menu-ico", "aria-hidden": "true" }, [n.icon]),
        el("span", { class: "nav-menu-label" }, [t(n.key)]),
      ]),
    ]))
  );
  const node = el("div", {
    class: "nav-group", "data-group": g.id, "data-group-routes": routesOf(g),
  }, [btn, menu]);
  wireGroup(node);
  return node;
}

// 行動端底部 Tab 的分組：按鈕外觀與其他 Tab 一致，點擊後從底欄上緣升起面板。
// 面板是 .tabbar（position: fixed）的絕對定位子元素，所以 bottom:100% 正好貼在底欄上方。
function tabGroupEl(g) {
  const id = `tabgroup-${g.id}`;
  const btn = el("button", {
    class: "tab-group-btn", type: "button", id: `${id}-btn`,
    "aria-haspopup": "true", "aria-expanded": "false", "aria-controls": `${id}-sheet`,
  }, [
    el("span", { class: "ico", "aria-hidden": "true" }, [g.icon]),
    el("span", { class: "tab-label" }, [t(g.key)]),
  ]);
  const sheet = el("ul", { class: "tab-sheet", id: `${id}-sheet`, "aria-labelledby": `${id}-btn` },
    g.items.map((n) => el("li", {}, [
      el("a", { href: n.href, "data-route": n.route }, [
        el("span", { class: "ico", "aria-hidden": "true" }, [n.icon]),
        el("span", { class: "tab-sheet-label" }, [t(n.key)]),
      ]),
    ]))
  );
  const node = el("div", {
    class: "tab-group", "data-group": g.id, "data-group-routes": routesOf(g),
  }, [btn, sheet]);
  wireGroup(node);
  return node;
}

// ---------- 頂欄 ----------
function renderHeader() {
  const host = document.getElementById("topbar");
  if (!host) return;

  const brand = el("a", { class: "brand", href: "index.html", "aria-label": "WEB6 " + t("brand.sub") }, [
    el("span", { class: "brand-logo" }, ["◈"]),
    el("span", { class: "brand-text" }, [
      el("strong", {}, ["WEB6"]),
      el("small", { "data-i18n": "brand.sub" }, [t("brand.sub")]),
    ]),
  ]);

  // 導航：概覽直達 + 資料／工具兩個下拉分組（行動端由 CSS 隱藏，改由底部 Tab 承接）
  const nav = el("nav", { class: "nav-main", "aria-label": t("nav.menu") }, [
    el("a", { href: NAV_HOME.href, "data-route": NAV_HOME.route }, [t(NAV_HOME.key)]),
    ...NAV_GROUPS.map(navGroupEl),
  ]);

  // 行動端空間有限，改用短佔位文字（避免搜尋框被擠到看不清楚）
  const phKey = isNarrow() ? "search.placeholderShort" : "search.placeholder";
  const input = el("input", {
    id: "searchInput", type: "search", inputmode: "search", autocomplete: "off",
    placeholder: t(phKey), "aria-label": t("search.aria"),
    "data-i18n-ph": phKey,
  });
  const form = el("form", { class: "search", id: "searchForm", role: "search" }, [
    input,
    el("button", { type: "submit", "aria-label": t("search.aria"), "data-i18n-aria": "search.aria" }, ["🔍"]),
  ]);

  // 原生 select：保留完整語言名稱（下拉選單與無障礙最佳）
  const select = el("select", { class: "lang-select", "aria-label": t("lang.aria"), "data-i18n-aria": "lang.aria" },
    LANGS.map((l) => el("option", { value: l.code, ...(l.code === getLang() ? { selected: "selected" } : {}) }, [l.label]))
  );
  select.addEventListener("change", (e) => setLang(e.target.value));
  const lang = el("label", { class: "lang-switch", title: t("lang.aria") }, [
    el("span", { class: "lang-globe" }, ["🌐"]),
    select,
  ]);

  // 錢包入口：桌面顯示圖示+文字，手機只留圖示（見 CSS），避免擠壓搜尋框
  const walletBtn = addToWalletButton("bar");
  walletBtn.classList.add("topbar-wallet");
  const wp = getProvider();
  if (wp) walletBtn.title = t("wallet.detected", { name: walletName(wp) }) + " · " + t("hero.addTitle");

  host.replaceChildren(
    el("div", { class: "topbar-inner" }, [
      brand,
      nav,
      el("div", { class: "topbar-right" }, [form, walletBtn, lang]),
    ])
  );

  highlight();
}

// ---------- 底部 Tab（行動端）----------
function renderTabbar() {
  const host = document.getElementById("tabbar");
  if (!host) return;
  host.setAttribute("aria-label", t("nav.menu"));
  host.replaceChildren(
    el("a", { href: NAV_HOME.href, "data-route": NAV_HOME.route }, [
      el("span", { class: "ico", "aria-hidden": "true" }, [NAV_HOME.icon]),
      // 包一層 .tab-label：省略號要作用在「文字本身」才有效，
      // 放在 flex 容器 <a> 上是沒用的（那樣長標籤會被硬切、沒有 …）
      el("span", { class: "tab-label" }, [t(NAV_HOME.key)]),
    ]),
    ...NAV_GROUPS.map(tabGroupEl),
  );
  highlight();
}

// ---------- 頁腳 ----------
function renderFooter() {
  const host = document.getElementById("footer");
  if (!host) return;
  // 每個頁面都能觸達「添加到錢包」（手機底欄已滿，放頁腳最省空間）
  const addLink = el("button", {
    class: "footer-link", type: "button", onclick: openNetworkModal,
  }, [t("footer.addNetwork")]);

  host.replaceChildren(
    el("span", { id: "footerStatus" }, [t("footer.connecting")]),
    el("span", { class: "footer-sep" }, ["·"]),
    el("span", {}, ["RPC: chain.web6.win"]),
    el("span", { class: "footer-sep" }, ["·"]),
    el("span", {}, [t("footer.chain")]),
    el("span", { class: "footer-sep" }, ["·"]),
    addLink,
  );
}

function highlight() {
  document.querySelectorAll("[data-route]").forEach((a) => {
    a.classList.toggle("active", a.getAttribute("data-route") === _active);
  });
  // 分組本身：只要當前頁是它的任一個子項，就整組高亮（使用者才知道自己身在「資料」下）
  document.querySelectorAll("[data-group-routes]").forEach((n) => {
    const on = (n.getAttribute("data-group-routes") || "").split(",").includes(_active);
    n.classList.toggle("active", on);
    const btn = n.querySelector(".nav-group-btn, .tab-group-btn");
    if (btn) btn.classList.toggle("active", on);
  });
}

// ---------- 搜尋 ----------
function wireSearch() {
  const form = document.getElementById("searchForm");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = document.getElementById("searchInput").value.trim();
    if (!q) return;
    try {
      const res = await API.search(q);
      if (res.type === "tx") location.href = `txs.html#/tx/${res.value}`;
      else if (res.type === "address") location.href = `address.html#/address/${res.value}`;
      else if (res.type === "block") location.href = `blocks.html#/block/${res.value}`;
      else toast(t("search.notFound"));
    } catch (err) {
      toast(t("search.failed") + (err.message || err));
    }
  });
}

// ---------- 頁腳連線狀態 ----------
function refreshFooterStatus() {
  const f = () => document.getElementById("footerStatus");
  API.getChainInfo()
    .then((info) => { if (f()) f().textContent = t("footer.connected", { n: fmtNum(info.blockNumber) }); })
    .catch(() => { if (f()) f().textContent = t("footer.failed"); });
}

function startFooterPolling() {
  refreshFooterStatus();
  setInterval(refreshFooterStatus, 15000);
}

// ===== 「添加到錢包」UI：按鈕 + 網路參數彈窗 =====
// 一鍵喚起錢包彈窗（EIP-3085），並為不支援一鍵添加的錢包提供完整參數 + 手動指引。
import { el } from "./utils.js";
import { t } from "./i18n.js";
import { CHAIN, chainIdHex, chainIdNum, explorerUrl, shareAddChainUrl } from "./config.js";
import * as API from "./api.js";
import { copyText, copyRow, openModal } from "./ui.js";
import {
  addOrSwitchChain, getProvider, walletName, isMobile,
  walletDeepLink, isMarkedAdded, paramsAsText, WalletError,
} from "./wallet.js";

// 錢包按鈕的三種外觀：hero（大型主 CTA）/ bar（頂欄緊湊）/ foot（頁腳文字）
export function addToWalletButton(variant = "bar") {
  const marked = isMarkedAdded();
  const cls = variant === "hero" ? "btn btn-primary btn-lg"
    : variant === "foot" ? "btn btn-ghost btn-sm"
    : "btn btn-primary btn-sm";

  const label = el("span", { class: "wallet-btn-label" }, [marked ? t("hero.added") : t("hero.add")]);
  const btn = el("button", {
    class: cls + " wallet-btn" + (marked ? " is-added" : ""),
    type: "button",
    title: t("hero.addTitle"),
    "data-variant": variant,
  }, [
    el("span", { class: "wallet-btn-ico", "aria-hidden": "true" }, ["🔗"]),
    label,
  ]);

  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    const provider = getProvider();

    // 沒有注入錢包 → 開彈窗給安裝 / deep link 指引
    if (!provider) { openNetworkModal(); return; }

    const original = label.textContent;
    btn.disabled = true;
    btn.classList.add("is-busy");
    label.textContent = t("hero.adding");
    try {
      const res = await addOrSwitchChain();
      const msg = res.status === "added" ? t("wallet.statusAdded")
        : res.status === "switched" ? t("wallet.statusSwitched")
        : t("wallet.statusExists");
      btn.classList.add("is-added");
      label.textContent = t("hero.added");
      notify(msg, "ok");
    } catch (e) {
      const err = e instanceof WalletError ? e : new WalletError("failed", e && e.message);
      btn.classList.remove("is-added");
      label.textContent = original;
      if (err.code === "rejected") notify(t("wallet.errRejected"), "warn");
      else if (err.code === "noWallet") { openNetworkModal(); }
      else notify(t("wallet.errFailed") + (err.message || ""), "fail");
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-busy");
    }
  });

  return btn;
}

// 輕量提示：沿用全站 toast，但用樣式區分成功 / 警告 / 失敗
function notify(msg, kind) {
  const node = document.getElementById("toast");
  if (!node) return;
  node.textContent = msg;
  node.className = "toast show toast-" + (kind || "ok");
  clearTimeout(notify._t);
  notify._t = setTimeout(() => { node.className = "toast"; }, 3200);
}

// ---------- 網路參數彈窗 ----------
export function openNetworkModal() {
  const provider = getProvider();
  const detected = !!provider;
  const name = detected ? walletName(provider) : "";

  // chainId 以節點實際回報值為準（寫死常數會在節點重建後過期，讓錢包判定不匹配）
  const rows = [
    ["wallet.chainName", CHAIN.nameFull],
    ["wallet.chainId", `${chainIdNum()}  (${chainIdHex()})`],
    ["wallet.currencySymbol", CHAIN.nativeSymbol],
    ["wallet.rpcUrl", CHAIN.rpcUrl],
    ["wallet.consensus", CHAIN.consensus],
  ];
  const ex = explorerUrl();
  if (ex) rows.push(["wallet.explorer", ex]);

  // 可分享的「一鍵加鏈」連結：運營把它貼到公告 / IM，對方點開即彈出加鏈彈窗。
  // 放在同一份可複製清單裡，於是「複製全部參數」也自然帶上它。
  const share = shareAddChainUrl();
  if (share) rows.push(["wallet.shareLink", share, { wrap: true }]);

  const body = [];

  // 錢包偵測狀態
  body.push(el("div", { class: "wallet-status" + (detected ? " is-on" : " is-off") }, [
    el("span", { class: "wallet-status-dot", "aria-hidden": "true" }),
    el("span", {}, [detected ? t("wallet.detected", { name }) : t("wallet.notDetected")]),
  ]));

  // 參數清單（每行可單獨複製）
  const renderedChainId = `${chainIdNum()}  (${chainIdHex()})`;
  body.push(el("div", { class: "copy-list" }, rows.map(([key, val, opt]) =>
    copyRow(t(key), val, t("wallet.copiedAll"), opt || {}))));

  // 手動添加指引
  body.push(el("p", { class: "modal-note" }, [t("wallet.manual")]));

  // 未偵測到錢包：安裝提示 + 手機 deep link
  if (!detected) {
    body.push(el("div", { class: "wallet-fallback" }, [
      el("p", {}, [t("wallet.notDetectedHint")]),
      isMobile() && walletDeepLink()
        ? el("a", { class: "btn btn-primary btn-block", href: walletDeepLink(), rel: "noopener" }, [t("wallet.openInApp")])
        : null,
    ]));
  }

  // 底部行動區：一鍵添加 / 切換 + 複製全部
  let close = () => {};
  const actions = [];
  if (detected) {
    const primary = el("button", {
      class: "btn btn-primary btn-block", type: "button", "data-autofocus": "1",
    }, [t("wallet.addBtn")]);
    primary.addEventListener("click", async () => {
      primary.disabled = true;
      const old = primary.textContent;
      primary.textContent = t("hero.adding");
      try {
        const res = await addOrSwitchChain();
        const msg = res.status === "added" ? t("wallet.statusAdded")
          : res.status === "switched" ? t("wallet.statusSwitched")
          : t("wallet.statusExists");
        close();
        notify(msg, "ok");
      } catch (e) {
        const err = e instanceof WalletError ? e : new WalletError("failed", e && e.message);
        primary.disabled = false;
        primary.textContent = old;
        if (err.code === "rejected") notify(t("wallet.errRejected"), "warn");
        else notify(t("wallet.errFailed") + (err.message || ""), "fail");
      }
    });
    actions.push(primary);
  }
  actions.push(el("button", {
    class: "btn btn-ghost btn-block", type: "button",
    onclick: () => copyText(paramsAsText(), t("wallet.copiedAll")),
  }, [t("wallet.copyAll")]));

  close = openModal({
    title: t("wallet.title"),
    subtitle: t("hero.addTitle"),
    body,
    footer: actions,
  });

  // 彈窗可能比節點回應更早出現（例如一進站就命中 #add-chain 深鏈接），
  // 那時候 chainId 還是設定裡的兜底值。拿到節點真值後整份清單重建——
  // 只改文字的話，複製按鈕拷貝的仍是舊值，會出現「畫面 2520、複製 20260801」。
  API.ensureChainId().then(() => {
    if (`${chainIdNum()}  (${chainIdHex()})` === renderedChainId) return;
    const list = document.querySelector(".modal-panel .copy-list");
    if (!list) return;
    list.replaceChildren(...rows.map(([key, val, opt]) =>
      copyRow(t(key), key === "wallet.chainId" ? `${chainIdNum()}  (${chainIdHex()})` : val,
        t("wallet.copiedAll"), opt || {})));
  }).catch(() => { /* 節點沒回應：保留兜底值 */ });
}

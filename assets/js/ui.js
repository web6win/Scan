// ===== 通用 UI 原件：無障礙 Modal（桌面居中 / 手機底部抽屜）+ 複製 =====
import { el, toast } from "./utils.js";
import { t } from "./i18n.js";

// 複製文字並提示（Clipboard API 在非 https 下不可用，故有 textarea 回退）
export async function copyText(text, okMsg) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      toast(okMsg || t("common.copied"));
      return true;
    }
    throw new Error("insecure");
  } catch {
    try {
      const ta = el("textarea", { style: "position:fixed;top:-1000px;opacity:0" }, [text]);
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      toast(ok ? (okMsg || t("common.copied")) : t("common.copyFailed"));
      return ok;
    } catch {
      toast(t("common.copyFailed"));
      return false;
    }
  }
}

// 帶標籤的「值 + 複製」列（網路參數用）
export function copyRow(label, value, okMsg, opts = {}) {
  // opts.wrap：給「長網址」用。窄螢幕上省略號會把網址尾巴（例如 #add-chain）切掉，
  // 而手機沒有 hover 可看 title，所以這一列允許折行；並且在 / # ? & = 之後插入 <wbr>，
  // 讓折行只發生在自然斷點（不會把 :8080 或 #add-chain 從中間切開）。顯示的仍是完整網址。
  const parts = [];
  if (opts.wrap) {
    const segs = String(value).split(/(?<=[/#?&=])/);
    segs.forEach((s, i) => { parts.push(s); if (i < segs.length - 1) parts.push(el("wbr")); });
  }
  return el("div", { class: "copy-row" }, [
    el("span", { class: "copy-row-key" }, [label]),
    el("span", { class: "copy-row-val" + (opts.wrap ? " is-url" : ""), title: value },
      opts.wrap ? parts : [value]),
    el("button", {
      class: "icon-btn icon-btn-sm",
      type: "button",
      "aria-label": t("common.copy") + " " + label,
      title: t("common.copy"),
      onclick: () => copyText(value, okMsg),
    }, ["⧉"]),
  ]);
}

let _lastFocus = null;

// 開啟 Modal。body 可以是 DOM 或字串；回傳 close()
export function openModal({ title, subtitle, body, footer, onClose }) {
  const root = document.getElementById("modalRoot") || (() => {
    const r = el("div", { id: "modalRoot", class: "modal-root" });
    document.body.appendChild(r);
    return r;
  })();
  if (root.firstChild) root.replaceChildren(); // 只允許一個

  _lastFocus = document.activeElement;

  const titleId = "modalTitle" + Date.now();
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    document.documentElement.classList.remove("modal-open");
    root.replaceChildren();
    if (_lastFocus && typeof _lastFocus.focus === "function") _lastFocus.focus();
    if (typeof onClose === "function") onClose();
  };

  const closeBtn = el("button", {
    class: "icon-btn modal-close", type: "button",
    "aria-label": t("common.close"), title: t("common.close"),
    onclick: close,
  }, ["✕"]);

  const head = el("div", { class: "modal-head" }, [
    el("div", { class: "modal-head-text" }, [
      el("h2", { id: titleId }, [title]),
      subtitle ? el("p", { class: "modal-sub" }, [subtitle]) : null,
    ]),
    closeBtn,
  ]);

  const panel = el("div", {
    class: "modal-panel", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId,
  }, [
    head,
    el("div", { class: "modal-body" }, [].concat(body || [])),
    footer ? el("div", { class: "modal-footer" }, [].concat(footer)) : null,
  ]);

  const backdrop = el("div", {
    class: "modal-backdrop",
    onclick: (e) => { if (e.target === backdrop) close(); },
  }, [panel]);

  // Esc 關閉 + Tab 焦點鎖在 modal 內
  function onKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); close(); return; }
    if (e.key !== "Tab") return;
    const items = panel.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener("keydown", onKey, true);
  document.documentElement.classList.add("modal-open");

  root.replaceChildren(backdrop);

  // 進場後聚焦：優先聚焦主要的行動按鈕，其次關閉鈕
  // （不用 requestAnimationFrame 直接呼叫，兼容沒有 rAF 的環境 / 測試執行器）
  const focusPrimary = () => {
    const primary = panel.querySelector("[data-autofocus]") || closeBtn;
    if (primary && typeof primary.focus === "function") primary.focus();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(focusPrimary);
  else setTimeout(focusPrimary, 0);

  return close;
}

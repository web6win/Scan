// ===== 錢包整合（EIP-1193 / EIP-3085 / EIP-3326）=====
// 目標：點一下「添加到錢包」就喚起 MetaMask 等錢包的授權彈窗，一鍵把本鏈加入網絡列表。
//
// 流程（穩健版）：
//   1. 先 wallet_switchEthereumChain —— 若該鏈已添加，直接切換過去（最順）
//   2. 若回報 4902（鏈未添加）→ 改用 wallet_addEthereumChain 觸發「添加網絡」彈窗
//   3. 用戶拒絕 → 4001，提示「已取消」，不當成錯誤
//
// 手機：多數手機瀏覽器沒有注入 provider，此時給出錢包 App 的 deep link
//       （在錢包內置瀏覽器中打開，window.ethereum 才存在）。
import { CHAIN, chainIdHex, chainIdNum, addChainParams, shareAddChainUrl } from "./config.js";
import { t } from "./i18n.js";
import * as API from "./api.js";

const ADDED_KEY = "web6.walletAdded";

// ---------- 錯誤 ----------
// code 用於 UI 分支，key 為 i18n key
export class WalletError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "WalletError";
    this.code = code;
  }
}

function normalizeError(e) {
  const code = e && (e.code ?? (e.data && e.data.code));
  if (code === 4001 || code === "ACTION_REJECTED") return new WalletError("rejected");
  if (code === 4902 || code === -32602) return new WalletError("notAdded", e && e.message);
  return new WalletError("failed", (e && (e.message || e)) || "unknown");
}

// ---------- provider 探測 ----------
export function getProvider() {
  if (typeof window === "undefined") return null;
  const eth = window.ethereum;
  if (!eth) return null;
  // 同時裝多個錢包擴充時，EIP-1193 規定把多個 provider 放在 .providers
  if (Array.isArray(eth.providers) && eth.providers.length) {
    return eth.providers.find((p) => p.isMetaMask) || eth.providers[0];
  }
  return eth;
}

export function hasWallet() {
  return !!getProvider();
}

// 錢包品牌識別（用於「已檢測到 MetaMask」之類的文案）
export function walletName(p = getProvider()) {
  if (!p) return t("wallet.injected");
  const flags = [
    ["isMetaMask", "MetaMask"],
    ["isOkxWallet", "OKX Wallet"],
    ["isOKExWallet", "OKX Wallet"],
    ["isBitget", "Bitget Wallet"],
    ["isBitKeep", "Bitget Wallet"],
    ["isTokenPocket", "TokenPocket"],
    ["isRabby", "Rabby"],
    ["isCoinbaseWallet", "Coinbase Wallet"],
    ["isTrust", "Trust Wallet"],
    ["isTrustWallet", "Trust Wallet"],
    ["isImToken", "imToken"],
    ["isMathWallet", "MathWallet"],
    ["isFrame", "Frame"],
  ];
  for (const [flag, label] of flags) if (p[flag]) return label;
  return t("wallet.injected");
}

// 是否為手機／平板
export function isMobile() {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod|HarmonyOS|Mobile/i.test(navigator.userAgent || "");
}

// 錢包 App 的 deep link：在錢包內置瀏覽器中打開本頁，window.ethereum 才會出現
export function walletDeepLink() {
  try {
    const hostPath = location.host + location.pathname + location.search + location.hash;
    return `https://metamask.app.link/dapp/${hostPath}`;
  } catch {
    return "";
  }
}

// 已添加過的本地標記（僅用於把按鈕顯示成「已添加」，不影響真實鏈上狀態）
export function isMarkedAdded() {
  try { return localStorage.getItem(ADDED_KEY) === chainIdHex(); } catch { return false; }
}
function markAdded() {
  try { localStorage.setItem(ADDED_KEY, chainIdHex()); } catch { /* ignore */ }
}

// ---------- 底層請求（兼容 request / sendAsync）----------
function call(p, method, params = []) {
  if (typeof p.request === "function") return p.request({ method, params });
  return new Promise((resolve, reject) => {
    if (typeof p.sendAsync !== "function") { reject(new WalletError("noWallet")); return; }
    p.sendAsync({ jsonrpc: "2.0", id: Date.now(), method, params }, (err, res) => {
      if (err) reject(err);
      else if (res && res.error) reject(res.error);
      else resolve(res && res.result);
    });
  });
}

// 目前錢包連到的鏈（用於判斷是否需要切換）
export async function currentChainId(p = getProvider()) {
  if (!p) return null;
  try { return await call(p, "eth_chainId"); } catch { return null; }
}

// ---------- 主流程 ----------
// 回傳 { status: "switched" | "added" | "exists" }
export async function addOrSwitchChain() {
  const p = getProvider();
  if (!p) throw new WalletError("noWallet");

  // 0) 先拿到節點「當下」的 chainId：寫死的常數會在節點重建後變成過期值，
  //    錢包拿它去對 RPC 會判定不匹配。取不到就沿用設定值降級。
  try { await API.ensureChainId(); } catch { /* 節點沒回應：沿用設定值 */ }
  const idHex = chainIdHex();

  // 1) 已經在該鏈上就不必再切
  const cur = await currentChainId(p);
  if (cur && cur.toLowerCase() === idHex.toLowerCase()) {
    markAdded();
    return { status: "exists" };
  }

  // 2) 嘗試切換；4902 表示錢包裡還沒這條鏈
  try {
    await call(p, "wallet_switchEthereumChain", [{ chainId: idHex }]);
    markAdded();
    return { status: "switched" };
  } catch (e) {
    const err = normalizeError(e);
    if (err.code === "rejected") throw err;
    if (err.code !== "notAdded") throw err;
  }

  // 3) 觸發「添加網絡」彈窗
  try {
    await call(p, "wallet_addEthereumChain", [addChainParams()]);
    markAdded();
    return { status: "added" };
  } catch (e) {
    throw normalizeError(e);
  }
}

// 錢包事件（帳號 / 鏈切換）——供 UI 更新狀態用，可選
export function onWalletEvent(handler) {
  const p = getProvider();
  if (!p || typeof p.on !== "function") return () => {};
  const onChain = (id) => handler({ type: "chainChanged", chainId: id });
  const onAcc = (accs) => handler({ type: "accountsChanged", accounts: accs });
  p.on("chainChanged", onChain);
  p.on("accountsChanged", onAcc);
  return () => {
    if (typeof p.removeListener === "function") {
      p.removeListener("chainChanged", onChain);
      p.removeListener("accountsChanged", onAcc);
    }
  };
}

// 產生文字型網路參數（給「複製全部參數」與手動添加指引用）
export function paramsAsText() {
  const lines = [
    `${t("wallet.chainName")}: ${CHAIN.nameFull}`,
    `${t("wallet.chainId")}: ${chainIdNum()} (${chainIdHex()})`,
    `${t("wallet.currencySymbol")}: ${CHAIN.nativeSymbol}`,
    `${t("wallet.rpcUrl")}: ${CHAIN.rpcUrl}`,
  ];
  // 附上可分享的一鍵加鏈連結：運營複製整段貼給使用者，對方點開就能一鍵加鏈
  const share = shareAddChainUrl();
  if (share) lines.push(`${t("wallet.shareLink")}: ${share}`);
  return lines.join("\n");
}

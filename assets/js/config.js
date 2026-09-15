// ===== 鏈元數據（單一事實來源）=====
// 只要改這裡，瀏覽器展示與「一鍵添加網絡到錢包」(EIP-3085) 的參數會同步更新。
// 注意：修改 chainId 後 chainIdHex 會自動推導，不需手動改。

export const CHAIN = {
  // ⚠️ 這裡是「節點還沒回應時」的兜底值，實際送出給錢包的是節點當下回報的
  // eth_chainId（見下方 chainIdNum()）。節點重建創世塊後 chainId 會變，
  // 若只寫死常數，「一鍵加鏈」會把過期的 chainId 推給使用者錢包——
  // 錢包自己會去問同一個 RPC，兩邊不符就會拒絕或加入一條對不上的網絡。
  // 現網實際 chainId = 2520 (0x9d8)，這裡同步為真實值，避免首屏兜底就用錯。
  chainId: 2520,
  name: "WEB6",                 // 品牌 / 簡稱（頂欄、錢包 network 名）
  nameFull: "WEB6 聯盟鏈",       // 全名（添加網絡時顯示給用戶）
  consensus: "QBFT",
  // 客戶端家族不對外展示：Hero 只顯示 Chain ID。
  // （若要重新顯示，需加回 web3_clientVersion 的 RPC 呼叫與對應 i18n 佔位符。）
  // 原生代幣：顯示與錢包註冊共用。若你們的代幣符號不是 ETH，改這兩行即可。
  nativeName: "Ether",
  nativeSymbol: "ETH",
  nativeDecimals: 18,
  rpcUrl: "https://chain.web6.win/",
  explorerName: "WEB6 Explorer",
  // 首頁「通证」欄位展示的代幣合約（無索引器的純前端無法自動列舉，這裡維護一張精選清單）。
  // 部署新代幣後把地址加進來即可在首頁出現；address 為必填，name/symbol 可選（留空則即時向鏈上讀取）。
  featuredTokens: [
    { address: "0xff4073c066dd2d1ff2ecb3a24dd7bcf65b6361d0" },
  ],
};

// chainId 的 0x 形式（EIP-3085 / EIP-3326 要求十六進制字串）
export const CHAIN_ID_HEX = "0x" + CHAIN.chainId.toString(16);

// 節點當下實際回報的 chainId（由 api.js 每次 getChainInfo() 寫入）。
// 所有「要給錢包」或「要顯示給使用者」的 chainId 都走 chainIdNum() / chainIdHex()，
// 只有在節點尚無回應時才退回 CHAIN.chainId。
let _liveChainId = null;
export function setLiveChainId(n) {
  if (Number.isFinite(n) && n > 0) _liveChainId = Math.trunc(n);
}
export function chainIdNum() { return _liveChainId || CHAIN.chainId; }
export function chainIdHex() { return "0x" + chainIdNum().toString(16); }

// 本瀏覽器自身的對外地址（部署在任意子路徑都能正確自指），用作 blockExplorerUrls。
// 只輸出 https：部分錢包（MetaMask）會校驗該欄位，帶 http 可能導致整筆 addEthereumChain 被拒。
// 本地 http 預覽時回傳空字串，呼叫方會省略此欄位（鏈仍可正常加入，僅少一個「在瀏覽器查看」連結）。
export function explorerUrl() {
  try {
    if (location.protocol !== "https:") return "";
    const url = location.origin + location.pathname.replace(/[^/]*$/, "");
    return url.replace(/\/$/, "") || "";
  } catch {
    return "";
  }
}

// 可分享的「一鍵加鏈」深鏈接：對方點開即彈出加鏈彈窗（彈窗內那顆按鈕才是喚起錢包的必要手勢，
// 未經使用者手勢直接呼叫 wallet_addEthereumChain 會被瀏覽器/錢包攔截）。
// 指向 index.html 而非目錄：避免部署環境沒設定目錄預設首頁時 404。
// 與 explorerUrl() 不同，這裡 http/https 都能用 —— 它只是本頁自己的地址。
export function shareAddChainUrl() {
  try {
    return location.origin + location.pathname.replace(/[^/]*$/, "") + "index.html#add-chain";
  } catch {
    return "";
  }
}

// 組出 EIP-3085 的 addEthereumChain 參數
export function addChainParams() {  const params = {
    chainId: chainIdHex(),   // 用節點實際值，不用寫死常數
    chainName: CHAIN.nameFull,
    nativeCurrency: {
      name: CHAIN.nativeName,
      symbol: CHAIN.nativeSymbol,
      decimals: CHAIN.nativeDecimals,
    },
    rpcUrls: [CHAIN.rpcUrl],
  };
  const ex = explorerUrl();
  if (ex) params.blockExplorerUrls = [ex];
  return params;
}

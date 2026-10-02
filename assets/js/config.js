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
  // 原生代幣：顯示與錢包註冊共用。幣種變更時改這三行即可
  // （fmtWei / 統計面板 / 錢包 addChain 全部由此推导，無需個別修改）。
  nativeName: "Contribution",
  nativeSymbol: "CNT",
  nativeDecimals: 18,
  rpcUrl: "https://chain.web6.win/",
  explorerName: "WEB6 Explorer",
  // 網絡頭像（EIP-3085 的 iconUrls，注意這是「網絡」圖標，不是原生幣 CNT 的 logo）。
  // 必須是 https 且指向有效圖片，否則嚴格按規範實現的錢包會直接拒絕「加鏈」請求；
  // 若圖掛了，把這裡清空即可（params 會不再帶 iconUrls，加鏈不受影響）。
  iconUrl: "https://scan.web6.win/web6-network.png",
  // 验证人治理合约地址（见 contracts/ValidatorGovernance.sol）。
  // 创世预部署于固定地址 0x...01000000，并在 genesis 的
  // qbft.validatorcontractaddress 指向它，以启用 QBFT 合约治理模式。
  // Besu 每个区块调用 getValidators() 取得验证人集合。
  // 也可用 ?addr=0x... 临时覆盖（便于未写死地址的部署）。
  validatorGovernance: "0x0000000000000000000000000000000001000000",
  // 首頁「通证」欄位展示的代幣合約。
  // 現在這份清單是**加分項而非唯一來源**：tokens.html 還會自動掃後端（VerifyApi）的合約目錄，
  // 對每個已部署合約做 ERC-165 標準識別，符合 ERC-20 / 721 / 1155 的就自動進榜 ——
  // 部署新代幣不必再手動改這裡。
  // 這裡只留兩種用途：① 收錄後端還沒索引到的老合約 ② 用 name / symbol 覆寫鏈上那個值（例如鏈上名稱是雜訊）。
  // address 為必填，name/symbol 可選（留空則讀鏈上值）。
  featuredTokens: [
    { address: "0xff4073c066dd2d1ff2ecb3a24dd7bcf65b6361d0" },
  ],
};

// ===== 合約驗證服務（後端：.NET 10 + EF Core 10 + PostgreSQL）=====
// 靜態站沒有後端，ABI / 原始碼預設只能存在使用者自己的瀏覽器裡（contractmeta.js）。
// 設定這裡的網址後，合約頁會優先去問服務端，拿得到就用服務端的那份（所有人可見）。
// 留空 = 不啟用，行為與以前完全一樣（純本機模式）。
// 部署後端後把 baseUrl 換成實際網址即可；也可以在頁面裡臨時覆寫（見 verifyapi.js）。
export const VERIFY_API = {
  baseUrl: "https://verify.web6.win",   // 本地開發用；部署後換成實際網址（例如 "https://verify.web6.win"）
  timeoutMs: 4000,        // 讀取逾時：服務掛了要趕快放棄，不能拖慢首屏
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
  // EIP-3085 頂層 iconUrls（網絡頭像）；空字串則不傳，避免無效圖導致加鏈被拒
  if (CHAIN.iconUrl) params.iconUrls = [CHAIN.iconUrl];
  return params;
}

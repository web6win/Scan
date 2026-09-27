// ===== 合約本地元資料（ABI / 原始碼 / 驗證狀態 / 標籤）=====
//
// 存放位置：瀏覽器 localStorage，key = `web6.contract.<小寫地址>`。
// 本專案是純靜態站、沒有後端，所以沒有像 Etherscan 那樣的「全站驗證合約庫」，
// ABI 只能落在**使用者自己這台瀏覽器**。
//
// 寫入者：
//   1. contract.js 的「驗證」表單 —— 使用者手動貼上 / 上傳 ABI（與原始碼）。
//   2. deploy.js 部署成功之後 —— 自動把這一次的編譯結果帶過來，
//      新合約就不用再手動上傳一次 ABI。
//
// 讀取者：contract.js 的 概覽 / 代碼 / 讀取 / 寫入 / 事件 / 審計 都吃這份 abi。
//
// 欄位：abi（陣列）、name、compiler、optimize、optimizeRuns、evmVersion、
//       source（原始碼字串）、verified（bool）、labels（陣列）、implHistory（陣列）

export function metaKey(a) { return `web6.contract.${String(a || "").toLowerCase()}`; }

export function loadMeta(a) {
  try { return JSON.parse(localStorage.getItem(metaKey(a))) || {}; } catch { return {}; }
}

export function saveMeta(a, patch) {
  const m = Object.assign(loadMeta(a), patch);
  try { localStorage.setItem(metaKey(a), JSON.stringify(m)); } catch { /* 隱私模式 / 配額滿：靜默略過 */ }
  return m;
}

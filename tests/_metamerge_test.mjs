// ===== 合約頁「遠端驗證資料 vs 本機資料」合併規則 =====
//
// 背景（就是使用者回報的症狀）：
//   合約詳情頁「代码 & ABI」顯示空的 ABI `[]`、沒有源碼。根因有兩層：
//   1. 自動索引的紀錄只有地址 / 部署者，abi 是空陣列 —— 這是正常的（鏈上沒有 ABI）。
//   2. 但 fetchVerified 把空 ABI 當成「有效的遠端資料」回傳，contract.js 的合併
//      （Object.assign(本機, 遠端)）就用法空的 abi / source 蓋掉使用者剛部署時
//      存在本機 localStorage 的 ABI / 源碼 —— 使用者明明部署過，卻兩邊都看不到。
//
// 這支測試用「真實後端的真實紀錄」把兩個邊界釘住：
//   - 空殼紀錄（abi=[]）→ remote.abi 必須是 falsy，使用者本機的內容才不會被蓋掉
//   - 真實驗證紀錄（abi 有內容）→ remote.abi 必須是 truthy，遠端權威資料才會生效
// 需要：後端在 5099（且 DB 裡有 0x008d… 空殼紀錄與 0xff4073… 已驗證紀錄）。
import { createRequire } from "node:module";

const require = createRequire("file:///C:/Users/usewe/.workbuddy/binaries/node/workspace/");

globalThis.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
const { fetchVerified } = await import("file:///C:/Users/usewe/Documents/web6win/scan/Scan/assets/js/verifyapi.js");

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); c ? pass++ : fail++; };

const SHELL = "0x008deffb7ff73272fe0eb0aee2a1d954ca0f902f";   // 索引器自動收錄，abi=[] 
const REAL = "0xff4073c066dd2d1ff2ecb3a24dd7bcf65b6361d0";    // 真正提交過驗證，abi 有 11 項
const NOPE = "0x0000000000000000000000000000000000000001";    // 不存在

// ---------- 1. 空殼紀錄：不能謊稱自己有 ABI ----------
const shell = await fetchVerified(SHELL);
ok(shell !== null, "空殼紀錄仍拿得到（部署元資料有用：creator / deployTxHash）");
ok(shell && shell.abi === null, `空殼紀錄的 abi 被正規化成 null（實際 ${JSON.stringify(shell && shell.abi)}）`);
ok(shell && !shell.abi, "→ remote.abi 為 falsy ⇒ contract.js 走「只補部署元資料」分支，本機 ABI 不會被蓋掉");
ok(shell && /^0x[0-9a-f]{40}$/.test(shell.creator || ""), `空殼紀錄帶著 creator（${shell && shell.creator}）`);
ok(shell && /^0x[0-9a-f]{64}$/.test(shell.deployTxHash || ""),
  `空殼紀錄帶著 deployTxHash ⇒ 提交驗證時可當「免等索引」的證明（${shell && String(shell.deployTxHash).slice(0, 12)}…）`);

// ---------- 2. 真實驗證紀錄：遠端權威資料必須照常生效 ----------
const real = await fetchVerified(REAL);
ok(real !== null && Array.isArray(real.abi) && real.abi.length === 11,
  `已驗證紀錄的 ABI 照常回傳（${real && real.abi && real.abi.length} 項）`);
ok(real && !!real.abi, "→ remote.abi 為 truthy ⇒ 遠端整份蓋上（原本的優先權規則不變）");
ok(real && real.verified === true, "已驗證紀錄的 verified 旗標照常");

// ---------- 3. 不存在的合約：維持原本的 null ----------
const nope = await fetchVerified(NOPE);
ok(nope === null, "未收錄的合約仍回 null（前端視為「沒有」）");

// ---------- 4. 合併規則（對照 contract.js 的分支）----------
// contract.js：remote.abi ? 整份蓋上 : 只補 creator/deployTxHash/deployBlock
const localMeta = {
  abi: [{ type: "function", name: "set", inputs: [{ type: "uint256", name: "n" }], outputs: [] }],
  source: "pragma solidity ^0.8.26; contract Mine {}",
  name: "Mine", compiler: "solc 0.8.26", verified: true,
};
function merge(local, remote) {
  if (!remote) return local;
  if (remote.abi) return Object.assign({}, local, remote, { labels: local.labels || [], implHistory: local.implHistory || [] });
  return Object.assign({}, local, {
    creator: local.creator || remote.creator || "",
    deployTxHash: local.deployTxHash || remote.deployTxHash || "",
    deployBlock: local.deployBlock != null ? local.deployBlock : (remote.deployBlock ?? null),
  });
}
const m1 = merge(localMeta, shell);
ok(m1.abi === localMeta.abi && m1.source === localMeta.source,
  "合併空殼後：本機的 ABI 與源碼原封不動（＝使用者部署完仍看得到代碼）");
ok(m1.creator === shell.creator, "合併空殼後：仍補上了遠端的 creator");
const m2 = merge(localMeta, real);
ok(Array.isArray(m2.abi) && m2.abi.length === 11, "合併已驗證紀錄後：以遠端 ABI 為準");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

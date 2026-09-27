// tokenmeta 多標準識別單元測試（對真實節點）
// 用法：node _tokenmeta_test.mjs
// 重點：ERC-1155 這種「沒有 decimals / totalSupply」的合約不能被判成非代幣，
// 也不能因為其他人 revert 而整批報錯（api.batch 會，所以本模組自己寫了容忍版 batch）。

// Node 沒有 localStorage：做一個最小替身，順便驗證持久化的讀寫行為。
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => Array.from(store.keys())[i] ?? null,
  get length() { return store.size; },
};

const NET = await import("./assets/js/tokenmeta.js");
const { readTokenMeta, readTokenMetas, cachedStandard, detectStandard, clearTokenCaches, STANDARD_LABEL } = NET;

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + JSON.stringify(extra) : "")); }
}
function eq(a, b, name) { ok(a === b, name, { got: a, want: b }); }

// 已知地址（鏈 2520）
const ERC1155 = "0x67ee5d0f271088d2f4e0d4efae66ff2530e77e6c"; // 使用者剛部署的 ERC-1155 ChainLegend Assets
const OTHER = "0x17fd652c60726091d7758bb6581c6977ee87f258";   // 索引到的另一份合約（非代幣）
const EOA = "0xa1e4ed5e98a8e75f327b3fbeb45ffafa4fd39327";    // 部署者錢包（EOA）

console.log("\n== 1. 單筆：ERC-1155 識別 ==");
const m1155 = await readTokenMeta(ERC1155);
ok(!!m1155, "回傳非空");
eq(m1155 && m1155.standard, "erc1155", "standard 判定為 erc1155");
eq(m1155 && m1155.name, "ChainLegend Assets", "name() 讀到");
eq(m1155 && (m1155.symbol ?? null), null, "沒有 symbol() → null（不是空字串）");
eq(m1155 && (m1155.decimals ?? null), null, "ERC-1155 沒有 decimals → null");
eq(m1155 && (m1155.totalSupply ?? null), null, "標準 1155 沒有 totalSupply() → null");
eq(m1155 && m1155.uri, "hello0.json", "uri(0) 讀到");
eq(m1155 && m1155.ok, true, "ok=true");

console.log("\n== 2. 非代幣不該被誤判 ==");
const mOther = await readTokenMeta(OTHER);
eq(mOther && mOther.standard, null, "普通合約 standard=null");
const mEoa = await readTokenMeta(EOA);
eq(mEoa && mEoa.standard, null, "EOA standard=null");
eq(mEoa && mEoa.ok, true, "EOA 也算探測成功（只是不是代幣）");

console.log("\n== 3. 批量：順序、長度、容錯 ==");
const list = [ERC1155, EOA, OTHER, ERC1155];
const arr = await readTokenMetas(list);
eq(arr.length, 4, "回傳長度等於輸入");
eq(arr[0].standard, "erc1155", "第 1 筆順序正確");
eq(arr[1].standard, null, "第 2 筆順序正確");
eq(arr[3].standard, "erc1155", "重複地址不被吃掉");
ok(arr.every((x) => x.ok), "整批沒有人因為別的地址 revert 而被拖垮");

console.log("\n== 4. 空輸入與髒輸入 ==");
eq((await readTokenMetas([])).length, 0, "空陣列 → 空結果");
const dirty = await readTokenMetas(["", null, ERC1155, undefined]);
eq(dirty.filter(Boolean).length, 4, "髒輸入保底回傳等長結果");
eq(dirty[2].standard, "erc1155", "有效地址仍正常解析");

console.log("\n== 5. 標準快取（localStorage）==");
store.clear();
clearTokenCaches();
const before = cachedStandard(ERC1155);
eq(before, undefined, "清乾淨時 cachedStandard 回 undefined（代表沒探測過）");
await readTokenMeta(ERC1155);
await readTokenMeta(EOA);
eq(cachedStandard(ERC1155), "erc1155", "探測後 cachedStandard 回 erc1155");
eq(cachedStandard(EOA), null, "EOA 快取為 null（明確的「不是代幣」）");
ok(store.has("web6.tokstd." + ERC1155.toLowerCase()), "已寫入 localStorage");
ok(cachedStandard(ERC1155.toUpperCase()) === "erc1155", "地址大小寫不敏感");

console.log("\n== 6. detectStandard 走快取 ==");
eq(await detectStandard(EOA), null, "EOA → null");
eq(await detectStandard(ERC1155), "erc1155", "ERC-1155 → erc1155");

console.log("\n== 7. 元資料短快取（60s 內不重打 RPC）==");
let calls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (...a) => { calls++; return realFetch(...a); };
await readTokenMeta(ERC1155);
const after1 = calls;
await readTokenMeta(ERC1155);
eq(calls - after1, 0, "第二次讀取命中快取，沒有多發請求");
globalThis.fetch = realFetch;

console.log("\n== 8. STANDARD_LABEL ==");
eq(STANDARD_LABEL.erc20, "ERC-20", "label erc20");
eq(STANDARD_LABEL.erc721, "ERC-721", "label erc721");
eq(STANDARD_LABEL.erc1155, "ERC-1155", "label erc1155");

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);

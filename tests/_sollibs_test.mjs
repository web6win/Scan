// ===== sollabs.js 回歸測試（純邏輯，不需要瀏覽器）=====
// 跑法：node _sollibs_test.mjs
// 需要網路（會真的去 jsdelivr 抓 OpenZeppelin 原始碼驗證遞迴解析）

import {
  cmpVer, parseImports, detectPragma, splitPkg, joinPath,
  resolveImports, scanPackages, LIBS, LIB_BY_PKG,
  parseVersionList, isStableVersion, fetchVersions, clearVersionCache,
  pickVersion, solcRange, formatRange, versionCompat,
} from "./assets/js/sollibs.js";

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? "  → " + extra : ""}`); }
};

console.log("=== 1. cmpVer ===");
ok(cmpVer("0.8.20", "0.8.20") === 0, "相等");
ok(cmpVer("0.8.9", "0.8.30") < 0, "0.8.9 < 0.8.30（字串比較會錯）");
ok(cmpVer("0.8.30", "0.8.9") > 0, "0.8.30 > 0.8.9");
ok(cmpVer("0.7.6", "0.8.0") < 0, "0.7.6 < 0.8.0");
ok(cmpVer("0.8.20", "0.8") > 0, "缺位補零");

console.log("=== 2. parseImports ===");
ok(JSON.stringify(parseImports(`import "a.sol";`)) === '["a.sol"]', "裸 import");
ok(JSON.stringify(parseImports(`import {ERC20} from "@oz/ERC20.sol";`)) === '["@oz/ERC20.sol"]', "具名 import");
ok(JSON.stringify(parseImports(`import * as M from "./lib/M.sol";`)) === '["./lib/M.sol"]', "namespace import");
ok(JSON.stringify(parseImports(`import "@a/A.sol";\nimport "@b/B.sol";`)) === '["@a/A.sol","@b/B.sol"]', "多行");
ok(parseImports(`import "@a/A.sol" as A;`) .length === 1, "import ... as");
ok(parseImports(`contract C {}`).length === 0, "沒有 import 時為空");
ok(parseImports("").length === 0, "空字串安全");

console.log("=== 3. splitPkg ===");
{
  const a = splitPkg("@openzeppelin/contracts/token/ERC20/ERC20.sol");
  ok(a && a.pkg === "@openzeppelin/contracts" && a.rest === "token/ERC20/ERC20.sol", "scoped 套件", JSON.stringify(a));
  const b = splitPkg("solmate/src/tokens/ERC20.sol");
  ok(b && b.pkg === "solmate" && b.rest === "src/tokens/ERC20.sol", "無 scope 套件", JSON.stringify(b));
  ok(splitPkg("./Base.sol") === null, "相對路徑不算套件");
  ok(splitPkg("../Base.sol") === null, "上層相對路徑不算套件");
  ok(splitPkg("@openzeppelin/contracts") === null, "只有套件名沒有檔案 → null");
  ok(splitPkg("ERC20.sol") === null, "單檔名不算套件");
}

console.log("=== 4. joinPath ===");
ok(joinPath("token/ERC20/ERC20.sol", "./IERC20.sol") === "token/ERC20/IERC20.sol", "同層");
ok(joinPath("token/ERC20/ERC20.sol", "../../utils/Context.sol") === "utils/Context.sol", "上兩層");
ok(joinPath("@oz/contracts/a/B.sol", "./C.sol") === "@oz/contracts/a/C.sol", "保留套件前綴");
ok(joinPath("A.sol", "./B.sol") === "B.sol", "根層（使用者上傳檔只有檔名）");
ok(joinPath("a/b/C.sol", "../../../D.sol") === "D.sol", "超出根不會變成負數段");

console.log("=== 5. detectPragma ===");
ok(detectPragma("pragma solidity ^0.8.20;") === "0.8.20", "^0.8.20");
ok(detectPragma("pragma solidity ^0.8.0;") === "0.8.0", "^0.8.0");
ok(detectPragma("pragma solidity >=0.8.0 <0.9.0;") === "0.8.0", ">=0.8.0 <0.9.0 取下界");
ok(detectPragma("pragma solidity 0.8.20;") === "0.8.20", "固定版本");
ok(detectPragma("contract C {}") === null, "沒有 pragma → null");

console.log("=== 6. OpenZeppelin 版本自動挑選 ===");
{
  const oz = LIB_BY_PKG.get("@openzeppelin/contracts");
  ok(oz.pick("0.8.37") === "5.6.1", "solc 0.8.37 → OZ 5.6.1");
  ok(oz.pick("0.8.20") === "5.6.1", "solc 0.8.20 → OZ 5.6.1");
  ok(oz.pick("0.8.19") === "4.9.6", "solc 0.8.19 → OZ 4.9.6");
  ok(oz.pick("0.8.0") === "4.9.6", "solc 0.8.0 → OZ 4.9.6");
  ok(oz.pick("0.7.6") === "3.4.2", "solc 0.7.6 → OZ 3.4.2");
  ok(LIBS.every((l) => Array.isArray(l.versions) && l.versions.length), "每個已知套件都有版本清單");
  ok(LIBS.every((l) => typeof l.pick === "function"), "每個已知套件都有 pick()");
}

console.log("=== 7. scanPackages ===");
{
  const f = new Map([["MyToken.sol", `
    pragma solidity ^0.8.20;
    import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
    import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
    import "./Helper.sol";
  `]]);
  const pkgs = scanPackages(f);
  ok(pkgs.length === 1 && pkgs[0] === "@openzeppelin/contracts", "只列裸套件、去重", JSON.stringify(pkgs));
}

console.log("=== 8. 真實遞迴抓取：只給一個 import OZ 的 .sol ===");
{
  const src = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MyToken is ERC20 {
    constructor() ERC20("MyToken", "MTK") { _mint(msg.sender, 1000000 ether); }
}`;
  const files = new Map([["MyToken.sol", src]]);
  const r = await resolveImports({ files, solcVersion: "0.8.37" });
  ok(r.failures.length === 0, "沒有抓取失敗", JSON.stringify(r.failures.slice(0, 3)));
  ok(r.sources.size >= 5, `抓回整棵依賴樹（實得 ${r.sources.size} 檔）`);
  ok(r.sources.has("@openzeppelin/contracts/token/ERC20/ERC20.sol"), "ERC20.sol 在裡面");
  ok(r.sources.has("@openzeppelin/contracts/utils/Context.sol"), "間接依賴 Context.sol 也抓到了");
  ok(r.sources.has("@openzeppelin/contracts/token/ERC20/IERC20.sol"), "IERC20.sol 也抓到");
  const v = (r.libs.find((l) => l.pkg === "@openzeppelin/contracts") || {}).version;
  ok(v === "5.6.1", `pragma ^0.8.20 → 挑到 ${v}`);
  ok(r.libs.length === 1 && r.libs[0].known, "識別為已知套件");
  // 每個 key 都要能還原成一個可抓取的路徑（相對 import 解析正確）
  const bad = [...r.sources.keys()].filter((k) => !k.startsWith("@openzeppelin/contracts/"));
  ok(bad.length === 0, "所有 key 都在同一套件命名空間下", JSON.stringify(bad.slice(0, 3)));
}

console.log("=== 9. 版本覆蓋（想用 OZ 4）===");
{
  const src = `pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract T is ERC20 { constructor() ERC20("T","T") {} }`;
  const files = new Map([["T.sol", src]]);
  const auto = await resolveImports({ files, solcVersion: "0.8.37" });
  ok((auto.libs[0] || {}).version === "4.9.6", `pragma ^0.8.0 自動挑 4.9.6（實得 ${(auto.libs[0]||{}).version}）`);
  const forced = await resolveImports({ files, solcVersion: "0.8.37", overrides: { "@openzeppelin/contracts": "5.6.1" } });
  ok((forced.libs[0] || {}).version === "5.6.1", "overrides 生效");
}

console.log("=== 10. 使用者自己上傳的檔案不會被重抓 ===");
{
  const src = `pragma solidity ^0.8.20;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract T {}`;
  const files = new Map([
    ["T.sol", src],
    ["ERC20.sol", "contract ERC20 {}"],   // 使用者自己提供了（檔名相符）
  ]);
  const r = await resolveImports({ files, solcVersion: "0.8.37" });
  ok(!r.sources.has("@openzeppelin/contracts/token/ERC20/ERC20.sol"), "同名檔案已上傳 → 不重抓");
}

console.log("=== 11. 未知套件 / 抓不到時要回報、不能丟例外 ===");
{
  const files = new Map([["X.sol", `import "@no/such/pkg/Whatever.sol";`]]);
  const r = await resolveImports({ files, solcVersion: "0.8.37" });
  ok(r.sources.size === 0, "一個都沒抓到");
  ok(r.failures.length === 1, "回報一筆失敗", JSON.stringify(r.failures));
  ok(r.failures[0].error.includes("404") || /HTTP/.test(r.failures[0].error), "錯誤訊息帶狀態碼");
}

console.log("=== 12. 相對 import 在使用者檔案之間 ===");
{
  const files = new Map([
    ["A.sol", `import "./B.sol"; contract A is B {}`],
    ["B.sol", `contract B {}`],
  ]);
  const r = await resolveImports({ files, solcVersion: "0.8.37" });
  ok(r.sources.size === 0, "自己人有的就不去抓");
  ok(r.failures.length === 0, "不該報錯", JSON.stringify(r.failures));
}

console.log("=== 13. 上限防呆 ===");
{
  const files = new Map([["T.sol", `import "@openzeppelin/contracts/token/ERC20/ERC20.sol";`]]);
  const r = await resolveImports({ files, solcVersion: "0.8.37", maxFiles: 3 });
  ok(r.sources.size <= 3, `maxFiles=3 時最多 3 檔（實得 ${r.sources.size}）`);
  ok(r.failures.length > 0, "超額會被記進 failures");
}

console.log("=== 14. 版本清單解析（預發布要過濾）===");
{
  ok(isStableVersion("5.6.1"), "5.6.1 是正式版");
  ok(!isStableVersion("5.7.0-rc.0"), "5.7.0-rc.0 是預發布");
  ok(!isStableVersion("2.0.0-beta.0"), "2.0.0-beta.0 是預發布");
  ok(isStableVersion("1.0"), "兩段版本號也算正式版");

  const j = parseVersionList({ tags: { latest: "5.6.1" }, versions: [{ version: "5.7.0" }, { version: "5.6.1" }] });
  ok(JSON.stringify(j) === '["5.7.0","5.6.1"]', "jsdelivr 形狀（陣列）", JSON.stringify(j));

  const n = parseVersionList({ "dist-tags": { latest: "1.5.0" }, versions: { "1.5.0": {}, "1.3.0": {} } });
  ok(n.length === 2 && n.includes("1.5.0") && n.includes("1.3.0"), "npm registry 形狀（物件）", JSON.stringify(n));

  ok(parseVersionList(null).length === 0, "null 安全");
  ok(parseVersionList({}).length === 0, "空物件安全");
}

console.log("=== 15. 版本 ↔ solc 相容性 ===");
{
  ok(formatRange({ min: "0.8.20" }) === "^0.8.20", "只有下界 → ^0.8.20");
  ok(formatRange({ min: "0.6.0", max: "0.8.0" }) === ">=0.6.0 <0.8.0", "有上下界 → >=0.6.0 <0.8.0");
  ok(formatRange(null) === null, "null → null");

  // 這些數字是實測各版本 .sol 的 pragma 來的
  ok(versionCompat("@openzeppelin/contracts", "5.6.1", "0.8.20").state === "ok", "OZ 5.6.1 + ^0.8.20 = ok");
  ok(versionCompat("@openzeppelin/contracts", "5.6.1", "0.8.0").state === "need-newer", "OZ 5.6.1 + ^0.8.0 = 需要更新的 solc");
  ok(versionCompat("@openzeppelin/contracts", "4.9.6", "0.8.0").state === "ok", "OZ 4.9.6 + ^0.8.0 = ok");
  ok(versionCompat("@openzeppelin/contracts", "3.4.2", "0.8.20").state === "too-new", "OZ 3.4.2（<0.8.0）+ ^0.8.20 = 太舊");
  ok(versionCompat("@openzeppelin/contracts", "3.4.2", "0.6.0").state === "ok", "OZ 3.4.2 + 0.6.0 = ok");
  ok(versionCompat("@some/unknown", "1.0.0", "0.8.20").state === "unknown", "沒實測過的套件 → unknown（不亂給提示）");
}

console.log("=== 16. pickVersion：從真實清單挑 ===");
{
  const list = ["5.7.0", "5.6.1", "5.0.2", "4.9.6", "3.4.2", "2.5.1"];
  // npm 的 latest 優先：5.7.0 雖然最新但掛在 dev tag，不要自動挑它
  ok(pickVersion("@openzeppelin/contracts", "0.8.20", list, "5.6.1") === "5.6.1", "latest tag 相容 → 挑 latest");
  ok(pickVersion("@openzeppelin/contracts", "0.8.20", list, null) === "5.7.0", "沒有 latest → 挑相容的最新版");
  ok(pickVersion("@openzeppelin/contracts", "0.8.0", list, "5.6.1") === "4.9.6", "pragma ^0.8.0 → 退回 4.x");
  ok(pickVersion("@openzeppelin/contracts", "0.6.0", list, "5.6.1") === "3.4.2", "pragma 0.6.0 → 退回 3.x");
  ok(pickVersion("@openzeppelin/contracts", "0.5.0", list, "5.6.1") === "2.5.1", "pragma 0.5.0 → 退回 2.x");
  ok(pickVersion("@openzeppelin/contracts", "0.8.20", [], null) === "5.6.1", "清單是空 → 用內建規則");
}

console.log("=== 17. fetchVersions ===");
{
  clearVersionCache();
  const jsdelivr = { tags: { latest: "5.6.1" }, versions: [{ version: "5.7.0" }, { version: "5.7.0-rc.0" }, { version: "5.6.1" }, { version: "4.9.6" }] };
  const r1 = await fetchVersions("@mock/a", { fetchFn: async () => JSON.stringify(jsdelivr) });
  ok(r1.ok, "jsdelivr 形狀解析成功");
  ok(r1.latest === "5.6.1", "latest 取自 tags", String(r1.latest));
  ok(JSON.stringify(r1.versions) === '["5.7.0","5.6.1","4.9.6"]', "由新到舊、濾掉 rc", JSON.stringify(r1.versions));

  const npmShape = { "dist-tags": { latest: "1.5.0" }, versions: { "1.5.0": {}, "1.5.1-beta.0": {}, "1.3.0": {} } };
  const r2 = await fetchVersions("@mock/b", { fetchFn: async () => JSON.stringify(npmShape) });
  ok(r2.ok && JSON.stringify(r2.versions) === '["1.5.0","1.3.0"]', "npm registry 形狀也能解析", JSON.stringify(r2.versions));

  // 兩個來源都炸 → 已知套件退回內建清單；不丟例外（版本清單抓不到不該擋住編譯）
  const r3 = await fetchVersions("@openzeppelin/contracts", { fetchFn: async () => { throw new Error("HTTP 500"); } });
  ok(!r3.ok, "抓不到 → ok=false");
  ok(r3.versions.length > 0, "已知套件仍有內建清單可選", JSON.stringify(r3.versions));
  const r4 = await fetchVersions("@nope/nope", { fetchFn: async () => { throw new Error("HTTP 500"); } });
  ok(!r4.ok && r4.versions.length === 0, "未知套件 → 空清單，也不丟例外");

  // 快取：第二次就算來源掛了也該拿得到（同一個套件不該一直打 npm）
  const r5 = await fetchVersions("@mock/a", { fetchFn: async () => { throw new Error("down"); } });
  ok(r5.cached === true && r5.versions.length === 3, "命中快取", JSON.stringify(r5.versions));
  clearVersionCache();
}

console.log("=== 18. 真實網路：版本清單 + 選了舊版就真的抓那個版本 ===");
{
  clearVersionCache();
  const v = await fetchVersions("@openzeppelin/contracts");
  ok(v.ok && v.versions.length > 20, `拿到 ${v.versions.length} 個版本`);
  ok(v.versions[0] === v.latest || cmpVer(v.versions[0], v.latest) >= 0, "清單由新到舊");

  const p520 = pickVersion("@openzeppelin/contracts", "0.8.20", v.versions, v.latest);
  const p80 = pickVersion("@openzeppelin/contracts", "0.8.0", v.versions, v.latest);
  const p60 = pickVersion("@openzeppelin/contracts", "0.6.0", v.versions, v.latest);
  ok(p520.split(".")[0] === "5", `pragma ^0.8.20 → OZ ${p520}`);
  ok(p80.split(".")[0] === "4", `pragma ^0.8.0 → OZ ${p80}`);
  ok(p60.split(".")[0] === "3", `pragma 0.6.0 → OZ ${p60}`);

  // 手動指定舊版：抓回來的原始碼要真的是那個版本
  const files = new Map([["T.sol", `pragma solidity ^0.8.0;\nimport "@openzeppelin/contracts/token/ERC20/ERC20.sol";\ncontract T is ERC20 {}`]]);
  const r = await resolveImports({ files, solcVersion: "0.8.37", overrides: { "@openzeppelin/contracts": "4.9.6" } });
  const src = r.sources.get("@openzeppelin/contracts/token/ERC20/ERC20.sol") || "";
  ok(/pragma solidity \^0\.8\.0;/.test(src), "指定 4.9.6 → 抓回來的 pragma 是 ^0.8.0");
  ok([...r.urls.values()].some((u) => u.includes("contracts@4.9.6")), "網址帶著指定的版本");
  ok(r.libs[0].version === "4.9.6", "結果裡回報 4.9.6", JSON.stringify(r.libs));
}

console.log(`\n===== ${pass} 通過 / ${fail} 失敗 =====`);
process.exit(fail ? 1 : 0);

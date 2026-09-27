// 冒煙：在真瀏覽器裡載 solc 並編譯一份樣本合約（驗證 compiler.js 的 emscripten wrapper 是否可用）
// 用法：node _solctest.mjs
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
// 測試環境裡「localhost 頁面打外網」會被沙箱擋住，所以由本機伺服器冒充站內自託管的 soljson
const VENDOR_FILE = process.env.SOLC_LOCAL || "/tmp/soljson-0.8.26.js";
const server = createServer(async (req, res) => {
  // normalize() 在 Windows 會把 / 換成 \，正則與 join 都會失效，統一轉回 /
  let p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname))
    .replace(/\\/g, "/").replace(/^(\.\.\/)+/, "");
  if (p === "/" || p === "\\") p = "/index.html";
  if (/^\/assets\/vendor\/solc\/soljson-[\d.]+\.js$/.test(p)) {
    try {
      const buf = await readFile(VENDOR_FILE);
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(buf);
    } catch { /* 沒有本地副本就讓它 404，走 CDN */ }
  }
  try {
    const f = join(root, p);
    const s = await stat(f);
    if (!s.isFile()) throw new Error("dir");
    res.writeHead(200, { "content-type": TYPES[extname(f)] || "application/octet-stream" });
    res.end(await readFile(f));
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nf");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const mod = await import(process.env.WEB6_PW || "file:///C:/Users/usewe/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js");
const chromium = mod.chromium || mod.default.chromium;
const browser = await chromium.launch({ channel: process.env.WEB6_BROWSER || "msedge" });
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("  [console.error]", m.text()); });
await page.goto(base + "/index.html", { waitUntil: "domcontentloaded" });

console.log("[載入 compiler.js + 取用 solc]");
const VER = process.env.SOLC_VER || "0.8.26";
const out = await page.evaluate(async (VER) => {
  const C = await import("/assets/js/compiler.js");
  const versions = await C.fetchSolcVersions();
  const t0 = Date.now();
  const solc = await C.loadCompiler(VER);
  const loadMs = Date.now() - t0;
  const ver = solc.version();

  // 單檔案
  const src = {
    "Counter.sol": {
      content: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Counter {
    uint256 public n;
    constructor(uint256 _n) { n = _n; }
    function inc() external { n += 1; }
}`,
    },
  };
  const o = await solc.compileInput(C.standardInput({ sources: src, optimize: true, runs: 200 }));
  const list = C.collectContracts(o);
  const diags = C.collectDiagnostics(o);

  // 多檔案 + import 回調（故意不放進 sources，靠 callback 餵）
  const a = {
    "Main.sol": { content: `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\nimport "./Lib.sol";\ncontract Main { uint256 public v = Lib.k(); }` },
  };
  // 第二個參數是「路徑 -> 原始碼」表，Worker 用它當 import 回調
  const o2 = await solc.compileInput(C.standardInput({ sources: a }), {
    "Lib.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\nlibrary Lib { function k() internal pure returns (uint256) { return 7; } }`,
  });
  const list2 = C.collectContracts(o2);

  // 故意的錯誤：syntax error 要能被抓到
  const o3 = await solc.compileInput(C.standardInput({ sources: { "Bad.sol": { content: "pragma solidity ^0.8.20; contract Bad { uint x = }" } } }));

  return {
    rawLen: (C.lastCompileRaw() || "").length,
    versions: versions.slice(0, 5),
    loadMs, ver,
    name: list[0] && list[0].name,
    bytecodePrefix: list[0] && list[0].bytecode.slice(0, 10),
    abiLen: list[0] && list[0].abi.length,
    ctor: list[0] && list[0].abi.find((x) => x.type === "constructor"),
    src: C.lastCompilerSource(),
    diags: diags.map((d) => d.severity),
    imported: list2.map((x) => x.name),
    badSeverity: C.collectDiagnostics(o3).map((d) => d.severity),
  };
}, VER);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗", m); } };
console.log(out.ver, `載入 ${out.loadMs}ms`, "來源:", out.src, "| 可用版本:", out.versions.join(", "));
ok(out.rawLen > 100, "編譯輸出非空（" + out.rawLen + " 位元組）");
ok(/\/assets\/vendor\//.test(out.src || ""), "使用站內自託管的 soljson（離線也可用）");
ok(/^0\.8\./.test(out.ver), "solc 版本字串正確（" + out.ver + "）");
ok(out.name === "Counter", "編譯出合約 Counter");
// solc 回傳的 bytecode 是純 hex，沒有 0x 前綴（deploy.js 會自己補）
ok(/^[0-9a-fA-F]{10}$/.test(out.bytecodePrefix || ""), "取得部署 bytecode");
ok(out.abiLen >= 3, "取得 ABI（含 Constructor / inc / n）");
ok(!!out.ctor && out.ctor.inputs.length === 1 && out.ctor.inputs[0].type === "uint256", "ABI 裡有構造函數參數 uint256");
ok((out.imported || []).includes("Main"), "import 回調補齊依賴後可編譯");
ok((out.badSeverity || []).includes("error"), "語法錯誤能被 collectDiagnostics 抓成 error");

await browser.close();
server.close();
console.log(`\n${fail === 0 ? "全部通過" : "有失敗"}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

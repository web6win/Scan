// 冒煙：部署頁「上傳原始碼 → 瀏覽器內編譯 → 錢包插件簽名部署」全流程
// 測試環境打不到外網，所以這裡：
//   - 站內自託管的 soljson 由本機伺服器提供（等同離線部署情境）
//   - 用假的 window.ethereum（EIP-1193）冒充錢包插件
//   - 攔截 fetch 把 RPC 換成假回應，全程不碰真節點
// 用法：SOLC_LOCAL=<soljson 絕對路徑> node _deploytest.mjs
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = process.env.SOLC_LOCAL || "C:/Users/usewe/AppData/Local/Temp/soljson-0.8.26.js";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname))
    .replace(/\\/g, "/").replace(/^(\.\.\/)+/, "");
  if (/^\/assets\/vendor\/solc\/soljson-[\d.]+\.js$/.test(p)) {
    try {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(await readFile(LOCAL));
    } catch { /* 沒本地副本就 404，走 CDN */ }
  }
  try {
    const f = join(root, p === "/" ? "/index.html" : p);
    const s = await stat(f);
    if (!s.isFile()) throw new Error("dir");
    res.writeHead(200, { "content-type": TYPES[extname(f)] || "application/octet-stream" });
    res.end(await readFile(f));
  } catch { res.writeHead(404); res.end("nf"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗", m); } };

const mod = await import(process.env.WEB6_PW || "file:///C:/Users/usewe/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js");
const chromium = mod.chromium || mod.default.chromium;
const browser = await chromium.launch({ channel: process.env.WEB6_BROWSER || "msedge" });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));

// 假 RPC + 假錢包：在頁面任何腳本之前注入
await page.addInitScript(() => {
  const TX = "0x" + "11".repeat(32);
  const ADDR = "0x2222222222222222222222222222222222222222";
  const ACCOUNT = "0x1111111111111111111111111111111111111111";
  window.__MOCK = { TX, ADDR, ACCOUNT, tx: null, raw: null };

  const realFetch = window.fetch.bind(window);
  const handle = (method) => {
    switch (method) {
      case "eth_chainId": return "0x9d8";
      case "net_version": return "2520";
      case "eth_blockNumber": return "0x100";
      case "eth_gasPrice": return "0x3b9aca00";
      case "eth_getTransactionCount": return "0x0";
      case "eth_estimateGas": return "0x1e8480";
      case "eth_getBalance": return "0xde0b6b3a7640000";
      case "eth_getCode": return "0x608060405234801561001057600080fd5b50";
      case "eth_call": return "0x";
      case "eth_getLogs": return [];
      case "eth_sendRawTransaction": return TX;
      case "eth_getTransactionReceipt":
        return { status: "0x1", contractAddress: ADDR, blockNumber: "0xff", gasUsed: "0x5208", transactionHash: TX };
      case "eth_getBlockByNumber":
      case "eth_getBlockByHash":
        return { number: "0xff", hash: "0x" + "ab".repeat(32), timestamp: "0x66000000", transactions: [], miner: "0x0", gasUsed: "0x0", gasLimit: "0x1c9c380" };
      default: return "0x";
    }
  };
  window.fetch = async (url, opts) => {
    const u = String((url && url.url) || url || "");
    if (u.includes("chain.web6.win")) {
      let body = [];
      try { body = JSON.parse((opts && opts.body) || "[]"); } catch { body = []; }
      const one = (c) => ({ jsonrpc: "2.0", id: c.id, result: handle(c.method) });
      const payload = Array.isArray(body) ? body.map(one) : one(body);
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(url, opts);
  };

  window.ethereum = {
    isMetaMask: true,
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [ACCOUNT];
      if (method === "eth_chainId") return "0x9d8";
      if (method === "eth_sendTransaction") { window.__MOCK.tx = params[0]; return TX; }
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
      const err = new Error("unsupported " + method); err.code = 4200; throw err;
    },
    on: () => {},
    removeListener: () => {},
  };
});

const SRC = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Counter {
    uint256 public n;
    constructor(uint256 _n) { n = _n; }
    function inc() external { n += 1; }
}`;

console.log("\n[上傳原始碼]");
await page.goto(base + "/deploy.html", { waitUntil: "domcontentloaded" });
await page.setInputFiles("#solFiles", { name: "Counter.sol", mimeType: "text/plain", buffer: Buffer.from(SRC) });
await page.waitForSelector("#fileList .file-item", { timeout: 10000 });
ok((await page.locator("#fileList .file-name").first().textContent()) === "Counter.sol", "檔案出現在清單裡");

console.log("\n[編譯]");
await page.selectOption("#solcVer", "0.8.26");
ok(await page.locator("#evmVersion").count() === 1, "編譯面板有 EVM 版本選擇器");
const evmOpts = await page.locator("#evmVersion option").allTextContents();
ok(evmOpts.includes("default") && evmOpts.includes("cancun"), "EVM 版本含 default 與 cancun");
await page.selectOption("#evmVersion", "cancun");
ok((await page.inputValue("#evmVersion")) === "cancun", "可選擇 EVM 版本（cancun）");
await page.click("#compileBtn");
await page.waitForSelector("#contractPick", { timeout: 150000 });
const optText = await page.locator("#contractPick option").first().textContent();
ok(/Counter/.test(optText || ""), "合約選擇器列出 Counter");
const bc = await page.inputValue("#bytecode");
ok(/^0x[0-9a-fA-F]{100,}/.test(bc), "bytecode 自動帶入部署參數（" + bc.length + " 字元）");
ok(await page.locator("#ctorFields").isVisible(), "建構函數參數表單出現");
ok(!(await page.locator("#bytecodeAuto").isHidden()), "顯示「已由編譯結果自動填充」");
const abi = JSON.parse(await page.inputValue("#ctorAbi"));
ok(Array.isArray(abi) && abi.some((x) => x.type === "constructor"), "ABI 自動帶入");

console.log("\n[錢包插件簽名部署]");
await page.fill("#ctorFields input[data-abi-type]", "42");
await page.selectOption("#signMode", "wallet");
await page.click("#connectBtn");
await page.waitForFunction(() => {
  const s = document.getElementById("walletState");
  return s && s.textContent && s.textContent.includes("0x1111");
}, null, { timeout: 15000 });
ok(true, "錢包連上並顯示帳號");
await page.click("#deployBtn");
await page.waitForFunction(() => document.querySelector("#deployResult .kv-row"), null, { timeout: 60000 });
const tx = await page.evaluate(() => window.__MOCK.tx);
ok(!!tx && tx.from === "0x1111111111111111111111111111111111111111", "交易由錢包帳號發出");
ok(!!tx && tx.data.toLowerCase().startsWith(bc.toLowerCase()), "data 以合約 bytecode 開頭");
ok(!!tx && /000000000000000000000000000000000000000000000000000000000000002a$/.test(tx.data), "建構函數參數 42 已 ABI 編碼並接在後面");
ok(!!tx && /^0x[0-9a-fA-F]+$/.test(tx.gas || ""), "帶上 gas 上限（0x" + (tx && tx.gas) + "）");

const resultText = await page.locator("#deployResult").innerText();
ok(/0x1111111111111111/.test(resultText), "結果面板顯示交易雜湊");
ok(/0x2222222222222222/.test(resultText), "結果面板顯示合約地址");
ok(/在浏览器中查看合约/.test(resultText), "結果面板有「在瀏覽器中查看合約」入口");

console.log("\n[部署後自動記住 ABI（合約頁讀寫的前提）]");
const saved = await page.evaluate(() => {
  const raw = localStorage.getItem("web6.contract.0x2222222222222222222222222222222222222222");
  if (!raw) return null;
  const m = JSON.parse(raw);
  return {
    keys: Object.keys(m), abi: m.abi, name: m.name, verified: m.verified,
    compiler: m.compiler, source: m.source || "", evmVersion: m.evmVersion,
  };
});
ok(!!saved, "合約地址的本機元資料已寫入 localStorage");
const names = (saved && saved.abi || []).filter((x) => x.type === "function").map((x) => x.name);
ok(names.includes("n"), "存下來的 ABI 含讀取函數 n()");
ok(names.includes("inc"), "存下來的 ABI 含寫入函數 inc()");
ok(saved && saved.verified === true, "標記為已驗證（bytecode 就是從這份原始碼編出來的）");
ok(saved && /^0\.8\.\d+/.test(saved.compiler || ""), "記錄編譯器版本：" + (saved && saved.compiler));
ok(saved && /contract Counter/.test(saved.source) && /function inc/.test(saved.source), "原始碼一併存進去（" + (saved.source || "").length + " 字元）");
ok(saved && saved.evmVersion === "cancun", "記錄 EVM 版本：cancun");
ok(/已保存到本机浏览器/.test(resultText), "結果面板提示 ABI 已保存");

console.log("\n[私鑰簽名路徑（既有功能沒被改壞）]");
await page.selectOption("#signMode", "key");
await page.fill("#privKey", "0x" + "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d".padStart(64, "0"));
await page.click("#deployBtn");
await page.waitForFunction(() => {
  const r = document.getElementById("deployResult");
  return r && /0x1111111111111111/.test(r.innerText);
}, null, { timeout: 60000 });
ok(true, "私鑰路徑也能送出並顯示結果");

console.log("\n[合約頁真的能讀寫（用上面存下來的 ABI）]");
await page.goto(base + "/address.html#/address/0x2222222222222222222222222222222222222222", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".c-tab", { timeout: 40000 });
await page.click('.c-tab[data-tab="read"]');
await page.waitForSelector(".fn-read .fn-name", { timeout: 30000 });
const readNames = await page.locator(".fn-read .fn-name").allTextContents();
ok(readNames.some((s) => /n\(\)/.test(s)), "「讀取合約」直接列出 n() → " + readNames.join(" , "));
await page.click('.c-tab[data-tab="write"]');
await page.waitForSelector(".fn-write .fn-name", { timeout: 30000 });
const writeNames = await page.locator(".fn-write .fn-name").allTextContents();
ok(writeNames.some((s) => /inc\(\)/.test(s)), "「寫入合約」直接列出 inc() → " + writeNames.join(" , "));

ok(errors.length === 0, "沒有未捕捉的頁面錯誤" + (errors.length ? " → " + errors.join(" | ") : ""));

await browser.close();
server.close();
console.log(`\n${fail === 0 ? "全部通過" : "有失敗"}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

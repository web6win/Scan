// 前後端聯調：靜態站 ↔ 驗證服務（.NET 10 + EF Core + PostgreSQL）
// 前置：驗證服務已在跑（預設 http://127.0.0.1:5099）
//   用法：VERIFY_API_URL=http://127.0.0.1:5099 VERIFY_ADMIN_KEY=xxx node _apitest.mjs
//
// 測的是四件事：
//   1) 服務端 API 本身（寫入要金鑰、讀取公開）
//   2) 合約頁真的吃得到服務端的 ABI（而且本機 localStorage 是空的 → 證明是遠端來的）
//   3) 服務端掛掉 / 沒設定時靜默降級，不噴錯、不白屏
//   4) 部署頁的「發布到驗證服務」路徑（沒金鑰會擋、有金鑰寫得進去）
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = (process.env.VERIFY_API_URL || "http://127.0.0.1:5099").replace(/\/+$/, "");
// 公開倉庫：管理員金鑰一律走環境變數（VERIFY_ADMIN_KEY），不要寫死在這裡
const KEY = process.env.VERIFY_ADMIN_KEY || "";
const ADDR = "0x2222222222222222222222222222222222222222";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗", m); } };

// ---------- 靜態站 ----------
const server = createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname))
    .replace(/\\/g, "/").replace(/^(\.\.\/)+/, "");
  try {
    const f = join(root, p === "/" ? "/index.html" : p);
    const s = await stat(f);
    if (!s.isFile()) throw new Error("dir");
    res.writeHead(200, { "content-type": TYPES[extname(f)] || "application/octet-stream" });
    res.end(await readFile(f));
  } catch { res.writeHead(404); res.end("nf"); }
});
// 固定用 8080：這個來源在服務端的 Cors:Origins 白名單裡，才測得到真實的跨網域情境
await new Promise((r) => server.listen(8080, "127.0.0.1", r));
const base = "http://127.0.0.1:8080";

// ---------- 1) API 本身 ----------
console.log("\n[服務端 API]");
let health = null;
try { health = await (await fetch(`${API}/api/health`)).json(); } catch { /* 下面會報 */ }
ok(!!health && health.status === "ok", `健康檢查：${health ? JSON.stringify(health).slice(0, 80) : "連不上 " + API}`);
if (!health) { console.log("\n請先啟動驗證服務後再跑本測試。"); process.exit(1); }

const ABI_COUNTER = [
  { type: "constructor", inputs: [{ name: "_n", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "n", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "inc", inputs: [], outputs: [], stateMutability: "nonpayable" },
];
const SRC = "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract Counter { uint256 public n; constructor(uint256 _n) { n = _n; } function inc() external { n += 1; } }";

let r = await fetch(`${API}/api/contracts/${ADDR}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Counter", abi: ABI_COUNTER }) });
ok(r.status === 401, "沒帶金鑰寫入 → 401");

r = await fetch(`${API}/api/contracts/${ADDR}`, {
  method: "PUT",
  headers: { "content-type": "application/json", "X-Api-Key": KEY },
  body: JSON.stringify({
    name: "Counter", compiler: "0.8.26+commit.8a97fa7a", optimize: true, optimizeRuns: 200,
    evmVersion: "default", license: "MIT", verified: true, submitter: "apitest",
    abi: ABI_COUNTER, source: SRC, sourceFiles: { "Counter.sol": SRC },
  }),
});
ok(r.status === 200 || r.status === 201, "帶金鑰寫入 → " + r.status);
const got = await (await fetch(`${API}/api/contracts/${ADDR}`)).json();
ok(Array.isArray(got.abi) && got.abi.some((x) => x.name === "inc"), "公開讀取拿到 ABI（含 inc）");
ok(got.source && got.source.includes("contract Counter"), "原始碼一併讀回");
ok(got.verified === true && got.name === "Counter", "verified / name 正確");

// ---------- 瀏覽器 ----------
const mod = await import(pathToFileURL(process.env.WEB6_PW || "C:/Users/usewe/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js").href);
const chromium = mod.chromium || mod.default.chromium;
const browser = await chromium.launch({ channel: process.env.WEB6_BROWSER || "msedge" });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));

// 假 RPC：這個地址在本測試裡「是合約」，其他全部假的，不碰真節點
await page.addInitScript(() => {
  const handle = (m) => {
    switch (m) {
      case "eth_chainId": return "0x9d8";
      case "net_version": return "2520";
      case "eth_blockNumber": return "0x100";
      case "eth_gasPrice": return "0x3b9aca00";
      case "eth_getTransactionCount": return "0x0";
      case "eth_getBalance": return "0xde0b6b3a7640000";
      case "eth_getCode": return "0x608060405234801561001057600080fd5b50";
      case "eth_call": return "0x";
      case "eth_getLogs": return [];
      case "eth_getBlockByNumber":
      case "eth_getBlockByHash":
        return { number: "0xff", hash: "0x" + "ab".repeat(32), timestamp: "0x66000000", transactions: [], miner: "0x0", gasUsed: "0x0", gasLimit: "0x1c9c380" };
      default: return "0x";
    }
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    const u = String((url && url.url) || url || "");
    if (u.includes("chain.web6.win")) {
      let body = [];
      try { body = JSON.parse((opts && opts.body) || "[]"); } catch { body = []; }
      const one = (c) => ({ jsonrpc: "2.0", id: c.id, result: handle(c.method) });
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(url, opts);
  };
});

console.log("\n[合約頁吃得到服務端的 ABI]");
await page.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
await page.evaluate(({ api, addr }) => {
  localStorage.setItem("web6.verifyApiUrl", api);
  localStorage.removeItem("web6.contract." + addr);   // 本機不留任何資料：顯示出來就只能是遠端來的
}, { api: API, addr: ADDR });

await page.goto(base + `/address.html#/address/${ADDR}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".c-tab", { timeout: 40000 });
await page.click('.c-tab[data-tab="read"]');
await page.waitForSelector(".fn-read .fn-name", { timeout: 30000 });
const readNames = await page.locator(".fn-read .fn-name").allTextContents();
ok(readNames.some((s) => /n\(\)/.test(s)), "讀取頁列出 n()（本機沒資料 → 來自服務端）→ " + readNames.join(" , "));
await page.click('.c-tab[data-tab="write"]');
await page.waitForSelector(".fn-write .fn-name", { timeout: 30000 });
const writeNames = await page.locator(".fn-write .fn-name").allTextContents();
ok(writeNames.some((s) => /inc\(\)/.test(s)), "寫入頁列出 inc() → " + writeNames.join(" , "));
await page.click('.c-tab[data-tab="code"]');
await page.waitForTimeout(500);
const codeText = await page.locator("#contractContent").innerText();
ok(/contract Counter/.test(codeText), "程式碼頁顯示服務端的原始碼");

console.log("\n[服務端連不上時靜默降級]");
await page.evaluate(() => localStorage.setItem("web6.verifyApiUrl", "http://127.0.0.1:1"));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".c-tab", { timeout: 40000 });
await page.click('.c-tab[data-tab="read"]');
await page.waitForTimeout(1500);
const fallbackText = await page.locator("#contractContent").innerText();
ok(/尚未上传|上传 ABI|No ABI/i.test(fallbackText), "服務端掛掉 → 退回「上傳 ABI」提示，沒白屏");
const stillOk = await page.locator(".c-tab").count();
ok(stillOk === 9, "九個分頁都還在（沒有整頁被錯誤蓋掉）");

console.log("\n[部署頁發布路徑]");
await page.evaluate((api) => localStorage.setItem("web6.verifyApiUrl", api), API);
await page.goto(base + "/deploy.html", { waitUntil: "domcontentloaded" });
await page.waitForSelector("#publishBtn", { timeout: 20000 });
ok(await page.locator("#apiBase").count() === 1, "有「驗證服務地址」輸入框");
ok(await page.locator("#apiKey").count() === 1, "有「管理員密鑰」輸入框");
ok(await page.inputValue("#apiBase") === API, "服務地址欄自動帶入已存的設定");
await page.click("#publishBtn");
await page.waitForTimeout(300);
const noDeployMsg = await page.locator("#publishState").innerText();
ok(/请先完成一次部署/.test(noDeployMsg), "還沒部署就按發布 → 提示要先部署：" + noDeployMsg.slice(0, 40));

const pub = await page.evaluate(async ({ addr, abi, key }) => {
  const V = await import("/assets/js/verifyapi.js");
  V.setAdminKey("");
  const noKey = await V.publishContract(addr, { name: "X", abi });
  V.setAdminKey(key);
  const good = await V.publishContract(addr, { name: "Counter-E2E", abi, source: "contract Counter {}", verified: true, submitter: "e2e" });
  return { noKey, good };
}, { addr: ADDR, abi: ABI_COUNTER, key: KEY });
ok(pub.noKey.ok === false && pub.noKey.error === "no_key", "沒金鑰 → 客戶端直接擋下（不發請求）");
ok(pub.good.ok === true, "有金鑰 → 發布成功");
const after = await (await fetch(`${API}/api/contracts/${ADDR}`)).json();
ok(after.name === "Counter-E2E", "資料庫裡的名字已更新為 Counter-E2E");

ok(errors.length === 0, "沒有未捕捉的頁面錯誤" + (errors.length ? " → " + errors.join(" | ") : ""));

await browser.close();
server.close();
console.log(`\n${fail === 0 ? "全部通過" : "有失敗"}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

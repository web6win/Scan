// 验证人治理页浏览器端到端冒烟测试（稳健版）
// 用法：node _govpage.mjs
import http from "http";
import fs from "fs";
import path from "path";

const ROOT = "C:/Users/usewe/Documents/web6win/scan/Scan";
const PORT = 8000;
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".map": "application/json", ".wasm": "application/wasm",
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const fp = path.join(ROOT, p);
  fs.readFile(fp, (e, buf) => {
    if (e) { res.statusCode = 404; res.end("nf"); return; }
    res.setHeader("content-type", MIME[path.extname(fp)] || "application/octet-stream");
    res.end(buf);
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const pw = await import("file:///C:/Users/usewe/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js");
const mod = pw.default || pw;
const chromium = mod.chromium || pw.chromium;
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (x ? "  → " + JSON.stringify(x) : "")); } };

// 等待 #view 内含某段文字（避免固定 sleep 的竞态）
async function waitViewText(substr, timeout = 15000) {
  try {
    await page.waitForFunction(
      (s) => { const v = document.getElementById("view"); return v && v.innerText.includes(s); },
      substr, { timeout }
    );
    return true;
  } catch { return false; }
}

console.log("\n== 导航入口 ==");
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('a[data-route="gov"]', { timeout: 10000 }).catch(() => {});
const hasNav = await page.$('a[data-route="gov"]');
ok(!!hasNav, "顶栏「工具」组含验证人治理入口");
const navText = hasNav ? await page.$eval('a[data-route="gov"]', (n) => n.innerText) : "";
ok(navText.includes("验证人治理"), "入口文字为「验证人治理」", navText);

console.log("\n== 治理页（已配置合约地址：渲染治理外壳，不应崩页）==");
await page.goto(`http://127.0.0.1:${PORT}/gov.html`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => { const v = document.getElementById("view"); return v && v.innerText.trim().length > 0; }, { timeout: 20000 }).catch(() => {});
const txt = await page.$eval("#view", (n) => n.innerText).catch(() => "(no #view)");
ok(txt.includes("当前验证人"), "治理外壳渲染（含「当前验证人」面板）", txt.slice(0, 300));
ok(txt.includes("治理提案"), "含「治理提案」面板（新模型）", txt.slice(0, 300));
ok(txt.includes("验证人治理"), "页面标题为「验证人治理」", txt.slice(0, 300));

console.log("\n== 治理页（?addr 覆盖为不可达合约：仍渲染外壳、不崩）==");
await page.goto(`http://127.0.0.1:${PORT}/gov.html?addr=0x0000000000000000000000000000000000000001`, { waitUntil: "domcontentloaded" });
const fOk = await waitViewText("当前验证人");
const txt2 = await page.$eval("#view", (n) => n.innerText).catch(() => "");
ok(fOk && txt2.includes("当前验证人"), "即便合约读不到，治理外壳仍渲染", txt2.slice(0, 300));
ok(txt2.includes("治理提案"), "?addr 覆盖后仍有「治理提案」面板", txt2.slice(0, 300));

console.log("\n== 主控台错误 ==");
// 只把「未捕获的页面异常（pageerror）」视为致命；网络/RPC 取数失败属环境依赖，不计。
const realErrors = errors.filter((e) => e.startsWith("pageerror:"));
ok(realErrors.length === 0, "没有未捕获的页面异常（pageerror）", realErrors.slice(0, 6));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);

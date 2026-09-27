// 端到端冒煙：起一個「模擬 GitHub Pages」的靜態伺服器（找不到檔案就回 404.html + 狀態碼 404），
// 再用真瀏覽器走一遍 /tx/<hash>，確認最後落在 /txs.html#/tx/<hash>。
// 用法：NODE_PATH=C:/Users/usewe/.workbuddy/binaries/node/workspace/node_modules node _404e2e.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// ESM 不吃 NODE_PATH，所以直接指到受管 workspace 裡那份（或自己 resolve 得到就用 reresolve 的）
const PW = process.env.WEB6_PW || "file:///C:/Users/usewe/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js";
const mod = await import(PW);          // playwright-core 是 CJS，named export 不一定拿得到
const chromium = mod.chromium || mod.default.chromium;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const candidates = [join(root, p), join(root, p + ".html")];
  for (const f of candidates) {
    if (!f.startsWith(root)) break;
    try {
      const buf = await readFile(f);
      res.writeHead(200, { "content-type": TYPES[extname(f)] || "application/octet-stream" });
      return res.end(buf);
    } catch { /* 繼續往下一個候選 */ }
  }
  // GitHub Pages 行為：沒命中就吐 404.html，且狀態碼維持 404
  try {
    const buf = await readFile(join(root, "404.html"));
    res.writeHead(404, { "content-type": "text/html" });
    res.end(buf);
  } catch { res.writeHead(500); res.end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗", m); } };

const TX = "0x" + "ab".repeat(32);
const ADDR = "0x" + "cd".repeat(20);
// 用系統現成的 Chromium 核心瀏覽器，不下載 playwright 自帶的那份
const browser = await chromium.launch({ channel: process.env.WEB6_BROWSER || "msedge" });
const page = await browser.newPage();

async function visit(path) {
  await page.goto(base + path, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  return new URL(page.url()).pathname + new URL(page.url()).hash + new URL(page.url()).search;
}

console.log("\n[瀏覽器實測]");
ok((await visit(`/tx/${TX}`)) === `/txs.html#/tx/${TX}`, "/tx/<hash> 落到交易詳情頁");
ok((await visit(`/block/12345`)) === "/blocks.html#/block/12345", "/block/<n> 落到區塊詳情頁");
ok((await visit(`/address/${ADDR}`)) === `/address.html#/address/${ADDR}`, "/address/<addr> 落到帳戶頁");

await page.goto(base + "/tx/not-a-hash", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(400);
ok(page.url().endsWith("/tx/not-a-hash"), "非法雜湊留在原址（沒有亂轉）");
ok(await page.locator("#nf-path").isVisible(), "非法雜湊顯示 404 卡片與請求路徑");
ok((await page.locator("#nf-path").textContent()) === "/tx/not-a-hash", "404 卡片印出請求路徑");
ok((await page.title()).includes("页面不存在"), "未命中時標題改成「页面不存在」");

await page.goto(base + "/totally-unknown", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(400);
ok(await page.locator(".nf-card").isVisible(), "未知路徑顯示 404 卡片");
ok((await page.locator("#nf-jump").getAttribute("href")) !== null, "手動兜底連結的 href 由 data-base-href 補上");

// 交易詳情頁真的有把這筆交易的內容渲染出來（代表 hash 路由被 views 正確吃到）
await page.goto(base + `/tx/${TX}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
const bodyText = await page.locator("body").innerText();
ok(bodyText.length > 0 && !/找不到这个页面/.test(bodyText), "轉址後是交易頁本體，不是 404 卡片");

// ---- 真實節點驗證：拿一筆鏈上真實交易，確認漂亮路徑落地後真的顯示該筆交易 ----
console.log("\n[真實交易]");
let realTx = null;
try {
  const rpc = await fetch("https://chain.web6.win", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }]),
  });
  const n = Number((await rpc.json())[0].result);
  for (let i = 0; i < 40 && !realTx; i++) {
    const r = await fetch("https://chain.web6.win", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x" + (n - i).toString(16), false] }]),
    });
    const blk = (await r.json())[0].result;
    if (blk && blk.transactions && blk.transactions.length) realTx = blk.transactions[0];
  }
} catch (e) { console.log("  ! 取不到節點資料，略過真實交易檢查：", e.message); }

if (realTx) {
  await page.goto(base + `/tx/${realTx}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".page-title h1", { timeout: 15000 }).catch(() => {});
  ok(page.url().endsWith(`#/tx/${realTx}`), "真實交易雜湊也轉址正確");
  const text = await page.locator("body").innerText();
  ok(text.includes(realTx), "頁面渲染出這筆交易的雜湊");
} else {
  console.log("  - 沒有可用的交易，略過");
}

await browser.close();
server.close();
console.log(`\n${fail === 0 ? "全部通過" : "有失敗"}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

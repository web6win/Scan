// 通證列表頁 + 合約詳情頁（ERC-1155）瀏覽器端對端測試
// 用法：node _tokenpage.mjs
// 前提：8000 埠沒被佔（驗證後端 Cors:Origins 只放行 8000 / 8080，換埠會靜默降級）
import http from "http";
import fs from "fs";
import path from "path";

const ROOT = "C:/Users/usewe/Documents/web6win/scan/Scan";
const PORT = 8000;
const TARGET = "0x67ee5d0f271088d2f4e0d4efae66ff2530e77e6c"; // 使用者剛部署的 ERC-1155
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
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

console.log("\n== 通證列表頁（中文）==");
await page.goto(`http://127.0.0.1:${PORT}/tokens.html`, { waitUntil: "load" });
// 列表是「骨架 → 原地更新」，等到真的出現 ERC-1155 那一列（合約檢測 + 標準識別要幾秒）
await page.waitForFunction(
  (addr) => document.body.innerText.includes("ERC-1155") && document.body.innerText.includes("ChainLegend Assets"),
  TARGET, { timeout: 45000 },
).catch(() => {});

const listText = await page.$eval("#view", (n) => n.innerText).catch(() => "");
ok(/ChainLegend Assets/.test(listText), "列表出現 ERC-1155 通證名稱", listText.slice(0, 300));
ok(/ERC-1155/.test(listText), "列表出現 ERC-1155 標準標籤");
ok(listText.includes(TARGET.slice(0, 12)), "列表出現合約地址", listText.slice(0, 300));

// 表頭：標準欄存在
const heads = await page.$$eval(".rtable .rhead .rcell", (ns) => ns.map((n) => n.innerText.trim())).catch(() => []);
ok(heads.length === 5, "表格有 5 欄", heads);
ok(heads.includes("标准"), "含「标准」欄", heads);

// 該列的標準標籤真的套到 .tag-std，且幾何上沒有溢位
const rowInfo = await page.evaluate((addr) => {
  const rows = Array.from(document.querySelectorAll(".rtable .rrow"));
  for (const r of rows) {
    if (r.innerText.toLowerCase().includes(addr.slice(0, 10).toLowerCase())) {
      const tag = r.querySelector(".tag-std");
      const box = tag ? tag.getBoundingClientRect() : null;
      return {
        text: r.innerText.replace(/\n/g, " | "),
        tag: tag ? tag.innerText.trim() : null,
        color: tag ? getComputedStyle(tag).color : null,
        overflow: box ? box.width > r.getBoundingClientRect().width : null,
      };
    }
  }
  return null;
}, TARGET);
ok(!!rowInfo, "找到 ERC-1155 那一列");
ok(rowInfo && rowInfo.tag === "ERC-1155", "該列標準標籤為 ERC-1155", rowInfo);
ok(rowInfo && rowInfo.overflow === false, "標準標籤未溢位", rowInfo);
ok(rowInfo && /—/.test(rowInfo.text), "精度欄顯示為 —（1155 沒有 decimals）", rowInfo && rowInfo.text);

console.log("\n== 合約詳情頁（ERC-1155）==");
await page.goto(`http://127.0.0.1:${PORT}/address.html#/address/${TARGET}`, { waitUntil: "load" });
// 合約頁要等部署資訊回推 / 代理偵測 / 標準識別，先等「載入中…」退場
await page.waitForFunction(
  () => !document.body.innerText.includes("加载中") && document.querySelector("#contractContent .panel"),
  null, { timeout: 60000 },
).catch(() => {});
await page.waitForTimeout(1500);

const detailText = await page.$eval("#view", (n) => n.innerText).catch(() => "");
ok(/代币合约 \(ERC-1155\)/.test(detailText), "概覽顯示「代币合约 (ERC-1155)」", detailText.slice(0, 400));
ok(/ChainLegend Assets/.test(detailText), "代幣名稱顯示");

// 代幣標籤：標題要帶標準名，且不該出現 ERC-20 專屬的精度列
const tokenTab = await page.$('.c-tab[data-tab="token"]');
ok(!!tokenTab && (await tokenTab.isVisible()), "代幣標籤對 1155 顯示");
await tokenTab.click();
await page.waitForFunction(() => document.body.innerText.includes("元数据 URI") || document.body.innerText.includes("Tokens No"), null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1200);
const tokenText = await page.$eval("#contractContent", (n) => n.innerText).catch(() => "");
ok(/代币信息 \(ERC-1155\)/.test(tokenText), "代幣面板標題帶標準名", tokenText.slice(0, 300));
ok(/元数据 URI/.test(tokenText), "顯示 ERC-1155 的元数据 URI", tokenText.slice(0, 400));
ok(!/精度/.test(tokenText), "不出現 ERC-20 專屬的精度列");
ok(/hello0\.json/.test(tokenText), "URI 值正確", tokenText.slice(0, 400));

// 讀取標籤：要能用自動套用的 ERC-1155 ABI
const readTab = await page.$('.c-tab[data-tab="read"]');
await readTab.click();
await page.waitForTimeout(2500);
const readText = await page.$eval("#contractContent", (n) => n.innerText).catch(() => "");
ok(/balanceOf|uri/.test(readText), "讀取標籤列出 ERC-1155 方法", readText.slice(0, 300));
ok(!/decimals|transferFrom\(address,uint256\)/.test(readText), "讀取標籤不列出 ERC-20 專屬方法", readText.slice(0, 300));

console.log("\n== 非代幣合約不該長出代幣標籤 ==");
await page.goto(`http://127.0.0.1:${PORT}/address.html#/address/0x17fd652c60726091d7758bb6581c6977ee87f258`, { waitUntil: "load" });
// ⚠️ 這一頁要特別有耐心：API.getContractCreation 是從鏈頭往回逐批（250 個 full block）
// 找部署交易，這份合約在 8 萬多塊、鏈頭 10 萬多塊，實測要兩三分鐘才走得完。
// 與本次改動無關，但測試必須等它（等不到的話 tab 會停在「加载中」，假失敗）。
await page.waitForFunction(() => !document.body.innerText.includes("加载中") && document.querySelector("#contractContent .panel"), null, { timeout: 300000 }).catch(() => {});
await page.waitForTimeout(2000);
const nonTokenState = await page.evaluate(() => {
  const b = document.querySelector('.c-tab[data-tab="token"]');
  return {
    hidden: !b || b.style.display === "none",
    panel: !!document.querySelector("#contractContent .panel"),
    head: (document.querySelector("#contractContent") || {}).innerText?.slice(0, 200) || null,
    tags: Array.from(document.querySelectorAll(".tag-row .tag")).map((n) => n.innerText.trim()),
  };
});
ok(nonTokenState.panel, "非代幣合約頁正常渲染", nonTokenState);
ok(nonTokenState.hidden, "非代幣合約隱藏代幣標籤", nonTokenState);

console.log("\n== 主控台錯誤 ==");
const real = errors.filter((e) => !/favicon|ERR_INTERNET|net::ERR/i.test(e));
ok(real.length === 0, "沒有未預期的 console / page error", real.slice(0, 5));

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);

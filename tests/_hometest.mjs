import http from "http";
import fs from "fs";
import path from "path";

const ROOT = "C:/Users/usewe/Documents/web6win/scan/Scan";
const PORT = 8000;
const API = "http://127.0.0.1:5099";
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

const out = {};
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); c ? pass++ : fail++; };

await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load" });

// 等待後端資料填入（.stats-source 出現「後端」字樣 = renderBackendStats 成功）
await page.waitForFunction(() => {
  const s = document.querySelector(".stats-source");
  return s && /后[端]端|backend/i.test(s.textContent || "");
}, { timeout: 25000 }).catch(() => {});

// 讀取三張卡片值 + 來源標籤 + 進度文字
const panel = await page.evaluate(() => {
  const vals = [...document.querySelectorAll(".stats-wrap .stat-value")].map((n) => n.textContent.trim());
  const src = document.querySelector(".stats-source");
  const prog = document.querySelector(".stats-progress");
  return { vals, src: src ? src.textContent.trim() : null, prog: prog ? prog.textContent.trim() : null };
});
out.panel = panel;

// 獨立抓後端 /api/stats 對照
const api = await fetch(API + "/api/stats?chainId=2520").then((r) => r.json());

ok(panel.vals.length === 3, `網路統計有 3 張卡片 (got ${panel.vals.length})`);
ok(panel.vals[0] && panel.vals[0] !== "—", `CNT 總量已填值 (${panel.vals[0]})`);
ok(panel.vals[1] && panel.vals[1] !== "—", `銷毀量已填值 (${panel.vals[1]})`);
ok(panel.vals[2] && panel.vals[2] !== "—", `地址數已填值 (${panel.vals[2]})`);
ok(/后端|backend/i.test(panel.src || ""), `資料來源標為後端 (${panel.src})`);

// 數值應與後端一致（總量/銷毀/地址數）
const supplyEth = (BigInt(api.totalSupplyWei) / 10n ** 18n).toString(); // 精度 18（CHAIN.nativeDecimals）
ok(panel.vals[0].replace(/[,\s]/g, "").startsWith(supplyEth.slice(0, Math.min(supplyEth.length, 6))), `總量顯示與後端一致（前端 ${panel.vals[0]} vs 後端 ${supplyEth} CNT）`);
ok(panel.vals[2].replace(/[,\s]/g, "") === String(api.addressCount), `地址數顯示與後端一致 (${panel.vals[2]} vs ${api.addressCount})`);

// 切英文再確認來源標籤
await page.evaluate(() => localStorage.setItem("web6.lang", "en"));
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => {
  const s = document.querySelector(".stats-source");
  return s && /backend/i.test(s.textContent || "");
}, { timeout: 25000 }).catch(() => {});
const srcEn = await page.evaluate(() => { const s = document.querySelector(".stats-source"); return s ? s.textContent.trim() : null; });
ok(/backend/i.test(srcEn || ""), `英文下來源標為 backend (${srcEn})`);

out.errors = errors;
ok(errors.length === 0, `無控制台錯誤 (${errors.length})`);

await page.screenshot({ path: path.join(ROOT, "_home_stats.png"), fullPage: false });
console.log(JSON.stringify(out, null, 2));
console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);

await browser.close();
server.close();
process.exit(fail ? 1 : 0);

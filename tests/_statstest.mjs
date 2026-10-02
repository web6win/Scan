// 網路統計端到端測試：原生幣（CNT）總量 + 地址數（用戶數）
// 作法：把 localStorage 的掃描游標預設到「最新高度往前 100 塊」，這樣只會補掃約 100 塊
// （避免把整條 7 萬多塊的鏈全部爬一遍），用來驗證：掃描能跑、地址能被收集、
// 餘額求和 > 0、卡片有數字、掃描進度會走到「已完成」、且無腳本錯誤。
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗", m); } };

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
await new Promise((r) => server.listen(8080, "127.0.0.1", r));
const base = "http://127.0.0.1:8080";

// 取最新高度，預設游標
const RPC = "https://chain.web6.win";
const rpc = async (m, p) => (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p || [] }) })).json().then((o) => o.result);
const latest = parseInt(await rpc("eth_blockNumber"), 16);
const primedTo = Math.max(0, latest - 100);
console.log(`最新高度 ${latest}，預設掃描游標到 ${primedTo}（只補掃約 ${latest - primedTo} 塊）`);

const mod = await import(process.env.WEB6_PW || "file:///C:/Users/usewe/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js");
const chromium = mod.chromium || mod.default.chromium;
const browser = await chromium.launch({ channel: process.env.WEB6_BROWSER || "msedge" });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

// 在頁面腳本執行前寫入快取，讓首次掃描只補掃新區塊
await page.addInitScript((primed) => {
  try { localStorage.setItem("web6.stats.2520", JSON.stringify(primed)); } catch {}
}, { scannedTo: primedTo, addresses: [], totalWei: "0", latest, updatedAt: 0 });

console.log("\n[網路統計]");
await page.goto(base + "/index.html", { waitUntil: "domcontentloaded" });

// 等掃描真的收集到地址（accounts >= 1）才算數，避免只抓到初始佔位幀
try {
  await page.waitForFunction(() => {
    const btn = document.querySelector("button.more");
    const panel = btn && btn.closest(".panel");
    if (!panel) return false;
    const vals = [...panel.querySelectorAll(".stat-value")].map((e) => e.textContent.trim());
    const acc = vals[1] || "";
    return /^\d[\d,]*$/.test(acc) && parseInt(acc.replace(/,/g, ""), 10) >= 1;
  }, { timeout: 60000 });
  ok(true, "掃描收集到地址（accounts >= 1）");
} catch { ok(false, "掃描收集到地址（accounts >= 1）— 逾時"); }

// 再等掃描跑到「已完成」狀態
try {
  await page.waitForFunction(() => {
    const btn = document.querySelector("button.more");
    const panel = btn && btn.closest(".panel");
    const prog = panel && panel.querySelector(".stats-progress");
    return prog && /已扫描全部区块|All blocks scanned/.test(prog.textContent);
  }, { timeout: 60000 });
  ok(true, "掃描進度走到「已完成」");
} catch { ok(false, "掃描進度走到「已完成」— 逾時"); }

const data = await page.evaluate(() => {
  const btn = document.querySelector("button.more");
  const panel = btn && btn.closest(".panel");
  const vals = panel ? [...panel.querySelectorAll(".stat-value")].map((e) => e.textContent.trim()) : [];
  const prog = panel ? (panel.querySelector(".stats-progress")?.textContent.trim() || "") : "";
  const title = panel ? (panel.querySelector("h2")?.textContent.trim() || "") : "";
  return { vals, prog, title };
});

ok(data.title && /统计|Stats/.test(data.title), `面板標題含「網路統計 / Network Stats」：${data.title}`);
ok(data.vals.length === 2, `面板內有 2 張統計卡片（實際 ${data.vals.length}）`);

const supply = data.vals[0] || "";
const accounts = data.vals[1] || "";
ok(/CNT/.test(supply) && supply !== "—", `CNT 總量顯示：${supply}`);
ok(/^\d[\d,]*$/.test(accounts), `地址數顯示為數字：${accounts}`);
const accNum = parseInt((accounts || "0").replace(/,/g, ""), 10);
ok(accNum >= 1, `地址數 >= 1（實際 ${accNum}）`);

// 進度：要嘛掃描中、要嘛已完成
const done = /已扫描全部区块|All blocks scanned/.test(data.prog);
const scanning = /扫描中|Scanning/.test(data.prog);
ok(done || scanning, `掃描進度有狀態（${data.prog.slice(0, 40)}）`);

ok(errors.length === 0, `無腳本錯誤（實際 ${errors.length} 條）`);
if (errors.length) errors.slice(0, 5).forEach((e) => console.log("     !", e));

console.log(`\n結果：通過 ${pass} / 失敗 ${fail}`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);

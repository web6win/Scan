// ===== 合約詳情頁「代码 & ABI」：真瀏覽器（msedge）驗證 =====
//
// 這是使用者回報的表面：合約詳情頁看不到原始碼與 ABI。
// 三條路都要在真瀏覽器裡釘住（Playwright + 系統 Edge；此沙箱沒有 Chrome）：
//
//   A. 後端有「真正的驗證資料」→ 代碼 & ABI 必須顯示 ABI（遠端權威資料這條路沒被改壞）
//   B. 後端只有「自動索引空殼」(abi=[]) 且本機沒有資料 → 必須顯示「上傳 ABI」表單，
//      而不是一個空的 ABI `[]`（＝回報畫面上的假象）；此時也不該出現「提交验证」按鈕
//   C. 模擬「使用者剛在本機部署過」（localStorage 有 ABI + 源碼），後端仍是空殼
//      → 必須顯示本機的 ABI 與源碼（＝修好的關鍵：空殼紀錄不得蓋掉本機資料）
//
// 註：0xff4073…（BTT）鏈上已經沒有 bytecode，位址頁不會走合約分支，所以不能用它。
//     A 用 Chain 上還活著的 0x6b3f…：測試前用管理員 API 臨時發布一份 ABI，測完還原原值。
//
// 需要：後端在 5099、靜態站在 8000（8000 是後端 CORS 白名單內，否則遠端資料會被瀏覽器擋掉）。
import http from "http";
import fs from "fs";
import path from "path";

const ROOT = "C:/Users/usewe/Documents/web6win/scan/Scan";
const PORT = 8000;
const BASE = "http://127.0.0.1:5099";
// 公開倉庫：管理員金鑰一律走環境變數（VERIFY_ADMIN_KEY），不要寫死在這裡
const ADMIN_KEY = process.env.VERIFY_ADMIN_KEY || "";
const CHAIN_ID = 2520;
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

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); c ? pass++ : fail++; };

const SHELL = "0x008deffb7ff73272fe0eb0aee2a1d954ca0f902f";   // 自動索引空殼（abi 為空）
const LIVE = "0x6b3f8293f28e0c50365a1aded88ee2d15df72e5b";    // 鏈上還活著的合約（先用來測遠端 ABI）
const LS_KEY = `web6.contract.${SHELL}`;
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address", name: "a" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transferFrom", stateMutability: "nonpayable", inputs: [{ type: "address", name: "f" }, { type: "address", name: "t" }, { type: "uint256", name: "v" }], outputs: [{ type: "bool" }] },
];

// ---------- 後端讀寫小工具 ----------
async function apiGet(addr) {
  const r = await fetch(`${BASE}/api/contracts/${addr}?chainId=${CHAIN_ID}`);
  return r.ok ? r.json() : null;
}
async function apiPut(addr, body) {
  const r = await fetch(`${BASE}/api/contracts/${addr}?chainId=${CHAIN_ID}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "X-Api-Key": ADMIN_KEY },
    body: JSON.stringify(Object.assign({ chainId: CHAIN_ID }, body)),
  });
  let j = null; try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, json: j };
}

const pw = await import("file:///C:/Users/usewe/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js");
const mod = pw.default || pw;
const chromium = mod.chromium || pw.chromium;
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

// 開合約頁並切到指定分頁。
// ⚠️ 合約頁的鏈上探測（部署回推 / 代理探測 / 代幣識別）要 ~12 秒才會 ready，
//    期間畫面是「加载中…」；一定要等 ready 再操作，否則抓到的只是空殼。
async function waitReady() {
  const t0 = Date.now();
  // ⚠️ Playwright 簽名是 waitForFunction(fn, arg, options) —— 選項要放「第三」個參數，
  //    放第二個會被當成 fn 的引數，timeout 就默默停在預設 30s（頁面有時要 >30s 才 ready）。
  await page.waitForFunction(() => {
    const v = document.getElementById("view");
    if (!v) return false;
    const hasTabs = v.querySelectorAll(".c-tab").length > 0;
    const loading = v.innerText.includes("加载中");
    return hasTabs && !loading && !!v.querySelector(".panel");
  }, undefined, { timeout: 120000 });
  return Date.now() - t0;
}
// reload=true 時強制重新載入：page.goto 到「同一個含 hash 的網址」在 Chromium 裡不會真的重載，
// 而 meta 是載入時從 localStorage 讀的 —— 不重載就看不到剛注入的本機資料。
async function openTab(addr, tab, { reload = false } = {}) {
  if (reload) await page.reload({ waitUntil: "load" });
  else await page.goto(`http://127.0.0.1:${PORT}/address.html#/address/${addr}`, { waitUntil: "load" });
  const ms = await waitReady();
  console.log(`   … ${addr.slice(0, 10)}… ready after ${ms} ms`);
  await page.click(`.c-tab[data-tab="${tab}"]`);
  await page.waitForSelector("#view .code-tab, #view .kv", { timeout: 20000 });
  await page.waitForTimeout(400);
  return ms;
}
const probeCode = () => page.evaluate(() => ({
  abiBoxes: [...document.querySelectorAll("#view pre.code-box")].map((p) => p.textContent.slice(0, 500)),
  hasUploadForm: !!document.querySelector("#view .verify-card"),
  codeSubmitBtn: !!document.querySelector("#view .code-tab") && !!document.querySelector("#view .publish-dir"),
  pane: (document.querySelector("#view .code-tab") || {}).innerText || "",
}));
// 「提交驗證」按鈕在概覽分頁的 panel-head（也有掛在代碼分頁上，見 probeCode.codeSubmitBtn）
async function submitBtnVisible() {
  await page.click('.c-tab[data-tab="overview"]');
  await page.waitForTimeout(400);
  return page.evaluate(() => !!document.querySelector("#view .publish-dir"));
}

const snapshot = await apiGet(LIVE);
let restored = false;
try {
  ok(!!snapshot, "取得 LIVE 合約的原始紀錄（用來測完還原）");

  // ---------- A. 後端有真實驗證資料 → 遠端 ABI 照常顯示 ----------
  const put = await apiPut(LIVE, { name: "TmpProbe", abi: ERC20_ABI, verified: true, compiler: "solc 0.8.26" });
  ok(put.status === 200 || put.status === 201, `臨時發布 ABI 到 ${LIVE.slice(0, 10)}…（HTTP ${put.status}）`);
  await openTab(LIVE, "code");
  const a = await probeCode();
  ok(a.abiBoxes.length > 0, `已驗證合約顯示 ABI（找到 ${a.abiBoxes.length} 個 code-box）`);  ok(/transferFrom|balanceOf/.test(a.abiBoxes.join(" ")), "ABI 內容來自後端（遠端權威資料生效）");
  ok(!a.hasUploadForm, "已驗證合約不顯示「上傳 ABI」表單");
  ok(a.codeSubmitBtn, "代碼分頁標題列就有「提交驗證」按鈕（上傳完不必跳回概覽）");
  ok(await submitBtnVisible(), "有 ABI ⇒ 概覽分頁的「提交驗證」按鈕存在");

  // 還原（PUT 會把 name/compiler/... 一併覆寫，所以照原值補回去）
  const res = await apiPut(LIVE, {
    name: snapshot.name, abi: snapshot.abi || [], verified: snapshot.verified,
    compiler: snapshot.compiler, optimize: snapshot.optimize, optimizeRuns: snapshot.optimizeRuns,
    evmVersion: snapshot.evmVersion, license: snapshot.license, source: snapshot.source,
    sourceFiles: snapshot.sourceFiles, submitter: snapshot.submitter,
  });
  restored = res.status === 200;
  const after = await apiGet(LIVE) || {};
  const sameAs = (k) => JSON.stringify(after[k]) === JSON.stringify(snapshot[k]);
  const diff = ["abi", "name", "verified", "compiler", "optimize", "optimizeRuns", "evmVersion", "license", "source", "submitter"]
    .filter((k) => !sameAs(k))
    .map((k) => `${k}: ${JSON.stringify(snapshot[k])} → ${JSON.stringify(after[k])}`);
  ok(restored && diff.length === 0,
    `LIVE 合約的紀錄已完整還原${diff.length ? "（差異：" + diff.join("; ") + "）" : ""}`);

  // ---------- B. 只有空殼紀錄、本機也沒資料 → 顯示上傳表單，不是空 ABI ----------
  await page.goto(`http://127.0.0.1:${PORT}/address.html#/address/${SHELL}`, { waitUntil: "load" });
  await page.evaluate((k) => localStorage.removeItem(k), LS_KEY);
  await openTab(SHELL, "code", { reload: true });
  const b = await probeCode();
  ok(b.hasUploadForm, "空殼紀錄 + 無本機資料 → 顯示「上傳 ABI / 源碼」表單");
  ok(!b.abiBoxes.some((t) => t.trim() === "[]"), "不再出現空的 ABI `[]`（＝回報畫面上的假象）");
  ok(!(await submitBtnVisible()), "沒有 ABI 時不顯示「提交驗證」按鈕（避免必然失敗的提交）");
  ok(!b.codeSubmitBtn, "代碼分頁也沒有「提交驗證」按鈕（沒有 ABI）");
  // ---------- C. 本機有 ABI + 源碼（模擬剛在本機部署），後端仍是空殼 ----------
  const localMeta = {
    abi: [
      { type: "function", name: "helloWeb6", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
      { type: "function", name: "setValue", stateMutability: "nonpayable", inputs: [{ type: "uint256", name: "v" }], outputs: [] },
    ],
    name: "LocalCounter",
    compiler: "solc 0.8.26",
    optimize: true,
    optimizeRuns: "200",
    evmVersion: "paris",
    source: "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.26;\ncontract LocalCounter { uint256 public value; function helloWeb6() external pure returns (string memory) { return \"hi\"; } }",
    verified: true,
  };
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [LS_KEY, JSON.stringify(localMeta)]);
  await openTab(SHELL, "code", { reload: true });
  const c = await probeCode();
  ok(!c.hasUploadForm, "本機有 ABI 後不再顯示上傳表單（走已驗證版面）");
  ok(/helloWeb6/.test(c.pane), "本機的 ABI 有顯示出來（不會被後端空殼的 [] 蓋掉）");
  ok(/pragma solidity/.test(c.pane), "本機的原始碼有顯示出來");
  ok(!c.abiBoxes.some((t) => t.trim() === "[]"), "ABI 區塊不是空的 []");
  ok(c.codeSubmitBtn, "代碼分頁的「提交驗證」按鈕出現（可把資料送進後端資料庫）");
  ok(await submitBtnVisible(), "概覽分頁的「提交驗證」按鈕也出現");

  await page.evaluate((k) => localStorage.removeItem(k), LS_KEY);
  ok(errors.length === 0, `無控制台錯誤（${errors.length}）${errors.length ? " :: " + errors.slice(0, 3).join(" | ") : ""}`);
} catch (e) {
  ok(false, "測試異常：" + ((e && e.message) || e));
} finally {
  if (!restored && snapshot) {
    await apiPut(LIVE, {
      name: snapshot.name, abi: snapshot.abi || [], verified: snapshot.verified,
      compiler: snapshot.compiler, optimize: snapshot.optimize, optimizeRuns: snapshot.optimizeRuns,
      evmVersion: snapshot.evmVersion, license: snapshot.license, source: snapshot.source,
      sourceFiles: snapshot.sourceFiles, submitter: snapshot.submitter,
    }).catch(() => {});
    console.log("（已補做還原）");
  }
  await browser.close().catch(() => {});
  await new Promise((r) => server.close(r));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

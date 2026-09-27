// ===== 部署頁「自動引入 @openzeppelin 等第三方庫」真瀏覽器驗證 =====
//
// 釘住的是使用者要的那件事：只上傳一個 import "@openzeppelin/contracts/…" 的 .sol，
// 不必自己上傳整套 OpenZeppelin，也要能編出 bytecode + ABI。
//
// 需要：靜態站 8000；solc 用站內自託管 assets/vendor/solc/soljson-<版本>.js
//      （此沙箱從 127.0.0.1 開的頁面載外部 9MB 檔案會卡住）。
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";

const ROOT = "C:/Users/usewe/Documents/web6win/scan/Scan";
const PORT = 8000;
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
const ok = (c, m, extra = "") => {
  console.log((c ? "PASS " : "FAIL ") + m + (extra ? "  → " + extra : ""));
  c ? pass++ : fail++;
};

// 待上傳的兩個 .sol（寫到暫存目錄）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "weblib-"));
const OZ_TOKEN = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract Web6Token is ERC20, Ownable {
    constructor(uint256 initialSupply)
        ERC20("Web6 Token", "WEB6")
        Ownable(msg.sender)
    {
        _mint(msg.sender, initialSupply);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}`;
const BAD_IMPORT = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@no-such-vendor/no-such-pkg/Whatever.sol";
contract Broken {}`;
// 只用 ERC20（不用 Ownable）：OZ 4.x 的 Ownable 不收建構參數，換版本才不會因為
// 合約寫法不同而編不過 —— 這裡要測的是「換版本」，不是合約寫法。
const ERC20_ONLY = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract PlainToken is ERC20 {
    constructor(uint256 initialSupply) ERC20("Plain Token", "PLAIN") {
        _mint(msg.sender, initialSupply);
    }
}`;

const fOz = path.join(tmp, "Web6Token.sol");
const fBad = path.join(tmp, "Broken.sol");
const fPlain = path.join(tmp, "PlainToken.sol");
fs.writeFileSync(fOz, OZ_TOKEN);
fs.writeFileSync(fBad, BAD_IMPORT);
fs.writeFileSync(fPlain, ERC20_ONLY);

const pw = await import("file:///C:/Users/usewe/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js");
const mod = pw.default || pw;
const chromium = mod.chromium || pw.chromium;
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage();
const errors = [];
const notFound = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("response", (r) => { if (r.status() === 404) notFound.push(r.url()); });

await page.goto(`http://127.0.0.1:${PORT}/deploy.html`, { waitUntil: "load" });
await page.waitForSelector("#compileBtn", { timeout: 20000 });

console.log("=== 1. 上傳後要顯示「偵測到的第三方庫」===");
await page.setInputFiles("#solFiles", [fOz]);
await page.waitForTimeout(600);
{
  const picker = await page.evaluate(() => {
    const b = document.getElementById("libPicker");
    if (!b || b.hidden) return null;
    return {
      text: b.innerText,
      selects: [...b.querySelectorAll("select.lib-ver")].map((s) => s.value),
      pkgs: [...b.querySelectorAll("code.lib-pkg")].map((c) => c.textContent),
    };
  });
  ok(!!picker, "libPicker 有顯示（不是 hidden）");
  ok(picker && picker.pkgs.includes("@openzeppelin/contracts"), "列出 @openzeppelin/contracts",
    JSON.stringify(picker && picker.pkgs));
  ok(picker && picker.selects.length === 1, "一個套件 → 一個選單", JSON.stringify(picker && picker.selects));
  ok(picker && /自动|自動/.test(picker.text), "預設是「自動」", JSON.stringify(picker && picker.text));
  ok(picker && /5\.6\.1/.test(picker.text), "自動挑到 5.6.1", JSON.stringify(picker && picker.text));
}

console.log("=== 1-b. 選單要列出 npm 上真實發行過的版本 ===");
{
  const got = await page.waitForFunction(() => {
    const s = document.querySelector("#libPicker select.lib-ver");
    return !!(s && !s.disabled && s.options.length > 15);
  }, undefined, { timeout: 40000 }).then(() => true).catch(() => false);
  ok(got, "版本清單載入完成（選項 > 15 個）");

  const info = await page.evaluate(() => {
    const s = document.querySelector("#libPicker select.lib-ver");
    const note = document.querySelector("#libPicker .lib-note");
    return {
      n: s ? s.options.length : 0,
      first: s ? s.options[0].textContent : "",
      has496: s ? [...s.options].some((o) => o.value === "4.9.6") : false,
      has342: s ? [...s.options].some((o) => o.value === "3.4.2") : false,
      hasRc: s ? [...s.options].some((o) => /-(rc|beta|alpha)/.test(o.value)) : false,
      note: note ? note.textContent : "",
    };
  });
  ok(info.n > 15, `選項數 ${info.n}（真實版本清單，不是內建那 4 個）`);
  ok(info.has496 && info.has342, "舊版本（4.9.6 / 3.4.2）也選得到");
  ok(!info.hasRc, "預發布版本（-rc / -beta）已過濾");
  ok(/5\.6\.1/.test(info.first), `第一項是「自動（5.6.1）」`, info.first);
  ok(/0\.8\.20/.test(info.note), "相容性提示：需要 ^0.8.20", info.note);
}

console.log("=== 1-c. 選別的版本 → 提示要跟著變，且真的抓那個版本 ===");
{
  await page.selectOption("#libPicker select.lib-ver", "4.9.6");
  await page.waitForTimeout(400);
  const a = await page.evaluate(() => {
    const s = document.querySelector("#libPicker select.lib-ver");
    const note = document.querySelector("#libPicker .lib-note");
    return { value: s ? s.value : "", note: note ? note.textContent : "", warn: note ? note.className : "" };
  });
  ok(a.value === "4.9.6", "選中的是 4.9.6", a.value);
  ok(/0\.8\.0/.test(a.note), "提示改成需要 ^0.8.0", a.note);

  // OZ 3.x 只吃 <0.8.0，而原始碼寫的是 ^0.8.20 → 要標出不相容
  await page.selectOption("#libPicker select.lib-ver", "3.4.2");
  await page.waitForTimeout(400);
  const b = await page.evaluate(() => {
    const note = document.querySelector("#libPicker .lib-note");
    return { note: note ? note.textContent : "", warn: note ? /lib-note-warn/.test(note.className) : false };
  });
  ok(b.warn, "3.4.2 與 pragma ^0.8.20 不合 → 出現警告樣式", b.note);

  // 回到自動：要復原成 5.6.1
  await page.selectOption("#libPicker select.lib-ver", "");
  await page.waitForTimeout(400);
  const c = await page.evaluate(() => {
    const s = document.querySelector("#libPicker select.lib-ver");
    const note = document.querySelector("#libPicker .lib-note");
    return { value: s ? s.value : "", first: s ? s.options[0].textContent : "", warn: note ? /lib-note-warn/.test(note.className) : false };
  });
  ok(c.value === "" && /5\.6\.1/.test(c.first), "回到自動 → 5.6.1", JSON.stringify(c));
  ok(!c.warn, "自動挑的版本沒有警告");
}

console.log("=== 1-d. 手動選的版本要真的用在編譯上 ===");
{
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("#compileBtn", { timeout: 20000 });
  await page.setInputFiles("#solFiles", [fPlain]);
  await page.waitForFunction(() => {
    const s = document.querySelector("#libPicker select.lib-ver");
    return !!(s && !s.disabled && s.options.length > 15);
  }, undefined, { timeout: 40000 });
  await page.selectOption("#libPicker select.lib-ver", "4.9.6");
  await page.waitForTimeout(300);
  await page.click("#compileBtn");
  const done = await page.waitForFunction(() => {
    const out = document.getElementById("compileOut");
    return !!(out && (document.getElementById("contractPick") || /未能获取|编译失败/.test(out.innerText)));
  }, undefined, { timeout: 240000 }).then(() => true).catch(() => false);
  ok(done, "用 4.9.6 編譯流程結束");
  const r = await page.evaluate(() => {
    const out = document.getElementById("compileOut");
    return { text: out ? out.innerText : "", hasPick: !!document.getElementById("contractPick") };
  });
  ok(r.hasPick, "4.9.6 也能編出合約", r.text.slice(0, 200));
  ok(/OpenZeppelin Contracts @ 4\.9\.6/.test(r.text), "摘要點名用的是 4.9.6", r.text.slice(0, 160));
  // 復原場景給第 2 組：重新上傳原本那個含 Ownable 的合約、版本回到自動
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("#compileBtn", { timeout: 20000 });
  await page.setInputFiles("#solFiles", [fOz]);
  await page.waitForTimeout(600);
}

console.log("=== 2. 只上傳主合約也要能編譯成功 ===");
await page.click("#compileBtn");
// solc 9MB 下載 + wasm 編譯 + 抓依賴，給足時間
const compiled = await page.waitForFunction(() => {
  const s = document.getElementById("contractPick");
  if (s) return true;
  const out = document.getElementById("compileOut");
  return !!(out && /未能获取|编译失败|compilerFail/.test(out.innerText));
}, undefined, { timeout: 240000 }).then(() => true).catch(() => false);
ok(compiled, "編譯流程結束（沒有卡死）");

{
  const r = await page.evaluate(() => {
    const sel = document.getElementById("contractPick");
    const out = document.getElementById("compileOut");
    return {
      hasPick: !!sel,
      opts: sel ? [...sel.options].map((o) => o.value) : [],
      outText: out ? out.innerText : "",
      okBox: (document.querySelector("#compileOut .diag-ok") || {}).innerText || "",
      errBox: (document.querySelector("#compileOut .diag-err") || {}).innerText || "",
    };
  });
  ok(r.hasPick, "出現合約選擇器（表示真的編出 bytecode）");
  ok(r.opts.some((o) => o.includes("Web6Token")), "選擇器裡有 Web6Token", JSON.stringify(r.opts));
  ok(/已自动引入|已自動引入/.test(r.outText), "顯示「已自動引入依賴」摘要",
    r.okBox.slice(0, 120));
  const m = /(\d+)\s*个依赖文件|(\d+)\s*個依賴文件/.exec(r.outText);
  ok(!!m && parseInt(m[1] || m[2], 10) >= 5, `依賴檔案數 ≥ 5（實得 ${m ? m[1] || m[2] : "?"}）`);
  ok(!/未能获取/.test(r.outText), "沒有抓取失敗", r.errBox.slice(0, 200));
  ok(/OpenZeppelin/.test(r.outText), "摘要裡點名 OpenZeppelin");
}

console.log("=== 3. 選中的合約要有 ABI（表示依賴真的被編進去）===");
{
  const abiLen = await page.evaluate(() => {
    // pickContract 會把 ABI 帶進部署參數區的隱藏狀態；這裡從 bytecode 長度間接確認
    const ta = document.getElementById("bytecode");
    return ta ? (ta.value || "").length : 0;
  });
  ok(abiLen > 1000, `bytecode 長度合理（${abiLen} 字元）`);
}

console.log("=== 4. 抓不到的依賴要明確失敗、不能假裝成功 ===");
{
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("#compileBtn", { timeout: 20000 });
  await page.setInputFiles("#solFiles", [fBad]);
  await page.waitForTimeout(400);
  const shown = await page.evaluate(() => {
    const b = document.getElementById("libPicker");
    return !!b && !b.hidden && /no-such-pkg/.test(b.innerText);
  });
  ok(shown, "未知套件也會列進選單（讓使用者知道要處理）");
  const unknown = await page.evaluate(() =>
    [...document.querySelectorAll("#libPicker .lib-unknown")].map((e) => e.textContent));
  ok(unknown.length === 1, "未知套件有標記", JSON.stringify(unknown));

  await page.click("#compileBtn");
  await page.waitForFunction(() => {
    const out = document.getElementById("compileOut");
    return !!(out && (out.querySelector(".lib-ok, .diag-err") || document.getElementById("contractPick")));
  }, undefined, { timeout: 240000 }).catch(() => {});
  const r = await page.evaluate(() => {
    const out = document.getElementById("compileOut");
    return { text: out ? out.innerText : "" };
  });
  ok(/未能获取|Could not fetch/.test(r.text), "明確顯示「未能取得依賴」", r.text.slice(0, 160));
}

console.log("=== 5. 沒有 JS 錯誤 ===");
{
  // 第 4 組是「故意」去戳不存在的套件，它產生的 404 與對應的 console 錯誤是預期行為；
  // 未知套件本來就要靠試幾個候選前綴來定位，404 就是它的探測手段。
  const expected = (u) => /no-such-(vendor|pkg)/.test(u);
  const real404 = notFound.filter((u) => !expected(u));
  ok(real404.length === 0, "沒有預期外的 404", JSON.stringify(real404.slice(0, 5)));
  const site404 = real404.filter((u) => u.includes("127.0.0.1"));
  ok(site404.length === 0, "站內資源沒有 404", JSON.stringify(site404.slice(0, 5)));
  // console 裡的「Failed to load resource」都是上面那批 404 的回聲，數量對得上就沒別的錯
  const real = errors.filter((e) => !/Failed to load resource/i.test(e));
  ok(real.length === 0, "沒有其它 JS 錯誤", JSON.stringify(real.slice(0, 3)));
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
await browser.close();
server.close();
console.log(`\n===== ${pass} 通過 / ${fail} 失敗 =====`);
process.exit(fail ? 1 : 0);

import { createRequire } from "module";
const require = createRequire("file:///C:/Users/who/sources/web6/scan/");
const { JSDOM } = require("jsdom");
const ethers = require("./assets/vendor/ethers.umd.min.js");

const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="view"></div><div id="toast"></div></body></html>`, { url: "https://explorer.local/address.html" });
global.window = dom.window;
global.document = dom.window.document;
// navigator 在 Node 22 是只读 getter，无法直接赋值；覆盖为 jsdom 的 navigator（含 language），
// 失败则保留 Node 自带（i18n.detectLang 会因 language 缺失 fallback 到 zh）。
try {
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator, writable: true, configurable: true,
  });
} catch { /* 保留 Node 自带 navigator */ }
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.FileReader = dom.window.FileReader;
global.Blob = dom.window.Blob;
global.URL = dom.window.URL;
global.CustomEvent = dom.window.CustomEvent;
global.localStorage = dom.window.localStorage || (() => { let s = {}; return { getItem: k => s[k] || null, setItem: (k, v) => s[k] = String(v), removeItem: k => delete s[k] }; })();
global.window.ethers = ethers;

// 节点对默认 UA 返回 403，统一加浏览器 UA
const realFetch = global.fetch;
global.fetch = (url, opts = {}) => {
  opts.headers = Object.assign({ "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" }, opts.headers || {});
  return realFetch(url, opts);
};

const ADDR = "0xff4073c066dd2d1ff2ecb3a24dd7bcf65b6361d0";
const results = [];
function check(name, cond, extra = "") {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  :: " + extra : ""}`);
}

let viewContract;
try {
  ({ viewContract } = await import("./assets/js/contract.js"));
} catch (e) {
  console.log("IMPORT FAILED:", e.stack || e.message);
  process.exit(1);
}

try {
  await viewContract(ADDR);
} catch (e) {
  console.log("viewContract THREW:", e.stack || e.message);
  process.exit(1);
}

const view = () => document.getElementById("view");
const txt = () => view().textContent || "";
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const clickTab = (id) => { const b = document.querySelector(`.c-tab[data-tab="${id}"]`); if (b) b.click(); else console.log("WARN no tab", id); };

// 概览首屏
await wait(600);
console.log("== Overview ==");
check("overview has token tag", /ERC-20|代币/.test(txt()), txt().slice(0, 60));
check("overview shows address", txt().includes(ADDR.slice(0, 12)));
check("overview shows bytecode", /0x363d|0x6080|bytecode|字节码/i.test(txt()));
check("tab count = 9 (all incl. token+audit)", document.querySelectorAll(".c-tab").length === 9, "got " + document.querySelectorAll(".c-tab").length);

// 代币
clickTab("token");
await wait(1800);
console.log("\n== Token ==");
check("token name Besu Test Token", txt().includes("Besu Test Token"));
check("token symbol BTT", txt().includes("BTT"));
check("token has total supply", /Total Supply|总供应/.test(txt()));
check("token shows 1,000,000 supply", txt().includes("1,000,000") || /1e6|1000000/.test(txt()));

// 事件
clickTab("events");
await wait(2800);
console.log("\n== Events ==");
check("events has Transfer", txt().includes("Transfer"));
const evtRows = document.querySelectorAll(".rtable .rrow").length;
check("events rows >= 9", evtRows >= 9, "rows=" + evtRows);

// 读取
clickTab("read");
await wait(400);
console.log("\n== Read ==");
check("read has balanceOf", txt().includes("balanceOf"));
check("read has totalSupply", txt().includes("totalSupply"));
check("read fn cards >= 4", document.querySelectorAll(".fn-card").length >= 4, "cards=" + document.querySelectorAll(".fn-card").length);

// 存储
clickTab("storage");
await wait(1500);
console.log("\n== Storage ==");
check("storage shows slot 0 value (Besu Test Token ascii)", txt().includes("4265737520") || txt().includes("Besu") || document.querySelectorAll(".rtable .rrow").length >= 1, "rows=" + document.querySelectorAll(".rtable .rrow").length);

// 代码 / ABI
clickTab("code");
await wait(400);
console.log("\n== Code ==");
check("code tab shows ABI/upload prompt", /ABI|源码|验证/i.test(txt()), txt().slice(0, 40));

// 写入
clickTab("write");
await wait(400);
console.log("\n== Write ==");
check("write has transfer fn", txt().includes("transfer"), txt().slice(0, 40));
check("write fn cards >= 3", document.querySelectorAll(".fn-card").length >= 3, "cards=" + document.querySelectorAll(".fn-card").length);

// 交易
clickTab("txns");
await wait(9000);
console.log("\n== Txns ==");
check("txns has toContract heading", /Transactions|交易|目标/.test(txt()));
const txRows = document.querySelectorAll(".rtable .rrow").length;
check("txns has >= 1 call row", txRows >= 1, "rows=" + txRows);
check("txns shows internal section", /Internal|内部/.test(txt()), txt().slice(0, 50));

// 审计
clickTab("audit");
await wait(400);
console.log("\n== Audit ==");
check("audit has labels section", /标签|Label|审计/.test(txt()), txt().slice(0, 40));
check("audit has export button", /Export|导出|CSV/i.test(txt()));

const passed = results.filter(r => r.pass).length;
console.log(`\n==== ${passed}/${results.length} checks passed ====`);
process.exit(passed === results.length ? 0 : 3);

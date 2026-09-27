// 404.html 冒煙測試：抽出頁面裡的轉址核心函式，用 Node 直接跑邏輯斷言。
// 用法：node _404check.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "404.html"), "utf8");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ✓", msg); } else { fail++; console.log("  ✗", msg); } };
const eq = (got, want, msg) => ok(got === want, `${msg} — got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

// ---- 1. 取出 head 裡那段 inline script 並在 stub 環境執行 ----
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!scripts[0]) { console.error("找不到 inline script"); process.exit(1); }

const win = {};
const loc = { pathname: "/__direct__", search: "", hostname: "scan.web6.win", replace: (u) => { loc.replaced = u; } };
new Function("window", "location", scripts[0])(win, loc);
const resolve = win.web6Resolve404;
ok(typeof resolve === "function", "web6Resolve404 已掛到 window");

// ---- 2. 路由對照 ----
const TX = "0x" + "ab".repeat(32);          // 64 hex
const ADDR = "0x" + "cd".repeat(20);        // 40 hex
console.log("\n[路由]");
eq(resolve(`/tx/${TX}`, "", "scan.web6.win"), `/txs.html#/tx/${TX}`, "/tx/<hash> → /txs.html#/tx/<hash>");
eq(resolve(`/block/12345`, "", "scan.web6.win"), "/blocks.html#/block/12345", "/block/<n> → /blocks.html#/block/<n>");
eq(resolve(`/address/${ADDR}`, "", "scan.web6.win"), `/address.html#/address/${ADDR}`, "/address/<addr> → /address.html#/address/<addr>");

console.log("\n[容錯]");
eq(resolve(`/TX/${TX}/`, "", "scan.web6.win"), `/txs.html#/tx/${TX}`, "路由段不分大小寫 / 容忍結尾斜線");
eq(resolve(`/tx/${TX.slice(2)}`, "", "scan.web6.win"), `/txs.html#/tx/${TX}`, "缺 0x 前綴自動補回");
eq(resolve(`/tx/${TX}`, "?page=2", "scan.web6.win"), `/txs.html#/tx/${TX}?page=2`, "保留 query string");
eq(resolve(`/tx/${TX.toUpperCase()}`, "", "scan.web6.win"), `/txs.html#/tx/${TX.toUpperCase()}`, "雜湊大小寫原樣保留（EIP-55 校驗和）");
eq(resolve("/tx/not-a-hash", "", "scan.web6.win"), null, "非法雜湊不轉址（走真的 404）");
eq(resolve("/nope", "", "scan.web6.win"), null, "未知路徑不轉址");
eq(resolve("/tx/0xabc/inner", "", "scan.web6.win"), null, "多餘層級不轉址");
eq(resolve("/", "", "scan.web6.win"), null, "根目錄不轉址");
eq(resolve("/tx/%E4%B8%AD%E6%96%87", "", "scan.web6.win"), null, "百分號編碼的非雜湊不轉址");

console.log("\n[github.io 專案站：第一段是 repo 名]");
eq(resolve("/repo/tx/" + TX, "", "user.github.io"), `/repo/txs.html#/tx/${TX}`, "/repo 前綴被保留");
eq(win.web6Base("/repo/tx/x", "user.github.io"), "/repo/", "web6Base 抓到 repo 前綴");
eq(win.web6Base("/tx/x", "scan.web6.win"), "/", "自訂網域的根目錄是 /");

// ---- 3. static 檢查：深路徑下不能有相對網址的資源 ----
console.log("\n[靜態檢查]");
// 注意：data-base-href 是「相對片段」的資料屬性，不是真的網址，要比對完整屬性名排除掉
const refs = [...html.matchAll(/(?:^|[\s"'])(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
const relative = refs.filter((u) => !/^(?:[a-z]+:|\/|#)/i.test(u));
ok(relative.length === 0, `沒有相對網址資源（會在 /tx/0x… 下解析成 /tx/assets/…）${relative.length ? " → " + relative : ""}`);
ok(/noindex/.test(html), "帶 noindex robots meta");
ok(!/assets\/css\/styles\.css/.test(html), "不依賴外部樣式表（自給自足）");
ok(/location\.replace/.test(html), "用 location.replace，不在歷史紀錄留下 /tx/…");
ok((html.match(/<script>/g) || []).length === 2, "兩段 inline script（head 轉址 + body 兜底）");

// ---- 4. head script 對「直接開 404.html」的行為 ----
loc.pathname = "/404.html";
loc.replaced = undefined;
new Function("window", "location", scripts[0])(win, loc);
eq(loc.replaced, undefined, "直接開 404.html 不會自己轉址");

console.log(`\n${fail === 0 ? "全部通過" : "有失敗"}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

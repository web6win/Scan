import http from "http";
import fs from "fs";
import path from "path";

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

const pw = await import("file:///C:/Users/usewe/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js");
const mod = pw.default || pw;
const chromium = mod.chromium || pw.chromium;
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

const out = {};

await page.goto(`http://127.0.0.1:${PORT}/contracts.html`, { waitUntil: "load" });
await page.waitForFunction(() => document.body.innerText.includes("Besu Test Token"), { timeout: 20000 });
out.title = await page.title();
const navZh = await page.$('a[data-route="contracts"]');
out.navZh = navZh ? (await navZh.innerText()).trim() : null;
out.hasAddrLink = !!(await page.$('a[href*="address.html#/address/0xff4073c066dd2d1ff2ecb3a24dd7bcf65b6361d0"]'));
out.hasVerified = !!(await page.$(".tag-ok"));
out.rowText = (await page.$eval(".rtable", (n) => n.innerText).catch(() => null)) || null;

// 切英文再確認導航標籤
await page.evaluate(() => localStorage.setItem("web6.lang", "en"));
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => document.body.innerText.includes("Besu Test Token"), { timeout: 20000 });
const navEn = await page.$('a[data-route="contracts"]');
out.navEn = navEn ? (await navEn.innerText()).trim() : null;

out.errors = errors;
console.log(JSON.stringify(out, null, 2));

await browser.close();
server.close();

// ===== 部署交易證明（txHash）驗證：端到端 =====
//
// 為什麼要這條路：合約索引器是「週期掃描」，剛部署完的合約可能還沒進資料庫（404 / 409）。
// 前端因此會帶上部署交易雜湊，後端直接向節點求證「這筆成功的部署交易 from === 簽名者」，
// 就地補上 creator / deployTxHash / deployBlock —— 不必等索引器。
//
// 這是**授權路徑**，必須嚴格測：證明不成立時絕不能放行、也絕不能寫入任何東西。
// 因為要用「假的鏈上資料」測正向案例（真鏈上沒有我們能控私鑰的部署交易），
// 這裡起一個 mock JSON-RPC（只攔我們註冊的兩支方法，其餘轉發真鏈），
// 再起第二個後端實例（5098）指向它，並關掉自動掃描，避免動到正式資料 / 游標。
//
// 需要：dotnet（PATH）、DB 連線字串（ConnectionStrings__Default）、本機 ethers 檔案。
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import http from "node:http";

const PORT = 5098;
const BASE = `http://127.0.0.1:${PORT}`;
const REAL_RPC = "https://chain.web6.win";
const CHAIN_ID = 2520;
// 公開倉庫：管理員金鑰一律走環境變數（VERIFY_ADMIN_KEY），不要寫死在這裡
const ADMIN_KEY = process.env.VERIFY_ADMIN_KEY || "";
const DLL = "C:/Users/usewe/Documents/web6win/scan/VerifyApi/bin/Debug/net10.0/VerifyApi.dll";

const require = createRequire("file:///C:/Users/usewe/.workbuddy/binaries/node/workspace/");
const { Client } = require("pg");

// verifyapi.js（前端模組）需要 localStorage
globalThis.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
const { verifyMessage } = await import("file:///C:/Users/usewe/Documents/web6win/scan/Scan/assets/js/verifyapi.js");

const ethMod = require("C:/Users/usewe/Documents/web6win/scan/Scan/assets/vendor/ethers.umd.min.js");
const ethers = ethMod.ethers || ethMod;

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); c ? pass++ : fail++; };

const randAddr = () => "0x" + [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
const randHash = () => "0x" + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
const lower = (s) => String(s || "").toLowerCase();

async function post(path, body, key) {
  const headers = { "content-type": "application/json" };
  if (key) headers["X-Api-Key"] = key;
  const r = await fetch(BASE + path, { method: "POST", headers, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, json: j };
}
async function get(path) {
  const r = await fetch(BASE + path);
  let j = null; try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, json: j };
}
async function del(addr) {
  return fetch(`${BASE}/api/contracts/${addr}?chainId=${CHAIN_ID}`, {
    method: "DELETE", headers: { "X-Api-Key": ADMIN_KEY },
  });
}

// ---------- 0. 先對「真鏈」驗證我們的欄位假設 ----------
// 部署證明完全建立在節點回傳的欄位形狀上（status / contractAddress / from / blockNumber 都是 hex 字串）。
// 若真實節點不長這樣，功能會靜默失效 —— 所以拿一筆真實的部署交易核對一次。
// 樣本：0x008d…902f 的部署交易（本專案實際用過的合約）。
const REAL_TX = "0xdf71599263b631ccc0e1ae5644cbb32cc3297ac0967b06a77f4431990da6c8ef";
const REAL_ADDR = "0x008deffb7ff73272fe0eb0aee2a1d954ca0f902f";
const REAL_CREATOR = "0xa1e4ed5e98a8e75f327b3fbeb45ffafa4fd39327";

async function realRpc(method, params) {
  const r = await fetch(REAL_RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method, params }]),
  });
  const j = await r.json();
  return (Array.isArray(j) ? j[0] : j).result;
}

{
  const rc = await realRpc("eth_getTransactionReceipt", [REAL_TX]);
  const tx = await realRpc("eth_getTransactionByHash", [REAL_TX]);
  ok(!!rc && rc.status === "0x1", `真鏈收據 status 是 hex 字串 "0x1"（實際 ${rc && JSON.stringify(rc.status)}）`);
  ok(!!rc && lower(rc.contractAddress) === lower(REAL_ADDR),
    `真鏈收據 contractAddress 指向本合約（實際 ${rc && rc.contractAddress}）`);
  ok(!!tx && lower(tx.from) === lower(REAL_CREATOR),
    `真鏈交易的 from 就是索引器記下的 creator（實際 ${tx && tx.from}）`);
  ok(!!rc && typeof rc.blockNumber === "string" && /^0x[0-9a-f]+$/i.test(rc.blockNumber),
    `真鏈收據 blockNumber 是 hex 字串（實際 ${rc && rc.blockNumber}）`);
  ok(!!tx && tx.to === null, "真鏈部署交易的 to 是 null（合約建立）");
}

// ---------- mock JSON-RPC ----------
const receipts = new Map();  // txHash(lower) -> receipt
const txs = new Map();       // txHash(lower) -> tx
let forwarded = 0;

const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let out = [];
    try {
      const parsed = JSON.parse(body);
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      for (const call of calls) {
        const p0 = lower(call.params && call.params[0]);
        if (call.method === "eth_getTransactionReceipt" && receipts.has(p0)) {
          out.push({ jsonrpc: "2.0", id: call.id, result: receipts.get(p0) });
        } else if (call.method === "eth_getTransactionByHash" && txs.has(p0)) {
          out.push({ jsonrpc: "2.0", id: call.id, result: txs.get(p0) });
        } else {
          // 沒註冊的一律轉發真鏈 → 未知雜湊會自然回 null，正是「證明不成立」
          forwarded++;
          const r = await fetch(REAL_RPC, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([call]),
          });
          const j = await r.json();
          out.push(...(Array.isArray(j) ? j : [j]));
        }
      }
    } catch (e) {
      out = [{ jsonrpc: "2.0", id: null, error: { code: -32700, message: String(e && e.message) } }];
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? out : out[0]));
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const mockPort = mock.address().port;
console.log(`mock RPC on 127.0.0.1:${mockPort}`);

// ---------- 起測試後端（5098）----------
const cs = process.env.ConnectionStrings__Default;
if (!cs) { console.error("缺少環境變數 ConnectionStrings__Default"); process.exit(1); }

// ⚠️ 連線字串是 ADO.NET 形式（Host=...;Port=...;），pg 只吃 URL / libpq 空白分隔格式，
//    直接丟給 new Client(字串) 會把整串當成 hostname → getaddrinfo ENOTFOUND。
const csMap = {};
for (const part of String(cs).split(";")) {
  const i = part.indexOf("=");
  if (i > 0) csMap[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
}
const pgCfg = {
  host: csMap.host,
  port: Number(csMap.port || 5432),
  database: csMap.database,
  user: csMap.username,
  password: csMap.password,
};

const child = spawn("dotnet", [DLL, "--urls", `http://127.0.0.1:${PORT}`], {
  env: {
    ...process.env,
    ConnectionStrings__Default: cs,
    Chain__RpcUrl: `http://127.0.0.1:${mockPort}`,
    Chain__Id: String(CHAIN_ID),
    Stats__AutoScan: "false",
    Contracts__AutoIndex: "false",
    Auth__AdminKey: ADMIN_KEY,
    ASPNETCORE_ENVIRONMENT: "Development",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));

async function waitReady(ms = 90000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* 還沒起來 */ }
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

const db = new Client(pgCfg);
const cleanupAddrs = [];
let exitCode = 1;

try {
  const ready = await waitReady();
  if (!ready) {
    console.error("測試後端未起來，log 尾巴：\n" + log.split("\n").slice(-25).join("\n"));
    throw new Error("backend not ready");
  }
  ok(true, "測試後端（5098，RPC 指向 mock）已啟動");
  await db.connect();

  // ---------- 準備測試資料 ----------
  const deployer = ethers.Wallet.createRandom();  // 真正部署的人（有私鑰）
  const attacker = ethers.Wallet.createRandom();  // 想冒充的人

  const A = randAddr();   // 正向案例合約
  const A2 = randAddr();  // payload 不合法時用
  const B = randAddr();   // 各種「證明不成立」的目標地址
  const D = randAddr();   // 冒充者用
  const C = randAddr();   // 被別的交易部署的合約

  const T = randHash();          // 真的部署了 A 的交易
  const T2 = randHash();         // 部署了 A2 的交易
  const T_wrong = randHash();    // 部署了 C（不是 B）的交易
  const T_failed = randHash();   // 部署失敗（status 0x0）的交易
  const T_attacker = randHash(); // 部署了 D、但 from 是 deployer 的交易
  const T_unknown = randHash();  // 完全沒註冊 → 轉發真鏈 → null

  const mkReceipt = (contractAddress, status = "0x1") => ({
    transactionHash: null, status, contractAddress, blockNumber: "0x1234",
    gasUsed: "0x5208", logs: [],
  });
  receipts.set(T, mkReceipt(A));
  receipts.set(T2, mkReceipt(A2));
  receipts.set(T_wrong, mkReceipt(C));
  receipts.set(T_failed, mkReceipt(B, "0x0"));
  receipts.set(T_attacker, mkReceipt(D));
  txs.set(T, { hash: T, from: deployer.address, to: null });
  txs.set(T2, { hash: T2, from: deployer.address, to: null });
  txs.set(T_wrong, { hash: T_wrong, from: deployer.address, to: null });
  txs.set(T_failed, { hash: T_failed, from: deployer.address, to: null });
  txs.set(T_attacker, { hash: T_attacker, from: deployer.address, to: null });

  const ABI = [
    { type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { type: "function", name: "set", stateMutability: "nonpayable", inputs: [{ type: "uint256", name: "n" }], outputs: [] },
  ];
  const mkPayload = (name) => JSON.stringify({
    name, compiler: "solc 0.8.26", optimize: true, optimizeRuns: 200, evmVersion: "paris",
    abi: ABI, source: `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.26;\ncontract ${name} { uint256 public count; function set(uint256 n) external { count = n; } }`,
    verified: true,
  });
  async function submit(addr, payloadStr, signerKey, txHash) {
    const hash = ethers.keccak256(ethers.toUtf8Bytes(payloadStr));
    const msg = verifyMessage(CHAIN_ID, addr, hash);
    const sig = await signerKey.signMessage(msg);
    const body = { chainId: CHAIN_ID, payload: payloadStr, signature: sig };
    if (txHash !== undefined) body.txHash = txHash;
    return post(`/api/contracts/${addr}/verify`, body);
  }

  // ---------- 1. 正向：部署者簽名 + 部署交易證明 → 直接建立並寫入 ----------
  const p1 = mkPayload("CounterA");
  const r1 = await submit(A, p1, deployer, T);
  cleanupAddrs.push(A);
  ok(r1.status === 200, `部署者 + 正確部署交易 → 200（實際 ${r1.status} ${r1.json && r1.json.error}）`);
  ok(r1.json && lower(r1.json.creator) === lower(deployer.address),
    `證明就地補上 creator = 部署者（實際 ${r1.json && r1.json.creator}）`);
  ok(r1.json && lower(r1.json.deployTxHash) === lower(T),
    `deployTxHash 已寫入（實際 ${r1.json && r1.json.deployTxHash}）`);
  ok(r1.json && r1.json.deployBlock === 0x1234,
    `deployBlock 由收據回填 = ${0x1234}（實際 ${r1.json && r1.json.deployBlock}）`);
  ok(r1.json && r1.json.verified === true, "establish 為已驗證");
  ok(r1.json && Array.isArray(r1.json.abi) && r1.json.abi.length === ABI.length,
    `ABI 已寫入（${ABI.length} 項）—— 這正是「合約詳情頁沒有代碼與 ABI」的修復點`);
  ok(r1.json && typeof r1.json.source === "string" && r1.json.source.includes("pragma solidity"),
    "原始碼已寫入");
  ok(r1.json && lower(r1.json.submitter) === lower(deployer.address), "submitter = 簽名者（建立者）");
  const idA = r1.json && r1.json.id;

  // ---------- 2. 免索引 → 詳情端點讀得到（前端「代碼 & ABI」就是吃這支）----------
  const g2 = await get(`/api/contracts/${A}?chainId=${CHAIN_ID}`);
  ok(g2.status === 200 && g2.json && g2.json.abi && g2.json.abi.length === ABI.length,
    "GET /api/contracts/{addr} 讀得到 ABI（前端詳情頁來源）");
  ok(g2.json && lower(g2.json.creator) === lower(deployer.address), "GET 也帶著 creator");

  // ---------- 3. 冪等：再提交一次不新增、id 不變 ----------
  const r3 = await submit(A, mkPayload("CounterA"), deployer, T);
  ok(r3.status === 200 && r3.json && r3.json.id === idA,
    `重複提交是 upsert（id 不變：${idA} → ${r3.json && r3.json.id}）`);

  // ---------- 4. 反向：冒充者簽名 + 指向「別人部署的交易」→ 證明不成立，不得寫入 ----------
  // 刻意是 404 而不是 403：部署證明的必要條件是 tx.from === 簽名者，冒充者永遠湊不出這組證明。
  // 對外只回「查不到」，不透露「這筆交易存在、但不是你的」。
  const r4 = await submit(D, mkPayload("CounterD"), attacker, T_attacker);
  cleanupAddrs.push(D);
  ok(r4.status === 404 && r4.json && r4.json.error === "not_found",
    `冒充者拿別人部署的交易 → 404（證明要求 tx.from === 簽名者）（實際 ${r4.status} ${r4.json && r4.json.error}）`);
  const g4 = await get(`/api/contracts/${D}?chainId=${CHAIN_ID}`);
  ok(g4.status === 404, `被拒的請求不留任何紀錄（實際 ${g4.status}）`);

  // ---------- 4b. 反向：合約已索引（creator 已知），冒充者再來 → 403 not_creator ----------
  const r4b = await submit(A, mkPayload("CounterA"), attacker, T);
  ok(r4b.status === 403 && r4b.json && r4b.json.error === "not_creator",
    `已索引的合約，冒充者提交 → 403 not_creator（實際 ${r4b.status} ${r4b.json && r4b.json.error}）`);
  const g4b = await get(`/api/contracts/${A}?chainId=${CHAIN_ID}`);
  ok(lower(g4b.json && g4b.json.submitter) === lower(deployer.address),
    "被拒之後 submitter 仍是原建立者，未被冒充者改寫");

  // ---------- 5. 反向：交易部署的是「別的合約」→ 證明不成立 → 404 ----------
  const r5 = await submit(B, mkPayload("CounterB"), deployer, T_wrong);
  ok(r5.status === 404 && r5.json && r5.json.error === "not_found",
    `txHash 部署的是別人的地址 → 404 not_found（實際 ${r5.status} ${r5.json && r5.json.error}）`);

  // ---------- 6. 反向：部署交易失敗（status 0x0）→ 證明不成立 → 404 ----------
  const r6 = await submit(B, mkPayload("CounterB"), deployer, T_failed);
  ok(r6.status === 404, `失敗的部署交易不算建立者 → 404（實際 ${r6.status}）`);

  // ---------- 7. 反向：亂給一個沒上鏈的 txHash → 404，且不會偷偷放行 ----------
  const r7 = await submit(B, mkPayload("CounterB"), deployer, T_unknown);
  ok(r7.status === 404, `未知 txHash → 404（實際 ${r7.status}）`);

  // ---------- 8. 反向：txHash 格式非法 → 視同沒帶 → 404 ----------
  const r8 = await submit(B, mkPayload("CounterB"), deployer, "0xdead");
  ok(r8.status === 404, `非法 txHash 格式 → 404（實際 ${r8.status}）`);

  // ---------- 9. 反向：沒帶 txHash（未索引）→ 404（維持原行為）----------
  const r9 = await submit(B, mkPayload("CounterB"), deployer);
  ok(r9.status === 404, `沒帶 txHash 且未索引 → 404（實際 ${r9.status}）`);

  // ---------- 10. 證明成立但 payload 缺 abi → 400，且不得寫入 ----------
  const badPayload = JSON.stringify({ name: "NoAbi", source: "x", verified: true });
  const r10 = await submit(A2, badPayload, deployer, T2);
  cleanupAddrs.push(A2);
  ok(r10.status === 400 && r10.json && r10.json.error === "invalid_payload",
    `證明成立但缺 abi → 400 invalid_payload（實際 ${r10.status} ${r10.json && r10.json.error}）`);
  const g10 = await get(`/api/contracts/${A2}?chainId=${CHAIN_ID}`);
  ok(g10.status === 404, "payload 不合法時也不留紀錄（實際 " + g10.status + "）");

  // ---------- 11. 反向：簽章垃圾 → 400 bad_signature（在任何 DB 動作之前就擋掉）----------
  const r11 = await post(`/api/contracts/${B}/verify`, {
    chainId: CHAIN_ID, payload: mkPayload("CounterB"), signature: "0x" + "ab".repeat(65), txHash: T_wrong,
  });
  ok(r11.status === 400 && r11.json && r11.json.error === "bad_signature",
    `垃圾簽章 → 400 bad_signature（實際 ${r11.status} ${r11.json && r11.json.error}）`);

  // ---------- 12. 正向：payload 被竄改（簽名綁定失效）→ 403，且不得寫入 ----------
  const good = mkPayload("CounterA");
  const sigForGood = await deployer.signMessage(verifyMessage(CHAIN_ID, A, ethers.keccak256(ethers.toUtf8Bytes(good))));
  const r12 = await post(`/api/contracts/${A}/verify`, {
    chainId: CHAIN_ID, payload: good.replace('"CounterA"', '"HACKED"'), signature: sigForGood, txHash: T,
  });
  ok(r12.status === 403 || (r12.status === 400 && r12.json && r12.json.error === "bad_signature"),
    `竄改 payload → 被拒（實際 ${r12.status} ${r12.json && r12.json.error}）`);
  const g12 = await get(`/api/contracts/${A}?chainId=${CHAIN_ID}`);
  ok(g12.json && g12.json.name === "CounterA", "被拒之後原紀錄內容未被改動");

  console.log(`\nmock 轉發真鏈次數：${forwarded}（未知雜湊的查詢走這條，屬預期）`);

  // ---------- 清理（只刪本測試建立的列）----------
  for (const a of cleanupAddrs) await del(a);
  const left = await db.query(
    `select count(*)::int as n from contracts where "ChainId"=$1 and lower("Address") = any($2::text[])`,
    [CHAIN_ID, cleanupAddrs.map(lower)],
  );
  ok(left.rows[0].n === 0, `測試資料已清除，未殘留（剩 ${left.rows[0].n} 列）`);

  console.log(`\n${pass} passed, ${fail} failed`);
  exitCode = fail === 0 ? 0 : 1;
} catch (e) {
  console.error("測試異常：", e && e.stack || e);
  exitCode = 1;
} finally {
  try { await db.end(); } catch { /* 可能沒連上 */ }
  try { child.kill("SIGKILL"); } catch { /* ignore */ }
  try { mock.close(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 400));
  process.exit(exitCode);
}

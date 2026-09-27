// ===== 建立者簽名提交驗證：端到端驗證 =====
//
// 驗證「只有合約建立者能提交驗證」這條授權規則：
//   - 用真實 ethers 錢包對前端 verifyMessage() 產生的訊息簽名（同時也證明前端/後端訊息格式一致）
//   - 打到真實後端 POST /api/contracts/{addr}/verify
//   - 正向：建立者本人 → 200 且寫入；反向：他人 / 竄改 payload / 換地址重用簽章 全部被擋
//
// 為了不污染真實資料，測試會自己 INSERT 一筆臨時合約（Creator = 測試金鑰 A），跑完 DELETE。
// 需要：後端在 5099、DB 連線字串（環境變數 ConnectionStrings__Default）、本機 ethers 檔案。
import { createRequire } from "node:module";

const BASE = "http://127.0.0.1:5099";
const CHAIN_ID = 2520;
const TMP_ID = 987654321;              // 臨時列的主鍵（遠離真實序列）
const require = createRequire("file:///C:/Users/usewe/.workbuddy/binaries/node/workspace/");

// ---- 前端模組需要 localStorage（私密模式 shim），跟 _verifyapi_test.mjs 同套路 ----
globalThis.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
const { verifyMessage } = await import("file:///C:/Users/usewe/Documents/web6win/scan/Scan/assets/js/verifyapi.js");

const ethMod = require("C:/Users/usewe/Documents/web6win/scan/Scan/assets/vendor/ethers.umd.min.js");
const ethers = ethMod.ethers || ethMod;

function parseCs(s) {
  const o = {};
  for (const part of String(s).split(";")) {
    const i = part.indexOf("=");
    if (i > 0) o[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return o;
}
const cs = parseCs(process.env.ConnectionStrings__Default || "");
const { Client } = require("pg");

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); c ? pass++ : fail++; };

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, json: j };
}
const lower = (s) => String(s || "").toLowerCase();

// ---- 準備 ----
const creatorKey = ethers.Wallet.createRandom();   // 扮演合約建立者
const attackerKey = ethers.Wallet.createRandom();  // 扮演想冒充的人
const addr = "0x" + [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
const addr2 = "0x" + [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");

const db = new Client({ host: cs.host, port: +cs.port, database: cs.database, user: cs.username, password: cs.password });
await db.connect();

async function setTmpRow({ creator }) {
  await db.query('delete from contracts where "Id"=$1', [TMP_ID]);
  await db.query(
    `insert into contracts ("Id","ChainId","Address","Name","Optimize","Verified","Creator","CreatedAt","UpdatedAt")
     values ($1,$2,$3,$4,false,false,$5, now(), now())`,
    [TMP_ID, CHAIN_ID, addr, "__creatorverify__", creator],
  );
}

const payloadObj = {
  name: "Creator Verify Test",
  abi: [{ type: "function", name: "ping", inputs: [], outputs: [], stateMutability: "view" }],
  source: "contract T { function ping() external pure returns (uint) { return 1; } }",
  compiler: "v0.8.26",
  optimize: false,
  optimizeRuns: null,
  evmVersion: "",
  verified: true,
};
const payloadStr = JSON.stringify(payloadObj);
const hash = ethers.keccak256(ethers.toUtf8Bytes(payloadStr));
const message = verifyMessage(CHAIN_ID, addr, hash);

let sigA = null;
try {
  // ---- 0. 前提 ----
  const health = await fetch(BASE + "/api/health").then((r) => r.json()).catch(() => null);
  ok(health && health.status === "ok", "後端在 5099 且健康");
  ok(typeof verifyMessage === "function", "前端 verifyMessage() 可載入");
  ok(message.includes(`chainId: ${CHAIN_ID}`) && message.includes(addr.toLowerCase()) && message.includes(hash),
    "verifyMessage() 產生的訊息含 chainId / 合約地址 / payload 雜湊");

  // ---- 1. 建立者本人簽名 → 應該成功 ----
  await setTmpRow({ creator: lower(creatorKey.address) });
  sigA = await creatorKey.signMessage(message);
  const r1 = await post(`/api/contracts/${addr}/verify`, { chainId: CHAIN_ID, payload: payloadStr, signature: sigA });
  ok(r1.status === 200, `建立者本人提交驗證 → 200（實際 ${r1.status} ${r1.json && r1.json.error || ""}）`);
  if (r1.status === 200) {
    const d = r1.json;
    ok(lower(d.creator) === lower(creatorKey.address), "回傳 creator 仍為建立者地址");
    ok(d.verified === true, "紀錄被標記為已驗證 (verified=true)");
    ok(lower(d.submitter) === lower(creatorKey.address), "submitter = 簽名者（建立者）");
    ok(d.name === "Creator Verify Test", "payload 的 name 已寫入");
    ok(Array.isArray(d.abi) && d.abi.length === 1 && d.abi[0].name === "ping", "payload 的 abi 已寫入");

    // 再讀一次，確認真的落庫（不是只有回應好看）
    const reread = await fetch(`${BASE}/api/contracts/${addr}?chainId=${CHAIN_ID}`).then((x) => x.json());
    ok(reread && reread.verified === true && lower(reread.submitter) === lower(creatorKey.address),
      "重新查詢：verified / submitter 已持久化到資料庫");
  }

  // ---- 2. 非建立者簽名 → 403 ----
  const sigB = await attackerKey.signMessage(message);
  const r2 = await post(`/api/contracts/${addr}/verify`, { chainId: CHAIN_ID, payload: payloadStr, signature: sigB });
  ok(r2.status === 403 && r2.json && r2.json.error === "not_creator",
    `非建立者提交 → 403 not_creator（實際 ${r2.status} ${r2.json && r2.json.error}）`);
  ok(r2.json && typeof r2.json.detail === "string" && r2.json.detail.includes(lower(attackerKey.address)),
    "錯誤詳情指出簽名者地址（方便使用者排查）");

  // ---- 3. 建立者簽了 A，卻送出被竄改的 payload → 簽章綁定失效 → 拒絕 ----
  // 註：ecRecover 對任何訊息都會還原出「某個」地址，竄改 payload → 雜湊變 → 訊息變 →
  //     還原出的地址就變成另一個人 → 走的是 403 not_creator（不是 400 bad_signature）。
  //     兩種都是拒絕；這裡同時驗「資料庫內容沒有被改動」才是真正要保證的事。
  const tampered = payloadStr.replace("Creator Verify Test", "HACKED");
  const r3 = await post(`/api/contracts/${addr}/verify`, { chainId: CHAIN_ID, payload: tampered, signature: sigA });
  ok(r3.status === 400 || r3.status === 403,
    `建立者簽章 + 被竄改 payload → 被拒（實際 ${r3.status} ${r3.json && r3.json.error}）`);
  const after3 = await fetch(`${BASE}/api/contracts/${addr}?chainId=${CHAIN_ID}`).then((x) => x.json());
  ok(after3 && after3.name === "Creator Verify Test",
    "竄改的 payload 沒有寫進資料庫（內容仍為原本提交的值）");

  // ---- 4. 拿為「別的合約」簽的訊息來重用 → 訊息含地址，重建後對不上 → 拒絕 ----
  const msgForOther = verifyMessage(CHAIN_ID, addr2, hash);
  const sigOther = await creatorKey.signMessage(msgForOther);
  const r4 = await post(`/api/contracts/${addr}/verify`, { chainId: CHAIN_ID, payload: payloadStr, signature: sigOther });
  ok(r4.status === 400 || r4.status === 403,
    `把為其他合約簽的簽章搬過來（重放）→ 被拒（實際 ${r4.status} ${r4.json && r4.json.error}）`);

  // ---- 5. 缺簽章 / 缺 payload → 400 ----
  const r5 = await post(`/api/contracts/${addr}/verify`, { chainId: CHAIN_ID, payload: payloadStr });
  ok(r5.status === 400 && r5.json && r5.json.error === "invalid_payload", `缺 signature → 400（實際 ${r5.status}）`);
  const r6 = await post(`/api/contracts/${addr}/verify`, { chainId: CHAIN_ID, signature: sigA });
  ok(r6.status === 400 && r6.json && r6.json.error === "invalid_payload", `缺 payload → 400（實際 ${r6.status}）`);

  // ---- 6. 尚未索引到部署者（creator 為空）→ 409 ----
  await setTmpRow({ creator: null });
  const r7 = await post(`/api/contracts/${addr}/verify`, { chainId: CHAIN_ID, payload: payloadStr, signature: sigA });
  ok(r7.status === 409 && r7.json && r7.json.error === "creator_unknown",
    `尚未索引到 creator → 409 creator_unknown（實際 ${r7.status} ${r7.json && r7.json.error}）`);

  // ---- 7. 不存在的合約 → 404 ----
  const r8 = await post(`/api/contracts/${addr2}/verify`, { chainId: CHAIN_ID, payload: payloadStr, signature: sigA });
  ok(r8.status === 404 && r8.json && r8.json.error === "not_found", `未索引的合約 → 404 not_found（實際 ${r8.status}）`);

  // ---- 8. 非法地址 → 400 ----
  const r9 = await post(`/api/contracts/0xdeadbeef/verify`, { chainId: CHAIN_ID, payload: payloadStr, signature: sigA });
  ok(r9.status === 400 && r9.json && r9.json.error === "invalid_address", `非法地址 → 400 invalid_address（實際 ${r9.status}）`);
} finally {
  await db.query('delete from contracts where "Id"=$1', [TMP_ID]);   // 一定要收乾淨
  await db.end();
  console.log("\n（臨時測試資料已刪除）");
}

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);

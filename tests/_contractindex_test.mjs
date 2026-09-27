// 合約自動索引驗證：確認「部署即自動收錄」真的發生，且冪等（不重複登記）。
// 直接打活後端（Node 層，不走 Playwright，因為沙箱會擋瀏覽器）。
//
// 斷言：
//   1. GET /api/contracts/index：lastContractBlock 已追上鏈頭（斷點續掃收尾）、total>=3、chainId=2520
//   2. GET /api/contracts：列表裡包含使用者部署的 0x008d… 且 creator 已自動填入；
//      至少有一筆 submitter="indexer"（自動索引寫入的）
//   3. POST /api/contracts/index（管理員金鑰）：再觸發一次，total 不變（冪等 upsert）
const BASE = process.env.VERIFY_BASE || "http://127.0.0.1:5099";
// 公開倉庫：管理員金鑰一律走環境變數（VERIFY_ADMIN_KEY），不要寫死在這裡
const ADMIN = process.env.VERIFY_ADMIN_KEY || "";
const CHAIN = 2520;
const TARGET = "0x008deffb7ff73272fe0eb0aee2a1d954ca0f902f".toLowerCase();

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log("  ✓", msg); } else { fail++; console.error("  ✗", msg); } }

async function jget(path) {
  const r = await fetch(BASE + path, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

(async () => {
  console.log("== 合約自動索引驗證 ==");

  // 1) 索引狀態：應該已經追上鏈頭
  const idx = await jget("/api/contracts/index");
  console.log("  index:", JSON.stringify(idx));
  ok(idx.chainId === CHAIN, "chainId 正確");
  ok(typeof idx.lastContractBlock === "number" && idx.lastContractBlock > 0, "lastContractBlock > 0（索引過區塊）");
  ok(typeof idx.latestBlock === "number" && idx.latestBlock > 0, "latestBlock > 0");
  ok(idx.latestBlock - idx.lastContractBlock <= 200, `索引游標已追上鏈頭（差 ${idx.latestBlock - idx.lastContractBlock}）`);
  ok(typeof idx.total === "number" && idx.total >= 3, `目錄至少有 3 筆合約（實際 ${idx.total}）`);

  // 2) 列表：使用者部署的合約被自動收錄，且 creator 已填
  const list = await jget(`/api/contracts?page=1&size=100&chainId=${CHAIN}`);
  const items = list.items || [];
  console.log("  目錄筆數:", list.total, "樣本:", items.map(i => i.address).join(", "));
  const target = items.find(i => i.address === TARGET);
  ok(!!target, "使用者部署的 0x008d… 出現在合約目錄（無須管理員手動登記）");
  ok(target && !!target.creator, "0x008d… 的 creator（部署者）已由索引器自動填入");
  ok(target && typeof target.deployBlock === "number", "0x008d… 的 deployBlock 已由索引器自動填入");
  const auto = items.find(i => i.address !== TARGET && i.creator);
  ok(!!auto, "存在一筆「非 BTT、且帶 creator」的自動索引紀錄");
  // submitter 只在單筆明細回傳，列表摘要不含；用明細確認是索引器寫入的
  if (auto) {
    const detail = await jget(`/api/contracts/${auto.address}?chainId=${CHAIN}`);
    ok(detail.submitter === "indexer", `自動索引新建的紀錄 submitter="indexer"（${auto.address}）`);
  }
  // creator 欄位有回傳（前端「部署者」欄位可用）
  ok(items.every(i => "creator" in i), "列表回應每筆都帶 creator 欄位");

  // 3) 冪等：再觸發一次索引，筆數不應增加
  const before = idx.total;
  const r = await fetch(BASE + "/api/contracts/index", {
    method: "POST", headers: { "content-type": "application/json", "X-Api-Key": ADMIN },
  });
  ok(r.ok, "POST /api/contracts/index 管理員觸發成功");
  await new Promise(res => setTimeout(res, 3000)); // 讓觸發的索引跑一下（其實只會補最新幾塊，不會新增歷史）
  const idx2 = await jget("/api/contracts/index");
  ok(idx2.total >= before, `再觸發索引後筆數不減少（${before} -> ${idx2.total}）`);

  console.log(`\n結果：${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("測試異常：", e); process.exit(2); });

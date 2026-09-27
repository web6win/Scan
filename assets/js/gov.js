// ===== 验证人治理合约交互（WEB6 ValidatorGovernance）=====
// 读取走 eth_call（API.callContract），写入走钱包签名（eth_sendTransaction）。
// 合约地址来自 config.js 的 CHAIN.validatorGovernance；未配置时页面提示「尚未部署」。
//
// 治理模型（合约 0x...01000000，创世预部署、无构造函数，初始验证人由 genesis storage 注入）：
//   1. 任意验证人可 proposeAddValidator(v) / proposeRemoveValidator(v)（提议者自动计 1 票）。
//   2. 其它验证人调用 approve(id) 追加赞成票。
//   3. 赞成票 >= ceil(验证人数 × 3/4) 时提案自动执行（新增 / 移除）。
//   4. 验证人集合下限 4、上限 256（合约强制），由 Besu 在下一区块直接采用。
import * as API from "./api.js";
import * as ABI from "./abi.js";
import { CHAIN } from "./config.js";
import { getProvider, requestAccounts, asWalletError } from "./wallet.js";

// 治理合约 ABI（只列出前端用到的成员，与 contracts/ValidatorGovernance.sol 严格对应）。
export const GOV_ABI = [
  "function getValidators() view returns (address[])",
  "function validatorCount() view returns (uint256)",
  "function proposalCount() view returns (uint256)",
  "function requiredApprovals() view returns (uint256)",
  "function getProposal(uint256 id) view returns (address target, bool isAdd, uint256 approvals, bool executed)",
  "function proposeAddValidator(address v)",
  "function proposeRemoveValidator(address v)",
  "function approve(uint256 id)",
  "event ValidatorAdded(address indexed validator)",
  "event ValidatorRemoved(address indexed validator)",
  "event ProposalCreated(uint256 indexed id, address indexed target, bool isAdd)",
  "event ProposalApproved(uint256 indexed id, address indexed validator)",
  "event ProposalExecuted(uint256 indexed id)",
];

let _iface = null;
function iface() {
  if (!_iface) _iface = ABI.makeInterface(GOV_ABI);
  return _iface;
}

export function govAddress() {
  // 由 config 注入；也可通过 ?addr=0x... 临时覆盖（便于测试未写死地址的部署）
  try {
    const q = new URLSearchParams(location.search).get("addr");
    if (q) return q;
  } catch { /* ignore */ }
  // CHAIN 是 config.js 的 ESM 导入（不是全局变量）。
  return CHAIN.validatorGovernance || "";
}

export function govConfigured() {
  return /^0x[0-9a-fA-F]{40}$/.test(govAddress());
}

// ---------- 只读 ----------
async function readView(name, args = []) {
  const addr = govAddress();
  const data = iface().encodeFunctionData(name, args);
  const hex = await API.callContract(addr, data);
  return iface().decodeFunctionResult(name, hex);
}

export async function getValidators() {
  const r = await readView("getValidators");
  return Array.from(r[0]).map((a) => String(a).toLowerCase());
}
export async function getValidatorCount() {
  const r = await readView("validatorCount");
  return Number(r[0]);
}
export async function getProposalCount() {
  const r = await readView("proposalCount");
  return Number(r[0]);
}
// 执行某提案所需的赞成票数 = ceil(验证人数 × 3/4)。
export async function getRequiredApprovals() {
  const r = await readView("requiredApprovals");
  return Number(r[0]);
}
// 一次读取某条提案的结构（转为普通对象）
export async function getProposal(id) {
  const r = await readView("getProposal", [id]);
  return {
    id,
    target: String(r.target).toLowerCase(),
    isAdd: !!r.isAdd,
    approvals: Number(r.approvals),
    executed: !!r.executed,
  };
}
// 是否为验证人：合约未暴露 isValidator 读取接口，由 getValidators() 集合推导。
export async function isValidator(addr) {
  if (!addr) return false;
  const vals = await getValidators();
  return vals.includes(String(addr).toLowerCase());
}

// ---------- 写入（钱包签名）----------
async function sendGov(name, args) {
  const p = getProvider();
  if (!p) throw new Error("no-wallet");
  let accounts = [];
  try { accounts = await p.request({ method: "eth_accounts" }); } catch { accounts = []; }
  if (!accounts || !accounts.length) accounts = await requestAccounts(p);
  const from = accounts[0];
  const data = iface().encodeFunctionData(name, args);
  const tx = { from, to: govAddress(), data };
  try {
    const hash = await p.request({ method: "eth_sendTransaction", params: [tx] });
    return hash;
  } catch (e) {
    throw asWalletError(e);
  }
}

export const proposeAddValidator = (v) => sendGov("proposeAddValidator", [v]);
export const proposeRemoveValidator = (v) => sendGov("proposeRemoveValidator", [v]);
export const approve = (id) => sendGov("approve", [id]);

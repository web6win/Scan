// ===== ABI / 编解码助手（基于本地打包的 ethers v6，提供正确的 keccak 与 ABI 编解码）=====
// 为什么用 ethers：函数选择器、事件 topic0、ABI 参数（含动态类型 / 元组 / 数组）的
// 编码与解码极易写错，而事件解码是本浏览器的核心（业务对账 / 审计全靠它），
// 所以直接复用 ethers 的 Interface，不走手写编解码。
// ethers 以经典 <script> 方式在 address.html 提前加载，挂载到 window.ethers。

let _eth = null;
export function getEthers() {
  if (_eth) return _eth;
  if (typeof window !== "undefined" && window.ethers) { _eth = window.ethers; return _eth; }
  return null;
}
export function ethersReady() { return !!getEthers(); }

// 解析 ABI 文本（容错：接受 JSON 数组，或 {"abi":[...]} 包裹，或标准 JSON 输入）
export function parseAbi(text) {
  if (Array.isArray(text)) return text;
  const s = (text || "").trim();
  if (!s) throw new Error("empty");
  let obj = JSON.parse(s);
  if (obj && obj.abi && Array.isArray(obj.abi)) obj = obj.abi;
  if (!Array.isArray(obj)) throw new Error("not an abi array");
  return obj;
}

export function makeInterface(abi) {
  const eth = getEthers();
  if (!eth) throw new Error("ethers-not-loaded");
  return new eth.Interface(abi);
}

// 过滤函数：按 stateMutability 区分 read(view/pure) 与 write
export function functionsOf(iface) {
  return Object.values(iface.fragments)
    .filter((f) => f.type === "function")
    .map((f) => ({
      name: f.name,
      signature: f.format("sighash"), // e.g. transfer(address,uint256)
      stateMutability: f.stateMutability,
      inputs: f.inputs.map((i) => ({ name: i.name || "", type: i.type })),
      outputs: f.outputs.map((o) => ({ name: o.name || "", type: o.type })),
      constant: f.stateMutability === "view" || f.stateMutability === "pure",
      payable: f.stateMutability === "payable",
    }));
}
export function eventsOf(iface) {
  return Object.values(iface.fragments)
    .filter((f) => f.type === "event")
    .map((f) => ({
      name: f.name,
      signature: f.format("sighash"),
      inputs: f.inputs.map((i) => ({ name: i.name || "", type: i.type, indexed: i.indexed })),
    }));
}

export function getFunctionFragment(iface, name) {
  return iface.getFunction(name);
}
export function getEventFragment(iface, name) {
  return iface.getEvent(name);
}

export function encodeFunctionData(iface, name, args) {
  return iface.encodeFunctionData(name, args);
}
export function decodeFunctionResult(iface, name, hex) {
  const res = iface.decodeFunctionResult(name, hex);
  return res; // ethers Result（数组 + 命名）
}
export function eventTopic0(iface, name) {
  return iface.getEvent(name).topicHash;
}

// 解码单条日志：返回 { name, signature, args(Result), fragment }
export function decodeLog(iface, log) {
  const parsed = iface.parseLog({ topics: log.topics, data: log.data });
  return { name: parsed.name, signature: parsed.signature, args: parsed.args, fragment: parsed.fragment };
}

// 把解码后的 ABI 值渲染成可读字符串（递归处理数组 / 元组 / bytes / bigint / address）
export function formatValue(v, type) {
  if (v == null) return "—";
  const eth = getEthers();
  // bigint
  if (typeof v === "bigint") return v.toString();
  // 字节（Uint8Array 或已 hex 字符串）
  if (v instanceof Uint8Array) {
    if (eth) try { return eth.hexlify(v); } catch { /* fallthrough */ }
    return "0x" + Array.from(v).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (type && /^bytes/.test(type) && typeof v === "string") {
    return v.length > 2 ? v : v;
  }
  // 数组 / Result（元组）
  if (Array.isArray(v) || (eth && v instanceof eth.Result)) {
    const arr = Array.from(v);
    if (!arr.length) return "[]";
    return "[" + arr.map((x, i) => formatValue(x, type)).join(", ") + "]";
  }
  // 普通对象（结构体，命名元组）
  if (typeof v === "object") {
    const entries = Object.entries(v).filter(([k]) => !/^\d+$/.test(k));
    if (!entries.length) return String(v);
    return entries.map(([k, val]) => `${k}: ${formatValue(val)}`).join(", ");
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

// 渲染函数返回值（多返回值时分行列出）
export function formatResult(res, outputs) {
  if (!res) return "—";
  const arr = Array.from(res);
  if (arr.length === 1) return formatValue(arr[0], outputs && outputs[0] && outputs[0].type);
  return arr
    .map((val, i) => {
      const name = outputs && outputs[i] && outputs[i].name;
      const type = outputs && outputs[i] && outputs[i].type;
      const label = name ? `${name} (${type})` : (type || `#${i}`);
      return `${label} = ${formatValue(val, type)}`;
    })
    .join("\n");
}

// ===== 代理合约探测 =====
// EIP-1167 最小代理：runtime 以 363d3d373d3d3d363d73 开头，随后 20 字节实现地址，结尾 5af43d82803e903d91602b57fd5bf3
// EIP-1967 标准插槽（keccak256("eip1967.proxy.implementation") - 1 等）
export const SLOT_EIP1967_IMPLEMENTATION =
  "0x360894a13b1a986b4a4c635a02e2f9fb6e9f33e2c1a5c5d8f5b5e5c5d5e5d622";
export const SLOT_EIP1967_BEACON =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59e17fe2b6c3bafd7c5b";
export const SLOT_EIP1967_ADMIN =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

export function detectMinimalProxy(code) {
  if (!code || code === "0x") return null;
  const c = code.toLowerCase();
  if (c.startsWith("0x363d3d373d3d3d363d73") && c.includes("5af43d82803e903d91602b57fd5bf3")) {
    // 提取地址：前缀之后 20 字节（40 hex）在结尾 magic 之前
    const body = c.slice("0x363d3d373d3d3d363d73".length);
    const addr = "0x" + body.slice(0, 40);
    return { isProxy: true, kind: "EIP-1167 Minimal Proxy", implementation: addr };
  }
  return null;
}

// 运行期代理探测：读取 EIP-1967 实现插槽 / Beacon 插槽。返回 { isProxy, kind, implementation }
export async function detectProxyRuntime(getStorage, code, addr) {
  const min = detectMinimalProxy(code);
  if (min) return min;
  try {
    const impl = await getStorage(addr, SLOT_EIP1967_IMPLEMENTATION);
    if (impl && impl !== "0x" && impl !== "0x" + "0".repeat(64)) {
      const a = "0x" + impl.slice(-40);
      // Beacon 模式下，实现插槽实际指向 beacon，再读 beacon 的 implementation
      const beacon = await getStorage(a, SLOT_EIP1967_IMPLEMENTATION);
      if (beacon && beacon !== "0x" && beacon !== "0x" + "0".repeat(64)) {
        return { isProxy: true, kind: "EIP-1967 Beacon Proxy", implementation: "0x" + beacon.slice(-40), beacon: a };
      }
      return { isProxy: true, kind: "EIP-1967 Proxy", implementation: a };
    }
  } catch { /* storage 不可读时不判定 */ }
  return { isProxy: false };
}

// ERC-20 / ERC-165 最小 ABI（用于代币识别与读取 / 写入）
// 含完整标准接口（view + write + 事件），让代币合约的读取 / 写入标签页开箱即用。
export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
];
export const ERC165_ABI = ["function supportsInterface(bytes4) view returns (bool)"];

export const INTERFACE_ERC20 = "0x36372b4e";
export const INTERFACE_ERC721 = "0x80ac58cd";
export const INTERFACE_ERC1155 = "0xd9b67a26";

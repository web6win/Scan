// ===== 合约浏览器（地址页在检测到合约时委托到此）=====
// 覆盖：概览 / 代码&ABI / 读取 / 写入 / 事件 / 交易 / 存储 / 审计 / 代币。
// 纯前端直连 JSON-RPC；解码依赖本地打包的 ethers（abi.js）。
import {
  el, hashLink, mono, codeBlock, copyBtn, toast, fmtWei, fmtTime, fmtDateTime, fmtAge, fmtNum,
  hexToNum, shortHash, isAddress, pagination, errorBox, emptyBox, spinner, setTitle,
} from "./utils.js";
import * as API from "./api.js";
import { t } from "./i18n.js";
import { CHAIN, chainIdNum } from "./config.js";
import * as ABI from "./abi.js";
import { getProvider, hasWallet, onWalletEvent, walletName } from "./wallet.js";

let _timer = null;
function stopTimer() { if (_timer) { clearInterval(_timer); _timer = null; } }

// ---------- 本地元数据（验证信息 / 标签 / 代理版本历史，存本机）----------
const metaKey = (a) => `web6.contract.${a}`;
function loadMeta(a) {
  try { return JSON.parse(localStorage.getItem(metaKey(a))) || {}; } catch { return {}; }
}
function saveMeta(a, patch) {
  const m = Object.assign(loadMeta(a), patch);
  try { localStorage.setItem(metaKey(a), JSON.stringify(m)); } catch { /* ignore */ }
  return m;
}

// ---------- CSV 导出 ----------
function downloadCsv(filename, header, rows) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.map(esc).join(",")];
  for (const r of rows) lines.push(r.map(esc).join(","));
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Solidity 语法高亮（轻量，用户自己的源码）----------
function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function highlightSolidity(src) {
  let s = escapeHtml(src);
  // 注释
  s = s.replace(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, '<span class="tk-comment">$1</span>');
  // 字符串
  s = s.replace(/(&quot;[^&]*?&quot;|'[^']*?')/g, '<span class="tk-str">$1</span>');
  const KW = /\b(pragma|solidity|contract|interface|library|function|modifier|event|struct|enum|mapping|address|uint\d*|int\d*|bool|bytes\d*|string|public|private|internal|external|view|pure|payable|returns|memory|storage|calldata|constant|immutable|constructor|if|else|for|while|require|emit|new|returns|virtual|override|using|import|abstract|is|indexed)\b/g;
  s = s.replace(KW, '<span class="tk-kw">$1</span>');
  s = s.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tk-num">$1</span>');
  return s;
}

// ---------- 参数强制转换（表单字符串 → ABI 类型）----------
function coerceArg(type, str) {
  const v = (str == null ? "" : String(str)).trim();
  if (type === "bool") return v.toLowerCase() === "true" || v === "1";
  if (/^uint/.test(type) || /^int/.test(type)) {
    if (v === "" || v == null) throw new Error("empty number");
    return v.includes(".") ? BigInt(Math.trunc(parseFloat(v))) : BigInt(v);
  }
  if (/^bytes/.test(type)) {
    if (!v.startsWith("0x")) throw new Error("bytes need 0x prefix");
    return v;
  }
  if (type === "address") {
    if (!isAddress(v)) throw new Error("bad address: " + v);
    return v;
  }
  if (type.endsWith("]") || type.startsWith("tuple")) {
    try { return JSON.parse(v || "[]"); } catch { throw new Error("bad array/tuple JSON"); }
  }
  return v;
}

// ---------- 分页查询事件（getLogs 范围过大时分块）----------
async function getLogsPaged(addr, fromBlock, toBlock, topics, chunk = 4000, cap = 20000) {
  const out = [];
  let from = fromBlock;
  while (from <= toBlock && out.length < cap) {
    const to = Math.min(from + chunk, toBlock);
    const filter = { fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), address: addr };
    if (topics) filter.topics = topics;
    try {
      const logs = await API.getLogs(filter);
      if (Array.isArray(logs)) out.push(...logs);
    } catch (e) {
      // 分块仍过大：缩小 chunk 再试一次
      if (chunk > 200) return getLogsPaged(addr, from, toBlock, topics, Math.floor(chunk / 4), cap);
      throw e;
    }
    if (from === to) break;
    from = to + 1;
  }
  return out;
}

// ============================================================
export async function viewContract(addr) {
  stopTimer();
  const view = document.getElementById("view");
  if (!view) return;
  const a = addr.toLowerCase();
  const meta = loadMeta(a);

  // 外壳：标题 + 标签页 + 内容
  const title = el("h1", {}, [t("contract.title")]);
  const tabsDef = [
    { id: "overview", key: "contract.tabOverview" },
    { id: "code", key: "code.tab" },
    { id: "read", key: "read.tab" },
    { id: "write", key: "write.tab" },
    { id: "events", key: "events.tab" },
    { id: "txns", key: "txns.tab" },
    { id: "storage", key: "storage.tab" },
    { id: "audit", key: "audit.tab" },
    { id: "token", key: "token.tab" },
  ];
  const tabbar = el("div", { class: "c-tabs", role: "tablist" },
    tabsDef.map((td) => el("button", {
      class: "c-tab", type: "button", role: "tab", "data-tab": td.id, "aria-selected": "false",
    }, [t(td.key)]))
  );
  const content = el("div", { class: "c-content", id: "contractContent" });
  const node = el("div", { class: "container" }, [el("div", { class: "page-title" }, [title]), tabbar, content]);
  view.replaceChildren(node);
  setTitle(t("contract.titleTag"));

  if (!ABI.ethersReady()) {
    content.replaceChildren(errorBox(t("code.solcFail")));
    return;
  }
  // 先把載入態與 tab 點擊接上：下面四個探測請求要幾秒才回來，期間不該是空白一片、
  // 也不該出現「tab 點了沒反應」。ready 之前 selectTab 只記住目標並顯示 spinner，
  // 探測完成後再一次渲染使用者真正想看的那個 tab。
  content.replaceChildren(spinner());
  let ready = false, pending = "overview";
  tabbar.querySelectorAll(".c-tab").forEach((b) => {
    b.addEventListener("click", () => selectTab(b.getAttribute("data-tab")));
  });

  // 基础资料（概览首屏即需）
  let account = null, creation = null, proxy = null, token = null;
  try {
    account = await API.getAccount(a);
  } catch (e) { content.replaceChildren(errorBox(e.message || String(e))); return; }

  // 代理探测（运行期插槽 + 最小代理字节码）
  proxy = await ABI.detectProxyRuntime((addr2, slot) => API.getStorageAt(addr2, slot), account.code, a).catch(() => ({ isProxy: false }));
  // 代币识别
  if (ABI.ethersReady()) {
    token = await detectToken(a).catch(() => null);
  }
  // 部署信息回推
  creation = await API.getContractCreation(a).catch(() => null);

  // 解码用 ABI：用户已验证的优先；否则若为 ERC-20 代币，自动套用标准 ERC-20 ABI，
  // 让读取 / 写入 / 事件 开箱即用（无需手动上传 ABI）。
  const decodeAbi = safeIface(meta.abi) || (token ? safeIface(ABI.ERC20_ABI) : null);

  function selectTab(id) {
    tabbar.querySelectorAll(".c-tab").forEach((b) => {
      const on = b.getAttribute("data-tab") === id;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    stopTimer();
    if (!ready) { pending = id; content.replaceChildren(spinner()); return; }
    if (id === "overview") return renderOverview();
    if (id === "code") return renderCode();
    if (id === "read") return renderRead();
    if (id === "write") return renderWrite();
    if (id === "events") return renderEvents();
    if (id === "txns") return renderTxns();
    if (id === "storage") return renderStorage();
    if (id === "audit") return renderAudit();
    if (id === "token") return renderToken();
  }

  // 审计标签（标签 / 版本历史 / 导出）对任一合约通用，始终保留。
  // 代币标签仅在确为 ERC-20 时显示。
  function hideTab(id) {
    const b = tabbar.querySelector(`.c-tab[data-tab="${id}"]`);
    if (b) b.style.display = "none";
  }
  if (!token) hideTab("token");

  // 探測完成，開放渲染；若使用者在載入期間已點過某個 tab，直接渲染那一個。
  ready = true;
  selectTab(pending);

  // ============ 概览 ============
  function renderOverview() {
    const rows = [
      [t("contract.address"), mono(a)],
      [t("contract.balance"), el("span", { class: "balance-value num" }, [fmtWei(account.balance)])],
      [t("contract.deployer"), creation ? hashLink(creation.deployer, "address", { head: 10, tail: 8 }) : el("span", { class: "muted" }, ["—"])],
      [t("contract.deployTx"), creation ? hashLink(creation.tx, "tx", { head: 10, tail: 8 }) : el("span", { class: "muted" }, ["—"])],
      [t("contract.deployBlock"), creation ? el("a", { class: "link", href: `blocks.html#/block/${hexToNum(creation.block)}` }, ["#" + fmtNum(hexToNum(creation.block))]) : el("span", { class: "muted" }, ["—"])],
      [t("contract.deployTime"), creation ? fmtTime(creation.time, { relative: true }) : el("span", { class: "muted" }, ["—"])],
    ];
    const tags = el("div", { class: "tag-row" }, [
      meta.verified || meta.abi
        ? el("span", { class: "tag tag-ok" }, [t("contract.verified")])
        : el("span", { class: "tag" }, [t("contract.unverified")]),
      proxy && proxy.isProxy ? el("span", { class: "tag tag-proxy" }, [t("contract.proxy")]) : null,
      token ? el("span", { class: "tag tag-token" }, [t("contract.isToken")]) : null,
    ]);
    const codeLen = account.code && account.code !== "0x" ? (account.code.length - 2) / 2 : 0;
    const codeEl = el("pre", { class: "code-box collapsible" }, [account.code && account.code !== "0x" ? account.code.slice(0, 320) : "0x"]);
    const codeWrap = el("div", { class: "kv-val" }, [
      el("div", { class: "code-meta" }, [`${t("contract.bytecodeLen")}: ${fmtNum(codeLen)} bytes `, copyBtn(account.code || "0x")]),
      codeEl,
      codeLen > 320 ? el("button", { class: "link-btn", type: "button", onclick: (e) => {
        const full = codeEl.textContent.length >= codeLen * 2 + 2;
        codeEl.textContent = full ? account.code.slice(0, 320) : account.code;
        e.target.textContent = full ? t("code.viewSource") : "收起";
      } }, [t("code.viewSource")]) : null,
    ]);
    const kv = el("div", { class: "kv" });
    for (const [k, v] of rows) kv.appendChild(el("div", { class: "kv-row" }, [
      el("div", { class: "kv-key" }, [k]), el("div", { class: "kv-val" }, [v == null ? "—" : v]),
    ]));
    kv.appendChild(el("div", { class: "kv-row" }, [
      el("div", { class: "kv-key" }, [t("contract.bytecode")]), codeWrap,
    ]));
    if (proxy && proxy.isProxy) {
      kv.appendChild(el("div", { class: "kv-row" }, [
        el("div", { class: "kv-key" }, [t("contract.implementation")]),
        el("div", { class: "kv-val" }, [hashLink(proxy.implementation, "address", { head: 10, tail: 8 }), el("span", { class: "muted" }, [" · " + proxy.kind])]),
      ]));
    }
    const sec = el("section", { class: "panel" }, [el("div", { class: "panel-head" }, [el("h2", {}, [t("contract.title")]), tags]), kv]);
    const note = el("div", { class: "note-hint" }, [
      el("span", { class: "note-ico", "aria-hidden": "true" }, ["ℹ"]),
      el("span", {}, [t("contract.creatorNote")]),
    ]);
    content.replaceChildren(sec, note);
  }

  // ============ 代码 & ABI ============
  function renderCode() {
    const wrap = el("section", { class: "panel" }, [el("div", { class: "panel-head" }, [el("h2", {}, [t("code.title")])])]);
    const body = el("div", { class: "panel-body code-tab" });
    wrap.appendChild(body);

    const iface = meta.abi ? safeIface(meta.abi) : null;
    if (iface) {
      // 已验证：展示 ABI / 源码 / 导出
      const abiPre = el("pre", { class: "code-box" }, [JSON.stringify(meta.abi, null, 2)]);
      const srcPre = meta.source
        ? (() => { const p = el("pre", { class: "code-box hl" }); p.innerHTML = highlightSolidity(meta.source); return p; })()
        : el("p", { class: "muted" }, [t("code.noSource")]);
      body.appendChild(el("div", { class: "kv" }, [
        kvRow(t("contract.name"), meta.name ? el("span", {}, [meta.name]) : el("span", { class: "muted" }, ["—"])),
        kvRow(t("code.compiler"), meta.compiler ? el("span", {}, [meta.compiler]) : el("span", { class: "muted" }, ["—"])),
        kvRow(t("code.optimize"), meta.optimize ? el("span", {}, [t("code.optimize") + (meta.optimizeRuns ? " (" + meta.optimizeRuns + ")" : "")]) : el("span", { class: "muted" }, ["—"])),
        kvRow(t("code.evmVersion"), meta.evmVersion ? el("span", {}, [meta.evmVersion]) : el("span", { class: "muted" }, ["—"])),
      ]));
      body.appendChild(codeCard(t("code.abi"), "JSON", abiPre, JSON.stringify(meta.abi, null, 2)));
      body.appendChild(el("button", { class: "btn btn-sm btn-ghost code-export", type: "button", onclick: () => downloadCsv(`${a}-abi.csv`, ["abi"], [[JSON.stringify(meta.abi)]]) }, [t("code.exportAbi")]));
      if (meta.source) {
        body.appendChild(codeCard(t("code.source"), "Solidity", srcPre, meta.source));
      }
      // 重新验证入口
      body.appendChild(reverifyForm(iface));
    } else {
      body.appendChild(el("p", { class: "muted code-intro" }, [t("code.noAbi")]));
      body.appendChild(verifyForm());
    }
    content.replaceChildren(wrap);
  }

  function kvRow(k, v) { return el("div", { class: "kv-row" }, [el("div", { class: "kv-key" }, [k]), el("div", { class: "kv-val" }, [v])]); }

  function verifyForm() {
    const abiTa = el("textarea", { class: "ta", rows: "6", placeholder: "ABI JSON" });
    const srcTa = el("textarea", { class: "ta", rows: "6", placeholder: ".sol source" });
    const compiler = el("input", { class: "fld", type: "text", placeholder: "e.g. v0.8.20+commit.a1b79de6" });
    const optimize = el("input", { class: "chk", type: "checkbox" });
    const runs = el("input", { class: "fld sm", type: "number", value: "200" });
    const evm = el("select", { class: "fld" }, ["default", "homestead", "tangerineWhistle", "spuriousDragon", "byzantium", "constantinople", "petersburg", "istanbul", "berlin", "london", "paris", "shanghai", "cancun"].map((v) => el("option", { value: v }, [v])));
    const fileAbi = el("input", { class: "file", type: "file", accept: ".json,.txt" });
    const fileSrc = el("input", { class: "file", type: "file", accept: ".sol,.json,.txt" });
    fileAbi.addEventListener("change", () => readFile(fileAbi, abiTa));
    fileSrc.addEventListener("change", () => readFile(fileSrc, srcTa));
    const status = el("p", { class: "verify-status" });
    const btn = el("button", { class: "btn btn-primary", type: "button" }, [t("code.verify")]);
    btn.addEventListener("click", async () => {
      let abi;
      try { abi = ABI.parseAbi(abiTa.value); } catch { status.textContent = t("code.invalidAbi"); return; }
      saveMeta(a, { abi, name: meta.name, compiler: compiler.value || meta.compiler, optimize: optimize.checked, optimizeRuns: runs.value, evmVersion: evm.value, source: srcTa.value || meta.source });
      status.textContent = t("code.verifying");
      // 尝试 solc 编译比对（失败则仅保存 ABI）
      if (srcTa.value.trim()) {
        let solc = null;
        status.textContent = t("code.solcLoading");
        try { solc = await loadSolc(); } catch { status.textContent = t("code.solcFail"); renderCode(); return; }
        try {
          const out = solc.compile(JSON.stringify(standardJsonInput(srcTa.value, compiler.value, optimize.checked, runs.value, evm.value)));
          const res = JSON.parse(out);
          // 取第一个合约的 deployedBytecode 比对
          const contracts = res.contracts || {};
          let matched = false;
          for (const f of Object.keys(contracts)) for (const name of Object.keys(contracts[f])) {
            const deployed = contracts[f][name].evm && contracts[f][name].evm.deployedBytecode && contracts[f][name].evm.deployedBytecode.object;
            if (deployed && account.code && ("0x" + deployed).toLowerCase().startsWith(account.code.toLowerCase().slice(0, Math.min(account.code.length, ("0x" + deployed).length)))) {
              matched = true; saveMeta(a, { verified: true, name: meta.name || name });
            }
          }
          status.textContent = matched ? t("code.verifiedOk") : t("code.verifiedAbi");
        } catch (e) { status.textContent = t("code.verifyFailed") + (e.message || e); }
      } else {
        status.textContent = t("code.verifiedAbi");
      }
      renderCode();
    });
    return el("div", { class: "verify-card" }, [
      el("label", { class: "fld-label" }, [t("code.abiUpload")]), abiTa, fileAbi,
      el("label", { class: "fld-label" }, [t("code.sourceUpload")]), srcTa, fileSrc,
      el("div", { class: "form-grid" }, [
        el("label", {}, [t("code.compiler")]), compiler,
        el("label", {}, [t("code.optimize")]), el("label", { class: "chk-label chk-cell" }, [optimize]),
        el("label", {}, [t("code.optimizeRuns")]), runs,
        el("label", {}, [t("code.evmVersion")]), evm,
      ]),
      btn, status,
    ]);
  }

  function reverifyForm(iface) {
    const btn = el("button", { class: "btn btn-sm btn-ghost code-reverify", type: "button" }, [t("code.verify")]);
    btn.addEventListener("click", () => { content.replaceChildren(verifyFormWrapper()); });
    return el("div", {}, [btn]);
  }
  function verifyFormWrapper() { return renderCodeShell(verifyForm()); }
  function renderCodeShell(inner) {
    const w = el("section", { class: "panel" }, [el("div", { class: "panel-head" }, [el("h2", {}, [t("code.title")])]), el("div", { class: "panel-body" }, [inner])]);
    content.replaceChildren(w); return w;
  }

  // ============ 读取 ============
  function renderRead() {
    if (!decodeAbi) { content.replaceChildren(emptyBox(t("code.noAbi") + " — " + t("code.abiUpload"))); return; }
    const iface = decodeAbi;
    const reads = ABI.functionsOf(iface).filter((f) => f.constant);
    const wrap = el("section", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", {}, [t("read.title")])]),
      el("p", { class: "muted tab-desc" }, [t("read.desc")]),
    ]);
    const body = el("div", { class: "fn-grid" });
    if (!reads.length) body.appendChild(emptyBox(t("read.noRead")));
    for (const f of reads) body.appendChild(readCard(iface, f));
    wrap.appendChild(body);
    content.replaceChildren(wrap);
  }

  function readCard(iface, f) {
    const fields = f.inputs.map((inp) => el("div", { class: "fn-field" }, [
      el("label", {}, [(inp.name || "arg") + " : " + inp.type]),
      el("input", { class: "fld", type: "text", placeholder: inp.type, "data-type": inp.type }),
    ]));
    const result = el("div", { class: "fn-result" });
    const btn = el("button", { class: "btn btn-primary btn-sm", type: "button" }, [t("read.call")]);
    btn.addEventListener("click", async () => {
      const inputs = Array.from(btn.parentNode.querySelectorAll(".fld"));
      let args;
      try { args = f.inputs.map((inp, i) => coerceArg(inp.type, inputs[i].value)); }
      catch (e) { result.textContent = t("read.decodeErr") + e.message; return; }
      result.textContent = t("read.calling");
      try {
        const data = ABI.encodeFunctionData(iface, f.name, args);
        const hex = await API.callContract(a, data);
        const dec = ABI.decodeFunctionResult(iface, f.name, hex);
        result.replaceChildren(el("pre", { class: "code-box result-box" }, [ABI.formatResult(dec, f.outputs)]));
      } catch (e) {
        result.textContent = t("read.decodeErr") + (e.shortMessage || e.message || e);
      }
    });
    return el("div", { class: "fn-card fn-read" }, [
      el("div", { class: "fn-head" }, [
        el("span", { class: "fn-glyph", html: ICON_READ, "aria-hidden": "true" }),
        el("span", { class: "fn-name" }, [f.signature]),
        el("span", { class: "fn-kind" }, ["READ"]),
      ]),
      el("div", { class: "fn-body" }, [...fields, btn, result]),
    ]);
  }

  // ============ 写入 ============
  function renderWrite() {
    if (!decodeAbi) { content.replaceChildren(emptyBox(t("code.noAbi") + " — " + t("code.abiUpload"))); return; }
    const iface = decodeAbi;
    const writes = ABI.functionsOf(iface).filter((f) => !f.constant);
    const wrap = el("section", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", {}, [t("write.title")])]),
      el("p", { class: "muted tab-desc" }, [t("write.desc")]),
    ]);
    const body = el("div", { class: "fn-grid" });
    if (!writes.length) body.appendChild(emptyBox(t("write.needWallet")));
    for (const f of writes) body.appendChild(writeCard(iface, f));
    wrap.appendChild(body);
    content.replaceChildren(wrap);
  }

  function writeCard(iface, f) {
    const fields = f.inputs.map((inp) => el("div", { class: "fn-field" }, [
      el("label", {}, [(inp.name || "arg") + " : " + inp.type]),
      el("input", { class: "fld", type: "text", placeholder: inp.type, "data-type": inp.type }),
    ]));
    const gasLimit = el("input", { class: "fld sm", type: "text", placeholder: t("write.gasLimit") });
    const gasPrice = el("input", { class: "fld sm", type: "text", placeholder: t("write.gasPrice") });
    const result = el("div", { class: "fn-result" });
    const btn = el("button", { class: "btn btn-primary btn-sm", type: "button" }, [t("write.submit")]);
    btn.addEventListener("click", async () => {
      const p = getProvider();
      if (!p) { result.textContent = t("write.needWallet"); return; }
      let accounts = [];
      try { accounts = await p.request({ method: "eth_accounts" }); } catch { accounts = []; }
      if (!accounts || !accounts.length) {
        try { accounts = await p.request({ method: "eth_requestAccounts" }); } catch (e) { result.textContent = t("write.needWallet"); return; }
      }
      const from = accounts[0];
      const inputs = Array.from(btn.parentNode.querySelectorAll(".fld[data-type]"));
      let args;
      try { args = f.inputs.map((inp, i) => coerceArg(inp.type, inputs[i].value)); }
      catch (e) { result.textContent = t("write.decodeErr") + e.message; return; }
      let data;
      try { data = ABI.encodeFunctionData(iface, f.name, args); }
      catch (e) { result.textContent = t("write.decodeErr") + (e.shortMessage || e.message); return; }
      const tx = { from, to: a, data };
      if (gasLimit.value) tx.gas = "0x" + BigInt(gasLimit.value).toString(16);
      if (gasPrice.value) tx.gasPrice = "0x" + (BigInt(Math.round(parseFloat(gasPrice.value) * 1e9))).toString(16);
      result.textContent = t("write.submitting");
      try {
        const hash = await p.request({ method: "eth_sendTransaction", params: [tx] });
        result.replaceChildren(el("div", { class: "fn-result-ok" }, [
          t("write.sent") + " ", hashLink(hash, "tx", { head: 10, tail: 8 }),
        ]));
      } catch (e) {
        result.textContent = t("write.writeErr") + (e.shortMessage || e.message || e);
      }
    });
    return el("div", { class: "fn-card fn-write" }, [
      el("div", { class: "fn-head" }, [
        el("span", { class: "fn-glyph", html: ICON_WRITE, "aria-hidden": "true" }),
        el("span", { class: "fn-name" }, [f.signature]),
        el("span", { class: "fn-kind" }, ["WRITE"]),
      ]),
      el("div", { class: "fn-body" }, [
        ...fields,
        el("div", { class: "form-grid sm" }, [
          el("label", {}, [t("write.gasLimit")]), gasLimit,
          el("label", {}, [t("write.gasPrice")]), gasPrice,
        ]),
        btn, result,
      ]),
    ]);
  }

  // ============ 事件 ============
  async function renderEvents() {
    const iface = decodeAbi;
    const events = iface ? ABI.eventsOf(iface) : [];
    const wrap = el("section", { class: "panel" }, [el("div", { class: "panel-head" }, [el("h2", {}, [t("events.title")]), el("span", { class: "live-pill" }, [t("events.live")])])]);
    const body = el("div", { class: "panel-body" });
    wrap.appendChild(body);
    content.replaceChildren(wrap);
    // 过滤栏
    const nameSel = el("select", { class: "fld" }, [el("option", { value: "" }, [t("events.filterName")]), ...events.map((e) => el("option", { value: e.name }, [e.name]))]);
    const fromInp = el("input", { class: "fld", type: "text", placeholder: t("events.filterFrom") });
    const blockInp = el("input", { class: "fld", type: "text", placeholder: t("events.filterBlock") });
    const filterBtn = el("button", { class: "btn btn-sm", type: "button" }, [t("events.filterBtn")]);
    const resetBtn = el("button", { class: "btn btn-sm btn-ghost", type: "button" }, [t("events.reset")]);
    const exportBtn = el("button", { class: "btn btn-sm btn-ghost", type: "button" }, [t("events.exportCsv")]);
    const filterBar = el("div", { class: "filter-bar" }, [nameSel, fromInp, blockInp, filterBtn, resetBtn, exportBtn]);
    body.appendChild(filterBar);

    const tableWrap = el("div", { class: "rtable-wrap" });
    body.appendChild(tableWrap);
    const allRows = []; // 当前已加载日志（用于导出）

    async function load(fromBlock, toBlock, name, from, append) {
      let topics = null;
      if (name && iface) {
        try { topics = [ABI.eventTopic0(iface, name)]; } catch { topics = null; }
      }
      if (from) topics = topics ? [topics[0], null, padTopic(from)] : [null, null, padTopic(from)];
      const logs = await getLogsPaged(a, fromBlock, toBlock, topics);
      return logs;
    }
    function padTopic(addr) { return "0x" + addr.toLowerCase().slice(2).padStart(64, "0"); }

    async function doLoad(append) {
      tableWrap.replaceChildren(spinner());
      try {
        const latest = hexToNum((await API.getChainInfo()).blockNumber);
        const name = nameSel.value, from = fromInp.value.trim(), br = blockInp.value.trim();
        let fromBlock = 0, toBlock = latest;
        if (br) { const parts = br.split("-"); fromBlock = parseBlock(parts[0], latest); toBlock = parts[1] ? parseBlock(parts[1], latest) : latest; }
        const logs = await load(fromBlock, toBlock, name, from, append);
        if (!logs.length) { tableWrap.replaceChildren(emptyBox(t("events.noEvents"))); return; }
        const rows = logs.map((log) => eventRow(log, iface)).reverse(); // 倒序（新→旧）
        allRows.length = 0; allRows.push(...logs);
        tableWrap.replaceChildren(rtable(
          [t("th.block"), t("th.txHash"), t("events.name"), t("events.from"), t("events.params")],
          rows, { cols: "0.8fr 1.6fr 1.2fr 1.4fr 2.4fr" }
        ));
      } catch (e) { tableWrap.replaceChildren(errorBox(e.message || String(e))); }
    }
    function parseBlock(s, latest) { s = s.trim(); if (s === "" || s === "latest") return latest; if (s.startsWith("0x")) return parseInt(s, 16); if (/^\d+$/.test(s)) return parseInt(s, 10); return latest; }

    filterBtn.addEventListener("click", () => doLoad(false));
    resetBtn.addEventListener("click", () => { nameSel.value = ""; fromInp.value = ""; blockInp.value = ""; doLoad(false); });
    exportBtn.addEventListener("click", () => {
      const header = [t("th.block"), t("th.txHash"), t("events.from"), t("events.name"), "decoded", "data"];
      const rows = allRows.map((log) => {
        const d = decodeEvent(log, iface);
        return [hexToNum(log.blockNumber), log.transactionHash, log.address, d.name, d.decoded ? d.decodedStr : "", log.data];
      });
      downloadCsv(`${a}-events.csv`, header, rows);
    });

    // 实时刷新（仅基础刷新，不重翻全部）
    _timer = setInterval(() => { if (!document.hidden) doLoad(false).catch(() => {}); }, 8000);

    doLoad(false);
  }

  function decodeEvent(log, iface) {
    if (iface) {
      try {
        const d = ABI.decodeLog(iface, log);
        const parts = Array.from(d.args).map((v, i) => {
          const inp = d.fragment.inputs[i];
          return `${inp ? (inp.name || "#" + i) : "#" + i}: ${ABI.formatValue(v, inp && inp.type)}`;
        });
        return { name: d.name, decoded: true, decodedStr: parts.join(", ") };
      } catch { /* fallthrough */ }
    }
    return { name: shortHash(log.topics[0], 10, 8), decoded: false, decodedStr: t("events.raw") + ": " + (log.data || "0x") };
  }
  function eventRow(log, iface) {
    const d = decodeEvent(log, iface);
    return [
      el("a", { class: "link", href: `blocks.html#/block/${hexToNum(log.blockNumber)}` }, ["#" + fmtNum(hexToNum(log.blockNumber))]),
      hashLink(log.transactionHash, "tx", { head: 8, tail: 6 }),
      el("span", { class: "evt-name" }, [d.name]),
      hashLink(log.address, "address", { head: 6, tail: 4 }),
      el("span", { class: "evt-params" }, [d.decodedStr]),
    ];
  }

  // ============ 交易 ============
  async function renderTxns() {
    const meta2 = loadMeta(a);
    const iface = meta2.abi ? safeIface(meta2.abi) : (token ? safeIface(ABI.ERC20_ABI) : null);
    const wrap = el("section", { class: "panel" }, [el("div", { class: "panel-head" }, [el("h2", {}, [t("txns.title")]), el("span", { class: "live-pill" }, [t("events.live")])])]);
    const body = el("div", { class: "panel-body" });
    wrap.appendChild(body);
    content.replaceChildren(wrap);
    body.appendChild(el("h3", { class: "sub" }, [t("txns.toContract")]));
    const callsWrap = el("div", { class: "rtable-wrap" });
    body.appendChild(callsWrap);
    body.appendChild(el("h3", { class: "sub" }, [t("txns.internal")]));
    const intWrap = el("div", { class: "rtable-wrap" });
    body.appendChild(intWrap);

    body.replaceChildren(el("div", { class: "scanning" }, [t("txns.scanning")]));
    // 調用該合約的交易（事件反推 + 近期區塊掃描，見 api.getContractTransactions）
    try {
      const txs = await API.getContractTransactions(a, 50);
      const rows = txs.map((tx) => {
        const ok = tx.status;
        const status = ok === null
          ? el("span", { class: "tag" }, ["…"])
          : ok
            ? el("span", { class: "tag tag-ok" }, [t("txns.success")])
            : el("span", { class: "tag tag-fail", title: tx.revertReason || "" }, [t("txns.failed")]);
        const decoded = iface && tx.input && tx.input !== "0x" ? decodeTxInput(tx.input, iface) : null;
        const gas = tx.gasUsed ? fmtNum(hexToNum(tx.gasUsed)) : "—";
        return [
          hashLink(tx.hash, "tx", { head: 8, tail: 6 }),
          el("a", { class: "link", href: `blocks.html#/block/${hexToNum(tx.blockNumber)}` }, ["#" + fmtNum(hexToNum(tx.blockNumber))]),
          el("span", { class: "muted", title: fmtDateTime(tx.blockTimestamp) }, [fmtAge(tx.blockTimestamp)]),
          hashLink(tx.from, "address", { head: 6, tail: 4 }),
          status,
          el("span", { class: "num" }, [gas]),
          decoded ? el("span", { class: "tx-decode" }, [decoded]) : el("span", { class: "muted" }, [t("txns.rawInput")]),
        ];
      });
      const inner = el("div", {}, [
        rows.length
          ? rtable([t("th.txHash"), t("th.block"), t("th.time"), t("th.from"), t("txns.status"), t("txns.gas"), t("txns.input")], rows, { cols: "1.6fr 0.7fr 0.9fr 1.3fr 0.8fr 0.9fr 2fr" })
          : emptyBox(t("txns.noTxns")),
      ]);
      body.replaceChildren(el("h3", { class: "sub" }, [t("txns.toContract")]), inner, el("h3", { class: "sub" }, [t("txns.internal")]), intWrap);
      loadInternal(intWrap, iface);
    } catch (e) { body.replaceChildren(errorBox(e.message || String(e))); }
  }

  async function loadInternal(host, iface) {
    host.replaceChildren(spinner());
    try {
      const latest = hexToNum((await API.getChainInfo()).blockNumber);
      const BATCH = 100;
      const traces = [];
      // 扫描最近 BATCH*4 块，找涉及本合约的内部调用
      for (let s = latest; s > Math.max(0, latest - BATCH * 4); s -= BATCH) {
        const blockTraces = await API.traceBlock(s);
        if (!blockTraces) { host.replaceChildren(emptyBox(t("txns.traceUnavailable"))); return; }
        for (const tr of blockTraces) {
          if (tr.type !== "call") continue;
          const to = (tr.action && tr.action.to || "").toLowerCase();
          const from = (tr.action && tr.action.from || "").toLowerCase();
          if (to === a || from === a) traces.push(tr);
        }
      }
      if (!traces.length) { host.replaceChildren(emptyBox(t("txns.noTxns"))); return; }
      const rows = traces.slice(0, 100).map((tr) => [
        tr.transactionHash ? hashLink(tr.transactionHash, "tx", { head: 8, tail: 6 }) : el("span", { class: "muted" }, ["—"]),
        el("span", {}, [tr.type]),
        hashLink(tr.action.from, "address", { head: 6, tail: 4 }),
        el("span", { class: "muted" }, ["→"]),
        hashLink(tr.action.to, "address", { head: 6, tail: 4 }),
        el("span", { class: "num" }, [fmtWei(tr.action.value || "0x0")]),
        tr.error ? el("span", { class: "tag tag-fail" }, [t("txns.failed")]) : el("span", { class: "tag tag-ok" }, [t("txns.success")]),
      ]);
      host.replaceChildren(rtable([t("th.txHash"), t("txns.internal"), t("th.from"), "", t("th.to"), t("th.value"), t("txns.status")], rows, { cols: "1.6fr 0.8fr 1.4fr 0.3fr 1.4fr 1fr 0.8fr" }));
    } catch (e) { host.replaceChildren(errorBox(e.message || String(e))); }
  }

  function decodeTxInput(input, iface) {
    try {
      const d = iface.parseTransaction({ data: input });
      const parts = Array.from(d.args).map((v, i) => `${d.fragment.inputs[i] ? d.fragment.inputs[i].name : "#" + i}: ${ABI.formatValue(v)}`);
      return `${d.name}(${parts.join(", ")})`;
    } catch { return null; }
  }

  // ============ 存储 ============
  async function renderStorage() {
    const wrap = el("section", { class: "panel" }, [el("div", { class: "panel-head" }, [el("h2", {}, [t("storage.title")])])]);
    const body = el("div", { class: "panel-body" });
    wrap.appendChild(body);
    content.replaceChildren(wrap);
    const fromInp = el("input", { class: "fld sm", type: "number", value: "0", min: "0" });
    const countInp = el("input", { class: "fld sm", type: "number", value: "64", min: "1" });
    const readBtn = el("button", { class: "btn btn-sm btn-primary", type: "button" }, [t("storage.read")]);
    const specInp = el("input", { class: "fld sm", type: "text", placeholder: "0x0" });
    const specBtn = el("button", { class: "btn btn-sm", type: "button" }, [t("storage.specific")]);
    const tableWrap = el("div", { class: "rtable-wrap" });
    body.appendChild(el("div", { class: "filter-bar" }, [
      el("label", {}, [t("storage.from")]), fromInp,
      el("label", {}, [t("storage.count")]), countInp, readBtn,
      el("label", {}, [t("storage.specific")]), specInp, specBtn,
    ]));
    body.appendChild(tableWrap);

    async function readRange(from, count) {
      tableWrap.replaceChildren(spinner());
      try {
        const vals = await API.getStorageRange(a, from, count);
        const rows = [];
        vals.forEach((v, i) => {
          if (!v || v === "0x" || /^0x0+$/.test(v)) return;
          rows.push([el("span", { class: "num" }, ["0x" + (from + i).toString(16)]), mono(v)]);
        });
        tableWrap.replaceChildren(rows.length ? rtable([t("storage.slot"), t("storage.value")], rows, { cols: "1fr 3fr" }) : emptyBox(t("storage.empty")));
      } catch (e) { tableWrap.replaceChildren(errorBox(e.message || String(e))); }
    }
    async function readSpecific(slot) {
      tableWrap.replaceChildren(spinner());
      try {
        const v = await API.getStorageAt(a, slot);
        const rows = [[el("span", { class: "num" }, [slot]), mono(v || "0x")]];
        tableWrap.replaceChildren(rtable([t("storage.slot"), t("storage.value")], rows, { cols: "1fr 3fr" }));
      } catch (e) { tableWrap.replaceChildren(errorBox(e.message || String(e))); }
    }
    readBtn.addEventListener("click", () => readRange(parseInt(fromInp.value || "0", 10), Math.min(parseInt(countInp.value || "64", 10), 256)));
    specBtn.addEventListener("click", () => { const s = specInp.value.trim(); if (s.startsWith("0x") || /^\d+$/.test(s)) readSpecific(s.startsWith("0x") ? s : "0x" + parseInt(s, 10).toString(16)); });
    readRange(0, 64);
  }

  // ============ 审计 ============
  // 版式：面板頭（標題 + 右側「匯出全部」動作）
  //       → 提示條（資料只落本機）→ 雙欄卡片（合約標籤 / 代理版本歷史）。
  // 全部寫入都只進 localStorage，不上鏈。
  function renderAudit() {
    // 「匯出全部」放在面板頭右側：掃描期間禁用，避免連點觸發多次全歷史 logs 掃描。
    // 標籤文字單獨用 span 包住，切換「掃描中」時不會把圖示一起吃掉。
    const expLabel = el("span", {}, [t("audit.exportAll")]);
    const expBtn = el("button", { class: "btn btn-sm btn-ghost", type: "button" },
      [el("span", { class: "ico", "aria-hidden": "true" }, ["⬇"]), expLabel]);
    expBtn.addEventListener("click", async () => {
      expBtn.disabled = true;
      expBtn.classList.add("is-busy");
      expLabel.textContent = t("txns.scanning");
      try {
        const latest = hexToNum((await API.getChainInfo()).blockNumber);
        const logs = await getLogsPaged(a, 0, latest, null);
        const header = [t("th.block"), t("th.txHash"), t("events.from"), t("events.name"), "decoded", "data"];
        const iface = loadMeta(a).abi ? safeIface(loadMeta(a).abi) : null;
        const rows = logs.map((log) => { const d = decodeEvent(log, iface); return [hexToNum(log.blockNumber), log.transactionHash, log.address, d.name, d.decoded ? d.decodedStr : "", log.data]; });
        downloadCsv(`${a}-all.csv`, header, rows);
      } catch (e) { toast(t("search.failed") + e.message); }
      expLabel.textContent = t("audit.exportAll");
      expBtn.classList.remove("is-busy");
      expBtn.disabled = false;
    });

    // audit-head 讓標題與動作文案在窄屏（320px）可換行，不互相擠壓
    const wrap = el("section", { class: "panel" }, [
      el("div", { class: "panel-head audit-head" }, [
        el("h2", {}, [t("audit.title")]),
        el("div", { class: "panel-head-actions" }, [expBtn]),
      ]),
    ]);
    const body = el("div", { class: "panel-body audit-body" });
    wrap.appendChild(body);

    // 提示條：說明這些標注只存在本機瀏覽器
    body.appendChild(el("div", { class: "audit-hint" }, [
      el("span", { class: "audit-hint-ico", "aria-hidden": "true" }, ["💾"]),
      el("span", { class: "audit-hint-text" }, [t("audit.note")]),
    ]));

    const grid = el("div", { class: "audit-grid" });
    body.appendChild(grid);

    // ---- 卡片 1：合约标签 ----
    // 數量徽章用既有 .tag；計數為 0 時以行內 display 收起（.tag 的 display 會蓋掉 [hidden]）
    const labelCount = el("span", { class: "tag audit-count" }, ["0"]);
    const labelsWrap = el("div", { class: "labels-wrap" });
    const labelInp = el("input", { class: "fld", type: "text", autocomplete: "off", maxlength: "40", placeholder: t("audit.labelPlaceholder") });
    const labelBtn = el("button", { class: "btn btn-sm btn-primary", type: "button" }, [t("audit.saveLabel")]);

    function paintLabels() {
      const mm = loadMeta(a);
      const list = mm.labels || [];
      labelCount.textContent = String(list.length);
      labelCount.style.display = list.length ? "" : "none";
      labelsWrap.replaceChildren(...(list.length
        ? list.map((l, i) => el("span", { class: "label-chip" }, [
            el("span", { class: "label-chip-text" }, [l]),
            el("button", {
              class: "x", type: "button", title: l, "aria-label": l,
              onclick: () => { const cur = loadMeta(a); saveMeta(a, { labels: (cur.labels || []).filter((_, j) => j !== i) }); paintLabels(); },
            }, [el("span", { "aria-hidden": "true" }, ["×"])]),
          ]))
        : [el("div", { class: "mini-empty" }, [t("audit.none")])]));
    }
    function syncLabelBtn() { labelBtn.disabled = !labelInp.value.trim(); }
    function commitLabel() {
      const v = labelInp.value.trim();
      if (!v) { labelInp.focus(); return; }
      const cur = loadMeta(a);
      const list = cur.labels || [];
      if (!list.includes(v)) saveMeta(a, { labels: [...list, v] });   // 同名標籤不重複新增
      labelInp.value = "";
      syncLabelBtn();
      paintLabels();
      labelInp.focus();
    }
    labelInp.addEventListener("input", syncLabelBtn);
    labelInp.addEventListener("keydown", (e) => { if (e.key === "Enter") commitLabel(); });
    labelBtn.addEventListener("click", commitLabel);

    grid.appendChild(el("section", { class: "audit-card" }, [
      el("div", { class: "audit-card-head" }, [el("h3", {}, [t("audit.label")]), labelCount]),
      el("div", { class: "audit-card-body" }, [
        el("div", { class: "audit-form" }, [labelInp, labelBtn]),
        labelsWrap,
      ]),
    ]));
    paintLabels();
    syncLabelBtn();

    // ---- 卡片 2：代理版本历史（仅代理合约显示）----
    if (proxy && proxy.isProxy) {
      const implCount = el("span", { class: "tag audit-count" }, ["0"]);
      const implWrap = el("div", { class: "impl-wrap" });
      const implInp = el("input", { class: "fld", type: "text", autocomplete: "off", placeholder: t("audit.implPlaceholder") });
      const implBtn = el("button", { class: "btn btn-sm btn-primary", type: "button" }, [t("audit.addImpl")]);

      function paintImpl() {
        const mm = loadMeta(a);
        const list = mm.implHistory || [];
        implCount.textContent = String(list.length);
        implCount.style.display = list.length ? "" : "none";
        implWrap.replaceChildren(...(list.length
          ? list.map((h) => el("div", { class: "audit-hist-row" }, [
              hashLink(h.address, "address", { head: 10, tail: 8 }),
              el("span", { class: "muted audit-hist-time" }, [h.note ? h.note + " · " : "", fmtDateTime(h.time)]),
            ]))
          : [el("div", { class: "mini-empty" }, [t("audit.none")])]));
      }
      // 地址不合法就直接禁用按鈕（原本點下去只會彈一句沒意義的提示）
      function syncImplBtn() { implBtn.disabled = !isAddress(implInp.value.trim()); }
      function commitImpl() {
        const v = implInp.value.trim();
        if (!isAddress(v)) { implInp.focus(); return; }
        const cur = loadMeta(a);
        saveMeta(a, { implHistory: [...(cur.implHistory || []), { address: v.toLowerCase(), note: "", time: Math.floor(Date.now() / 1000) }] });
        implInp.value = "";
        syncImplBtn();
        paintImpl();
        implInp.focus();
      }
      implInp.addEventListener("input", syncImplBtn);
      implInp.addEventListener("keydown", (e) => { if (e.key === "Enter") commitImpl(); });
      implBtn.addEventListener("click", commitImpl);

      grid.appendChild(el("section", { class: "audit-card" }, [
        el("div", { class: "audit-card-head" }, [el("h3", {}, [t("audit.proxyHistory")]), implCount]),
        el("div", { class: "audit-card-body" }, [
          el("div", { class: "audit-form" }, [implInp, implBtn]),
          implWrap,
        ]),
      ]));
      paintImpl();
      syncImplBtn();
    }

    content.replaceChildren(wrap);
  }

  // ============ 代币 ============
  async function renderToken() {
    if (!token) { content.replaceChildren(emptyBox(t("token.notToken"))); return; }
    const wrap = el("section", { class: "panel" }, [el("div", { class: "panel-head" }, [el("h2", {}, [t("token.title")])])]);
    const body = el("div", { class: "panel-body" });
    wrap.appendChild(body);
    // 先把（帶 spinner 的）骨架掛上去：代幣頁要等全歷史 Transfer logs，
    // 若撐到最後才 replaceChildren，等待期間會停在「上一個 tab」的內容，
    // 且該 Promise 晚到時還會把已經切走的 tab 覆蓋掉。
    content.replaceChildren(wrap);
    const supplyStr = token.totalSupply != null ? formatUnits(token.totalSupply, token.decimals) : "—";
    body.appendChild(el("div", { class: "kv" }, [
      kvRow(t("token.name"), el("span", {}, [token.name || "—"])),
      kvRow(t("token.symbol"), el("span", {}, [token.symbol || "—"])),
      kvRow(t("token.decimals"), el("span", {}, [String(token.decimals)])),
      kvRow(t("token.totalSupply"), el("span", { class: "num" }, [supplyStr])),
    ]));
    // 转账记录 + 持有人（从 Transfer 事件聚合）
    body.appendChild(el("h3", { class: "sub" }, [t("token.transfers")]));
    const trWrap = el("div", { class: "rtable-wrap" });
    body.appendChild(trWrap);
    trWrap.replaceChildren(spinner());
    try {
      const iface = ABI.makeInterface(ABI.ERC20_ABI);
      const latest = hexToNum((await API.getChainInfo()).blockNumber);
      const logs = await getLogsPaged(a, 0, latest, [ABI.eventTopic0(iface, "Transfer")]);
      const balances = new Map();
      const transfers = logs.slice(-100).reverse();
      const rows = transfers.map((log) => {
        const d = ABI.decodeLog(iface, log);
        const from = d.args[0], to = d.args[1], val = d.args[2];
        // 持有人聚合
        if (from !== "0x0000000000000000000000000000000000000000") balances.set(from, (balances.get(from) || 0n) - val);
        if (to !== "0x0000000000000000000000000000000000000000") balances.set(to, (balances.get(to) || 0n) + val);
        return [
          el("a", { class: "link", href: `blocks.html#/block/${hexToNum(log.blockNumber)}` }, ["#" + fmtNum(hexToNum(log.blockNumber))]),
          hashLink(from, "address", { head: 6, tail: 4 }),
          hashLink(to, "address", { head: 6, tail: 4 }),
          el("span", { class: "num" }, [formatUnits(val, token.decimals)]),
        ];
      });
      trWrap.replaceChildren(rows.length ? rtable([t("th.block"), t("token.transferFrom"), t("token.transferTo"), t("token.amount")], rows, { cols: "0.8fr 1.6fr 1.6fr 1.4fr" }) : emptyBox(t("txns.noTxns")));
      // 持有人
      const holders = Array.from(balances.entries()).filter(([, v]) => v > 0n).sort((x, y) => (y[1] > x[1] ? 1 : -1)).slice(0, 50);
      const hWrap = el("div", { class: "rtable-wrap" });
      body.appendChild(el("h3", { class: "sub" }, [t("token.holders")]));
      body.appendChild(hWrap);
      hWrap.replaceChildren(holders.length ? rtable([t("token.holder"), t("token.amount")], holders.map(([h, v]) => [hashLink(h, "address", { head: 10, tail: 8 }), el("span", { class: "num" }, [formatUnits(v, token.decimals)])]), { cols: "2.4fr 1.4fr" }) : emptyBox(t("txns.noTxns")));
    } catch (e) { trWrap.replaceChildren(errorBox(e.message || String(e))); }
  }
}

// ---------- 共享小工具 ----------
function safeIface(abi) {
  try { return ABI.makeInterface(abi); } catch { return null; }
}

// ERC-20 识别：尝试调用标准 name()/symbol()/decimals()/totalSupply()。
// 只要能取到 name 或 symbol，即判定为代币（让读取 / 事件 / 写入开箱即用，无需手动上传 ABI）。
async function detectToken(addr) {
  if (!ABI.ethersReady()) return null;
  const iface = ABI.makeInterface(ABI.ERC20_ABI);
  async function view(name) {
    try {
      const data = ABI.encodeFunctionData(iface, name, []);
      const hex = await API.callContract(addr, data);
      const res = ABI.decodeFunctionResult(iface, name, hex);
      return res[0];
    } catch { return undefined; }
  }
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    view("name"), view("symbol"), view("decimals"), view("totalSupply"),
  ]);
  if ((name != null && name !== "") || (symbol != null && symbol !== "")) {
    return { isToken: true, name, symbol, decimals: Number(decimals) || 18, totalSupply };
  }
  return null;
}

// 响应式表格（与 views.js 同款，CSS 类一致）
function rtable(headers, rows, opts = {}) {
  // 純 fr 欄寬升級為 minmax(0, fr)：長 hex / 無空白字串的 min-content 很大，
  // 會把相鄰欄（如事件名稱）壓到折行；minmax(0, ·) 允許欄位縮到內容以下。
  const cols = (opts.cols && !opts.cols.includes("minmax"))
    ? opts.cols.replace(/(\d*\.?\d+)fr/g, "minmax(0, $1fr)")
    : (opts.cols || `repeat(${headers.length}, minmax(0, 1fr))`);
  const wrap = el("div", { class: "rtable-wrap" });
  const table = el("div", { class: "rtable" });
  table.style.setProperty("--cols", cols);
  const head = el("div", { class: "rhead" }, headers.map((h) => el("div", { class: "rcell" }, [h])));
  table.appendChild(head);
  if (!rows.length) {
    table.appendChild(el("div", { class: "rempty" }, [opts.emptyText || t("common.noData")]));
  }
  for (const r of rows) {
    table.appendChild(el("div", { class: "rrow" },
      r.map((c, i) => el("div", { class: "rcell", "data-label": headers[i] || "" }, [c]))));
  }
  wrap.appendChild(table);
  return wrap;
}

// 方法图标（读 / 写），纯 SVG 字符串经 el() 的 html 属性注入，无需 i18n
const ICON_READ = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_WRITE = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

// 代码卡片（ABI / 源码）：带标题栏 + 语言标签 + 复制按钮，像代码编辑器面板
function codeCard(title, lang, preEl, copyText) {
  return el("div", { class: "code-card" }, [
    el("div", { class: "code-card-head" }, [
      el("span", { class: "cc-title" }, [title]),
      el("span", { class: "cc-lang" }, [lang]),
      copyBtn(copyText),
    ]),
    preEl,
  ]);
}

function readFile(input, ta) {
  const f = input.files && input.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => { ta.value = r.result; };
  r.readAsText(f);
}
function formatUnits(v, decimals) {
  try { return ABI.getEthers().formatUnits(v, decimals); } catch { return String(v); }
}

// Solc 懒加载（仅源码验证时；失败则回退 ABI-only）
let _solcPromise = null;
function loadSolc() {
  if (_solcPromise) return _solcPromise;
  _solcPromise = new Promise((resolve, reject) => {
    if (typeof window === "undefined" || window.solc) return resolve(window.solc);
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/solc@0.8.26/dist/solc.min.js";
    s.onload = () => resolve(window.solc);
    s.onerror = () => reject(new Error("solc load failed"));
    document.head.appendChild(s);
    setTimeout(() => reject(new Error("solc timeout")), 15000);
  });
  return _solcPromise;
}
function standardJsonInput(source, compiler, optimize, runs, evm) {
  const sources = {};
  // 支持多文件：若 source 看似标准 JSON 则直接用，否则单文件包装
  try {
    const parsed = JSON.parse(source);
    if (parsed.sources) return parsed;
  } catch { /* 单文件 */ }
  sources["contract.sol"] = { content: source };
  const settings = { optimizer: { enabled: !!optimize, runs: parseInt(runs || "200", 10) || 200 }, outputSelection: { "*": { "*": ["evm.deployedBytecode"] } } };
  if (evm && evm !== "default") settings.evmVersion = evm;
  return { language: "Solidity", sources, settings };
}

// 给 el() 增加 .also 链式（用于 innerHTML 高亮）
if (typeof Element !== "undefined" && !Element.prototype.also) {
  Element.prototype.also = function (fn) { fn(this); return this; };
}

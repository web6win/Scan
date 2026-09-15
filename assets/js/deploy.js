// ===== 合约部署：浏览器内本地签名 + 广播（不上传私钥）=====
import * as API from "./api.js";
import {
  el, mono, shortHash, fmtNum, toast, errorBox, spinner,
} from "./utils.js";
import { t } from "./i18n.js";

const ETHERS_URL = "https://esm.sh/ethers@6.13.4";
let _ethers = null;
async function loadEthers() {
  if (_ethers) return _ethers;
  toast(t("dep.loadingLib"));
  _ethers = await import(/* @vite-ignore */ ETHERS_URL);
  return _ethers;
}

// 本地 KV 行构造（deploy 页不依赖 views.js 的 kvTable）
function kv(key, val) {
  return el("div", { class: "kv-row" }, [
    el("div", { class: "kv-key" }, [key]),
    el("div", { class: "kv-val" }, [val]),
  ]);
}

function pollReceipt(hash, tries = 40, intervalMs = 3000) {
  return (async () => {
    for (let i = 0; i < tries; i++) {
      const r = await API.getTxReceipt(hash);
      if (r) return r;
      await new Promise((res) => setTimeout(res, intervalMs));
    }
    return null;
  })();
}

function buildSuccess(hash, receipt) {
  const num = receipt.blockNumber ? parseInt(receipt.blockNumber, 16) : null;
  const ok = receipt.status === "0x1";
  return el("div", { class: "panel" }, [
    el("div", { class: "panel-head" }, [
      el("h2", {}, [ok ? t("dep.ok") : t("dep.packedFailed")]),
    ]),
    el("div", { class: "kv" }, [
      kv(t("dep.txHash"), el("a", { class: "link", href: `txs.html#/tx/${hash}` }, [mono(hash)])),
      kv(t("dep.contractAddr"),
        receipt.contractAddress
          ? el("a", { class: "link", href: `address.html#/address/${receipt.contractAddress}` }, [mono(receipt.contractAddress)])
          : el("span", { class: "muted" }, ["—"])),
      kv(t("dep.block"), num != null
        ? el("a", { class: "link", href: `blocks.html#/block/${num}` }, ["#" + fmtNum(num)])
        : el("span", { class: "muted" }, ["—"])),
      kv(t("dep.gasUsed"), receipt.gasUsed ? fmtNum(parseInt(receipt.gasUsed, 16)) : "—"),
      kv(t("dep.status"), ok
        ? el("span", { class: "tag tag-ok" }, [t("dep.okTag")])
        : el("span", { class: "tag tag-fail" }, [t("dep.failTag")])),
    ]),
  ]);
}

function buildBroadcasted(hash) {
  return el("div", { class: "panel" }, [
    el("div", { class: "panel-head" }, [el("h2", {}, [t("dep.broadcasted")])]),
    el("div", { class: "kv" }, [
      kv(t("dep.txHash"), el("a", { class: "link", href: `txs.html#/tx/${hash}` }, [mono(hash)])),
    ]),
    el("div", { class: "hint", style: "padding:0 16px 16px" }, [t("dep.broadcastHint")]),
  ]);
}

async function deploy() {
  const $ = (id) => document.getElementById(id);
  const result = $("deployResult");
  const btn = $("deployBtn");

  let mod;
  try {
    mod = await loadEthers();
  } catch (e) {
    result.replaceChildren(errorBox(t("dep.libFailed")));
    return;
  }
  const { Wallet, Interface } = mod;

  const privRaw = $("privKey").value.trim();
  const bcRaw = $("bytecode").value.trim();
  if (!privRaw || !bcRaw) { toast(t("dep.needInput")); return; }

  let wallet;
  try { wallet = new Wallet(privRaw); } catch (e) {
    result.replaceChildren(errorBox(t("dep.badKey")));
    return;
  }
  const from = wallet.address;

  let bytecode = bcRaw.startsWith("0x") ? bcRaw.slice(2) : bcRaw;
  if (!/^[0-9a-fA-F]*$/.test(bytecode)) {
    result.replaceChildren(errorBox(t("dep.badBytecode")));
    return;
  }

  // 拼接构造函数参数
  const ctorMode = $("ctorMode").value;
  try {
    if (ctorMode === "hex") {
      let h = $("ctorHex").value.trim();
      h = h.startsWith("0x") ? h.slice(2) : h;
      if (h && !/^[0-9a-fA-F]*$/.test(h)) throw new Error(t("dep.badCtorHex"));
      bytecode += h;
    } else if (ctorMode === "abi") {
      const abiText = $("ctorAbi").value.trim();
      const argsText = $("ctorArgs").value.trim();
      if (abiText) {
        const iface = new Interface(JSON.parse(abiText));
        const args = argsText ? JSON.parse(argsText) : [];
        const enc = iface.encodeDeploy(args);
        bytecode += enc.replace(/^0x/, "");
      }
    }
  } catch (e) {
    result.replaceChildren(errorBox(t("dep.ctorFailed") + e.message));
    return;
  }

  btn.disabled = true;
  btn.textContent = t("dep.submitting");
  result.replaceChildren(spinner(t("dep.gettingParams")));

  try {
    const info = await API.getChainInfo();
    const chainId = info.chainId;
    const nonce = await API.getNonce(from);

    let gasPrice = BigInt(info.gasPrice || "0x0");
    if ($("priceMode").value === "manual") {
      const g = parseFloat($("gasPrice").value);
      if (!g || g <= 0) throw new Error(t("dep.badGasPrice"));
      gasPrice = BigInt(Math.floor(g * 1e9));
    }
    if (gasPrice <= 0n) gasPrice = 1000000000n; // 兜底 1 Gwei

    const data = "0x" + bytecode;
    let gasLimit;
    if ($("gasMode").value === "manual") {
      gasLimit = parseInt($("gasLimit").value, 10);
      if (!gasLimit || gasLimit <= 0) throw new Error(t("dep.badGasLimit"));
    } else {
      try {
        const est = await API.estimateGas({ from, data, value: "0x0" });
        gasLimit = Math.max(21000, Math.floor(est * 1.2));
      } catch (e) {
        gasLimit = 3000000;
        toast(t("dep.gasFallback", { n: gasLimit }));
      }
    }

    const tx = {
      type: 0,
      nonce,
      gasPrice: "0x" + gasPrice.toString(16),
      gasLimit,
      to: null,
      value: "0x0",
      data,
      chainId,
    };

    const raw = await wallet.signTransaction(tx);
    const hash = await API.sendRawTransaction(raw);

    result.replaceChildren(spinner(t("dep.broadcastedWait")));
    const receipt = await pollReceipt(hash);
    result.replaceChildren(receipt ? buildSuccess(hash, receipt) : buildBroadcasted(hash));
  } catch (e) {
    result.replaceChildren(errorBox(t("dep.failed") + (e && e.message ? e.message : e)));
  } finally {
    btn.disabled = false;
    btn.textContent = t("dep.submit");
  }
}

let _inited = false;

export function initDeploy() {
  const $ = (id) => document.getElementById(id);
  if (!$("deployBtn")) return;
  if (_inited) return; // 避免重複綁定事件（語言切換時會被再次呼叫）
  _inited = true;

  // 語言切換時清掉動態結果（靜態表單文字由 i18n 的 data-i18n 統一刷新）
  window.addEventListener("langchange", () => {
    const r = $("deployResult");
    if (r) r.replaceChildren();
    const b = $("deployBtn");
    if (b && !b.disabled) b.textContent = t("dep.submit");
  });

  $("ctorMode").addEventListener("change", (e) => {
    const m = e.target.value;
    $("ctorHexField").hidden = m !== "hex";
    $("ctorAbiField").hidden = m !== "abi";
  });
  $("gasMode").addEventListener("change", (e) => { $("gasLimit").hidden = e.target.value !== "manual"; });
  $("priceMode").addEventListener("change", (e) => { $("gasPrice").hidden = e.target.value !== "manual"; });

  $("genWallet").addEventListener("click", async () => {
    try {
      const { Wallet } = await loadEthers();
      const w = Wallet.createRandom();
      $("privKey").value = w.privateKey;
      toast(t("dep.walletCreated", { addr: w.address }));
    } catch (e) {
      toast(t("dep.walletFailed") + (e.message || e));
    }
  });

  $("deployBtn").addEventListener("click", deploy);
}

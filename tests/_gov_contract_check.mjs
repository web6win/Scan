// 忠实复刻新版 ValidatorGovernance.sol 的纯逻辑模型（不依赖 EVM）。
// 新模型（创世预部署、无 initialize）：验证人由 genesis storage 注入；
// 任意验证人 proposeAddValidator / proposeRemoveValidator（提议者自动计 1 票），
// 其它验证人 approve(id) 追加；赞成票 >= ceil(验证人数 × 3/4) 时自动执行。
// 下限 4、上限 256（合约强制）。
// 仅用于实证检验治理规则，与前端 gov.js 的 ABI/读写无关。

const MIN_VALIDATORS = 4;
const MAX_VALIDATORS = 256;

function makeContract() {
  const c = {
    validators: [],        // validatorList（插入顺序，非排序）
    isValidator: {},
    validatorIndex: {},    // 1-based，便于 O(1) 删除
    proposals: [],         // { target, isAdd, approvals, executed, approved:{} }
  };

  // ceil(n * 3 / 4)
  c.requiredApprovals = () => Math.floor((c.validators.length * 3 + 3) / 4);
  c.getValidators = () => c.validators.slice();
  c.validatorCount = () => c.validators.length;
  c.proposalCount = () => c.proposals.length;
  c.getProposal = (id) => {
    const p = c.proposals[id];
    return { target: p.target, isAdd: p.isAdd, approvals: p.approvals, executed: p.executed };
  };

  // 模拟创世预部署：把初始验证人直接写入 storage（无构造函数、无 initialize）
  c.predeploy = (initial) => {
    for (const v of initial) {
      if (v === 0) throw new Error("VG: zero address");
      if (!c.isValidator[v]) {
        c.isValidator[v] = true;
        c.validatorIndex[v] = c.validators.length + 1;
        c.validators.push(v);
      }
    }
  };

  const _addValidator = (v) => {
    if (c.validators.length >= MAX_VALIDATORS) throw new Error("VG: max 256 validators");
    c.isValidator[v] = true;
    c.validatorIndex[v] = c.validators.length + 1;
    c.validators.push(v);
  };
  const _removeValidator = (v) => {
    if (c.validators.length <= MIN_VALIDATORS) throw new Error("VG: keep >= 4 validators");
    const idx = c.validatorIndex[v]; // 1-based
    const last = c.validators.length - 1;
    if (idx - 1 !== last) {
      const moved = c.validators[last];
      c.validators[idx - 1] = moved;
      c.validatorIndex[moved] = idx;
    }
    c.validators.pop();
    c.isValidator[v] = false;
    delete c.validatorIndex[v];
  };
  const _tryExecute = (p) => {
    if (p.executed) return;
    if (p.approvals >= c.requiredApprovals()) {
      // 真实合约里 p.executed = true 先置位，再调 _addValidator / _removeValidator；
      // 若内部因越界 revert，EVM 会把整笔交易（含 executed）回滚。这里等价地只在变更成功后才置位。
      if (p.isAdd) _addValidator(p.target);
      else _removeValidator(p.target);
      p.executed = true;
    }
  };

  c.proposeAdd = (v, voter) => {
    if (!c.isValidator[voter]) throw new Error("VG: caller is not validator");
    if (v === 0) throw new Error("VG: zero address");
    if (c.isValidator[v]) throw new Error("VG: already a validator");
    const id = c.proposals.length;
    const p = { target: v, isAdd: true, approvals: 1, executed: false, approved: {} };
    p.approved[voter] = true;
    c.proposals.push(p);
    _tryExecute(p);
    return id;
  };
  c.proposeRemove = (v, voter) => {
    if (!c.isValidator[voter]) throw new Error("VG: caller is not validator");
    if (!c.isValidator[v]) throw new Error("VG: not a validator");
    const id = c.proposals.length;
    const p = { target: v, isAdd: false, approvals: 1, executed: false, approved: {} };
    p.approved[voter] = true;
    c.proposals.push(p);
    _tryExecute(p);
    return id;
  };
  c.approve = (id, voter) => {
    if (!c.isValidator[voter]) throw new Error("VG: caller is not validator");
    const p = c.proposals[id];
    if (p.executed) throw new Error("VG: proposal executed");
    if (p.approved[voter]) throw new Error("VG: already approved");
    p.approved[voter] = true;
    p.approvals += 1;
    try { _tryExecute(p); }
    catch (e) { p.approvals -= 1; throw e; } // 模拟 EVM revert 整体回滚投票数
  };

  return c;
}

// ---------- 测试 ----------
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  -> " + extra : "")); }
}
function throws(fn, label) {
  try { fn(); fail++; console.log("  ✗ " + label + " (应抛错却没抛)"); }
  catch (e) { pass++; console.log("  ✓ " + label + "  抛错: " + e.message); }
}

console.log("== 1. requiredApprovals = ceil(n × 3/4) ==");
{
  const c = makeContract(); c.predeploy([1, 2, 3, 4]);
  ok("n=4 -> 3", c.requiredApprovals() === 3, c.requiredApprovals());
  c.predeploy([5]);
  ok("n=5 -> 4", c.requiredApprovals() === 4, c.requiredApprovals());
  c.predeploy([6, 7, 8]);
  ok("n=8 -> 6", c.requiredApprovals() === 6, c.requiredApprovals());
}

console.log("== 2. 创世预部署 4 个验证人 ==");
{
  const c = makeContract(); c.predeploy([1, 2, 3, 4]);
  ok("count=4", c.validatorCount() === 4, c.validatorCount());
  ok("全部是验证人", [1, 2, 3, 4].every((v) => c.isValidator[v]));
  ok("getValidators 返回 4 个", c.getValidators().length === 4);
}

console.log("== 3. proposeAdd + approve 达到 ¾ 多数 ==");
{
  const c = makeContract(); c.predeploy([1, 2, 3, 4]);
  const id = c.proposeAdd(5, 1); // 提议者 1 自动 1 票
  ok("提议后 approvals=1", c.getProposal(id).approvals === 1);
  ok("2 票（提议者+1）未达 3，未执行", c.getProposal(id).executed === false && !c.isValidator[5]);
  c.approve(id, 2);
  c.approve(id, 3); // 1+2 = 3 = 门槛 -> 执行
  ok("3 票 -> 已执行", c.getProposal(id).executed === true);
  ok("5 已加入，count=5", c.isValidator[5] === true && c.validatorCount() === 5);
}

console.log("== 4. 同验证人重复 approve 被拒 ==");
{
  const c = makeContract(); c.predeploy([1, 2, 3, 4]);
  const id = c.proposeAdd(5, 1);
  c.approve(id, 2);
  throws(() => c.approve(id, 2), "同一验证人重复赞成被拒");
}

console.log("== 5. proposeRemove + approve ==");
{
  const c = makeContract(); c.predeploy([1, 2, 3, 4, 5]); // n=5, 门槛 4
  const id = c.proposeRemove(5, 1); // 1 票
  c.approve(id, 2);
  c.approve(id, 3);
  c.approve(id, 4); // 1+3 = 4 = 门槛 -> 执行
  ok("4 票 -> 移除执行", c.getProposal(id).executed === true);
  ok("5 被移除，回到 4 个", c.isValidator[5] === false && c.validatorCount() === 4);
}

console.log("== 6. 下限保护：4 个时移除提案可发起，但执行被拒 ==");
{
  const c = makeContract(); c.predeploy([1, 2, 3, 4]); // 门槛 3
  const id = c.proposeRemove(2, 1); // 不抛错，创建提案
  ok("4 个时可发起移除提案", id === 0);
  c.approve(id, 2); // 2 票
  throws(() => c.approve(id, 3), "达 3 票时执行移除越界被拒（下限 4）");
  ok("越界后仍未执行、2 仍在", c.getProposal(id).executed === false && c.isValidator[2] === true && c.validatorCount() === 4);
}

console.log("== 7. 上限保护：256 个时即使达到多数也无法新增 ==");
{
  const c = makeContract();
  const many = []; for (let i = 1; i <= 256; i++) many.push(i);
  c.predeploy(many);
  ok("初始 256 个", c.validatorCount() === 256, c.validatorCount());
  const id = c.proposeAdd(999, 1); // 1 票，门槛 = ceil(256×3/4) = 192
  let n = 1;
  for (let v = 2; v <= 256 && n < 191; v++) { c.approve(id, v); n++; }
  ok("191 票仍未执行", c.getProposal(id).executed === false, c.getProposal(id).approvals);
  throws(() => c.approve(id, 192), "第 192 票触发新增越界被拒（上限 256）");
  ok("越界后仍未执行、999 未加入", c.getProposal(id).executed === false && !c.isValidator[999]);
}

console.log("== 8. 非验证人不能提议 / 审批 ==");
{
  const c = makeContract(); c.predeploy([1, 2, 3, 4]);
  throws(() => c.proposeAdd(5, 9), "非验证人提议被拒");
  const id = c.proposeAdd(5, 1);
  throws(() => c.approve(id, 9), "非验证人审批被拒");
}

console.log("== 9. 已执行提案不可再审批 ==");
{
  const c = makeContract(); c.predeploy([1, 2, 3, 4]);
  const id = c.proposeAdd(5, 1); c.approve(id, 2); c.approve(id, 3);
  ok("已执行", c.getProposal(id).executed === true);
  throws(() => c.approve(id, 4), "已执行提案审批被拒");
}

console.log("== 10. getValidators 返回插入顺序；UI 侧排序升序 ==");
{
  const c = makeContract(); c.predeploy([4, 2, 1, 3]); // 乱序注入
  ok("返回注入顺序（合约不加排序）", JSON.stringify(c.getValidators()) === JSON.stringify([4, 2, 1, 3]), c.getValidators());
  // 与 views.js 一致：小写十六进制字符串字典序即升序
  const sorted = c.getValidators().map(String).sort();
  ok("UI 排序后升序", JSON.stringify(sorted) === JSON.stringify(["1", "2", "3", "4"]), sorted);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

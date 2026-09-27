#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
GitHub Actions workflow 靜態檢查（不需要網路、不需要 gh CLI、不需要 docker）

用法：
  <venv>/Scripts/python.exe _wfcheck.py <repo_root> [<repo_root> ...]
  例：python _wfcheck.py C:/Users/usewe/Documents/web6win/scan/VerifyApi

檢查項目：
  1. YAML 可解析、有 on: 與 jobs:
  2. 每個 job 有 runs-on；每個 step 恰好有 uses 或 run；uses 有釘版本
  3. `${{ steps.X.outputs.* }}` 的 X 真的存在
  4. `${{ env.X }}` 的 X 有被定義（workflow/job/step env 或寫進 $GITHUB_ENV）
  5. 已知 action 的 block-scalar 輸入裡沒有誤寫 `#` 註解（會被當成規則送進去）
  6. 沒有拿 github.repository 當 ghcr 映像名（ghcr 要求全小寫）
  7. 檔案裡沒有明顯的硬編密鑰
  8. Dockerfile / .dockerignore 存在
"""
import os
import re
import sys

try:
    import yaml
except ImportError:
    print("need pyyaml:  <venv>/Scripts/python.exe -m pip install pyyaml")
    sys.exit(2)

PASS = 0
FAIL = 0
FAILED = []

DUMP = {"width": 10 ** 6, "allow_unicode": True}

REF_STEPS = re.compile(r"steps\.([A-Za-z0-9_\-]+)\.outputs")
REF_ENV = re.compile(r"env\.([A-Za-z0-9_]+)")
# run 腳本裡的裸 shell 變數（排除 $1 $@ $? 這類位置/特殊參數）
REF_SHELL = re.compile(r"\$\{?([A-Z_][A-Z0-9_]*)\}?")
SHELL_ASSIGN = re.compile(r"(?:^|[;\s])(?:export\s+)?([A-Z_][A-Z0-9_]*)=")
# runner 自己提供的變數，不用我們定義
SHELL_BUILTIN = re.compile(r"^(GITHUB_|RUNNER_|ACTIONS_|INPUT_|TMPDIR$|HOME$|PATH$|PWD$|SHELL$|USER$|HOSTNAME$|LANG$|CI$)")

# 這些 action 的輸入是「一行一條規則」的 block scalar，裡面的 # 是資料不是註解
RULE_BLOCK_INPUTS = {
    ("docker/metadata-action", "tags"),
    ("docker/metadata-action", "images"),
    ("docker/metadata-action", "flavor"),
}

SECRET_HINTS = [
    re.compile(r"Password\s*=\s*(?!REPLACE|\$|\{\{)[^\s\"';]{8,}", re.I),
    re.compile(r"(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
]


def ok(msg):
    global PASS
    PASS += 1
    print(f"  ok   {msg}")


def bad(msg):
    global FAIL
    FAIL += 1
    FAILED.append(msg)
    print(f"  FAIL {msg}")


def check_file(path, raw):
    print(f"\n-- {path}")
    try:
        doc = yaml.safe_load(raw)
    except Exception as exc:  # noqa: BLE001
        bad(f"YAML 解析失敗：{exc}")
        return
    if not isinstance(doc, dict):
        bad("頂層不是 mapping")
        return
    ok("YAML 可解析")

    # YAML 1.1 會把 `on` 解析成布林 True，所以兩種 key 都要找
    triggers = doc.get("on") if "on" in doc else doc.get(True)
    if not triggers:
        bad("沒有 on: 觸發設定")
    else:
        names = sorted(triggers) if isinstance(triggers, dict) else [str(triggers)]
        ok(f"觸發：{', '.join(names)}")

    jobs = doc.get("jobs") or {}
    if not isinstance(jobs, dict) or not jobs:
        bad("沒有 jobs")
        return

    wf_env = set((doc.get("env") or {}).keys())

    for jname, job in jobs.items():
        if not isinstance(job, dict):
            bad(f"job {jname} 不是 mapping")
            continue
        steps = [s for s in (job.get("steps") or []) if isinstance(s, dict)]

        if "runs-on" not in job:
            bad(f"job {jname} 缺 runs-on")
        else:
            ok(f"job {jname}  runs-on={job['runs-on']}, {len(steps)} steps")

        ids = {s["id"] for s in steps if "id" in s}
        job_env = set((job.get("env") or {}).keys())

        # step 形狀 + block-scalar 註解
        shape_bad = 0
        for i, s in enumerate(steps):
            has_uses, has_run = "uses" in s, "run" in s
            if has_uses == has_run:
                bad(f"job {jname} step[{i}]（{s.get('name')}）必須恰好有 uses 或 run 之一")
                shape_bad += 1
            if has_uses and "@" not in str(s["uses"]) and not str(s["uses"]).startswith("./"):
                bad(f"job {jname} step[{i}] uses 沒釘版本：{s['uses']}")
                shape_bad += 1
            for key, val in (s.get("with") or {}).items():
                # uses 帶 @v5 版本後綴，比對前先剝掉
                action = str(s.get("uses", "")).split("@")[0]
                if (action, key) in RULE_BLOCK_INPUTS and isinstance(val, str):
                    if any(ln.strip().startswith("#") for ln in val.splitlines()):
                        bad(f"{s['uses']} 的 with.{key} block 裡有 # 註解行（會被當成規則送進去）")
                        shape_bad += 1
        if shape_bad == 0:
            ok(f"job {jname} step 形狀正確、uses 全釘版本、block scalar 無誤植註解")

        # steps.* 引用
        refs = set(REF_STEPS.findall(yaml.dump(job, **DUMP)))
        missing = sorted(r for r in refs if r not in ids)
        for m in missing:
            bad(f"job {jname} 引用了不存在的 step id：{m}")
        if not missing:
            ok(f"job {jname} steps.* 可解析 → {sorted(refs)}（已定義 ids={sorted(ids)}）")

        # env.* 引用
        step_env = set()
        gh_written = set()
        for s in steps:
            step_env |= set((s.get("env") or {}).keys())
            if "run" in s:
                script = str(s["run"])
                for line in script.splitlines():
                    m = re.match(r"\s*([A-Z][A-Z0-9_]*)\s*=", line)
                    if m:
                        gh_written.add(m.group(1))
                # echo "FOO=bar" >> "$GITHUB_ENV" 這種寫法：值在引號裡，抓任何 FOO=
                if "GITHUB_ENV" in script:
                    gh_written |= set(re.findall(r"([A-Z][A-Z0-9_]*)=", script))
        defined = wf_env | job_env | step_env | gh_written
        env_refs = set(REF_ENV.findall(yaml.dump(steps, **DUMP)))
        unknown = sorted(e for e in env_refs if e not in defined)
        for u in unknown:
            bad(f"job {jname} 引用了未定義的 env：{u}")
        if not unknown:
            ok(f"job {jname} env.* 可解析 → {sorted(env_refs)}（defined={sorted(defined)}）")

        # run 腳本裡的裸 shell 變數（打錯字就變空字串，最難發現）
        shell_refs, inline = set(), set()
        for s in steps:
            if "run" not in s:
                continue
            script = str(s["run"])
            inline |= set(SHELL_ASSIGN.findall(script))
            shell_refs |= set(REF_SHELL.findall(script))
        unresolved = sorted(
            v for v in shell_refs
            if v not in defined and v not in inline and not SHELL_BUILTIN.match(v)
        )
        for v in unresolved:
            bad(f"job {jname} run 腳本用了未定義的 shell 變數 ${v}")
        if not unresolved:
            ok(f"job {jname} run 腳本的 {len(shell_refs)} 個變數都有來源")

    # ghcr 映像名必須全小寫
    img_lines = [v.strip() for v in re.findall(r"^\s*images:\s*(.*)$", raw, re.M)]
    for v in img_lines:
        if "github.repository" in v and "repository_owner" not in v:
            bad(f"images 用了 github.repository（會帶 repo 名的大小寫，ghcr 不接受）→ {v}")
    joined_img = " ".join(img_lines)
    if "env.IMAGE" in joined_img or "env.REGISTRY" in joined_img:
        if re.search(r"\$\{[A-Z_]*REPOSITORY_OWNER,,\}", raw):
            ok("映像名由 shell 小寫化組出（${…REPOSITORY_OWNER,,}/…）")
        else:
            bad("映像名走 env.IMAGE / env.REGISTRY，但找不到小寫化處理（ghcr 要求全小寫）")
    elif img_lines and not any("github.repository" in v for v in img_lines):
        ok(f"images 未使用 github.repository → {img_lines}")

    # 密鑰掃描
    hits = [m.group(0)[:60] for pat in SECRET_HINTS for m in pat.finditer(raw)]
    if hits:
        bad(f"疑似硬編密鑰：{hits}")
    else:
        ok("沒有明顯的硬編密鑰")


def check_dockerfile(root):
    """沒有 docker 時，靠靜態比對抓出多階段 Dockerfile 的常見錯法。"""
    path = os.path.join(root, "Dockerfile")
    if not os.path.isfile(path):
        bad(f"缺少 {path}")
        return
    raw = open(path, "r", encoding="utf-8").read()

    stages = re.findall(r"^FROM\s+(\S+)\s+AS\s+(\w+)", raw, re.M | re.I)
    names = [n for _, n in stages]
    if len(names) < 2:
        bad("Dockerfile 不是多階段（CI 會找不到 SDK 來 publish）")
    else:
        ok(f"Dockerfile 多階段：{', '.join(n for _, n in stages)}")

    # 最終階段不該是 SDK 映像（那會讓映像肥到不像話）
    last_from = re.findall(r"^FROM\s+(\S+)", raw, re.M | re.I)
    if last_from and "/sdk:" in last_from[-1]:
        bad(f"最終階段用了 SDK 映像：{last_from[-1]}")

    # publish 輸出目錄 ↔ COPY --from 來源要對得上（跨階段路徑寫錯是最常見的啞巴錯）
    outs = re.findall(r"-o\s+(/\S+)", raw)
    for stage, src in re.findall(r"^COPY\s+--from=(\w+)\s+(/\S+)\s+", raw, re.M):
        if stage not in names:
            bad(f"COPY --from={stage} 指向不存在的階段（已定義 {names}）")
            continue
        src_n = src.rstrip("/")
        if not any(src_n == o.rstrip("/") or src_n == os.path.dirname(o.rstrip("/")) for o in outs):
            bad(f"COPY --from={stage} {src} 對不上任何 publish 輸出 {outs}")
        else:
            ok(f"跨階段 COPY {src} ← 階段 {stage} 路徑一致")

    # ENTRYPOINT 的 dll 名要和 csproj 的 AssemblyName 一致
    ent = re.search(r"^ENTRYPOINT\s+\[(.*)\]", raw, re.M)
    dlls = re.findall(r'"([^"]+\.dll)"', ent.group(1)) if ent else []
    if not dlls:
        bad("ENTRYPOINT 沒有指定 .dll")
    else:
        expected = set()
        for c in os.listdir(root):
            if c.endswith(".csproj"):
                txt = open(os.path.join(root, c), "r", encoding="utf-8").read()
                m = re.search(r"<AssemblyName>([^<]+)</AssemblyName>", txt)
                expected.add((m.group(1) if m else c[: -len(".csproj")]) + ".dll")
        if expected and dlls[0] not in expected:
            bad(f"ENTRYPOINT 用 {dlls[0]}，但 csproj 的組件名是 {sorted(expected)}")
        else:
            ok(f"ENTRYPOINT 組件名一致 → {dlls[0]}")

    # EXPOSE 與 ASPNETCORE_URLS 的埠要一致
    expose = re.findall(r"^EXPOSE\s+(\d+)", raw, re.M)
    urls = re.search(r"ASPNETCORE_URLS=http://[^:\s]+:(\d+)", raw)
    if expose and urls:
        if expose[0] != urls.group(1):
            bad(f"EXPOSE {expose[0]} 與 ASPNETCORE_URLS 的 {urls.group(1)} 不一致")
        else:
            ok(f"EXPOSE / ASPNETCORE_URLS 埠一致 → {expose[0]}")
    elif not urls:
        bad("沒有設 ASPNETCORE_URLS，容器可能只聽 localhost")

    # USER $APP_UID（非 root 執行）需要 aspnet/runtime ≥ 8 才有這個變數
    if "USER $APP_UID" in raw:
        base = re.search(r"mcr\.microsoft\.com/dotnet/(aspnet|runtime):(\d+)", raw)
        if base and int(base.group(2)) < 8:
            bad(f"用了 $APP_UID 但基礎映像 dotnet/{base.group(1)}:{base.group(2)} 沒定義它")
        else:
            ok("以非 root（$APP_UID）執行")

    # .dockerignore 必須擋掉主機的 bin/ obj/，否則容器內 restore 會被髒產物搞壞
    ig = os.path.join(root, ".dockerignore")
    if not os.path.isfile(ig):
        bad("沒有 .dockerignore（build context 會把 obj/ 一起送進去）")
    else:
        itxt = open(ig, "r", encoding="utf-8").read()
        missing = [p for p in ("obj", "bin", ".git") if p not in itxt]
        if missing:
            bad(f".dockerignore 沒擋：{missing}")
        else:
            ok(".dockerignore 已擋掉 obj/ bin/ .git")

    # 佔位用的 appsettings.json 不能夾真密鑰（只看連線字串本體，不要被別處的 REPLACE_ 騙過）
    cfg = os.path.join(root, "appsettings.json")
    if os.path.isfile(cfg):
        ctxt = open(cfg, "r", encoding="utf-8").read()
        # 必須鎖定 ConnectionStrings 區塊：Logging.LogLevel 裡也有一個 "Default"
        m = re.search(r'"ConnectionStrings"\s*:\s*\{[^}]*"Default"\s*:\s*"([^"]*)"', ctxt, re.S)
        conn = m.group(1) if m else ""
        pm = re.search(r"Password=([^;]*)", conn)
        if pm and pm.group(1).strip() and "REPLACE" not in pm.group(1):
            bad(f"appsettings.json 的連線字串寫了真密碼（Password={pm.group(1)[:3]}***）")
        elif conn:
            ok(f"appsettings.json 連線字串為佔位值 → {re.sub(r'Password=.*', 'Password=***', conn)}")
        else:
            bad("appsettings.json 找不到 ConnectionStrings:Default")
        ak = re.search(r'"AdminKey"\s*:\s*"([^"]*)"', ctxt)
        if ak and ak.group(1).strip():
            bad("appsettings.json 的 Auth:AdminKey 不是空的（真值該走環境變數 / user-secrets）")
        else:
            ok("appsettings.json 的 Auth:AdminKey 為空（寫入預設關閉）")


def main():
    roots = sys.argv[1:] or ["."]
    found = 0
    for root in roots:
        wfdir = os.path.join(root, ".github", "workflows")
        if not os.path.isdir(wfdir):
            bad(f"找不到 {wfdir}")
            continue
        for name in sorted(os.listdir(wfdir)):
            if name.endswith((".yml", ".yaml")):
                found += 1
                p = os.path.join(wfdir, name)
                with open(p, "r", encoding="utf-8") as fh:
                    check_file(p, fh.read())
        check_dockerfile(root)
    if not found:
        bad("一個 workflow 都沒找到")

    print(f"\n{'=' * 46}\nPASS {PASS} / FAIL {FAIL}")
    for f in FAILED:
        print(f"  - {f}")
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()

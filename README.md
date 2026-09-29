# 可靠性守卫 / Reliability Guard (`dsh-reliability-guard`)

A reliability guard for **DeepSeek Harness**. Starting with 1.1.7, the package deliberately does **not** declare `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` host-version peers, so DSH prerelease updates are not blocked solely by a stale version range. It adds deterministic gates around the agent loop to reduce guessing, repeated no-progress calls, false completion, and irreversible mistakes.

适用于 **DeepSeek Harness** 的可靠性守卫插件。自 1.1.7 起，包清单不再声明 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 宿主版本 peer，因此 DSH 的 RC/小版本更新不会仅因为旧版本范围而阻止插件加载。它在 Agent 循环周围增加确定性门禁，用于减少猜测、无进展的重复调用、假完成和不可逆错误。

Every gate is computed from program state and tool results. Nothing here asks a
model to self-assess, and nothing here replaces an official DSH capability.

- **npm:** `dsh-reliability-guard`

- **Version / 版本：** 1.1.8
- **Runtime:** DSH host-version admission is unpinned; Node ≥ 20
- **Dependencies:** `@deepseek-ai/cordis` 4.0.4 and `@deepseek-ai/schemastery` 3.18.4 remain explicit peers; DSH host modules are supplied by the Harness runtime resolver
- **Build step for consumers:** none — the published artifact is plain ESM

### Host-version compatibility policy / 宿主版本兼容策略

From 1.1.7 onward, `package.json` intentionally omits peers named `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*`. DSH's Loader treats a missing DSH host peer as **no version constraint**, which avoids repeated plugin releases solely to follow `0.x` prerelease numbers. This does **not** promise API compatibility with every future DSH build: if DSH removes or changes an API the plugin actually uses, activation can still fail at import/runtime and that release must be adapted normally.

自 1.1.7 起，`package.json` 有意不声明 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` peer。DSH Loader 会把“未声明 DSH host peer”视为**没有版本约束**，因此后续 RC/小版本不会只因版本号变化而被兼容门拦截。这不等于承诺未来所有 DSH API 都兼容：若官方真正删除/改变插件使用的 API，插件仍可能在加载或运行时失败，届时需要真实适配。

The source `devDependencies` may stay pinned to a known DSH train for reproducible development; those entries are not runtime compatibility constraints.
开发用 `devDependencies` 可以继续固定在已知 DSH 版本线上以保持复现性；它们不参与运行时兼容门。

---

## What it does

| Gate | What it decides | How it decides it |
|---|---|---|
| **Prompt policy** | The operating rules the model reads on every request | One static, ordered system-prompt section (`reliability-guard:policy`) |
| **Evidence ledger** | Is a conclusion still supported by current state? | Per-session record of file versions, verifications, failures and declared unknowns; a later change invalidates earlier observations |
| **Tool loop guard** | Is this call provably not making progress? | Consecutive byte-identical runs, argument-normalized semantic runs, pure no-op shell runs, blind retries with no state change, and no-progress stalls |
| **Mutation risk classifier** | How dangerous is this call, and is it reversible? | Deterministic rules over the tool name, its arguments and the workspace root → `LOW`/`MEDIUM`/`HIGH`/`CRITICAL` |
| **Verification planner** | Did the check actually pass? | Parses exit codes, test summaries, clean-check markers and artifact identities out of the real result — never the presence of a success word |
| **Completion gate** | May this turn end? | Blocks while a mutation has no covering verification, a failure is unexplained, or a review failed; informs once about open unknowns |
| **Independent reviewer** | Did a fresh-context reviewer find a counterexample? | Injects a review request that excludes the executor's reasoning, then requires an explicit `VERDICT: PASS`/`FAIL` |
| **Freshness gate** | Is this an external fact being asserted from memory? | A clause must carry a topic marker *and* read as a claim about the external present; a relevant retrieval inside the window, or an explicit "not freshly verified" label, answers it. Always advisory |
| **Windows-first checks** | Will this environment detail break the command? | Encoding, quoting, path separators, CRLF and fresh-process semantics, evaluated only on Windows |

Plus one read-only diagnostics tool, `reliability_guard`, that reports what the
guard has actually verified in the current session.

`reliability_guard_reconcile` repairs session accounting only; it never changes
files. / 新增记账修复工具，只修改本会话账本，不修改文件。

### Shell read-back / Shell 回读验证

`Get-FileHash`, `Get-Item`, and `Get-Content` are recorded as `read-back`, just
like the harness `read` tool. Literal paths, semicolon/newline-separated reads,
and formatting pipelines such as `Select-Object`, `Format-List`, `Format-Table`,
`ConvertTo-Json`, and `Out-String` are supported. A shell read must produce
observable output and finish without a reported error or interruption.
Dynamic scripts, substitutions, output redirection, discarded output, and
mixed read/write commands are not inferred as pure read-back.

支持上述 PowerShell 命令的纯读取及常见格式化管道，成功后按 `read-back` 记账。
无输出、错误、中断、后台未完成和混合读写不会被直接算作成功回读。
复杂脚本请拆出单独的读取命令，或使用 harness 的 `read` 工具。

The verdict, ledger, diagnostics, and gate share one strength policy. Each
changed path must have a later check matching its expected state (present or
absent). Reading another file, a generic listing, or a review PASS cannot close
that gap. Rewriting the same path requires a new check. `diff` remains weak.
Tests/builds/lint record the pending target set when they start; this prevents
older or concurrent checks covering newer changes, but does not prove that a
test suite semantically exercises every changed file. Read-back verifies
observed state, not functional correctness.

验证按“具体路径 + 预期存在/不存在 + 调用顺序”记账。读取无关文件、普通列目录、
单独 diff 或评审 PASS 不能抵扣目标缺口；同一路径再次修改后必须重新验证。
测试、构建和 lint 绑定启动时待验证的目标集，但不能据此证明测试的语义覆盖率。

### Deletion verification / 删除验证

After an observed deletion, use a separate call with a literal target:

```powershell
Test-Path -LiteralPath .\gone.txt
```

`False` covers that deletion. A fixed literal label such as
`'gone=' + (Test-Path -LiteralPath .\gone.txt)` is also a self-contained receipt
when the returned line is exactly `gone=False`. `Get-Item` or native `read`
reporting the expected missing target also works when absence is confirmed. An
exact-name `glob` with no results covers a known deleted **file**, not a directory.
A parent-directory re-list covers recorded deletions only after an additional
exact filesystem absence check; the listing text alone is never proof.
Confirmation refreshes the stale observation to “absent”.
Permission errors, unrelated targets, wildcard searches and `-PathType Leaf`
are not accepted as proof of total absence. Review remains a separate gate. Since
1.1.4, PowerShell receipts understand the current DSH structured stream shape
`stdout: { text, ... }` / `stderr: { text, ... }`; existence receipts use the
structured stdout text when available
and otherwise normalize DSH's presentation-only marker lines such as `[stdout]` /
`[exit code: 0]`, so an exact `False` is not discarded when the host omits a
structured `stdout` field. Relative shell receipts are resolved from the call's
explicit `workdir` when present. A parent re-list uses the DSH fs service for its
required exact stat when available and a native absolute-path stat fallback on the
Desktop host when that service is unavailable.

删除后单独执行上述命令，返回 `False` 即可验证该路径。固定字面量标签形式，例如
`'gone=' + (Test-Path -LiteralPath .\gone.txt)` 返回精确 `gone=False` 时也直接构成
目标回执，不再额外依赖 fs 服务。也支持目标 `Get-Item` / 原生 `read` 的确认不存在
结果、精确文件名 `glob` 空结果，以及父目录重列后通过**独立精确 stat**确认目标
不存在；目录 listing 文本本身仍不算删除证据。成功后旧的 stale 观察更新为 absent，
不再要求读取已删文件。权限错误、无关路径、通配符和 `-PathType Leaf` 不作为路径
完全不存在的证据。自 1.1.4 起，PowerShell 回执兼容当前 DSH 的结构化流对象
`stdout: { text, ... }` / `stderr: { text, ... }`；存在性回执优先读取 `stdout.text`；
结构化字段不可用时，会仅剥离 DSH 的独立展示标记行（如 `[stdout]` / `[exit code: 0]`）
再做精确布尔绑定。父目录重列所需的精确 stat 优先使用 DSH fs 服务，服务不可用时
仅对当前宿主可识别的本机绝对路径使用原生 stat 兜底。相对路径按调用显式
`workdir` 解析。自 1.1.1 起，DSH Desktop 自动拼接的
`[Console]::OutputEncoding = ...; $OutputEncoding = ...;` 编码前导被作为精确匹配的
宿主传输脚手架跳过，不再让后续 `Test-Path` / `Get-FileHash` / `Get-ChildItem`
因 `scopeUncertain` 被整段丢弃。其它未知 PowerShell stage 仍保持 fail-closed。

Detailed diagnostics include the receipt source for verification targets, for
example `shell-false`, `shell-labeled-false`, `shell-not-found`, or
`listing+exact-stat`, so a closed deletion can be attributed to the check that
actually covered it. / 详细诊断会标出每个验证目标的回执来源，避免出现 pending 已归零但
无法解释究竟是哪次检查覆盖的情况。

For deletions that may need independent review, preserve pre-delete evidence before
or as part of the deletion call when practical: the target path plus an actual size
and SHA256 emitted by a real filesystem/hash tool. A model-authored byte count, hash,
or prose claim is not evidence and cannot establish the deleted file's prior state.

若删除后可能需要独立评审，建议在删除前或删除命令中保留真实工具输出的前态证据：
目标路径、size 与 SHA256。模型自行写出的字节数、哈希或文字声明不构成证据，也不能
证明被删文件此前确实存在。1.1.1 还会在可精确解析的 mutation 执行前记录 guard 自己
通过文件系统 `stat` 观察到的 `present/type/size`，并把它带入诊断与独立评审上下文；
这能证明“该精确目标在删除前确实存在”，但它不是内容哈希，也不会冒充对已删除字节
内容的审查证据。

### Boundaries / 能力边界

1.0.6 also accepts straight-line PowerShell assignments within **one call**:

```powershell
$f = 'C:\work\gone.txt'; Remove-Item -LiteralPath $f -Force
# In a separate verification call, declare the variable again:
$f = 'C:\work\gone.txt'; Test-Path -LiteralPath $f
```

Only literal strings are resolved (case-insensitive variable names, simple
reassignment, and standalone `$f` / `"$f"` references). Branches, computed paths,
interpolation, cross-call variables and changed working directories are not
guessed. A recognized mutator with unresolved targets or failed filesystem
observations creates an **unresolved mutation risk**, not a fabricated mutation.
That risk remains an unverified item for the current turn even after unrelated
reads, a test pass, or review PASS. The normal correction budget still bounds
messages; it does not turn the risk into a verified result. In 1.0.7 use the
reconciliation tool described below to declare full scope, then independently
observe each target. Do not repeat a destructive operation merely to satisfy
the guard. Declared scope is an explicit caller assertion, not an automatically
proven reconstruction of an arbitrary script's entire effects.

1.0.6 支持同一条调用内的字面量变量赋值、大小写不敏感引用、简单重赋值，以及
独立 `$f` / `"$f"` 参数。每次 PowerShell 调用需重新声明变量，不跨调用继承。
条件分支、表达式、字符串插值、环境变量和工作目录变化不做猜测。已识别的修改
命令若无法确定目标，或文件快照读取失败，会产生独立的“未解析修改风险”；这不是
“确认发生了修改”，也不等于“没有修改”。无关回读、测试成功和评审 PASS 不能消除
它。本轮应明确报告未验证；提示次数上限不改变此状态。1.0.7 提供下述补录入口，
声明完整范围后必须另行观测目标。范围来自调用者声明，不等于程序独立证明了任意
脚本的全部副作用；不应为了消除提示而盲目重做删除。

Detailed diagnostics include bounded, redacted mutation events, call sequence,
expected target state, covering verification sequence, and unresolved risks.
These are in-memory, current-turn records, not a durable filesystem audit log.
诊断详情提供有界、脱敏的逐条变更和覆盖验证信息；记录属于本轮内存状态，不是持久化审计日志。
Since 1.0.8, count-only reset receipts survive reloads under the profile; see below.
自 1.0.8 起，未闭合数量摘要会保存在 profile 中，重启不再静默冒充解决。

### Restart accounting and tool registration / 重启记账与工具注册

- Both tools are registered in a lifecycle-owned tools-service scope, checked
  by registry read-back, retried at startup (0/100/1000 ms) and checked on agent
  creation/tool execution. Service replacement reactivates registration.
  Success, failure and skip are logged at `info` (unless your log threshold hides
  that level). Diagnostics include `toolsRegistered: true/false`, checked in the
  calling agent's visible tool scope. / 两工具注册后回查，启动有界重试；已有会话也可用。
- **更新插件后若工具不可见，请再重启一次应用。** Wait until the package-manager
  update finishes, then restart. If tools remain invisible, check profile bundle
  loading and `reliability-guard` registration logs. A plugin cannot repair a host
  that has not loaded its new code or has filtered out its tools. The observed
  desktop first-restart race is not claimed to be reproduced by isolated tests.
- The launcher-provided `profileContext.dir` is the sole storage location source:
  `<profile>/reliability-guard/checkpoints/<sha256(session-id)>.json`.
  Count-only receipts are atomically replaced and file-flushed. No original
  commands, target paths, message text or raw session IDs are written there.
  Mutating/uncertain calls also leave an in-flight count before execution so an
  interrupted call is not silently reported as completed. / 只存计数，不存原命令或正文。
- **This is reset accounting, not full ledger restoration.** On reload, previous
  open counts become `history.status: reset`, with `resetCount`, per-kind `reset`
  counts and `resolvedByRestart: 0`. Turn-boundary drops are also archived.
  Receipts count obligations (a change and its review are separate), not unique
  files. Old filesystem observations are not restored as current proof; callers
  must disclose historical gaps and re-establish current evidence if needed.
  / 重启后明确报告“重置，非解决”，不把旧证据恢复为 PASS，也不伪装为完整账本持久化。
- For pre-1.0.8 sessions without a receipt, history is `history-unavailable`, not
  a claimed zero. Without a profile, storage is `unavailable`; unreadable/corrupt
  receipts or failed writes are reported as `error`, with a warning. Existing
  corrupt receipts are preserved. This local receipt store assumes one active
  writer per session/profile; it is not a concurrent multi-process database.
  / 无旧摘要时无法追溯历史数量；存储错误可见，不覆盖损坏摘要。卸载不删除历史摘要。

### Explaining failures / 解释失败

Use detailed diagnostics to obtain `failure_id`, then call:

```json
{"action":"resolve_failure","failure_id":"failure-2-1","resolution":"unrelated","reason":"Explain the recorded failure and cite evidence showing why it is unrelated to the requested work."}
```

`resolution` is `explained` or `unrelated`. An optional `evidence_seq` must name
a recorded passing verification newer than the failure. Without it, the reason
is explicitly a **caller explanation**, not machine-verified success. The record
moves to `resolvedFailures`; diagnostics label it “已解释失败”. Mutation coverage,
unknowns and independent-review requirements are unchanged. / 缺口可以解释关闭，
但不能借此伪造测试成功、变更验证或评审通过。

Freshness uses each topic's own timestamp and at least two shared significant
subject words; generic `version/release/latest` words do not count. Failed or
unrelated retrievals do not clear pending claims. Topic records are bounded by
`evidence.maxRecords`. This is still a conservative lexical advisory, not proof
that a retrieved page supports a claim. / 按主题计时并加强相关性；时效门仍是词法提示。

### Repairing accounting / 修复未决记账

1. Call `reliability_guard` with `{"detail":true}`. Use `{"call_seq":3}` to
   inspect a specific earlier mutation/risk and its redacted original command.
2. Declare **all** affected targets with `reliability_guard_reconcile`:

   ```json
   {"action":"declare_targets","call_seq":3,"targets":[{"path":"gone.txt","expected":"absent"}],"reason":"Explain how the original command and evidence establish this complete scope."}
   ```

3. This creates pending checks, **not PASS**. Separately read each present target,
   run `Test-Path -LiteralPath 'gone.txt'`, or re-list its exact parent (the guard
   also performs an exact absence stat). Generic test success cannot settle this
   reconciliation. Older `present` history is labelled superseded, not erased.
   The covering verification must be a **later, separate tool call**. A read launched in the same parallel batch as the mutation cannot verify a change that has not completed yet. / 覆盖核查必须发生在变更之后，并使用独立的后续调用；与变更同批并行的读取不算覆盖证据。

先查序号和原命令，再声明全部目标与预期状态。补录不会直接通过，必须独立验证；
无关读取、旧验证、普通测试成功和评审 PASS 均不能消除这项补录风险。空目标、重复
目标、未来序号、遗漏已知目标会被拒绝。修复工具的参数错误有明确原因，不再污染
任务的未解释失败账本。

For a declared unknown, `resolve_unknown` takes `unknown_id`, a newer successful
`evidence_seq`, and a `reason`. It records the caller's evidence-linked explanation;
it does not waive mutation or review gates. / 未知项可通过上述参数关联较新的成功检查
和解释关闭；记录仍保留，不绕过变更或评审门禁。

The order is strict: **write the declaration -> run a new successful verification -> call `resolve_unknown` with that verification's `evidence_seq`**. A verification older than the declaration is rejected. Explicit uncertainty declarations may be plain, bulleted, or Markdown-bold (for example `未验证: X`, `- 未验证: X`, or `**未验证：X**`). / 顺序必须是“声明 → 新核查 → resolve”；旧证据不能关闭新声明。声明允许朴素、列表或 Markdown 加粗形式。

### 1.0.7 deletion and review details / 删除与评审细节

- Quoted comma lists (`'a','b','c','d'`) preserve each literal target, including
  filenames containing a comma inside their own quotes. / 逗号列表逐路径记账。
- Bare existence checks are preferred. A fixed literal label such as
  `"exists: " + (Test-Path -LiteralPath 'gone.txt')` is supported with Boolean
  output **and** filesystem confirmation; arbitrary wrappers are not interpreted.
  / 支持固定字面量标签拼接，不扩展为任意表达式求值。
- Listings remain weak unless they confirm known deleted targets with exact
  filesystem checks; those confirmations are recorded as strong `absence`.
  / 不把所有 listing 升为强验证，仅对具体删除目标的确认记 absence。
- Child sessions return evidence to their parent for independent review instead
  of recursively spawning reviewers. This is **DEFERRED**, never review PASS.
  Depth-limit errors are capability limitations, not unexplained task failures.
  / 子会话不再递归评审，状态明确交回父会话，而非伪造通过。
- Completed `subagent_fork` verdicts and foreground `workflow` results with
  `agentsStarted > 0` are accepted. Background launch receipts and zero-agent
  workflows are not completed reviews. Existing FAIL findings are not waived.
  / 支持已完成的替代评审工具，不接受后台启动回执或无评审者的 PASS。
- Novel successful read/list output counts as progress; unchanged reads do not.
  `noticesByTag` and `evidenceDigestsInjected` separate actual notices/digests;
  `digestsInjected` remains a legacy total-notice alias. Advisory budget is three
  notices in total per turn. / 新信息计入进展；计数细分，注释与预算保持一致。

The shell recognizer is a bounded literal grammar, not a full PowerShell/Bash
interpreter. It tracks supported literal delete/write/redirection targets by
filesystem version changes, and does not attribute concurrent runtime writes
to read-only commands. Arbitrary scripts, remote changes and unrecognized
mutation verbs may remain untracked; this is not a sandbox or a complete
mutation monitor. Split complex work into
explicit literal operations and checks. Turning `evidence.enabled` off disables
detailed evidence collection, not the minimal accounting needed by the gate.

Shell 识别器不是完整解释器；支持的字面量删除、写入和重定向通过文件版本变化记账。
只读调用不会因为 DSH 同时写日志而被登记为修改。任意脚本、远程资源和未知修改命令
仍可能无法追踪；插件不是沙箱或全量变更监控器，请拆成明确目标的操作与验证。关闭详细 evidence 后，
完成门所需的最小变更/验证记账仍保留，避免无法完成的配置组合。

---

### Install

DSH Reliability Guard is available on **npm** and as a prebuilt `.tgz` package
from [GitHub Releases](https://github.com/StrIngeKing/dsh-reliability-guard/releases).

The npm package name is:

```text
dsh-reliability-guard
```

#### Install from npm

For a DSH profile managed through the CLI:

```sh
dsh plugin --profile <name> add dsh-reliability-guard
```

This installs the published npm package and adds the bundle to the selected
DeepSeek Harness profile.

You may also install the package directly with npm when working with the package
outside DSH:

```sh
npm install dsh-reliability-guard
```

> For normal DeepSeek Harness use, prefer `dsh plugin ... add` rather than
> installing the package directly with npm.

#### Install from GitHub Release

Download the prebuilt package from the corresponding GitHub Release:

```text
dsh-reliability-guard-1.1.8.tgz
```

Then install it into a CLI-managed profile:

```sh
dsh plugin --profile <name> add /abs/path/dsh-reliability-guard-1.1.8.tgz
```

#### Install from a local checkout

For development or local testing:

```sh
dsh plugin --profile <name> add /abs/path/dsh-reliability-guard
```

#### Package structure

The package is a DSH **bundle**: its `package.json` declares
`dsh.bundle.patch`, and that patch inserts one entry (`id: reliability-guard`)
into the composed profile tree.

The plugin relies on the runtime services provided by DeepSeek Harness rather
than bundling a second copy of the host runtime. Its declared peer dependencies
are resolved from the host environment, avoiding duplicate service registries
or prompt infrastructure.

#### Desktop

The Electron application manages the `desktop` profile itself. Install the
plugin through the Desktop plugin interface rather than the CLI:

1. Open **Plugins** in the sidebar.
2. Choose **Install**.
3. Enter the npm package name:

   ```text
   dsh-reliability-guard
   ```

   or select the downloaded `.tgz` file.

4. Confirm that **可靠性守卫 / Reliability Guard** appears in the plugin list.
5. Enable it if necessary.

After installation, open a session and call:

```text
reliability_guard
```

A successful load should report the plugin version and:

```text
toolsRegistered: true
```

### Web

Use the same sidebar → **Plugins** page. `dsh plugin --profile web add …` also
works, but the UI is the supported surface.

### Verifying the load

After installing, open a session and ask the model to call `reliability_guard`.
A successful call returns a report like:

```text
reliability-guard diagnostics v1 (2026-01-01T00:00:00.000Z)
plugin version / 插件版本: 1.1.8
toolsRegistered: true
mode: balanced — identical-repeat block at 5, semantic 3, no-op shell 3, blind retries 2, stall 6
session: <id>
session calls: 0; risk counts: {"LOW":0,"MEDIUM":0,"HIGH":0,"CRITICAL":0}
mutations: 0 file(s) this session; gate injections: 0; review: not required
counters: (none)
```


### Shell-query runtime diagnostic / Shell 查询运行时诊断

The temporary shell-query trace is **off by default** in 1.1.6. When investigating a shell verification that appears as `targets=[]`, set `diagnostics.runtimeShellTrace: true`, reproduce once, then call `reliability_guard(detail:true)`. A bounded diagnostic block records the runtime `exec.name`, argument keys,
`typeof args.command`, a redacted 200-character command preview, whether
`shellCommandOf(...)` recognized the call, and the outputs of both
`verificationQueries(...)` and direct `shellReadQueries(...)`. This is
observability only: it does **not** change verification, evidence, risk, review,
or completion-gate decisions.

该块用于区分“宿主运行时参数形状不同”“query 提取失败”和“query 已有但后执行证据消费失败”。
只保留最近 8 条，并经过脱敏与长度限制；它是诊断信息，不参与证据或门禁判定。

## Uninstall

```sh
dsh plugin --profile <name> remove dsh-reliability-guard
```

or Desktop/Web: sidebar → **Plugins** → **Remove**. The bundle is deselected
from `dsh.profile.bundles` before the package is unloaded, so the guard's
listeners, prompt section and diagnostic tool are disposed with it and no
session state is retained.

Disable without uninstalling (keeps the dependency, stops the guard):

- **Plugins** page → toggle the **可靠性守卫 / Reliability Guard** row off, or
- add to the profile's `cordis.patch.yml`:

  ```yaml
  - id: reliability-guard
    disabled: true
  ```

---

## Context / token cost

Reliability Guard is designed so ordinary read-only work pays little overhead and
high-risk mutations pay for stronger verification/review only when needed. In
1.1.6 the default static policy is `minimal` (804 characters / 104 English words,
versus 2769 / 443 for the previous `compact` default). The section is prefix-stable:
the same configuration renders the same bytes every request, so a host that supports
prefix caching can reuse it; whether cached tokens are billed differently is host-specific.

The default low-overhead profile also uses one completion correction per turn, one
independent reviewer round for HIGH/CRITICAL work, no automatic full evidence digest,
and no runtime shell trace. Safety gates remain active: a mutation still needs covering
verification, and HIGH/CRITICAL work still requires independent review.

For maximum context savings on a trusted/read-only workflow you can additionally disable
features explicitly (`completionGate`, `freshnessGate`, `windows`, or diagnostics), but
doing so removes the corresponding protection/observability rather than merely optimizing it.

### Usage patterns that save work

- Batch a bounded set of targets in one mutation call; the ledger still records each target.
- Keep mutation and verification commands direct instead of hiding them behind opaque scripts.
- For deletion receipts, prefer the shortest exact command: `Test-Path -LiteralPath '<target>'`.
- Give the independent reviewer concrete ledger pre-state, scope and verification evidence; narrative claims are not evidence.
- Keep heavy gates for mutation/audit work; do not enable extra diagnostics or full prompt verbosity for pure prose/read-only tasks unless needed.

## Configuration

Every field is declared with `@deepseek-ai/schemastery` and documented in
[`lib/config.js`](lib/config.js). The fields are marked `.volatile()` so the
Settings surface can retune a running session without a remount.

```yaml
- id: reliability-guard
  config:
    mode: balanced            # balanced | strict | maximum
    maxBlindRetries: 2
    semanticLoopThreshold: 3
    prompt:
      enabled: true
      verbosity: minimal      # minimal | compact | full
    review:
      enabled: true
      highRiskOnly: true
      maxRounds: 1            # set 2 if you want an automatic corrective re-review
    completionGate:
      enabled: true
      maxInjectionsPerTurn: 1
    freshnessGate:
      enabled: true
    evidence:
      injectDigest: false     # gap-specific correction stays enabled
    diagnostics:
      enabled: true
      includeSensitiveContent: false
      runtimeShellTrace: false
```

### Modes

`mode` supplies the numeric threshold defaults; an explicitly configured
threshold always wins.

| Threshold | balanced | strict | maximum |
|---|---|---|---|
| `maxIdenticalRepeats` | 5 | 4 | 3 |
| `maxBlindRetries` | 2 | 2 | 1 |
| `semanticLoopThreshold` | 3 | 3 | 2 |
| `maxNoopShellRun` | 3 | 2 | 1 |
| `maxStallSteps` | 6 | 5 | 4 |

`balanced` is deliberately conservative: it hard-blocks an identical run only
*after* the shipped `dsh-repeat-tool-reminder` thresholds (3/5/8) have already
warned twice, so the official advisory is never superseded by an earlier stop.

### Full field list

| Field | Default | Meaning |
|---|---|---|
| `mode` | `balanced` | Threshold preset |
| `maxIdenticalRepeats` | preset | Consecutive byte-identical calls before a block |
| `maxBlindRetries` | preset | Consecutive failures of one call with no state change |
| `semanticLoopThreshold` | preset | Calls that differ only in whitespace/quoting/comments |
| `maxNoopShellRun` | preset | Consecutive effect-free shell calls |
| `maxStallSteps` | preset | Consecutive calls with no observable progress |
| `repeatWindow` | `12` | Recent calls retained for loop judgement |
| `guard.exactRepeats` | `true` | Byte-identical detector |
| `guard.semanticRepeats` | `true` | Argument-normalized detector |
| `guard.noopShell` | `true` | No-op shell detector |
| `guard.blindRetries` | `true` | Blind-retry detector |
| `guard.stall` | `true` | No-progress detector |
| `risk.enabled` | `true` | Mutation risk classification |
| `risk.requireRollbackPlan` | `true` | Refuse HIGH/CRITICAL without a stated undo path |
| `risk.requireVerificationPlan` | `true` | Refuse HIGH/CRITICAL without a stated check |
| `risk.askOnCritical` | `true` | Route a CRITICAL call to the approval seam |
| `risk.workspaceOnlyWhenUnscoped` | `true` | Unscoped recursive deletes stay workspace-scoped |
| `review.enabled` | `true` | Independent reviewer gate |
| `review.highRiskOnly` | `true` | Review only HIGH/CRITICAL (plus multi-file, see below) |
| `review.multiFileThreshold` | `3` | Distinct files in one turn that also triggers review |
| `review.maxRounds` | `1` | Reviewer rounds; set `2` for one automatic corrective re-review |
| `completionGate.enabled` | `true` | Block a turn that is not ready to end |
| `completionGate.requireVerificationForMutation` | `true` | A mutation needs a covering verification |
| `completionGate.maxInjectionsPerTurn` | `1` | Corrective messages per turn |
| `freshnessGate.enabled` | `true` | External-fact freshness gate |
| `freshnessGate.maxAgeMinutes` | `30` | How long a retrieval stays fresh |
| `freshnessGate.topics` | 13 markers | Substrings that mark a claim as an external fact |
| `windows.enabled` | `true` | Windows/PowerShell environment checks |
| `windows.warnOnNonAsciiCommandWithoutEncoding` | `true` | Non-ASCII without an encoding control |
| `windows.warnOnCrlfSensitivePatch` | `true` | CRLF/LF mismatch on a literal edit |
| `evidence.enabled` | `true` | Evidence ledger |
| `evidence.maxRecords` | `200` | Ledger capacity |
| `evidence.injectDigest` | `false` | Attach the full evidence digest with a correction |
| `evidence.maxDigestChars` | `1600` | Digest cap when enabled |
| `prompt.enabled` | `true` | Register the policy section |
| `prompt.verbosity` | `minimal` | `minimal` (804 chars), `compact` (~2.8k chars), or `full` |
| `diagnostics.enabled` | `true` | Publish `reliability_guard` |
| `diagnostics.includeSensitiveContent` | `false` | Allow bounded argument previews in diagnostics |
| `diagnostics.runtimeShellTrace` | `false` | Keep the 1.1.3 shell-query runtime trace for troubleshooting |
| `diagnostics.logLevel` | `info` | `debug`/`info`/`warn`/`error` |

---

## What DSH already does, and what this plugin adds

Reliability Guard deliberately does **not** reimplement shipped capabilities.
The boundary is:

| Capability | Owned by DSH | Added by Reliability Guard |
|---|---|---|
| Consecutive identical tool-call reminders | `dsh-repeat-tool-reminder` (advisory, canonical-JSON identity, thresholds 3/5/8) | Hard block at a *later* threshold, plus argument-normalized, no-op-shell, blind-retry and stall detection that the official guard does not attempt |
| Human approval | `dsh-user-approval` (`allowed-once`/`rejected`/`cancelled`/`unavailable`, fail-closed) | Uses it: a CRITICAL call without a stated rollback and verification plan is routed there as `{kind:'ask'}` |
| Sandbox / permission mode | `dsh-sandbox-policy` + `dsh-sandbox-*` | Reads it only, to classify scope; never bypasses or reimplements it |
| Stale-file guard | `dsh-fs-observation-policy` (`FsVersion`, `FS_STALE_VERSION`) | Reuses `ctx.fs` versions for its ledger and adds a content digest, which catches an in-place rewrite that keeps size *and* mtime |
| Durability checkpoints | `dsh-session-checkpoint-policy` (`ctx.sessions.flush`) | Separately persists count-only reset receipts under the profile. Neither receipts nor session checkpoints are filesystem rollback snapshots |
| Compaction / truncation | `dsh-compaction-*`, `dsh-spill-policy` | Never truncates model output; its own payloads are bounded by configuration |
| Tool schema exposure | `dsh-tools` registry | Adds diagnostics and a session-accounting repair tool; neither modifies task files. Count-only guard receipts are written under the profile |

## Privacy and safety

- Raw conversation text is never stored by the guard. The ledger records file
  paths, versions, verification kinds, failure digests and the model's own
  explicit `unknown:`-style declarations. Bounded, redacted external-claim
  fragments are retained in memory for per-topic re-evaluation; full messages
  are not retained. Only obligation counts are persisted to the profile.
- Unresolved mutation records retain up to 16,000 characters of the originating
  command in current-turn memory for reconciliation; diagnostic output always
  redacts secrets and bounds the preview. This is not a durable transcript copy.
- Every diagnostic string passes through `redactSecrets`, which replaces
  credential-shaped substrings (API keys, tokens, JWTs, private keys,
  `password=`/`api_key:` pairs) with a stable `<redacted:tag>` placeholder —
  even when `diagnostics.includeSensitiveContent` is enabled.
- Nothing is sent anywhere. There is no telemetry, no network call and no
  external service.
- User git configuration is never modified. The guard does not run commands.
- The sandbox and approval seams are used as-is; the only escalation path it can
  trigger is the official `{kind:'ask'}` verdict, which fails closed when no
  approval channel exists.

## Failure behavior

Fail-closed is reserved for genuinely irreversible or inconsistent states:

- HIGH/CRITICAL mutation with no stated rollback or verification plan → denied,
  or routed to approval for CRITICAL. There is no "allow anyway" path.
- A verification that reports any failure → never counted as verification.
- A failed **read/verification** command is recorded as a failed check, not as an `unexplained failure`; `resolve_failure` is for non-read task failures. / 读取类报错属于失败核查，不进入 unexplained failures。
- An unreadable reviewer report → counted as FAIL.

Everything else degrades to advice rather than stopping work:

- Windows environment findings are advisory only, including the destructive-without-undo note.
- A freshness gap asks for a retrieval or an honest label; it is always advisory and never blocks.
- Loop thresholds require provable non-progress, and the completion gate has a
  per-turn injection budget so the gate can never become the loop it prevents.
- A turn's mutation gap is judged within that turn: an earlier turn's unverified
  change is not something a later read-only turn can close, and a call the guard
  itself refused is never counted as an unexplained failure.
- By default no loop verdict is recorded on turns with no tool calls; the
  guard never invents a check the model did not run.

## Development

```sh
pnpm install          # installs the official DSH packages at the pinned version
pnpm test             # the whole suite
pnpm test:seams       # the seam-level tests
pnpm pack             # prebuilt tarball, no consumer build step
```

Tests drive the **real** official pipeline: the tool registry's own
`pre-execute` / `execute` / `post-execute` / `result` stages, the real session
log, and the production `AgentLoop` mounted by the official
`@deepseek-ai/dsh-agent-loop-testkit`. Tools and model responses are controlled
fixtures; filesystem regressions also execute real PowerShell against isolated
temporary files. These tests do not call a live DeepSeek model.

See [`docs/ADR-0001-reliability-guard.md`](https://github.com/StrIngeKing/dsh-reliability-guard/blob/main/docs/ADR-0001-reliability-guard.md)
for the architecture decisions and the seam inventory this plugin is built on,
and [`CHANGELOG.md`](CHANGELOG.md) for release history.


## Further reading / 进一步阅读

- [Detailed overview: capabilities, boundaries, and token cost](https://github.com/StrIngeKing/dsh-reliability-guard/blob/main/docs/INTRODUCTION.md)
- [详细介绍：能力、边界与 Token 成本](https://github.com/StrIngeKing/dsh-reliability-guard/blob/main/docs/INTRODUCTION.zh-CN.md)
- [Architecture Decision Record / 架构决策记录](https://github.com/StrIngeKing/dsh-reliability-guard/blob/main/docs/ADR-0001-reliability-guard.md)
- [v1.1.8 Validation Report / v1.1.8 验证报告](https://github.com/StrIngeKing/dsh-reliability-guard/blob/main/docs/VALIDATION-1.1.8.md)
- [v1.1.5 Historical Validation / v1.1.5 历史验证](https://github.com/StrIngeKing/dsh-reliability-guard/blob/main/docs/VALIDATION-1.1.5.md)
- [Changelog / 更新日志](CHANGELOG.md)

## License

MIT

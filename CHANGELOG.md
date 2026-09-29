# Changelog

## 1.2.0

- 完成“赛博纪委 / Cyber Internal Affairs”运行时标识迁移：DSH bundle/component id、Cordis plugin name、prompt section、message source kind、诊断/修复工具名与错误码前缀统一使用 `sbjw`。
- DSH 插件详情页不再显示旧组件名 `reliability-guard`。
- 新工具名为 `sbjw` 与 `sbjw_reconcile`。这是一次有意的 1.2.0 兼容性变更。
- checkpoint 新写入 `<profile>/sbjw/checkpoints`；读取时仍兼容旧 `<profile>/reliability-guard/checkpoints`，用于一次性继承历史 reset 计数。
- 历史 CHANGELOG / validation 文档保留旧名称以忠实记录旧版本。


All notable changes to `sbjw` (赛博纪委 / Cyber Internal Affairs) are documented here. This
project follows [Semantic Versioning](https://semver.org/).

## [1.1.9] — 2026-09-29

### Project rebrand / 项目改名

- 项目公开名称改为 **赛博纪委 / Cyber Internal Affairs**；npm 包名改为 **`sbjw`**。
- DSH 本地化元数据改为按界面语言显示：中文 `赛博纪委`，英文 `Cyber Internal Affairs`；插件详情页使用独立中英文介绍。
- README 拆分为 `README.md`（English）与 `README.zh-CN.md`（简体中文），不再在同一文件逐段中英混排，并显著压缩篇幅。
- `cordis.patch.yml` 的包名改为 `sbjw`；`package.json`、发布校验、当前文档、日志/诊断公开品牌和安装示例同步改名。
- 为避免破坏既有 profile、checkpoint、工具调用和外部集成，`reliability-guard` bundle id、`reliability_guard*` 工具名、`reliability-guard:policy` prompt section、既有错误码/存储兼容键继续保留。
- 历史版本验证文档中的旧包名属于当时真实工件记录，未伪造改写。


## [1.1.8] — 2026-09-29

### Declaration and reconciliation hardening / 声明与修复通道加固

- uncertainty 声明解析现在容忍常见 Markdown 列表/加粗形式，例如 `**未验证：X**`、`- **未确认: X**`；避免模型自然排版导致 unknown 安全记账静默失效。
- `reliability_guard_reconcile` 的 `resolve_unknown` 工具说明明确顺序：**声明 → 新的成功核查 → resolve**，`evidence_seq` 必须晚于该声明。
- README 明确：读取类报错记为失败 verification/check，不进入 `unexplained failures`；`resolve_failure` 用于非读取类任务失败。
- completion gate 的评审提示不再写“has not run”，而改为“尚无 PASS/FAIL verdict；本回合已发起的评审可能在回合末落账”，避免同回合 reviewer 已返回但状态尚未 capture 时产生误导。
- 文档补充覆盖性核查的时间顺序：mutation 与 verification 必须是独立、后续调用；与变更同一并行批次启动的读取不能覆盖该变更。
- 不改变 1.1.7 已验收通过的 deletion receipts、review 判定、低开销默认值、DSH host peer 无版本约束策略。

## [1.1.7] — 2026-09-29

### Host compatibility policy / 宿主兼容策略

- 移除 `peerDependencies` 中全部 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` host-version 声明。根据 DSH Loader 的兼容规则，未声明 DSH host peer 即“不施加版本约束”，因此 `0.2.0-rc.2` 及后续 RC/小版本不会再仅因为旧 peer range 被启动兼容门拒绝。
- 不使用 `*` / `>=` 伪装成“无限兼容”；对 prerelease 来说宽泛 semver 容易产生意外匹配语义。这里直接省略 DSH host peers，让 Loader 明确按“无版本约束”处理。
- `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 仍保留精确 peer；源码开发依赖仍可固定在已验证 DSH train，它们不参与 Loader 的 DSH host-version admission。
- 风险取舍：此变更只移除**版本号门禁**，不保证未来 DSH API 永不破坏。真正的 API/服务变更仍可能导致插件加载失败，需要按实际故障适配。
- 运行时代码、1.1.6 的低开销默认值、shell receipt / mutation ledger / review / completion gate 逻辑均不修改。

## [1.1.6] — 2026-09-29

### Low-overhead defaults / 低开销默认值

- 新增 `prompt.verbosity=minimal` 并设为默认：常驻 policy 从 1.1.5 `compact` 的
  2769 字符 / 443 words 降到 804 字符 / 104 words；`compact` 与 `full` 仍可选。
  文本仍保持 prefix-stable，同一配置每次渲染完全相同，便于宿主前缀缓存。
- 默认 `completionGate.maxInjectionsPerTurn=1`、`evidence.injectDigest=false`、
  `evidence.maxDigestChars=1600`，避免同一缺口重复注入整份证据摘要；门禁仍逐目标要求
  mutation verification。
- 默认 `review.maxRounds=1`：HIGH/CRITICAL 仍必须独立评审，但一次 FAIL 后不自动再花
  一轮 reviewer 上下文；需要自动纠错复审的部署可显式改回 `2`。
- 1.1.3 临时 shell-query runtime trace 改为 `diagnostics.runtimeShellTrace=false` 默认关闭；
  需要排障时可临时打开，不影响正常 verification。

### Context compaction / 上下文压缩

- 压缩 `reliability_guard` / `reliability_guard_reconcile` 的常驻 tool schema 描述。
- completion-gate 只注入当前缺口的短指令；默认不再附整份 evidence digest。
- reviewer prompt 保留 requirement / state / change / checks 四块独立证据，但压缩固定说明，
  并对每块做有界截断；mutation / verification 列表也做有界摘要，防止多文件任务把 reviewer
  prompt 无界放大。
- 这些更改只减少上下文，不改变 1.1.5 的 risk、ledger、shell receipt、mutation coverage、
  review PASS/FAIL 或 fail-closed 语义。

## [1.1.5] — 2026-09-29

### Compatibility / 兼容性

- 修复 DSH `0.2.0-rc.1` 的启动兼容门拒绝：六个 `@deepseek-ai/dsh*` host peer 从
  精确 `0.1.7-rc.2` 改为精确双版本范围 `0.1.7-rc.2 || 0.2.0-rc.1`。
- 不使用 `*`、`>=` 或跨未来 prerelease 的宽泛范围；未实际纳入的 `0.2.0-rc.2` /
  `0.3.x` 等仍应由 DSH compatibility gate 拒绝，直到插件明确适配。
- 源码开发依赖切到当前 `0.2.0-rc.1` 线；运行时代码与 1.1.4 完全相同，本版本只修
  host-version declaration / release metadata，不改变 verification、ledger、review 或 gate 语义。

## [1.1.4] — 2026-09-29

### Fixed / 修复

- 修复真实 DSH 0.1.7+ `pwsh` 前台结果的结构化 stream 形状：`stdout` / `stderr` 为
  `{ text, truncated, spillPath? }`，不再把空 stderr 对象 `String(...)` 成 `[object Object]`
  而令 `shellOK=false`。裸 `Test-Path -> False` 与存在文件的 `Get-FileHash` 现在都可进入
  read-evidence 消费链。
- 同时兼容旧式字符串 stream 与数值/数字字符串 exit code；`timedOut` / `aborted` /
  `stopped` / signal / 非空 stderr 仍严格 fail-closed。
- structured stdout 本身可作为 read-back 的可观察输出；不再要求同一 payload 必须重复出现在
  展示文本中。
- 读类核查失败原因现在区分“没有提取到 verification target”和“target 已提取但运行时回执未匹配”，
  避免继续把 post-execute 消费故障误报成 parser 故障。
- 增加 ledger-key 回归，证明 `noteMutation()` 的 Map key 一直是 `pathKey(...)` 规范化形式；
  `mutation #N` 诊断显示的原生路径只是 display path，不代表 Map key。

### Regression coverage / 回归覆盖

- 新增当前 DSH `PwshForegroundResult` 结构对象的 `Test-Path False -> strong absence -> pending 0`、
  `Get-FileHash -> present`、非空 stderr fail-closed，以及 mutation key 等于 query canonical key 的测试。

## [1.1.3] — 2026-09-29

### Diagnostics / 诊断

- 新增一次性、只读的 shell-query 运行时诊断，用于定位真实 DSH Desktop 中
  `verificationQueries(...)` 与直接 `shellReadQueries(...)` 的分歧。`reliability_guard(detail:true)`
  现在会有界显示 `exec.name`、`Object.keys(exec.arguments)`、`typeof args.command`、
  前 200 字符命令预览、`shellCommandOf` 是否可见，以及两条 query 提取路径的返回值。
- 诊断记录仅保留最近 8 条 command-shaped 调用，并继续经过 secret redaction / preview 截断；
  本版本不改变 verification verdict、ledger coverage、risk、review 或 completion-gate 行为。
- 目的仅是区分三种真实运行时故障：宿主 tool/args 形状不匹配、两条 query 提取都失败、
  或 query 已存在但 post-execute evidence 消费失败。确认根因后该临时诊断应在后续版本收敛/移除。

## [1.1.2] — 2026-09-29

### Fixed / 修复

- 修复 DSH 未提供结构化 `value.stdout` 时的删除回执：对展示文本只剥离独立的
  `[stdout]` / `[stderr]` / `[exit code: ...]` 标记行，再进行精确 `True|False`
  绑定；`[stdout]\nFalse\n[exit code: 0]` 现在生成 strong `absence`，不再
  `targets=[]`。Structured stdout remains preferred when present.
- 固定字面量标签 + `Test-Path` 的精确 `...False` 输出现在本身即可绑定目标，取消
  不必要的二次 `ctx.get('fs')` 依赖；权限/错误输出仍 fail closed。
- `Get-Item` 对单一精确字面量目标返回 `ItemNotFoundException` / `PathNotFound` 时，
  可作为该删除目标的 shell absence 回执；多目标模糊错误仍不作绑定。
- 父目录 `Get-ChildItem` 仍不会仅凭 listing 文本升级为强验证；所需 exact stat
  优先使用 DSH fs 服务，服务不可用时只对当前宿主的本机绝对路径使用原生 `stat`
  兜底。Listing remains weak without this independent exact-target check.
- 修复空 shell 展示标记被误算为读取内容：只有 `[stdout]` / `[exit code: 0]` 而无
  实际 payload 时，`hasReadOutput=false`，防止空 `Get-Item` / `Get-FileHash` 假阳性。
- 详细诊断的 verification target 增加 `source`，可直接看到覆盖来自
  `shell-false`、`shell-labeled-false`、`shell-not-found`、`listing+exact-stat` 等，
  解决“pending 已关闭但不知道是谁覆盖”的可观测性问题。

### Regression coverage / 回归覆盖

- 新增真实 DSH 装饰文本、无 `ctx fs` 标签回执、stderr fail-closed、单目标
  `Get-Item` not-found、父目录 listing + native exact stat，以及
  `DSH preamble -> decorated False -> strong absence -> pending mutation 1→0` 整链回归。

## [1.1.1] — 2026-09-29

### Fixed / 修复

- 识别并跳过 DSH Desktop 注入的两条 PowerShell UTF-8 编码前导；它们不再把
  `scopeUncertain` 传播到真实用户命令。带前导的 `Test-Path`、`Get-FileHash`、
  `Get-ChildItem` 与裸命令现在提取出相同读目标。Recognize the exact DSH pwsh
  encoding preamble as host transport scaffolding instead of opaque user code.
- 固定字面量标签包装（`'label' + (Test-Path ...)`）在 DSH 前导存在时同样可解析；
  `-PathType`、通配符、未知 `Set-Location`/表达式 stage 等仍 fail closed。
- PowerShell mutation 提取器在调用方未显式传 `{powershell:true}` 时可由明确的
  PowerShell 语法自动识别 `$f='literal'; Remove-Item -LiteralPath $f`，消除直接
  `shellMutationTargets()` 与真实 DSH 主链的结论不一致。
- 精确 mutation 在执行前若能由 guard 文件系统观察，会记录真实 pre-state
  `present/type/size`；删除评审上下文不再假设必须存在 VCS diff，并明确区分
  文件系统前态证据与“模型自述哈希/字节数”。

### Regression coverage / 回归覆盖

- 新增 DSH 编码前导 + `Test-Path` / `Get-FileHash` / `Get-ChildItem`、固定标签包装、
  中文绝对路径、显式 `workdir` 相对路径、结构化 `stdout=False` 到 strong absence、
  pending mutation 归零，以及变量删除提取一致性的回归测试。
- 保留 fail-closed 边界：未知 cwd-changing stage 不能为相对路径生成可靠查询，
  `-PathType Leaf` 仍不能证明“路径完全不存在”。

## [1.1.0] — 2026-09-29

### Fixed / 修复

- 修复删除回执在 DSH Desktop 结构化 PowerShell 结果下丢失的问题：当 `pwsh`
  同时返回 `value.stdout` 与带 `[stdout]` / `[exit code: 0]` 的展示文本时，
  `Test-Path ... -> False` 现在从真实 stdout 做精确布尔绑定，不再落成
  `existence FAIL; targets=[]`。Use structured shell stdout for exact existence receipts.
- `verificationQueries` 现在按 `pwsh.workdir` 解析相对路径，而不是一律按 workspace
  root；避免正确的相对 `Test-Path` 与 mutation ledger 键错配。Respect explicit shell
  workdir for verification target resolution.
- `-LiteralPath` / `-Path` / `-FilePath` 现在显式消费紧随其后的字面量路径参数；
  缺失、动态、运算符目标继续 fail closed。Explicitly bind path-bearing flags to
  their literal operands without broadening the accepted shell grammar.
- 保持既有边界：`-PathType` / 通配符不作为“完全不存在”证明，普通 listing 不升级
  为强验证；只有已知删除目标经精确 stat 确认后才记录 strong `absence`。

### Documentation / 文档

- 对齐删除门禁提示与实现：裸 `Test-Path`、固定字面量标签 + `Test-Path`、父目录
  re-list + exact stat 均有对应回归覆盖。
- 补充删除前证据建议：需要后续独立评审时，优先保留真实工具输出的 size + SHA256；
  模型自我声明的字节数、哈希或文字描述不构成证据。

## [1.0.8] — 2026-09-29

### Fixed / 修复

- 两工具统一生命周期注册、注册后回查、有界重试和 info 级成功/失败/跳过日志；
  诊断增加按调用会话可见性检查的 `toolsRegistered`。Register and verify both tools
  on service activation/replacement; check existing agents and keep unload cleanup.
- profile 内按 session 保存仅计数摘要；跨进程/重载后的未闭合项标记 `reset`，
  不冒充 `resolved`，保留历史累计和执行中风险。Persist count-only reset receipts;
  unavailable/corrupt history is explicit. This does not restore old evidence.
- `resolve_failure` 提供带说明的已解释/无关通道，保留解释记录，不豁免变更/评审。
  Explain failures without requiring a byte-identical successful retry.
- 时效门按主题时间戳、至少两个有效主题词判断；失败/无关检索不清除缺口，记录有界。
  Per-topic freshness prevents unrelated searches from refreshing stale evidence.
- 修复 newest registry 回退顺序、UNKNOWN 风险桶、扩展 UNC 前缀；移除 TODO/FIXME
  未知声明规则和三个确无引用的导出，保留 `sessionStatesOf` 检查接口及 `riskRank`。
  Preserve existing artifact-version slash rejection and all 1.0.7 coverage rules.

### Limits / 边界

- 未直接修改或重启用户 desktop profile；首次桌面更新竞态仍需用户 E2E 确认。
  Isolated service lifecycle and process-restart tests are not a desktop restart test.
- 无 1.0.8 前摘要的旧会话只能显示历史未知；计数摘要不是完整审计日志。
  Historical reset obligations remain distinct from verified or explained items.

## [1.0.7] — 2026-09-28

### Fixed / 修复

- 修复带引号的逗号列表被合并成错误路径；多路径删除及检查逐目标入账。
  Parse quoted PowerShell comma lists without splitting commas inside filenames.
- 增加补录范围、随后独立观测的恢复流程，解决未解析风险、零路径变更及后续删除
  仍悬挂旧 present 条目的问题。Recover scope without treating declarations as proof;
  label superseded history and retain the caller-declared provenance.
- 父目录重列仍须目标 stat 确认才成为强 absence；支持固定标签加括号 Test-Path，
  不接受任意表达式或把普通 listing 一概升级。Targeted absence, not generic listing,
  closes deletion coverage; fixed-label existence wrappers are supported.
- 子会话将独立评审交回父会话；深度超限不再记为未解释任务失败。支持已完成的
  subagent_fork，以及确有 agent 启动的前台 workflow 评审；不把后台回执当 PASS。
  Defer child review without claiming PASS and recognize completed alternative reviews.
- 读取/列举返回的新信息计为进展；相同读取不虚增进展。风险中的删除、原地改写
  规则锚定命令开头，避免代码字符串误命中。Count novel observations and avoid matching
  editor/deletion words inside unrelated script arguments.

### Added / 新增

- `reliability_guard_reconcile`：declare_targets 与带证据的 resolve_unknown。
  Adds explicit, validated accounting repair; it does not modify user files.
- 未解析记录保留有界原命令；按 call_seq 查看脱敏详情。诊断区分检查通过、具体覆盖、
  声明范围和已被后续变更替代的历史。Retain bounded command provenance and expose scoped diagnostics.
- 英文 locale 标题英语优先，中文 locale 保持中文优先，二者都是双语。
  English-first English metadata and Chinese-first Chinese metadata.
- 按提示类型/实际摘要细分计数；修正每轮共三次 advisory 的注释。
  Split notice counters and align budget comments with behavior.

### Limits / 边界

- 补录范围来源于调用者声明；后续观测证明目标当前状态，不证明未声明路径从未受影响。
  Declared scope is not exhaustive side-effect proof. No live DeepSeek model test
  or general-purpose shell interpretation is claimed.

## [1.0.6] — 2026-09-28

### Fixed / 修复

- 修复同一 PowerShell 调用内 `$f='字面量'; Remove-Item -LiteralPath $f` 漏记删除，
  以及相同写法的 `Test-Path` 无法验证。Resolve straight-line literal variable bindings
  for both mutation observation and verification, without executing command text.
- 不再把“无法解析目标”表现成“没有待验证事项”。已识别修改命令的未知目标、
  条件作用域或快照失败单独记录为未解析风险，不伪造实际修改；普通验证和评审 PASS
  不能抵扣。Track unresolved mutation risks separately from observed changes.
- 命令失败也检查已取得的前后文件快照，保留失败前发生的删除。Observe partial
  filesystem effects even when the tool returns an error after changing files.
- 变量仅在单次调用内有效，不猜测分支、动态表达式和跨调用状态；不将 PowerShell
  赋值规则用于 Bash。Invalidate uncertain bindings instead of reusing stale values.

### Added / 新增

- 诊断详情展示有界、脱敏的变更事件、工具、调用顺序、目标状态和覆盖验证序号，
  并单独显示未解析风险。Expose auditable per-change coverage in current-turn memory.
- 增加字面量/变量对照的真实文件回归，逐步检查 `0 → 1 → 1 → 0`，以及错误、
  条件分支、变量重赋值、快照失败和完整循环。安装包测试也验证变量删除先产生缺口
  再关闭。The packed-plugin smoke test checks the actual pending-state transition.

### Limits / 边界

- 不是通用 Shell 解释器或全量文件变更监控。未知脚本、远程修改及未识别修改动词
  仍有边界。未解析风险本轮不自动消除；应报告未验证，不应盲目重复删除。
  This is not a universal mutation monitor. Unresolved scope remains explicit
  until turn end; bounded correction messages never certify it as verified.
- 未进行真实 DeepSeek 模型联机测试。No live DeepSeek model was used for validation.

## [1.0.5] — 2026-09-28

### Fixed / 修复

- 按路径、预期状态及起止顺序验证每项变更；无关读取、普通 listing、旧验证和
  评审 PASS 不再被用于抵扣目标缺口。Each mutation requires a fresh matching
  target/state check; unrelated reads and review verdicts do not substitute.
- 删除支持 `Test-Path False`、确认不存在的 `Get-Item` / native `read`、精确文件
  `glob` 和父目录重列加目标 stat。确认后 stale 更新为 absent；权限错误不算不存在。
  Confirmed absence closes deletion coverage and refreshes stale observations.
- 捕获裸相对路径删除及重定向写入；只快照可识别的修改目标，避免把 DSH 并发写日志
  归因于只读调用。Track literal mutation targets, including relative deletes and
  redirections, without blaming readers for concurrent runtime writes.
- 文件正文中的 FAIL / ERROR / code: 404 不再决定原生读取成败；继续解析诊断展示
  上限之后的失败信号。File contents are not machine status; bounded evidence
  display does not stop outcome parsing. Bare build/service success words and
  malformed artifact versions are not sufficient verification.
- 风险逐命令段判断，避免前置读取掩盖后续凭据写入，以及把引用文本当成修改；
  `-n` 不再被当成通用 dry-run。Classify command stages independently and distinguish
  quoted arguments and command-specific dry-run flags.
- `evidence.enabled:false` 时仍保留门禁必要记账；修复注册实例卸载的 root 别名归属，
  诊断可接受不完整配置。Keep minimal gate accounting when detailed evidence is off;
  preserve sibling registrations and tolerate partial diagnostics configuration.

### Added / 新增

- 诊断显示真实插件版本和待验证变更数。Diagnostics report the loaded package version
  separately from the diagnostics schema version, plus pending mutation count.
- 新增实际临时文件、PowerShell 和完整 AgentLoop 回归；安装包测试也覆盖删除闭环。
  Real-file and production-loop regressions include a packed-plugin deletion check.

### Limits / 边界

- 保留中英双语名称说明，以及 object-root Schema、单次上下文投递修复。
  Preserve bilingual metadata, object-root tool schemas and single context delivery.
- 本版修复所附反馈中可复现的核心链路，不声称未提供详细复现的全部 34 项已解决。
  This release addresses reproduced cases, not a blanket closure of all 34 reported
  items. Shell parsing remains bounded; see README for unsupported cases.

## [1.0.4] — 2026-09-28

### Fixed / 修复

- 将 `Get-FileHash`、`Get-Item`、`Get-Content` 的纯 shell 回读纳入验证记账，
  支持常见格式化管道，并排除失败、中断、无输出及混合读写。
- Recognize pure PowerShell file reads as `read-back`, with observable output
  and completion checks, including non-terminating PowerShell error detection.
- 合并验证强度定义，使判定、账本、诊断和门禁一致；成功回读及 lint 可覆盖
  基础修改验证缺口，diff 或显式弱验证不会再清除未验证标记。
- Share verification kinds and strength policy between verdicts and the ledger.
  Store verdict strength and require a check after the latest mutation; unknown,
  failed, weak, older, and same-call checks cannot clear the pending flag.
- Add full AgentLoop tests with real temporary-file writes and PowerShell
  hash/metadata/content reads, plus native read parity and failure regressions.

## [1.0.3] — 2026-09-28

### Fixed / 修复

- 修复审查、完成门禁和无进展提示的重复投递导致的
  `message "reliability-guard-..." is already pending` / `UNKNOWN` 本轮失败。
  统一通过 `additionalContexts` 交由 DSH 入队，每条提示只投递一次。
- Deliver correction notices only through `additionalContexts`, letting the
  DSH tool scheduler own inbox delivery. Remove the duplicate `agent.inject`
  path that aborted turns for review, completion-gate, and stall notices.
- Add full production AgentLoop regressions covering model tool calls,
  scheduler commit, single context delivery, subsequent model requests, and
  successful turn completion. Registry-only tests now assert that delivery is
  deferred to the driver.

## [1.0.2] — 2026-09-28

### Changed

- Standardize the user-facing bilingual plugin name as
  **可靠性守卫 / Reliability Guard** in both locales, package metadata, and
  documentation.
- Keep `dsh-reliability-guard`, `reliability-guard`, and `reliability_guard`
  unchanged as stable package, Cordis, and tool identifiers.

## [1.0.1] — 2026-09-28

### Fixed

- Register `reliability_guard` through the official `defineTool` helper so its
  model-facing parameter schema always has an explicit JSON Schema object root.
  This prevents providers from rejecting the function with `type: null`.
- Add direct and packed-profile regression checks for
  `parameters.type === "object"` and the `detail` boolean property.
- Make the full test command portable to current Windows Node releases by
  targeting test files explicitly instead of passing the test directory.

### Changed

- Add official DSH locale resources with bilingual Chinese/English display
  names and descriptions, and ship them in the package and tarball.
- Make the diagnostic tool description and its `detail` parameter bilingual.

## [1.0.0] — 2026-01-01

First release built on the public DSH 0.1.7-rc.2 seams. This is a ground-up
implementation, not a revision of the v0.1.0 MVP: the earlier version's prompt
rules were kept and compressed, and every other capability was rebuilt against
the seams that were verified in the shipped source.

### Added

- **Prompt policy** — one static, ordered system-prompt section
  (`reliability-guard:policy`, order 8000) covering evidence before conclusion,
  observe before change, fact/inference/unknown separation, current state over
  stale memory, root-cause diagnosis, minimal patch, platform awareness, safe
  mutation, verify after change, the completion gate, context hygiene, freshness
  and truthful status reporting. `compact` (default) and `full` variants; the
  section is `interpolate: false`, so it can never break prompt assembly.
- **Evidence ledger** — per-session, never shared. Records file identity and
  version, tool-result digests, verifications, unexplained failures, declared
  unknowns and overturned conclusions. A later observation of the same target
  invalidates the earlier one and records why. Storage is keyed by the live
  `Session` object and released on `session/disposed` and on plugin disposal.
- **Tool loop guard** — five independent detectors on `tools/pre-execute`:
  consecutive byte-identical calls, argument-normalized semantic repeats
  (whitespace/quoting/comments), pure no-op shell runs (every statement and
  pipeline stage effect-free), blind retries (a repeated failure with no state
  change in between), and no-progress stalls. Each block carries an auditable
  machine code and one actionable instruction.
- **Mutation risk classifier** — deterministic `LOW`/`MEDIUM`/`HIGH`/`CRITICAL`
  classification with `action`, `scope` and a `mutation` certainty, covering
  deletes, overwrites, `git reset --hard`/`clean`, database migrations and
  destructive SQL, dependency installs/upgrades, machine-level configuration,
  credentials, publishing/deploying, permission broadening and disk-level
  destruction. Reuses the official sandbox and approval seams instead of adding
  a second permission system.
- **Verification planner** — parses exit codes, test summaries (`N passed`,
  `N failed`, `Tests:`), clean-check and problem counts, build error counts and
  artifact versions; a success word alone is never accepted, and any reported
  failure disqualifies the check.
- **Completion gate** — blocks a turn while a mutation has no covering
  verification, a failure is unexplained, or a reviewer returned FAIL; informs
  once per gap about open unknowns and stale observations. Bounded by
  `completionGate.maxInjectionsPerTurn`, and it reports the remaining gap
  explicitly after the budget is spent instead of looping.
- **Independent reviewer** — requests a fresh-context review for HIGH/CRITICAL
  changes or multi-file turns through the shipped `subagent` tool. The request
  carries the requirement, current state, diff hint and verification results,
  and explicitly excludes the executor's reasoning. `VERDICT: PASS`/`FAIL`,
  with an unparseable report counted as FAIL and `review.maxRounds` bounding the
  round trip.
- **Freshness gate** — detects externally controlled claims (version, release,
  compatibility, official API, deprecation, registry, changelog, advisory) in
  assistant messages and requires a retrieval inside `freshnessGate.maxAgeMinutes`
  or an explicit `not freshly verified` label.
- **Windows-first checks** — non-ASCII text without an encoding control,
  unquoted paths with spaces, fresh-process-only state (`$env:` assignments,
  bare `cd`, aliases, module imports), `cmd /c` re-parsing, `&&` chaining, and
  CRLF/LF mismatches on literal edits. Advisory only, and a no-op on Linux and
  macOS.
- **Diagnostics** — the read-only `reliability_guard` tool reports policy,
  counters, session state, evidence summary, stale observations, open failures,
  declared unknowns and review state. Credential-shaped content is redacted
  unconditionally.
- **Bundle packaging** — `dsh.bundle.patch`, prebuilt ESM, no consumer build
  step, installable from a tarball, a directory, npm or Git.

### Fixed after adversarial review

Every item below was reproduced against the real pipeline before it was fixed,
and the reviewer's own probe scripts were re-run afterwards to confirm the fix.

- **Credential leak (blocker).** `redactSecrets` did not redact credentials
  embedded in a URL, so a command or error text containing
  `scheme://user:password@host` reached the diagnostics report and the injected
  correction. URL userinfo is now redacted as a component, ahead of every
  token-shaped rule.
- **Innocent commands denied (blocker).** The credential rule matched the bare
  words `password`, `secret` and `api_key`, so `rg "api_key" src/` and
  `npm test --grep "password reset"` were classified CRITICAL and refused. The
  rule is now three precise ones: a credential store on the left of a
  redirection, a key-generation or key-writing command, and an explicit rotation
  verb. A read of `.env.example` is LOW again.
- **Wrong assumption about the registry (blocker).** The guard appended its own
  prose to the tool result on the belief that the registry drops additional
  contexts from a bare accept decision. It does not
  (`dsh-tools/lib/index.js:3505,3516`), so the tool result the model and the
  session log read is now left exactly as the tool produced it.
- **Freshness gate false positives (major).** A bare topic marker was enough, so
  7 of 10 ordinary engineering messages were flagged as external-fact claims.
  Detection now requires both a topic marker and a claim about the external
  present (a currency word, a version number beside an external artifact, or an
  external release artifact), excludes local-scope phrasing, and never blocks: a
  freshness gap is advisory. Ordinary prose now trips 0 of 10.
- **Cross-turn and self-inflicted blocking (major).** A mutation from an earlier
  turn blocked every later read-only turn, and a call the guard itself refused
  was recorded as an unexplained failure that survived until the refused command
  was re-run. The mutation gap is now scoped to the current turn by call
  sequence, the guard's own refusals are not recorded as failures, and only a
  high-risk call that is actually allowed requires a review.
- **Shell mutations were invisible (major).** A `Set-Content`, `Out-File`,
  `sed -i`, or lockfile rewrite left no ledger record, so the completion gate's
  "mutation without verification" rule never fired for the most likely real
  mutation path. The guard now snapshots the `ctx.fs` version of every path a
  call names, before and after it, and records a mutation when the version
  changed.
- **Dead configuration made live.** The CRLF/LF literal-edit check now reads the
  target's text through the session's own filesystem provider, the
  destructive-without-undo check is part of the Windows advisory set, and
  `risk.workspaceOnlyWhenUnscoped` now decides the unscoped-delete scope.
- **Windows advisories were invisible.** The findings are counted in
  `windowsWarnings` and logged with their code at debug level, so an advisory
  note is auditable instead of only held in memory.
- **`repeatWindow` is now applied** to the retained call history.

### Fixed after the second adversarial review

The second review verified the fixes above and found a fresh blocker plus three
class-level gaps, which are now fixed and covered by
[`test/18-review-regressions.test.js`](test/18-review-regressions.test.js).

- **Every `edit` call failed (blocker).** The new line-ending check called
  `evaluateLineEndings`, which the module never imported, so with
  `windows.enabled` at its default every edit raised
  `evaluateLineEndings is not defined` before the tool body ran. The import is
  restored and a real `edit` call is now driven end to end.
- **URL redaction was still incomplete (blocker).** The password pattern stopped
  at the first `@`, so `postgres://admin:P@ssw0rd!@host` leaked `ssw0rd!`. The
  password group is now greedy and anchored on the last plausible `@host`, and
  the token form, `curl -u user:pass`, `redis://:pass@host` and
  `//host/:_authToken=…` all redact as well. A public URL that merely contains an
  `@` is no longer mangled.
- **Innocent commands were still denied (major).** The credential rules matched
  the rotation verb inside a search argument and the `.env` suffix inside a read
  target, so `rg "how to rotate the password"` and
  `Get-Content -Path .env.example` were CRITICAL. The rotation verb must now
  start a command, a credential store must be the target of a write verb or a
  redirection, and `ssh-keygen` is identified positively by a generation flag —
  so `-l`, `-y`, `-F` and `-p` forms stay read-only. Innocent cases: 0/10
  misclassified; real credential writes: 6/6 still CRITICAL.
- **A refused high-risk call still demanded a review (major).** `highRiskCalls`
  was incremented before the plan check, so a denial forced an independent review
  of work that never happened. It is now incremented only when the call is
  allowed, which is what the comment and this changelog already claimed.
- **Relative write targets were invisible (major).** `extractShellPaths` only saw
  absolute and `./`-prefixed paths, so `Set-Content -Path out.txt` recorded no
  mutation. A file-writing verb followed by a relative path is now extracted,
  while a read (`Get-Content -Path out.txt`) is not.
- **A genuine failure blocked every later turn (major).** `unexplainedFailures`
  persisted for the session, so one transient failure stopped unrelated work
  until the identical command happened to succeed. The record stays in the ledger
  and in diagnostics; the gate now demands an explanation only in the turn the
  failure happened in.
- **Relative paths were classified as machine-level (major).** A relative path
  was treated as outside the workspace, making `rm -rf ./build` and every
  relative write target CRITICAL. A relative path belongs to the session's
  working directory whatever that directory is, so it is now workspace-scoped; an
  absolute path outside both the workspace and the platform temp root is still
  CRITICAL.

### Seams used

`tools/pre-execute`, `tools/post-execute`, `tools/result`, `ctx.systemPrompt.section`,
`ctx.on('session/event')`, `ctx.on('session/disposed')`, `ctx.on('agent/created')`,
`ctx.on('fs/observed')`, `agent.inject` (next-step inbox), `ctx.fs.resolve`/`ctx.fs.stat`
versions, `ctx.sandboxPolicy.resolve` (read-only), the `approval` service via a
`{kind:'ask'}` verdict, and the `subagent` tool. No core file is modified and no
private field is touched.

### Known limitations

- The review handoff relies on the injected request reaching the shipped
  `subagent` tool; the verdict is read from that tool's result. A host that
  composes no subagent tool cannot satisfy the review gate, which then reports
  the missing review instead of passing.
- A shell mutation is recognized by observation, not by name: the guard reads
  the `ctx.fs` version of every path a command names, before and after the call,
  and records a mutation when the version changed. A command that mutates
  something the guard cannot name — an in-process API call, a remote resource, a
  file whose path is computed at runtime — is therefore not recorded as a
  mutation and cannot be demanded back as unverified.
- Staleness uses the official `FsVersion` (device, inode, size, mtime, ctime) as
  its primary signal, which is exact for every ordinary edit. The stored content
  fingerprint is only available for the tool families whose arguments carry the
  new bytes; an external same-size/same-mtime in-place rewrite of a path the
  guard never read is not detected.
- The freshness detector is lexical and therefore deliberately narrow: a clause
  must carry a topic marker *and* read like a claim about the external present
  (a currency word, a version number next to an external artifact, or a release
  artifact in an external scope), and local-scope phrasing is excluded. It can
  still be wrong in both directions, which is why a freshness gap is always
  **advisory** and never blocks a turn.
- The Windows environment checks are lexical, so they can produce false
  positives; they are therefore advisory and never block.
- The official `dsh-session-checkpoint-policy` provides durability flush, not
  filesystem rollback, so the guard states a required rollback plan rather than
  performing or verifying a restore.
- `tools/post-execute` listeners receive the tool result and `next()` resolves to
  the downstream decision. Any future listener must preserve that distinction:
  returning a result-shaped object makes the registry read it as a `content` +
  `value` replacement, which it rejects.

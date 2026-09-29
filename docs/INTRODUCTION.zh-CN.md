# DSH Reliability Guard：能力、边界与 Token 成本说明（1.1.8 版）

> 本文面向 **1.1.8**，结论来自真实 DSH Desktop 会话的**账本原文**与**宿主逐请求用量计量**（token / 缓存命中率 / 结算花费）。涉及版本行为处均标注版本与证据来源。

## 一、定位

**它不增加智能，它增加"问责机制"。**

把"我说我验证过了"变成**账本上可核对的、目标匹配的观测**，并在证据不足时**拦住回合结束**。

它是一层包在 Agent 循环外面的：

**确定性门禁 + 审计账本**

补充一句 1.1.8 的事实：**核心语义（risk / ledger / receipt / review / completion gate）自 1.1.5 起未改变**；1.1.6 只调默认值，1.1.7 只改元数据，1.1.8 只做声明与修复通道加固。这也是它"越更新越稳"的原因。

---

## 二、版本沿革与稳定性（1.1.4 → 1.1.8）

| 版本 | 性质 | 对稳定性的影响 |
| --- | --- | --- |
| 1.1.4 | 真因修复：DSH 的 `stdout` / `stderr` 是结构化对象 `{ text, truncated, spillPath? }`，旧代码 `String(stderr)` 得到 `"[object Object]"` ⇒ `shellOK=false`，导致**所有 Shell 核查被拒** | 修对了，但 `peerDependencies` 精确写死 `0.1.7-rc.2` ⇒ 宿主升到 `0.2.0-rc.1` 时被 DSH 兼容性门禁**静默拒绝加载**（实测：策略段与工具全无、无任何报错） |
| 1.1.5 | **仅**放宽 peer 为 `0.1.7-rc.2 \|\| 0.2.0-rc.1`；运行时代码与 1.1.4 相同 | 能加载，但覆盖窗口仍窄；删除闭环在本版首次实测通过 |
| 1.1.6 | **仅改默认值**（低开销） | 语义不变，开销骤降（见第七节） |
| 1.1.7 | **仅元数据**：移除全部 `@deepseek-ai/dsh*` host peer 声明（`peerDependencies` 只剩 `cordis` / `schemastery`） | 拆掉了"静默拒载"这台机器；此后宿主升 RC 不会再因版本声明被拒 |
| **1.1.8** | 声明识别加固（容忍 `**未验证：X**`）、`resolve_unknown` 时序写进工具描述、门禁文案修正、README 补充"与变更同批次启动的读取不能覆盖该变更" | 改动面小、可回滚；**本文档即以此版验收** |

**结论**：1.1.8 是这条线上最稳的一版——1.1.4 之后运行时功能性改动只有两次（1.1.6 默认值、1.1.8 加固），且唯一会造成"插件凭空消失"的机制已被移除。

---

## 三、实测确认的能力（1.1.8）

> 以下能力均有本会话账本证据支持。

| 能力 | 实测表现 |
| --- | --- |
| **① 事前风险分级与拦截** | 每次工具调用前分类 `LOW / MEDIUM / HIGH / CRITICAL`。我多次被拒：`refused this HIGH-risk call: deletes files … Missing before this can run: rollback`；补齐 `SCOPE / ROLLBACK / VERIFICATION` 说明后放行。 |
| **② 变更账本（Mutation Ledger）** | 逐目标记录 `-> present / absent`，并**在执行前抓真实前态**：`mutation #21: …\.ab-guarded.tmp -> absent; pre-state observed: present type=file size=45`；被后续变更取代时标记 `superseded by #N`。 |
| **③ 多目标逐条入账** | 一次逗号列表删除 3 个文件 → 三条记录分别带各自前态（52 / 1464 / 1338 字节）。 |
| **④ 覆盖判定（Coverage）** | 只有"**目标匹配 + 类型够强 + 晚于变更**"的核查才算数。写入/读取要求 `read-back`（原生 `read` 即带目标）；**删除必须是 `absence`**（`Test-Path → False`、`Get-Item` 缺失，或父目录重列 + 精确 stat）。实测：`check #22: absence PASS; strong=true; targets=[{…, "expected":"absent", "source":"shell-false"}]`，对应 mutation `covering verification: 22`。**注意**：核查必须是**独立且晚于变更的调用**；与变更同批次并行启动的读取不算。 |
| **⑤ 完成门禁（Completion Gate）** | 回合结束前若仍存在"无覆盖的变更 / 未解释的失败 / 未决未知项 / 未评审的高风险变更"，就会**向对话注入一条指令**（默认每回合最多 1 条、不附带整份证据摘要），明确列出缺口与补救办法。1.1.8 起文案不再写 "has not run"，而是"尚无 PASS/FAIL verdict；本回合已发起的评审可能在回合末落账"。 |
| **⑥ 强制独立评审** | 高风险变更（尤其删除）要求拉起 fresh-context 评审员，必须给出 `VERDICT: PASS\|FAIL`；FAIL 作为"**未解决的反对意见**"写进结论；默认 `maxRounds=1`。本会话累计 **7 次 PASS**（另有早期多轮 FAIL），其中一次评审员**独立纠正了作者的字节数误记**，另一次自行解压会话记录、重建被删内容并给出 SHA256。 |
| **⑦ 审计读取工具** | `reliability_guard(detail:true)` 查看：`pending mutation verification`、逐条 mutation/check（含 `targets` 与 `source`）、`stale observations`、`unexplained failures`、`unknowns`、`counters`、跨重启 `history`；支持 `call_seq` 回看历史调用，**含脱敏后的原命令**。1.1.3 曾有临时 shell 查询运行时追踪，现已默认关闭（`diagnostics.runtimeShellTrace=false`）。 |
| **⑧ 记账修复通道** | `reliability_guard_reconcile`：`declare_targets`（补录范围，且明确"**声明不是证据**"，之后必须独立回查）、`resolve_unknown`（顺序必须是"**声明 → 更新的成功核查 → resolve**"，`evidence_seq` 必须晚于声明，否则被拒）、`resolve_failure`（解释**非读取类**任务失败，不代表重试成功，且不豁免门禁）。1.1.8 起不确定性声明可写成 Markdown 形式，例如 `**未验证：X**` 也会被记账（尾随 `**` 自动剥离）。 |
| **⑨ 循环 / 停滞防护** | 相同命令重复、语义重复、盲重试、无进展（stall）、no-op shell 都会被识别；**只有新信息才算进展**，重复读取不算。**已知粗糙处**：它对"只读调查"也不敏感——我连续 6 次只读检索（读配置/读 schema）就被警告"6 calls 无进展"。 |
| **⑩ 新鲜度门（Freshness Gate）** | 对"外部事实"类声明（版本、发布、可用性等）要求会话内做过相关检索；1.1.2 起按**主题**记录检索时间并要求主题词重合，无关检索不能算。**此条目前只验证到计数器与代码结构，语义未做端到端测试**。 |
| **⑪ 跨重启审计留痕** | 把**计数收据**写进 profile（`history.storage: profile`、`resetCount` 增长），并明确记录 **`reset is NOT resolved / 重置不等于解决`**。 |
| **⑫ 策略段注入** | 通过 `prompt.js` 的 `reliability-guard:policy` 注入**前缀稳定**的 system prompt 段。1.1.6 起默认 `minimal`（**804 字符 / 104 words**）；`compact` 仍可选（2769 字符 / 443 words，12 条详细规则）；`full` 再附 verification matrix。前缀稳定是为了吃满宿主的前缀缓存。 |

---

## 四、它不做什么（边界）

既来自官方 Limits，也来自实测：

- 不读取模型内部推理，只看**可观测行为**。
- **不修改你的文件**；`reconcile` 只改账本。
- 不做通用 Shell 解释，采用 **fail-closed**：近似前导、复杂表达式、多目标模糊错误一律**不绑定目标**，宁可漏记也不乱记。
- 不把"声明 / 自述 / 评审 PASS"当证据：`Review PASS does not replace target observation`。
- 不能证明"未声明路径从未被影响"。
- 重启后内存账本清零，只保留**计数收据**；旧未闭合项以 `reset` 计数提示，而不是被视为已解决。
- **（A/B 实测新发现）脚本盲区**：它只解析**工具调用自身的命令文本**。把受管辖的操作（删除/原地改写）**包进脚本调用**时，账本、门禁、评审**全部不触发**：

  ```text
  shell-query #28  command="& run-acceptance.ps1 -Phase delete"  -> verificationQueries=[]
  check       #29  existence FAIL; targets=[]      （没有可覆盖的目标，自然不入账）
  ```

  这不是恶意才会发生——为了"一次跑完"写个脚本非常自然。**建议**：README/策略明示"不要用脚本包装受门禁管辖的操作"，或由守卫对脚本内容做静态扫描（`Remove-Item` / `Set-Content` / `git push` / 包管理器安装等）。

---

## 五、它实际帮到了什么

这次开发把插件从 `1.0.5` 一路逼到 `1.1.8`，依赖其账本原文定位并复现的问题包括：

- **静默删除不入账**（1.0.5）
- **逗号列表零目标**（1.0.6）
- **结构化 `stderr` 被 `String()` 转成 `[object Object]`**，导致所有 Shell 核查被拒（1.1.4 修复）
- Shell 查询目标提取异常 / **删除验证无法闭环**（1.0.8–1.1.3 逐层定位，1.1.5 首次闭环）
- 评审与账本状态不一致（`review: required` 与账本不符）
- 默认上下文开销过高 ⇒ 促成 1.1.6 的 `minimal` policy、单轮 completion 注入、默认单轮 reviewer
- DSH prerelease 版本号变化导致兼容门禁反复拒绝 ⇒ 促成 1.1.7 的"不钉死宿主版本、真实 API 变化再适配"策略
- Markdown 加粗导致不确定性声明漏记、`resolve_unknown` 时序说明不明 ⇒ 促成 1.1.8 的声明/修复通道加固

反过来，它也沉淀出一套可复用的验收基础设施：

```text
.scratch\acceptance\CHECKLIST.md
.scratch\acceptance\run-acceptance.ps1
```

即：它不仅"拦错误"，还逐步变成一套**可靠性验收基础设施**。

---

## 六、适合谁

> **需要让 Agent 执行危险操作、不可逆操作，或需要审计的场景。**

例如：删除文件、修改配置、部署、数据库迁移、批量修改、高风险自动化。

它用**额外的工具调用、验证往返和独立评审**换取：

- 每一步都有目标匹配的观测
- 变更前后都有账本记录
- 结论不能只靠 Agent 自述
- 证据不足时禁止宣布完成

代价同样明显：**更慢、更啰嗦、Token 消耗更高。**

### A/B 实测：用 vs 不用（同一个删除任务，两种路径）

| 观察点 | A 组（守卫可见） | B 组（守卫不可见 ≈ 没装插件） |
| --- | --- | --- |
| 建探针 | `mutation #20 -> present; pre-state observed: absent` | **无任何记录** |
| 删除 | `mutation #21 -> absent; pre-state observed: present type=file size=45` | **无任何记录** |
| 守卫注入 | **2 条**（建后要求核查；删后判 CRITICAL 要求独立评审） | **0 条** |
| 强制核查 | 必须做裸 `Test-Path`，否则 `pending` 不归零 | 无要求 |
| 独立评审 | **必须**（1 个全新评审子会话） | 无 |
| 可追溯性 | `check #22: absence PASS; strong=true; targets=[…, expected:"absent"]` + `covering verification: 22` | 事后**查不到**做过什么 |
| 我的额外调用 | 4 次 + 1 个评审会话 | 1 次（脚本本身） |

**一句话**：插件不改变"我能不能做"，它改变的是**我能不能"不被检查地说做完了"**。

---

## 七、是否会增加 Token 消耗（1.1.8 默认）

**会。** 但成本不来自插件自己调用模型，而来自额外验证、门禁上下文与独立评审。**1.1.6 起默认配置已专门压缩了常驻与纠错开销，因此 1.1.5 时期的高开销观测不能直接当成 1.1.8 的默认成本。**

### 成本来源与 1.1.8 默认行为

| # | 成本 | 1.1.8 默认行为 / 实测锚点 | 性质 |
| ---: | --- | --- | --- |
| **1** | **常驻策略段** | 默认 `prompt.verbosity=minimal`：**804 字符 / 104 words**（`compact` 2769 / 443 可选）。前缀稳定 ⇒ 可被宿主前缀缓存整段命中 | 固定，每轮都付，但默认已显著压缩 |
| **2** | **门禁 / 通知注入** | 默认 `completionGate.maxInjectionsPerTurn=1`、`evidence.injectDigest=false`、`evidence.maxDigestChars=1600`；只注入当前缺口所需的短上下文，不附整份证据摘要 | 有缺口时发生，且有界 |
| **3** | **结构性额外往返** | mutation 与 covering verification 必须是**独立且后续**的调用；读账本、补录、解释也会增加调用次数 | 每个高要求动作都可能付 |
| **4** | **独立评审** | 高风险变更才触发（`review.highRiskOnly=true`），默认 `maxRounds=1`；这是**最大的可变成本** | 高风险才付 |
| **5** | **附带摩擦** | 被拒调用需补齐 `SCOPE / ROLLBACK / VERIFICATION`；循环/停滞警告可能迫使改路线 | 视情况 |

### 实测计量（本会话 A/B，宿主逐请求记录）

| | **A 组（守卫可见）** | **B 组（守卫不可见 ≈ 无守卫）** |
| --- | --- | --- |
| 请求数 | 4 | 5 |
| prompt 合计 | **2,058,672** | **2,607,074** |
| ├ 命中缓存 | 2,053,120 | 2,604,800 |
| └ 未命中输入 | **5,552** | **2,274** |
| output | **3,871** | **4,316** |
| **缓存命中率** | **99.73%** | **99.91%** |

**A 组独有——强制评审子会话（独立计量）**：prompt **1,192,901**（命中 1,155,712 + 未命中 **37,189**）、output **45,536**、命中率 **96.88%**、**实测花费 ¥0.242447**。

**主会话累计**：未命中输入 5,702,426 + 命中 128,931,584（**命中率 95.76%**）+ 输出 705,599；`cacheWriteTokens = 0`（该提供商不报告缓存写入计费）。

### 怎么读这些数字

1. **命中率几乎不受"有没有守卫"影响**（99.73% vs 99.91%）：两个请求共享同一个 ~51–52 万 token 的大前缀，而 DSH 的前缀缓存几乎把它全缓存了。**插件的策略段设计成 prefix-stable，所以在缓存下它的文本成本接近于零**——这是 1.1.6 降开销的直接收益。
2. **守卫真正的成本不在"文本"，而在"多出的动作"**：强制独立评审（本次 ¥0.24 量级）与额外往返；未命中输入的增加只有千级 token。
3. 上表是同会话内两个时间窗的求和，**不是隔离的受控实验**（B 组继承了 A 组之后的上下文）；适合看结构与量级，不宜把两列直接相减当作"插件净成本"。
4. 参照：当日累计 ¥9.56（余额 ¥16.11）。**一次强制评审 ¥0.24** 在这种会话里属于零头，换来的是独立第二双眼睛的核对。

### 还能怎么继续降（1.1.8 已有的旋钮）

- 只读/文档类任务：`freshnessGate.enabled:false`、`windows.enabled:false`、`completionGate.maxInjectionsPerTurn:0`（注意：这会让"未覆盖的变更"静默，谨慎）、`evidence.maxRecords` 调小。
- 想让写类免评审：保持 `review.highRiskOnly:true`，并把 `review.multiFileThreshold`（默认 3）调大。
- 想让策略段更短：`prompt.verbosity` 已是 `minimal`；再短只能关闭策略段（不推荐）。
- 想少收循环警告：`exactRepeats` / `semanticRepeats` / `noopShell` / `blindRetries` / `stall` 可分别关闭（会丢掉真停滞检测）。
- 排障才需要：`diagnostics.runtimeShellTrace`、`diagnostics.includeSensitiveContent`（默认关闭，且**永远不要**在共享日志里打开）。

**建议的下一步（1.1.9，opt-in）**：把"按操作类型分级"做成显式开关（默认**与 1.1.8 行为等价**），例如 `read / write / mutate / destructive / publish` 五档，仅 `destructive` 与 `publish` 保留评审与收据；同时补上**脚本静态扫描**以堵住第四节的盲区。这样"读类几乎零开销、删改部署照旧严格"可以并存，而不动摇 1.1.8 的稳定性。

---

## 八、一句话总结

**1.1.8 不增加智能，它把"我说我验证过了"变成可核对的账本观测，并在证据不足时拦住完成。** 它会增加 Token 消耗，但 1.1.6 起默认已把常驻与纠错上下文压到很低（策略段 804 字符、每回合最多 1 次注入、默认单轮评审）；**实测大头只有一处——高风险操作的独立评审（¥0.24 量级/次）**。对"删了就回不来"的操作，这个价钱值得；对写文档、改文案，它就是收税。

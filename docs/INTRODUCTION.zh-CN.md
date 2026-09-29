# DSH Reliability Guard：能力、边界与 Token 成本说明

## 一、定位

**它不增加智能，它增加“问责机制”。**

把“我说我验证过了”变成**账本上可核对的、目标匹配的观测**，并在证据不足时**拦住回合结束**。

它是一层包在 Agent 循环外面的：

**确定性门禁 + 审计账本**

---

## 二、实测确认的能力

> 以下能力均有本会话中的账本证据支持。

| 能力 | 实测表现 |
| --- | --- |
| **① 事前风险分级与拦截** | 每次工具调用前分类 `LOW / MEDIUM / HIGH / CRITICAL`。我多次被拒：`refused this HIGH-risk call: deletes files … Missing before this can run: rollback`；补齐 `SCOPE / ROLLBACK / VERIFICATION` 说明后放行。 |
| **② 变更账本（Mutation Ledger）** | 逐目标记录 `-> present / absent`，并**在执行前抓真实前态**：`mutation #5: …\.accept-F.tmp -> absent; pre-state observed: present type=file size=54`；被后续变更取代时标记 `superseded by #N`。 |
| **③ 多目标逐条入账** | 一次逗号列表删除 3 个文件 → 三条记录分别带有各自前态（52 / 1464 / 1338 字节）。 |
| **④ 覆盖判定（Coverage）** | 只有“**目标匹配 + 类型够强 + 晚于变更**”的核查才算数。写入/读取要求 `read-back`（原生 `read` 即带目标）；**删除必须是 `absence`**（`Test-Path → False`、`Get-Item` 缺失，或父目录重列 + 精确 stat）。实测通过：`check #6: absence PASS; strong=true; targets=[{…, "expected":"absent", "source":"shell-false"}]`。 |
| **⑤ 完成门禁（Completion Gate）** | 回合结束前如果仍存在“无覆盖的变更 / 未解释的失败 / 未决未知项 / 未评审的高风险变更”，就会**向对话注入一条指令**，而不是静默失败，并明确列出缺口及具体补救办法。 |
| **⑥ 强制独立评审** | 高风险变更，尤其是删除，要求拉起一个 fresh-context 评审员，并必须给出 `VERDICT: PASS\|FAIL`。FAIL 会作为“**未解决的反对意见**”写进结论；预算 `maxRounds` 用尽后封顶。本会话共 4 次 PASS，其中一次评审员独立解压会话记录、重建被删内容并给出 SHA256。 |
| **⑦ 审计读取工具** | `reliability_guard(detail:true)` 可查看：`pending mutation verification`、逐条 mutation/check（含 `targets` 与 `source`）、`stale observations`、`unexplained failures`、`unknowns`、`counters`、跨重启 `history`。还支持通过 `call_seq` 回看历史调用，**包括脱敏后的原命令**。 |
| **⑧ 记账修复通道** | `reliability_guard_reconcile` 支持：`declare_targets`（补录范围，但明确“**声明不是证据**”，之后必须独立回查）、`resolve_unknown`（带证据解释未知项）、`resolve_failure`（解释失败，**不代表重试成功**，且不豁免门禁）。三个能力均已实测。 |
| **⑨ 循环 / 停滞防护** | 相同命令重复、语义重复、盲重试、无进展（stall）、no-op shell 都会被识别；**只有新信息才算进展**，重复读取不算。 |
| **⑩ 新鲜度门（Freshness Gate）** | 对“外部事实”类声明，例如版本、发布、可用性，要求会话内做过相关检索。1.1.2 起按**主题**记录检索时间，并要求主题词重合，无关检索不能算。此条目前只验证到计数器与代码结构，语义未做端到端测试。 |
| **⑪ 跨重启审计留痕** | 将**计数收据**写入 profile（`history.storage: profile`、`resetCount` 增长），并明确记录：**`reset is NOT resolved / 重置不等于解决`**。 |
| **⑫ 策略段注入** | 将 12 条 `Operating reliability rules` 作为 system prompt 段落注入，即 `prompt.js` 中的 `reliability-guard:policy`。因此，“策略段是否存在”也成为判断插件是否激活的第一个信号。 |

---

## 三、它不做什么

这些边界既来自官方 Limits，也来自实际测试。

- 不读取模型内部推理，只看**可观测行为**。
- **不修改你的文件**；`reconcile` 只修改账本。
- 不做通用 Shell 解释，而是采用 **fail-closed** 策略：近似前导、复杂表达式、多目标模糊错误一律**不绑定目标**，宁可漏记，也不乱记。
- 不把“声明 / 自述 / 评审 PASS”当作证据：`Review PASS does not replace target observation`。
- 不能证明“未声明路径从未被影响”。
- 重启后内存账本会清零，只保留**计数收据**。旧的未闭合项会以 `reset` 计数形式提示，而不是被视为已经解决。

---

## 四、它实际帮到了什么

这次开发过程中，它把我们自己的插件从 `1.0.5` 一路逼到了 `1.1.5`。

实际暴露并定位过的问题包括：

- **静默删除不入账**
- **逗号列表零目标**
- 结构化 `stderr` 被 `String()` 转换成 `[object Object]`，导致所有 Shell 核查被拒
- Shell 查询目标提取异常
- 删除验证无法正常闭环
- 评审与账本状态不一致

这些问题都依赖 Reliability Guard 自己输出的账本原文完成定位和复现。

反过来，它也逐步形成了一套可复用的验收流程：

```text
.scratch\acceptance\CHECKLIST.md
.scratch\acceptance\run-acceptance.ps1
```

也就是说，它不仅是在“拦错误”，还逐渐变成了一套**可靠性验收基础设施**。

---

## 五、适合谁

它适合：

> **需要让 Agent 执行危险操作、不可逆操作，或者需要审计的场景。**

例如：

- 删除文件
- 修改配置
- 部署
- 数据库迁移
- 批量修改
- 高风险自动化操作

它通过**额外的工具调用、验证往返和独立评审**，换取：

- 每一步都有目标匹配的观测
- 变更前后都有账本记录
- 结论不能仅靠 Agent 自述
- 证据不足时禁止直接宣布完成

代价也很明显：

**更慢、更啰嗦、Token 消耗更高。**

如果任务只是写文档、改文案，它可能会显得过度严格。

但一旦涉及：

> **“删了就回不来”**

这类操作，它的价值就会明显提升。

---

## 六、是否会增加 Token 消耗

**会。**

不过 Token 成本并不是来自插件自己调用模型，而主要来自：

1. 常驻策略段注入
2. 门禁与通知文本
3. 为满足验证要求产生的额外调用
4. 高风险操作触发的独立评审

### 成本来源与实测锚点

| # | 成本 | 实测 / 估算 | 性质 |
| ---: | --- | --- | --- |
| **1** | **常驻策略段** | `prompt.js` 整文件约 6.3 KB，其中 12 条规则作为 system prompt 段落**每次请求都会存在**。估算约 **1.5–2 KB ≈ 400–600 tokens / 请求**。 | 固定、每轮都付 |
| **2** | **门禁 / 通知注入** | 本会话 38 次调用中：`gateInjections=7`、`noticesInjected=11`、`digestsInjected=11`、`evidenceDigestsInjected=8`。每条都可能携带 `Evidence digest` 块，估算约 **150–500 tokens / 条**；本会话量级约 **2–5k tokens**。 | 有缺口时发生 |
| **3** | **结构性额外往返** | 变更与核查**必须分开**，还可能需要读账本、补录、解释。因此每次变更通常**至少多 2–3 次调用**。本次删除演示：建 → 删 → 裸查 → 读账本，共约 4–5 次调用；如果带评审则约 6–8 次。 | 每个动作都付 |
| **4** | **独立评审** | 每次评审都会启动**一个全新上下文的 Agent**，自行读文件、运行命令、编写约 500–1500 词报告。其自身工作通常可能消耗**数万 tokens**，而回传到主上下文的报告又约为 **1–3k tokens**。本会话有 4 次 PASS，早期还经历过多轮 FAIL。 | 高风险变更才付 |
| **5** | **附带摩擦** | 被拒绝的调用需要重新补写更完整的 `SCOPE / ROLLBACK / VERIFICATION`，通常约 100–150 词 / 次；停滞和盲重试警告也可能迫使 Agent 更换路线，从而产生额外上下文消耗。 | 视情况而定 |

### 要点澄清

**插件本身不调用任何模型。**

它做的是：

```text
确定性判断
→ 记录账本
→ 检查门禁
→ 注入提示
```

真正昂贵的是：

```text
Reliability Guard 发现证据不足
        ↓
要求补充验证 / 独立评审
        ↓
Agent 发起更多工具调用
        ↓
必要时创建新的评审子代理
        ↓
产生额外 Token 消耗
```

因此，最大的 Token 开销并不是插件代码本身，而是：

> **为了满足插件门禁，由 Agent 额外执行的验证与独立评审。**

尤其对于高风险操作，独立评审通常是最大的 Token 成本来源。
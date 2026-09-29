# 赛博纪委

> AI 想交差，先拿证据。

[简体中文](README.zh-CN.md) | [English](README.md)

**赛博纪委（Cyber Internal Affairs）** 是面向 **DeepSeek Harness** 的证据门禁与可靠性插件。它会记录 Agent 实际做过的变更、要求变更后独立核查，并在高风险任务中触发独立评审。

核心原则只有一句：**AI 说“做完了”不算，证据过关才算。**

- npm 包名：`sbjw`
- 当前版本：`1.2.0`
- Node.js：`>= 20`
- DSH 宿主版本：不锁版本
- 许可证：MIT

> 自 1.2.0 起，DSH 组件 ID 与主要工具标识也统一为 `sbjw`，当前插件界面不再暴露旧的 `reliability-guard` 组件名；历史版本文档仍会保留当时的旧名称。

## 它做什么

- **证据账本**：记录变更、核查、失败和显式 unknown。
- **完成门禁**：变更没有后续覆盖证据，就不能算完成。
- **风险分级**：确定性划分 `LOW` / `MEDIUM` / `HIGH` / `CRITICAL`。
- **独立评审**：高风险任务可以要求新上下文 reviewer。
- **循环保护**：识别重复调用、无效调用、盲目重试和停滞。
- **回读验证**：支持 `Get-FileHash`、`Get-Item`、`Get-Content` 等受支持的纯读取。
- **删除收据**：删除后用独立的精确“不存在”核查覆盖变更。
- **会话诊断**：`sbjw` 查看插件到底记录了什么。
- **账本修复**：`sbjw_reconcile` 只修复记账，不修改任务文件。

## 安装

### DSH CLI

```sh
dsh plugin --profile <name> add sbjw
```

### npm / 本地 profile

```sh
npm install sbjw
```

如果 profile 的 `node_modules` 是由另一主版本 pnpm 创建的，请继续使用同一主版本操作该 profile。

### Desktop

打开 **Plugins**，安装 `sbjw`。中文界面显示 **赛博纪委**，英文界面显示 **Cyber Internal Affairs**。必要时安装后重启 DSH。

加载成功后可调用：

```text
sbjw
```

正常应看到 `toolsRegistered: true`。

## 从 `dsh-reliability-guard` 迁移

`sbjw` 现在同时是 npm 包名和 DSH 组件 ID，不要让旧包与新包同时启用。使用 DSH 管理 profile 时，先移除旧包再安装 `sbjw`；手工维护 `package.json` 时，把 dependencies 与 `dsh.profile.bundles` 里的 `dsh-reliability-guard` 都替换为 `sbjw`。

自 1.2.0 起主要工具名也统一为：

```text
sbjw
sbjw_reconcile
```

## 变更验证

每个 mutation 都必须由**发生在它之后、且独立执行的核查调用**覆盖。和变更放在同一个并行批次里的读取，不能证明变更完成后的状态。

删除文件后，最短的收据是：

```powershell
Test-Path -LiteralPath 'C:\work\gone.txt'
```

结果精确为 `False` 时，可以形成强删除证据：

```text
expected: absent
source: shell-false
```

单纯列父目录内容不算强删除证据。

## Unknown 与修复通道

显式不确定项支持普通文本、列表和 Markdown 加粗：

```text
未验证: 部署目标
- 未确认: 远端状态
**未验证：生产配置**
```

关闭 unknown 的顺序必须是：

1. 先写声明；
2. 再做一次**新的成功核查**；
3. 用那次核查的 `evidence_seq` 调用 `resolve_unknown`。

读取命令报错会记成失败核查，不进入 `unexplained failures`；`resolve_failure` 用于非读取类任务失败。

## 默认低开销配置

```yaml
- id: sbjw
  config:
    mode: balanced
    prompt:
      enabled: true
      verbosity: minimal
    review:
      enabled: true
      highRiskOnly: true
      maxRounds: 1
    completionGate:
      enabled: true
      maxInjectionsPerTurn: 1
    evidence:
      injectDigest: false
    diagnostics:
      enabled: true
      runtimeShellTrace: false
```

组件 ID 现在与 npm 包名一致，因此当前 DSH 插件页不会再显示旧组件名。

## DSH 兼容策略

包清单不声明 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 宿主版本 peer，因此 DSH 的 RC/小版本更新不会只因为旧 semver 范围而被拒绝加载。但这不代表永久兼容所有未来 API；官方真正改变接口时仍可能需要适配。

## 能力边界

Shell 识别器是保守的字面量解析器。关键变更和核查尽量使用直接、明确的顶层命令。复杂脚本、计算路径、跨调用变量、远程副作用和不透明脚本包装可能被标成 unresolved，而不是被插件猜测。

## 隐私

赛博纪委自身不发送遥测，也不会主动发起网络请求。诊断信息会脱敏并限制长度；持久化到 profile 的主要是义务数量摘要，不是完整对话或完整命令历史。

## 开发

```sh
pnpm install
pnpm test
pnpm test:seams
npm pack
```

- 仓库：https://github.com/StrIngeKing/sbjw
- 架构说明：`docs/ADR-0001-cyber-internal-affairs.md`
- 更新记录：`CHANGELOG.md`

## License

MIT

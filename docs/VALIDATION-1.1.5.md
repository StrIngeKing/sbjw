# 1.1.5 基线与环境校验 / Baseline and environment validation

日期：2026-09-29。

本文件记录 `dsh-reliability-guard` 1.1.5 的发布基线、开发环境与验证结果。发布用 TGZ 作为 1.1.5 的运行时基线；源码仓库在此基础上保留开发测试所需的依赖与测试资产。

## 版本与兼容性基线

- 发布版本：`1.1.5`。
- DeepSeek Harness 运行时兼容范围：`0.1.7-rc.2 || 0.2.0-rc.1`。
- 验证期间，1.1.5 TGZ 与实际安装版本中的 **26 个发布文件逐个 SHA-256 一致**。
- 源码工作区已同步到 1.1.5 发布内容；除 `package.json` 的开发环境配置外，**25 个发布文件与原始 TGZ 字节一致**。
- `package.json` 在开发环境中显式加入 `@deepseek-ai/dsh: 0.2.0-rc.1` 作为 `devDependency`，用于避免开发 CLI 继续解析到旧 peer；运行时 peer 双版本范围保持不变。

## 开发环境

- 开发直接依赖的 11 个 DSH 包：`0.2.0-rc.1`。
- Cordis：`4.0.4`。
- Schemastery：`3.18.4`。
- Node.js：`v24.15.0`。
- pnpm：`10.27.0`。
- 验证过程未修改全局安装。
- 发现旧锁文件仍保留旧的间接 peer 后，重新安装并生成 `pnpm-lock.yaml`；之后未再出现 peer 版本混用警告。
- `pnpm install --frozen-lockfile --ignore-scripts`：通过，结果为 `Already up to date`。

## 校验结果

- `pnpm exec dsh --version`：`0.2.0-rc.1`。
- `pnpm run verify:pack`：通过。
- **218 项测试，218 通过，0 失败，0 跳过**。
- 安装包烟测使用原始 1.1.5 TGZ，通过新版 DSH CLI 安装到隔离 profile，并通过真实工具注册与 AgentLoop 验证。
- 1.1.5 新增 8 类回归覆盖：host peer 范围、PowerShell 编码前导、显式 Bash、结构化 stream / 数字与字符串 exit code、删除缺口关闭、装饰文本与标签回执、错误/中断拒绝、结构化 hash 与空输出。
- 旧测试中一处无 shell 参数的调用原先假设 Bash；按 1.1.1 已发布的自动识别规则，改为显式 `{ powershell: false }`，保留原 Bash 边界检查。没有修改发布包运行时代码来迎合测试。
- 隔离空 profile 安装时出现的宿主 peer 提示，在烟测提供真实宿主依赖后完成验证；这不等同于桌面 GUI 的首次重启流程已被验证。

## 发布产物

- TGZ：`dist/dsh-reliability-guard-1.1.5.tgz`
- SHA-256：`ECC032DBCDC8C8A0E48DCD36214AD9689BB82FD055671A96230E47B27F961865`

源码 ZIP 不作为稳定校验产物记录哈希；公开仓库的源码快照可由 GitHub tag / release 自动生成。历史内部构建、临时依赖状态和本地备份不属于公开发布产物。

## 复测

在源码仓库根目录执行：

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec dsh --version
pnpm run verify:pack
pnpm test
```

如需执行依赖真实 Harness profile 的集成烟测，请使用独立测试 profile，并将相关环境变量指向本机的隔离目录，而不要复用个人或生产 profile。例如：

```powershell
$env:DSRH_SMOKE_PROFILE_DIR='<path-to-isolated-dsh-profile>'
$env:DSRH_SMOKE_INSTALL_NODE_MODULES='<path-to-project>\node_modules'
pnpm test
```

不同机器上的绝对路径属于本地测试环境，不是发布产物的一部分。

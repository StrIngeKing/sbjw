# 1.1.8 发布基线与校验 / Release baseline and validation

本文件记录 `dsh-reliability-guard` 1.1.8 的发布准备基线。维护者报告：1.1.8 是当前在真实 DeepSeek Harness 环境中实测最稳定的版本。本次整理不重新声称或替代该真实宿主测试；这里记录的是发布工件同步、字节一致性和可重复的静态/打包校验。

This document records the release-preparation baseline for `dsh-reliability-guard` 1.1.8. The maintainer reports 1.1.8 as the most stable version in current real DeepSeek Harness testing. This packaging pass does not independently reproduce or replace that host-level validation; it records artifact synchronization, byte-level equivalence, and reproducible static/packaging checks.

## 发布基线 / Release baseline

- 发布版本 / Version: `1.1.8`
- Node.js requirement: `>=20`
- DSH host-version policy: since 1.1.7, the package intentionally declares **no** `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` runtime peers; actual API compatibility is still required.
- Explicit runtime peers remain:
  - `@deepseek-ai/cordis` `4.0.4`
  - `@deepseek-ai/schemastery` `3.18.4`
- Source development dependencies remain pinned to the `0.2.0-rc.1` DSH train for reproducible development; they are not runtime admission constraints.

## 原始实测 TGZ / Original tested TGZ

维护者提供的 1.1.8 实测包：

`dsh-reliability-guard-1.1.8.original-tested.tgz`

SHA-256:

```text
998147894A476C2A2A83B3583AA0C98174A3CBDB40E21F2CF1F5F551B2FE13C7
```

该包包含 26 个发布文件。

## 最终发布 TGZ / Final release TGZ

公开发布建议使用整理后的：

`dsh-reliability-guard-1.1.8.tgz`

SHA-256:

```text
675A729065AEB3EAB0289A566C6AED556111E024E264452685BC0728DC4D827B
```

npm pack metadata:

```text
name: dsh-reliability-guard
version: 1.1.8
files: 26
package size: ~114.7 kB
unpacked size: ~348.6 kB
shasum: 4ce6c2aef85e8f4336cda8e4ffaccacc18ca117e
```

## 与实测包的差异 / Differences from the tested artifact

对两个 TGZ 解包后逐文件比较：

- **24 / 26 个文件字节完全一致**。
- 仅以下两个发布文件不同：
  - `package.json`
  - `README.md`
- 所有 `lib/*.js`、`cordis.patch.yml`、`locale/*.json`、`CHANGELOG.md`、`LICENSE` 与原始实测 1.1.8 TGZ **字节一致**。

差异只用于发布元数据与文档整理：

1. `package.json`
   - 增加 GitHub `repository` / `bugs` / `homepage` 元数据。
   - 版本、运行时 peer 策略、入口、exports、bundle patch 与原始实测包保持一致。
2. `README.md`
   - 将遗留的安装示例文件名 `1.1.1.tgz` 修正为 `1.1.8.tgz`。
   - 增加 GitHub 上的详细介绍、ADR、验证报告和 Changelog 入口。

因此，本次发布整理**没有修改 1.1.8 的运行时代码或默认配置行为**。

After unpacking both tarballs and comparing every shipped file:

- **24 / 26 files are byte-identical**.
- Only `package.json` and `README.md` differ.
- All `lib/*.js`, `cordis.patch.yml`, `locale/*.json`, `CHANGELOG.md`, and `LICENSE` are byte-identical to the maintainer-tested 1.1.8 artifact.
- The changes are release metadata/documentation only; runtime code and default configuration behavior are unchanged.

## 源码同步 / Source synchronization

GitHub 源码工作区已同步到 1.1.8：

- `lib/` 使用原始 1.1.8 TGZ 中的运行时代码。
- `cordis.patch.yml` 使用 1.1.8 的低开销默认值：
  - `prompt.verbosity: minimal`
  - `review.maxRounds: 1`
  - `completionGate.maxInjectionsPerTurn: 1`
  - `evidence.injectDigest: false`
  - `diagnostics.runtimeShellTrace: false`
- `CHANGELOG.md` 已包含 1.1.6 / 1.1.7 / 1.1.8。
- release regression test 已更新为 1.1.8 的 host-peer policy，并增加 Markdown uncertainty declaration 回归。
- `docs/INTRODUCTION*.md` 已更新为 1.1.8 的默认低开销行为和 1.1.7+ host compatibility policy。

## 本次可重复校验 / Reproducible checks in this packaging pass

已执行：

```text
node scripts/verify-pack.mjs
→ verify-pack ok: dsh-reliability-guard@1.1.8
```

全部 JavaScript / MJS 文件做 Node 语法检查：

```text
node --check
→ 43 / 43 passed
```

`npm pack --dry-run` / `npm pack` 均确认：

```text
26 files
package name: dsh-reliability-guard
version: 1.1.8
```

### 未在本次打包工作区重新执行的项目

上传的开源副本不包含 `node_modules`，因此本次整理**没有重新执行完整 `pnpm test` / DSH AgentLoop 测试套件**。1.1.8 的真实 DSH 稳定性结论来自维护者此前的真实宿主实测；发布前如需最高保证，可再用最终发布 TGZ 做一次安装/启动/工具注册 smoke test。

The uploaded source copy does not include `node_modules`, so this packaging pass did **not** rerun the complete `pnpm test` / DSH AgentLoop suite. The real-host stability assessment comes from the maintainer's prior DSH testing. For maximum release assurance, perform one final install/start/tool-registration smoke test with the final release TGZ.

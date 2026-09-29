# Cyber Internal Affairs

> Evidence first. No evidence, no pass.

[English](README.md) | [简体中文](README.zh-CN.md)

**Cyber Internal Affairs** is an evidence-gating and reliability plugin for **DeepSeek Harness**. It watches what an agent actually changes, requires later verification for mutations, and can demand an independent review for high-risk work.

The rule is simple: **the AI does not get to say “done” just because it says so.**

- npm package: `sbjw`(暂时没申请下来，有点冲突，之前是dsh-reliability-guard)
- version: `1.2.0`
- Node.js: `>= 20`
- DSH host version: intentionally unpinned
- license: MIT

> Since 1.2.0 the DSH component id and primary tool identifiers also use `sbjw`, so the current UI no longer exposes the former `reliability-guard` component name. Historical release notes may still mention the old package name.

## What it does

- **Evidence ledger** — records mutations, verification, failures, and explicit unknowns.
- **Completion gate** — a changed target must have later covering evidence before the work is considered complete.
- **Risk classification** — deterministic `LOW` / `MEDIUM` / `HIGH` / `CRITICAL` classification.
- **Independent review** — high-risk work can require a fresh-context reviewer.
- **Loop protection** — blocks provable repeat/no-op/blind-retry/stall patterns.
- **Read-back receipts** — supports exact reads such as `Get-FileHash`, `Get-Item`, and `Get-Content`.
- **Deletion receipts** — an exact later absence check can cover a recorded deletion.
- **Diagnostics** — `sbjw` reports what the guard actually recorded.
- **Ledger repair** — `sbjw_reconcile` repairs accounting only; it does not edit task files.

## Install

### DSH CLI

```sh
dsh plugin --profile <name> add sbjw
```

### npm / local profile

```sh
npm install sbjw
```

If the profile's `node_modules` was created by another pnpm major, use the same pnpm major that owns that profile.

### Desktop

Open **Plugins**, install `sbjw`, then restart DSH if necessary. In the English UI the plugin is shown as **Cyber Internal Affairs**; in the Chinese UI it is shown as **赛博纪委**.

After loading, call:

```text
sbjw
```

A healthy load reports `toolsRegistered: true`.

## Migrating from `dsh-reliability-guard`

`sbjw` is the new npm package and DSH component id. Do not keep the old package active beside it. For a managed profile, remove the old package/bundle and add `sbjw`. If you maintain `package.json` manually, replace `dsh-reliability-guard` with `sbjw` in both dependencies and `dsh.profile.bundles`.

Since 1.2.0 the primary tools are:

```text
sbjw
sbjw_reconcile
```

## Verification model

A mutation must be covered by a **later, separate** verification call. A read launched in the same parallel batch cannot prove the state after that mutation.

For a deleted file, the shortest receipt is:

```powershell
Test-Path -LiteralPath 'C:\work\gone.txt'
```

An exact `False` can be recorded as strong absence evidence:

```text
expected: absent
source: shell-false
```

A generic directory listing by itself is not strong deletion evidence.

## Unknowns and reconciliation

Uncertainty may be plain, bulleted, or Markdown-bold:

```text
Unverified: deployment target
- Unknown: remote state
**Unverified: production config**
```

To close an unknown, the order is strict:

1. write the declaration;
2. run a **new successful verification**;
3. call `resolve_unknown` with that verification's `evidence_seq`.

A failed read is a failed verification, not an `unexplained failure`. `resolve_failure` is for non-read task failures.

## Low-overhead defaults

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

The component id now matches the npm package name, so the current DSH plugin page no longer exposes the former component id.

## DSH compatibility

The package does not declare `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` host-version peers, so DSH prerelease updates are not rejected only because of a stale semver range. This does **not** promise permanent API compatibility: real DSH API changes may still require an update.

## Boundaries

The shell recognizer is conservative. Prefer direct literal mutations and direct later checks. Complex scripts, computed paths, cross-call variables, remote side effects, and opaque wrappers may remain unresolved instead of being guessed.

## Privacy

Cyber Internal Affairs sends no telemetry and makes no network calls of its own. Diagnostics are bounded and redacted. Persistent profile receipts store obligation counts rather than raw conversation text or full command history.

## Development

```sh
pnpm install
pnpm test
pnpm test:seams
npm pack
```

- Repository: https://github.com/StrIngeKing/sbjw
- Architecture: `docs/ADR-0001-cyber-internal-affairs.md`
- Changelog: `CHANGELOG.md`

## License

MIT

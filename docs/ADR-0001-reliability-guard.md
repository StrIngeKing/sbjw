# ADR-0001 — Reliability Guard on the public DSH seams

- **Status:** accepted
- **Date:** 2026-01-01
- **Runtime under test:** DeepSeek Harness `0.1.7-rc.2` (Electron app `44.0.0`), Cordis `4.0.4`
- **Supersedes:** the v0.1.0 MVP of `dsh-reliability-guard`

## Context

The task was to turn a prompt-only reliability MVP into a guard that
systematically reduces guessing, false completion, tool loops, irreversible
mistakes and environment errors — with one hard constraint: **anything a
deterministic program can decide must not be delegated to a model's
self-assessment.**

Two facts shaped every decision:

1. **The development prompt's file paths do not exist on the target machine.**
   It refers to a source checkout (`docs/user/develop/basic/publish.md`,
   `packages/core/tools/src/index.ts`, `docs/tool-execution-pipeline.md`,
   `packages/bundle/base/cordis.patch.yml`, …). The installed application ships
   no `docs/` or `packages/` tree; the DSH code lives inside
   `resources/app.asar` as npm packages. The investigation therefore used the
   published packages as the authoritative source, extracted from the archive
   and verified against the archive's own SHA256 integrity values
   (11 380/11 380 files matched) rather than trusting a copy.
2. **Several capabilities the prompt asked for already exist officially.**
   Approval, sandbox policy, stale-file guarding, durability checkpoints,
   compaction and an advisory repeat detector are shipped. Reimplementing them
   would create a second, conflicting authority.

## Decision

Build the guard as a **pure consumer of documented seams**: a bundle that
registers listeners, one prompt section and one read-only tool, and owns only
its own per-session state.

### Seam inventory (verified in the shipped source, not from memory)

| Need | Seam | Contract as verified |
|---|---|---|
| Decide allow / deny / ask before a call | `tools/pre-execute` waterfall (`dsh-tools/lib/index.js:3225`) | Listener `(exec, next)`; return `{kind:'allow'|'deny'|'ask'|'cancel'}`. `deny` gets `reason` + optional `info`; `ask` is routed to the approval service by the registry, which denies on `rejected`/`cancelled`/`unavailable` and when no approval service or no agent exists |
| Inspect or block a result | `tools/post-execute` waterfall (`:3504`) | Listener `(exec, result, next)` — **`result` is argument 2 and `next()` resolves to the downstream DECISION**, not to a result. Return `{kind:'accept'}` (optionally `content` xor `value`) or `{kind:'block', feedback}`, and `additionalContexts` in either |
| Observe the final outcome | `tools/result` (`:3416`) | Plain emit, observe-only |
| Add operating rules to the prompt | `ctx.systemPrompt.section({name, order, text, interpolate})` (`dsh-system-prompt/lib/index.js:240`) | Ordered, name-shadowed, disposed with the fiber; `interpolate:false` keeps literal braces safe |
| Per-session state | plugin-owned bucket keyed by the live `Session` object, released on `session/disposed` | No ambient session service exists; the session is reached as `exec.agent.session` |
| Deliver a correction after a tool result | `additionalContexts` → driver-owned next-step inbox | The scheduler records the tool result, then enqueues its contexts for the next model step. The plugin must not also call `agent.inject` for these messages, since a duplicate pending ID aborts the turn. Verified with full AgentLoop regressions in 1.0.3. |
| Fresh-context review | the shipped `subagent` tool | The guard injects the review request; the executor makes the call; the verdict is read from that tool's result |
| Human approval | `{kind:'ask'}` from `pre-execute` | Fail-closed. Never hangs and never fails open |
| File identity | `ctx.fs.resolve` / `ctx.fs.stat` → `{version, type, size}`, `fs/observed` event | `FsVersion` is opaque (`dev:ino:size:mtimeNs:ctimeNs`) and comparison-only. `fs/observed` observers must be synchronous |
| Effective permission mode | `ctx.sandboxPolicy.resolve({session})` | Read-only. The guard never calls `setSandboxMode` |
| Durability | `ctx.sessions.flush(session)` | A flush, **not** a filesystem rollback |

### Deliberate non-decisions

- **No `ctx.tools.guard()`.** The monotonic guard cannot selectively allow a
  HIGH-risk call that later carries a rollback plan; `pre-execute` can.
- **No subagent service call.** Driving `ctx.subagents.startContinuable` would
  duplicate the shipped `subagent` tool's lifecycle, sandbox and preset
  handling. The guard composes a prompt instead and stays out of the delegation
  mechanism.
- **No filesystem fingerprinting via its own `fs` reads.** The official engine
  tool bodies own their own observation records; a second observation path would
  produce `FS_STALE_VERSION` races. The guard reads `ctx.fs.stat` versions only,
  and reads file text only to inspect line endings before an edit.
- **No generic "unknown tool mutates" rule.** A mutation is recorded when the
  classifier recognizes a file writer, or when the version of a path the call
  named actually changed across it. That keeps the completion gate from
  demanding verification for calls that changed nothing, while still covering
  `Set-Content`, `Out-File`, `sed -i` and lockfile rewrites.
- **The freshness gap is advisory, not blocking.** Its detector is lexical, and a
  lexical false positive must never stop a turn. Narrowing the detector (a
  topic marker *plus* external-claim shape, minus local-scope phrasing) is what
  keeps it usable; the severity stays advisory regardless.
- **Core modification: none.** Every requirement was met through the public
  seams above; this ADR therefore registers no exception.

### Consequences

- The guard never overlaps the official repeat reminder's thresholds: its
  identical-run block fires at or after the advisory thresholds (balanced 5 vs
  the shipped 3/5/8).
- A guard block is a normal tool error whose text names the evidence and one
  next action, so the model can recover inside the same turn.
- Because corrections are delivered both as additional context and as a
  next-step inbox message, a corrective notice cannot be silently dropped by a
  neighbouring post-execute listener.
- Session state is released on `session/disposed`, on plugin disposal and on
  process exit; a long-lived host does not accumulate finished sessions.

## Verification performed

- 17 required test scenarios, driven against the real registry, the real session
  log and the production `AgentLoop` from the official testkit; no official
  component is mocked or monkey-patched. The only test-owned model backend is a
  scripted `LlmAdapter`, which is the official public extension point.
- An adversarial review by a fresh-context reviewer that had not written the
  code and could not see the author's reasoning. It returned FAIL with three
  blockers (URL-embedded credentials escaping redaction, a credential rule that
  denied innocent read-only commands, and an incorrect assumption about how the
  registry treats `additionalContexts`) plus a set of major findings. Every
  finding was reproduced before it was fixed, and the reviewer's own probe
  scripts were re-run afterwards to confirm the fix.
- A packaged tarball installed into a temporary profile, followed by
  `--dump-config` composition inspection, a real boot, the installed-artifact
  smoke test, and a clean `remove` that restores the bundle list and the
  dependency set.

## Residual risks

Recorded in [`../CHANGELOG.md`](../CHANGELOG.md#known-limitations): the review
handoff depends on the shipped `subagent` tool; a mutation the guard cannot name
is not recorded; staleness rests on the official version rather than a content
hash; the freshness detector is lexical and therefore advisory; the Windows
checks are lexical and therefore advisory; and the official "checkpoint"
capability is durability, not rollback.

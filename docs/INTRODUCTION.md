# DSH Reliability Guard: Capabilities, Boundaries, and Token Cost (1.1.8)

> This document describes **1.1.8**. Every statement about behaviour is backed either by the plugin's own ledger output or by the host's per-request usage accounting (tokens, cache hit rate, settled cost), captured in a real DSH Desktop session.

## 1. Positioning

**It does not make the model smarter. It adds accountability.**

Instead of accepting "I verified it" as a claim, Reliability Guard turns verification into **target-matched, auditable observations recorded in a ledger**, and prevents a turn from completing when the available evidence is insufficient.

In short, it is a layer around the Agent loop:

**Deterministic Gates + Audit Ledger**

One 1.1.8 fact worth stating up front: the **core semantics (risk, ledger, receipts, review, completion gate) have not changed since 1.1.5**. 1.1.6 only changed defaults, 1.1.7 only changed metadata, and 1.1.8 only hardened declarations and the reconciliation channels. That is why the line has become more stable, not less.

---

## 2. Version History and Stability (1.1.4 → 1.1.8)

| Version | Nature | Effect on stability |
| --- | --- | --- |
| 1.1.4 | Root-cause fix: DSH exposes `stdout` / `stderr` as structured objects `{ text, truncated, spillPath? }`, so the old `String(stderr)` produced `"[object Object]"` ⇒ `shellOK=false` ⇒ **every shell verification was rejected** | Correct fix, but `peerDependencies` pinned the host to exactly `0.1.7-rc.2`, so a host upgrade to `0.2.0-rc.1` was **silently refused by the DSH compatibility gate** (observed: no policy section, no tools, no error) |
| 1.1.5 | **Metadata only**: peer widened to `0.1.7-rc.2 \|\| 0.2.0-rc.1`; runtime code identical to 1.1.4 | Loads again; **deletion closure passed end-to-end for the first time** |
| 1.1.6 | **Defaults only** (low-overhead profile) | Semantics unchanged, overhead sharply reduced (see §7) |
| 1.1.7 | **Metadata only**: all `@deepseek-ai/dsh*` host peers removed (`peerDependencies` keeps only `cordis` / `schemastery`) | Removes the silent-refusal mechanism; later host release candidates no longer get rejected because of a stale version range |
| **1.1.8** | Declaration parsing hardened (accepts `**unverified: X**`), `resolve_unknown` ordering documented in the tool description, completion-gate wording corrected, README documents the ordering rule for verification | Small, revertible deltas — **the version this document was validated against** |

**Conclusion:** 1.1.8 is the most stable release of this line. After 1.1.4 there were only two runtime-functional changes (1.1.6 defaults, 1.1.8 hardening), and the only mechanism that could make the plugin vanish without a message has been removed.

---

## 3. Capabilities Confirmed in Real Testing (1.1.8)

> The capabilities below were observed and verified through ledger evidence during real sessions.

| Capability | Observed Behavior |
| --- | --- |
| **① Pre-execution Risk Classification and Blocking** | Every tool call is classified as `LOW / MEDIUM / HIGH / CRITICAL` before execution. High-risk calls were repeatedly rejected with messages such as: `refused this HIGH-risk call: deletes files … Missing before this can run: rollback`. Execution was allowed only after the required `SCOPE / ROLLBACK / VERIFICATION` information was provided. |
| **② Mutation Ledger** | Mutations are recorded per target as `-> present / absent`, with the **real pre-state captured before execution**. Example: `mutation #21: …\.ab-guarded.tmp -> absent; pre-state observed: present type=file size=45`. When a later mutation supersedes an earlier one, the ledger marks it as `superseded by #N`. |
| **③ Per-target Accounting for Multi-target Operations** | A single comma-separated deletion involving three files produced three independent ledger entries, each with its own pre-state (52 / 1464 / 1338 bytes). |
| **④ Verification Coverage** | A verification counts only when it is **target-matched + sufficiently strong + later than the mutation**. Writes and reads require `read-back` (a native `read` already carries its target). **Deletion requires `absence` evidence**: bare `Test-Path -LiteralPath '<literal>' → False`, an exact `Get-Item` not-found, or a parent re-list combined with precise stat. Example: `check #22: absence PASS; strong=true; targets=[{…, "expected":"absent", "source":"shell-false"}]` with `covering verification: 22`. **Ordering matters**: the covering check must be a separate call that starts after the mutation; a read launched in the same parallel batch does not count. |
| **⑤ Completion Gate** | Before a turn may finish, the gate checks for uncovered mutations, unexplained failures, unresolved unknowns, and unreviewed high-risk changes. If any remain it **injects an explicit instruction into the conversation** (by default at most one injection per turn, without attaching the full evidence digest), naming the gap and the concrete remediation. Since 1.1.8 the wording no longer says "has not run" but "no PASS/FAIL verdict is recorded yet; a review launched this turn may land at turn end". |
| **⑥ Mandatory Independent Review** | High-risk mutations, especially deletions, require a fresh-context reviewer that must return `VERDICT: PASS\|FAIL`. A FAIL becomes an **unresolved objection**. Default `maxRounds=1`. In this line of work seven reviews returned PASS (and several earlier rounds returned FAIL), including one where the reviewer **independently corrected the author's byte-count misstatement** and one where it unpacked the session transcript, reconstructed the deleted content and produced a SHA256. |
| **⑦ Audit Inspection Tooling** | `reliability_guard(detail:true)` exposes `pending mutation verification`, per-entry mutation/check records including `targets` and `source`, `stale observations`, `unexplained failures`, `unknowns`, `counters`, and cross-restart `history`. `call_seq` inspects previous calls including the **redacted original command**. The temporary runtime shell-query trace shipped in 1.1.3 is off by default (`diagnostics.runtimeShellTrace=false`). |
| **⑧ Ledger Reconciliation** | `reliability_guard_reconcile` supports `declare_targets` (supplements scope while stating that **a declaration is not evidence**), `resolve_unknown`, and `resolve_failure`. `resolve_unknown` requires the order **"declaration → newer passing check → resolve"**, with `evidence_seq` later than the declaration (otherwise the call is rejected). `resolve_failure` explains **non-read** task failures, does not mean the operation succeeded, and does not bypass gates. Since 1.1.8, Markdown-wrapped uncertainty declarations such as `**unverified: X**` are also recorded (the trailing `**` is stripped). |
| **⑨ Loop and Stall Protection** | Byte-identical repeats, argument-normalized semantic repeats, no-op shell calls, blind retries and no-progress stalls are detected. **Only genuinely new information counts as progress**; repeated reads do not. **Known roughness:** the heuristic is insensitive to read-only investigation — six consecutive read-only inspection calls were flagged as "6 calls in a row produced no observable progress". |
| **⑩ Freshness Gate** | Claims about external facts (versions, releases, availability) require relevant retrieval in the session. Since 1.1.2 freshness is tracked **by topic** and the retrieved topic must overlap with the claim; unrelated retrieval does not count. Verified at counter and code-structure level only — not yet through full semantic end-to-end testing. |
| **⑪ Cross-restart Audit Receipts** | Count-based receipts are stored in the profile (`history.storage: profile`, `resetCount` grows), and the plugin states explicitly that **`reset is NOT resolved`** — resetting state does not mean earlier unresolved items were solved. |
| **⑫ Policy Injection** | `prompt.js` injects a **prefix-stable** system-prompt section named `reliability-guard:policy` (prefix stability is deliberate, so the host's prefix cache can absorb it). Since 1.1.6 the default is `minimal` (**804 characters / 104 words**); `compact` (2769 characters / 443 words, twelve detailed rules) and `full` (adds the verification matrix) remain available. |

---

## 4. What It Does Not Do

These boundaries come from both the documented limits and observed behaviour.

- It does not inspect private model reasoning; it only observes **externally visible behavior**.
- It **does not modify your files**; `reconcile` only changes ledger state.
- It is not a general-purpose shell interpreter. It follows a **fail-closed** strategy: ambiguous prefixes, complex expressions, and unclear multi-target failures are not bound to targets. It prefers missing evidence over incorrectly attributed evidence.
- It does not treat declarations, self-reports, or reviewer PASS results as evidence: `Review PASS does not replace target observation`.
- It cannot prove that an undeclared path was never affected.
- In-memory ledger state is cleared after restart; only **count-based receipts** remain, and previously unresolved items are surfaced as `reset` counters rather than treated as resolved.
- **(New, measured) The script blind spot.** The guard parses only the tool call's own command text. When a governed operation (deletion, in-place rewrite) is **wrapped inside a script call**, the ledger, the gates and the review requirement are **not triggered at all**:

  ```text
  shell-query #28  command="& run-acceptance.ps1 -Phase delete"  -> verificationQueries=[]
  check       #29  existence FAIL; targets=[]      (nothing to cover, so nothing is recorded)
  ```

  This does not require bad intent — writing a small script to "get it done in one shot" is a natural move. **Recommendation:** state in the README/policy that governed operations must not be wrapped in scripts, or have the guard statically scan script text for `Remove-Item` / `Set-Content` / `git push` / package-manager install commands.

---

## 5. What It Actually Helped With

During development, Reliability Guard effectively pushed the plugin itself from `1.0.5` through `1.1.8`. Real issues uncovered and reproduced, all from the plugin's own ledger output:

- **Silent deletions not entering the ledger** (1.0.5)
- **Comma-separated multi-target operations producing zero targets** (1.0.6)
- Structured `stderr` converted through `String()` into `[object Object]`, causing every shell verification to be rejected (fixed in 1.1.4)
- Incorrect shell-query target extraction, and deletion verification that could not close the evidence loop (localised layer by layer across 1.0.8–1.1.3, first closed end-to-end in 1.1.5)
- Review state becoming inconsistent with ledger state
- Excessive default context overhead, which led to the 1.1.6 `minimal` policy, one completion injection per turn, and one reviewer round by default
- Repeated host-version admission failures across DSH prerelease bumps, which led to the 1.1.7 unpinned host-version policy while still requiring real API compatibility
- Markdown formatting causing uncertainty declarations to be missed, plus unclear `resolve_unknown` ordering, which led to the 1.1.8 declaration/reconciliation hardening

The process also produced a reusable acceptance workflow, and the plugin's own documentation now records the verification-ordering rule:

```text
.scratch\acceptance\CHECKLIST.md
.scratch\acceptance\run-acceptance.ps1
```

So Reliability Guard is not only a mechanism for blocking unsafe completion; it is gradually becoming **reliability acceptance infrastructure**.

---

## 6. Who It Is For

Reliability Guard is designed for:

> **Agents performing dangerous, irreversible, or audit-sensitive operations.**

Typical examples: file deletion, configuration changes, deployment, database migrations, batch modifications, high-risk automation.

It trades **additional tool calls, verification rounds, and independent review** for stronger guarantees:

- Every important step has target-matched observations
- Mutations have before/after evidence
- Completion cannot rely only on the Agent's own claims
- Insufficient evidence prevents the task from being declared complete

The trade-off is straightforward: **it is slower, more verbose, and consumes more tokens.** For simple tasks such as writing documentation or editing copy it may feel unnecessarily strict; once the operation becomes *"if this is deleted, it may not come back"*, the cost is easy to justify.

### A/B measurement: with the guard vs. without it (same deletion task)

| Observation | Arm A (guard sees it) | Arm B (guard blind ≈ no plugin) |
| --- | --- | --- |
| Probe created | `mutation #20 -> present; pre-state observed: absent` | **nothing recorded** |
| Probe deleted | `mutation #21 -> absent; pre-state observed: present type=file size=45` | **nothing recorded** |
| Gate injections | **2** (verify after the write; CRITICAL review after the delete) | **0** |
| Forced check | bare `Test-Path` required, otherwise `pending` never returns to 0 | none |
| Independent review | **required** (1 fresh review session) | none |
| Traceability | `check #22: absence PASS; strong=true; targets=[…, expected:"absent"]` + `covering verification: 22` | **nothing to inspect afterwards** |
| Extra calls | 4 tool calls + 1 review session | 1 call (the script itself) |

**In one line:** the plugin does not change what the Agent *can* do; it changes whether the Agent can **declare the work done without being checked**.

---

## 7. Does It Increase Token Usage? (1.1.8 defaults)

**Yes** — but not because the plugin calls a model. The cost comes from extra verification, gate context, and independent review. **Since 1.1.6 the defaults deliberately compress persistent and corrective overhead, so 1.1.5-era figures must not be read as the 1.1.8 default cost.**

| # | Cost Source | 1.1.8 Default / Observed Anchor | Nature |
| ---: | --- | --- | --- |
| **1** | **Persistent policy section** | `prompt.verbosity=minimal`: **804 characters / 104 words** (`compact` 2769 / 443 optional). Prefix-stable, so the host cache can absorb it. | Fixed per request, already compressed |
| **2** | **Gate / notice injection** | `completionGate.maxInjectionsPerTurn=1`, `evidence.injectDigest=false`, `evidence.maxDigestChars=1600`: only the short gap-specific context is injected, never the whole digest. | Only when gaps exist, and bounded |
| **3** | **Structural extra round trips** | A mutation and its covering verification must be **separate, later calls**; ledger inspection, reconciliation and explanations add calls too. | Paid per high-assurance action |
| **4** | **Independent review** | Triggered only for high-risk changes (`review.highRiskOnly=true`), default `maxRounds=1`. **The largest variable cost.** | Only for high-risk mutations |
| **5** | **Operational friction** | Rejected calls need fuller `SCOPE / ROLLBACK / VERIFICATION` text; loop/stall findings can force a route change. | Situation-dependent |

### Measured accounting (same session, host per-request records)

| | **Arm A (guard sees it)** | **Arm B (guard blind ≈ no guard)** |
| --- | --- | --- |
| Requests | 4 | 5 |
| Prompt total | **2,058,672** | **2,607,074** |
| ├ cache read | 2,053,120 | 2,604,800 |
| └ uncached input | **5,552** | **2,274** |
| Output | **3,871** | **4,316** |
| **Cache hit rate** | **99.73%** | **99.91%** |

**Arm A only — the forced review session (measured separately):** prompt **1,192,901** (cache read 1,155,712 + uncached **37,189**), output **45,536**, cache hit rate **96.88%**, **settled cost ¥0.242447**.

**Whole main session:** uncached input 5,702,426 + cache read 128,931,584 (**95.76% hit rate**) + output 705,599; `cacheWriteTokens = 0` (this provider reports no cache-write billing).

### How to read these numbers

1. **The hit rate is essentially independent of the guard** (99.73% vs 99.91%): both arms share a ~510–520K-token prefix that the host's prefix cache absorbs almost entirely. Because the policy section is deliberately prefix-stable, **its text cost is close to zero per request** — the direct payoff of the 1.1.6 work.
2. **The guard's real cost is not text but extra actions**: the forced independent review (≈¥0.24 per review in this session) and the additional round trips. The uncached-input delta is only in the thousands of tokens.
3. The two rows are **window sums within one session, not an isolated controlled experiment** (Arm B inherits the context grown by Arm A), so read them as structure and magnitude, not as a clean "net cost of the plugin".
4. For scale: the day's spend was ¥9.56 (balance ¥16.11). **One forced review at ¥0.24 is a rounding error** against the session, and it buys an independent second pair of eyes.

### How to reduce it further (knobs that already exist in 1.1.8)

- Read-only / documentation work: `freshnessGate.enabled:false`, `windows.enabled:false`, `completionGate.maxInjectionsPerTurn:0` (note: this makes uncovered mutations silent — use with care), smaller `evidence.maxRecords`.
- Let reversible writes skip review: keep `review.highRiskOnly:true` and raise `review.multiFileThreshold` (default 3).
- Shorter policy: already `minimal`; anything shorter means disabling the section (not recommended).
- Fewer loop warnings: `exactRepeats` / `semanticRepeats` / `noopShell` / `blindRetries` / `stall` can be disabled individually (at the cost of losing genuine stall detection).
- Diagnostics only when troubleshooting: `diagnostics.runtimeShellTrace`, `diagnostics.includeSensitiveContent` (off by default; **never** enable it in a shared log).

**Suggested next step (1.1.9, opt-in):** express per-operation tiers as an explicit switch that defaults to **1.1.8-equivalent behaviour** — e.g. `read / write / mutate / destructive / publish`, where only `destructive` and `publish` keep receipts and review — and add **static script scanning** to close the blind spot in §4. That way "near-zero overhead for read work, strict gates for delete/deploy" can coexist without gambling the stability of 1.1.8.

---

## 8. Summary

**1.1.8 does not add intelligence; it turns "I verified it" into auditable, target-matched ledger observations and blocks completion when evidence is missing.** It does increase token usage, but since 1.1.6 the defaults keep persistent and corrective context small (an 804-character policy, at most one gate injection per turn, a single reviewer round by default). **The one measured cost centre is the independent review for high-risk operations (≈¥0.24 per review in this session).** For "delete it and it is gone" operations that is cheap; for editing copy or writing documentation, it is a tax.

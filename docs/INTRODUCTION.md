# DSH Reliability Guard: Capabilities, Boundaries, and Token Cost

## 1. Positioning

**It does not make the model smarter. It adds accountability.**

Instead of accepting “I verified it” as a claim, Reliability Guard turns verification into **target-matched, auditable observations recorded in a ledger**, and prevents the turn from completing when the available evidence is insufficient.

In short, it acts as a layer around the Agent loop:

**Deterministic Gates + Audit Ledger**

---

## 2. Capabilities Confirmed in Real Testing

> The capabilities below were observed and verified through ledger evidence during real sessions.

| Capability | Observed Behavior |
| --- | --- |
| **① Pre-execution Risk Classification and Blocking** | Every tool call is classified as `LOW / MEDIUM / HIGH / CRITICAL` before execution. High-risk calls were repeatedly rejected with messages such as: `refused this HIGH-risk call: deletes files … Missing before this can run: rollback`. Execution was allowed only after the required `SCOPE / ROLLBACK / VERIFICATION` information was provided. |
| **② Mutation Ledger** | Mutations are recorded per target as `-> present / absent`, with the **real pre-state captured before execution**. Example: `mutation #5: …\.accept-F.tmp -> absent; pre-state observed: present type=file size=54`. When a later mutation supersedes an earlier one, the ledger marks it as `superseded by #N`. |
| **③ Per-target Accounting for Multi-target Operations** | A single comma-separated deletion involving three files resulted in three independent ledger entries, each with its own pre-state, including sizes of 52 / 1464 / 1338 bytes. |
| **④ Verification Coverage** | A verification only counts when it is **target-matched + sufficiently strong + later than the mutation**. Writes and reads require `read-back`; native `read` operations already carry target information. **Deletion requires `absence` evidence**, such as `Test-Path → False`, a missing `Get-Item`, or parent-directory re-listing combined with precise stat behavior. Example: `check #6: absence PASS; strong=true; targets=[{…, "expected":"absent", "source":"shell-false"}]`. |
| **⑤ Completion Gate** | Before a turn is allowed to finish, Reliability Guard checks for uncovered mutations, unexplained failures, unresolved unknowns, or unreviewed high-risk changes. If any remain, it **injects an explicit instruction into the conversation** rather than failing silently, including the missing evidence and concrete remediation steps. |
| **⑥ Mandatory Independent Review** | High-risk mutations, especially deletions, require a fresh-context reviewer that must return `VERDICT: PASS\|FAIL`. A FAIL becomes an **unresolved objection** in the final state. Review rounds are capped by `maxRounds`. In this session, four reviews returned PASS, including one where the reviewer independently unpacked session records, reconstructed deleted content, and produced a SHA256 hash. |
| **⑦ Audit Inspection Tooling** | `reliability_guard(detail:true)` exposes `pending mutation verification`, detailed mutation/check entries including `targets` and `source`, `stale observations`, `unexplained failures`, `unknowns`, `counters`, and cross-restart `history`. It also supports `call_seq` for inspecting previous calls, including the **redacted original command**. |
| **⑧ Ledger Reconciliation** | `reliability_guard_reconcile` supports `declare_targets`, `resolve_unknown`, and `resolve_failure`. `declare_targets` can supplement scope information, while explicitly stating that **declaration is not evidence** and must be followed by independent verification. `resolve_unknown` requires an evidence-backed explanation. `resolve_failure` records why a failure is understood, but **does not mean the operation succeeded**, and does not bypass gates. All three paths were exercised in testing. |
| **⑨ Loop and Stall Protection** | Repeated commands, semantic repetition, blind retries, stalls, and no-op shell calls are detected. **Only genuinely new information counts as progress**; repeated reads do not. |
| **⑩ Freshness Gate** | Claims about external facts such as versions, releases, and availability require relevant retrieval within the current session. Since 1.1.2, freshness is tracked by **topic**, and the retrieved topic must overlap with the claim. Unrelated retrieval does not count. This capability was verified at the counter and code-structure level, but not yet through full semantic end-to-end testing. |
| **⑪ Cross-restart Audit Receipts** | Reliability Guard stores **count-based receipts** in the profile using settings such as `history.storage: profile`, while `resetCount` increases across resets. It explicitly records that **`reset is NOT resolved`** — resetting state does not mean previous unresolved issues were solved. |
| **⑫ Policy Injection** | Twelve `Operating reliability rules` are injected as a system-prompt section through `reliability-guard:policy` in `prompt.js`. The presence of this policy section therefore becomes the first signal that the plugin is active. |

---

## 3. What It Does Not Do

These boundaries come from both the documented limits and observed behavior.

- It does not inspect private model reasoning; it only observes **externally visible behavior**.
- It **does not modify your files**; `reconcile` only changes ledger state.
- It is not a general-purpose shell interpreter. It follows a **fail-closed** strategy: ambiguous prefixes, complex expressions, and unclear multi-target failures are not bound to targets. It prefers missing evidence over incorrectly attributed evidence.
- It does not treat declarations, self-reports, or reviewer PASS results as evidence: `Review PASS does not replace target observation`.
- It cannot prove that an undeclared path was never affected.
- In-memory ledger state is cleared after restart. Only **count-based receipts** remain. Previously unresolved items are reflected through `reset` counters rather than being treated as resolved.

---

## 4. What It Actually Helped With

During development, Reliability Guard effectively pushed the plugin itself from `1.0.5` through `1.1.5`.

Real issues uncovered and reproduced included:

- **Silent deletions not entering the ledger**
- **Comma-separated multi-target operations producing zero targets**
- Structured `stderr` being converted through `String()` into `[object Object]`, causing all shell verification to be rejected
- Incorrect shell-query target extraction
- Deletion verification that could not close the evidence loop
- Review state becoming inconsistent with ledger state

These defects were identified and reproduced using the plugin's own ledger output.

At the same time, the process also produced a reusable acceptance workflow:

```text
.scratch\acceptance\CHECKLIST.md
.scratch\acceptance\run-acceptance.ps1
```

In other words, Reliability Guard is not only a mechanism for blocking unsafe completion.

It is gradually becoming a form of **reliability acceptance infrastructure**.

---

## 5. Who It Is For

Reliability Guard is designed for:

> **Agents performing dangerous, irreversible, or audit-sensitive operations.**

Typical examples include:

- File deletion
- Configuration changes
- Deployment
- Database migrations
- Batch modifications
- High-risk automation

It trades **additional tool calls, verification rounds, and independent review** for stronger guarantees:

- Every important step has target-matched observations
- Mutations have before/after evidence
- Completion cannot rely only on the Agent's own claims
- Insufficient evidence prevents the task from being declared complete

The trade-off is straightforward:

**It is slower, more verbose, and consumes more tokens.**

For simple tasks such as writing documentation or editing copy, it may feel unnecessarily strict.

But once the operation becomes:

> **“If this is deleted, it may not come back.”**

the additional verification cost becomes much easier to justify.

---

## 6. Does It Increase Token Usage?

**Yes.**

However, most of the Token cost does not come from the plugin directly calling a model.

Instead, the cost comes from:

1. Persistent policy injection
2. Gate and notice messages
3. Additional calls required to satisfy verification
4. Independent reviews for high-risk operations

### Token Cost Sources and Observed Anchors

| # | Cost Source | Observed / Estimated Cost | Nature |
| ---: | --- | --- | --- |
| **1** | **Persistent Policy Section** | `prompt.js` is approximately 6.3 KB in total, with 12 rules injected into the system prompt on **every request**. Estimated contribution: roughly **1.5–2 KB ≈ 400–600 tokens per request**. | Fixed, paid every turn |
| **2** | **Gate / Notice Injection** | In one session with 38 calls: `gateInjections=7`, `noticesInjected=11`, `digestsInjected=11`, `evidenceDigestsInjected=8`. Each may include an `Evidence digest` block, estimated at roughly **150–500 tokens per item**, for a session-level total of approximately **2–5k tokens**. | Triggered when gaps exist |
| **3** | **Structural Extra Round Trips** | Mutations and verification **must be separated**, and additional ledger reads, reconciliation, or explanations may be required. Each mutation therefore usually adds **at least 2–3 extra calls**. In the deletion demonstration: create → delete → raw verification → ledger read required roughly 4–5 calls; with review, roughly 6–8 calls. | Paid per action |
| **4** | **Independent Review** | Each review starts **a fresh-context Agent**, which may independently read files, run commands, and write a 500–1500 word report. The review itself can therefore consume **tens of thousands of tokens**, while the report returned to the main context may add another **1–3k tokens**. The observed session included four PASS reviews plus multiple earlier FAIL rounds. | Mainly paid for high-risk mutations |
| **5** | **Operational Friction** | Rejected operations must often be retried with longer `SCOPE / ROLLBACK / VERIFICATION` descriptions, typically around 100–150 words per retry. Stall and blind-retry warnings may also force a route change, indirectly consuming more context. | Situation-dependent |

### Important Clarification

**The plugin itself does not call any model.**

Its work is deterministic:

```text
Deterministic checks
        ↓
Ledger updates
        ↓
Gate evaluation
        ↓
Prompt / notice injection
```

The expensive part happens afterward:

```text
Reliability Guard detects insufficient evidence
        ↓
Requires additional verification or review
        ↓
The Agent performs more tool calls
        ↓
A fresh reviewer may be created
        ↓
Additional Token usage is produced
```

So the largest Token cost does not come from the plugin's own execution.

It comes from:

> **The additional verification and independent review work that the Agent must perform in order to satisfy the plugin's gates.**

For high-risk operations, independent review is usually the largest Token cost.
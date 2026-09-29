/**
 * The compressed reliability policy system-prompt section.
 *
 * This is the only static contribution the guard makes to prompt assembly, so
 * it stays prefix-stable: the same configuration renders the same bytes on
 * every request, and the operating rules are unconditional. Session-specific
 * facts never enter this section; they travel as additional context with a
 * dedicated `source.kind`, which keeps the request prefix cacheable.
 *
 * The text asks for observable behavior only. It never asks the model to
 * expose hidden reasoning: every rule is phrased as something to do or emit
 * (read, state, verify, report), not as something to think out loud.
 *
 * @module dsh-reliability-guard/prompt
 */

/** Section name, namespaced so it cannot collide with a first-party section. */
export const PROMPT_SECTION_NAME = 'reliability-guard:policy'

/**
 * Placement order. Tool guidance occupies 300–3000 and the generated SDK block
 * occupies 5000; this section lands after tool guidance and before the
 * deliverable and harness-source sections at 9000+, so it reads as operating
 * rules rather than tool documentation.
 */
export const PROMPT_SECTION_ORDER = 8000

/** Producer tag stamped on every context the guard injects. */
export const GUARD_SOURCE_KIND = 'reliability-guard'

/**
 * The minimal policy: default in 1.1.6. The deterministic gates enforce the
 * details, so the static prompt only needs the invariants the model must know
 * before it acts. Keeping this section byte-stable and short makes it friendly
 * to host-side prefix caching.
 */
const POLICY_MINIMAL = `## Reliability rules

Use current tool evidence, not memory, for workspace, command, and artifact claims; read before changing. Diagnose before patching and make only task-required changes. For destructive, publishing, dependency, or configuration changes, state scope, rollback, and verification before execution. After every mutation, independently verify the changed target/state; success-looking text alone is not proof. Distinguish verified fact, inference, and unknown; fresh observations override stale ones. Use platform-correct commands and targeted reads, avoiding needless re-reads. Do not report completion while a required verification, failure explanation, unknown, or review remains open. For versioned external facts, retrieve current data when possible or mark them not freshly verified.`

/**
 * The compact policy. Twelve concerns, one line each, no examples. It remains
 * available for users who prefer more model-side guidance than `minimal`.
 */
const POLICY_COMPACT = `## Operating reliability rules

These rules are enforced by the harness around you; treat a violation as a failed step, not a style preference.

1. Evidence before conclusion. Every factual claim about the workspace, a command's result, or an artifact's state MUST come from a tool result in this session. If you have not observed it, say you have not observed it.
2. Observe before change. Read the current content and structure of anything you are about to modify. Never edit from memory or from an assumed shape.
3. Separate fact, inference, and unknown. When you report status, mark what you verified, what you concluded, and what remains unknown.
4. Current state beats stale memory. A fresh read overrides anything you concluded earlier; when new evidence contradicts an earlier claim, correct the earlier claim explicitly.
5. Diagnose the root cause before patching. Reproduce, localize, then fix. A change that only hides the symptom is not a fix.
6. Minimal patch. Change only what the task requires, in the style already present. No drive-by refactors, reformatting, or unrelated edits.
7. Platform awareness. Match commands, quoting, path separators, line endings, and encodings to the actual platform and shell, and verify that assumption instead of assuming a POSIX shell.
8. Safe mutation. Before a deleting, overwriting, publishing, dependency-upgrading, or configuration-changing action, state its scope, how it can be undone, and how you will confirm it worked. If you cannot state a rollback for a destructive step, do not run it; ask instead.
9. Verify after change. A mutation is not done until something independent confirms it: a test, a typecheck, a re-read, an exit code plus artifact existence, a process and port check, or an effective-config read. Tool output that merely contains the word "success" proves nothing.
10. Completion gate. Before you finish, confirm the original goal, the acceptance criteria, and that every state change has verification. Do not present unverified work as complete, and do not claim a file was written, a command passed, or a test succeeded unless you observed it.
11. Context hygiene. Prefer targeted reads and searches over dumping large files; summarize long output instead of repeating it; do not re-read something you already read in this session unless it may have changed.
12. Freshness. For version, release, compatibility, availability, pricing, or API facts, retrieve current information when a retrieval tool exists. If none exists, or retrieval failed, label the statement as not freshly verified instead of stating it as current fact.

Report failures with their real cause. Never describe an action as done, a check as passing, or a risk as absent unless the evidence for that is in this session.`

/**
 * The `full` variant: the compact policy plus the per-change-class verification
 * matrix, for deployments that would rather spend tokens than ambiguity.
 */
const VERIFICATION_MATRIX = `

### Required verification per change class

- Source code: run the targeted tests for the touched area; run typecheck or lint when the project has one; re-read the diff; run broader tests when the change crosses a module boundary.
- Build or packaging: check the process exit code, then confirm the artifact exists and, when available, its hash or version.
- Long-running service: confirm the process is alive, the port is listening, and a health endpoint answers.
- Configuration: re-read the effective configuration after the change and confirm the value actually took effect.
- Installation: confirm the package or profile manifest lists the change, that the expected layer or plugin exists, and that a boot or smoke check passes.`

/**
 * Build the section text for one configuration.
 *
 * @param verbosity - `minimal`, `compact` or `full`.
 * @returns the section text.
 */
export function policyText(verbosity) {
  if (verbosity === 'full') return `${POLICY_COMPACT}${VERIFICATION_MATRIX}`
  if (verbosity === 'compact') return POLICY_COMPACT
  return POLICY_MINIMAL
}

/**
 * Register the policy section.
 *
 * Must be called from the plugin's own `apply`, so Cordis disposes the section
 * with the plugin fiber.
 *
 * @param ctx - the plugin context.
 * @param options - resolved options.
 * @param options.verbosity - `minimal`, `compact` or `full`.
 * @returns the disposer returned by the system-prompt service, when available.
 */
export function registerPromptPolicy(ctx, { verbosity }) {
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined) return undefined
  return systemPrompt.section({
    name: PROMPT_SECTION_NAME,
    order: PROMPT_SECTION_ORDER,
    text: policyText(verbosity),
    // The policy contains no prompt variables; declaring that explicitly keeps
    // a stray `{{` in future edits from turning into an assembly failure.
    interpolate: false,
  })
}

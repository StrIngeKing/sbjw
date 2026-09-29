/**
 * Configuration schema and derived runtime policy for dsh-reliability-guard.
 *
 * The schema is declared with `@deepseek-ai/schemastery`, the same schema
 * library the shipped DSH plugins use for `export const Config`. Every field
 * carries a description so the Web/Desktop Settings surface can derive a
 * readable form, and the fields are marked `.volatile()` so an operator can
 * retune a running session without a restart (the reason is recorded in
 * `docs/ADR-0001-reliability-guard.md`).
 *
 * @module dsh-reliability-guard/config
 */

import z from '@deepseek-ai/schemastery'

/** Guard intensity presets. Each preset only changes threshold defaults. */
export const MODES = ['balanced', 'strict', 'maximum']

/**
 * Threshold defaults per mode. `balanced` is deliberately conservative: it
 * blocks only after the shipped `dsh-repeat-tool-reminder` thresholds (3/5/8)
 * would already have warned twice, so the guard never supersedes the official
 * advisory with an earlier hard stop.
 */
const MODE_PRESETS = {
  balanced: {
    maxIdenticalRepeats: 5,
    maxBlindRetries: 2,
    semanticLoopThreshold: 3,
    maxNoopShellRun: 3,
    maxStallSteps: 6,
  },
  strict: {
    maxIdenticalRepeats: 4,
    maxBlindRetries: 2,
    semanticLoopThreshold: 3,
    maxNoopShellRun: 2,
    maxStallSteps: 5,
  },
  maximum: {
    maxIdenticalRepeats: 3,
    maxBlindRetries: 1,
    semanticLoopThreshold: 2,
    maxNoopShellRun: 1,
    maxStallSteps: 4,
  },
}

/**
 * Declared plugin configuration.
 *
 * `mode` supplies a preset for every numeric threshold; an explicitly
 * configured threshold always wins over the preset. `undefined` therefore
 * means "take the preset", which is why the numeric fields have no schema
 * default of their own.
 */
export const Config = z.object({
  mode: z
    .union(MODES.map((mode) => z.const(mode)))
    .default('balanced')
    .description('Guard intensity preset: balanced, strict or maximum. Explicit thresholds override the preset.'),

  maxIdenticalRepeats: z
    .number()
    .min(2)
    .max(20)
    .description('Consecutive byte-identical calls to the same tool with the same canonical arguments before the run is blocked (preset: balanced 5, strict 4, maximum 3).'),

  maxBlindRetries: z
    .number()
    .min(0)
    .max(10)
    .description('Consecutive failures of the same tool without any observed state change (different result content, a file-version change, or a new evidence record) before further attempts are blocked.'),

  semanticLoopThreshold: z
    .number()
    .min(2)
    .max(20)
    .description('Calls that are not byte-identical but canonicalize to the same tool and arguments (whitespace, quoting and comment differences only) before the run is blocked.'),

  maxNoopShellRun: z
    .number()
    .min(1)
    .max(20)
    .description('Consecutive pure no-op shell calls (echo / Write-Host / Write-Output / true / exit 0 and equivalent) that neither mutate state nor produce information before the run is blocked.'),

  maxStallSteps: z
    .number()
    .min(2)
    .max(200)
    .description('Consecutive steps in which no progress was observed (no mutation of tracked files, no new evidence, no passing verification) before the guard requests a plan change.'),

  repeatWindow: z
    .number()
    .min(2)
    .max(50)
    .default(12)
    .description('How many recent calls stay in the guard\'s per-session ring buffer when judging a repeat run.'),

  guard: z
    .object({
      exactRepeats: z.boolean().default(true).description('Detect byte-identical consecutive repeats.').volatile(),
      semanticRepeats: z.boolean().default(true).description('Detect argument-normalized semantic repeats.').volatile(),
      noopShell: z.boolean().default(true).description('Detect consecutive no-op shell calls.').volatile(),
      blindRetries: z.boolean().default(true).description('Detect blind retries that repeat a known failure without new evidence.').volatile(),
      stall: z.boolean().default(true).description('Detect no-progress stalls across steps.').volatile(),
    })
    .description('Individual loop detectors. Disabling one leaves the others active.'),

  risk: z
    .object({
      enabled: z.boolean().default(true).description('Classify state-changing calls as LOW / MEDIUM / HIGH / CRITICAL.').volatile(),
      requireRollbackPlan: z.boolean().default(true).description('Refuse HIGH/CRITICAL calls whose arguments state no rollback plan (fail closed).').volatile(),
      requireVerificationPlan: z.boolean().default(true).description('Refuse HIGH/CRITICAL calls whose arguments state no verification plan (fail closed).').volatile(),
      askOnCritical: z.boolean().default(true).description('Route CRITICAL calls through the official approval seam when no rollback and verification plan is stated.').volatile(),
      workspaceOnlyWhenUnscoped: z.boolean().default(true).description('Treat an unscoped recursive delete as workspace-scoped unless its path is clearly outside the workspace.').volatile(),
    })
    .description('Mutation risk classifier settings.'),

  review: z
    .object({
      enabled: z.boolean().default(true).description('Require an independent fresh-context reviewer before a high-risk or multi-file change is reported complete.').volatile(),
      highRiskOnly: z.boolean().default(true).description('Review only HIGH/CRITICAL risk changes; set false to review every mutating change.').volatile(),
      multiFileThreshold: z.number().min(1).max(100).default(3).description('Number of distinct mutated files in one turn that also triggers a review.').volatile(),
      maxRounds: z.number().min(1).max(10).default(1).description('Maximum reviewer rounds before the guard stops re-reviewing and reports the unresolved finding instead of looping.').volatile(),
    })
    .description('Independent reviewer gate settings.'),

  completionGate: z
    .object({
      enabled: z.boolean().default(true).description('Block the end of a turn when a mutation has no recorded verification, a failure is unexplained, or a material unknown remains.').volatile(),
      requireVerificationForMutation: z.boolean().default(true).description('要求每个变更路径都有变更后的对应状态验证。 / Require fresh matching-state verification for every changed path.').volatile(),
      maxInjectionsPerTurn: z.number().min(0).max(10).default(1).description('How many corrective messages the completion gate may inject in one turn before it stops (anti-loop bound).').volatile(),
    })
    .description('Completion gate settings.'),

  freshnessGate: z
    .object({
      enabled: z.boolean().default(true).description('Require a retrieval or an explicit stale marker before answering from memory about versioned external facts.').volatile(),
      maxAgeMinutes: z.number().min(1).max(10080).default(30).description('How long a retrieved external fact stays fresh for this session.').volatile(),
      topics: z
        .array(z.string())
        .default(['version', 'release', 'latest', 'compatib', 'api', 'deprecat', 'support', 'registry', 'npm', 'pypi', 'changelog', 'security', 'advisory'])
        .description('Case-insensitive substrings that mark a claim as an external fact, evaluated against the text the model is about to rely on.'),
    })
    .description('External-fact freshness gate settings.'),

  windows: z
    .object({
      enabled: z.boolean().default(true).description('Apply Windows/PowerShell-first diagnostics: encoding, quoting, path separators, CRLF, fresh-process semantics.').volatile(),
      warnOnNonAsciiCommandWithoutEncoding: z.boolean().default(true).description('Warn when a PowerShell command carries a non-ASCII path or literal without an explicit output encoding.').volatile(),
      warnOnCrlfSensitivePatch: z.boolean().default(true).description('Warn when an exact-string file edit is attempted against a file whose dominant line ending is CRLF.').volatile(),
    })
    .description('Windows-first environment checks.'),

  evidence: z
    .object({
      enabled: z.boolean().default(true).description('维护详细证据；关闭时保留完成门所需的最小变更与验证记账。 / Maintain detailed evidence; minimal mutation and verification accounting remains active when disabled.').volatile(),
      maxRecords: z.number().min(8).max(2000).default(200).description('Ledger capacity; the oldest non-load-bearing records are evicted first.').volatile(),
      injectDigest: z.boolean().default(false).description('Attach the evidence digest to corrective context. Off by default in the low-overhead profile; gap-specific evidence is still included.').volatile(),
      maxDigestChars: z.number().min(200).max(20000).default(1600).description('Hard cap for one injected evidence digest.').volatile(),
    })
    .description('Evidence ledger settings.'),

  prompt: z
    .object({
      enabled: z.boolean().default(true).description('Register the compressed reliability policy system-prompt section.').volatile(),
      verbosity: z
        .union([z.const('minimal'), z.const('compact'), z.const('full')])
        .default('minimal')
        .description('minimal is the low-overhead default; compact keeps the legacy detailed policy; full also adds the verification matrix.'),
    })
    .description('Prompt policy settings.'),

  diagnostics: z
    .object({
      enabled: z.boolean().default(true).description('Publish the reliability_guard diagnostics tool.').volatile(),
      includeSensitiveContent: z.boolean().default(false).description('Include raw tool arguments and command text in diagnostics. Off by default; never enable it in a shared log.').volatile(),
      runtimeShellTrace: z.boolean().default(false).description('Keep the temporary bounded shell-query runtime trace. Off by default after the 1.1.4 root cause was fixed.').volatile(),
      logLevel: z
        .union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')])
        .default('info')
        .description('Minimum level for Reliability Guard log lines.'),
    })
    .description('Diagnostics and logging settings.'),
})

/**
 * Resolve the mode preset and overlay every explicitly configured threshold.
 *
 * @param config - the validated plugin configuration.
 * @returns the effective numeric thresholds plus the original config.
 */
export function resolvePolicy(config) {
  const preset = MODE_PRESETS[config.mode] ?? MODE_PRESETS.balanced
  const pick = (declared, fallback) => (Number.isFinite(declared) ? declared : fallback)
  return {
    mode: config.mode,
    maxIdenticalRepeats: pick(config.maxIdenticalRepeats, preset.maxIdenticalRepeats),
    maxBlindRetries: pick(config.maxBlindRetries, preset.maxBlindRetries),
    semanticLoopThreshold: pick(config.semanticLoopThreshold, preset.semanticLoopThreshold),
    maxNoopShellRun: pick(config.maxNoopShellRun, preset.maxNoopShellRun),
    maxStallSteps: pick(config.maxStallSteps, preset.maxStallSteps),
  }
}

/**
 * Unwrap one declared configuration value.
 *
 * A `.volatile()` schemastery field resolves to a live accessor object rather
 * than to a plain value, so every read has to go through it. This function is
 * total: a plain value, an accessor, and an absent field all return something
 * usable, which keeps a schema change from turning into a runtime failure.
 *
 * @param value - the declared field.
 * @param fallback - the value to use when the field is absent.
 * @returns the current value, or the fallback.
 */
export function fieldValue(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'object' && typeof value.get === 'function') {
    try {
      const current = value.get()
      return current === undefined ? fallback : current
    } catch {
      return fallback
    }
  }
  return value
}

/** Read a boolean configuration field through {@link fieldValue}. */
function bool(value, fallback) {
  return fieldValue(value, fallback) === true
}

/**
 * Build a live view of the declared configuration.
 *
 * The view reads volatile fields at call time, so an operator who retunes the
 * guard from the Settings surface changes the running behavior without a
 * remount.
 *
 * @param config - the validated plugin configuration.
 * @returns an object whose `live()` returns plain, unwrapped fields.
 */
export function createConfigView(config = {}) {
  config = { ...config }
  for (const group of ['prompt', 'guard', 'risk', 'review', 'completionGate', 'freshnessGate', 'windows', 'evidence', 'diagnostics']) {
    config[group] ??= {}
  }
  const live = () => ({
    prompt: {
      enabled: bool(config.prompt.enabled, true),
      verbosity: fieldValue(config.prompt.verbosity, 'minimal'),
    },
    repeatWindow: fieldValue(config.repeatWindow, 12),
    guard: {
      exactRepeats: bool(config.guard.exactRepeats, true),
      semanticRepeats: bool(config.guard.semanticRepeats, true),
      noopShell: bool(config.guard.noopShell, true),
      blindRetries: bool(config.guard.blindRetries, true),
      stall: bool(config.guard.stall, true),
    },
    risk: {
      enabled: bool(config.risk.enabled, true),
      requireRollbackPlan: bool(config.risk.requireRollbackPlan, true),
      requireVerificationPlan: bool(config.risk.requireVerificationPlan, true),
      askOnCritical: bool(config.risk.askOnCritical, true),
      workspaceOnlyWhenUnscoped: bool(config.risk.workspaceOnlyWhenUnscoped, true),
    },
    review: {
      enabled: bool(config.review.enabled, true),
      highRiskOnly: bool(config.review.highRiskOnly, true),
      multiFileThreshold: fieldValue(config.review.multiFileThreshold, 3),
      maxRounds: fieldValue(config.review.maxRounds, 1),
    },
    completionGate: {
      enabled: bool(config.completionGate.enabled, true),
      requireVerificationForMutation: bool(config.completionGate.requireVerificationForMutation, true),
      maxInjectionsPerTurn: fieldValue(config.completionGate.maxInjectionsPerTurn, 1),
    },
    freshnessGate: {
      enabled: bool(config.freshnessGate.enabled, true),
      maxAgeMinutes: fieldValue(config.freshnessGate.maxAgeMinutes, 30),
      topics: fieldValue(config.freshnessGate.topics, []),
    },
    windows: {
      enabled: bool(config.windows.enabled, true),
      warnOnNonAsciiCommandWithoutEncoding: bool(config.windows.warnOnNonAsciiCommandWithoutEncoding, true),
      warnOnCrlfSensitivePatch: bool(config.windows.warnOnCrlfSensitivePatch, true),
    },
    evidence: {
      enabled: bool(config.evidence.enabled, true),
      maxRecords: fieldValue(config.evidence.maxRecords, 200),
      injectDigest: bool(config.evidence.injectDigest, false),
      maxDigestChars: fieldValue(config.evidence.maxDigestChars, 1600),
    },
    diagnostics: {
      enabled: bool(config.diagnostics.enabled, true),
      includeSensitiveContent: bool(config.diagnostics.includeSensitiveContent, false),
      runtimeShellTrace: bool(config.diagnostics.runtimeShellTrace, false),
      logLevel: fieldValue(config.diagnostics.logLevel, 'info'),
    },
  })
  return { live }
}

export default Config

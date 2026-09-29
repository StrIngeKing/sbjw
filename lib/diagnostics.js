/**
 * Diagnostics: a redacted, bounded snapshot of what the guard knows and did.
 *
 * Privacy rules are enforced here rather than at each call site:
 *
 * - raw conversation text is never stored by the guard at all;
 * - every emitted string passes through `redactSecrets`;
 * - tool arguments are omitted unless `includeSensitiveContent` is explicitly
 *   enabled, and even then only as a bounded, redacted preview;
 * - nothing is ever sent anywhere: diagnostics are returned to the caller and
 *   written to the host's own log.
 *
 * @module dsh-reliability-guard/diagnostics
 */

import { preview, redactSecrets } from './util.js'
import { RISK_LEVELS } from './risk.js'
import { readFileSync } from 'node:fs'
import { createConfigView, resolvePolicy } from './config.js'

export const PLUGIN_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

/** Version of the diagnostics payload shape. */
export const DIAGNOSTICS_VERSION = 1

/**
 * Build the diagnostics snapshot for one session.
 *
 * @param input - snapshot input.
 * @param input.policy - the resolved policy thresholds.
 * @param input.config - the effective plugin configuration.
 * @param input.state - the session state bucket, when a session is known.
 * @param input.ledger - the ledger for that session, when known.
 * @param input.sessionId - the session id, when known.
 * @param input.detail - whether to include per-session detail.
 * @param input.includeSensitiveContent - whether bounded argument previews are allowed.
 * @param input.now - the timestamp to stamp.
 * @returns a frozen, redacted snapshot.
 */
export function buildDiagnostics({
  policy,
  config,
  state,
  ledger,
  sessionId,
  detail = false,
  callSeq,
  toolsRegistered = false,
  includeSensitiveContent = false,
  now = Date.now(),
}) {
  policy ??= resolvePolicy({ mode: 'balanced', ...config })
  config = createConfigView(config).live()
  const report = {
    version: DIAGNOSTICS_VERSION,
    pluginVersion: PLUGIN_VERSION,
    generatedAt: new Date(now).toISOString(),
    plugin: 'dsh-reliability-guard',
    toolsRegistered,
    policy: {
      mode: policy.mode,
      maxIdenticalRepeats: policy.maxIdenticalRepeats,
      maxBlindRetries: policy.maxBlindRetries,
      semanticLoopThreshold: policy.semanticLoopThreshold,
      maxNoopShellRun: policy.maxNoopShellRun,
      maxStallSteps: policy.maxStallSteps,
    },
    features: {
      promptPolicy: config.prompt.enabled,
      promptVerbosity: config.prompt.verbosity,
      evidenceLedger: config.evidence.enabled,
      loopGuard: config.guard,
      riskClassifier: config.risk.enabled,
      review: { enabled: config.review.enabled, highRiskOnly: config.review.highRiskOnly, maxRounds: config.review.maxRounds },
      completionGate: config.completionGate.enabled,
      freshnessGate: config.freshnessGate.enabled,
      windowsChecks: config.windows.enabled,
      sensitiveContent: includeSensitiveContent,
      runtimeShellTrace: config.diagnostics.runtimeShellTrace,
    },
  }

  if (state === undefined) {
    report.session = { present: false, note: 'no session state exists yet in this process' }
    return Object.freeze(deepClone(report))
  }

  report.session = {
    present: true,
    id: sessionId === undefined ? undefined : String(sessionId),
    disposed: state.disposed,
    calls: state.seq,
    history: state.history ?? { storage: 'unavailable', status: 'history-unavailable' },
    mutatedFilesInTurn: state.mutatedFiles.size,
    mutatedFilesInSession: state.sessionMutatedFiles.size,
    pendingMutations: ledger?.pendingMutations().length,
    unresolvedMutationRisks: state.unresolvedMutationCount,
    reviewDeferredToParent: state.reviewDeferredToParent === true,
    reviewUnavailable: state.reviewUnavailable,
    riskCounts: countByRisk(state.calls),
    highRiskCalls: state.highRiskCalls,
    counters: { ...state.counters },
    gate: state.gate === undefined ? undefined : { injections: state.gate.injections, lastPassed: state.gate.lastPassed },
    review: state.review === undefined ? undefined : { required: state.review.required, round: state.review.round, verdict: state.review.verdict?.verdict, cappedOut: state.review.cappedOut },
    freshness: state.freshness.size === 0 ? undefined : { topics: state.freshness.size, newestAt: newestFreshness(state.freshness) },
  }

  if (config.diagnostics.includeSensitiveContent && includeSensitiveContent) {
    report.samples = state.calls.slice(-5).map((call) => ({
      toolName: call.toolName,
      risk: call.risk,
      ok: call.isError !== true,
      argumentsPreview: call.argumentsPreview === undefined ? undefined : preview(redactSecrets(call.argumentsPreview), 200),
    }))
  }

  if (detail) {
    report.evidence = ledger === undefined ? undefined : ledger.summary()
    report.unexplainedFailures = state.unexplainedFailures.map((item) => redactSecrets(item.text))
    report.failureDetails = state.unexplainedFailures.map(({ id, at, text }) => ({ id, at, text: redactSecrets(text) }))
    report.resolvedFailures = state.resolvedFailures.slice(-10)
    report.unknowns = state.unknowns.map((item) => redactSecrets(item.text))
    report.unknownDetails = state.unknowns.map(item => ({ id: item.id, at: item.at, text: redactSecrets(item.text) }))
    report.overturned = state.overturned.map((item) => ({ path: redactSecrets(item.path), reason: redactSecrets(item.reason) }))
    const targetView = target => ({
      path: redactSecrets(target.path ?? target.key ?? ''),
      expected: target.expected,
      source: typeof target.source === 'string' ? target.source : undefined,
    })
    report.verifications = state.verifications.slice(-20).map((item) => ({ kind: item.kind, passed: item.passed, strong: item.strong, toolName: item.toolName, at: item.at, startSeq: item.startSeq, targets: item.targets.slice(0, 20).map(targetView) }))
    if (config.diagnostics.runtimeShellTrace) report.shellQueryDiagnostics = (state.shellQueryDiagnostics ?? []).slice(-8).map(item => ({
      at: item.at,
      execName: redactSecrets(String(item.execName ?? '')),
      argumentKeys: Array.isArray(item.argumentKeys) ? item.argumentKeys.slice(0, 40).map(key => redactSecrets(String(key))) : [],
      commandType: item.commandType,
      commandPreview: redactSecrets(String(item.commandPreview ?? '')),
      shellCommandDefined: item.shellCommandDefined === true,
      shellCommandPreview: item.shellCommandPreview === undefined ? undefined : redactSecrets(String(item.shellCommandPreview)),
      verificationQueries: Array.isArray(item.verificationQueries) ? item.verificationQueries.slice(0, 20).map(query => ({ ...query, path: redactSecrets(String(query.path ?? '')) })) : [],
      directShellReadQueries: Array.isArray(item.directShellReadQueries) ? item.directShellReadQueries.slice(0, 20).map(query => ({ ...query, path: redactSecrets(String(query.path ?? '')) })) : [],
      error: item.error === undefined ? undefined : redactSecrets(String(item.error)),
    }))
    report.mutations = state.mutationEvents.slice(-20).map(item => ({
      ...targetView(item),
      at: item.at,
      startSeq: item.startSeq,
      toolName: item.toolName,
      risk: item.risk,
      before: item.before,
      coveredBy: ledger?.covering(item)?.at,
      supersededBy: item.supersededBy ?? (state.mutations.get(item.key)?.at > item.at ? state.mutations.get(item.key).at : undefined),
    }))
    const riskView = item => ({ ...item, command: preview(redactSecrets(item.command ?? ''), 2000), targets: item.targets?.map(targetView) })
    report.unresolvedMutationRisks = state.unresolvedMutations.filter(item => item.resolvedAt === undefined).slice(0, 20).map(riskView)
    report.reconciliations = state.unresolvedMutations.filter(item => item.resolvedAt !== undefined).slice(-5).map(riskView)
    if (callSeq !== undefined) report.focus = {
      call_seq: callSeq,
      risks: state.unresolvedMutations.filter(item => item.at === callSeq).map(riskView),
      mutations: state.mutationEvents.filter(item => item.at === callSeq).map(item => ({ ...targetView(item), at: item.at, before: item.before })),
    }
    report.resolvedUnknowns = state.resolvedUnknowns.slice(-10)
  }

  return Object.freeze(deepClone(report))
}

function countByRisk(calls) {
  const counts = { UNKNOWN: 0 }
  for (const level of RISK_LEVELS) counts[level] = 0
  for (const call of calls) {
    const level = call.risk
    if (level !== undefined && Object.hasOwn(counts, level)) counts[level] += 1
    else counts.UNKNOWN += 1
  }
  return counts
}

function newestFreshness(freshness) {
  let newest
  for (const record of freshness.values()) {
    if (newest === undefined || record.at > newest) newest = record.at
  }
  return newest === undefined ? undefined : new Date(newest).toISOString()
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * Render a snapshot as the short text the model reads.
 *
 * @param report - the snapshot from {@link buildDiagnostics}.
 * @returns bounded diagnostic text.
 */
export function renderDiagnostics(report) {
  if (report.focus) return redactSecrets(JSON.stringify({ pluginVersion: report.pluginVersion, toolsRegistered: report.toolsRegistered, history: report.session?.history, ...report.focus }, null, 2)).slice(0, 4000)
  const lines = [
    `reliability-guard diagnostics v${report.version} (${report.generatedAt})`,
    `plugin version / 插件版本: ${report.pluginVersion}`,
    `toolsRegistered: ${report.toolsRegistered}`,
    `mode: ${report.policy.mode} — identical-repeat block at ${report.policy.maxIdenticalRepeats}, semantic ${report.policy.semanticLoopThreshold}, no-op shell ${report.policy.maxNoopShellRun}, blind retries ${report.policy.maxBlindRetries}, stall ${report.policy.maxStallSteps}`,
  ]
  if (report.session?.present !== true) {
    lines.push('session: none recorded yet')
    return lines.join('\n')
  }
  const session = report.session
  lines.push(`session: ${session.id ?? '(unknown)'}`)
  lines.push(`history / 历史: ${JSON.stringify(session.history)}; reset is NOT resolved / 重置不等于解决`)
  if (session.reviewDeferredToParent) lines.push('independent review: DEFERRED TO PARENT (not PASS) / 子会话评审交回父会话')
  if (session.reviewUnavailable) lines.push(`review unavailable: ${session.reviewUnavailable}`)
  lines.push(`pending mutation verification / 待验证事项: ${session.pendingMutations === undefined ? 'unknown' : session.pendingMutations + (session.unresolvedMutationRisks ?? 0)} (confirmed changes: ${session.pendingMutations ?? 'unknown'}; unresolved mutation risks: ${session.unresolvedMutationRisks ?? 0})`)
  lines.push(`session calls: ${session.calls}; risk counts: ${JSON.stringify(session.riskCounts)}`)
  lines.push(
    `mutations: ${session.mutatedFilesInSession} file(s) this session; gate injections: ${session.gate?.injections ?? 0}; review: ${session.review?.verdict ?? (session.review?.required === true ? 'required, no verdict yet' : 'not required')}`,
  )
  const counters = Object.entries(session.counters)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${key}=${value}`)
  lines.push(`counters: ${counters.length === 0 ? '(none)' : counters.join(', ')}`)
  if (report.resolvedFailures?.length) lines.push(`explained failures / 已解释失败: ${report.resolvedFailures.slice(-3).map(item => `${item.id} (${item.resolution}; caller explanation, not PASS): ${preview(item.reason, 120)}`).join(' | ')}`)
  for (const item of (report.failureDetails ?? []).slice(-4)) lines.push(`failure id=${item.id} at=${item.at}: ${preview(item.text, 160)}`)
  if (session.counters.noticesInjected) lines.push(`notices by type: ${JSON.stringify(session.counters.noticesByTag)}`)
  if (session.freshness !== undefined) lines.push(`external retrievals recorded: ${session.freshness.topics}`)
  if ((report.shellQueryDiagnostics ?? []).length > 0) {
    lines.push('shell-query runtime diagnostic / Shell 查询运行时诊断（1.1.3 临时）:')
    for (const item of report.shellQueryDiagnostics.slice(-4)) {
      lines.push(`shell-query #${item.at}: exec.name=${JSON.stringify(item.execName)}; args.keys=${JSON.stringify(item.argumentKeys)}; typeof args.command=${item.commandType}; shellCommandOf=${item.shellCommandDefined ? JSON.stringify(item.shellCommandPreview ?? '') : 'undefined'}`)
      lines.push(`  command[0:200]=${JSON.stringify(item.commandPreview ?? '')}`)
      lines.push(`  verificationQueries=${JSON.stringify(item.verificationQueries ?? [])}`)
      lines.push(`  shellReadQueries(runtime-mode)=${JSON.stringify(item.directShellReadQueries ?? [])}${item.error ? `; diagnosticError=${item.error}` : ''}`)
    }
  }
  if (report.evidence !== undefined) {
    lines.push(
      `evidence: ${report.evidence.observedFiles} observed / ${report.evidence.staleFiles} stale; verifications ${report.evidence.verifications}; unexplained failures ${report.evidence.unexplainedFailures}; unknowns ${report.evidence.unknowns}`,
    )
  }
  if ((report.unexplainedFailures ?? []).length > 0) lines.push(`open failures: ${report.unexplainedFailures.join(' | ')}`)
  if ((report.unknowns ?? []).length > 0) lines.push(`open unknowns: ${report.unknowns.join(' | ')}`)
  if (report.mutations) {
    for (const item of report.mutations.slice(-5)) {
      const pre = item.before?.present === true
        ? `; pre-state observed: present${item.before.type ? ` type=${item.before.type}` : ''}${Number.isFinite(item.before.size) ? ` size=${item.before.size}` : ''}`
        : item.before?.present === false ? '; pre-state observed: absent' : ''
      lines.push(`mutation #${item.at}: ${item.path} -> ${item.expected}${pre}; ${item.supersededBy ? `superseded by #${item.supersededBy}` : `covering verification: ${item.coveredBy ?? 'NONE'}`}`)
    }
    for (const item of (report.unresolvedMutationRisks ?? []).slice(0, 3)) lines.push(`unresolved risk #${item.at} (${item.toolName}): ${item.reason}; command: ${preview(item.command, 600)}; declared targets: ${JSON.stringify(item.targets ?? [])}`)
    if (report.reconciliations?.length) lines.push(`reconciled calls: ${report.reconciliations.map(r => `#${r.at}`).join(', ')}; scope was caller-declared, current target states independently observed / 范围来自声明，当前状态已观测`)
    for (const item of report.unknownDetails ?? []) lines.push(`unknown id=${item.id} at=${item.at}: ${item.text}`)
    for (const item of (report.verifications ?? []).slice(-5)) lines.push(`check #${item.at}: ${item.kind} ${item.passed ? 'PASS' : 'FAIL'}; strong=${item.strong}; targets=${JSON.stringify(item.targets)}`)
  }
  return lines.join('\n').slice(0, 4000)
}

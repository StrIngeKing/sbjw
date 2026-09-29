/**
 * dsh-reliability-guard — a reliability guard for DeepSeek Harness.
 *
 * The plugin is a set of deterministic gates wired to official seams only. It
 * never monkey-patches an internal object, never replaces a shipped service,
 * and never implements its own permission system:
 *
 * | Concern | Official seam |
 * |---|---|
 * | Pre-call policy, allow/deny/ask | `tools/pre-execute` waterfall |
 * | Post-call inspection and correction | `tools/post-execute` waterfall |
 * | Final, observe-only outcome | `tools/result` event |
 * | Operating rules in the prompt | `ctx.systemPrompt.section` |
 * | Per-session state | session-scoped bucket owned by this plugin |
 * | Human approval | the shipped `approval` service via a `{kind:'ask'}` verdict |
 * | Sandbox / permission mode | read-only via `ctx.sandboxPolicy` |
 * | File identity and staleness | `ctx.fs` versions and the `fs/observed` event |
 * | Keeping a turn alive to fix a gap | `additionalContexts` (driver-owned next-step delivery) |
 * | Independent review | the shipped `subagent` tool, driven by a prompt injection |
 *
 * @module dsh-reliability-guard
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { Checkpoints, openCounts } from './checkpoints.js'
import { shellMutationFacts, pathKey } from './shell-facts.js'
import { verificationQueries } from './verification.js'
import { collectReadEvidence } from './observations.js'
import { registerReconciliationTool, settleReconciliations } from './reconciliation.js'
import { Config as GuardConfig, createConfigView, resolvePolicy } from './config.js'
import { GuardLogger, SessionStates, publishSessionStates, withdrawSessionStates } from './state.js'
import { registerPromptPolicy } from './prompt.js'
import { EvidenceLedger } from './evidence.js'
import { classifyRisk, detectRollbackIntent, detectVerificationIntent, extractShellPaths, riskRank, statedPlanOf } from './risk.js'
import { isNoopShellCommand, shellCommandOf } from './noop-shell.js'
import {
  judgeVerification,
  parseReviewVerdict,
  parseVerificationSignals,
  renderGateMessage,
  renderReviewPrompt,
  verificationIntent,
} from './verification.js'
import { buildDiagnostics, renderDiagnostics } from './diagnostics.js'
import { captureShellQueryDiagnostic, noteShellQueryDiagnostic } from './runtime-diagnostics.js'
import { canAdvise, canInject, evaluateCompletionGate, gapLines, noteAdvisory } from './completion-gate.js'
import { consumeRetrieval, evaluateFreshness } from './freshness.js'
import { evaluateLineEndings, evaluateWindowsShellCall } from './windows.js'
import { detectUnknownDeclarations } from './declarations.js'
import { canonicalize, errorMessage, normalizeCommand, preview, redactSecrets, weakFingerprint } from './util.js'

/** Cordis plugin name, shown in the loader and diagnostics. */
export const name = 'reliability-guard'

/** Service dependencies. The tool pipeline is required for every feature. */
export const inject = ['tools']

/** The declared configuration schema. */
export { GuardConfig as Config }

/** Per-execution classification, keyed by the execution object. */
const executionFacts = new WeakMap()

/** The source kind stamped on every message the guard injects. */
const GUARD_SOURCE = 'reliability-guard'

/**
 * The guard's own published namespace.
 *
 * The Cordis loader hands a plugin either the module namespace or its
 * `default` export, so this object carries both the plugin face (`name`,
 * `Config`, `apply`, `inject`) and the observability key described in
 * `state.js`. The named exports above remain the authoritative plugin face for
 * consumers that import the module directly.
 */
const pluginNamespace = { name, inject, Config: GuardConfig, apply }

export { pluginNamespace as default }

/**
 * Install the guard.
 *
 * @param ctx - the plugin context; every registration is disposed with it.
 * @param config - the validated configuration.
 */
export function apply(ctx, config) {
  const policy = resolvePolicy(config)
  const view = createConfigView(config)
  const logger = new GuardLogger(ctx.logger, view.live().diagnostics.logLevel)
  const checkpoints = new Checkpoints(ctx.get('profileContext')?.dir, logger)
  const states = new SessionStates(logger, checkpoints)

  // Publish the read-only session-state registry for observability and tests,
  // keyed by this context so two contexts never share state through it.
  publishSessionStates(pluginNamespace, ctx, states)

  // Release every bucket when this plugin unloads, so a reload or an uninstall
  // retains nothing.
  ctx.effect(() => () => {
    states.disposeAll()
    withdrawSessionStates(pluginNamespace, ctx)
  }, 'reliability-guard.stateOwnership()')

  if (view.live().prompt.enabled) {
    try {
      const disposer = registerPromptPolicy(ctx, { verbosity: view.live().prompt.verbosity })
      if (disposer === undefined) {
        logger.warn('the systemPrompt service is not composed; the reliability policy section was not registered')
      } else {
        logger.debug('registered the reliability policy prompt section')
      }
    } catch (error) {
      // A second instance in the same scope cannot register the same section
      // name. That is a composition detail, not a reason to fail the whole
      // guard: the gates and the diagnostics tool still work without the policy
      // text, and a genuine reload registers it normally.
      logger.warn(`the reliability policy section could not be registered: ${errorMessage(error)}`)
    }
  }

  registerGuardTools(ctx, view, policy, states, logger)

  ctx.on('session/disposed', (session) => {
    const released = states.dispose(session)
    logger.debug(released ? 'released session state on dispose' : 'session dispose observed with no state to release')
  })

  ctx.on('agent/created', ({ agent }) => {
    const state = states.get(agent.session)
    logger.debug(`agent created; session state ready (${state.key})`)
  })

  // Official file observations from any actor invalidate this session's record
  // of the same target. Observers on this event must be synchronous.
  ctx.on('fs/observed', (target, observation, actor) => {
    const facts = executionFacts.get(actor)
    const queryPath = pathKey(target?.displayPath ?? target, actor?.agent?.session?.header?.cwd)
    if (facts && ['present', 'absent'].includes(observation?.kind)) facts.observations.set(queryPath, observation.kind)
    if (!view.live().evidence.enabled) return
    const session = actor?.agent?.session
    if (session === undefined) return
    const state = states.peek(session)
    if (state === undefined) return
    const ledger = ledgerOf(state, view.live())
    if (observation?.kind === 'absent') {
      ledger.invalidate(target, 'the file was observed as absent')
      return
    }
    if (observation?.kind !== 'present') return
    const stored = ledger.get(target)
    if (stored !== undefined && stored.kind === 'present' && String(stored.version) !== String(observation.version)) {
      ledger.invalidate(target, 'another actor changed the file after it was read')
    }
  })

  // The durable session log is the only place the model's own statements and
  // the originating request appear, so the ledger learns them here.
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/start') {
      const state = states.peek(session)
      if (state !== undefined) {
        const beforeReset = openCounts(state)
        state.currentTurn = Number(event.data?.turn ?? state.currentTurn + 1)
        // The call sequence is the reliable turn boundary: later turns may be
        // appended without the guard observing every event, so the gate compares
        // sequences rather than turn numbers.
        state.turnStartSeq = state.seq
        state.mutatedFiles.clear()
        state.mutations.clear()
        state.unresolvedMutationCount = 0
        state.unresolvedMutations = []
        state.mutationEvents = []
        state.mutationSinceVerification = false
        state.verifications = []
        state.gate = undefined
        state.review = undefined
        state.reviewUnavailable = undefined
        state.highRiskCalls = 0
        checkpoints.noteTurnReset(state, beforeReset)
        states.checkpoint(session)
      }
      return
    }
    if (event?.type === 'user/message' || event?.type === 'agent/inbox/spliced') {
      const state = states.peek(session)
      if (state === undefined) return
      const text = userTextOf(event.data)
      if (text !== '') state.requirement = preview(redactSecrets(text), 1200)
      return
    }
    if (event?.type !== 'assistant/message') return
    const state = states.peek(session)
    if (state === undefined) return
    const text = messageTextOf(event.data)
    if (text === '') return
    if (view.live().evidence.enabled) {
      const ledger = ledgerOf(state, view.live())
      for (const unknown of detectUnknownDeclarations(text)) ledger.noteUnknown(unknown, 'assistant-message')
    }
    if (view.live().freshnessGate.enabled) {
      const verdict = evaluateFreshness({
        text,
        topics: view.live().freshnessGate.topics,
        retrievals: state.freshness,
        maxAgeMinutes: view.live().freshnessGate.maxAgeMinutes,
      })
      if (!verdict.passed) {
        state.pendingFreshness = verdict.gaps
        state.counters.freshnessWarnings += 1
        logger.debug(`freshness gate flagged ${verdict.claims.length} external claim(s) without a relevant retrieval`)
      } else {
        state.pendingFreshness = undefined
      }
      state.freshnessClaimText = verdict.claims.map(claim => redactSecrets(claim.text)).join('\n')
    }
    states.checkpoint(session)
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await guardCall(ctx, exec, { view, policy, states, logger })
    if (decision !== undefined) return decision
    const state = exec.agent?.session && states.peek(exec.agent.session)
    if (state && executionFacts.get(exec)?.risk?.mutation !== 'never') {
      state.inFlightRiskCalls ??= new Set()
      state.inFlightRiskCalls.add(executionFacts.get(exec).startSeq)
      states.checkpoint(exec.agent.session)
    }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    // Cordis waterfall semantics: this listener receives the tool result as its
    // second argument, while `next()` resolves to the DECISION produced further
    // down the chain (`{kind:'accept'|'block', ...}`) — not to a tool result.
    // Both are needed: the result is the evidence, and the decision must be
    // preserved so a downstream block is never silently converted into success.
    const decision = await next()
    let observed = false
    try {
      const outcome = await observeResult(ctx, exec, result, decision, { view, policy, states, logger })
      observed = true
      return outcome
    } finally {
      const session = exec.agent?.session
      if (session) {
        if (observed) states.peek(session)?.inFlightRiskCalls?.delete(executionFacts.get(exec)?.startSeq)
        states.checkpoint(session)
      }
    }
  })

  logger.info(
    `armed (mode=${policy.mode}; identical-repeat block at ${policy.maxIdenticalRepeats}, semantic ${policy.semanticLoopThreshold}, no-op shell ${policy.maxNoopShellRun}, blind retries ${policy.maxBlindRetries}, stall ${policy.maxStallSteps})`,
  )
}

/**
 * The pre-execute gate: classify, detect, and decide.
 *
 * @returns a decision to return, or `undefined` to continue the waterfall.
 */
async function guardCall(ctx, exec, { view, policy, states, logger }) {
  const config = view.live()
  const workspaceOnlyWhenUnscoped = config.risk.workspaceOnlyWhenUnscoped
  const session = exec.agent?.session
  if (session === undefined) return undefined
  const state = states.get(session)
  state.seq += 1
  // The retained call history follows the configured window.
  state.callWindowSize = config.repeatWindow

  const toolName = String(exec.name)
  const args = exec.arguments
  const workspaceRoot = sessionWorkspaceRoot(ctx, session)
  if (state.workspaceRoot === undefined) state.workspaceRoot = workspaceRoot
  const delegationDepth = Math.max(session.header?.delegationDepth ?? 0, exec.agent?.options?.subagentDepth ?? 0)
  state.reviewDeferredToParent = delegationDepth > 0 || session.header?.origin === 'subagent'

  const facts = {
    startSeq: state.seq,
    queries: verificationQueries(toolName, args, workspaceRoot),
    observations: new Map(),
    // Machine checks cover only changes already recorded when they started.
    verificationTargets: [...state.mutations.values()].map(change => ({ path: change.key, expected: change.expected })),
    risk: classifyRisk({ toolName, args, workspaceRoot, workspaceOnlyWhenUnscoped }),
    intent: verificationIntent(toolName, args),
    noopShell: false,
    signature: `${toolName}::${canonicalize(args)}`,
    semanticSignature: semanticSignature(toolName, args),
    plan: statedPlanOf(args),
    findings: [],
    rollbackIntent: undefined,
    verificationIntentSeen: undefined,
    rollbackSignal: undefined,
    /** Version of each named path before the call, for the post-call diff. */
    preVersions: undefined,
  }
  executionFacts.set(exec, facts)
  state.counters.preExecuteChecked += 1

  // Temporary 1.1.3 observability for the Desktop shell-query seam. Capture
  // any command-shaped call, including unexpected runtime tool names, so the
  // diagnostic can distinguish an args/name mismatch from a parser/consumer
  // failure. Instrumentation is bounded and must never affect the call.
  if (typeof args?.command === 'string' || /(?:pwsh|powershell|bash|shell|cmd)/i.test(toolName)) {
    try {
      noteShellQueryDiagnostic(state, captureShellQueryDiagnostic({
        toolName,
        args,
        workspaceRoot,
        startSeq: facts.startSeq,
      }))
    } catch (error) {
      logger.debug(`shell-query diagnostic capture failed: ${errorMessage(error)}`)
    }
  }

  // A call the guard itself refuses must not be recorded as a new unexplained
  // failure: the refusal is already delivered to the model as the error text,
  // and treating it as a fresh unexplained failure would block an unrelated,
  // fully verified turn until the refused command were re-run.
  facts.guardDenied = false

  const command = shellCommandOf(toolName, args)
  facts.shellMutation = command === undefined ? undefined : shellMutationFacts(command, { powershell: toolName === 'pwsh' })
  if (command !== undefined) facts.noopShell = isNoopShellCommand(command)

  collectEnvironmentFindings(facts, { toolName, args, config, state, logger })

  // A literal edit against a file with the opposite line ending can never match.
  // The text is read through the session's own filesystem provider, so the check
  // uses exactly what the edit will see, and it stays advisory.
  if (config.windows.enabled && toolName === 'edit') {
    const fileText = await readTargetText(ctx, exec, args, logger)
    for (const finding of evaluateLineEndings({ toolName, args, fileText, config: config.windows })) {
      facts.findings.push(finding)
      state.counters.windowsWarnings += 1
      logger.debug(`windows advisory (${finding.code}) on ${toolName}: ${finding.message}`)
    }
    if (facts.findings.length > 0) facts.risk = { ...facts.risk, environmentalNotes: facts.findings.map((finding) => finding.code) }
  }

  const loopVerdict = detectLoop(state, facts, policy, config, toolName)
  trackRuns(state, facts, toolName)
  if (loopVerdict !== undefined) {
    // A blocked call still flows through post-execute, which keeps the run
    // counters advancing: a model hammering a denial is exactly the loop worth
    // breaking.
    state.counters.blockedLoops += 1
    if (loopVerdict.kind === 'no-op-shell') state.counters.noopShellBlocked += 1
    if (loopVerdict.kind === 'blind-retry') state.counters.blindRetriesBlocked += 1
    logger.info(`${loopVerdict.kind} blocked: ${redactSecrets(loopVerdict.summary)}`)
    facts.guardDenied = true
    return {
      kind: 'deny',
      reason: renderDenial(loopVerdict, state, config),
      info: { code: `RELIABILITY_GUARD_${loopVerdict.kind.toUpperCase().replace(/-/g, '_')}`, source: GUARD_SOURCE },
    }
  }

  if (config.risk.enabled) {
    const riskDecision = evaluateRisk(facts, { config, logger, state, workspaceRoot })
    if (riskDecision !== undefined) {
      facts.guardDenied = true
      return riskDecision
    }
  }

  // Snapshot the version of every path this call names, so a tool the
  // classifier does not know as a writer can still be recognized as one when
  // the version actually changes. This is the compensating mechanism for
  // `mutation: 'possible'`.
  if (facts.risk.mutation !== 'never' || facts.shellMutation?.unresolved.length) facts.preVersions = await snapshotNamedPaths(ctx, exec, facts, logger)

  return undefined
}

/**
 * Read the current version of every path a call names.
 *
 * Only the filesystem's own opaque version is read, never file content, and a
 * missing `fs` service or an unresolvable path simply yields no entry.
 *
 * @param ctx - the plugin context.
 * @param exec - the execution about to run.
 * @param state - the session state bucket.
 * @param logger - the guard logger.
 * @returns a `Map` of path to `{ version, type, size, present, target }`, possibly empty.
 */
async function snapshotNamedPaths(ctx, exec, facts, logger) {
  const fs = ctx.get('fs')
  const paths = facts.shellMutation?.targets ?? namedPathsOf(exec.arguments)
  if (paths.length === 0) return undefined
  if (fs === undefined) { if (facts.shellMutation) facts.observationGap = 'filesystem service unavailable for mutation targets'; return undefined }
  const session = exec.agent?.session
  const cwd = session?.header?.cwd
  const snapshot = new Map()
  for (const path of paths) {
    try {
      const target = await fs.resolve(path, { cwd })
      const info = await fs.stat(target, exec.signal)
      snapshot.set(path, { version: info?.version, type: info?.type, size: info?.size, present: info !== undefined, target })
    } catch (error) {
      if (facts.shellMutation) facts.observationGap = 'could not observe every mutation target before execution'
      // An unresolvable path is not an error for the guard: it only means this
      // call cannot be judged by a version diff.
      logger.debug(`could not snapshot "${path}" before the call: ${errorMessage(error)}`)
    }
  }
  return snapshot.size === 0 ? undefined : snapshot
}

/**
 * Every path-like argument a call names.
 *
 * @param args - the parsed arguments.
 * @returns the candidate paths.
 */
function namedPathsOf(args) {
  if (args === null || typeof args !== 'object') return []
  const found = []
  for (const key of ['file_path', 'path', 'target', 'destination', 'source', 'output', 'out']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') found.push(value)
  }
  // Shell commands name their targets inside the text.
  if (typeof args.command === 'string') {
    for (const candidate of extractShellPaths(args.command)) found.push(candidate)
  }
  return [...new Set(found)].slice(0, 12)
}

/** Apply the risk policy to a classified call. */
function evaluateRisk(facts, { config, logger, state, workspaceRoot }) {
  const risk = facts.risk
  const rank = riskRank(risk.risk)
  if (rank < riskRank('MEDIUM')) return undefined

  facts.rollbackIntent = detectRollbackIntent(facts.plan)
  facts.verificationIntentSeen = detectVerificationIntent(facts.plan)
  facts.rollbackSignal = risk.rollbackSignal ?? facts.rollbackIntent

  if (rank < riskRank('HIGH')) return undefined

  const missing = []
  if (config.risk.requireRollbackPlan && facts.rollbackSignal === undefined && risk.reversible !== true) missing.push('rollback')
  if (config.risk.requireVerificationPlan && facts.verificationIntentSeen === undefined) missing.push('verification')
  if (missing.length === 0) {
    // Only a high-risk call that actually proceeds is a reason to require a
    // review: a refusal is already answered, and counting it would demand a
    // review of work that never happened.
    state.highRiskCalls += 1
    logger.debug(`${risk.risk}-risk call allowed with a stated plan (${risk.ruleId})`)
    return undefined
  }

  const summary = `${risk.risk} risk (${risk.reason}); missing: ${missing.join(' + ')}; scope: ${risk.scope}`
  if (config.risk.askOnCritical && rank >= riskRank('CRITICAL')) {
    state.counters.asked += 1
    logger.info(`routing to approval: ${summary}`)
    return {
      kind: 'ask',
      reason: `Reliability Guard: ${summary}. Approve only if you accept this change without a stated rollback or verification plan.`,
      displayReason: 'Reliability Guard: irreversible high-risk action without a stated rollback or verification plan',
    }
  }

  state.counters.deniedHighRisk += 1
  logger.warn(`denied: ${summary}`)
  return {
    kind: 'deny',
    reason: renderRiskDenial(risk, missing, workspaceRoot),
    info: { code: 'RELIABILITY_GUARD_RISK', source: GUARD_SOURCE },
  }
}

/**
 * Return a downstream decision untouched.
 *
 * A `tools/post-execute` listener must return a DECISION, never the tool result:
 * the registry reads the returned object as a decision, and a result carries
 * both `content` and `value`, which the registry rejects as contradictory
 * replacements.
 *
 * @param decision - the value `next()` resolved to.
 * @returns the decision unchanged.
 */
function passthrough(decision) {
  return decision
}

/**
 * The post-execute observer: record evidence, detect the changed outcome, and
 * inject the corrections that keep a turn honest.
 */
async function observeResult(ctx, exec, result, decision, { view, policy, states, logger }) {
  // A downstream `block` is that listener's verdict and owns the outcome: the
  // guard records the blocked attempt but never rewrites the decision.
  const blocked = decision !== null && typeof decision === 'object' && decision.kind === 'block'

  const config = view.live()
  const session = exec.agent?.session
  if (session === undefined) return passthrough(decision)
  const state = states.peek(session)
  if (state === undefined) return passthrough(decision)
  const facts = executionFacts.get(exec)
  if (facts === undefined) return passthrough(decision)

  const ledger = ledgerOf(state, config)
  const text = contentText(result)
  const toolName = String(exec.name)
  const failed = result?.isError === true || blocked
  const call = ledger.recordCall({
    toolName,
    isError: failed,
    contentText: text,
    signature: facts.signature,
    argumentsPreview: facts.plan === '' ? undefined : facts.plan,
  })
  call.risk = facts.risk?.risk

  // A shell command (or any tool the classifier does not know as a writer) is
  // judged by what actually changed on disk, not by its name.
  if (!facts.guardDenied && facts.preVersions !== undefined) {
    facts.versionChanged = await detectVersionChanges(ctx, facts, exec, logger)
  }

  // A command can change files before failing. Record observed effects even
  // when the command or a downstream post-execution check reports failure.
  if (!facts.guardDenied) {
    for (const { path, expected, type, before } of facts.versionChanged ?? []) {
      if (facts.risk?.mutation === 'definite' && !result?.isError && !blocked) continue
      ledger.noteMutation(path, facts.risk?.risk ?? 'MEDIUM', { expected, type, toolName, startSeq: facts.startSeq, before })
      if (config.evidence.enabled) ledger.invalidate(path, 'observed file change during a mutating call')
    }
    const uncertainty = facts.observationGap ?? facts.shellMutation?.unresolved[0]
    if (uncertainty) ledger.noteUnresolvedMutation(toolName, uncertainty, facts.startSeq, exec.arguments?.command)
  }

  facts.readEvidence = blocked ? { targets: [] } : await collectReadEvidence(ctx, exec, result, text, facts, state)

  facts.reviewCapabilityFailure = ['subagent', 'subagent_fork', 'workflow'].includes(toolName)
    && result?.isError === true && /subagent depth \d+ exceeds maxDepth \d+/.test(text)
  if (facts.reviewCapabilityFailure) state.reviewUnavailable = 'Host subagent depth limit; return evidence to the parent or request external review. Do not retry nested delegation.'
  let progressed = recordOutcome({ exec, result, blocked, text, toolName, facts, ledger, state, config, logger })
  settleReconciliations(state, ledger)
  if (!failed && (facts.risk?.mutation === 'never' || ['listing', 'read-back', 'existence'].includes(facts.intent)) && text.trim() && text.trim() !== '(no output)') {
    const information = weakFingerprint(text)
    if (state.readInformation.get(facts.signature) !== information) {
      state.readInformation.set(facts.signature, information)
      if (state.readInformation.size > 128) state.readInformation.delete(state.readInformation.keys().next().value)
      progressed = true
      state.lastProgressSeq = state.seq
    }
  }
  state.mutationSinceVerification = ledger.pendingMutations().length > 0 || state.unresolvedMutationCount > 0
  if (progressed) state.progress += 1

  if (config.freshnessGate.enabled && !failed) {
    let retrieved = false
    consumeRetrieval(toolName, exec.arguments, ({ topic, toolName: source }) => {
      ledger.noteFreshness(topic, { toolName: source })
      retrieved = true
    })
    if (retrieved) {
      state.lastRetrievalAt = Date.now()
      const verdict = evaluateFreshness({ text: state.freshnessClaimText, topics: config.freshnessGate.topics, retrievals: state.freshness, maxAgeMinutes: config.freshnessGate.maxAgeMinutes })
      state.pendingFreshness = verdict.passed ? undefined : verdict.gaps
    }
  }

  if (facts.noopShell === true && !failed) state.noopShellRun += 1
  else state.noopShellRun = 0

  captureReviewVerdict(state, toolName, text, config, logger, result)

  // A downstream block is that listener's verdict: the guard records it and
  // leaves the outcome alone rather than stacking a second correction on it.
  if (blocked) return passthrough(decision)

  // A failed review gets exactly one corrective round; after that the cap
  // branch below reports the unresolved finding instead of reviewing again.
  if (isReviewPending(state) && state.review.verdict.verdict === 'FAIL' && state.review.round < config.review.maxRounds) {
    state.review.round += 1
    state.counters.reviewsRequested += 1
    logger.info(`review FAIL: returning the work for round ${state.review.round}`)
    return withCorrection(state, {
      decision,
      text: renderReviewPrompt({
        requirement: requirementOf(state),
        currentState: currentStateOf(state),
        diff: diffHintOf(state),
        verification: verificationSummaryOf(state),
        risk: facts.risk?.risk ?? 'HIGH',
        round: state.review.round,
      }),
      tag: 'review',
    })
  }
  if (isReviewPending(state) && state.review.verdict.verdict === 'FAIL' && state.review.round >= config.review.maxRounds) {
    if (state.review.cappedOut !== true) {
      state.review.cappedOut = true
      state.counters.reviewsCappedOut += 1
      logger.warn(`review budget spent with an unresolved FAIL after round ${state.review.round}`)
    }
    // The budget is spent and a reviewer still objects, so the guard stops
    // asking and hands the unresolved finding to the completion gate.
  } else if (state.review === undefined || state.review.verdict?.verdict !== 'PASS') {
    const reviewPlan = planReview(state, facts, config)
    if (reviewPlan !== undefined) {
      state.review = { required: true, round: 1, cappedOut: false, verdict: undefined }
      state.counters.reviewsRequested += 1
      logger.info(`requesting independent review: ${reviewPlan.reason}`)
      return withCorrection(state, { decision, text: reviewPlan.prompt, tag: 'review' })
    }
  }

  if (config.guard.stall) {
    state.stallSteps = state.seq - (state.lastProgressSeq ?? 0)
    if (state.stallSteps >= policy.maxStallSteps) {
      state.lastProgressSeq = state.seq
      state.stallSteps = 0
      state.counters.stallsBlocked += 1
      return withCorrection(state, {
        decision,
        text: `Reliability Guard: ${policy.maxStallSteps} calls in a row produced no observable progress — no file changed, no new evidence, no passing check. Stop repeating the current approach. State what you expected, what actually happened, and then do something different: gather the missing information, change the plan, or report the blocker.`,
        tag: 'stall',
      })
    }
  }

  const gatePlan = planGate(state, config)
  if (gatePlan !== undefined) {
    state.gate = {
      ...(state.gate ?? {}),
      injections:
        gatePlan.advisory === true || gatePlan.reportedExhausted === true
          ? (state.gate?.injections ?? 0)
          : (state.gate?.injections ?? 0) + 1,
      lastPassed: false,
      reportedExhausted: gatePlan.reportedExhausted === true,
      lastGaps: gatePlan.blocking ?? 0,
    }
    if (gatePlan.advisory === true) noteAdvisory(state)
    else if (gatePlan.reportedExhausted !== true) state.counters.gateInjections += 1
    logger.info(
      `completion gate: ${gatePlan.blocking} blocking gap(s)${gatePlan.advisory === true ? ' (advisory)' : gatePlan.reportedExhausted === true ? ' (budget spent)' : ''}`,
    )
    return withCorrection(state, { decision, text: gatePlan.text, tag: 'completion-gate' })
  }

  // Nothing to correct: pass the downstream decision through unchanged.
  return passthrough(decision)
}

/**
 * Record the durable meaning of one result.
 *
 * @returns whether the result is evidence of progress.
 */
function recordOutcome({ exec, result, blocked, text, toolName, facts, ledger, state, config, logger }) {
  const isError = (result?.isError === true && !facts.readEvidence?.expectedNotFound) || blocked === true
  const key = String(facts.signature)

  if (isError && !facts.reviewCapabilityFailure) {
    const contentKey = weakFingerprint(redactSecrets(text).slice(0, 400))
    const failure = state.failures.get(key)
    if (failure === undefined) {
      state.failures.set(key, { count: 1, contentKey, at: state.seq, progressAtFailure: state.progress })
    } else {
      failure.count += 1
      failure.contentKey = contentKey
      failure.at = state.seq
    }
    if (state.failures.size > 128) {
      const oldest = [...state.failures.entries()].sort((left, right) => left[1].at - right[1].at)[0]
      if (oldest !== undefined) state.failures.delete(oldest[0])
    }
    // The guard's own refusal is not an unexplained failure of the task: the
    // model already received the reason, and recording it would block an
    // unrelated, fully verified turn until the refused command were re-run.
    if (config.evidence.enabled && facts.guardDenied !== true && toolName !== 'reliability_guard_reconcile') {
      ledger.noteFailure(`${toolName} failed: ${preview(text, 160)}`, key)
    }
    return false
  }

  // A success releases the failure run for this exact call.
  state.failures.delete(key)
  if (config.evidence.enabled) ledger.clearFailure(key)

  let progress = false

  if (facts.intent !== undefined) {
    const signals = parseVerificationSignals(text, isError)
    let verdict = judgeVerification(facts.intent, signals, {
      shellRead: facts.intent === 'read-back' && shellCommandOf(toolName, exec.arguments) !== undefined,
    })
    const readTargets = facts.readEvidence?.targets ?? []
    const readKind = ['read-back', 'listing', 'existence'].includes(facts.intent)
    if (readKind) verdict = { passed: readTargets.length > 0, strong: readTargets.length > 0,
      reason: readTargets.length
        ? 'target state confirmed'
        : (facts.queries?.length
            ? 'verification target was extracted but no runtime receipt matched it'
            : 'no verification target was extracted') }
    if (facts.intent === 'listing' && !readTargets.length && !isError) verdict = { passed: true, strong: false, reason: 'listing returned information; no changed target was verified' }
    const kind = readTargets.length
      ? (readTargets.every(target => target.expected === 'absent') ? 'absence' : 'read-back')
      : facts.intent
    const targets = readKind ? readTargets : facts.verificationTargets
    ledger.recordVerification({
      kind,
      toolName,
      passed: verdict.passed,
      strong: verdict.strong === true,
      targets,
      startSeq: facts.startSeq,
      detail: `${verdict.reason}${signals.evidence.length > 0 ? ` — ${signals.evidence[0]}` : ''}`,
      atSeq: state.seq,
    })
    if (verdict.passed) {
      progress = !readKind // Read progress is based on new returned information below.
      for (const target of readTargets) ledger.confirmObservation(target.path, target.expected)
    }
  }

  const risk = facts.risk
  if (risk !== undefined && risk.mutation === 'definite') {
    const mutatedPath = firstPathOf(exec.arguments) ?? risk.paths?.[0]
    ledger.noteMutation(mutatedPath, risk.risk, {
      toolName,
      startSeq: facts.startSeq,
      before: preMutationStateOf(facts, mutatedPath, state.workspaceRoot),
    })
    if (config.evidence.enabled && typeof mutatedPath === 'string' && mutatedPath !== '') {
      // The file on disk is no longer what the ledger recorded, and the call
      // itself tells us the new content for the tool families that write one
      // file, so the record is refreshed rather than only invalidated.
      ledger.invalidate(mutatedPath, 'this session changed the file')
      const digest = writeDigestOf(toolName, exec.arguments)
      if (digest !== undefined) ledger.observePath(mutatedPath, { toolName, digest })
    }
    progress = true
  } else if (facts.versionChanged !== undefined) {
    progress = true
  }

  // Both diagnostics and the completion gate use the same coverage decision.
  // A read/diff or successful check must not hide a mutation in that same call.
  state.mutationSinceVerification = ledger.pendingMutations().length > 0

  if (progress) state.lastProgressSeq = state.seq
  return progress
}

/**
 * Read the current text of the file a call is about to edit.
 *
 * Uses the session's own filesystem provider, so the bytes the check sees are
 * the bytes the edit will see. A provider that cannot read the target, or a
 * file over the size cap, simply yields no text: the check is advisory, and an
 * unreadable file is the edit tool's problem, not the guard's.
 *
 * @param ctx - the plugin context.
 * @param exec - the execution about to run.
 * @param args - the parsed arguments.
 * @param logger - the guard logger.
 * @returns the file text, or `undefined`.
 */
async function readTargetText(ctx, exec, args, logger) {
  const fs = ctx.get('fs')
  if (fs === undefined || typeof fs.readText !== 'function') return undefined
  const path = typeof args?.file_path === 'string' ? args.file_path : typeof args?.path === 'string' ? args.path : undefined
  if (path === undefined || path === '') return undefined
  try {
    const target = await fs.resolve(path, { cwd: exec.agent?.session?.header?.cwd })
    const text = await fs.readText(target, exec.signal)
    if (typeof text !== 'string') return undefined
    // Line-ending analysis only needs the shape, so a large file is bounded.
    return text.length > 262_144 ? undefined : text
  } catch (error) {
    logger.debug(`could not read "${path}" for the line-ending check: ${errorMessage(error)}`)
    return undefined
  }
}

/**
 * Re-read the paths a call named and report the ones whose version changed.
 *
 * @param ctx - the plugin context.
 * @param facts - the execution facts captured before the call.
 * @param exec - the finished execution.
 * @param logger - the guard logger.
 * @returns the paths whose version changed, or `undefined`.
 */
async function detectVersionChanges(ctx, facts, exec, logger) {
  const before = facts.preVersions
  if (before === undefined) return undefined
  const fs = ctx.get('fs')
  if (fs === undefined) return undefined
  const changed = []
  for (const [path, prior] of before) {
    try {
      const info = await fs.stat(prior.target, exec.signal)
      const present = info !== undefined
      if (present !== prior.present || String(info?.version) !== String(prior.version)) {
        changed.push({
          path,
          expected: present ? 'present' : 'absent',
          type: info?.type ?? prior.type,
          before: { present: prior.present === true, type: prior.type, size: prior.size },
        })
      }
    } catch (error) {
      if (facts.shellMutation) facts.observationGap = 'could not observe every mutation target after execution'
      logger.debug(`could not re-read "${path}" after the call: ${errorMessage(error)}`)
    }
  }
  return changed.length === 0 ? undefined : changed
}

/**
 * Read the post-write content fingerprint the call itself already carries.
 *
 * A tool that replaces whole content carries the new bytes in its arguments, so
 * the ledger can refresh its record without reading the file back. Tools that
 * only patch a fragment carry the replacement, which is enough to notice a
 * later change to that fragment.
 */
function writeDigestOf(toolName, args) {
  if (args === null || typeof args !== 'object') return undefined
  if (toolName === 'write' && typeof args.content === 'string') return weakFingerprint(args.content)
  if (toolName === 'edit' && typeof args.new_string === 'string') return weakFingerprint(args.new_string)
  // Any other single-file writer that declares `content` plus a path is treated
  // the same way, so the record is refreshed rather than only invalidated.
  if (typeof args.content === 'string' && typeof (args.file_path ?? args.path) === 'string') {
    return weakFingerprint(args.content)
  }
  if (typeof args.new_string === 'string') return weakFingerprint(args.new_string)
  return undefined
}

/**
 * Capture an independent reviewer's verdict from the result of the `subagent`
 * call the executor was asked to make.
 *
 * The verdict is unparseable-checked: a report without an explicit
 * `VERDICT: PASS` counts as FAIL, because an unreadable review is not evidence.
 */
function captureReviewVerdict(state, toolName, text, config, logger, result) {
  if (!config.review.enabled) return
  if (state.review === undefined) return
  if (!['subagent', 'subagent_fork', 'workflow'].includes(toolName) || result?.isError) return
  if (result?.value?.kind === 'background') return
  if (toolName === 'workflow') {
    if (result?.value?.kind !== 'foreground' || !(result.value.agentsStarted > 0)) return
    text = typeof result.value.result === 'string' ? result.value.result : JSON.stringify(result.value.result)
    if (!/VERDICT\s*:\s*(PASS|FAIL)/i.test(text)) return
    if (/VERDICT\s*:\s*FAIL/i.test(text)) text = `VERDICT: FAIL\n${text}`
  }
  if (toolName === 'subagent_fork' && !/VERDICT\s*:\s*(PASS|FAIL)/i.test(text)) return
  if (text.trim() === '') return
  // One verdict per round: a second report in the same round must not replace
  // the first, or a reviewer that answers twice could talk the gate open.
  if (state.review.verdict !== undefined && state.review.verdictRound === state.review.round) return
  const verdict = parseReviewVerdict(text)
  state.review.verdict = verdict
  state.reviewUnavailable = undefined
  state.review.verdictRound = state.review.round
  if (verdict.verdict === 'PASS') state.counters.reviewsPassed += 1
  else state.counters.reviewsFailed += 1
  logger.info(`review round ${state.review.round}: ${verdict.verdict}`)
}

/** Whether a review is required and currently awaiting its verdict. */
function isReviewPending(state) {
  return state.review !== undefined && state.review.verdict !== undefined
}

/** Decide whether this turn needs an independent review. */
function planReview(state, facts, config) {
  if (!config.review.enabled) return undefined
  if (state.reviewDeferredToParent || state.reviewUnavailable) return undefined
  // One review request per turn: a second request is how mutual review loops
  // start, and the gate already blocks a turn whose review failed.
  if (state.review !== undefined) return undefined
  const risk = facts.risk?.risk ?? 'LOW'
  const highRisk = riskRank(risk) >= riskRank('HIGH')
  const multiFile = state.mutatedFiles.size >= config.review.multiFileThreshold
  if (config.review.highRiskOnly && !highRisk) return undefined
  if (!highRisk && !multiFile) return undefined
  const reason = highRisk ? `${risk} risk change` : `${state.mutatedFiles.size} files changed in one turn`
  return {
    reason,
    prompt: `Reliability Guard requires an independent review before this turn can be reported complete (${reason}). Spawn a reviewer with fresh context and no shared reasoning, then include its report verbatim.\n\n${renderReviewPrompt(
      {
        requirement: requirementOf(state),
        currentState: currentStateOf(state),
        diff: diffHintOf(state),
        verification: verificationSummaryOf(state),
        risk,
        round: 1,
      },
    )}`,
  }
}

/** Decide whether the completion gate should correct or inform this turn. */
function planGate(state, config) {
  if (!config.completionGate.enabled) return undefined
  const ledger = ledgerOf(state, config)
  const verdict = evaluateCompletionGate({
    state,
    verification: ledger.verificationCoveringLatestMutation(),
    pendingMutations: ledger.pendingMutations(),
    requireVerificationForMutation: config.completionGate.requireVerificationForMutation,
    reviewRequired: reviewRequiredFor(state, config),
    reviewVerdict: state.review?.verdict,
    reviewCappedOut: state.review?.cappedOut === true,
    freshnessGaps: state.pendingFreshness ?? [],
  })

  // An advisory gap does not block the turn, but the model still has to hear it
  // once: an unreported declared unknown or a stale observation is exactly what
  // makes a confident final answer wrong. Advisories have their own, smaller
  // budget so they cannot turn into the prompt loop the gate exists to prevent.
  const advisoryOnly = verdict.blocking === 0 && verdict.gaps.length > 0
  if (advisoryOnly) {
    if (!canAdvise(state)) return undefined
    return { blocking: 0, advisory: true, text: renderGateMessage(gapLines(verdict.gaps), {}) }
  }

  if (verdict.passed) {
    state.gate = { ...(state.gate ?? {}), lastPassed: true, lastGaps: 0 }
    state.pendingFreshness = undefined
    return undefined
  }
  if (!canInject(state, config.completionGate.maxInjectionsPerTurn)) {
    if (state.gate?.reportedExhausted === true) return undefined
    return {
      blocking: verdict.blocking,
      reportedExhausted: true,
      text: `Reliability Guard: the completion gate still reports ${verdict.blocking} blocking gap(s) and this turn's correction budget is spent. Do not present the work as complete. State each remaining gap explicitly in your answer:\n${gapLines(verdict.gaps)
        .map((line) => `- ${line}`)
        .join('\n')}`,
    }
  }
  const digest = config.evidence.injectDigest ? ledger.digest({ maxChars: config.evidence.maxDigestChars }) : ''
  return { blocking: verdict.blocking, text: renderGateMessage(gapLines(verdict.gaps), { digest }) }
}

/**
 * Return one correction for the driver to deliver at the next step boundary.
 *
 * The tool scheduler commits `additionalContexts` into the next-step inbox
 * after recording the tool result. It owns delivery: also calling
 * `agent.inject(message)` here would enqueue the same ID twice and fail the
 * turn with "message ... is already pending". Returning context alone lets
 * the model receive the correction without rewriting the tool's output.
 *
 * @returns a post-execute decision carrying the correction.
 */
function withCorrection(state, { decision, text, tag }) {
  const message = {
    role: 'user',
    id: `reliability-guard-${tag}-${Math.random().toString(36).slice(2, 10)}`,
    content: [{ type: 'text', text }],
    source: { kind: GUARD_SOURCE, form: 'notice', tag },
  }
  // Retain the diagnostics counter for notices handed to the driver.
  state.counters.digestsInjected += 1
  state.counters.noticesInjected += 1
  state.counters.noticesByTag[tag] = (state.counters.noticesByTag[tag] ?? 0) + 1
  if (/Evidence digest|Current evidence:/i.test(text)) state.counters.evidenceDigestsInjected += 1
  const base = decision !== null && typeof decision === 'object' && typeof decision.kind === 'string' ? decision : { kind: 'accept' }
  return { ...base, additionalContexts: [message, ...(base.additionalContexts ?? [])] }
}

/**
 * The loop detectors. Each returns a verdict only when the run is provably not
 * making progress, so a legitimate repetition is never blocked.
 *
 * A run is consecutive: any different tracked call resets the counter, which is
 * why a genuine retry with changed arguments never trips a threshold.
 */
function detectLoop(state, facts, policy, config, toolName) {
  if (facts.noopShell && config.guard.noopShell && state.noopShellRun + 1 >= policy.maxNoopShellRun) {
    return {
      kind: 'no-op-shell',
      summary: `${state.noopShellRun + 1} consecutive effect-free shell calls: ${preview(String(facts.signature ?? ''), 120)}`,
      advice: 'Run a command that changes state or returns information the task needs, or finish and report the result.',
      evidence: `${state.noopShellRun + 1} consecutive no-op shell calls (threshold ${policy.maxNoopShellRun})`,
    }
  }

  if (config.guard.exactRepeats && state.exactSignature === facts.signature && state.exactRun + 1 >= policy.maxIdenticalRepeats) {
    return {
      kind: 'repeat',
      summary: `identical call repeated ${state.exactRun + 1} times: ${preview(String(facts.signature ?? ''), 160)}`,
      advice: 'Read the previous result again. If it did not change, repeating the call cannot change it: change the arguments, change the approach, or report what blocked you.',
      evidence: `${state.exactRun + 1} consecutive byte-identical calls (threshold ${policy.maxIdenticalRepeats})`,
    }
  }

  if (config.guard.semanticRepeats) {
    // A semantic repeat is a call that normalizes to the same thing as the
    // previous call WITHOUT being byte-identical. Comparing the semantic
    // signature with the raw one would never match (the raw form is prefixed
    // with the tool name), so byte-identical runs would be counted twice and
    // would trip this lower threshold first.
    const sameTool = state.semanticTool === toolName
    const repeatsPrevious = sameTool && state.semanticSignature === facts.semanticSignature
    const identical = repeatsPrevious && state.exactSignature === facts.signature
    if (repeatsPrevious && !identical && state.semanticRun + 1 >= policy.semanticLoopThreshold) {
      return {
        kind: 'semantic-repeat',
        summary: `${state.semanticRun + 1} semantically identical calls: ${preview(String(facts.semanticSignature ?? ''), 160)}`,
        advice: 'These calls differ only in whitespace, quoting, or comments, so they keep producing the same result. Change what the call actually does.',
        evidence: `${state.semanticRun + 1} argument-normalized identical calls (threshold ${policy.semanticLoopThreshold})`,
      }
    }
  }

  if (config.guard.blindRetries) {
    const key = String(facts.signature)
    const failure = state.failures.get(key)
    if (failure !== undefined && failure.count > policy.maxBlindRetries && state.progress === failure.progressAtFailure) {
      return {
        kind: 'blind-retry',
        summary: `retry ${failure.count + 1} of a known failure with no new evidence: ${preview(key, 160)}`,
        advice: 'The previous attempts failed with no state change in between. Diagnose the failure first: read the error, check the precondition it names, and change something before retrying.',
        evidence: `${failure.count} prior failures with no observable progress (threshold ${policy.maxBlindRetries})`,
      }
    }
  }

  return undefined
}

/**
 * Advance the consecutive-run counters for the call about to run.
 *
 * The semantic run tracks "normalizes the same as the previous call"; whether
 * that run is also byte-identical is derived from the raw signature at decision
 * time, which is why both are stored.
 */
function trackRuns(state, facts, toolName) {
  if (state.exactSignature === facts.signature) state.exactRun += 1
  else {
    state.exactSignature = facts.signature
    state.exactRun = 1
  }
  if (state.semanticTool === toolName && state.semanticSignature === facts.semanticSignature) state.semanticRun += 1
  else {
    state.semanticTool = toolName
    state.semanticSignature = facts.semanticSignature
    state.semanticRun = 1
  }
}

/**
 * Apply the Windows-first environment checks to one call.
 *
 * Findings are advisory by contract, so they are recorded and logged rather than
 * acted on: the guard must never block work on the strength of a lexical
 * heuristic. They remain reachable through the diagnostics counters, which is
 * what makes an advisory note auditable instead of invisible.
 */
function collectEnvironmentFindings(facts, { toolName, args, config, state, logger }) {
  if (!config.windows.enabled) return
  for (const finding of evaluateWindowsShellCall({ toolName, args, config: config.windows })) facts.findings.push(finding)
  if (facts.findings.length === 0) return
  facts.risk = { ...facts.risk, environmentalNotes: facts.findings.map((finding) => finding.code) }
  state.counters.windowsWarnings += facts.findings.length
  for (const finding of facts.findings) {
    logger.debug(`windows advisory (${finding.code}) on ${toolName}: ${finding.message}`)
  }
}
function renderDenial(verdict, state, config) {
  const lines = [`Reliability Guard blocked this call. ${verdict.advice}`, `Evidence: ${verdict.evidence}.`]
  const digest = config.evidence.injectDigest ? ledgerOf(state, config).digest({ maxChars: config.evidence.maxDigestChars }) : ''
  if (digest !== '') lines.push('', 'Current evidence:', digest)
  return lines.join('\n')
}

function renderRiskDenial(risk, missing, workspaceRoot) {
  const lines = [
    `Reliability Guard refused this ${risk.risk}-risk call: ${risk.reason}.`,
    `Scope: ${risk.scope}${workspaceRoot === undefined || workspaceRoot === '' ? '' : ` (workspace root: ${workspaceRoot})`}.`,
    `Missing before this can run: ${missing.join(' and ')}.`,
  ]
  if (missing.includes('rollback')) {
    lines.push('State, in the call itself, how this change can be undone: a backup copy, a stash or commit, a transaction — or an explicit statement that it cannot be undone, and why that is acceptable.')
  }
  if (missing.includes('verification')) {
    lines.push('State, in the call itself, how you will confirm the change took effect: a test, a build with its exit code plus artifact, a service probe, or a re-read of the effective configuration.')
  }
  lines.push('Then repeat the call with that plan in its `justification` (or `description`) argument.')
  return lines.join('\n')
}

function contentText(result) {
  if (result === null || typeof result !== 'object') return ''
  const content = result.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part !== null && typeof part === 'object' && part.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('\n')
}

/** Read a message's text from a `session/event` payload. */
function messageTextOf(data) {
  const message = data?.message ?? data
  return contentText(message)
}

/** Read the originating request text from a user message or an inbox splice. */
function userTextOf(data) {
  if (data === undefined || data === null) return ''
  const parts = []
  const direct = messageTextOf(data)
  if (direct !== '') parts.push(direct)
  const inserted = data.inserted
  if (Array.isArray(inserted)) {
    for (const message of inserted) {
      const text = messageTextOf(message)
      if (text !== '') parts.push(text)
    }
  }
  if (data.message !== undefined) {
    const text = messageTextOf(data.message)
    if (text !== '' && !parts.includes(text)) parts.push(text)
  }
  return parts.join('\n').slice(0, 4000)
}

function firstPathOf(args) {
  if (args === null || typeof args !== 'object') return undefined
  for (const key of ['file_path', 'path', 'target', 'destination']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** Exact pre-execution filesystem state for one mutated path, when captured. */
function preMutationStateOf(facts, path, workspaceRoot) {
  if (typeof path !== 'string' || path === '' || facts.preVersions === undefined) return undefined
  const wanted = pathKey(path, workspaceRoot)
  for (const [candidate, prior] of facts.preVersions) {
    if (pathKey(candidate, workspaceRoot) !== wanted) continue
    return { present: prior.present === true, type: prior.type, size: prior.size }
  }
  return undefined
}

function semanticSignature(toolName, args) {
  if (toolName === 'bash' || toolName === 'pwsh') {
    const command = typeof args?.command === 'string' ? args.command : ''
    return `cmd:${normalizeCommand(command)}`
  }
  return canonicalize(args)
}

function sessionWorkspaceRoot(ctx, session) {
  const header = session?.header
  if (header !== undefined && typeof header.cwd === 'string' && header.cwd !== '') return header.cwd
  const sandboxPolicy = ctx.get('sandboxPolicy')
  if (sandboxPolicy === undefined) return undefined
  try {
    const resolved = sandboxPolicy.resolve({ session })
    return typeof resolved?.workspaceRoot === 'string' ? resolved.workspaceRoot : undefined
  } catch (error) {
    ctx.logger?.debug?.(`reliability-guard: could not read the sandbox policy: ${errorMessage(error)}`)
    return undefined
  }
}

function ledgerOf(state, config) {
  return new EvidenceLedger(state, { maxRecords: config.evidence.maxRecords })
}

function reviewRequiredFor(state, config) {
  if (!config.review.enabled) return false
  if (state.reviewDeferredToParent) return false
  // `highRiskCalls` counts the high-risk calls that were ALLOWED in this turn,
  // so a refused call does not demand a review in an unrelated later turn.
  const highRisk = state.highRiskCalls > 0
  const multiFile = state.sessionMutatedFiles.size >= config.review.multiFileThreshold
  if (config.review.highRiskOnly) return highRisk
  return highRisk || multiFile || state.sessionMutatedFiles.size > 0
}

function requirementOf(state) {
  return state.requirement ?? '(the original request is not recorded in this session; derive it from the conversation history above)'
}

function currentStateOf(state) {
  const files = [...state.mutatedFiles]
  const mutations = state.mutationEvents.slice(-8).map(item => {
    const details = [item.before?.type, Number.isFinite(item.before?.size) ? `${item.before.size} bytes` : undefined].filter(Boolean)
    const before = item.before?.present === true
      ? `pre-state observed present${details.length ? ` (${details.join(', ')})` : ''}`
      : item.before?.present === false ? 'pre-state observed absent' : 'pre-state not captured'
    return `${item.path ?? item.key ?? '(unscoped)'} -> ${item.expected ?? 'present'}; ${before}`
  })
  return `Workspace root: ${state.workspaceRoot ?? '(unknown)'}. Files changed this turn: ${files.length === 0 ? '(none recorded)' : files.join(', ')}${mutations.length ? `. Exact mutation observations: ${mutations.join(' | ')}` : ''}`
}

function diffHintOf(state) {
  const events = state.mutationEvents.slice(-8)
  const files = [...state.mutatedFiles]
  if (files.length === 0) return '(no file path was recorded for the change; inspect the workspace diff)'
  if (events.some(item => item.expected === 'absent')) {
    return `Do not assume a VCS is available. Review the exact mutation ledger instead: ${events.map(item => `${item.path ?? item.key ?? '(unscoped)'} -> ${item.expected ?? 'present'}`).join(' | ')}. For a deletion, guard-captured pre-state proves only the filesystem state it records; the later absence verification proves the post-state. Neither substitutes for missing content evidence when the requirement depends on the deleted bytes.`
  }
  return `Run a diff over these paths and include it: ${files.join(', ')}`
}

function verificationSummaryOf(state) {
  if (state.verifications.length === 0) return '(no verification has been recorded in this session)'
  return state.verifications
    .slice(-5)
    .map((item) => `${item.kind} check ${item.passed ? 'PASS' : 'FAIL'} via ${item.toolName ?? 'unknown'}; target(s): ${item.targets?.map(t => `${t.path} -> ${t.expected}`).join(', ') || 'none; not mutation coverage'}${item.detail === undefined ? '' : ` — ${item.detail}`}`)
    .join('\n')
}

function registerDiagnosticsTool(ctx, view, policy, states, logger) {
    return ctx.tools.register(defineTool({
      name: 'reliability_guard',
      description:
        'Reliability Guard diagnostics / 可靠性守卫诊断：read what has actually been verified in this session, including mutations, recorded verifications, stale observations, unexplained failures, declared unknowns, review state, and guard counters. 读取本会话中实际完成的验证；当你不确定某项检查是否已记录时，请在宣告任务完成前调用。',
      parameters: {
        detail: {
          type: 'boolean',
          description: 'Include per-session evidence details; defaults to false. / 包含会话级证据详情（过期项、验证和未决项）；默认为 false。',
        },
        call_seq: { type: 'integer', description: 'Focus on an earlier mutation/risk call sequence, including redacted original command. / 查看指定序号的变更或风险及脱敏原始命令。' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const config = view.live()
        const session = exec.agent?.session
        const state = session === undefined ? undefined : states.get(session)
        const report = buildDiagnostics({
          toolsRegistered: guardToolsPresent(ctx.tools, exec.agent),
          policy,
          config,
          state,
          ledger: state === undefined ? undefined : ledgerOf(state, config),
          sessionId: session?.id,
          detail: args?.detail === true || args?.call_seq !== undefined,
          callSeq: args?.call_seq,
          includeSensitiveContent: config.diagnostics.includeSensitiveContent,
        })
        return renderDiagnostics(report)
      },
    }))
}

function guardToolsPresent(tools, scope) {
  return ['reliability_guard', 'reliability_guard_reconcile'].every(name => tools.get(name, scope) !== undefined)
}

/** Register on the service-owned child scope, including service replacements. */
function registerGuardTools(ctx, view, policy, states, logger) {
  logger.info('tool registration waiting for tools service')
  ctx.inject(['tools'], toolsCtx => {
    let disposed = false
    const owned = new Map()
    const ensure = () => {
      if (disposed) return
      const registrations = [
        ['reliability_guard_reconcile', () => registerReconciliationTool(toolsCtx, states, view)],
        ['reliability_guard', () => registerDiagnosticsTool(toolsCtx, view, policy, states, logger)],
      ]
      for (const [name, register] of registrations) {
        if (name === 'reliability_guard' && !view.live().diagnostics.enabled) {
          if (!owned.has(name)) logger.info(`tool registration skipped: ${name} (diagnostics disabled)`)
          owned.get(name)?.()
          owned.set(name, undefined)
          continue
        }
        if (toolsCtx.tools.get(name, undefined)) {
          if (!owned.has(name)) { logger.info(`tool registration skipped: ${name} (already present)`); owned.set(name, undefined) }
          continue
        }
        try {
          owned.get(name)?.()
          owned.set(name, register())
          if (!toolsCtx.tools.get(name, undefined)) throw new Error('registry read-back did not find the tool')
          logger.info(`tool registration success: ${name}`)
        } catch (error) {
          logger.info(`tool registration failed: ${name}: ${errorMessage(error)}`)
          logger.warn(`tool unavailable: ${name}; retry after profile update settles / 更新完成后请再次重启应用`)
        }
      }
    }
    ensure()
    // Covers registration races without unbounded timers or detached effects.
    const timers = [0, 100, 1000].map(delay => setTimeout(ensure, delay))
    toolsCtx.on('agent/created', ensure)
    toolsCtx.on('tools/pre-execute', (_exec, next) => { ensure(); return next() })
    toolsCtx.effect(() => () => { disposed = true; timers.forEach(clearTimeout); for (const dispose of owned.values()) dispose?.() }, 'reliability-guard.tools()')
  })
}

/**
 * Per-session state ownership and level-filtered logging.
 *
 * Reliability Guard keeps every mutable fact in one bucket per session. The
 * bucket is keyed by the `Session` object, so a disposed session's state
 * becomes unreachable even if an explicit cleanup is missed, and it is also
 * removed on `session/disposed` (and on plugin disposal) so a long-lived host
 * does not retain finished sessions.
 *
 * The module-level publication index is an inspection API, not an evidence
 * cache. Evidence remains owned by each registry and session.
 *
 * @module dsh-reliability-guard/state
 */

/** Log levels in ascending severity. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error']

/**
 * Symbol under which a plugin instance publishes its session-state registry.
 *
 * The registry is published on the plugin's own namespace object, keyed by the
 * owning context, so two contexts in one process can never observe each other's
 * sessions even though they share this module instance. It is a read/inspect
 * surface: nothing outside the plugin mutates guard state through it, and a host
 * that never reads it is unaffected.
 */
export const SESSION_STATES = Symbol.for('dsh-reliability-guard/session-states')

/**
 * Per-context registry publication.
 *
 * The plugin namespace carries one entry per owning context, and the same object
 * is also recorded against the context itself. Both directions exist so a test
 * or a diagnostic can ask either question — "what is registered for this
 * context" and "what is the newest registration" — without the module holding
 * any state that outlives the contexts themselves.
 */
const publishedByContext = new WeakMap()
const publications = new Map()

/**
 * Publish a registry for one context.
 *
 * @param namespace - the plugin namespace object.
 * @param ctx - the owning plugin context.
 * @param registry - the registry to publish.
 */
export function publishSessionStates(namespace, ctx, registry) {
  const byContext = namespace[SESSION_STATES] instanceof Map ? namespace[SESSION_STATES] : new Map()
  byContext.set(ctx, registry)
  // Recording the root as well means a caller holding the root context — the
  // context a host or a test actually constructed — can read the registry
  // without knowing which child fiber the plugin was mounted on.
  const root = ctx?.root
  if (root !== undefined && root !== ctx) byContext.set(root, registry)
  namespace[SESSION_STATES] = byContext
  publishedByContext.set(ctx, registry)
  if (root !== undefined) publishedByContext.set(root, registry)
  publications.delete(ctx)
  publications.set(ctx, { namespace, registry })
}

/**
 * Withdraw one context's registry publication.
 *
 * @param namespace - the plugin namespace object.
 * @param ctx - the owning plugin context.
 */
export function withdrawSessionStates(namespace, ctx) {
  const byContext = namespace[SESSION_STATES]
  if (!(byContext instanceof Map)) return
  const withdrawn = byContext.get(ctx)
  byContext.delete(ctx)
  publishedByContext.delete(ctx)
  publications.delete(ctx)
  const root = ctx?.root
  if (root !== undefined && byContext.get(root) === withdrawn) {
    byContext.delete(root)
    publishedByContext.delete(root)
    const survivor = [...publications.entries()].filter(([, item]) => item.namespace === namespace).map(([owner, item]) => [owner, item.registry]).findLast(([owner]) => owner !== root && owner?.root === root)
    if (survivor) {
      byContext.set(root, survivor[1])
      publishedByContext.set(root, survivor[1])
    }
  }
  if (byContext.size === 0) delete namespace[SESSION_STATES]
}

/**
 * Read the registry published for one context.
 *
 * @param namespace - the plugin namespace object.
 * @param ctx - the context whose registry is wanted, or its root; omitted returns the newest published one.
 * @returns the registry, or `undefined`.
 */
export function sessionStatesOf(namespace, ctx) {
  if (ctx === undefined) return [...publications.values()].findLast(item => item.namespace === namespace)?.registry
  const direct = publishedByContext.get(ctx)
  if (direct !== undefined) return direct
  const root = ctx?.root
  if (root !== undefined) {
    const viaRoot = publishedByContext.get(root)
    if (viaRoot !== undefined) return viaRoot
  }
  const byContext = namespace[SESSION_STATES]
  if (!(byContext instanceof Map)) return undefined
  return byContext.get(ctx) ?? (root === undefined ? undefined : byContext.get(root))
}

/** Diagnostic counters that never contain user content. */
export function createCounters() {
  return {
    preExecuteChecked: 0,
    deniedLowRisk: 0,
    deniedHighRisk: 0,
    asked: 0,
    blockedLoops: 0,
    noopShellBlocked: 0,
    blindRetriesBlocked: 0,
    stallsBlocked: 0,
    postExecuteBlocked: 0,
    digestsInjected: 0,
    noticesInjected: 0,
    evidenceDigestsInjected: 0,
    noticesByTag: {},
    gateInjections: 0,
    reviewsRequested: 0,
    reviewsPassed: 0,
    reviewsFailed: 0,
    reviewsCappedOut: 0,
    freshnessWarnings: 0,
    windowsWarnings: 0,
  }
}

/** One session's isolated guard state. */
export function createSessionState(sessionKey) {
  return {
    /** Stable session id; a diagnostic label only. */
    key: sessionKey,
    /** Monotonic call sequence for this session. */
    seq: 0,
    /** How many recent calls are retained, refreshed from the configuration. */
    callWindowSize: 12,
    /** Ring buffer of recent call observations. */
    calls: [],
    /** Consecutive byte-identical run: last signature and its length. */
    exactSignature: undefined,
    exactRun: 0,
    /** Consecutive semantically identical run: last tool, signature and length. */
    semanticTool: undefined,
    semanticSignature: undefined,
    semanticRun: 0,
    /** Consecutive no-op shell calls. */
    noopShellRun: 0,
    /** signature -> { count, contentKey, at, progressAtFailure }. */
    failures: new Map(),
    /**
     * Progress counter. It only advances on a real mutation or a passing
     * verification, so "the same failure with no progress in between" is a
     * deterministic question rather than a heuristic.
     */
    progress: 0,
    /** Call sequence of the newest observed progress. */
    lastProgressSeq: 0,
    /** Calls since the newest progress, recomputed each post-execute. */
    stallSteps: 0,
    /** Distinct files whose version changed during this turn. */
    mutatedFiles: new Set(),
    /** Latest change per canonical path in the current turn. */
    mutations: new Map(),
    /** Unresolved execution risks are not asserted to be actual mutations. */
    unresolvedMutationCount: 0,
    unresolvedMutations: [],
    mutationEvents: [],
    resolvedUnknowns: [],
    resolvedFailures: [],
    failureSerial: 0,
    unknownSerial: 0,
    readInformation: new Map(),
    /** Distinct files mutated during the whole session. */
    sessionMutatedFiles: new Set(),
    /** Evidence records keyed by target key. */
    evidence: new Map(),
    /** Insertion order of evidence keys, for bounded eviction. */
    evidenceOrder: [],
    /** Unverified assumptions the model declared as unknown. */
    unknowns: [],
    /** Conclusions invalidated by later evidence. */
    overturned: [],
    /** Verifications recorded in this turn, newest last. */
    verifications: [],
    /** Bounded 1.1.3 runtime traces for the shell query extraction seam. */
    shellQueryDiagnostics: [],
    /** Calls whose risk was classified at or above HIGH. */
    highRiskCalls: 0,
    /** Whether any state-changing call happened since the last verification. */
    mutationSinceVerification: false,
    /** Whether a mutation happened at all in this session. */
    mutated: false,
    /** Turn number the guard last observed, and the call sequence it started at. */
    currentTurn: 0,
    turnStartSeq: 0,
    lastMutationTurn: -1,
    /** Sequence and risk of the newest mutation. */
    lastMutationSeq: 0,
    lastMutationRisk: undefined,
    /**
     * File version captured before a call that names a path but is not a known
     * writer, so a shell command that changed the file can be recognized from
     * the version diff rather than from the tool name.
     */
    preCallVersions: new Map(),
    /** Review state for the current turn. */
    review: undefined,
    /** Completion-gate state for the current turn. */
    gate: undefined,
    /** Unresolved failure descriptions awaiting an explanation. */
    unexplainedFailures: [],
    /** Freshness records: topic -> { at, toolName }. */
    freshness: new Map(),
    /** Timestamp of the newest external retrieval. */
    lastRetrievalAt: undefined,
    /** Freshness gaps detected on the newest assistant message. */
    pendingFreshness: undefined,
    /** The originating request, bounded and redacted. */
    requirement: undefined,
    /** Workspace root observed for this session. */
    workspaceRoot: undefined,
    /** Counters for diagnostics. */
    counters: createCounters(),
    /** Whether the session has been disposed. */
    disposed: false,
  }
}

/**
 * Owns one state bucket per live session.
 *
 * `get` never throws: it creates the bucket lazily on first use, which keeps
 * the guard correct for hook orderings it does not control.
 */
export class SessionStates {
  #states = new WeakMap()
  #ordered = new Set()
  #logger
  #checkpoints

  /**
   * @param logger - level-filtered logger used for cleanup diagnostics.
   */
  constructor(logger, checkpoints) {
    this.#logger = logger
    this.#checkpoints = checkpoints
  }

  /**
   * Return the state bucket for one session, creating it on first use.
   *
   * @param session - the DSH `Session` object.
   * @returns the session's isolated state.
   */
  get(session) {
    let state = this.#states.get(session)
    if (state === undefined) {
      state = createSessionState(String(session?.id ?? 'unknown'))
      this.#checkpoints?.load(state)
      this.#states.set(session, state)
      this.#ordered.add(session)
    }
    return state
  }

  /**
   * Return the state bucket only when it already exists.
   *
   * @param session - the DSH `Session` object.
   * @returns the existing state, or `undefined`.
   */
  peek(session) {
    return this.#states.get(session)
  }

  checkpoint(session) {
    const state = this.peek(session)
    if (state && !state.disposed) this.#checkpoints?.save(state)
  }

  /**
   * Drop one session's state.
   *
   * @param session - the DSH `Session` object.
   * @returns whether a bucket was removed.
   */
  dispose(session) {
    const state = this.#states.get(session)
    if (state === undefined) return false
    this.checkpoint(session)
    state.disposed = true
    this.#states.delete(session)
    this.#ordered.delete(session)
    return true
  }

  /**
   * Drop every bucket. Called from the plugin's own disposal so an uninstall
   * or reload retains nothing.
   *
   * @returns how many buckets were released.
   */
  disposeAll() {
    const count = this.#ordered.size
    for (const session of this.#ordered) {
      this.checkpoint(session)
      const state = this.#states.get(session)
      if (state !== undefined) state.disposed = true
    }
    this.#ordered.clear()
    this.#states = new WeakMap()
    if (count > 0) this.#logger.debug(`released ${count} session state bucket(s)`)
    return count
  }

  /** @returns how many session buckets are currently tracked. */
  get size() {
    return this.#ordered.size
  }

  /**
   * Snapshot the live session keys, for diagnostics and tests.
   *
   * @returns an array of session ids currently holding state.
   */
  liveKeys() {
    return [...this.#ordered].map((session) => String(session?.id ?? 'unknown'))
  }
}

/**
 * Level-filtered logger that writes through the Cordis logger when the host
 * provides one, and stays silent otherwise. Every line is prefixed so guard
 * output is separable from other plugins at any level.
 */
export class GuardLogger {
  #logger
  #threshold

  /**
   * @param logger - the Cordis `ctx.logger`, or a compatible object.
   * @param level - minimum level to emit.
   */
  constructor(logger, level = 'info') {
    this.#logger = logger
    this.#threshold = Math.max(0, LOG_LEVELS.indexOf(level))
  }

  /**
   * Lower the bar for a configuration change without rebuilding the logger.
   *
   * @param level - new minimum level.
   */
  setLevel(level) {
    const index = LOG_LEVELS.indexOf(level)
    if (index >= 0) this.#threshold = index
  }

  #emit(level, message) {
    const index = LOG_LEVELS.indexOf(level)
    if (index < this.#threshold) return
    const text = `reliability-guard: ${message}`
    const target = this.#logger?.[level]
    if (typeof target === 'function') target.call(this.#logger, text)
  }

  /** @param message - diagnostic detail that is normally not interesting. */
  debug(message) {
    this.#emit('debug', message)
  }

  /** @param message - a normal, notable guard decision. */
  info(message) {
    this.#emit('info', message)
  }

  /** @param message - something the operator should look at. */
  warn(message) {
    this.#emit('warn', message)
  }

  /** @param message - the guard could not do its job. */
  error(message) {
    this.#emit('error', message)
  }
}

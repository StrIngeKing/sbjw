/**
 * The per-session evidence ledger.
 *
 * The ledger records what the agent actually observed, not what it said it
 * observed. It exists so two questions can be answered without asking a model:
 *
 * - Is this conclusion still supported by current state, or has the file it
 *   came from changed since it was read?
 * - Is this mutation verified, and is this failure explained?
 *
 * Storage is per session (see `state.js`), so sessions cannot contaminate each
 * other. File identity prefers the official `FsVersion` from `ctx.fs.stat`
 * (device, inode, size, mtime, ctime) and adds a bounded sampled-content
 * digest, because an external same-size same-mtime rewrite passes the official
 * guard with no way to tell.
 *
 * @module sbjw/evidence
 */

import { createHash } from 'node:crypto'
import { errorMessage, preview, redactSecrets, weakFingerprint } from './util.js'
import { VERIFICATION_KINDS, STRONG_KINDS } from './verification.js'
import { pathKey } from './shell-facts.js'
export { VERIFICATION_KINDS } from './verification.js'

/** How many bytes are sampled from each end of a file for the content digest. */
const SAMPLE_BYTES = 4096
/** Largest file whose content digest is computed; larger files use metadata only. */
const MAX_SAMPLED_BYTES = 512 * 1024
/** Most files whose content digest is kept per session. */
const MAX_SAMPLED_FILES = 48

/**
 * Compute a bounded content digest for a file handle supplied by the caller.
 *
 * The caller owns reading; this function only hashes, which keeps the ledger
 * free of filesystem error handling it cannot improve.
 *
 * @param readChunk - async `(length) => Buffer` reader over the file.
 * @param size - the file size in bytes.
 * @returns a digest string, or `undefined` when the file is too large.
 */
export async function sampledDigest(readChunk, size) {
  if (!Number.isFinite(size) || size < 0 || size > MAX_SAMPLED_BYTES) return undefined
  if (size === 0) return 'empty'
  const hash = createHash('sha256')
  hash.update(`len:${size};`)
  if (size <= SAMPLE_BYTES * 2) {
    const whole = await readChunk(size)
    hash.update(whole)
  } else {
    const head = await readChunk(SAMPLE_BYTES)
    hash.update(head)
    hash.update('|…|')
    const tail = await readChunk(SAMPLE_BYTES, size - SAMPLE_BYTES)
    hash.update(tail)
  }
  return hash.digest('hex').slice(0, 16)
}

/**
 * Make a stable, filesystem-safe key for a target.
 *
 * @param target - an `FsTarget`-like object or a path string.
 * @returns the key used by the ledger map.
 */
export function evidenceKey(target) {
  if (typeof target === 'string') return target
  return String(target?.targetKey ?? target?.displayPath ?? '')
}

/**
 * The ledger for one session.
 */
export class EvidenceLedger {
  #state
  #limit
  #samplesEnabled

  /**
   * @param state - the session state bucket from `SessionStates`.
   * @param options - ledger options.
   * @param options.maxRecords - maximum retained file records.
   * @param options.samples - whether sampled content digests are kept.
   */
  constructor(state, { maxRecords = 200, samples = true } = {}) {
    this.#state = state
    this.#limit = maxRecords
    this.#samplesEnabled = samples
  }

  /** @returns the number of file records currently held. */
  get size() {
    return this.#state.evidence.size
  }

  /**
   * Record that a file was observed with a known version.
   *
   * @param target - the `FsTarget` from `ctx.fs.resolve`.
   * @param info - the `ctx.fs.stat` result (`undefined` when the file is absent).
   * @param options - extra context.
   * @param options.agent - the observing agent, for the diagnostic label.
   * @param options.digest - a precomputed content digest, when available.
   * @returns the stored record.
   */
  observe(target, info, { agent, digest } = {}) {
    const key = evidenceKey(target)
    const record = {
      key,
      path: String(target?.displayPath ?? key),
      version: info?.version,
      kind: info === undefined ? 'absent' : 'present',
      size: info?.size,
      type: info?.type,
      digest: this.#samplesEnabled ? digest : undefined,
      observedAt: this.#state.seq,
      agentId: agent?.id === undefined ? undefined : String(agent.id),
      stale: false,
      invalidatedBy: undefined,
    }
    const previous = this.#state.evidence.get(key)
    if (previous !== undefined && !sameVersion(previous, record)) {
      // A new observation replaces the old one and overturns every conclusion
      // that was drawn from the previous version.
      this.#recordOverturn(previous, record)
    }
    this.#state.evidence.set(key, record)
    this.#touchOrder(key)
    this.#evict()
    return record
  }

  /**
   * Record a read-only observation when only a path is known.
   *
   * @param path - the path that was read.
   * @param options - extra context.
   * @param options.toolName - the tool that read it.
   * @param options.digest - a content digest when one was computed.
   * @param options.agent - the observing agent.
   * @returns the stored record.
   */
  observePath(path, { toolName, digest, agent } = {}) {
    const key = String(path)
    const record = {
      key,
      path: key,
      version: undefined,
      kind: 'path-only',
      digest: this.#samplesEnabled ? digest : undefined,
      observedAt: this.#state.seq,
      agentId: agent?.id === undefined ? undefined : String(agent.id),
      tool: toolName,
      stale: false,
      invalidatedBy: undefined,
    }
    this.#state.evidence.set(key, record)
    this.#touchOrder(key)
    this.#evict()
    return record
  }

  /**
   * Whether the ledger holds a present-version observation for a target.
   *
   * @param target - the `FsTarget` or path.
   * @returns whether a non-stale observation exists.
   */
  has(target) {
    const record = this.#state.evidence.get(evidenceKey(target))
    return record !== undefined && record.stale !== true && record.kind === 'present'
  }

  /**
   * The stored record for a target.
   *
   * @param target - the `FsTarget` or path.
   * @returns the record, or `undefined`.
   */
  get(target) {
    return this.#state.evidence.get(evidenceKey(target))
  }

  /**
   * Compare a fresh `ctx.fs.stat` result with the stored observation.
   *
   * @param target - the `FsTarget`.
   * @param info - the fresh `ctx.fs.stat` result.
   * @param options - comparison options.
   * @param options.digest - a freshly computed content digest.
   * @returns the comparison verdict.
   */
  compare(target, info, { digest } = {}) {
    const stored = this.#state.evidence.get(evidenceKey(target))
    if (stored === undefined) return { status: 'unobserved' }
    if (stored.kind === 'present' && info === undefined) {
      this.#invalidate(stored, 'the file no longer exists')
      return { status: 'changed', reason: 'the file no longer exists' }
    }
    if (stored.kind === 'present' && String(stored.version) !== String(info?.version)) {
      this.#invalidate(stored, 'filesystem version changed')
      return { status: 'changed', reason: 'filesystem version changed since it was read' }
    }
    if (this.#samplesEnabled && stored.digest !== undefined && digest !== undefined && stored.digest !== digest) {
      this.#invalidate(stored, 'content digest changed')
      return { status: 'changed', reason: 'content changed in place without a version change' }
    }
    return { status: 'fresh' }
  }

  /**
   * Mark every stored observation of a key stale, recording the cause.
   *
   * @param target - the `FsTarget` or path.
   * @param reason - why the observation no longer holds.
   * @returns whether a record was invalidated.
   */
  invalidate(target, reason) {
    const record = this.#state.evidence.get(evidenceKey(target))
    if (record === undefined) return false
    this.#invalidate(record, reason)
    return true
  }

  #invalidate(record, reason) {
    if (record.stale === true && record.invalidatedBy === reason) return
    record.stale = true
    record.invalidatedBy = reason
    this.#state.overturned.push({
      path: record.path,
      at: this.#state.seq,
      reason: String(reason),
    })
    this.#boundOverturned()
  }

  #recordOverturn(previous, next) {
    this.#state.overturned.push({
      path: next.path,
      at: this.#state.seq,
      reason: previous.kind === 'present' && next.kind === 'present' ? 're-read: version changed' : `re-read: now ${next.kind}`,
    })
    this.#boundOverturned()
  }

  #boundOverturned() {
    const max = Math.max(8, this.#limit)
    if (this.#state.overturned.length > max) {
      this.#state.overturned.splice(0, this.#state.overturned.length - max)
    }
  }

  #touchOrder(key) {
    const order = this.#state.evidenceOrder
    const existing = order.indexOf(key)
    if (existing >= 0) order.splice(existing, 1)
    order.push(key)
  }

  #evict() {
    const order = this.#state.evidenceOrder
    while (order.length > this.#limit) {
      const key = order.shift()
      if (key !== undefined) this.#state.evidence.delete(key)
    }
    if (order.length > MAX_SAMPLED_FILES) {
      // Keep digests only for the most recent files: the cost is bounded and
      // the older records still carry the official version.
      for (let index = 0; index < order.length - MAX_SAMPLED_FILES; index += 1) {
        const record = this.#state.evidence.get(order[index])
        if (record !== undefined) record.digest = undefined
      }
    }
  }

  /**
   * Record a tool result observation.
   *
   * @param observation - the observation to store.
   * @param observation.toolName - the tool that produced the result.
   * @param observation.isError - whether the call failed.
   * @param observation.contentText - the result text, already bounded by the caller.
   * @param observation.signature - the canonical call signature.
   * @param observation.argumentsPreview - a bounded, redacted arguments preview.
   * @param observation.testsPassed - parsed test outcome, when the result carries one.
   * @param observation.testsFailed - parsed failing-test count, when known.
   */
  recordCall({ toolName, isError, contentText, signature, argumentsPreview, testsPassed, testsFailed }) {
    const contentKey = weakFingerprint(String(contentText ?? ''))
    const entry = {
      at: this.#state.seq,
      toolName,
      isError: isError === true,
      contentKey,
      signature,
      argumentsPreview: argumentsPreview === undefined ? undefined : preview(redactSecrets(argumentsPreview), 200),
      testsPassed,
      testsFailed,
    }
    this.#state.calls.push(entry)
    const window = Math.max(4, this.#state.callWindowSize)
    if (this.#state.calls.length > window) this.#state.calls.splice(0, this.#state.calls.length - window)
    return entry
  }

  /**
   * Record a verification of the current state.
   *
   * @param verification - the verification to record.
   * @param verification.kind - one of {@link VERIFICATION_KINDS}.
   * @param verification.toolName - the tool that performed it.
   * @param verification.passed - whether the verification passed.
   * @param verification.strong - whether the verdict allows this check to cover a mutation.
   * @param verification.detail - a bounded, already-redacted description.
   * @param verification.atSeq - the call sequence at which it happened.
   * @returns the stored verification.
   */
  recordVerification({ kind, toolName, passed, strong = STRONG_KINDS.has(kind), detail, atSeq, startSeq, targets = [] }) {
    const entry = {
      kind: VERIFICATION_KINDS.includes(kind) ? kind : 'unknown',
      toolName,
      passed: passed === true,
      strong: strong === true && STRONG_KINDS.has(kind),
      detail: detail === undefined ? undefined : preview(redactSecrets(String(detail)), 200),
      at: Number.isFinite(atSeq) ? atSeq : this.#state.seq,
      startSeq: startSeq ?? atSeq ?? this.#state.seq,
      targets: targets.map(target => ({ ...target, path: pathKey(target.path, this.#state.workspaceRoot) })),
    }
    this.#state.verifications.push(entry)
    const max = Math.max(16, this.#limit)
    if (this.#state.verifications.length > max) this.#state.verifications.splice(0, this.#state.verifications.length - max)
    this.#state.mutationSinceVerification = this.#state.mutated && this.verificationCoveringLatestMutation() === undefined
    return entry
  }

  /**
   * Whether a strong verification happened after the newest mutation.
   *
   * @returns the newest strong verification that covers the last mutation, or `undefined`.
   */
  verificationCoveringLatestMutation() {
    if (this.#state.unresolvedMutationCount > 0) return undefined
    const changes = [...this.#state.mutations.values()]
    if (!changes.length) return undefined
    const covered = changes.map(change => this.covering(change))
    return covered.every(Boolean) ? covered.at(-1) : undefined
  }

  covering(change) {
    return this.#state.verifications.findLast(entry => entry.passed && entry.strong
      && entry.at > change.at && entry.startSeq > change.at
      && entry.targets.some(target => target.path === change.key && target.expected === change.expected))
  }

  pendingMutations() {
    return [...this.#state.mutations.values()].filter(change => !this.covering(change))
  }

  /** Replace stale observations with a newly confirmed state, including absence. */
  confirmObservation(path, expected) {
    const key = pathKey(path, this.#state.workspaceRoot)
    let matched = false
    for (const record of this.#state.evidence.values()) {
      if (pathKey(record.path, this.#state.workspaceRoot) !== key) continue
      record.kind = expected === 'absent' ? 'absent' : 'path-only'
      record.stale = false
      record.invalidatedBy = undefined
      record.observedAt = this.#state.seq
      record.version = undefined
      record.digest = undefined
      matched = true
    }
    if (!matched) {
      const record = this.observePath(path)
      record.kind = expected === 'absent' ? 'absent' : 'path-only'
    }
  }

  /**
   * Note that a state-changing call happened at the current sequence.
   *
   * @param path - the mutated path, when the tool call names one.
   * @param risk - the classification risk level.
   */
  noteMutation(path, risk, { expected = 'present', type, toolName, startSeq, before } = {}) {
    this.#state.mutated = true
    this.#state.mutationSinceVerification = true
    this.#state.lastMutationSeq = this.#state.seq
    this.#state.lastMutationRisk = risk
    const key = path ? pathKey(path, this.#state.workspaceRoot) : `unscoped:${this.#state.seq}`
    const preState = before && typeof before === 'object'
      ? {
          present: before.present === true,
          type: typeof before.type === 'string' ? before.type : undefined,
          size: Number.isFinite(before.size) ? Number(before.size) : undefined,
        }
      : undefined
    this.#state.mutations.set(key, { key, path, expected, type, at: this.#state.seq, risk, before: preState })
    this.#state.mutationEvents.push({ key, path, expected, type, at: this.#state.seq, risk, toolName, startSeq, before: preState })
    if (this.#state.mutationEvents.length > this.#limit) this.#state.mutationEvents.shift()
    if (typeof path === 'string' && path !== '') {
      this.#state.mutatedFiles.add(path)
      this.#state.sessionMutatedFiles.add(path)
    }
  }

  noteUnresolvedMutation(toolName, reason, startSeq, command = '') {
    this.#state.unresolvedMutationCount++
    this.#state.unresolvedMutations.push({ toolName, reason, startSeq, at: this.#state.seq,
      command: String(command).slice(0, 16000), commandTruncated: String(command).length > 16000 })
  }

  /**
   * Declare an unknown or unverified assumption.
   *
   * @param text - the declared unknown, already bounded by the caller.
   * @param source - where the declaration came from.
   * @returns whether it was added (duplicates are folded).
   */
  noteUnknown(text, source) {
    const value = String(text ?? '').trim()
    if (value === '') return false
    if (this.#state.unknowns.some((item) => item.text === value)) return false
    this.#state.unknowns.push({ id: `${this.#state.seq}:${++this.#state.unknownSerial}`, text: preview(redactSecrets(value), 240), source, at: this.#state.seq })
    const max = Math.max(8, Math.floor(this.#limit / 4))
    if (this.#state.unknowns.length > max) this.#state.unknowns.splice(0, this.#state.unknowns.length - max)
    return true
  }

  /**
   * Note a failure that is currently unexplained. Blind-retry detection and
   * the completion gate both read this list.
   *
   * @param description - a bounded, redacted description of the failure.
   * @param key - a stable key for the failure, so a repeat is recognized.
   * @returns whether this is a newly seen failure.
   */
  noteFailure(description, key) {
    const text = preview(redactSecrets(String(description ?? '')), 240)
    if (this.#state.unexplainedFailures.some((item) => item.key === key)) return false
    this.#state.unexplainedFailures.push({ id: `failure-${this.#state.seq}-${++this.#state.failureSerial}`, key, text, at: this.#state.seq })
    const max = Math.max(4, Math.floor(this.#limit / 8))
    if (this.#state.unexplainedFailures.length > max) this.#state.unexplainedFailures.splice(0, this.#state.unexplainedFailures.length - max)
    return true
  }

  /**
   * Clear a failure once a later success or verification explains it.
   *
   * @param key - the failure key.
   * @returns whether a failure was cleared.
   */
  clearFailure(key) {
    const index = this.#state.unexplainedFailures.findIndex((item) => item.key === key)
    if (index < 0) return false
    this.#state.unexplainedFailures.splice(index, 1)
    return true
  }

  /** @returns how many failures are currently unexplained. */
  get unexplainedCount() {
    return this.#state.unexplainedFailures.length
  }

  /**
   * Record that external information was retrieved, for the freshness gate.
   *
   * @param topic - a normalized topic key.
   * @param options - retrieval metadata.
   * @param options.toolName - the retrieval tool.
   * @param options.now - the timestamp to record (defaults to `Date.now()`).
   */
  noteFreshness(topic, { toolName, now = Date.now() } = {}) {
    this.#state.freshness.delete(String(topic))
    this.#state.freshness.set(String(topic), { at: now, toolName })
    while (this.#state.freshness.size > this.#limit) this.#state.freshness.delete(this.#state.freshness.keys().next().value)
  }

  /**
   * The newest retrieval for a topic.
   *
   * @param topic - a normalized topic key.
   * @returns the record, or `undefined`.
   */
  freshnessOf(topic) {
    return this.#state.freshness.get(String(topic))
  }

  /**
   * Render a compressed digest of current evidence for injection into the
   * conversation.
   *
   * Only the facts that change a decision are included: stale observations,
   * unexplained failures, unverified mutations, declared unknowns, and the
   * verification that covers (or fails to cover) the latest mutation.
   *
   * @param options - digest options.
   * @param options.maxChars - hard character cap.
   * @param options.includePaths - whether file paths may appear (off keeps
   *   the digest content-free for shared logs).
   * @returns the digest text, or `''` when there is nothing worth saying.
   */
  digest({ maxChars = 2400, includePaths = true } = {}) {
    const lines = []
    const stale = [...this.#state.evidence.values()].filter((record) => record.stale === true)
    if (stale.length > 0) {
      lines.push(`stale observations (re-read before relying on them): ${stale.length}`)
      for (const record of stale.slice(-5)) {
        lines.push(`  - ${includePaths ? record.path : `file#${weakFingerprint(record.path)}`}: ${record.invalidatedBy}`)
      }
    }
    const freshPresent = [...this.#state.evidence.values()].filter((record) => record.stale !== true && record.kind === 'present')
    if (freshPresent.length > 0 && lines.length === 0) {
      lines.push(`observed files currently fresh: ${freshPresent.length}`)
    }
    if (this.#state.mutated) {
      const covering = this.verificationCoveringLatestMutation()
      lines.push(
        covering === undefined
          ? 'mutations this session: yes; verification covering the latest mutation: NONE'
          : `mutations this session: yes; latest covering verification: ${covering.kind} (${covering.toolName ?? 'unknown tool'})`,
      )
      if (this.#state.mutatedFiles.size > 0) {
        const names = includePaths ? [...this.#state.mutatedFiles].slice(-6) : [...this.#state.mutatedFiles].slice(-6).map((path) => `file#${weakFingerprint(path)}`)
        lines.push(`  mutated: ${names.join(', ')}`)
      }
    }
    if (this.#state.unresolvedMutationCount > 0) lines.push(`unresolved mutation risks: ${this.#state.unresolvedMutationCount}; not verified (not asserted as observed changes)`)
    if (this.#state.unexplainedFailures.length > 0) {
      lines.push(`unexplained failures: ${this.#state.unexplainedFailures.length}`)
      for (const failure of this.#state.unexplainedFailures.slice(-4)) lines.push(`  - ${failure.text}`)
    }
    if (this.#state.unknowns.length > 0) {
      lines.push(`declared unknowns: ${this.#state.unknowns.length}`)
      for (const unknown of this.#state.unknowns.slice(-4)) lines.push(`  - ${unknown.text}`)
    }
    if (this.#state.overturned.length > 0) {
      lines.push(`conclusions overturned by later evidence: ${this.#state.overturned.length}`)
      for (const item of this.#state.overturned.slice(-3)) {
        lines.push(`  - ${includePaths ? item.path : `file#${weakFingerprint(item.path)}`}: ${item.reason}`)
      }
    }
    if (lines.length === 0) return ''
    let text = lines.join('\n')
    if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… (digest truncated)`
    return text
  }

  /**
   * A content-free summary for diagnostics.
   *
   * @returns counters and sizes only.
   */
  summary() {
    const records = [...this.#state.evidence.values()]
    return {
      observedFiles: records.length,
      freshFiles: records.filter((record) => record.stale !== true && record.kind === 'present').length,
      staleFiles: records.filter((record) => record.stale === true).length,
      recentCalls: this.#state.calls.length,
      verifications: this.#state.verifications.length,
      mutations: this.#state.sessionMutatedFiles.size,
      mutationVerified: this.verificationCoveringLatestMutation() !== undefined,
      pendingMutations: this.pendingMutations().length,
      unresolvedMutationRisks: this.#state.unresolvedMutationCount,
      unexplainedFailures: this.#state.unexplainedFailures.length,
      unknowns: this.#state.unknowns.length,
      overturned: this.#state.overturned.length,
    }
  }
}

function sameVersion(left, right) {
  return left.kind === right.kind && String(left.version) === String(right.version)
}

/**
 * Wrap an error for diagnostics without losing the cause chain.
 *
 * @param error - the thrown value.
 * @returns a redacted one-line description.
 */
export function describeError(error) {
  return redactSecrets(errorMessage(error))
}

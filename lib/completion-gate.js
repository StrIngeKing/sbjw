/**
 * The completion gate.
 *
 * Before a turn is allowed to end, the gate answers one question with
 * deterministic evidence: is anything the model is about to call "done"
 * actually unverified, unexplained, or unknown?
 *
 * The gate never inspects reasoning and never asks a model. It reads the
 * session's own ledger — which mutations happened, which verifications were
 * observed, which failures were never explained, which files are stale — and
 * turns each gap into one actionable line.
 *
 * @module dsh-reliability-guard/completion-gate
 */

/**
 * Evaluate the completion gate for one session.
 *
 * @param input - evaluation input.
 * @param input.state - the session state bucket.
 * @param input.verification - the verification that covers the latest mutation, when one exists.
 * @param input.requireVerificationForMutation - whether an unverified mutation is a blocking gap.
 * @param input.reviewRequired - whether an independent review is required for this turn.
 * @param input.reviewVerdict - the reviewer's verdict, when a review already ran.
 * @param input.reviewCappedOut - whether the review budget is exhausted.
 * @param input.freshnessGaps - open freshness gaps from the freshness gate.
 * @returns the gate result: `passed` plus an ordered gap list.
 */
export function evaluateCompletionGate({
  state,
  verification,
  requireVerificationForMutation,
  reviewRequired,
  reviewVerdict,
  reviewCappedOut,
  freshnessGaps = [],
  pendingMutations,
}) {
  const gaps = []
  const push = (category, severity, message) => gaps.push({ category, severity, message })

  if (state.disposed) {
    return { passed: true, gaps: [], skipped: 'session disposed' }
  }

  // The mutation gap is judged for the CURRENT turn, by call sequence: a
  // mutation from an earlier turn has a sequence at or before this turn's start
  // marker, and a later read-only turn cannot verify it. Demanding it anyway
  // would make the guard generate busywork about its own history.
  const mutatedThisTurn = state.lastMutationSeq > state.turnStartSeq
  if (requireVerificationForMutation && state.unresolvedMutationCount > 0) {
    push('unresolved-mutation', 'blocking', `${state.unresolvedMutationCount} mutating call(s) have unresolved targets or observations. Use reliability_guard(detail:true) for call_seq, then reliability_guard_reconcile(action:declare_targets, call_seq, targets:[{path,expected}], reason) to declare the FULL affected scope. A declaration is NOT evidence: separate fresh target checks must follow. Review PASS or unrelated reads cannot clear it. / 补录完整目标后必须独立回读，不能宣称已经验证。`)
  }
  if (requireVerificationForMutation && mutatedThisTurn && state.mutationSinceVerification && verification === undefined) {
    const changes = pendingMutations ?? [...(state.mutations?.values() ?? [])]
    const files = changes.map(change => change.path).filter(Boolean).slice(-4)
    push(
      'verification',
      'blocking',
      `A state change in this turn has no covering verification${files.length > 0 ? ` (changed: ${files.join(', ')})` : ''}. Re-read a changed file; for deletion prefer a separate bare Test-Path -LiteralPath 'exact-target' (False). A fixed literal label + (Test-Path -LiteralPath 'exact-target') is also accepted when that exact Boolean line is returned. Get-Item reporting the exact target missing also works. A parent Get-ChildItem -LiteralPath 'exact-parent' -Force is only strong when the guard can independently stat the recorded target as absent; the listing alone is never proof. If a later deletion was not recorded, declare the corrected scope with reliability_guard_reconcile, then verify it. Review PASS does not replace target observation.`,
    )
  }

  // A failure only blocks the turn it happened in. The guard cannot tell a real
  // blocker from a transient one without evidence, and carrying it forward would
  // stop a later, unrelated, fully verified turn until the identical command
  // succeeded. The ledger keeps the record; the gate scopes the demand.
  const failuresThisTurn = state.unexplainedFailures.filter((failure) => failure.at > state.turnStartSeq)
  if (failuresThisTurn.length > 0) {
    const first = failuresThisTurn[0]
    push(
      'failure',
      'blocking',
      `${failuresThisTurn.length} failure(s) in this turn were never explained. The first is: ${first.text}. Either fix it, use reliability_guard_reconcile action=resolve_failure with failure_id, resolution=explained/unrelated and an evidence-based reason (caller explanation, not verified success), or report it as an open failure.`,
    )
  }

  const unverifiedClasses = new Set()
  if (state.sessionMutatedFiles.size > 0 && verification === undefined && !requireVerificationForMutation) {
    unverifiedClasses.add('mutation')
  }
  if (unverifiedClasses.size > 0) {
    push('verification', 'advisory', 'A change was made and no verification was recorded; confirm the change before reporting it as done.')
  }

  if (state.unknowns.length > 0) {
    push(
      'unknown',
      'advisory',
      `${state.unknowns.length} declared unknown(s) remain open: ${state.unknowns.slice(-3).map((item) => item.text).join(' | ')}. Resolve them or mark them explicitly as unresolved in the final report.`,
    )
  }

  const stale = [...state.evidence.values()].filter((record) => record.stale === true)
  if (stale.length > 0 && state.mutated) {
    push(
      'context',
      'advisory',
      `${stale.length} recorded observation(s) are stale because the underlying file changed. Re-read them before relying on any conclusion drawn from them.`,
    )
  }

  for (const gap of freshnessGaps) push('freshness', gap.severity ?? 'advisory', gap.message)

  if (state.reviewDeferredToParent) push('review-deferred', 'advisory', 'Child-session independent review is deferred to the parent. Return evidence and limitations; do not recursively spawn a reviewer or claim this child was independently reviewed. / 子会话将独立评审交回父会话。')
  if (reviewRequired && state.reviewUnavailable) push('review-unavailable', 'blocking', state.reviewUnavailable)
  if (reviewRequired && !state.reviewUnavailable && reviewVerdict === undefined && !reviewCappedOut) {
    push('review', 'blocking', 'This change is high-risk or spans several files and has not been reviewed by an independent reviewer. Request the review, or state that no review channel is available.')
  }
  if (reviewVerdict !== undefined && reviewVerdict.verdict === 'FAIL' && !reviewCappedOut) {
    push('review', 'blocking', `The independent reviewer returned FAIL: ${reviewVerdict.reason}`)
  }
  // The review budget bounds the loop, not the finding: once the budget is spent
  // an unresolved FAIL still blocks a clean completion, so the executor has to
  // report the reviewer's objection instead of quietly passing itself.
  if (reviewVerdict !== undefined && reviewVerdict.verdict === 'FAIL' && reviewCappedOut) {
    push(
      'review',
      'blocking',
      `The independent reviewer returned FAIL and the review budget is spent, so the objection is unresolved: ${reviewVerdict.reason} Report this finding explicitly in your answer instead of presenting the work as complete.`,
    )
  }

  const blocking = gaps.filter((gap) => gap.severity === 'blocking')
  return {
    passed: blocking.length === 0,
    gaps,
    blocking: blocking.length,
    advisory: gaps.length - blocking.length,
  }
}

/**
 * Convert gate gaps into the lines the model receives.
 *
 * @param gaps - the gaps from {@link evaluateCompletionGate}.
 * @returns one line per gap, blocking items first.
 */
export function gapLines(gaps) {
  const ordered = [...gaps].sort((left, right) => (left.severity === right.severity ? 0 : left.severity === 'blocking' ? -1 : 1))
  return ordered.map((gap) => gap.message)
}

/**
 * Whether the next injection is still within budget.
 *
 * The bound is what stops the gate from becoming the loop it exists to
 * prevent: after `maxInjectionsPerTurn` corrections the gate reports the gap
 * once more as an advisory and lets the turn end.
 *
 * @param state - the session state bucket.
 * @param maxInjectionsPerTurn - configured bound.
 * @returns whether another injection is allowed.
 */
export function canInject(state, maxInjectionsPerTurn) {
  const used = state.gate?.injections ?? 0
  return used < maxInjectionsPerTurn
}

/**
 * Whether an advisory note may still be attached this turn.
 *
 * Advisory gaps exist so a turn is *informed* — that a declared unknown is
 * still open, that an observation went stale, that a retrieval is missing —
 * without being blocked. They get their own, larger budget than blocking
 * corrections: three advisory notices in total per turn, then silence.
 *
 * @param state - the session state bucket.
 * @returns whether another advisory note is allowed.
 */
export function canAdvise(state) {
  return (state.gate?.advisories ?? 0) < 3
}

/** Record that one advisory note was attached. */
export function noteAdvisory(state) {
  state.gate = { ...(state.gate ?? {}), advisories: (state.gate?.advisories ?? 0) + 1 }
}

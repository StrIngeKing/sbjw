/** Caller-declared scope is not filesystem evidence: fresh observations must follow. */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { EvidenceLedger } from './evidence.js'
import { pathKey } from './shell-facts.js'
import { redactSecrets, preview } from './util.js'

export function settleReconciliations(state, ledger) {
  for (const risk of state.unresolvedMutations) {
    if (risk.resolvedAt !== undefined || !risk.targets?.length) continue
    if (!risk.targets.every(target => {
      const change = state.mutations.get(target.path)
      return change?.at === risk.declaredAt && change.expected === target.expected && state.verifications.some(v =>
        ['read-back', 'absence'].includes(v.kind) && v.passed && v.strong && v.at > change.at && v.startSeq > change.at
        && v.targets.some(t => t.path === target.path && t.expected === target.expected))
    })) continue
    risk.resolvedAt = state.seq
  }
  state.unresolvedMutationCount = state.unresolvedMutations.filter(risk => risk.resolvedAt === undefined).length
}

export function declareTargets(state, ledger, args) {
  if (!Number.isSafeInteger(args.call_seq) || args.call_seq <= state.turnStartSeq || args.call_seq >= state.seq) throw new Error('call_seq must identify an earlier call in this turn')
  if (!args.reason?.trim()) throw new Error('Explain the source of the declared scope; a declaration is not an observation')
  if (!Array.isArray(args.targets) || !args.targets.length || args.targets.length > 100) throw new Error('Declare 1–100 concrete targets')
  const targets = args.targets.map(target => {
    if (!['present', 'absent'].includes(target.expected) || typeof target.path !== 'string' || !target.path.trim() || /[*?\[\]\r\n]/.test(target.path)) throw new Error('Each target needs a literal path and present/absent expected state')
    return { path: pathKey(target.path, state.workspaceRoot), expected: target.expected }
  })
  if (new Set(targets.map(t => t.path)).size !== targets.length) throw new Error('Duplicate or conflicting target paths')
  let risk = state.unresolvedMutations.find(item => item.at === args.call_seq && item.resolvedAt === undefined)
  const changes = [...state.mutations.values()].filter(item => item.at === args.call_seq)
  if (!risk && !changes.length) throw new Error('No unresolved risk or current mutation matches call_seq')
  const required = [...changes.filter(item => item.path).map(item => item.key), ...(risk?.targets ?? []).map(item => item.path)]
  if (required.some(path => !targets.some(t => t.path === path))) throw new Error('Cannot omit previously recorded targets when redeclaring scope')
  if (!risk) {
    ledger.noteUnresolvedMutation('reconciliation', 'caller declared a corrected target scope', args.call_seq)
    risk = state.unresolvedMutations.at(-1)
    risk.at = args.call_seq
  }
  risk.reasonForDeclaration = preview(redactSecrets(args.reason), 1000)
  risk.targets = targets
  risk.declaredAt = state.seq
  risk.scopeSource = 'caller-declared; not independently proven'
  for (const change of changes) if (!change.path) state.mutations.delete(change.key)
  for (const event of state.mutationEvents) if (event.at === args.call_seq && !event.path) event.supersededBy = state.seq
  for (const target of targets) {
    const previous = state.mutations.get(target.path)
    ledger.noteMutation(target.path, previous?.risk ?? 'HIGH', { expected: target.expected, type: previous?.type, toolName: 'sbjw_reconcile', startSeq: state.seq })
  }
  state.gate = undefined // A new repair attempt gets a bounded opportunity to verify.
  settleReconciliations(state, ledger)
  return 'Scope declared, NOT verified. Run separate exact-target reads or bare Test-Path checks; for deletions a parent listing with exact stat confirmation also works. / 目标已声明，尚未验证。范围来源是调用者声明，不是独立证明。'
}

export function resolveUnknown(state, args) {
  if (!args.reason?.trim()) throw new Error('A resolution explanation is required')
  const index = state.unknowns.findIndex(item => item.id === args.unknown_id)
  if (index < 0) throw new Error('Unknown declaration id was not found')
  const unknown = state.unknowns[index]
  const evidence = state.verifications.find(v => v.at === args.evidence_seq && v.passed && v.at > unknown.at)
  if (!evidence) throw new Error('Reference a successful verification newer than the declaration')
  state.resolvedUnknowns.push({ ...unknown, resolvedAt: state.seq, evidenceSeq: evidence.at, reason: preview(redactSecrets(args.reason), 1000), resolutionSource: 'caller interpretation of recorded evidence' })
  if (state.resolvedUnknowns.length > 100) state.resolvedUnknowns.shift()
  state.unknowns.splice(index, 1)
  return 'Unknown resolved by caller explanation linked to recorded evidence; mutation and review gates are unchanged. / 未知项已关联证据说明，不影响变更或评审门禁。'
}

export function registerReconciliationTool(ctx, states, view) {
  return ctx.tools.register(defineTool({
    name: 'sbjw_reconcile',
    description: 'Repair accounting without waiving gates: declare scope; resolve an unknown only after a newer passing verification; or explain a non-read task failure (not PASS). / 修复记账：未知项须先做晚于声明的成功核查；读取失败属于核查失败，不用 resolve_failure。',
    parameters: {
      action: { type: 'string', enum: ['declare_targets', 'resolve_unknown', 'resolve_failure'], required: true },
      call_seq: { type: 'integer', description: 'Earlier call sequence. / 原始调用序号。' },
      targets: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, expected: { type: 'string', enum: ['present', 'absent'], required: true },
      } } },
      unknown_id: { type: 'string' }, evidence_seq: { type: 'integer', description: 'For resolve_unknown: sequence of a passing verification newer than the declaration; order is declare -> new check -> resolve. / resolve_unknown 必须引用晚于声明的新成功核查。' },
      failure_id: { type: 'string', description: 'Failure id. / 失败编号。' },
      resolution: { type: 'string', enum: ['explained', 'unrelated'], description: 'Explanation status; not PASS. / 说明状态，非成功验证。' },
      reason: { type: 'string', required: true, description: 'Scope/evidence explanation; do not invent evidence. / 范围或证据说明。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      if (!exec.agent?.session) throw new Error('Reconciliation requires a session')
      const state = states.get(exec.agent.session)
      const ledger = new EvidenceLedger(state, { maxRecords: view.live().evidence.maxRecords })
      if (args.action === 'declare_targets') return declareTargets(state, ledger, args)
      if (args.action === 'resolve_unknown') return resolveUnknown(state, args)
      if (args.action === 'resolve_failure') return resolveFailure(state, args)
      throw new Error('Unknown reconciliation action')
    },
  }))
}

/** An audited caller explanation closes only the unexplained-failure gap. */
export function resolveFailure(state, args) {
  if (typeof args.reason !== 'string' || !args.reason.trim()) throw new Error('Provide evidence and an explanation of why this failure is explained or unrelated')
  if (!['explained', 'unrelated'].includes(args.resolution)) throw new Error('resolution must be explained or unrelated')
  const index = state.unexplainedFailures.findIndex(item => item.id === args.failure_id)
  if (index < 0) throw new Error('Failure id was not found')
  const failure = state.unexplainedFailures[index]
  if (args.evidence_seq !== undefined && !state.verifications.some(v => v.at === args.evidence_seq && v.passed && v.at > failure.at)) throw new Error('evidence_seq must reference a recorded passing verification newer than the failure')
  const { key, ...publicFailure } = failure
  state.resolvedFailures.push({ ...publicFailure, resolvedAt: state.seq, resolution: args.resolution, reason: preview(redactSecrets(args.reason), 1000), evidenceSeq: args.evidence_seq, resolutionSource: 'caller explanation; not verified success' })
  if (state.resolvedFailures.length > 100) state.resolvedFailures.shift()
  state.unexplainedFailures.splice(index, 1)
  state.failures.delete(key)
  return 'Failure explained / 失败已解释（调用者说明，非验证成功）；mutation and review gates remain unchanged.'
}

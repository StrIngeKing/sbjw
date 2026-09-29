import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, existsSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Guard from '../lib/index.js'
import { sessionStatesOf } from '../lib/state.js'
import { EvidenceLedger } from '../lib/evidence.js'
import { shellMutationFacts, shellReadQueries } from '../lib/shell-facts.js'
import { classifyRisk } from '../lib/risk.js'
import { realFiles, plan } from './helpers/real-files.js'
import { callTool, guardNotices, resultText } from './helpers/harness.js'
import { evaluateCompletionGate } from '../lib/completion-gate.js'

const bucket = (p, a) => sessionStatesOf(Guard.default, p.ctx).peek(a.session)
const make = (p, name, options = {}) => p.harness.create(SessionId(name), options, { cwd: p.root })
const gate = state => evaluateCompletionGate({ state, requireVerificationForMutation: true, verification: new EvidenceLedger(state).verificationCoveringLatestMutation() })
const fixtureTool = (ctx, name, execute, schema = { type: 'string' }) => ctx.tools.register(defineTool({ name, description: 'Controlled review fixture.', parameters: {}, output: { schema, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }, execute }))

test('quoted comma arrays retain all targets and do not split commas inside a filename', () => {
  const command = "Remove-Item -LiteralPath 'a','b','c','d' -Force"
  assert.deepEqual(shellMutationFacts(command, { powershell: true }), { targets: ['a', 'b', 'c', 'd'], unresolved: [] })
  assert.deepEqual(shellMutationFacts("Remove-Item 'a,b','c d'", { powershell: true }).targets, ['a,b', 'c d'])
  assert.equal(classifyRisk({ toolName: 'pwsh', args: { command }, workspaceRoot: 'C:/work' }).risk, 'HIGH')
  assert.deepEqual(shellReadQueries("Test-Path -LiteralPath 'a','b'", { powershell: true }).map(q => q.path), ['a', 'b'])
})

for (const verification of ["Test-Path -LiteralPath 'a','b','c','d'", 'Get-ChildItem -LiteralPath . -Force', 'Get-ChildItem -Force', "'a: ' + (Test-Path -LiteralPath 'a'); 'b: ' + (Test-Path -LiteralPath 'b'); 'c: ' + (Test-Path -LiteralPath 'c'); 'd: ' + (Test-Path -LiteralPath 'd')"]) {
  test(`four-target delete is covered by ${verification}`, { skip: process.platform !== 'win32' }, async t => {
    const p = await realFiles(t, { review: { enabled: false } }), a = await make(p, 'four-delete')
    for (const file of ['a','b','c','d']) writeFileSync(p.targetOf(file), file)
    const removed = await callTool(p.ctx, 'pwsh', { command: "Remove-Item -LiteralPath 'a','b','c','d' -Force", description: plan }, { agent: a })
    assert.equal(removed.isError, false)
    const s = bucket(p, a), ledger = new EvidenceLedger(s)
    assert.equal(ledger.pendingMutations().length, 4)
    assert.equal(s.unresolvedMutationCount, 0)
    await callTool(p.ctx, 'pwsh', { command: verification }, { agent: a })
    assert.equal(ledger.pendingMutations().length, 0)
    assert.equal(gate(s).passed, true)
    assert.equal(s.verifications.at(-1).kind, 'absence')
  })
}

for (const check of ['Test-Path -LiteralPath gone.txt', 'Get-ChildItem -LiteralPath . -Force']) {
  test(`declare unknown deletion scope, then independently verify with ${check}`, { skip: process.platform !== 'win32' }, async t => {
    const p = await realFiles(t, { review: { enabled: false } }), a = await make(p, 'recover')
    await callTool(p.ctx, 'write', { file_path: 'gone.txt', content: 'fixture' }, { agent: a })
    const s = bucket(p, a), ledger = new EvidenceLedger(s)
    await callTool(p.ctx, 'pwsh', { command: "$f=Join-Path . 'gone.txt'; Remove-Item $f", description: plan }, { agent: a })
    const risk = s.unresolvedMutations.at(-1)
    assert.match(risk.command, /Join-Path/)
    assert.equal(s.unresolvedMutationCount, 1)
    assert.equal([...s.mutations.values()][0].expected, 'present', 'old write has not silently become a deletion')
    const declared = await callTool(p.ctx, 'sbjw_reconcile', { action: 'declare_targets', call_seq: risk.at, targets: [{ path: 'gone.txt', expected: 'absent' }], reason: 'The preceding command joined cwd with the literal gone.txt; the whole affected scope is this file.' }, { agent: a })
    assert.equal(declared.isError, false, resultText(declared))
    assert.equal(s.unresolvedMutationCount, 1, 'declaration alone is not proof')
    assert.equal(ledger.pendingMutations().length, 1)
    writeFileSync(p.targetOf('unrelated'), 'unrelated')
    await callTool(p.ctx, 'read', { file_path: 'unrelated' }, { agent: a })
    assert.equal(s.unresolvedMutationCount, 1)
    await callTool(p.ctx, 'pwsh', { command: check }, { agent: a })
    assert.equal(s.unresolvedMutationCount, 0)
    assert.equal(ledger.pendingMutations().length, 0)
    assert.equal(gate(s).passed, true)
    const diag = resultText(await callTool(p.ctx, 'sbjw', { detail: true }, { agent: a }))
    assert.match(diag, /superseded by #/)
  })
}

test('declaration cannot omit known targets, use a future call, or certify a still-present deleted file', async t => {
  const p = await realFiles(t, { review: { enabled: false } }), a = await make(p, 'bad-declare')
  await callTool(p.ctx, 'write', { file_path: 'kept', content: 'fixture' }, { agent: a })
  const s = bucket(p, a), seq = s.seq
  for (const args of [{ call_seq: seq, targets: [] }, { call_seq: 9999, targets: [{ path: 'kept', expected: 'absent' }] }, { call_seq: seq, targets: [{ path: 'other', expected: 'absent' }] }]) {
    const r = await callTool(p.ctx, 'sbjw_reconcile', { action: 'declare_targets', reason: 'test validation', ...args }, { agent: a })
    assert.equal(r.isError, true)
  }
  const r = await callTool(p.ctx, 'sbjw_reconcile', { action: 'declare_targets', call_seq: seq, targets: [{ path: 'kept', expected: 'absent' }], reason: 'Caller claims deletion; actual file remains.' }, { agent: a })
  assert.equal(r.isError, false)
  await callTool(p.ctx, 'read', { file_path: 'kept' }, { agent: a })
  assert.equal(s.unresolvedMutationCount, 1)
  assert.equal(existsSync(p.targetOf('kept')), true)
  assert.equal(s.unexplainedFailures.length, 0, 'rejected repair requests are explained control errors, not task failures')
})

test('zero-path mutation can be attached to scope without leaving an unscoped permanent gap', async t => {
  const p = await realFiles(t, { review: { enabled: false } }), a = await make(p, 'zero-path')
  writeFileSync(p.targetOf('x'), 'fixture')
  await callTool(p.ctx, 'read', { file_path: 'x' }, { agent: a })
  const s = bucket(p, a), ledger = new EvidenceLedger(s), seq = s.seq
  ledger.noteMutation(undefined, 'CRITICAL')
  const r = await callTool(p.ctx, 'sbjw_reconcile', { action: 'declare_targets', call_seq: seq, targets: [{ path: 'x', expected: 'present' }], reason: 'Identify the full scope of the unscoped fixture change.' }, { agent: a })
  assert.equal(r.isError, false, resultText(r))
  assert.equal(s.unresolvedMutationCount, 1)
  await callTool(p.ctx, 'read', { file_path: 'x' }, { agent: a })
  assert.equal(s.unresolvedMutationCount, 0)
  assert.equal(ledger.pendingMutations().length, 0)
  assert.equal(gate(s).passed, true)
})

test('nested sessions defer review to their parent and depth-limit errors are not unexplained failures', async t => {
  const p = await realFiles(t), a = await make(p, 'nested', { subagentDepth: 1 })
  await callTool(p.ctx, 'write', { file_path: 'x', content: 'fixture' }, { agent: a })
  const s = bucket(p, a)
  s.highRiskCalls = 1
  fixtureTool(p.ctx, 'subagent_fork', () => { throw new Error('subagent depth 2 exceeds maxDepth 1') })
  const r = await callTool(p.ctx, 'subagent_fork', {}, { agent: a })
  assert.equal(r.isError, true)
  assert.equal(s.unexplainedFailures.length, 0)
  assert.equal(s.counters.reviewsRequested, 0)
  assert.equal(s.reviewDeferredToParent, true)
  assert.ok(!guardNotices(r).some(n => n.tag === 'review'))
  assert.match(resultText(await callTool(p.ctx, 'sbjw', { detail: true }, { agent: a })), /DEFERRED TO PARENT \(not PASS\)/)
})

for (const name of ['subagent_fork', 'workflow']) {
  test(`completed ${name} review is captured`, async t => {
    const p = await realFiles(t), a = await make(p, `review-${name}`)
    await callTool(p.ctx, 'write', { file_path: 'x', content: 'fixture' }, { agent: a })
    const s = bucket(p, a)
    s.review = { required: true, round: 1 }
    fixtureTool(p.ctx, name, () => name === 'workflow' ? { kind: 'foreground', agentsStarted: 1, result: 'VERDICT: PASS\nChecked targets.' } : 'VERDICT: PASS\nChecked targets.', name === 'workflow' ? { type: 'json' } : { type: 'string' })
    const r = await callTool(p.ctx, name, {}, { agent: a })
    assert.equal(r.isError, false, resultText(r))
    assert.equal(s.review.verdict.verdict, 'PASS')
  })
}

test('successful novel directory observations advance progress without gaining mutation coverage', async t => {
  const p = await realFiles(t, { maxStallSteps: 2 }), a = await make(p, 'fresh-listings')
  const s = () => bucket(p, a)
  for (let i = 0; i < 8; i++) {
    await callTool(p.ctx, 'glob', { pattern: `different-${i}.txt` }, { agent: a })
    assert.equal(s().counters.stallsBlocked, 0)
  }
  assert.ok(s().verifications.every(v => !v.strong))
})

for (const result of [{ kind: 'background', agentsStarted: 1, result: 'VERDICT: PASS' }, { kind: 'foreground', agentsStarted: 0, result: 'VERDICT: PASS' }]) {
  test(`workflow ${result.kind}/${result.agentsStarted} is not an independent review`, async t => {
    const p = await realFiles(t), a = await make(p, 'not-review')
    await callTool(p.ctx, 'write', { file_path: 'x', content: 'fixture' }, { agent: a })
    const s = bucket(p, a)
    s.review = { required: true, round: 1 }
    fixtureTool(p.ctx, 'workflow', () => result, { type: 'json' })
    await callTool(p.ctx, 'workflow', {}, { agent: a })
    assert.equal(s.review.verdict, undefined)
  })
}

test('machine success cannot settle declared unknown scope without targeted observations', async t => {
  const p = await realFiles(t, { review: { enabled: false } }), a = await make(p, 'not-proof')
  await callTool(p.ctx, 'write', { file_path: 'x', content: 'fixture' }, { agent: a })
  const s = bucket(p, a), seq = s.seq
  await callTool(p.ctx, 'sbjw_reconcile', { action: 'declare_targets', call_seq: seq, targets: [{ path: 'x', expected: 'present' }], reason: 'Declared scope' }, { agent: a })
  fixtureTool(p.ctx, 'probe_test', () => '5 passed, 0 failed')
  await callTool(p.ctx, 'probe_test', {}, { agent: a })
  assert.equal(s.unresolvedMutationCount, 1)
  await callTool(p.ctx, 'read', { file_path: 'x' }, { agent: a })
  assert.equal(s.unresolvedMutationCount, 0)
})

test('unchanged repeated reads do not invent progress when repetition guards are disabled', async t => {
  const p = await realFiles(t, { maxStallSteps: 2, guard: { exactRepeats: false, semanticRepeats: false } }), a = await make(p, 'same-read')
  writeFileSync(p.targetOf('same'), 'same')
  for (let i = 0; i < 4; i++) await callTool(p.ctx, 'read', { file_path: 'same' }, { agent: a })
  assert.ok(bucket(p, a).counters.stallsBlocked > 0)
})

test('focused original commands are redacted and new tools keep object-root schemas', async t => {
  const p = await realFiles(t), a = await make(p, 'risk-detail')
  await callTool(p.ctx, 'read', { file_path: 'missing' }, { agent: a })
  const s = bucket(p, a), ledger = new EvidenceLedger(s)
  ledger.noteUnresolvedMutation('pwsh', 'unresolved fixture', s.seq, "Remove-Item $f # password=secret123")
  const result = await callTool(p.ctx, 'sbjw', { call_seq: s.seq }, { agent: a })
  assert.doesNotMatch(resultText(result), /secret123/)
  assert.match(resultText(result), /Remove-Item/)
  for (const name of ['sbjw', 'sbjw_reconcile']) assert.equal(p.ctx.tools.schemas(undefined).find(s => s.name === name).parameters.type, 'object')
})

test('quoted in-place editor words do not classify a script or temp directory creation as bulk rewrite', () => {
  for (const command of ['node -e "console.log(\'Set-Content delete Out-File\')"', "New-Item -ItemType Directory -Path 'scratch-Out-File' -Force"]) {
    const risk = classifyRisk({ toolName: 'pwsh', args: { command } })
    assert.notEqual(risk.ruleId, 'in-place-edit')
  }
})

test('unknown resolution requires a real newer verification and does not clear mutation gaps', async t => {
  const p = await realFiles(t), a = await make(p, 'unknown')
  await callTool(p.ctx, 'write', { file_path: 'x', content: 'fixture' }, { agent: a })
  const s = bucket(p, a), ledger = new EvidenceLedger(s)
  ledger.noteUnknown('Whether x is readable', 'test')
  const id = s.unknowns[0].id
  const bad = await callTool(p.ctx, 'sbjw_reconcile', { action: 'resolve_unknown', unknown_id: id, evidence_seq: 9999, reason: 'No evidence' }, { agent: a })
  assert.equal(bad.isError, true)
  await callTool(p.ctx, 'read', { file_path: 'x' }, { agent: a })
  const resolved = await callTool(p.ctx, 'sbjw_reconcile', { action: 'resolve_unknown', unknown_id: id, evidence_seq: s.verifications.at(-1).at, reason: 'The read returned its contents.' }, { agent: a })
  assert.equal(resolved.isError, false, resultText(resolved))
  assert.equal(s.unknowns.length, 0)
  assert.equal(s.resolvedUnknowns.length, 1)
})

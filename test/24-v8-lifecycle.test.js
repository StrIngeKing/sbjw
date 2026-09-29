import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as Guard from '../lib/index.js'
import { createSessionState, sessionStatesOf, publishSessionStates, withdrawSessionStates } from '../lib/state.js'
import { EvidenceLedger } from '../lib/evidence.js'
import { Checkpoints, openCounts } from '../lib/checkpoints.js'
import { evaluateFreshness, topicOverlap } from '../lib/freshness.js'
import { normalizePath, isInside } from '../lib/util.js'
import { pathKey } from '../lib/shell-facts.js'
import { detectUnknownDeclarations } from '../lib/declarations.js'
import { buildDiagnostics } from '../lib/diagnostics.js'
import { resolveFailure } from '../lib/reconciliation.js'
import { mountGuardHarness, createAgent, callTool, resultText, recordingLogger, deliverSessionEvent, assistantMessageData } from './helpers/harness.js'

const bucket = (p, a) => sessionStatesOf(Guard.default, p.ctx).peek(a.session)
const CLAIM = 'DeepSeek Harness 0.1.8 is the latest release and its npm package is compatible with Node 20.'
const TOPICS = ['version', 'release', 'compatib']
const temp = t => {
  const path = mkdtempSync(join(tmpdir(), 'dsh-v8-'))
  t.after(() => { assert.ok(resolve(path).startsWith(resolve(tmpdir())) && path.includes('dsh-v8-')); rmSync(path, { recursive: true, force: true }) })
  return path
}

test('both tools register when the guard predates the tools service and survive remount for an existing agent', async t => {
  const ctx = new Context(); ctx.logger = recordingLogger()
  t.after(() => ctx.fiber.dispose())
  const first = ctx.plugin(Guard, {})
  await mountAgentLoopTestDependencies(ctx)
  await first
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await createAgent(harness, 'existing-before-remount')
  for (const name of ['sbjw', 'sbjw_reconcile']) assert.equal(ctx.tools.get(name).parameters.type, 'object')
  assert.match(resultText(await callTool(ctx, 'sbjw', {}, { agent })), /toolsRegistered: true/)
  await first.dispose()
  assert.equal(ctx.tools.get('sbjw'), undefined)
  await ctx.plugin(Guard, {})
  assert.match(resultText(await callTool(ctx, 'sbjw', {}, { agent })), /toolsRegistered: true/)
  const repair = await callTool(ctx, 'sbjw_reconcile', { action: 'resolve_failure', failure_id: 'nonexistent', resolution: 'unrelated', reason: 'Validation probe' }, { agent })
  assert.match(resultText(repair), /Failure id was not found/)
  assert.doesNotMatch(resultText(repair), /unknown tool/i)
  assert.ok(ctx.logger.at('info').some(line => line.includes('registration success: sbjw')))
})

test('diagnostics-disabled registration is logged as skipped, not success', async t => {
  const p = await mountGuardHarness({ config: { diagnostics: { enabled: false } } })
  t.after(() => p.ctx.fiber.dispose())
  assert.equal(p.ctx.tools.get('sbjw'), undefined)
  assert.ok(p.ctx.tools.get('sbjw_reconcile'))
  assert.ok(p.logger.at('info').some(line => /skipped.*diagnostics disabled/.test(line)))
})

test('a replacement real tool service registers both tools for an already live session', async t => {
  const p = await mountGuardHarness(); t.after(() => p.ctx.fiber.dispose())
  const a = await createAgent(p.harness, 'service-replaced'), old = p.ctx.tools
  p.ctx.registry.delete(ToolRuntime)
  await new Promise(resolve => setImmediate(resolve))
  const replacement = p.ctx.plugin(ToolRuntime)
  await replacement
  await new Promise(resolve => setImmediate(resolve))
  assert.notEqual(p.ctx.tools, old)
  assert.match(resultText(await callTool(p.ctx, 'sbjw', {}, { agent: a })), /toolsRegistered: true/)
  assert.ok(p.ctx.tools.get('sbjw_reconcile'))
})

test('turn reset archives dropped obligations and keeps already resolved work out of reset totals', async t => {
  const dir = temp(t), p = await mountGuardHarness({ profileDir: dir, config: { review: { enabled: false } } })
  t.after(() => p.ctx.fiber.dispose())
  const a = await createAgent(p.harness, 'turn-boundary')
  await callTool(p.ctx, 'write', { file_path: '/tmp/v8-turn', content: 'fixture' }, { agent: a })
  const s = bucket(p, a)
  assert.equal(new EvidenceLedger(s).pendingMutations().length, 1)
  a.session.append('turn/start', {})
  assert.equal(s.history.reset.mutations, 1)
  assert.equal(new EvidenceLedger(s).pendingMutations().length, 0)
  a.session.append('turn/start', {})
  assert.equal(s.history.reset.mutations, 1)
})

test('a real unexplained tool failure can be explained without waiving mutation coverage', async t => {
  const p = await mountGuardHarness({ config: { review: { enabled: false } } })
  t.after(() => p.ctx.fiber.dispose())
  const a = await createAgent(p.harness, 'explain-failure')
  await callTool(p.ctx, 'write', { file_path: '/tmp/unverified-v8', content: 'fixture' }, { agent: a })
  await callTool(p.ctx, 'probe_echo', { text: 'Optional unrelated discovery failed', fail: true }, { agent: a })
  const s = bucket(p, a), failure = s.unexplainedFailures[0]
  assert.ok(failure.id)
  assert.match(resultText(await callTool(p.ctx, 'sbjw', { detail: true }, { agent: a })), new RegExp(failure.id))
  const result = await callTool(p.ctx, 'sbjw_reconcile', { action: 'resolve_failure', failure_id: failure.id, resolution: 'unrelated', reason: 'The recorded error came from optional discovery; the required local write did succeed and still needs read-back.' }, { agent: a })
  assert.equal(result.isError, false, resultText(result))
  assert.equal(s.unexplainedFailures.length, 0)
  assert.equal(s.failures.size, 0)
  assert.equal(new EvidenceLedger(s).pendingMutations().length, 1)
  assert.equal(s.resolvedFailures[0].resolutionSource, 'caller explanation; not verified success')
  assert.match(resultText(await callTool(p.ctx, 'sbjw', { detail: true }, { agent: a })), /已解释失败/)
})

test('failure explanations require valid IDs, reasons, resolution and real evidence when cited', () => {
  const s = createSessionState('fail-validation'); s.seq = 1
  new EvidenceLedger(s).noteFailure('test', 'private-arguments')
  const args = { failure_id: s.unexplainedFailures[0].id, reason: 'diagnosed', resolution: 'explained' }
  for (const bad of [{ reason: '' }, { failure_id: 'missing' }, { resolution: 'pass' }, { evidence_seq: 99 }]) assert.throws(() => resolveFailure(s, { ...args, ...bad }))
  assert.equal(s.unexplainedFailures.length, 1)
  s.seq = 2
  new EvidenceLedger(s).recordVerification({ kind: 'test', passed: true })
  resolveFailure(s, { ...args, evidence_seq: 2 })
  assert.doesNotMatch(JSON.stringify(s.resolvedFailures), /private-arguments/)
})

test('fresh unrelated topics cannot revive an expired matching topic or pass on one shared word', () => {
  const now = 4_000_000
  const retrievals = new Map([['deepseek harness release', { at: now - 31 * 60_000 }], ['postgres index release', { at: now }]])
  assert.equal(evaluateFreshness({ text: CLAIM, topics: TOPICS, retrievals, now }).passed, false)
  assert.equal(topicOverlap(CLAIM, ['DeepSeek release']), undefined)
  assert.equal(topicOverlap(CLAIM, ['random version release latest']), undefined)
  retrievals.set('deepseek harness release', { at: now })
  assert.equal(evaluateFreshness({ text: CLAIM, topics: TOPICS, retrievals, now }).passed, true)
})

test('failed retrievals and unrelated successful retrievals do not clear a pending freshness gap', async t => {
  const p = await mountGuardHarness(); t.after(() => p.ctx.fiber.dispose())
  const a = await createAgent(p.harness, 'retrievals-v8')
  p.ctx.tools.register(defineTool({ name: 'web_search', description: 'Controlled retrieval', parameters: { query: { type: 'string' }, fail: { type: 'boolean' } }, output: { schema: { type: 'string' }, render: (_, v) => [{ type: 'text', text: v }] }, execute(args) { if (args.fail) throw new Error('offline'); return 'retrieved' } }))
  deliverSessionEvent(p.ctx, a, 'assistant/message', assistantMessageData(CLAIM))
  await callTool(p.ctx, 'web_search', { query: 'deepseek harness release', fail: true }, { agent: a })
  assert.equal(bucket(p, a).freshness.size, 0)
  assert.ok(bucket(p, a).pendingFreshness)
  await callTool(p.ctx, 'web_search', { query: 'postgres index release' }, { agent: a })
  assert.ok(bucket(p, a).pendingFreshness)
})

test('freshness topics are bounded and refreshing a topic updates eviction order', () => {
  const s = createSessionState('bounded'), ledger = new EvidenceLedger(s, { maxRecords: 20 })
  for (let i = 0; i < 1000; i++) ledger.noteFreshness(`topic-${i}`)
  assert.equal(s.freshness.size, 20)
  ledger.noteFreshness('topic-980', { now: 42 }); ledger.noteFreshness('next')
  assert.equal(s.freshness.has('topic-981'), false)
  assert.equal(s.freshness.get('topic-980').at, 42)
})

test('profile checkpoint survives a separate process and reports RESET, not RESOLVED', t => {
  const dir = temp(t)
  const source = `import { Checkpoints } from ${JSON.stringify(new URL('../lib/checkpoints.js', import.meta.url).href)};
    import { createSessionState } from ${JSON.stringify(new URL('../lib/state.js', import.meta.url).href)};
    import { EvidenceLedger } from ${JSON.stringify(new URL('../lib/evidence.js', import.meta.url).href)};
    const store = new Checkpoints(process.argv[1], {info(){},warn(){}}), state = createSessionState('restart-session');
    store.load(state); state.seq = 1; new EvidenceLedger(state).noteUnresolvedMutation('pwsh', 'dynamic target', 1, 'private-secret-command'); store.save(state);`
  execFileSync(process.execPath, ['--input-type=module', '-e', source, dir])
  const s = createSessionState('restart-session'), store = new Checkpoints(dir, recordingLogger())
  store.load(s)
  assert.equal(s.history.previousOpenCount, 1)
  assert.equal(s.history.status, 'reset')
  assert.equal(s.history.reset.risks, 1)
  assert.equal(s.history.resolvedByRestart, 0)
  store.save(s)
  const again = createSessionState('restart-session'); new Checkpoints(dir, recordingLogger()).load(again)
  assert.equal(again.history.resetCount, 1, 'restarting twice must not recount the same receipt')
  const folder = join(dir, 'sbjw', 'checkpoints')
  assert.doesNotMatch(readFileSync(join(folder, readdirSync(folder)[0]), 'utf8'), /private-secret-command|dynamic target|restart-session/)
})

test('live pipeline writes unresolved counts under profile and reports them after reload on the same session', async t => {
  const dir = temp(t), p = await mountGuardHarness({ profileDir: dir })
  t.after(() => p.ctx.fiber.dispose())
  const a = await createAgent(p.harness, 'persisted-agent')
  await callTool(p.ctx, 'pwsh', { command: "$f=Join-Path . 'x'; Remove-Item $f", description: 'Only fixture; rollback restore fixture; verification Test-Path afterward.' }, { agent: a })
  assert.ok(bucket(p, a).unresolvedMutationCount >= 1)
  await p.guardFiber.dispose()
  await p.ctx.plugin(Guard, {})
  const diag = resultText(await callTool(p.ctx, 'sbjw', {}, { agent: a }))
  assert.match(diag, /toolsRegistered: true/)
  assert.match(diag, /"status":"reset"/)
  assert.equal(bucket(p, a).history.reset.risks, 1)
})

test('missing profile, older history and corrupt checkpoints are explicit, not empty or resolved', t => {
  const noProfile = createSessionState('no-profile'); new Checkpoints(undefined, recordingLogger()).load(noProfile)
  assert.equal(noProfile.history.storage, 'unavailable')
  const dir = temp(t), store = new Checkpoints(dir, recordingLogger()), s = createSessionState('corrupt')
  store.load(s); assert.equal(s.history.status, 'history-unavailable'); store.save(s)
  const folder = join(dir, 'sbjw', 'checkpoints'), file = join(folder, readdirSync(folder)[0])
  writeFileSync(file, '{corrupt')
  const next = createSessionState('corrupt'); store.load(next); store.save(next)
  assert.equal(next.history.storage, 'error')
  assert.equal(readFileSync(file, 'utf8'), '{corrupt', 'failed reads must not overwrite evidence of corruption')
})

test('a pending in-flight operation survives restart but covered changes do not become reset gaps', t => {
  const dir = temp(t), store = new Checkpoints(dir, recordingLogger()), state = createSessionState('in-flight')
  store.load(state); state.seq = 1
  const ledger = new EvidenceLedger(state)
  ledger.noteMutation('/tmp/covered', 'MEDIUM')
  state.seq = 2
  ledger.recordVerification({ kind: 'read-back', passed: true, targets: [{ path: '/tmp/covered', expected: 'present' }] })
  assert.equal(openCounts(state).mutations, 0)
  state.inFlightRiskCalls = new Set([3]); store.save(state)
  const next = createSessionState('in-flight'); new Checkpoints(dir, recordingLogger()).load(next)
  assert.equal(next.history.resetCount, 1)
  assert.equal(next.history.reset.inFlight, 1)
  assert.equal(next.history.reset.mutations, 0)
})

test('failed profile writes are visible and never advertised as durable', t => {
  const dir = temp(t), logger = recordingLogger(), store = new Checkpoints(dir, logger), state = createSessionState('blocked-storage')
  store.load(state)
  writeFileSync(join(dir, 'sbjw'), 'a non-directory fixture')
  store.save(state)
  assert.equal(state.history.storage, 'error')
  assert.ok(logger.at('warn').some(line => /write failed/.test(line)))
})

test('newest registry follows publication order across roots and namespaces, not alias insertion order', () => {
  const ns = {}, other = {}, otherOwner = {}, rootA = {}, rootB = {}, a = { root: rootA }, b = { root: rootB }, c = { root: rootA }
  try {
    publishSessionStates(ns, a, 'a'); publishSessionStates(ns, b, 'b'); publishSessionStates(ns, c, 'c')
    withdrawSessionStates(ns, c)
    assert.equal(sessionStatesOf(ns), 'b')
    assert.equal(sessionStatesOf(ns, rootA), 'a')
    publishSessionStates(ns, a, 'a2'); publishSessionStates(other, otherOwner, 'other')
    assert.equal(sessionStatesOf(ns), 'a2')
  } finally { withdrawSessionStates(ns, a); withdrawSessionStates(ns, b); withdrawSessionStates(ns, c); withdrawSessionStates(other, otherOwner) }
})

test('unknown risk bucket, explicit unknown markers and Windows UNC canonicalization', () => {
  const s = createSessionState('unknown-risk'); s.calls.push({ risk: 'FUTURE' }, { risk: 'LOW' })
  assert.equal(buildDiagnostics({ config: {}, state: s }).session.riskCounts.UNKNOWN, 1)
  assert.deepEqual(detectUnknownDeclarations('TODO: rename helper\nFIXME: style issue'), [])
  assert.equal(detectUnknownDeclarations('unknown: whether external service responds').length, 1)
  const extended = String.raw`\\?\UNC\srv\share\folder\file`, ordinary = String.raw`\\srv\share\folder\file`
  assert.equal(normalizePath(extended, 'win32'), '//srv/share/folder/file')
  assert.equal(normalizePath(extended, 'win32'), normalizePath(ordinary, 'win32'))
  assert.equal(pathKey(extended), pathKey(ordinary))
  assert.equal(isInside(extended, String.raw`\\srv\share`, 'win32'), true)
  assert.equal(isInside(extended, String.raw`\\other\share`, 'win32'), false)
})

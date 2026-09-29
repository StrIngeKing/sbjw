import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { SESSION_STATES, sessionStatesOf } from '../lib/state.js'
import * as Guard from '../lib/index.js'
import { mountGuardHarness, callTool, resultText, createAgent, guardNotices, messageText, deliverSessionEvent, assistantMessageData } from './helpers/harness.js'

const states = (ctx) => sessionStatesOf(Guard.default, ctx)
const bucket = (agent) => states().peek(agent.session)

/** Run one call and return its guard notices, so a test can read the injection. */
async function callAndReadNotice(ctx, name, args, agent) {
  const result = await callTool(ctx, name, args, { agent })
  return { result, notices: guardNotices(result), text: resultText(result) }
}

test('a successful mutation followed by a passing verification satisfies the gate', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'gate-pass')

  // 1. Mutate. The gate must complain, because nothing has verified it yet.
  const afterMutation = await callAndReadNotice(probe.ctx, 'write', { file_path: '/tmp/gated.txt', content: 'done' }, agent)
  assert.equal(afterMutation.result.isError, false)
  assert.ok(
    afterMutation.notices.some((notice) => notice.tag === 'completion-gate'),
    'the gate must correct a turn that mutated without verifying',
  )
  assert.match(afterMutation.notices.find((notice) => notice.tag === 'completion-gate').text, /not ready to end/)
  assert.equal(bucket(agent).mutationSinceVerification, true)

  // 2. Verify with a real test summary. The registry has already reported the
  //    mutation, so a passing check now covers it.
  const verifying = await callAndReadNotice(probe.ctx, 'probe_test', { output: '5 passed, 0 failed' }, agent)
  assert.equal(verifying.result.isError, false)
  assert.equal(bucket(agent).mutationSinceVerification, false, 'a passing verification must clear the mutation flag')
  const covering = bucket(agent).verifications.at(-1)
  assert.equal(covering.kind, 'test')
  assert.equal(covering.passed, true)

  // 3. The next call must NOT be corrected again: there is nothing left to fix.
  const afterVerification = await callAndReadNotice(probe.ctx, 'probe_echo', { text: 'reporting' }, agent)
  assert.deepEqual(
    afterVerification.notices.filter((notice) => notice.tag === 'completion-gate'),
    [],
    'the gate must not keep correcting a turn that is now verified',
  )
})

test('a failing verification does not satisfy the gate', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'gate-fail')

  await callTool(probe.ctx, 'write', { file_path: '/tmp/f.txt', content: 'x' }, { agent })
  await callTool(probe.ctx, 'probe_test', { output: '2 failed, 3 passed' }, { agent })

  assert.equal(bucket(agent).mutationSinceVerification, true, 'a failing check cannot cover a mutation')
  const written = bucket(agent).verifications.find((item) => item.kind === 'test')
  assert.equal(written.passed, false)
  assert.match(written.detail, /failing result/)

  const next = await callAndReadNotice(probe.ctx, 'probe_echo', { text: 'still not done' }, agent)
  const gate = next.notices.find((notice) => notice.tag === 'completion-gate')
  assert.ok(gate, 'the gate must still block after a failing verification')
  assert.match(gate.text, /no covering verification/)
})

test('the gate names the concrete gap instead of restating the policy', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'gate-specific')
  const { notices } = await callAndReadNotice(probe.ctx, 'write', { file_path: join(process.cwd(), 'app.js'), content: 'let x = 1' }, agent)
  const gate = notices.find((notice) => notice.tag === 'completion-gate')
  assert.match(gate.text, /no covering verification/)
  assert.match(gate.text, /\app\.js/, 'the gap must name the changed file')
  assert.match(gate.text, /Re-read a changed file/, 'the gap must say what to do')
  assert.match(gate.text, /Evidence digest \(current session\):/, 'the digest is attached when enabled')
})

test('an unexplained failure is a blocking gap for the turn it happened in', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'gate-failure')

  // A turn boundary first, so the failure is unambiguously this turn's.
  agent.session.append('turn/start', { turn: 1 })
  await callTool(probe.ctx, 'probe_echo', { text: 'boom: module not found', fail: true }, { agent })
  assert.equal(bucket(agent).unexplainedFailures.length, 1)

  const { notices } = await callAndReadNotice(probe.ctx, 'probe_echo', { text: 'unrelated progress' }, agent)
  const gate = notices.find((notice) => notice.tag === 'completion-gate')
  assert.ok(gate, 'an unexplained failure must keep the gate closed')
  assert.match(gate.text, /failure\(s\) in this turn were never explained/)
  assert.match(gate.text, /module not found/)
})

test('a failure from an earlier turn does not block a later, unrelated turn', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'gate-old-failure')

  agent.session.append('turn/start', { turn: 1 })
  await callTool(probe.ctx, 'probe_echo', { text: 'boom: transient', fail: true }, { agent })
  assert.equal(bucket(agent).unexplainedFailures.length, 1, 'the ledger keeps the record')

  // A new turn: the guard cannot tell a real blocker from a transient one, so
  // carrying the failure forward would stop unrelated work until the identical
  // command happened to succeed. The record stays; the demand does not.
  agent.session.append('turn/start', { turn: 2 })
  const { notices } = await callAndReadNotice(probe.ctx, 'probe_echo', { text: 'unrelated work' }, agent)
  assert.deepEqual(
    notices.filter((notice) => notice.tag === 'completion-gate'),
    [],
    'a previous turn failure must not block this turn',
  )
  assert.equal(bucket(agent).unexplainedFailures.length, 1, 'and the ledger still reports it in diagnostics')
})

test('a declared unknown keeps the gate advisory until it is reported', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'gate-unknown')

  deliverSessionEvent(
    probe.ctx,
    agent,
    'assistant/message',
    assistantMessageData('Status report.\nunknown: whether the CDN cache has been purged.\n'),
  )
  assert.equal(bucket(agent).unknowns.length, 1, 'the declaration must reach the ledger')

  const { notices } = await callAndReadNotice(probe.ctx, 'probe_echo', { text: 'done' }, agent)
  const gate = notices.find((notice) => notice.tag === 'completion-gate')
  assert.ok(gate)
  assert.match(gate.text, /declared unknown\(s\) remain open/)
  assert.match(gate.text, /CDN cache/)
})

test('the injection budget bounds the gate so it cannot become the loop it prevents', async (t) => {
  const probe = await mountGuardHarness({ config: { completionGate: { maxInjectionsPerTurn: 1 } } })
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'gate-budget')
  // The mutation itself is the first correction: nothing has verified it yet.
  const mutation = await callAndReadNotice(probe.ctx, 'write', { file_path: '/tmp/budget.txt', content: 'x' }, agent)
  assert.ok(mutation.notices.some((notice) => notice.tag === 'completion-gate'))
  assert.equal(bucket(agent).gate.injections, 1)

  // The budget is now spent, so the gate reports the gap once as a final
  // statement instead of correcting again.
  const second = await callAndReadNotice(probe.ctx, 'probe_echo', { text: 'one' }, agent)
  const gate = second.notices.find((notice) => notice.tag === 'completion-gate')
  assert.ok(gate)
  assert.match(gate.text, /correction budget is spent/)
  assert.match(gate.text, /Do not present the work as complete/)
  assert.equal(bucket(agent).gate.injections, 1, 'reporting the exhausted budget must not consume another injection')

  // Third: nothing more is injected, so the turn can end.
  const third = await callAndReadNotice(probe.ctx, 'probe_echo', { text: 'two' }, agent)
  assert.deepEqual(
    third.notices.filter((notice) => notice.tag === 'completion-gate'),
    [],
    'the gate must stop after reporting once, or it would be the loop it exists to prevent',
  )
})

test('disabling the completion gate removes all correction', async (t) => {
  const probe = await mountGuardHarness({ config: { completionGate: { enabled: false } } })
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'gate-off')
  const { notices } = await callAndReadNotice(probe.ctx, 'write', { file_path: '/tmp/off.txt', content: 'x' }, agent)
  assert.deepEqual(notices.filter((notice) => notice.tag === 'completion-gate'), [])
  // The mutation is still recorded: disabling the correction must not disable
  // the evidence the diagnostics report depends on.
  assert.equal(bucket(agent).sessionMutatedFiles.size, 1)
})

test('a corrective message is returned for driver-owned delivery without pre-enqueueing', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'gate-inject')

  const before = agent.inbox.nextStep.length
  const result = await callTool(probe.ctx, 'write', { file_path: '/tmp/staged.txt', content: 'x' }, { agent })
  const notices = guardNotices(result)
  assert.ok(notices.length > 0)
  assert.equal(
    agent.inbox.nextStep.length,
    before,
    'the registry must not pre-enqueue contexts that the driver will deliver',
  )
  const staged = result.additionalContexts.find(message => message.source?.kind === 'sbjw')
  assert.equal(staged.source.kind, 'sbjw')
  assert.match(messageText(staged), /Cyber Internal Affairs/)

  // Complete delivery and model continuation are exercised by the real-loop
  // regressions in 19-context-delivery.test.js.
})

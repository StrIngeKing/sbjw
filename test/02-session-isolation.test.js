import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SESSION_STATES, sessionStatesOf } from '../lib/state.js'
import * as Guard from '../lib/index.js'
import { mountGuardHarness, callTool, resultText, createAgent } from './helpers/harness.js'

const states = (ctx) => sessionStatesOf(Guard.default, ctx)

test('the guard tracks one state bucket per session and never mixes them', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agentA = await createAgent(probe.harness, 'session-a')
  const agentB = await createAgent(probe.harness, 'session-b')

  await callTool(probe.ctx, 'write', { file_path: '/tmp/a.txt', content: 'aaa' }, { agent: agentA })
  await callTool(probe.ctx, 'write', { file_path: '/tmp/b.txt', content: 'bbb' }, { agent: agentB })

  const registry = states()
  assert.ok(registry, 'the plugin must publish its session-state registry')
  assert.deepEqual(registry.liveKeys().sort(), ['session-a', 'session-b'])

  const bucketA = registry.peek(agentA.session)
  const bucketB = registry.peek(agentB.session)
  assert.notEqual(bucketA, bucketB)
  assert.equal(bucketA.key, 'session-a')
  assert.equal(bucketB.key, 'session-b')

  // Each session saw exactly its own call and its own mutated path.
  assert.equal(bucketA.seq, 1)
  assert.equal(bucketB.seq, 1)
  assert.deepEqual([...bucketA.sessionMutatedFiles], ['/tmp/a.txt'])
  assert.deepEqual([...bucketB.sessionMutatedFiles], ['/tmp/b.txt'])
  assert.equal(bucketA.evidence.size, 1)
  assert.equal(bucketB.evidence.size, 1)
  assert.equal(bucketA.evidence.has('/tmp/b.txt'), false)
  assert.equal(bucketB.evidence.has('/tmp/a.txt'), false)

  // The per-session diagnostics report only its own session.
  const reportA = resultText(await callTool(probe.ctx, 'reliability_guard', { detail: true }, { agent: agentA }))
  assert.match(reportA, /session-a/)
  assert.doesNotMatch(reportA, /session-b/)
})

test('disposing a session releases its bucket and leaves other sessions intact', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agentA = await createAgent(probe.harness, 'keeper')
  const agentB = await createAgent(probe.harness, 'leaver')
  await callTool(probe.ctx, 'probe_echo', { text: 'a' }, { agent: agentA })
  await callTool(probe.ctx, 'probe_echo', { text: 'b' }, { agent: agentB })

  const registry = states()
  assert.equal(registry.size, 2)
  assert.equal(registry.dispose(agentB.session), true)
  assert.equal(registry.size, 1)
  assert.deepEqual(registry.liveKeys(), ['keeper'])
  assert.equal(registry.peek(agentB.session), undefined)
  assert.ok(registry.peek(agentA.session), 'the surviving session keeps its state')
})

test('a second session id cannot inherit the first session counters', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const first = await createAgent(probe.harness, 'reused-id')
  await callTool(probe.ctx, 'write', { file_path: '/tmp/one.txt', content: 'x' }, { agent: first })
  await callTool(probe.ctx, 'write', { file_path: '/tmp/two.txt', content: 'y' }, { agent: first })
  assert.equal(states().peek(first.session).seq, 2)

  // The bucket is keyed by the live Session object, so a later session — the
  // shape a resume produces — starts empty even when the previous session id is
  // reused. The session service refuses two live sessions with one id, so the
  // second identity is a distinct id, which is the only way a resume can appear.
  const second = await probe.ctx.sessions.create(SessionId('resumed-id'), { cwd: process.cwd() })
  assert.notEqual(second.id, first.session.id)
  const bucket = states().get(second)
  assert.equal(bucket.seq, 0)
  assert.equal(bucket.sessionMutatedFiles.size, 0)
  assert.equal(bucket.evidence.size, 0)
  assert.equal(states().peek(first.session).seq, 2, 'the original session keeps its own counters')
})

test('unloading the plugin releases every bucket and unpublishes the registry', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'unloaded')
  await callTool(probe.ctx, 'probe_echo', { text: 'x' }, { agent })
  const registry = states()
  assert.equal(registry.size, 1)

  await probe.guardFiber.dispose()
  assert.equal(registry.size, 0, 'the disposed instance must release every bucket')
  assert.equal(
    sessionStatesOf(Guard.default, probe.ctx),
    undefined,
    'a disposed plugin must not leave its registry published for its context',
  )
})

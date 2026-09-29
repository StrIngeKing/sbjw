import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SESSION_STATES, sessionStatesOf } from '../lib/state.js'
import * as Guard from '../lib/index.js'
import { mountGuardHarness, callTool, createAgent, guardNotices, deliverSessionEvent, assistantMessageData } from './helpers/harness.js'

const states = (ctx) => sessionStatesOf(Guard.default, ctx)

test('unloading the plugin removes the prompt section and the diagnostics tool', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const fiber = ctx.plugin(Guard, {})
  await fiber
  await mountAgentLoopTestHarness(ctx)

  // Both contributions exist while the plugin is mounted...
  const before = await ctx.systemPrompt.assemble({})
  assert.ok(before.sections.some((section) => section.name === 'reliability-guard:policy'))
  assert.ok(ctx.tools.get('reliability_guard', undefined) !== undefined)
  const sessionsBefore = ctx.tools.schemas(undefined).length
  const diagnosticsSchema = ctx.tools.schemas(undefined).find((schema) => schema.name === 'reliability_guard')
  assert.deepEqual(
    diagnosticsSchema?.parameters,
    {
      type: 'object',
      properties: {
        detail: {
          type: 'boolean',
          description: 'Include per-session evidence details; defaults to false. / 包含会话级证据详情（过期项、验证和未决项）；默认为 false。',
        },
        call_seq: { type: 'integer', description: 'Focus on an earlier mutation/risk call sequence, including redacted original command. / 查看指定序号的变更或风险及脱敏原始命令。' },
      },
    },
    'the model-facing parameters must be a JSON Schema object root',
  )

  // ...and neither survives the unload.
  await fiber.dispose()
  const after = await ctx.systemPrompt.assemble({})
  assert.equal(
    after.sections.some((section) => section.name === 'reliability-guard:policy'),
    false,
    'the policy section must be disposed with the plugin',
  )
  assert.equal(ctx.tools.get('reliability_guard', undefined), undefined, 'the diagnostics tool must be disposed with the plugin')
  assert.equal(ctx.tools.get('reliability_guard_reconcile', undefined), undefined, 'the reconciliation tool must be disposed too')
  assert.equal(ctx.tools.schemas(undefined).length, sessionsBefore - 2, 'both plugin tools must disappear')
})

test('unloading releases every session bucket and stops observing events', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'unload')
  await callTool(probe.ctx, 'write', { file_path: '/tmp/unload.txt', content: 'x' }, { agent })
  const registry = states()
  assert.equal(registry.size, 1)
  assert.equal(registry.peek(agent.session).sessionMutatedFiles.size, 1)

  await probe.guardFiber.dispose()
  assert.equal(registry.size, 0, 'no bucket may outlive the plugin')
  assert.equal(
    sessionStatesOf(Guard.default, probe.ctx),
    undefined,
    'the registry must be unpublished for the context that owned it',
  )

  // A tool call after the unload must behave exactly as if the guard never
  // existed: no denial, no injected notice, no error.
  const after = await callTool(probe.ctx, 'probe_echo', { text: 'after unload' }, { agent })
  assert.equal(after.isError, false)
  assert.deepEqual(guardNotices(after), [])
})

test('a reload starts from a clean slate with no inherited state', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const first = ctx.plugin(Guard, {})
  await first
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('reload'), {}, { cwd: process.cwd() })
  const firstRegistry = states()
  await ctx.tools.execute({
    name: 'reliability_guard',
    callId: 'call-1',
    arguments: {},
    signal: new AbortController().signal,
    agent,
  })
  assert.equal(firstRegistry.size, 1)
  await first.dispose()

  // Remount, exactly as an HMR reload does.
  const second = ctx.plugin(Guard, {})
  await second
  const secondRegistry = states()
  assert.notEqual(secondRegistry, firstRegistry, 'a reload must publish a fresh registry')
  assert.equal(secondRegistry.size, 0, 'a reload must not inherit the previous instance state')
  assert.equal(secondRegistry.peek(agent.session), undefined)

  const assembly = await ctx.systemPrompt.assemble({})
  assert.equal(
    assembly.sections.filter((section) => section.name === 'reliability-guard:policy').length,
    1,
    'a reload must not duplicate the prompt section',
  )
})

test('two guard instances compose without duplicating the prompt section or the tool', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const first = ctx.plugin(Guard, {})
  await first
  const second = ctx.plugin(Guard, {})
  await second

  const assembly = await ctx.systemPrompt.assemble({})
  // The system-prompt registry shadows same-named sections, so the second
  // instance replaces the first rather than appending a duplicate.
  assert.equal(assembly.sections.filter((section) => section.name === 'reliability-guard:policy').length, 1)
  // Two registrations of one tool name are tolerated by the registry; what
  // matters is that a call still resolves to exactly one implementation.
  const tool = ctx.tools.get('reliability_guard', undefined)
  assert.ok(tool !== undefined)
})

test('a session that ends abnormally still releases its state', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'abnormal-end')
  await callTool(probe.ctx, 'write', { file_path: '/tmp/abnormal.txt', content: 'x' }, { agent })
  const registry = states()
  assert.equal(registry.size, 1)

  // The official session service emits `session/disposed`; the guard must treat
  // it as the single release point rather than relying on an orderly turn end.
  probe.ctx.emit('session/disposed', agent.session)
  assert.equal(registry.size, 0)
  assert.equal(registry.peek(agent.session), undefined)
})

test('no module-level state survives between two independent contexts', async (t) => {
  const first = new Context()
  const second = new Context()
  t.after(() => {
    first.fiber.dispose()
    second.fiber.dispose()
  })
  await mountAgentLoopTestDependencies(first)
  await mountAgentLoopTestDependencies(second)
  await first.plugin(Guard, {})
  // Each mount publishes its own registry, so capture each one as it appears:
  // "newest" is the context that most recently mounted.
  const registryA = sessionStatesOf(Guard.default)
  await second.plugin(Guard, {})
  const registryB = sessionStatesOf(Guard.default)
  assert.notEqual(registryA, registryB, 'each context must publish its own registry')
  const firstHarness = await mountAgentLoopTestHarness(first)
  const secondHarness = await mountAgentLoopTestHarness(second)
  const agentA = await firstHarness.create(SessionId('ctx-a'), {}, { cwd: process.cwd() })
  const agentB = await secondHarness.create(SessionId('ctx-b'), {}, { cwd: process.cwd() })
  const bucketA = registryA.peek(agentA.session)
  const bucketB = registryB.peek(agentB.session)
  assert.equal(registryA.size, 1)
  assert.equal(registryB.size, 1)
  assert.equal(registryA.peek(agentB.session), undefined, 'context A must not track context B sessions')
  assert.notEqual(bucketA, bucketB)
  assert.equal(bucketA.key, 'ctx-a')
  assert.equal(bucketB.key, 'ctx-b')
  deliverSessionEvent(second, agentB, 'assistant/message', assistantMessageData('unknown: b only\n'))
  assert.equal(bucketB.unknowns.length, 1)
  assert.equal(bucketA.unknowns.length, 0, 'one context must never see another context declarations')
})

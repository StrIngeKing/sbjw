import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountGuardHarness, createAgent } from './helpers/harness.js'
import { ScriptedAdapter, tool, done, runTurn, assertDeliveredOnce } from './helpers/loop.js'

// Probe tool bodies only echo their inputs. No shell command or file write runs.
const highRisk = {
  command: 'git reset --hard HEAD~1',
  description: 'Rollback: recover from reflog. Verification: confirm with git log afterwards.',
}

test('a full review turn delivers one request, receives PASS, and completes', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const adapter = new ScriptedAdapter([
    [tool('change', 'pwsh', highRisk)],
    [tool('review', 'subagent', { report: 'VERDICT: PASS\nChecked the result.' })],
    [tool('verify', 'probe_test', { output: '5 passed, 0 failed' })],
    done,
  ])
  probe.ctx.llm.registerAdapter(['scripted'], adapter)
  const agent = await createAgent(probe.harness, 'loop-review', { provider: 'scripted', model: 'local' })
  const events = await runTurn(probe.ctx, agent)
  assertDeliveredOnce(events, adapter, 'review')
  assert.equal(adapter.requests.length, 4)
})

test('a full mutation turn delivers a completion correction and continues to verification', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const adapter = new ScriptedAdapter([
    [tool('change', 'write', { file_path: join(process.cwd(), 'loop-probe.txt'), content: 'x' })],
    [tool('verify', 'probe_test', { output: '5 passed, 0 failed' })],
    done,
  ])
  probe.ctx.llm.registerAdapter(['scripted'], adapter)
  const agent = await createAgent(probe.harness, 'loop-gate', { provider: 'scripted', model: 'local' })
  const events = await runTurn(probe.ctx, agent)
  assertDeliveredOnce(events, adapter, 'completion-gate')
  assert.equal(adapter.requests.length, 3)
})

test('a full stalled turn delivers a stall correction once and can finish', async (t) => {
  const probe = await mountGuardHarness({ config: { maxStallSteps: 2 } })
  t.after(() => probe.ctx.fiber.dispose())
  const adapter = new ScriptedAdapter([
    [tool('one', 'probe_echo', { text: 'one' })],
    [tool('two', 'probe_echo', { text: 'two' })],
    done,
  ])
  probe.ctx.llm.registerAdapter(['scripted'], adapter)
  const agent = await createAgent(probe.harness, 'loop-stall', { provider: 'scripted', model: 'local' })
  const events = await runTurn(probe.ctx, agent)
  assertDeliveredOnce(events, adapter, 'stall')
  assert.equal(adapter.requests.length, 3)
})

test('batched corrections preserve other plugins contexts and the original tool outputs', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  probe.ctx.on('tools/post-execute', async (exec, _result, next) => {
    const decision = await next()
    if (exec.name !== 'write') return decision
    return {
      ...(decision ?? { kind: 'accept' }),
      additionalContexts: [...(decision?.additionalContexts ?? []), createUserMessage({
        content: [{ type: 'text', text: `Other plugin context: ${exec.callId}` }],
        source: { kind: 'other-test-plugin', form: 'notice' },
      })],
    }
  })
  const adapter = new ScriptedAdapter([
    [
      tool('batch-a', 'write', { file_path: join(process.cwd(), 'batch-a.txt'), content: 'a' }),
      tool('batch-b', 'write', { file_path: join(process.cwd(), 'batch-b.txt'), content: 'b' }),
    ],
    [tool('verify-batch', 'probe_test', { output: '5 passed, 0 failed' })],
    done,
  ])
  probe.ctx.llm.registerAdapter(['scripted'], adapter)
  const agent = await createAgent(probe.harness, 'loop-batch', { provider: 'scripted', model: 'local' })
  const events = await runTurn(probe.ctx, agent)
  assertDeliveredOnce(events, adapter, 'completion-gate', 2)
  const recorded = events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'other-test-plugin')
  assert.equal(recorded.length, 2, 'contexts from another plugin must survive composition')
  const nextRequest = JSON.stringify(adapter.requests[1].messages)
  assert.match(nextRequest, /Other plugin context: batch-a/)
  assert.match(nextRequest, /Other plugin context: batch-b/)
  const writes = events.filter(event => event.type === 'tool/result' && ['batch-a', 'batch-b'].includes(event.data.message.toolCallId))
  assert.equal(writes.length, 2)
  for (const event of writes) {
    const message = event.data.message
    assert.equal(message.isError, false)
    assert.deepEqual(message.content, [{ type: 'text', text: `wrote ${join(process.cwd(), `${message.toolCallId}.txt`)} (1 bytes)` }])
  }
})

/**
 * Loop detectors.
 *
 * A guard that blocks repetition is only useful if it can still tell a loop
 * from work. These tests therefore come in pairs: every detector is proven to
 * block a run that provably cannot make progress, and the same machinery is
 * proven to leave legitimate repetition — polling a set of paths, repeating a
 * call a few times — alone.
 *
 * The pure `isNoopShellCommand` table is the conservative half of the no-op
 * detector: it must never call a command effect-free when any statement or
 * pipeline stage touches state, reads a file, or starts a process.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SESSION_STATES, sessionStatesOf } from '../lib/state.js'
import * as Guard from '../lib/index.js'
import { isNoopShellCommand } from '../lib/noop-shell.js'
import { mountGuardHarness, callTool, createAgent, resultText } from './helpers/harness.js'

const states = (ctx) => sessionStatesOf(Guard.default, ctx)
const bucket = (agent) => states().peek(agent.session)

/**
 * The two identical-repeat acceptance tests below were written against a real
 * bug: `detectLoop` gated the semantic branch on
 * `facts.semanticSignature !== facts.signature`, but for a non-shell tool the
 * signature is `${toolName}::${canonicalize(args)}` while the semantic
 * signature is `canonicalize(args)` alone. They are therefore never equal, so
 * byte-identical calls counted as a semantic run and were denied at
 * `semanticLoopThreshold` (balanced: 3) — making `maxIdenticalRepeats`
 * unreachable and hard-stopping a repeat at exactly the official reminder's
 * first threshold. The detector now derives "not byte-identical" from the
 * previous RAW signature for the same tool, so the two thresholds are
 * independent again, and these tests run for real.
 */

test('isNoopShellCommand accepts only wholly effect-free commands', () => {
  const effectFree = [
    'echo hi',
    'Write-Host "x"',
    'Write-Output 1',
    'true',
    'exit 0',
    '# comment only',
    'echo a; echo b',
    "'literal'",
  ]
  for (const command of effectFree) {
    assert.equal(isNoopShellCommand(command), true, `"${command}" produces no durable change and no information`)
  }

  // An empty command is a no-op, not a mutation: nothing runs.
  assert.equal(isNoopShellCommand(''), true)
  assert.equal(isNoopShellCommand('   \n  '), true)

  const mutating = {
    // The read is the point of the command: it returns file content the task
    // needs, and discarding it hides nothing.
    'Get-Content x | Out-Null': 'reads the filesystem',
    // Recursive deletion is the most destructive command in the classifier, and
    // a model that reaches it has not stopped working — it is working.
    'rm -rf build': 'deletes a tree',
    // A test run is the verification evidence the completion gate demands;
    // blocking it would block the very work that closes a turn.
    'npm test': 'runs a process and produces the verification result',
    // Polling `git status` is a normal way to observe state that changes later.
    'git status': 'reports repository state that changes over time',
    'Set-Content a b': 'writes a file through the cmdlet',
    // Comments are stripped before classification, so a mutation hidden behind
    // them must still be visible: nothing about this command is empty.
    '# nothing to see\nrm -rf build': 'mutates after a comment-only first line',
    // A separator is a separator: an effect-free leading statement must not
    // excuse the mutation chained to it.
    'echo hi && rm -rf build': 'deletes a tree after a harmless echo',
    'echo hi; rm -rf build': 'deletes a tree after a harmless echo',
  }
  for (const [command, why] of Object.entries(mutating)) {
    assert.equal(isNoopShellCommand(command), false, `"${command}" must not be a no-op: it ${why}`)
  }
})

test(
  'a redirect is not a no-op',
  () => {
    assert.equal(isNoopShellCommand('echo hi > file.txt'), false)
    assert.equal(isNoopShellCommand('echo hi >> file.txt'), false)
    assert.equal(isNoopShellCommand('Write-Output 1 > out.txt'), false)
  },
)

test(
  'an all-effect-free pipeline is a no-op',
  () => {
    // Every stage merely formats or discards output an effect-free stage
    // produced, so the whole pipeline is inert and a run of them is a spin.
    assert.equal(isNoopShellCommand('Write-Host "x" | Out-Null'), true)
    assert.equal(isNoopShellCommand('Write-Output 1 | Out-Null'), true)
    assert.equal(isNoopShellCommand('Write-Host "x" | Out-String | Out-Null'), true)
  },
)

test(
  'byte-identical calls are denied at the identical-repeat threshold, not before',
  async (t) => {
    const probe = await mountGuardHarness()
    t.after(() => probe.ctx.fiber.dispose())
    const agent = await createAgent(probe.harness, 'loop-exact-default')

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const allowed = await callTool(probe.ctx, 'probe_echo', { text: 'same' }, { agent })
      assert.equal(allowed.isError, false, `attempt ${attempt} is below the balanced threshold of 5`)
    }
    const denied = await callTool(probe.ctx, 'probe_echo', { text: 'same' }, { agent })
    assert.equal(denied.isError, true)
    assert.equal(denied.error.info.code, 'SBJW_REPEAT')
    assert.match(resultText(denied), /Evidence: 5 consecutive byte-identical calls \(threshold 5\)/)
  },
)

test(
  'a call repeated below the identical-repeat threshold is not denied',
  async (t) => {
    const probe = await mountGuardHarness()
    t.after(() => probe.ctx.fiber.dispose())
    const agent = await createAgent(probe.harness, 'loop-below-threshold')

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const allowed = await callTool(probe.ctx, 'probe_echo', { text: 'same' }, { agent })
      assert.equal(allowed.isError, false, 'four identical calls are below maxIdenticalRepeats of 5')
    }
    assert.equal(bucket(agent).counters.blockedLoops, 0)
  },
)

test('the identical-repeat detector blocks the configured run length', async (t) => {
  // The semantic detector is disabled so this test measures the identical-run
  // counter alone; the configuration schema documents that each detector can be
  // switched off independently. The semantic detector has its own tests below.
  const probe = await mountGuardHarness({ config: { guard: { semanticRepeats: false } } })
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'loop-exact')

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const allowed = await callTool(probe.ctx, 'probe_echo', { text: 'same' }, { agent })
    assert.equal(allowed.isError, false, `attempt ${attempt} is not yet a loop`)
    assert.equal(resultText(allowed), 'same')
  }
  assert.equal(bucket(agent).counters.blockedLoops, 0)

  const denied = await callTool(probe.ctx, 'probe_echo', { text: 'same' }, { agent })
  assert.equal(denied.isError, true, 'the fifth identical call is the run the detector exists for')
  assert.deepEqual(denied.error.info, { code: 'SBJW_REPEAT', source: 'sbjw' })
  const text = resultText(denied)
  assert.match(text, /Cyber Internal Affairs blocked this call/)
  assert.match(text, /Evidence: 5 consecutive byte-identical calls \(threshold 5\)/, 'the denial must name its evidence')
  assert.match(text, /Read the previous result again/, 'the denial must state an actionable next step')
  assert.match(text, /change the arguments, change the approach, or report what blocked you/)

  const state = bucket(agent)
  assert.equal(state.counters.blockedLoops, 1)
  assert.equal(state.counters.preExecuteChecked, 5, 'every attempt must pass through the guard')
  assert.equal(state.exactRun, 5)
  assert.match(probe.logger.at('info').join('\n'), /sbjw: repeat blocked:/, 'the block must be auditable')
})

test('the identical-repeat threshold is configuration-driven', async (t) => {
  const probe = await mountGuardHarness({ config: { maxIdenticalRepeats: 3, guard: { semanticRepeats: false } } })
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'loop-config')

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const allowed = await callTool(probe.ctx, 'probe_echo', { text: 'cfg' }, { agent })
    assert.equal(allowed.isError, false, `attempt ${attempt} is below the configured threshold`)
  }
  const denied = await callTool(probe.ctx, 'probe_echo', { text: 'cfg' }, { agent })
  assert.equal(denied.isError, true)
  assert.equal(denied.error.info.code, 'SBJW_REPEAT')
  assert.match(resultText(denied), /Evidence: 3 consecutive byte-identical calls \(threshold 3\)/)
})

test('calls that differ only in whitespace or quoting are one semantic loop', async (t) => {
  // `echo` is also a no-op shell command and the no-op detector runs first, so
  // it is disabled here to isolate the semantic detector; the no-op detector
  // has its own test below.
  const probe = await mountGuardHarness({ config: { guard: { noopShell: false } } })
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'loop-semantic')

  const variants = ['echo  hi', 'echo hi', 'echo   "hi"']
  for (const command of variants.slice(0, 2)) {
    const allowed = await callTool(probe.ctx, 'pwsh', { command }, { agent })
    assert.equal(allowed.isError, false, `"${command}" is not yet a loop`)
  }

  const denied = await callTool(probe.ctx, 'pwsh', { command: variants[2] }, { agent })
  assert.equal(denied.isError, true)
  assert.equal(denied.error.info.code, 'SBJW_SEMANTIC_REPEAT')
  const text = resultText(denied)
  assert.match(text, /Evidence: 3 argument-normalized identical calls \(threshold 3\)/)
  assert.match(text, /differ only in whitespace, quoting, or comments/)
  assert.match(text, /Change what the call actually does/)

  const state = bucket(agent)
  assert.equal(state.semanticRun, 3)
  assert.equal(state.exactRun, 1, 'the three calls were never byte-identical, which is why the semantic detector exists')
  assert.match(probe.logger.at('info').join('\n'), /sbjw: semantic-repeat blocked:/)
})

test('the semantic detector also fires in the shipped default configuration', async (t) => {
  // No detector is disabled here: a repeated file read is not a no-op, so the
  // shipped preset has to catch this run through the semantic signature alone.
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'loop-semantic-default')

  for (const command of ['Get-Content  a.txt', 'Get-Content a.txt']) {
    const allowed = await callTool(probe.ctx, 'pwsh', { command }, { agent })
    assert.equal(allowed.isError, false)
  }
  const denied = await callTool(probe.ctx, 'pwsh', { command: 'Get-Content "a.txt"' }, { agent })
  assert.equal(denied.isError, true)
  assert.equal(denied.error.info.code, 'SBJW_SEMANTIC_REPEAT')
})

test('a run of effect-free shell calls is denied at the no-op threshold', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'loop-noop')

  // Three different no-op commands: the run, not the text, identifies a model
  // that has stopped working, so these must not be byte-identical.
  const commands = ['Write-Host "step 1"', 'Write-Output 1', 'echo working']
  for (const command of commands.slice(0, 2)) {
    const allowed = await callTool(probe.ctx, 'pwsh', { command }, { agent })
    assert.equal(allowed.isError, false)
  }
  assert.equal(bucket(agent).noopShellRun, 2, 'the run counter advances on the evidence of each finished call')

  const denied = await callTool(probe.ctx, 'pwsh', { command: commands[2] }, { agent })
  assert.equal(denied.isError, true)
  assert.equal(denied.error.info.code, 'SBJW_NO_OP_SHELL')
  const text = resultText(denied)
  assert.match(text, /Evidence: 3 consecutive no-op shell calls \(threshold 3\)/)
  assert.match(text, /Run a command that changes state or returns information the task needs/)
  assert.equal(bucket(agent).counters.noopShellBlocked, 1)
  assert.match(probe.logger.at('info').join('\n'), /sbjw: no-op-shell blocked:/)
})

test('normal repetition is not a loop', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'loop-legitimate')

  // Polling six different paths is one repeated *shape* with six different
  // arguments, which is how an agent waits for someone else's change.
  for (let index = 1; index <= 6; index += 1) {
    const path = `/tmp/poll-${index}.txt`
    const result = await callTool(probe.ctx, 'probe_read', { file_path: path }, { agent })
    assert.equal(result.isError, false, `reading ${path} is work, not a loop`)
  }

  // Repeating one call twice stays below every shipped threshold; the guard
  // stops a run that cannot progress, not repetition as such.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await callTool(probe.ctx, 'probe_echo', { text: 'legit' }, { agent })
    assert.equal(result.isError, false, `repetition ${attempt} is below the shipped thresholds`)
  }

  const state = bucket(agent)
  assert.equal(state.counters.blockedLoops, 0)
  assert.equal(state.calls.length, 8, 'all eight legitimate calls must still reach the ledger')
  assert.equal(state.semanticRun, 2)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Guard from '../lib/index.js'
import { sessionStatesOf } from '../lib/state.js'
import { EvidenceLedger } from '../lib/evidence.js'
import { shellMutationFacts, shellReadQueries } from '../lib/shell-facts.js'
import { classifyRisk } from '../lib/risk.js'
import { evaluateCompletionGate } from '../lib/completion-gate.js'
import { buildDiagnostics, renderDiagnostics } from '../lib/diagnostics.js'
import { realFiles, plan } from './helpers/real-files.js'
import { callTool } from './helpers/harness.js'
import { ScriptedAdapter, tool, done, runTurn } from './helpers/loop.js'

const pwsh = { powershell: true }
const facts = command => shellMutationFacts(command, pwsh)
const bucket = (probe, agent) => sessionStatesOf(Guard.default, probe.ctx).peek(agent.session)
const makeAgent = (probe, name, options = {}) => probe.harness.create(SessionId(name), options, { cwd: probe.root })
const gate = state => evaluateCompletionGate({ state, requireVerificationForMutation: true, verification: new EvidenceLedger(state).verificationCoveringLatestMutation() })

for (const prefix of ["$f='gone.txt';", "$f = 'gone.txt'\n", '$F="gone.txt";', "$f='old.txt'; $f='gone.txt';"]) {
  test(`literal binding: ${prefix}`, () => {
    assert.deepEqual(facts(`${prefix} Remove-Item -LiteralPath $f -Force`), { targets: ['gone.txt'], unresolved: [] })
    assert.equal(shellReadQueries(`${prefix} Test-Path -LiteralPath "$f"`, pwsh)[0]?.path, 'gone.txt')
  })
}

test('literal named parameters and multiple bindings resolve, including apostrophes and spaces', () => {
  assert.deepEqual(facts("Remove-Item -LiteralPath 'C:/work/a b.txt' -Force").targets, ['C:/work/a b.txt'])
  assert.deepEqual(facts("$f='a''b.txt'; Remove-Item -LiteralPath $f").targets, ["a'b.txt"])
  assert.deepEqual(facts("$a='a.txt'; $b='b.txt'; Remove-Item $a; Remove-Item $b").targets, ['a.txt', 'b.txt'])
  assert.deepEqual(facts("$f='a.txt'; Get-Item $f; Remove-Item $f").targets, ['a.txt'])
  assert.equal(shellReadQueries("$f='a.txt'; Get-Content $f | Select-Object -First 1 | Out-String", pwsh)[0]?.path, 'a.txt')
  assert.equal(classifyRisk({ toolName: 'pwsh', args: { command: "$f='C:/outside/.env'; Set-Content -LiteralPath $f x" }, workspaceRoot: 'C:/work' }).risk, 'CRITICAL')
})

for (const command of [
  'Remove-Item -LiteralPath $f',
  "$f=(Join-Path . 'gone.txt'); Remove-Item $f",
  "$f='a.txt'; $f=Get-Content paths.txt; Remove-Item $f",
  "$f='a.txt'; if ($true) { $f='b.txt'; }; Remove-Item $f",
  "$f='a.txt'; if ($true) { Remove-Item $f }",
  "$f='a.txt' && Remove-Item $f",
  "$f='a.txt'; Remove-Item $f,unknown*.txt",
  "$f='a.txt'; Get-Item $f -OutVariable f; Remove-Item $f",
  "$f='a.txt'; Get-Item $f -ov:f; Remove-Item $f",
  "$f='a.txt'; Get-Item $f -InformationVariable f; Remove-Item $f",
  "$f='a.txt'; Get-Item $f -OutV f; Remove-Item $f",
  "Set-Location sub; Remove-Item gone.txt",
  'Remove-Item -Verbose gone.txt > log.txt',
  'Write-Output x > $unknown > log.txt',
]) {
  test(`unknown expression is explicit, not empty success: ${command}`, () => {
    assert.ok(facts(command).unresolved.length > 0)
  })
}

test('bindings never cross calls or get interpreted as Bash; quoted text is not code', () => {
  facts("$f='gone.txt'")
  assert.deepEqual(facts('Remove-Item $f').targets, [])
  // Since 1.1.1 omitted options auto-detect PowerShell; explicit Bash must not.
  assert.deepEqual(shellMutationFacts("$f='gone.txt'; rm $f", { powershell: false }).targets, [])
  assert.deepEqual(facts('Write-Output "Remove-Item $f"'), { targets: [], unresolved: [] })
  assert.deepEqual(shellReadQueries("$f='a'; if ($true) {$f='b'}; Test-Path $f", pwsh), [])
})

for (const variables of [false, true]) {
  test(`${variables ? 'variable' : 'absolute literal'} deletion: pending 0 -> 1 -> 1 -> 0`, { skip: process.platform !== 'win32' }, async t => {
    const probe = await realFiles(t, { review: { enabled: false } })
    const agent = await makeAgent(probe, `transition-${variables}`)
    const target = probe.targetOf('gone.txt').replaceAll("'", "''")
    const command = verb => variables ? `$f = '${target}'; ${verb} -LiteralPath $f` : `${verb} -LiteralPath '${target}'`
    await callTool(probe.ctx, 'write', { file_path: 'gone.txt', content: 'fixture' }, { agent })
    await callTool(probe.ctx, 'read', { file_path: 'gone.txt' }, { agent })
    const state = bucket(probe, agent), ledger = new EvidenceLedger(state)
    assert.equal(ledger.pendingMutations().length, 0)
    const before = state.mutationEvents.length
    await callTool(probe.ctx, 'pwsh', { command: command('Remove-Item') + ' -Force', description: plan }, { agent })
    assert.equal(existsSync(probe.targetOf('gone.txt')), false)
    assert.equal(state.mutationEvents.length, before + 1)
    assert.equal(ledger.pendingMutations().length, 1)
    assert.equal(ledger.pendingMutations()[0].expected, 'absent')
    assert.equal(gate(state).passed, false)
    writeFileSync(probe.targetOf('other.txt'), 'unrelated')
    await callTool(probe.ctx, 'read', { file_path: 'other.txt' }, { agent })
    assert.equal(ledger.pendingMutations().length, 1)
    await callTool(probe.ctx, 'pwsh', { command: command('Test-Path') }, { agent })
    assert.equal(ledger.pendingMutations().length, 0)
    assert.equal(state.unresolvedMutationCount, 0)
    assert.equal(ledger.summary().staleFiles, 0)
    assert.equal(gate(state).passed, true)
    const report = buildDiagnostics({ state, ledger, detail: true })
    assert.equal(report.mutations.at(-1).expected, 'absent')
    assert.ok(report.mutations.at(-1).coveredBy > report.mutations.at(-1).at)
    assert.match(renderDiagnostics(report), /mutation #\d+/)
  })
}

test('dynamic deletion creates unresolved risk; unrelated reads and review PASS cannot hide it', { skip: process.platform !== 'win32' }, async t => {
  const probe = await realFiles(t, { review: { enabled: false }, evidence: { enabled: false } })
  const agent = await makeAgent(probe, 'dynamic')
  writeFileSync(probe.targetOf('gone.txt'), 'fixture')
  await callTool(probe.ctx, 'pwsh', { command: "$f=Join-Path . 'gone.txt'; Remove-Item -LiteralPath $f", description: plan }, { agent })
  const state = bucket(probe, agent), ledger = new EvidenceLedger(state)
  assert.equal(existsSync(probe.targetOf('gone.txt')), false)
  assert.equal(state.unresolvedMutationCount, 1)
  assert.equal(state.mutations.size, 0, 'uncertainty must not assert an observed mutation')
  await callTool(probe.ctx, 'pwsh', { command: 'Test-Path -LiteralPath gone.txt' }, { agent })
  await callTool(probe.ctx, 'subagent', { report: 'VERDICT: PASS' }, { agent })
  assert.equal(gate(state).passed, false)
  assert.equal(ledger.verificationCoveringLatestMutation(), undefined)
  assert.match(renderDiagnostics(buildDiagnostics({ state, ledger, detail: true })), /unresolved mutation risks: 1/)
})

test('deletion remains recorded when a later operation makes the command fail', { skip: process.platform !== 'win32' }, async t => {
  const probe = await realFiles(t, { review: { enabled: false } })
  const agent = await makeAgent(probe, 'partial-failure')
  writeFileSync(probe.targetOf('gone.txt'), 'fixture')
  await callTool(probe.ctx, 'pwsh', { command: "$f='gone.txt'; Remove-Item $f; throw 'later failure'", description: plan }, { agent })
  assert.equal(new EvidenceLedger(bucket(probe, agent)).pendingMutations().length, 1)
})

test('registry error results retain already-observed file deletion', async t => {
  const probe = await realFiles(t, { review: { enabled: false } })
  const agent = await makeAgent(probe, 'error-result')
  writeFileSync(probe.targetOf('gone.txt'), 'fixture')
  probe.ctx.tools.register(defineTool({
    name: 'bash', description: 'Bounded failed-deletion fixture.',
    parameters: { command: { type: 'string', required: true }, description: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute() { unlinkSync(probe.targetOf('gone.txt')); throw new Error('failure after deletion') },
  }))
  const result = await callTool(probe.ctx, 'bash', { command: 'rm gone.txt', description: plan }, { agent })
  assert.equal(result.isError, true)
  assert.equal(new EvidenceLedger(bucket(probe, agent)).pendingMutations()[0].expected, 'absent')
})

for (const phase of ['before', 'after']) {
  test(`snapshot failure ${phase} deletion is an explicit uncertainty`, { skip: process.platform !== 'win32' }, async t => {
    const probe = await realFiles(t, { review: { enabled: false } })
    const agent = await makeAgent(probe, `stat-failed-${phase}`)
    writeFileSync(probe.targetOf('gone.txt'), 'fixture')
    const original = probe.ctx.fs.stat
    let calls = 0
    probe.ctx.fs.stat = async target => {
      if (++calls === (phase === 'before' ? 1 : 2)) throw new Error('fixture permission error')
      return original(target)
    }
    await callTool(probe.ctx, 'pwsh', { command: 'Remove-Item gone.txt', description: plan }, { agent })
    assert.equal(existsSync(probe.targetOf('gone.txt')), false)
    const state = bucket(probe, agent)
    assert.equal(state.unresolvedMutationCount, 1)
    assert.equal(gate(state).passed, false)
  })
}

test('a denied variable deletion neither runs nor creates an unresolved execution risk', { skip: process.platform !== 'win32' }, async t => {
  const probe = await realFiles(t)
  const agent = await makeAgent(probe, 'denied-variable')
  writeFileSync(probe.targetOf('gone.txt'), 'fixture')
  const result = await callTool(probe.ctx, 'pwsh', { command: "$f='gone.txt'; Remove-Item $f -Force" }, { agent })
  assert.equal(result.isError, true)
  assert.equal(existsSync(probe.targetOf('gone.txt')), true)
  assert.equal(bucket(probe, agent).unresolvedMutationCount, 0)
  assert.equal(bucket(probe, agent).mutations.size, 0)
})

test('variable deletion completes a production loop without duplicate contexts', { skip: process.platform !== 'win32' }, async t => {
  const probe = await realFiles(t)
  const adapter = new ScriptedAdapter([
    [tool('w', 'write', { file_path: 'gone.txt', content: 'fixture' })],
    [tool('r', 'read', { file_path: 'gone.txt' })],
    [tool('d', 'pwsh', { command: "$f='gone.txt'; Remove-Item -LiteralPath $f -Force", description: plan })],
    [tool('v', 'pwsh', { command: "$f='gone.txt'; Test-Path -LiteralPath $f" })],
    [tool('review', 'subagent', { report: 'VERDICT: PASS' })], done,
  ])
  probe.ctx.llm.registerAdapter(['scripted'], adapter)
  const agent = await makeAgent(probe, 'variable-loop', { provider: 'scripted', model: 'local' })
  await runTurn(probe.ctx, agent)
  const state = bucket(probe, agent)
  assert.equal(state.mutationSinceVerification, false)
  assert.equal(state.unresolvedMutationCount, 0)
  assert.equal(state.review.verdict.verdict, 'PASS')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { EvidenceLedger } from '../lib/evidence.js'
import { createSessionState, sessionStatesOf, publishSessionStates, withdrawSessionStates } from '../lib/state.js'
import { buildDiagnostics, PLUGIN_VERSION } from '../lib/diagnostics.js'
import { collectReadEvidence } from '../lib/observations.js'
import * as Guard from '../lib/index.js'
import { classifyRisk, extractShellPaths } from '../lib/risk.js'
import { parseVerificationSignals, judgeVerification } from '../lib/verification.js'
import { pathKey } from '../lib/shell-facts.js'
import { callTool, guardNotices } from './helpers/harness.js'
import { realFiles, plan } from './helpers/real-files.js'
import { ScriptedAdapter, tool, done, runTurn } from './helpers/loop.js'

const bucket = (probe, agent) => sessionStatesOf(Guard.default, probe.ctx).peek(agent.session)
const makeAgent = (probe, name, options = {}) => probe.harness.create(SessionId(name), options, { cwd: probe.root })

test('relative deletes and redirection targets are extracted; quoted mentions are not writes', () => {
  for (const command of ['Remove-Item gone.txt', 'rm gone.txt', 'echo done > gone.txt', 'git diff>gone.txt']) {
    assert.ok(extractShellPaths(command).includes('gone.txt'), command)
    assert.notEqual(classifyRisk({ toolName: 'pwsh', args: { command } }).mutation, 'never', command)
  }
  for (const command of ['echo "Set-Content x.txt hi"', 'rg -n "DROP TABLE" docs/', 'Get-Content .env.example']) {
    assert.equal(classifyRisk({ toolName: 'pwsh', args: { command } }).risk, 'LOW', command)
  }
  assert.equal(classifyRisk({ toolName: 'pwsh', args: { command: 'Get-Content .env.example > $null; Set-Content ~/.env secret' } }).risk, 'CRITICAL')
  assert.notEqual(classifyRisk({ toolName: 'pwsh', args: { command: 'Set-Content a.txt x -n' } }).mutation, 'never')
})

test('covering checks are path/state-specific and a later rewrite invalidates coverage', () => {
  const state = createSessionState('path-coverage')
  state.workspaceRoot = 'C:/work'
  const ledger = new EvidenceLedger(state)
  state.seq = 1; ledger.noteMutation('a.txt', 'MEDIUM')
  state.seq = 2; ledger.noteMutation('b.txt', 'HIGH', { expected: 'absent', type: 'file' })
  const check = (path, expected) => ledger.recordVerification({ kind: expected === 'absent' ? 'absence' : 'read-back', passed: true, targets: [{ path, expected }] })
  state.seq = 3; check('unrelated.txt', 'present')
  assert.equal(ledger.pendingMutations().length, 2)
  state.seq = 4; check('./A.txt', 'present')
  assert.equal(ledger.pendingMutations().length, 1)
  state.seq = 5; check('b.txt', 'present')
  assert.equal(ledger.pendingMutations().length, 1)
  state.seq = 6; check('b.txt', 'absent')
  assert.equal(ledger.pendingMutations().length, 0)
  state.seq = 7; ledger.noteMutation('a.txt', 'MEDIUM')
  assert.equal(ledger.pendingMutations().length, 1)
  assert.equal(pathKey('sub/../a.txt', state.workspaceRoot), 'c:/work/a.txt')
})

test('file contents are not machine errors, while failed machine checks stay failed', () => {
  for (const text of ['FAIL', 'ERROR: example', 'code: 404', 'exit code: 1']) {
    assert.equal(judgeVerification('read-back', parseVerificationSignals(text, false)).passed, true, text)
  }
  assert.equal(judgeVerification('test', parseVerificationSignals('5 passed, 1 failed', false)).passed, false)
  assert.equal(judgeVerification('build', parseVerificationSignals('SUCCESS', false)).passed, false)
  assert.equal(judgeVerification('build', parseVerificationSignals('ERROR\nSUCCESS\n[exit code: 0]', false)).passed, false)
  assert.equal(judgeVerification('artifact', parseVerificationSignals('> 1.2.3/file', false)).passed, false)
  const long = Array.from({ length: 12 }, (_, i) => `${i + 1} passed`).join('\n') + '\n1 failed'
  assert.equal(judgeVerification('test', parseVerificationSignals(long, false)).passed, false)
})

for (const [name, readTool, args] of [
  ['Test-Path', 'pwsh', { command: 'Test-Path -LiteralPath gone.txt' }],
  ['Get-Item', 'pwsh', { command: 'Get-Item -LiteralPath gone.txt -ErrorAction Stop' }],
  ['native-read', 'read', { file_path: 'gone.txt' }],
  ['exact-glob', 'glob', { pattern: 'gone.txt' }],
  ['parent-list', 'pwsh', { command: 'Get-ChildItem -LiteralPath . -Force' }],
]) {
  test(`delete then ${name}: target absence closes coverage and stale state in a full loop`, { skip: process.platform !== 'win32' }, async t => {
    const probe = await realFiles(t)
    const adapter = new ScriptedAdapter([
      [tool('write', 'write', { file_path: 'gone.txt', content: 'probe' })],
      [tool('read-before', 'read', { file_path: 'gone.txt' })],
      [tool('delete', 'pwsh', { command: 'Remove-Item gone.txt', description: plan })],
      [tool('confirm', readTool, args)],
      [tool('review', 'subagent', { report: 'VERDICT: PASS\nExact deletion verified.' })],
      done,
    ])
    probe.ctx.llm.registerAdapter(['scripted'], adapter)
    const agent = await makeAgent(probe, name, { provider: 'scripted', model: 'local' })
    await runTurn(probe.ctx, agent)
    const state = bucket(probe, agent)
    const ledger = new EvidenceLedger(state)
    assert.equal(state.review.verdict.verdict, 'PASS')
    assert.equal(state.mutationSinceVerification, false, JSON.stringify(state.verifications))
    assert.equal(ledger.pendingMutations().length, 0)
    assert.equal(ledger.summary().staleFiles, 0)
    assert.equal(state.unexplainedFailures.length, 0)
    assert.ok(state.verifications.some(v => v.kind === 'absence' && v.passed))
  })
}

test('unrelated read, failed read and unrelated absent target cannot close a deletion', { skip: process.platform !== 'win32' }, async t => {
  const probe = await realFiles(t, { review: { enabled: false } })
  const agent = await makeAgent(probe, 'unrelated')
  await callTool(probe.ctx, 'write', { file_path: 'gone.txt', content: 'x' }, { agent })
  await callTool(probe.ctx, 'pwsh', { command: 'Remove-Item gone.txt', description: plan }, { agent })
  writeFileSync(probe.targetOf('other.txt'), 'FAIL and code: 404 are file contents')
  for (const [name, args] of [
    ['read', { file_path: 'other.txt' }],
    ['pwsh', { command: 'Test-Path -LiteralPath unrelated.txt' }],
    ['glob', { pattern: '*' }],
    ['pwsh', { command: 'Test-Path -LiteralPath gone.txt -PathType Leaf' }],
  ]) {
    await callTool(probe.ctx, name, args, { agent })
    assert.equal(bucket(probe, agent).mutationSinceVerification, true, name)
    assert.equal(new EvidenceLedger(bucket(probe, agent)).pendingMutations().length, 1, name)
  }
})

test('redirection writes are observed and an exact read closes them', { skip: process.platform !== 'win32' }, async t => {
  const probe = await realFiles(t)
  const agent = await makeAgent(probe, 'redirect')
  await callTool(probe.ctx, 'pwsh', { command: 'echo done > output.txt' }, { agent })
  assert.equal(bucket(probe, agent).mutations.size, 1)
  assert.equal(bucket(probe, agent).mutationSinceVerification, true)
  await callTool(probe.ctx, 'read', { file_path: 'output.txt' }, { agent })
  assert.equal(bucket(probe, agent).mutationSinceVerification, false)
})

test('evidence disabled retains minimal accounting so a verified turn can close', async t => {
  const probe = await realFiles(t, { evidence: { enabled: false } })
  const agent = await makeAgent(probe, 'evidence-disabled')
  await callTool(probe.ctx, 'write', { file_path: 'file.txt', content: 'x' }, { agent })
  assert.equal(bucket(probe, agent).mutationSinceVerification, true)
  const result = await callTool(probe.ctx, 'read', { file_path: 'file.txt' }, { agent })
  assert.equal(bucket(probe, agent).mutationSinceVerification, false)
  assert.equal(guardNotices(result).length, 0)
})

test('mixed present and absent reads retain coverage for each confirmed target', { skip: process.platform !== 'win32' }, async t => {
  const probe = await realFiles(t, { review: { enabled: false } })
  const agent = await makeAgent(probe, 'mixed-read')
  await callTool(probe.ctx, 'write', { file_path: 'kept.txt', content: 'kept' }, { agent })
  await callTool(probe.ctx, 'write', { file_path: 'gone.txt', content: 'gone' }, { agent })
  await callTool(probe.ctx, 'pwsh', { command: 'Remove-Item gone.txt', description: plan }, { agent })
  await callTool(probe.ctx, 'pwsh', { command: 'Get-Content kept.txt; Get-ChildItem -LiteralPath . -Force' }, { agent })
  assert.equal(bucket(probe, agent).mutationSinceVerification, false)
})

test('changes made by an external writer during a read are not attributed to the reader', async t => {
  const probe = await realFiles(t)
  const agent = await makeAgent(probe, 'read-only-attribution')
  writeFileSync(probe.targetOf('runtime.log'), 'before')
  const actualStat = probe.ctx.fs.stat
  let stats = 0
  probe.ctx.fs.stat = async target => {
    stats++
    const info = await actualStat(target)
    writeFileSync(probe.targetOf('runtime.log'), 'runtime changed independently')
    return info
  }
  await callTool(probe.ctx, 'read', { file_path: 'runtime.log' }, { agent })
  assert.ok(stats > 0, 'external write actually happened during the read')
  assert.equal(bucket(probe, agent).mutations.size, 0)
  assert.equal(bucket(probe, agent).highRiskCalls, 0)
})

test('permission errors and a directory glob do not prove deletion', async () => {
  const state = createSessionState('negative-absence')
  state.workspaceRoot = 'C:/work'
  state.seq = 1
  new EvidenceLedger(state).noteMutation('gone', 'HIGH', { expected: 'absent', type: 'directory' })
  const ctx = { get: () => ({ resolve: async path => path, stat: async () => { throw new Error('Permission denied') } }) }
  const facts = { startSeq: 2, observations: new Map(), queries: [{ path: 'C:/work/gone', kind: 'read-back' }] }
  const denied = await collectReadEvidence(ctx, { name: 'read' }, { isError: true, error: { code: 'EACCES' } }, 'Permission denied', facts, state)
  assert.deepEqual(denied.targets, [])
  facts.queries[0].kind = 'glob'
  const directory = await collectReadEvidence(ctx, { name: 'glob' }, { isError: false, value: { paths: [] } }, 'No files found', facts, state)
  assert.deepEqual(directory.targets, [])
})

test('review PASS does not substitute for target verification', async t => {
  const probe = await realFiles(t)
  const agent = await makeAgent(probe, 'review-not-proof')
  await callTool(probe.ctx, 'write', { file_path: 'changed.txt', content: 'x' }, { agent })
  await callTool(probe.ctx, 'subagent', { report: 'VERDICT: PASS' }, { agent })
  assert.equal(bucket(probe, agent).mutationSinceVerification, true)
})

test('partial diagnostics config is safe and identifies the loaded release', () => {
  for (const config of [undefined, {}, { evidence: { enabled: false } }]) {
    const report = buildDiagnostics({ config })
    assert.equal(report.pluginVersion, PLUGIN_VERSION)
    assert.equal(report.features.completionGate, true)
  }
})

test('unloading sibling registrations preserves or restores the root alias', () => {
  for (const newestFirst of [false, true]) {
    const namespace = {}, root = {}, a = { root }, b = { root }, first = {}, second = {}
    publishSessionStates(namespace, a, first)
    publishSessionStates(namespace, b, second)
    withdrawSessionStates(namespace, newestFirst ? b : a)
    assert.equal(sessionStatesOf(namespace, root), newestFirst ? first : second)
    withdrawSessionStates(namespace, newestFirst ? a : b)
    assert.equal(sessionStatesOf(namespace, root), undefined)
  }
})

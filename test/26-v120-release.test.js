import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createSessionState } from '../lib/state.js'
import { EvidenceLedger } from '../lib/evidence.js'
import { verificationQueries, parseVerificationSignals, STRONG_KINDS } from '../lib/verification.js'
import { shellMutationFacts, shellReadQueries, pathKey } from '../lib/shell-facts.js'
import { collectReadEvidence } from '../lib/observations.js'
import { detectUnknownDeclarations } from '../lib/declarations.js'

const preamble = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
const cwd = 'I:/guard-fixture'
const target = pathKey('gone.txt', cwd)
const noFs = { get: () => undefined }

function deletionFixture(command = "Test-Path -LiteralPath 'gone.txt'") {
  const state = createSessionState('v118-receipt'); state.workspaceRoot = cwd; state.seq = 1
  const ledger = new EvidenceLedger(state)
  ledger.noteMutation(target, 'HIGH', { expected: 'absent', type: 'file' })
  state.seq = 2
  const exec = { name: 'pwsh', arguments: { command: preamble + command }, signal: new AbortController().signal }
  const facts = { queries: verificationQueries(exec.name, exec.arguments, cwd), startSeq: 2, observations: new Map() }
  return { state, ledger, exec, facts }
}

test('1.2.0 leaves DSH host-version admission unpinned while keeping exact runtime peers', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
  assert.equal(manifest.version, '1.2.0')
  assert.equal(manifest.name, 'sbjw')
  assert.equal(manifest.description.includes('Cyber Internal Affairs'), true)
  assert.equal(Object.keys(manifest.peerDependencies).some(name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')), false)
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '4.0.4')
  assert.equal(manifest.peerDependencies['@deepseek-ai/schemastery'], '3.18.4')
  for (const [name, version] of Object.entries(manifest.devDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh')) assert.equal(version, '0.2.0-rc.1')
  }
})

test('1.2.0 ships localized DSH branding for Cyber Internal Affairs / 赛博纪委', () => {
  const en = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url)))
  const zh = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url)))
  assert.equal(en.meta.title, 'Cyber Internal Affairs')
  assert.equal(zh.meta.title, '赛博纪委')
  assert.match(zh.meta.description, /DeepSeek 同志/)
  assert.match(zh.meta.description, /吹牛、说大话/)
  assert.match(zh.meta.description, /实事求是/)
})

test('1.2.0 recognizes common Markdown-wrapped uncertainty declarations', () => {
  assert.deepEqual(detectUnknownDeclarations('**未验证：删除范围是否完整**'), ['删除范围是否完整'])
  assert.deepEqual(detectUnknownDeclarations('- **未确认: reviewer 是否覆盖所有目标**'), ['reviewer 是否覆盖所有目标'])
  assert.deepEqual(detectUnknownDeclarations('**unverified: release artifact hash**'), ['release artifact hash'])
})

test('encoding preamble preserves exact Test-Path, hash, listing and labeled queries', () => {
  for (const command of ["Test-Path -LiteralPath '中文.txt'", "Get-FileHash -LiteralPath '中文.txt'", 'Get-ChildItem -LiteralPath .', "'exists: ' + (Test-Path -LiteralPath 'gone.txt')"]) {
    assert.deepEqual(shellReadQueries(preamble + command, { powershell: true }), shellReadQueries(command, { powershell: true }))
  }
  const queries = verificationQueries('pwsh', { command: preamble + "Test-Path -LiteralPath 'gone.txt'", workdir: 'sub' }, cwd)
  assert.equal(queries[0].path, pathKey('sub/gone.txt', cwd))
  assert.equal(STRONG_KINDS.has('listing'), false)
})

test('PowerShell auto-detection does not override explicitly selected Bash', () => {
  const command = "$f='gone.txt'; Remove-Item -LiteralPath $f"
  assert.deepEqual(shellMutationFacts(command).targets, ['gone.txt'])
  assert.deepEqual(shellMutationFacts(command, { powershell: false }).targets, [])
})

for (const code of [0, '0']) {
  test(`structured streams with exitCode=${JSON.stringify(code)} close an exact deletion`, async () => {
    const f = deletionFixture()
    const result = { isError: false, value: { exitCode: code, stdout: { text: 'False\r\n', truncated: false }, stderr: { text: '', truncated: false } } }
    assert.equal(f.ledger.pendingMutations().length, 1)
    const observed = await collectReadEvidence(noFs, f.exec, result, '[stdout]\nFalse\n[exit code: 0]', f.facts, f.state)
    assert.deepEqual(observed.targets, [{ path: target, expected: 'absent', source: 'shell-false' }])
    f.ledger.recordVerification({ kind: 'absence', passed: true, startSeq: 2, targets: observed.targets })
    assert.equal(f.ledger.pendingMutations().length, 0)
  })
}

test('decorated text-only and fixed labeled receipts still cover exact absence', async () => {
  for (const [command, text] of [["Test-Path -LiteralPath 'gone.txt'", '[stdout]\nFalse\n[exit code: 0]'], ["'exists: ' + (Test-Path -LiteralPath 'gone.txt')", 'exists: False']]) {
    const f = deletionFixture(command)
    const observed = await collectReadEvidence(noFs, f.exec, { isError: false }, text, f.facts, f.state)
    assert.equal(observed.targets.length, 1)
    assert.equal(observed.targets[0].expected, 'absent')
  }
})

test('stderr, interruption and nonzero exit never certify a structured false receipt', async () => {
  for (const bad of [{ stderr: { text: 'Access denied', truncated: false } }, { exitCode: 1 }, { timedOut: true }, { stopped: true }, { aborted: true }, { signal: 'SIGTERM' }]) {
    const f = deletionFixture()
    const value = { exitCode: 0, stdout: { text: 'False', truncated: false }, stderr: { text: '', truncated: false }, ...bad }
    assert.deepEqual((await collectReadEvidence(noFs, f.exec, { isError: false, value }, 'False', f.facts, f.state)).targets, [])
  }
})

test('structured hash output counts as read-back but empty markers do not', async () => {
  const f = deletionFixture("Get-FileHash -LiteralPath 'gone.txt'")
  f.state.mutations.get(target).expected = 'present'
  const result = { isError: false, value: { exitCode: 0, stdout: { text: 'SHA256 123456 gone.txt', truncated: false }, stderr: { text: '', truncated: false } } }
  assert.equal((await collectReadEvidence(noFs, f.exec, result, '', f.facts, f.state)).targets[0].expected, 'present')
  assert.equal(parseVerificationSignals('[stdout]\n[exit code: 0]', false).hasReadOutput, false)
})

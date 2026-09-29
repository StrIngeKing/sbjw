import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { verificationIntent, parseVerificationSignals, judgeVerification, STRONG_KINDS } from '../lib/verification.js'
import { EvidenceLedger } from '../lib/evidence.js'
import { createSessionState, sessionStatesOf } from '../lib/state.js'
import * as Guard from '../lib/index.js'
import { evaluateCompletionGate } from '../lib/completion-gate.js'
import { mountGuardHarness, createAgent, callTool, guardNotices } from './helpers/harness.js'
import { ScriptedAdapter, tool, done, runTurn, assertDeliveredOnce } from './helpers/loop.js'

test('pure PowerShell file reads are verification attempts, including formatted and combined reads', () => {
  for (const command of [
    'Get-FileHash -LiteralPath "I:\\folder with spaces\\文件.zip" -Algorithm SHA256',
    'Get-Item -LiteralPath ./package.zip | Select-Object FullName, Length, LastWriteTime',
    'Get-Content -LiteralPath settings.json -Raw -Encoding UTF8',
    '# confirm the file\nGet-FileHash ./file.zip; Get-Item ./file.zip | Format-List *',
    'get-item ./file.zip | ConvertTo-Json -Depth 3 | Out-String',
  ]) assert.equal(verificationIntent('pwsh', { command }), 'read-back', command)
  assert.equal(verificationIntent('read', { file_path: 'file.zip' }), 'read-back')
})

test('mentions, writes, discarded output and dynamic scripts are not pure shell read-back', () => {
  for (const command of [
    'Write-Output "Get-FileHash ./file.zip"',
    'echo Get-Item ./file.zip',
    'Get-FileHash ./file.zip > hash.txt',
    'Get-Item ./file.zip | Out-File meta.txt',
    'Get-Content settings.json; Set-Content settings.json changed',
    'Get-Item ./file.zip | Out-Null',
    'Get-FileHash $(Get-Item ./file.zip)',
    'Get-Item ./file.zip -ErrorAction SilentlyContinue',
    'Get-FileHash -Algorithm SHA256',
    'Get-Item -?',
  ]) assert.equal(verificationIntent('pwsh', { command }), undefined, command)
})

test('shell read-back requires output and rejects non-terminating errors, failure exits and interruption', () => {
  const success = 'Algorithm Hash Path\nSHA256 1234567890 C:\\out.zip'
  assert.equal(judgeVerification('read-back', parseVerificationSignals(success, false), { shellRead: true }).strong, true)
  for (const text of [
    '', '(no output)', '[exit code: 0]', '(no output)\n[exit code: 0]',
    `${success}\n[exit code: 1]`,
    `${success}\n[exit code: null]`,
    'Get-Item: Cannot find path',
    '[stderr]\nGet-FileHash: Access denied\n[exit code: 0]',
    `${success}\n[timed out after 100ms]`,
    `${success}\n[stopped: user]`,
    `${success}\n[killed by signal: SIGTERM]`,
    '[still running after 100ms; moved to background job x]',
  ]) assert.equal(judgeVerification('read-back', parseVerificationSignals(text, false), { shellRead: true }).passed, false, text)
  assert.equal(judgeVerification('read-back', parseVerificationSignals(success, true), { shellRead: true }).passed, false)
})

test('read-back, lint and diff strength agrees across verdict, ledger, diagnostics and gate', () => {
  for (const [kind, output, expected] of [
    ['read-back', 'file content', true],
    ['lint', '0 problems', true],
    ['test', '5 passed, 0 failed', true],
    ['diff', 'diff --git a/a b/a', false],
  ]) {
    const state = createSessionState(`strength-${kind}`)
    const ledger = new EvidenceLedger(state)
    state.seq = 1
    ledger.noteMutation('file.txt', 'MEDIUM')
    state.seq = 2
    const verdict = judgeVerification(kind, parseVerificationSignals(output, false))
    assert.equal(verdict.strong, expected, kind)
    assert.equal(STRONG_KINDS.has(kind), expected, kind)
    ledger.recordVerification({ kind, ...verdict, targets: [{ path: 'file.txt', expected: 'present' }] })
    const covering = ledger.verificationCoveringLatestMutation()
    assert.equal(covering !== undefined, expected, kind)
    assert.equal(state.mutationSinceVerification, !expected, kind)
    assert.equal(ledger.summary().mutationVerified, expected, kind)
    assert.equal(evaluateCompletionGate({ state, verification: covering, requireVerificationForMutation: true }).passed, expected, kind)
  }
})

test('old, same-call, weak and failed verifications cannot erase a mutation', () => {
  for (const record of [
    { kind: 'read-back', passed: true, atSeq: 1 },
    { kind: 'read-back', passed: true, atSeq: 2 },
    { kind: 'read-back', passed: true, strong: false, atSeq: 3 },
    { kind: 'read-back', passed: false, atSeq: 3 },
    { kind: 'unknown-kind', passed: true, atSeq: 3 },
  ]) {
    const state = createSessionState('uncovered')
    const ledger = new EvidenceLedger(state)
    state.seq = 2
    ledger.noteMutation('file.txt', 'MEDIUM')
    ledger.recordVerification(record)
    assert.equal(ledger.verificationCoveringLatestMutation(), undefined)
    assert.equal(state.mutationSinceVerification, true)
  }
})

test('a git diff is recorded but does not silently clear the mutation gate', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'diff-not-strong')
  await callTool(probe.ctx, 'write', { file_path: join(process.cwd(), 'probe.txt'), content: 'x' }, { agent })
  const result = await callTool(probe.ctx, 'pwsh', { command: 'git diff' }, { agent })
  assert.ok(guardNotices(result).some(notice => notice.tag === 'completion-gate'))
  const state = sessionStatesOf(Guard.default, probe.ctx).peek(agent.session)
  assert.equal(state.verifications.at(-1).strong, false)
  assert.equal(state.mutationSinceVerification, true)
})

for (const reader of ['Get-FileHash', 'Get-Item', 'Get-Content', 'read']) {
  test(`write then ${reader} closes the gate in a real AgentLoop`, { skip: process.platform !== 'win32' && reader !== 'read' }, async (t) => {
    const probe = await mountGuardHarness({ tools: false })
    t.after(() => probe.ctx.fiber.dispose())
    const directory = mkdtempSync(join(tmpdir(), 'dsh-readback-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const target = join(directory, '回读 文件.txt')
    const expectedContent = 'A real file read-back.\n'
    probe.ctx.tools.register(defineTool({
      name: 'write', description: 'Write this test fixture.',
      parameters: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute(args) {
        assert.equal(args.file_path, target)
        writeFileSync(target, args.content)
        return 'file written'
      },
    }))
    const shell = reader !== 'read'
    const command = `${reader} -LiteralPath '${target.replaceAll("'", "''")}' -ErrorAction Stop`
    probe.ctx.tools.register(defineTool({
      name: shell ? 'pwsh' : 'read', description: 'Read this test fixture.',
      parameters: shell ? { command: { type: 'string', required: true } } : { file_path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute(args) {
        assert.equal(readFileSync(target, 'utf8'), expectedContent)
        if (!shell) return readFileSync(target, 'utf8')
        assert.equal(args.command, command)
        return execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 10000 })
      },
    }))
    const adapter = new ScriptedAdapter([
      [tool('write-file', 'write', { file_path: target, content: expectedContent })],
      [tool('read-file', shell ? 'pwsh' : 'read', shell ? { command } : { file_path: target })],
      done,
    ])
    probe.ctx.llm.registerAdapter(['scripted'], adapter)
    const agent = await createAgent(probe.harness, `readback-${reader}`, { provider: 'scripted', model: 'local' })
    const events = await runTurn(probe.ctx, agent)
    assertDeliveredOnce(events, adapter, 'completion-gate')
    const state = sessionStatesOf(Guard.default, probe.ctx).peek(agent.session)
    assert.equal(state.verifications.at(-1).kind, 'read-back')
    assert.equal(state.verifications.at(-1).strong, true)
    assert.equal(state.mutationSinceVerification, false)
    assert.equal(new EvidenceLedger(state).summary().mutationVerified, true)
    assert.equal(adapter.requests.length, 3)
  })
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateLineEndings, evaluateWindowsShellCall, isIrreversibleWithoutStatedUndo } from '../lib/windows.js'
import { SESSION_STATES, sessionStatesOf } from '../lib/state.js'
import * as Guard from '../lib/index.js'
import { callTool, createAgent, guardNotices, mountGuardHarness, resultText } from './helpers/harness.js'

const states = (ctx) => sessionStatesOf(Guard.default, ctx)

/**
 * Evaluate one shell call against the modeled platform.
 *
 * The platform is always passed explicitly: a test that depended on the host OS
 * would silently stop covering Windows on any other machine, and would cover
 * the wrong branch on Windows itself.
 */
function shell(command, { platform = 'win32', config = {}, toolName = 'pwsh' } = {}) {
  return evaluateWindowsShellCall({ toolName, args: { command }, platform, config })
}

/** The finding codes, which are the stable part of a finding. */
function codes(findings) {
  return findings.map((finding) => finding.code)
}

function edit(args, { fileText = 'a\r\nb\r\n', platform = 'win32', config = {}, toolName = 'edit' } = {}) {
  return evaluateLineEndings({ toolName, args, fileText, platform, config })
}

test('a non-ASCII command without encoding control is flagged, and the flag clears with control', () => {
  const command = 'Get-Content "C:\\数据\\报告.txt"'
  const findings = shell(command)
  assert.deepEqual(codes(findings), ['non-ascii-without-encoding'])
  assert.match(findings[0].message, /GBK\/936/, 'the note explains the concrete Windows failure mode')

  // Both documented ways of setting the encoding must clear the note: the
  // console-level control and the cmdlet-level `-Encoding` switch.
  assert.deepEqual(shell(`[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}`), [])
  assert.deepEqual(shell('Get-Content "C:\\数据\\报告.txt" -Encoding utf8'), [])

  // Mentioning encoding without setting it is a weaker but real note: the
  // effective code page is still unverified.
  const mentioned = shell('Write-Host "数据" # utf8')
  assert.deepEqual(codes(mentioned), ['encoding-mentioned-not-set'])
})

test('an unquoted path containing a space is flagged, a quoted one is not', () => {
  assert.deepEqual(codes(shell('Get-ChildItem C:\\Program Files\\Contoso')), ['unquoted-path-with-space'])
  assert.deepEqual(shell('Get-ChildItem "C:\\Program Files\\Contoso"'), [], 'a quoted path cannot be split, so there is nothing to report')
})

test('state that only survives a fresh process is flagged with the concrete workaround', () => {
  const env = shell('$env:PATH = "$env:PATH;C:\\tools"')
  assert.deepEqual(codes(env), ['fresh-process-semantics'])
  assert.match(env[0].message, /setx/, 'the note must name the remedy, not just the hazard')

  const cd = shell('cd src')
  assert.deepEqual(codes(cd), ['fresh-process-semantics'])
  assert.match(cd[0].message, /workdir/, 'a relative cd is resolved against an assumed directory')

  const push = shell('Push-Location C:\\src')
  assert.deepEqual(codes(push), ['fresh-process-semantics'])
  assert.match(push[0].message, /scoped to this process/)
})

test('&& chaining is flagged, except when the command itself targets PowerShell', () => {
  assert.deepEqual(codes(shell('npm run build && npm test')), ['posix-chaining'])
  // PowerShell 7 supports `&&`, so a command that names it explicitly is not a
  // hazard; the note exists for the unknown-target case only.
  assert.deepEqual(shell('pwsh -NoProfile -Command "npm run build" && pwsh -Command "npm test"'), [])
})

test('an unquoted cmd /c invocation is flagged as a re-parse hazard', () => {
  const findings = shell('cmd /c dir C:\\')
  assert.deepEqual(codes(findings), ['cmd-quoting'])
  assert.match(findings[0].message, /re-parses the line/, 'cmd.exe applies its own quoting rules')
  assert.deepEqual(shell('cmd /c "echo %PATH%"'), [], 'quoting the inner command removes the ambiguity')
})

test('every finding is advisory and non-Windows platforms produce none', () => {
  const flagged = [
    'Get-Content "C:\\数据\\报告.txt"',
    'Write-Host "数据" # utf8',
    'Get-ChildItem C:\\Program Files\\Contoso',
    '$env:PATH = "$env:PATH;C:\\tools"',
    'cd src',
    'Push-Location C:\\src',
    'npm run build && npm test',
    'cmd /c dir C:\\',
  ]

  for (const command of flagged) {
    const findings = shell(command)
    assert.ok(findings.length > 0, `this command is one of the hazard cases: ${command}`)
    // The whole point of these checks: a wrong heuristic must never stall work.
    assert.deepEqual(
      [...new Set(findings.map((finding) => finding.severity))],
      ['advisory'],
      `every finding must be advisory: ${command}`,
    )
    // Linux and macOS must not regress: the checks are Windows-only by design.
    assert.deepEqual(shell(command, { platform: 'linux' }), [], `no findings on linux: ${command}`)
    assert.deepEqual(shell(command, { platform: 'darwin' }), [], `no findings on darwin: ${command}`)
  }

  // The evaluator only claims shell calls, and an operator can turn it off.
  assert.deepEqual(shell('npm run build && npm test', { toolName: 'write' }), [])
  assert.deepEqual(shell('npm run build && npm test', { config: { enabled: false } }), [])
  assert.deepEqual(shell(''), [], 'an empty command is nothing to warn about')
})

test('a CRLF file with a bare-\\n anchor is flagged, a matching anchor is not', () => {
  const mismatch = edit({ old_string: 'a\nb' })
  assert.deepEqual(codes(mismatch), ['crlf-mismatch'])
  assert.equal(mismatch[0].severity, 'advisory')
  assert.match(mismatch[0].message, /CRLF line endings/)

  assert.deepEqual(edit({ old_string: 'a\r\nb' }), [], 'an anchor copied from the file matches exactly')

  const opposite = edit({ old_string: 'a\r\nb' }, { fileText: 'a\nb\n' })
  assert.deepEqual(codes(opposite), ['lf-mismatch'])
  assert.deepEqual(edit({ old_string: 'a\nb' }, { fileText: 'a\nb\n' }), [])
})

test('line-ending checks need known file text and the edit tool', () => {
  // Without the current text the dominant ending is unknown, so guessing would
  // only produce noise. `fileText` is passed explicitly here because the helper
  // above defaults it.
  assert.deepEqual(
    evaluateLineEndings({ toolName: 'edit', args: { old_string: 'a\nb' }, fileText: undefined, platform: 'win32', config: {} }),
    [],
  )
  assert.deepEqual(edit({ old_string: 'a\nb' }, { fileText: '' }), [])
  assert.deepEqual(edit({ old_string: '' }), [], 'an empty anchor cannot mismatch')
  assert.deepEqual(edit({ old_string: 'a\nb' }, { toolName: 'write' }), [])
  assert.deepEqual(edit({ old_string: 'a\nb' }, { config: { warnOnCrlfSensitivePatch: false } }), [])
  assert.deepEqual(edit({ old_string: 'a\nb' }, { platform: 'linux' }), [])
})

test('a non-destructive command is never reported as irreversible', () => {
  // The false-positive direction matters as much as the true-positive one: a
  // read-only command must never be accused of being irreversible.
  for (const command of ['ls -la', 'echo hi', 'git status', 'Get-Content notes.txt', 'npm test']) {
    assert.equal(isIrreversibleWithoutStatedUndo(command), false, `not destructive: ${command}`)
  }
})

// REFERENCE FINDING (not fixed here): the second parameter is documented but not
// declared, so the function cannot read the stated plan it is supposed to honor.
test('a destructive command is judged against its stated undo plan', () => {
  assert.equal(isIrreversibleWithoutStatedUndo('rm -rf /tmp/build'), true, 'no plan was stated')
  assert.equal(isIrreversibleWithoutStatedUndo('Remove-Item -Recurse -Force C:\\data'), true)
  assert.equal(isIrreversibleWithoutStatedUndo('git reset --hard HEAD~3'), true)
  assert.equal(isIrreversibleWithoutStatedUndo('DROP TABLE users'), true)
  assert.equal(
    isIrreversibleWithoutStatedUndo('rm -rf /tmp/build', 'a backup copy exists at /tmp/build.bak and can be restored'),
    false,
    'a stated undo path makes the command reversible',
  )
})

test('the Windows checks are wired but never block a PowerShell call', async (t) => {
  // Debug level so the advisory log line is observable: the finding must be
  // auditable somewhere an operator can read, not only held in a counter.
  const probe = await mountGuardHarness({ config: { diagnostics: { logLevel: 'debug' } } })
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'windows-pipeline')
  const bucket = states().peek(agent.session)

  const command = 'Get-Content "C:\\数据\\报告.txt"'
  // The pure evaluator is the layer that detects the hazard; the pipeline test
  // below proves that detection never turns into a denial.
  assert.deepEqual(codes(shell(command)), ['non-ascii-without-encoding'])

  const result = await callTool(
    probe.ctx,
    'pwsh',
    { command, description: 'dry-run inspection only; verification: re-read the printed output; rollback: nothing is written' },
    { agent },
  )
  assert.equal(result.isError, false, 'an environment note is advisory: it must never block the call')
  assert.equal(resultText(result), `ran: ${command}`, 'the tool result is delivered unchanged')
  assert.deepEqual(guardNotices(result), [], 'an advisory note is not delivered as a correction')
  assert.equal(bucket.counters.preExecuteChecked, 1, 'the call went through the guard, so the wiring exists')
  assert.equal(bucket.counters.deniedHighRisk, 0)
  assert.equal(bucket.counters.blockedLoops, 0)
  assert.equal(bucket.counters.digestsInjected, 0, 'nothing was corrected or injected')

  // The advisory note must be auditable, not invisible: the counter that the
  // diagnostics report shows is the surface that makes it so, and the finding
  // code is logged for an operator reading the host log.
  assert.equal(bucket.counters.windowsWarnings, 1, 'the advisory finding is counted for diagnostics')
  assert.ok(
    probe.logger.at('debug').some((line) => line.includes('windows advisory (non-ascii-without-encoding)')),
    'the advisory finding is logged with its code',
  )
})

test('a Windows parsing hazard never blocks a call, even a risky one', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'windows-advisory-only')
  const bucket = states().peek(agent.session)

  // An unquoted path with a space, plus a backup copy the classifier can see, so
  // the risk gate is satisfied and only the advisory layer is engaged.
  const command = 'Copy-Item C:\\temp dir\\file.txt C:\\backup\\file.txt.bak'
  const result = await callTool(
    probe.ctx,
    'pwsh',
    { command, description: 'backup copy; verification: re-read the destination; rollback: the original is untouched' },
    { agent },
  )
  assert.equal(result.isError, false, 'advisory findings must never deny a call')
  assert.ok(bucket.counters.windowsWarnings >= 1, 'the parsing hazard is counted')
  assert.equal(bucket.counters.deniedHighRisk, 0)
})

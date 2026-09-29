/**
 * Regression tests for the two adversarial review rounds.
 *
 * Each case here corresponds to a reproduced finding from a reviewer that had
 * not written the code. They are kept separate from the feature suites because
 * their purpose is different: these assert that a specific defect stays fixed,
 * with the reviewer's own reproduction as the test body.
 *
 * @module test/18-review-regressions
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { redactSecrets } from '../lib/util.js'
import { classifyRisk, extractShellPaths } from '../lib/risk.js'
import { evaluateFreshness } from '../lib/freshness.js'
import * as Guard from '../lib/index.js'
import { mountGuardHarness, callTool, createAgent, guardNotices, resultText } from './helpers/harness.js'

test('a credential embedded in a URL is redacted as one component', () => {
  // The password may contain `@`, `:`, `/` or `%`, so the redaction cannot stop
  // at the first separator. Each case below leaked before the fix.
  const cases = [
    ['https://user:s3cr3tP4ss@example.com/repo', 's3cr3tP4ss'],
    ['postgres://admin:P@ssw0rd!@host:5432/db', 'P@ssw0rd!'],
    ['postgres://admin:P@ssw0rd!@host:5432/db', 'ssw0rd!'],
    ['mysql://root:pw@tcp(host:3306)/db', 'pw'],
    ['redis://:hunter2@cache.internal:6379', 'hunter2'],
    ['https://user:pa/ss@host/path', 'pa/ss'],
    ['curl -u alice:s3cr3t https://api.example.com', 's3cr3t'],
    ['//registry.npmjs.org/:_authToken=npm_AbCdEf123456', 'npm_AbCdEf123456'],
  ]
  for (const [text, secret] of cases) {
    const out = redactSecrets(text)
    assert.equal(out.includes(secret), false, `the credential must not survive: ${text} -> ${out}`)
    assert.match(out, /<redacted:[0-9a-f]{8}>/, `the redaction must be visible: ${out}`)
  }
})

test('redaction does not mangle a public URL that merely contains an at sign', () => {
  // A scoped package path is not a credential, and mangling it would corrupt
  // every diagnostic that mentions a registry URL.
  for (const text of ['https://github.com/org/repo.git', 'https://example.com/a@b/c', 'mailto:someone@example.com']) {
    assert.equal(redactSecrets(text), text, `ordinary text must be untouched: ${text}`)
  }
})

test('innocent commands that mention credential words are not denied', () => {
  // These were classified CRITICAL before the fix, which refused ordinary
  // read-only work.
  const innocent = [
    'rg "api_key" src/',
    'npm run test --grep "password reset"',
    'cat .env.example',
    'Get-Content -Path .env.example',
    'git log --grep "rotate the password"',
    'rg "how to rotate the password"',
    'ssh-keygen -l -f ~/.ssh/id_rsa.pub',
    'ssh-keygen -y -f ~/.ssh/id_rsa',
    'openssl req -noout -text -in csr.pem',
    'openssl rsa -noout -modulus -in key.pem',
  ]
  for (const command of innocent) {
    const verdict = classifyRisk({ toolName: 'pwsh', args: { command }, workspaceRoot: process.cwd() })
    assert.notEqual(verdict.risk, 'CRITICAL', `must not be CRITICAL: ${command} -> ${verdict.ruleId}`)
  }
})

test('a real credential write is still CRITICAL', () => {
  const writes = [
    'Set-Content -Path .credentials.yaml -Value x',
    'ssh-keygen -t ed25519 -f ~/.ssh/deploy',
    'ssh-keygen',
    'openssl genrsa -out private.pem 2048',
    'rotate the api_key in the vault',
    'echo "postgres://u:p@h/db" >> .env',
  ]
  for (const command of writes) {
    const verdict = classifyRisk({ toolName: 'pwsh', args: { command }, workspaceRoot: process.cwd() })
    assert.equal(verdict.risk, 'CRITICAL', `must stay CRITICAL: ${command} -> ${verdict.risk}/${verdict.ruleId}`)
    assert.equal(verdict.action, 'credential')
  }
})

test('/tmp, the platform temp root and workspace paths are not treated as escapes', () => {
  // A relative write target inside the workspace is the most common call there
  // is; classifying it as outside would put the approval prompt in front of
  // every ordinary edit.
  const workspace = process.cwd()
  for (const command of [
    'Set-Content -Path out.txt -Value hello',
    'Out-File -FilePath build.log',
    `Set-Content -Path ${workspace}\\note.txt -Value x`,
  ]) {
    const verdict = classifyRisk({ toolName: 'pwsh', args: { command }, workspaceRoot: workspace })
    assert.notEqual(verdict.scope, 'outside', `inside the workspace: ${command} -> ${verdict.scope}`)
    assert.notEqual(verdict.risk, 'CRITICAL', `inside the workspace: ${command} -> ${verdict.risk}`)
  }
})

test('a relative write target is extracted so a mutation can be observed', () => {
  // Without the target the version diff has nothing to compare, so a shell
  // mutation stayed invisible to the completion gate.
  assert.deepEqual(extractShellPaths('Set-Content -Path out.txt -Value hello'), ['out.txt'])
  assert.deepEqual(extractShellPaths('Set-Content out.txt -Value hello'), ['out.txt'])
  assert.deepEqual(extractShellPaths('Out-File -FilePath build.log'), ['build.log'])
  // A read is not a write target.
  assert.deepEqual(extractShellPaths('Get-Content -Path out.txt'), [])
})

test('ordinary engineering prose never trips the freshness gate', () => {
  const topics = ['version', 'release', 'latest', 'compatib', 'api', 'deprecat', 'support', 'registry', 'npm', 'pypi', 'changelog', 'security', 'advisory']
  const ordinary = [
    'I added a new api method on the guard namespace so the settings page can read it.',
    'This change supports a new option without altering the existing behaviour.',
    'The npm script now runs the targeted suite before the broader one.',
    'I reviewed the security wording in the error message and tightened it.',
    'The file path contains api and version in its name, which is unfortunate.',
    'Our own release notes live in CHANGELOG.md and I updated the entry for this fix.',
    'I bumped the internal version constant and reran the suite.',
    'The registry lookup is cached, so the second call is free.',
    'Support for that flag was added two commits ago.',
    'The deprecation shim still exists for the old name.',
  ]
  for (const text of ordinary) {
    const verdict = evaluateFreshness({ text, topics, retrievedTopics: [], now: 1_000_000 })
    assert.equal(verdict.passed, true, `must not be flagged: ${text}`)
  }
})

test('a genuine external claim is still reported, and never blocks', () => {
  const topics = ['version', 'release', 'latest', 'compatib', 'api', 'deprecat', 'support', 'registry', 'npm', 'pypi', 'changelog', 'security', 'advisory']
  const genuine = [
    'DSH 0.1.7 is the latest release of DeepSeek Harness.',
    'The current version is 2.0.1 and it is no longer supported.',
    'CVE-2025-1234 was announced for the registry package.',
  ]
  for (const text of genuine) {
    const verdict = evaluateFreshness({ text, topics, retrievedTopics: [], now: 1_000_000 })
    assert.equal(verdict.passed, false, `must be reported: ${text}`)
    assert.equal(verdict.gaps[0].severity, 'advisory', 'a lexical detector must never block a turn')
  }
})

test('an edit call on a real file completes without an import or read failure', async (t) => {
  // The guard's line-ending check runs before an edit. A missing import there
  // failed every edit call on every platform, so this test drives the real
  // pipeline with a minimal `fs` provider standing in for the session backend.
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)

  const crlfText = 'alpha\r\nbeta\r\ngamma\r\n'
  const files = new Map([['/work/crlf.txt', crlfText]])
  const versions = new Map([['/work/crlf.txt', 'v1']])
  ctx.provide('fs', {
    async resolve(path) {
      return { targetKey: path, displayPath: path }
    },
    async stat(target) {
      if (!files.has(target.targetKey)) return undefined
      return { version: versions.get(target.targetKey), type: 'file', size: files.get(target.targetKey).length }
    },
    async readText(target) {
      return files.get(target.targetKey)
    },
  })

  const guardFiber = ctx.plugin(Guard, { diagnostics: { logLevel: 'debug' } })
  await guardFiber
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('edit-check'), {}, { cwd: '/work' })

  ctx.tools.register(
    defineTool({
      name: 'edit',
      description: 'Test double for the edit tool.',
      parameters: {
        file_path: { type: 'string', required: true, description: 'Target path.' },
        old_string: { type: 'string', required: true, description: 'Anchor.' },
        new_string: { type: 'string', required: true, description: 'Replacement.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        return `edited ${args.file_path}`
      },
    }),
  )

  const result = await callTool(
    ctx,
    'edit',
    { file_path: '/work/crlf.txt', old_string: 'beta\ngamma', new_string: 'beta\ndelta' },
    { agent },
  )
  assert.equal(result.isError, false, `the edit must reach the tool body: ${resultText(result)}`)
  assert.match(resultText(result), /edited \/work\/crlf\.txt/)
  assert.equal(result.content.some((part) => String(part.text).includes('Cyber Internal Affairs')), false, 'guard prose must not enter the tool result')
})

test('a shell mutation is observed through the file version, not the tool name', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)

  const files = new Map()
  const versions = new Map()
  let counter = 0
  ctx.provide('fs', {
    async resolve(path) {
      return { targetKey: path, displayPath: path }
    },
    async stat(target) {
      if (!files.has(target.targetKey)) return undefined
      return { version: versions.get(target.targetKey), type: 'file', size: files.get(target.targetKey).length }
    },
    async readText(target) {
      return files.get(target.targetKey)
    },
  })

  const guardFiber = ctx.plugin(Guard, {})
  await guardFiber
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('shell-mutation'), {}, { cwd: '/work' })

  ctx.tools.register(
    defineTool({
      name: 'pwsh',
      description: 'Test double for the pwsh tool that really writes a file.',
      parameters: {
        command: { type: 'string', required: true, description: 'Command.' },
        description: { type: 'string', description: 'Stated intent.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        files.set('out.txt', 'hello')
        counter += 1
        versions.set('out.txt', `v${counter}`)
        return `ran: ${args.command}`
      },
    }),
  )

  const result = await callTool(
    ctx,
    'pwsh',
    {
      command: 'Set-Content -Path out.txt -Value hello',
      // A stated rollback and verification satisfy the risk gate, so the call
      // proceeds and the ONLY thing left to observe is what changed on disk.
      description: 'write a file; rollback: restore from the backup copy; verification: re-read the file',
    },
    { agent },
  )
  assert.equal(result.isError, false, `the stated plan must let the call through: ${resultText(result)}`)
  // The call changed the version of a path it named, so the guard records a
  // mutation even though `pwsh` is not a tool the classifier knows as a writer.
  // The diagnostics report is the observable surface for that record.
  const report = resultText(await callTool(ctx, 'sbjw', { detail: true }, { agent }))
  assert.match(report, /mutations: 1 file\(s\) this session/, `an observed shell mutation must be recorded: ${report}`)
})

test('a genuine unexplained failure blocks its own turn but not the next one', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'failure-scope')

  agent.session.append('turn/start', { turn: 1 })
  await callTool(probe.ctx, 'probe_echo', { text: 'boom: disk full', fail: true }, { agent })
  const sameTurn = await callTool(probe.ctx, 'probe_echo', { text: 'retrying' }, { agent })
  assert.ok(
    guardNotices(sameTurn).some((notice) => notice.tag === 'completion-gate' && /never explained/.test(notice.text)),
    'the failure must block the turn it happened in',
  )

  agent.session.append('turn/start', { turn: 2 })
  const nextTurn = await callTool(probe.ctx, 'probe_echo', { text: 'unrelated work' }, { agent })
  assert.deepEqual(
    guardNotices(nextTurn).filter((notice) => notice.tag === 'completion-gate'),
    [],
    'a transient failure must not stop unrelated later work',
  )
})

test('the guard never writes its prose into the tool result', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'no-poison')
  const result = await callTool(probe.ctx, 'write', { file_path: '/tmp/np.txt', content: 'x' }, { agent })
  assert.equal(resultText(result), 'wrote /tmp/np.txt (1 bytes)', 'the result is exactly what the tool produced')
  assert.ok(guardNotices(result).length > 0, 'the correction is delivered as additional context instead')
})

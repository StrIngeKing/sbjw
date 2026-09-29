/**
 * Profile smoke check.
 *
 * This is the one test that exercises the **installed** artifact rather than the
 * working tree: it imports `dsh-reliability-guard` from a real DSH profile's
 * `node_modules` (populated by `dsh plugin --profile <name> add <tarball>`) and
 * unwraps it exactly the way the Cordis loader does, so a broken `files` list, a
 * missing entry point, or an unparsable patch is caught here.
 *
 * Two environment variables configure it:
 *
 * - `DSRH_SMOKE_PROFILE_DIR` — `<DSH_HOME>/profiles/<name>`, the profile that has
 *   the tarball installed.
 * - `DSRH_SMOKE_INSTALL_NODE_MODULES` — the DSH installation's own
 *   `node_modules`, used to resolve the plugin's declared peers the way the real
 *   loader does. A `file:` tarball install does not materialize peer
 *   dependencies into the profile, so without this a bare import from the
 *   installed copy cannot resolve; pointing at the installation tree is exactly
 *   what the installed host provides at runtime.
 *
 * The test reports a skip when the profile is absent, because the profile is
 * created by the release procedure rather than by `pnpm install`.
 *
 * @module test/17-profile-smoke
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { deliverSessionEvent, assistantMessageData, registerProbeTools } from './helpers/harness.js'
import { ScriptedAdapter, tool, done, runTurn, assertDeliveredOnce } from './helpers/loop.js'
import { realFiles, plan } from './helpers/real-files.js'

const profileDir = process.env.DSRH_SMOKE_PROFILE_DIR
const installNodeModules = process.env.DSRH_SMOKE_INSTALL_NODE_MODULES

/**
 * Reproduce the Cordis loader's export shape normalization.
 *
 * @param exports - the imported module namespace.
 * @returns the value the loader would apply.
 */
function unwrapExports(exports) {
  if (exports === null || exports === undefined) return exports
  let value = exports.default ?? exports
  if (value.__esModule) value = value.default ?? value
  return value
}

/**
 * Link one scope's missing packages from the installation tree.
 *
 * Junction creation is Windows-friendly and needs no elevation; a directory
 * symlink is used elsewhere. Existing entries are left alone.
 *
 * @param targetDir - the `node_modules` directory to complete.
 * @param sourceDir - the installation's `node_modules`.
 * @returns the absolute paths that were linked.
 */
function linkMissingInto(targetDir, sourceDir) {
  const linked = []
  mkdirSync(targetDir, { recursive: true })
  const link = (name, from, to) => {
    if (existsSync(to)) return
    try {
      symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir')
      linked.push(to)
    } catch (error) {
      // A missing link is reported by the import that needs it, with a better
      // message than a silent swallow would give.
      void error
    }
  }
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('@')) {
      const scopeDir = join(targetDir, entry.name)
      mkdirSync(scopeDir, { recursive: true })
      for (const scoped of readdirSync(join(sourceDir, entry.name), { withFileTypes: true })) {
        link(scoped.name, join(sourceDir, entry.name, scoped.name), join(scopeDir, scoped.name))
      }
      continue
    }
    link(entry.name, join(sourceDir, entry.name), join(targetDir, entry.name))
  }
  return linked
}

test(
  'the installed tarball loads, activates, and is composed as a bundle',
  {
    skip:
      profileDir === undefined || installNodeModules === undefined
        ? 'set DSRH_SMOKE_PROFILE_DIR and DSRH_SMOKE_INSTALL_NODE_MODULES to run the installed-artifact check'
        : false,
  },
  async (t) => {
    const packageDir = join(profileDir, 'node_modules', 'dsh-reliability-guard')
    assert.ok(existsSync(packageDir), `the profile does not contain an installed dsh-reliability-guard at ${packageDir}`)

    // 1. The bundle marker and patch are present in the INSTALLED copy.
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    assert.equal(manifest.name, 'dsh-reliability-guard')
    assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
    const patch = readFileSync(join(packageDir, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /id: reliability-guard/)
    for (const file of ['lib/index.js', 'locale/en.json', 'locale/zh.json', 'README.md', 'CHANGELOG.md', 'LICENSE']) {
      assert.ok(existsSync(join(packageDir, file)), `the tarball must ship ${file}`)
    }
    const enMeta = JSON.parse(readFileSync(join(packageDir, 'locale', 'en.json'), 'utf8')).meta
    const zhMeta = JSON.parse(readFileSync(join(packageDir, 'locale', 'zh.json'), 'utf8')).meta
    assert.equal(enMeta.title, 'Reliability Guard / 可靠性守卫')
    assert.equal(zhMeta.title, '可靠性守卫 / Reliability Guard')

    // 2. The profile really lists the bundle, so the loader would compose it.
    const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    assert.ok(
      profileManifest.dsh?.profile?.bundles?.includes('dsh-reliability-guard'),
      'the installed bundle must appear in dsh.profile.bundles',
    )

    // 3. Every peer the plugin declares is resolvable from the installation, so
    //    the real host can satisfy it.
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      const peerDir = join(installNodeModules, ...peer.split('/'))
      assert.ok(existsSync(peerDir), `declared peer ${peer} is not present in the DSH installation tree`)
    }

    // 4. The installed entry point imports and has the plugin face.
    const linked = linkMissingInto(join(profileDir, 'node_modules'), installNodeModules)
    t.after(() => {
      for (const path of linked) rmSync(path, { recursive: true, force: true })
    })
    const namespace = await import(pathToFileURL(join(packageDir, 'lib', 'index.js')).href)
    const plugin = unwrapExports(namespace)
    assert.equal(plugin.name, 'reliability-guard')
    assert.deepEqual([...plugin.inject], ['tools'])
    assert.equal(typeof plugin.apply, 'function')
    assert.equal(typeof plugin.Config, 'function', 'the installed Config schema must resolve')

    // 5. It activates on a real context, with the real prerequisite services.
    const ctx = new Context()
    ctx.provide('profileContext', { dir: profileDir })
    t.after(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(plugin, {})
    assert.equal(ctx.fiber.state, 2, 'the guard fiber must be ACTIVE, not withheld')
    const diagnosticsSchema = ctx.tools.schemas(undefined).find((schema) => schema.name === 'reliability_guard')
    assert.equal(
      diagnosticsSchema?.parameters?.type,
      'object',
      'the packed plugin must expose an object-root JSON Schema to model providers',
    )
    assert.equal(diagnosticsSchema?.parameters?.properties?.detail?.type, 'boolean')
    assert.equal(ctx.tools.schemas(undefined).find(s => s.name === 'reliability_guard_reconcile')?.parameters?.type, 'object')

    // 6. Its prompt section is really registered by the installed copy.
    const assembly = await ctx.systemPrompt.assemble({})
    assert.ok(
      assembly.sections.some((section) => section.name === 'reliability-guard:policy'),
      'the installed copy must register the policy section',
    )

    // 7. A real session drives the installed copy end to end: its diagnostics
    //    tool answers through the installed code path.
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('smoke-agent'), {}, { cwd: process.cwd() })
    deliverSessionEvent(
      ctx,
      agent,
      'assistant/message',
      assistantMessageData('Status.\nunknown: whether the smoke profile pins the expected version.\n'),
    )
    const result = await ctx.tools.execute({
      name: 'reliability_guard',
      callId: 'smoke-diagnostics',
      arguments: { detail: true },
      signal: new AbortController().signal,
      agent,
    })
    assert.equal(result.isError, false, 'the installed diagnostics tool must answer')
    const text = (result.content ?? []).map((part) => part.text).join('\n')
    assert.match(text, /reliability-guard diagnostics/)
    assert.match(text, /toolsRegistered: true/)
    assert.match(text, /"storage":"profile"/)
    assert.ok(ctx.tools.schemas(undefined).find(s => s.name === 'reliability_guard_reconcile').parameters.properties.action.enum.includes('resolve_failure'))
    assert.match(text, /smoke-agent/, 'the report must be scoped to the calling session')
    assert.ok(text.includes(`plugin version / 插件版本: ${manifest.version}`))

    // 8. Drive the packed plugin through a complete production loop, including
    // scheduler-owned context delivery. Probe tools do not execute commands.
    registerProbeTools(ctx)
    const adapter = new ScriptedAdapter([
      [tool('packed-change', 'pwsh', {
        command: 'git reset --hard HEAD~1',
        description: 'Rollback: recover from reflog. Verification: confirm with git log afterwards.',
      })],
      [tool('packed-review', 'subagent', { report: 'VERDICT: PASS\nChecked the result.' })],
      [tool('packed-verify', 'probe_test', { output: '5 passed, 0 failed' })],
      done,
    ])
    ctx.llm.registerAdapter(['scripted'], adapter)
    const loopAgent = await harness.create(SessionId('packed-loop'), { provider: 'scripted', model: 'local' }, { cwd: process.cwd() })
    const events = await runTurn(ctx, loopAgent)
    assertDeliveredOnce(events, adapter, 'review')
    assert.equal(adapter.requests.length, 4)

    // 9. Exercise the new deletion accounting through the installed artifact.
    if (process.platform === 'win32') {
      const fixture = await realFiles(t, {}, plugin)
      const deletion = new ScriptedAdapter([
        [tool('installed-write', 'write', { file_path: 'gone.txt', content: 'fixture' })],
        [tool('installed-read', 'read', { file_path: 'gone.txt' })],
        [tool('installed-delete', 'pwsh', { command: "$f='gone.txt'; Remove-Item -LiteralPath $f -Force", description: plan })],
        [tool('installed-absence', 'pwsh', { command: "$f='gone.txt'; Test-Path -LiteralPath $f" })],
        [tool('installed-review', 'subagent', { report: 'VERDICT: PASS' })],
        done,
      ])
      fixture.ctx.llm.registerAdapter(['scripted'], deletion)
      const deletionAgent = await fixture.harness.create(SessionId('packed-deletion'), { provider: 'scripted', model: 'local' }, { cwd: fixture.root })
      const installedState = await import(pathToFileURL(join(packageDir, 'lib', 'state.js')).href)
      const installedEvidence = await import(pathToFileURL(join(packageDir, 'lib', 'evidence.js')).href)
      const counts = []
      fixture.ctx.on('tools/result', exec => {
        if (!['installed-read', 'installed-delete', 'installed-absence'].includes(exec.callId)) return
        const current = installedState.sessionStatesOf(plugin, fixture.ctx).peek(deletionAgent.session)
        counts.push(new installedEvidence.EvidenceLedger(current).pendingMutations().length)
      })
      await runTurn(fixture.ctx, deletionAgent)
      assert.deepEqual(counts, [0, 1, 0], 'installed variable deletion must create, then close a real pending mutation')
      const state = installedState.sessionStatesOf(plugin, fixture.ctx).peek(deletionAgent.session)
      const ledger = new installedEvidence.EvidenceLedger(state)
      assert.equal(ledger.pendingMutations().length, 0)
      assert.equal(ledger.summary().staleFiles, 0)
      assert.equal(state.unexplainedFailures.length, 0)
      assert.equal(state.review.verdict.verdict, 'PASS')
      const recovery = new ScriptedAdapter([
        [tool('recovery-write', 'write', { file_path: 'recover.txt', content: 'fixture' })],
        [tool('recovery-delete', 'pwsh', { command: "$f=Join-Path . 'recover.txt'; Remove-Item $f", description: plan })],
        [tool('recovery-scope', 'reliability_guard_reconcile', { action: 'declare_targets', call_seq: 2, targets: [{ path: 'recover.txt', expected: 'absent' }], reason: 'The original command joined cwd with recover.txt; this is the full affected scope.' })],
        [tool('recovery-verify', 'pwsh', { command: 'Get-ChildItem -LiteralPath . -Force' })],
        [tool('recovery-review', 'subagent', { report: 'VERDICT: PASS' })], done,
      ])
      fixture.ctx.llm.registerAdapter(['recovery'], recovery)
      const recoveryAgent = await fixture.harness.create(SessionId('packed-recovery'), { provider: 'recovery', model: 'local' }, { cwd: fixture.root })
      await runTurn(fixture.ctx, recoveryAgent)
      const recovered = installedState.sessionStatesOf(plugin, fixture.ctx).peek(recoveryAgent.session)
      assert.equal(recovered.unresolvedMutationCount, 0)
      assert.equal(new installedEvidence.EvidenceLedger(recovered).pendingMutations().length, 0)
      assert.ok(recovered.unresolvedMutations[0].resolvedAt > recovered.unresolvedMutations[0].declaredAt)
    }
  },
)

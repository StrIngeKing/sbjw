/**
 * Deterministic mutation-risk classification and the approval seam.
 *
 * The classifier is what keeps the guard out of the way of normal work and in
 * front of irreversible work, so it is tested as a table: read-only tools stay
 * LOW, every destructive family is named with its `action`, and the workspace
 * root decides whether a command can damage the machine or only the repository.
 *
 * The pipeline half of this file pins the fail-closed path: a CRITICAL call with
 * no stated plan carries a `{kind:'ask'}` verdict, and the official registry
 * resolves that ask through the approval seam — which, with no answerer
 * composed, is a denial. The last test mounts the shipped approval service to
 * prove the wording of that refusal comes from the official seam and not from
 * the guard.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SESSION_STATES, sessionStatesOf } from '../lib/state.js'
import * as Guard from '../lib/index.js'
import {
  classifyRisk,
  detectRollbackIntent,
  detectRollbackSignal,
  detectVerificationIntent,
  statedPlanOf,
} from '../lib/risk.js'
import { mountGuardHarness, callTool, createAgent, resultText, appendSessionEvent } from './helpers/harness.js'

const states = (ctx) => sessionStatesOf(Guard.default, ctx)
const bucket = (agent) => states().peek(agent.session)
const shell = (command, workspaceRoot) =>
  classifyRisk({ toolName: 'pwsh', args: { command }, ...(workspaceRoot === undefined ? {} : { workspaceRoot }) })

test('read-only tools never rise above LOW', () => {
  for (const toolName of ['read', 'grep', 'web_fetch']) {
    // Even arguments that look destructive cannot move a read-only tool: the
    // tool cannot act on them, and blocking exploration is the failure mode
    // this guard exists to avoid.
    const verdict = classifyRisk({ toolName, args: { file_path: '/etc/shadow', pattern: 'rm -rf /', url: 'https://x' } })
    assert.equal(verdict.risk, 'LOW', `${toolName} only reads`)
    assert.equal(verdict.action, 'read')
    assert.equal(verdict.ruleId, 'read-only')
    assert.equal(verdict.reversible, true)
    assert.equal(verdict.mutation, 'never')
  }
})

test('each destructive family is classified with its action and level', () => {
  const table = [
    ['rm -rf /', 'HIGH', 'delete'],
    ['Remove-Item -Recurse -Force C:\\Windows', 'CRITICAL', 'delete'],
    ['git reset --hard', 'HIGH', 'vcs-discard'],
    ['DROP TABLE t', 'CRITICAL', 'database'],
    ['alembic upgrade head', 'CRITICAL', 'migration'],
    ['npm install left-pad', 'HIGH', 'dependency'],
    ['git config --global user.name x', 'HIGH', 'system-config'],
    ['chmod -R 777 /', 'HIGH', 'permission'],
    ['npm publish', 'HIGH', 'publish'],
    ['kubectl apply -f x.yaml', 'HIGH', 'publish'],
    ['Set-ExecutionPolicy Bypass', 'HIGH', 'system-config'],
    ['format-volume', 'CRITICAL', 'system-config'],
    ['echo hi', 'LOW', 'read'],
  ]
  for (const [command, risk, action] of table) {
    const verdict = shell(command)
    assert.equal(verdict.risk, risk, `"${command}" must be ${risk}`)
    assert.equal(verdict.action, action, `"${command}" must be classified as ${action}`)
  }
})

test('the workspace root decides whether a delete can damage the machine', () => {
  const inside = shell('rm -rf /repo/build', '/repo')
  assert.equal(inside.risk, 'HIGH', 'a delete inside the workspace can be undone from version control')
  assert.notEqual(inside.risk, 'CRITICAL')
  assert.equal(inside.action, 'delete')
  assert.equal(inside.scope, 'path')
  assert.equal(inside.reversible, false, 'the call states no rollback, so it is not reversible by itself')

  const outside = shell('rm -rf /repo/build', '/somewhere/else')
  assert.equal(outside.risk, 'CRITICAL')
  assert.equal(outside.scope, 'outside', 'the same bytes outside the root are a machine-level action')

  assert.equal(shell('rm -rf /var/lib/data', '/repo').risk, 'CRITICAL')
  assert.equal(shell('Remove-Item -Recurse -Force C:\\Windows', '/repo').risk, 'CRITICAL')

  // The platform temp root is part of the allowed boundary (the official
  // sandbox permits it), so scratch work there is not a machine-level action.
  assert.equal(shell('rm -rf /tmp/build', '/repo').risk, 'HIGH')
  assert.equal(shell('rm -rf /tmp/build', '/repo').scope, 'path')

  // A relative path belongs to the session's working directory whatever that
  // directory is, so it can never be proven to be outside the workspace. Failing
  // a relative path closed made `Set-Content out.txt` look like a machine-level
  // action, which put the approval prompt in front of every ordinary edit.
  const relative = shell('rm -rf ./build', '/repo')
  assert.equal(relative.risk, 'HIGH', 'a relative target is workspace-scoped, not machine-level')
  assert.equal(relative.scope, 'path')
  // An absolute path outside the root is still the worst case.
  assert.equal(shell('rm -rf /srv/other/build', '/repo').risk, 'CRITICAL')
  assert.equal(shell('rm -rf /srv/other/build', '/repo').scope, 'outside')
  // With no root to compare against, the same command is workspace-scoped.
  const unscopedRelative = shell('rm -rf ./build')
  assert.equal(unscopedRelative.risk, 'HIGH')
  assert.equal(unscopedRelative.scope, 'path')
})

test('detectRollbackSignal recognises the undo path a command carries', () => {
  assert.equal(detectRollbackSignal('Copy-Item a b.bak'), 'backup-copy')
  assert.equal(detectRollbackSignal('git stash'), 'git-stash')
  assert.equal(detectRollbackSignal('git commit -m "checkpoint"'), 'git-commit')
  assert.equal(detectRollbackSignal('git revert HEAD'), 'git-revert')
  assert.equal(detectRollbackSignal('Remove-Item x -ToRecycleBin'), undefined)
  assert.equal(detectRollbackSignal('sed -i s/a/b/ file'), undefined, 'an in-place edit states no undo path')
})

test(
  'a dry run downgrades a destructive command to MEDIUM',
  {
  },
  () => {
    assert.equal(detectRollbackSignal('Remove-Item -Recurse -Force /repo/build -WhatIf'), 'dry-run')
    assert.equal(detectRollbackSignal('npm publish --dry-run'), 'dry-run')
    // A dry run cannot change state, so it must not be routed to approval.
    const verdict = shell('Remove-Item -Recurse -Force /repo/build -WhatIf', '/repo')
    assert.equal(verdict.risk, 'MEDIUM')
    assert.equal(verdict.ruleId, 'recursive-delete:dry-run')
    assert.equal(verdict.reversible, true)
    assert.equal(verdict.mutation, 'never')
  },
)

test('a stated plan is read from every key an agent may use', () => {
  assert.equal(statedPlanOf({ justification: 'a', plan: 'c', note: ' b ', ignored: 'd' }), 'a c b')
  assert.equal(statedPlanOf({ description: 'deploy the fix' }), 'deploy the fix')
  assert.equal(statedPlanOf({ justification: '   ', description: '' }), '', 'blank plans are not plans')
  assert.equal(statedPlanOf({}), '')
  assert.equal(statedPlanOf(null), '', 'argument sniffing must be total')
  assert.equal(statedPlanOf('deploy'), '')
})

test('rollback and verification intent are detected independently', () => {
  assert.equal(detectRollbackIntent('Rollback: restore the pre-migration dump.'), 'explicit')
  assert.equal(detectRollbackIntent('This appends only; additive change.'), 'additive-only')
  assert.equal(detectRollbackIntent('We take a snapshot first.'), 'snapshot')
  assert.equal(detectRollbackIntent('Just do it.'), undefined)

  assert.equal(detectVerificationIntent('run node --test afterwards'), 'test')
  assert.equal(detectVerificationIntent('typecheck it with tsc'), 'typecheck')
  assert.equal(detectVerificationIntent('lint the changed files'), 'lint')
  assert.equal(detectVerificationIntent('verify the result'), 'rerun')
  assert.equal(detectVerificationIntent('re-read the file afterwards'), 're-read')
  assert.equal(detectVerificationIntent('probe the health endpoint'), 'health')
  assert.equal(detectVerificationIntent('looks fine'), undefined)
})

test('a CRITICAL call with no stated plan is denied because no approval channel exists', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'risk-ask')

  // The testkit composes no approval service, which is exactly the deployment
  // the official registry documents: `ask` degrades to `deny`.
  assert.equal(probe.ctx.get('approval'), undefined)

  const denied = await callTool(probe.ctx, 'pwsh', { command: 'DROP TABLE t' }, { agent })
  assert.equal(denied.isError, true)
  const reason = denied.error.message
  assert.match(reason, /Cyber Internal Affairs: CRITICAL risk \(destructive SQL/)
  assert.match(reason, /missing: rollback \+ verification/)
  assert.match(reason, /Approve only if you accept this change without a stated rollback or verification plan/)
  assert.equal(denied.error.info, undefined, 'the deny comes from the registry degrade, not from a guard rule')

  const state = bucket(agent)
  assert.equal(state.counters.asked, 1, 'the call must have been routed to approval')
  assert.equal(state.counters.deniedHighRisk, 0)
  assert.match(resultText(denied), /^Error: Cyber Internal Affairs: CRITICAL risk/)
})

test('the same CRITICAL call is allowed when it states a rollback and a verification plan', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'risk-planned')

  const allowed = await callTool(
    probe.ctx,
    'pwsh',
    {
      command: 'DROP TABLE t',
      description: 'Rollback: restore the pre-migration dump with psql and git checkout. Verification: run node --test and re-read the schema.',
    },
    { agent },
  )
  assert.equal(allowed.isError, false)
  // The tool output leads the content; the guard appends its own notice after
  // it, so this asserts the call ran rather than that nothing was injected.
  assert.match(resultText(allowed), /^ran: DROP TABLE t/)
  const state = bucket(agent)
  assert.equal(state.counters.asked, 0, 'a call with a stated plan must not be routed to approval')
  assert.equal(state.highRiskCalls, 1)
})

test('a HIGH-risk call without a plan is refused with the guard\'s own machine code', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'risk-high')

  const denied = await callTool(probe.ctx, 'pwsh', { command: 'rm -rf ./build' }, { agent })
  assert.equal(denied.isError, true)
  assert.equal(denied.error.info.code, 'SBJW_RISK')
  const reason = denied.error.message
  assert.match(reason, /Cyber Internal Affairs refused this HIGH-risk call/)
  assert.match(reason, /recursively deletes a directory tree/)
  assert.match(reason, /Missing before this can run: rollback and verification/)
  assert.match(reason, /Scope: path \(workspace root: /)
  assert.match(reason, /Then repeat the call with that plan in its `justification`/)

  const state = bucket(agent)
  assert.equal(state.counters.deniedHighRisk, 1)
  assert.match(probe.logger.at('warn').join('\n'), /sbjw: denied: HIGH risk/)
})

test('the shipped approval service denies when no answerer is attached', async (t) => {
  const { default: ApprovalService } = await import('@deepseek-ai/dsh-user-approval')
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  await probe.ctx.plugin(ApprovalService, {})
  const agent = await createAgent(probe.harness, 'risk-approval-service')

  // The audit pair the service writes must be turn-enclosed, so the call has to
  // happen inside an open turn — which is what the real loop always provides.
  appendSessionEvent(agent, 'turn/start', {})

  const denied = await callTool(probe.ctx, 'pwsh', { command: 'DROP TABLE t' }, { agent })
  assert.equal(denied.isError, true)
  assert.equal(denied.error.message, 'tool "pwsh" requires approval, but no approval channel is available')

  const types = []
  for (let seq = 0; seq < agent.session.seq; seq += 1) types.push(agent.session.eventAt(seq)?.type)
  assert.ok(types.includes('approval/asked'), 'the ask must be audited before the decision')
  assert.ok(types.includes('approval/decided'), 'the outcome must be audited after the decision')
})

test('disabling both plan requirements lets the same call through', async (t) => {
  const probe = await mountGuardHarness({ config: { risk: { requireRollbackPlan: false, requireVerificationPlan: false } } })
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'risk-plans-off')

  const allowed = await callTool(probe.ctx, 'pwsh', { command: 'DROP TABLE t' }, { agent })
  assert.equal(allowed.isError, false)
  assert.match(resultText(allowed), /^ran: DROP TABLE t/)
  const state = bucket(agent)
  assert.equal(state.counters.asked, 0)
  assert.equal(state.counters.deniedHighRisk, 0)
  assert.equal(state.highRiskCalls, 1, 'the risk is still classified and counted')
})

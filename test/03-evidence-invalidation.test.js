/**
 * Evidence invalidation.
 *
 * The ledger exists so a conclusion cannot outlive the state it was drawn from.
 * These tests prove that property twice over: through the real tool pipeline (a
 * write, a read, and a second write of the same path, observed through the
 * published session-state registry), and directly against `EvidenceLedger` for
 * the comparisons a pipeline of test doubles cannot stage on its own — a file
 * that disappears, and an in-place rewrite whose filesystem version never
 * changed.
 *
 * The last case is the whole reason the ledger keeps a content digest: the
 * official `FsVersion` (device, inode, size, mtime) is identical after an
 * external same-size rewrite, so a version-only guard reports "fresh" about
 * bytes that are already stale.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SESSION_STATES, createSessionState, sessionStatesOf } from '../lib/state.js'
import { EvidenceLedger } from '../lib/evidence.js'
import * as Guard from '../lib/index.js'
import { mountGuardHarness, callTool, createAgent } from './helpers/harness.js'

const states = (ctx) => sessionStatesOf(Guard.default, ctx)
const bucket = (agent) => states().peek(agent.session)

/** A version observation shaped like the official `ctx.fs.stat` result. */
const present = (version, overrides = {}) => ({ version, size: 12, type: 'file', ...overrides })

test('writing the same path again overturns the observation it replaced', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'evidence-overturn')
  const path = '/tmp/ledger-overturn.txt'

  const written = await callTool(probe.ctx, 'write', { file_path: path, content: 'version one' }, { agent })
  assert.equal(written.isError, false)
  const state = bucket(agent)
  const first = state.evidence.get(path)
  assert.ok(first, 'a recognised file writer must leave an observation of the path it wrote')
  assert.equal(first.kind, 'path-only')
  assert.equal(first.stale, false)
  assert.equal(typeof first.digest, 'string', 'the call carries the new content, so the record can be fingerprinted')
  assert.equal(first.observedAt, 1)

  // The read is recorded as a call, but it is classified as a possible mutation
  // rather than a definite one, so it must not overturn an observation: only
  // observed state changes invalidate evidence.
  const read = await callTool(probe.ctx, 'probe_read', { file_path: path }, { agent })
  assert.equal(read.isError, false)
  assert.deepEqual(
    state.calls.map((call) => call.toolName),
    ['write', 'probe_read'],
    'the ledger must record the read as a call',
  )
  assert.equal(first.stale, false, 'a read does not change the file')

  // The same path written again: the observation a conclusion rested on is now
  // unsupported, so it is marked stale rather than silently replaced.
  const rewritten = await callTool(probe.ctx, 'write', { file_path: path, content: 'version two' }, { agent })
  assert.equal(rewritten.isError, false)
  assert.equal(state.seq, 3)
  assert.equal(first.stale, true)
  assert.equal(first.invalidatedBy, 'this session changed the file')

  const overturned = state.overturned.filter((item) => item.path === path)
  assert.equal(overturned.length, 1, 'the overturn must be recorded once, with its cause')
  assert.equal(overturned[0].at, 3)
  assert.equal(overturned[0].reason, 'this session changed the file')

  const second = state.evidence.get(path)
  assert.notEqual(second, first, 'the live record is the new observation')
  assert.equal(second.stale, false)
  assert.notEqual(second.digest, first.digest, 'different content must produce a different digest')

  const ledger = new EvidenceLedger(state)
  const digest = ledger.digest()
  assert.match(digest, /conclusions overturned by later evidence: 1/)
  assert.match(digest, new RegExp(`${path}: this session changed the file`))

  // A different path is untouched by that overturn.
  await callTool(probe.ctx, 'write', { file_path: '/tmp/ledger-other.txt', content: 'unrelated' }, { agent })
  assert.equal(state.evidence.get('/tmp/ledger-other.txt').stale, false)
  assert.equal(state.evidence.get(path), second, 'the live record of the first path must survive another write')
})

test('an official file observation invalidates a record that is still in the ledger', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'evidence-fs-event')
  const state = bucket(agent)
  const ledger = new EvidenceLedger(state)
  const watched = '/tmp/ledger-watched.txt'

  // A real execution object is the actor the official fs tools pass when they
  // announce an observation (`ctx.emit('fs/observed', target, observation,
  // exec)`), so the event is captured from a real call rather than made up.
  let actor
  probe.ctx.on('tools/post-execute', (exec, result, next) => {
    actor = exec
    return next()
  })
  await callTool(probe.ctx, 'write', { file_path: '/tmp/ledger-actor.txt', content: 'x' }, { agent })
  assert.ok(actor, 'the harness must expose the real execution object as the actor')

  // The testkit mounts no fs service, so the `fs/observed` event the official
  // fs plugin would emit is delivered directly. Everything on the receiving
  // side — the guard's handler, the ledger, the session bucket — is real.
  //
  // A stat result (`version`/`size`/`type`) is not the event payload: the event
  // carries an observation (`kind: 'present' | 'absent'`), which is what the
  // guard branches on.
  const record = ledger.observe(watched, present('v1'))
  probe.ctx.emit('fs/observed', watched, { kind: 'present', version: 'v2' }, actor)
  assert.equal(record.stale, true)
  assert.equal(record.invalidatedBy, 'another actor changed the file after it was read')
  assert.equal(state.evidence.get(watched).stale, true, 'the stale record stays in the ledger so the digest can report it')

  const digest = ledger.digest()
  assert.match(digest, /stale observations \(re-read before relying on them\): 1/)
  assert.match(digest, new RegExp(`${watched}: another actor changed the file after it was read`))

  // An absence observed by anyone invalidates the observation of a file that
  // was there: "gone" is a state change like any other.
  const removed = '/tmp/ledger-removed.txt'
  const removedRecord = ledger.observe(removed, present('v1'))
  probe.ctx.emit('fs/observed', removed, { kind: 'absent' }, actor)
  assert.equal(removedRecord.stale, true)
  assert.equal(removedRecord.invalidatedBy, 'the file was observed as absent')

  // A path the ledger never observed must not become an observation just
  // because someone looked at it.
  probe.ctx.emit('fs/observed', '/tmp/ledger-never-observed.txt', { kind: 'present', version: 'v9' }, actor)
  assert.equal(state.evidence.has('/tmp/ledger-never-observed.txt'), false)
})

test('compare() answers unobserved, fresh and changed against a stored version', () => {
  const state = createSessionState('unit-compare')
  const ledger = new EvidenceLedger(state)
  const target = '/unit/compare.txt'

  assert.deepEqual(ledger.compare(target, present('v1')), { status: 'unobserved' })

  const record = ledger.observe(target, present('v1'))
  assert.equal(record.stale, false)
  assert.deepEqual(ledger.compare(target, present('v1')), { status: 'fresh' })

  const changed = ledger.compare(target, present('v2'))
  assert.equal(changed.status, 'changed')
  assert.match(changed.reason, /version changed/)
  assert.equal(record.stale, true)
  assert.equal(record.invalidatedBy, 'filesystem version changed')
  assert.deepEqual(state.overturned, [{ path: target, at: 0, reason: 'filesystem version changed' }])
})

test('an in-place rewrite with an unchanged version is caught only by the digest', () => {
  // Same path, same FsVersion, different bytes: the exact blind spot of a
  // version-only guard, produced by anything that rewrites a file without
  // changing its size — an external process, a restore, another agent.
  const state = createSessionState('unit-digest')
  const ledger = new EvidenceLedger(state)
  const target = '/unit/rewrite.txt'
  const record = ledger.observe(target, present('v1'), { digest: 'aaaa' })

  assert.deepEqual(ledger.compare(target, present('v1'), { digest: 'aaaa' }), { status: 'fresh' })

  const changed = ledger.compare(target, present('v1'), { digest: 'bbbb' })
  assert.equal(changed.status, 'changed')
  assert.match(changed.reason, /without a version change/)
  assert.equal(record.stale, true)
  assert.equal(record.invalidatedBy, 'content digest changed')

  // The same comparison with sampling disabled is what the official
  // version-only identity reports: fresh, because nothing it can see changed.
  const versionOnlyState = createSessionState('unit-digest-off')
  const versionOnly = new EvidenceLedger(versionOnlyState, { samples: false })
  versionOnly.observe(target, present('v1'), { digest: 'aaaa' })
  assert.deepEqual(versionOnly.compare(target, present('v1'), { digest: 'bbbb' }), { status: 'fresh' })
  assert.equal(versionOnlyState.overturned.length, 0)
})

test('an observation is invalidated when the file disappears', () => {
  const state = createSessionState('unit-absent')
  const ledger = new EvidenceLedger(state)
  const target = '/unit/gone.txt'
  const record = ledger.observe(target, present('v1'))

  const missing = ledger.compare(target, undefined)
  assert.equal(missing.status, 'changed')
  assert.equal(missing.reason, 'the file no longer exists')
  assert.equal(record.stale, true)
  assert.equal(record.invalidatedBy, 'the file no longer exists')

  // Re-observing an absence is itself an overturn: the record says the file was
  // there, and the newest evidence says it is not.
  const absent = ledger.observe(target, undefined)
  assert.equal(absent.kind, 'absent')
  assert.equal(
    state.overturned.at(-1).reason,
    're-read: now absent',
    'the ledger must say why the earlier conclusion stopped holding',
  )
})

test('re-observing a different version records the overturn reason', () => {
  const state = createSessionState('unit-reread')
  const ledger = new EvidenceLedger(state)
  const target = '/unit/reread.txt'
  ledger.observe(target, present('v1'))

  const second = ledger.observe(target, present('v2'))
  assert.equal(second.stale, false)
  assert.equal(state.overturned.length, 1)
  assert.equal(state.overturned[0].reason, 're-read: version changed')
})

test('the ledger is bounded, evicting the least recently observed record', () => {
  const state = createSessionState('unit-bounded')
  const ledger = new EvidenceLedger(state, { maxRecords: 8 })
  const at = (index) => `/unit/bounded-${index}.txt`

  for (let index = 0; index < 12; index += 1) ledger.observe(at(index), present(`v${index}`))
  assert.equal(ledger.size, 8, 'the ledger must not grow without bound')
  assert.equal(state.evidenceOrder.length, 8)
  assert.equal(state.evidence.has(at(0)), false)
  assert.equal(state.evidence.has(at(3)), false)
  assert.equal(state.evidence.has(at(4)), true)
  assert.equal(state.evidence.has(at(11)), true)

  // Re-observing an old record makes it the most recent, so the next insertion
  // evicts a different key. Otherwise a long session would forget exactly the
  // files it is still working on.
  ledger.observe(at(4), present('v4-again'))
  ledger.observe('/unit/bounded-new.txt', present('v-new'))
  assert.equal(ledger.size, 8)
  assert.equal(state.evidence.has(at(5)), false)
  assert.equal(state.evidence.has(at(4)), true)
  assert.equal(state.evidence.has('/unit/bounded-new.txt'), true)
})

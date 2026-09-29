import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SESSION_STATES, sessionStatesOf } from '../lib/state.js'
import * as Guard from '../lib/index.js'
import { parseReviewVerdict, renderReviewPrompt } from '../lib/verification.js'
import { mountGuardHarness, callTool, createAgent, guardNotices, messageText } from './helpers/harness.js'

const states = (ctx) => sessionStatesOf(Guard.default, ctx)
const bucket = (agent) => states().peek(agent.session)

/** A high-risk call that states a rollback and a verification plan, so only the review gate applies. */
const HIGH_RISK_CALL = {
  command: 'git reset --hard HEAD~1',
  description: 'Discard the last commit. Rollback: the commit is recoverable from reflog. Verification: confirm with git log afterwards.',
}

test('a high-risk change requests an independent review before completion', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'review-required')

  const result = await callTool(probe.ctx, 'pwsh', HIGH_RISK_CALL, { agent })
  const notices = guardNotices(result)
  const review = notices.find((notice) => notice.tag === 'review')
  assert.ok(review, 'a HIGH-risk change must request a review')

  // The request is a fresh-context review prompt: it carries the requirement,
  // the state, the diff hint and the verification results, and it explicitly
  // forbids leaning on the author's reasoning.
  assert.match(review.text, /independent review/i)
  assert.match(review.text, /Original requirement/)
  assert.match(review.text, /Current state/)
  assert.match(review.text, /Observed change/)
  assert.match(review.text, /Verification results already produced/)
  assert.match(review.text, /must not ask for it/)
  assert.match(review.text, /VERDICT: PASS/)
  assert.match(review.text, /VERDICT: FAIL/)

  // Registry execution returns the request; the loop owns subsequent delivery.
  assert.equal(agent.inbox.nextStep.length, 0)
  assert.equal(bucket(agent).review.required, true)
  assert.equal(bucket(agent).review.round, 1)
})

test('a reviewer PASS clears the review gate', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'review-pass')

  await callTool(probe.ctx, 'pwsh', HIGH_RISK_CALL, { agent })
  const reviewed = await callTool(
    probe.ctx,
    'subagent',
    { report: 'VERDICT: PASS\n\nI checked the three paths that could regress and found no counterexample. The rollback claim is supported by the reflog output shown above.' },
    { agent },
  )
  assert.equal(reviewed.isError, false)
  assert.equal(bucket(agent).review.verdict.verdict, 'PASS')
  assert.equal(bucket(agent).review.verdict.reason, 'the reviewer found no counterexample')
  assert.equal(bucket(agent).counters.reviewsPassed, 1)

  // A PASS must not queue another review request.
  const next = await callTool(probe.ctx, 'probe_echo', { text: 'reporting the result' }, { agent })
  assert.deepEqual(
    guardNotices(next).filter((notice) => notice.tag === 'review'),
    [],
  )
})

test('a reviewer FAIL keeps the gate closed and returns the work to the executor', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'review-fail')

  await callTool(probe.ctx, 'pwsh', HIGH_RISK_CALL, { agent })
  const verdict = await callTool(
    probe.ctx,
    'subagent',
    { report: 'VERDICT: FAIL\n\n1. `git reset --hard` also discards the working tree, and the stated rollback covers only the commit.\n2. No verification was run after the reset.' },
    { agent },
  )
  assert.equal(bucket(agent).review.verdict.verdict, 'FAIL')
  assert.equal(bucket(agent).counters.reviewsFailed, 1)

  // maxRounds defaults to 2, so the FAIL returns the work immediately: the
  // verdict result itself carries the round-two request, and the executor does
  // not get a step in which it could report failure as completion.
  const reviews = guardNotices(verdict).filter((notice) => notice.tag === 'review')
  assert.equal(reviews.length, 1, 'the verdict result carries the round-two request, replacing the answered one')
  assert.equal(bucket(agent).review.round, 2)
  assert.match(reviews[0].text, /Independent review round 2/i)
  assert.match(reviews[0].text, /VERDICT: PASS/)
  assert.equal(bucket(agent).counters.reviewsRequested, 2)
})

test('the review round budget stops the mutual-review loop', async (t) => {
  const probe = await mountGuardHarness({ config: { review: { maxRounds: 2 } } })
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'review-capped')

  await callTool(probe.ctx, 'pwsh', HIGH_RISK_CALL, { agent })
  const failing = { report: 'VERDICT: FAIL\n\nStill missing: the working-tree files removed by the reset are not recoverable.' }
  await callTool(probe.ctx, 'subagent', failing, { agent })
  assert.equal(bucket(agent).review.round, 2)
  assert.equal(bucket(agent).review.cappedOut, false)

  // Round two answers with another FAIL: the budget is spent, so no third
  // request is staged.
  const secondFail = await callTool(probe.ctx, 'subagent', failing, { agent })
  assert.deepEqual(
    guardNotices(secondFail).filter((notice) => notice.tag === 'review'),
    [],
    'the budget must stop a third review request',
  )
  assert.equal(bucket(agent).review.cappedOut, true)
  assert.equal(bucket(agent).counters.reviewsCappedOut, 1)
  assert.equal(bucket(agent).counters.reviewsRequested, 2)

  // The unresolved finding is still reported: the anti-loop bound must not turn
  // a failed review into a silent pass.
  const after = await callTool(probe.ctx, 'probe_echo', { text: 'final' }, { agent })
  assert.deepEqual(
    guardNotices(after).filter((notice) => notice.tag === 'review'),
    [],
  )
  const gate = guardNotices(after).find((notice) => notice.tag === 'completion-gate')
  assert.ok(gate, 'the capped review must still surface through the completion gate')
  assert.match(gate.text, /reviewer|FAIL/i)
})

test('a reviewer report without an explicit verdict counts as FAIL', () => {
  const unparseable = parseReviewVerdict('The change looks reasonable to me. I did not find anything obviously wrong.')
  assert.equal(unparseable.verdict, 'FAIL', 'an unreadable review is not evidence of correctness')
  assert.match(unparseable.reason, /did not state a parseable/)

  const explicit = parseReviewVerdict('VERDICT: PASS\nNo counterexample found.')
  assert.equal(explicit.verdict, 'PASS')
})

test('the review prompt never forwards the executor explanation', () => {
  const prompt = renderReviewPrompt({
    requirement: 'Fix the failing test in parser.js',
    currentState: 'parser.js edited, 1 file changed',
    diff: 'diff --git a/parser.js b/parser.js',
    verification: 'test PASS via probe_test — 5 passing check(s) reported',
    risk: 'HIGH',
    round: 1,
  })
  assert.match(prompt, /find counterexamples, not to agree/)
  assert.match(prompt, /You have no access to the author's reasoning and must not ask for it/)
  assert.match(prompt, /VERDICT: PASS/)
  // The reviewer is told what to check, not what the author concluded.
  assert.doesNotMatch(prompt, /my reasoning|I decided|because I/i)
})

test('low-risk single-file work does not request a review', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'review-skip')
  const { join } = await import('node:path')
  const result = await callTool(probe.ctx, 'write', { file_path: join(process.cwd(), 'note.txt'), content: 'x' }, { agent })
  assert.deepEqual(
    guardNotices(result).filter((notice) => notice.tag === 'review'),
    [],
    'highRiskOnly must keep ordinary edits free of review requests',
  )
  assert.equal(bucket(agent).counters.reviewsRequested, 0)
})

test('disabling review never requests one', async (t) => {
  const probe = await mountGuardHarness({ config: { review: { enabled: false } } })
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'review-off')
  const result = await callTool(probe.ctx, 'pwsh', HIGH_RISK_CALL, { agent })
  assert.deepEqual(guardNotices(result).filter((notice) => notice.tag === 'review'), [])
  assert.equal(bucket(agent).counters.reviewsRequested, 0)
})

test('the review request is a distinct, labelled context, never a user turn', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'review-labelled')
  const result = await callTool(probe.ctx, 'pwsh', HIGH_RISK_CALL, { agent })
  const staged = result.additionalContexts.find(message => message.source?.tag === 'review')
  assert.equal(staged.source.kind, 'reliability-guard')
  assert.equal(staged.source.form, 'notice')
  assert.equal(staged.source.tag, 'review')
  assert.match(messageText(staged), /Reliability Guard requires an independent review/)
})

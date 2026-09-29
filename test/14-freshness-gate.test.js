import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { consumeRetrieval, evaluateFreshness, findExternalClaims } from '../lib/freshness.js'
import { SESSION_STATES, sessionStatesOf } from '../lib/state.js'
import * as Guard from '../lib/index.js'
import {
  appendSessionEvent,
  assistantMessageData,
  callTool,
  createAgent,
  deliverSessionEvent,
  guardNotices,
  mountGuardHarness,
} from './helpers/harness.js'

const states = (ctx) => sessionStatesOf(Guard.default, ctx)
const TOPICS = ['version', 'release', 'compatib']

/** A response that states a version/compatibility fact without any retrieval. */
const CLAIM = 'DeepSeek Harness 0.1.8 is the latest release and its npm package is compatible with Node 20.'

/**
 * Register the shipped retrieval tool's name.
 *
 * The harness registers the guard's own probe family, and the freshness gate
 * keys on the real tool names (`web_search` / `web_fetch`), so the test supplies
 * the same contract the shipped catalog exposes. Without this the retrieval
 * could not be simulated at all.
 */
function registerRetrievalTools(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'web_search',
      description: 'Test double for the shipped retrieval tool.',
      parameters: { query: { type: 'string', required: true, description: 'Search query.' } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        return `results for ${args.query}`
      },
    }),
  )
}

test('an external version claim with no retrieval is an advisory freshness gap', () => {
  const verdict = evaluateFreshness({ text: CLAIM, topics: TOPICS, now: 1_000 })
  assert.equal(verdict.passed, false, 'an unretrieved external fact must not pass the gate')
  assert.equal(verdict.retrievalAgeMs, undefined, 'no retrieval exists, so there is no age to report')
  assert.equal(verdict.gaps.length, 1)
  assert.equal(verdict.gaps[0].category, 'freshness')
  // Advisory, never blocking: detection is lexical, so the only correct demand
  // is an honest label — a lexical false positive must not stop a turn.
  assert.equal(verdict.gaps[0].severity, 'advisory')

  // The gap names the matched marker and the exact claim, so the model can see
  // which sentence it has to back with a retrieval or label as unverified.
  assert.match(verdict.gaps[0].message, /matched "release"/)
  assert.match(verdict.gaps[0].message, /is the latest release/)
  assert.match(verdict.gaps[0].message, /no web_search or web_fetch result exists in this session/)
  assert.match(verdict.gaps[0].message, /label the statement as not freshly verified/)

  // The claim list is the evidence behind the gap, not a copy of the message.
  assert.ok(verdict.claims.length > 0)
  assert.equal(verdict.claims[0].marker, 'release')
})

test('a retrieval inside the freshness window passes the same claim', () => {
  const now = 1_000_000
  const verdict = evaluateFreshness({
    text: CLAIM,
    topics: TOPICS,
    retrievedTopics: ['deepseek harness latest release'],
    lastRetrievalAt: now - 5 * 60_000,
    now,
  })
  assert.equal(verdict.passed, true)
  assert.deepEqual(verdict.gaps, [])
  assert.equal(verdict.retrievalAgeMs, 5 * 60_000, 'the reported age is what makes the pass auditable')
  assert.ok(verdict.claims.length > 0, 'the claim is still reported: the gate approved it, it did not fail to see it')
})

test('a retrieval older than the window fails the claim again', () => {
  const now = 1_000_000
  const retrievedTopics = ['deepseek harness latest release']
  const verdict = evaluateFreshness({ text: CLAIM, topics: TOPICS, retrievedTopics, lastRetrievalAt: now - 31 * 60_000, now })
  assert.equal(verdict.passed, false, 'a stale retrieval is not evidence for a version claim')
  assert.match(verdict.gaps[0].message, /past the 30-minute freshness window/)
  assert.equal(verdict.retrievalAgeMs, 31 * 60_000)

  // The boundary is inclusive: exactly at the window the retrieval still counts,
  // and a shorter configured window moves the cutoff with it.
  assert.equal(
    evaluateFreshness({ text: CLAIM, topics: TOPICS, retrievedTopics, lastRetrievalAt: now - 30 * 60_000, now }).passed,
    true,
  )
  const shortWindow = evaluateFreshness({
    text: CLAIM,
    topics: TOPICS,
    retrievedTopics,
    lastRetrievalAt: now - 6 * 60_000,
    now,
    maxAgeMinutes: 5,
  })
  assert.equal(shortWindow.passed, false)
  assert.match(shortWindow.gaps[0].message, /past the 5-minute freshness window/)
})

test('a retrieval about a different subject does not answer the claim', () => {
  const now = 1_000_000
  // A fresh retrieval exists, but it is about something else, so the claim is
  // still unverified. Otherwise any search would launder every later statement.
  const verdict = evaluateFreshness({
    text: CLAIM,
    topics: TOPICS,
    retrievedTopics: ['postgres index bloat'],
    lastRetrievalAt: now - 60_000,
    now,
  })
  assert.equal(verdict.passed, false)
  assert.match(verdict.gaps[0].message, /about a different subject/)
})

test('a claim that already carries a staleness label is not flagged', () => {
  // The honesty path is the point of the gate: a statement the model has
  // already marked as not freshly verified needs no further correction.
  const honest = [
    'Version 2 is not freshly verified.',
    'As of my training, the latest release is 3.1.',
    'This release is unverified.',
    'I cannot confirm the current support matrix.',
    'No retrieval: the API version is assumed.',
  ]
  for (const text of honest) {
    const verdict = evaluateFreshness({ text, topics: TOPICS, now: 1_000 })
    assert.equal(verdict.passed, true, `an explicitly labelled statement must pass: ${text}`)
    assert.deepEqual(verdict.gaps, [], `no gap may be reported for: ${text}`)
  }
  assert.deepEqual(findExternalClaims(honest[0], TOPICS), [])
})

test('text without an external-fact marker is never flagged', () => {
  const local = 'I renamed the helper and reran the suite; the failure was in my own code.'
  assert.deepEqual(findExternalClaims(local, TOPICS), [])
  assert.deepEqual(evaluateFreshness({ text: local, topics: TOPICS, now: 1_000 }), { passed: true, gaps: [], claims: [] })

  // A clause shorter than the minimum is not a claim either, and empty text is
  // never a claim: the gate has to stay quiet on ordinary prose.
  assert.deepEqual(findExternalClaims('version', TOPICS), [])
  assert.deepEqual(findExternalClaims('', TOPICS), [])
  assert.deepEqual(evaluateFreshness({ text: '', topics: TOPICS, now: 1_000 }).claims, [])
})

test('consumeRetrieval records a topic for the retrieval tools only', () => {
  const recorded = []
  const record = (entry) => recorded.push(entry)

  assert.equal(consumeRetrieval('web_search', { query: 'Node 24 ESM' }, record), true)
  assert.deepEqual(recorded, [{ topic: 'node 24 esm', toolName: 'web_search' }], 'the query is normalized into a stable topic key')

  recorded.length = 0
  assert.equal(consumeRetrieval('web_fetch', { url: 'https://nodejs.org/api/esm.html' }, record), true)
  assert.deepEqual(recorded, [{ topic: 'nodejs.org/api/esm.html', toolName: 'web_fetch' }], 'a URL topic drops the scheme')

  // A fetch that also carries the originating query is relevant to both, which
  // is why one call may record two topics.
  recorded.length = 0
  assert.equal(consumeRetrieval('web_fetch', { url: 'https://a.b/c', query: 'Q' }, record), true)
  assert.deepEqual(recorded, [
    { topic: 'a.b/c', toolName: 'web_fetch' },
    { topic: 'q', toolName: 'web_fetch' },
  ])

  // A retrieval with no recognizable argument still counts as a retrieval; it
  // must never be silently ignored.
  recorded.length = 0
  assert.equal(consumeRetrieval('web_search', {}, record), true)
  assert.deepEqual(recorded, [{ topic: 'web_search', toolName: 'web_search' }])

  // Bound: one topic key can never be unbounded text.
  recorded.length = 0
  consumeRetrieval('web_search', { query: 'q'.repeat(200) }, record)
  assert.equal(recorded[0].topic.length, 160)

  // Everything that is not a retrieval records nothing.
  recorded.length = 0
  assert.equal(consumeRetrieval('probe_read', { file_path: '/tmp/x.txt' }, record), false)
  assert.equal(consumeRetrieval('write', { file_path: '/tmp/x.txt', content: 'x' }, record), false)
  assert.deepEqual(recorded, [])
})

test('the pipeline flags an assistant claim and the completion gate names it', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'freshness-flag')
  const bucket = states().peek(agent.session)

  // The durable session log is where the model's own statement lives, so the
  // event is delivered the way the session service delivers it.
  deliverSessionEvent(probe.ctx, agent, 'assistant/message', assistantMessageData(CLAIM))
  assert.ok(bucket.pendingFreshness, 'a statement relying on an unretrieved external fact must leave a pending gap')
  assert.equal(bucket.pendingFreshness.length, 1)
  assert.equal(bucket.pendingFreshness[0].category, 'freshness')
  assert.equal(bucket.counters.freshnessWarnings, 1, 'the warning is counted for diagnostics')

  // Reaching post-execute with any call is what carries the gap to the model.
  const result = await callTool(probe.ctx, 'probe_echo', { text: 'Here is my answer.' }, { agent })
  const notice = guardNotices(result).find((entry) => entry.tag === 'completion-gate')
  assert.ok(notice, 'the turn must be corrected before it can end on an unretrieved external fact')
  assert.match(notice.text, /This response states an externally controlled fact/)
  assert.match(notice.text, /is the latest release/, 'the notice must quote the claim, not only the policy')
  assert.match(notice.text, /Retrieve current information, or label the statement as not freshly verified/)
})

test('a retrieval inside the window clears the gap for the re-evaluated statement', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'freshness-clear')
  const bucket = states().peek(agent.session)
  registerRetrievalTools(probe.ctx)

  deliverSessionEvent(probe.ctx, agent, 'assistant/message', assistantMessageData(CLAIM))
  assert.ok(bucket.pendingFreshness, 'the claim starts out flagged')

  const search = await callTool(probe.ctx, 'web_search', { query: 'DeepSeek Harness latest release' }, { agent })
  assert.equal(search.isError, false, 'the retrieval itself must never be blocked')
  assert.equal(bucket.freshness.size, 1, 'the retrieval is recorded as a topic')
  const [topic, record] = [...bucket.freshness.entries()][0]
  assert.equal(topic, 'deepseek harness latest release', 'the query is the topic key')
  assert.equal(record.toolName, 'web_search')
  assert.ok(Number.isFinite(record.at), 'the topic record is timestamped, or the window cannot be evaluated per topic')
  assert.ok(Number.isFinite(bucket.lastRetrievalAt), 'the session marks a newest retrieval timestamp')
  assert.ok(bucket.lastRetrievalAt >= record.at, 'the newest-retrieval marker agrees with the recorded topic')

  // The retrieval answers the gap in the same call that found the information,
  // so the pending note is dropped immediately. Without this the correction
  // would still be delivered with its pre-retrieval wording ("no web_search or
  // web_fetch result exists in this session"), which is false by then.
  assert.equal(bucket.pendingFreshness, undefined, 'a retrieval clears the gap it answers')

  // The re-evaluated statement is backed by the retrieval inside the window.
  deliverSessionEvent(probe.ctx, agent, 'assistant/message', assistantMessageData(CLAIM))
  assert.equal(bucket.pendingFreshness, undefined, 'a retrieval inside the window now backs the claim, so no label is required')

  // A new turn resets the gate budget, and the next post-execute must find
  // nothing left to correct about freshness.
  appendSessionEvent(agent, 'turn/start', {})
  const after = await callTool(probe.ctx, 'probe_echo', { text: 'done' }, { agent })
  assert.deepEqual(
    guardNotices(after).filter((entry) => /freshly verified|externally controlled fact/.test(entry.text)),
    [],
    'the gate must not keep demanding a retrieval that now exists',
  )
  assert.equal(bucket.gate.lastPassed, true, 'the gate recorded that it re-evaluated and passed')
})

test('disabling the freshness gate turns off detection and retrieval recording', async (t) => {
  const probe = await mountGuardHarness({ config: { freshnessGate: { enabled: false } } })
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'freshness-off')
  const bucket = states().peek(agent.session)
  registerRetrievalTools(probe.ctx)

  deliverSessionEvent(probe.ctx, agent, 'assistant/message', assistantMessageData(CLAIM))
  assert.equal(bucket.pendingFreshness, undefined, 'a disabled gate must not flag anything')
  assert.equal(bucket.counters.freshnessWarnings, 0)

  await callTool(probe.ctx, 'web_search', { query: 'DeepSeek Harness latest release' }, { agent })
  assert.equal(bucket.freshness.size, 0, 'a disabled gate must not record retrievals either')
  assert.equal(bucket.lastRetrievalAt, undefined)

  const result = await callTool(probe.ctx, 'probe_echo', { text: 'reporting' }, { agent })
  assert.deepEqual(
    guardNotices(result).filter((entry) => /freshly verified|externally controlled fact/.test(entry.text)),
    [],
  )
})

// REFERENCE FINDING (not fixed here): findExternalClaims splits on `.`, so an
// honest label inside a sentence whose version contains a decimal point is
// truncated and the remaining clause is still flagged.
test('an honest label survives a version with a decimal point', () => {
  const verdict = evaluateFreshness({ text: 'Version 2.0 is not freshly verified.', topics: TOPICS, now: 1_000 })
  assert.equal(verdict.passed, true, 'a statement the model already labelled must not be flagged again')
  assert.deepEqual(verdict.gaps, [])
})

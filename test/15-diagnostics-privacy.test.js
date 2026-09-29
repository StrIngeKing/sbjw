import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, createConfigView, resolvePolicy } from '../lib/config.js'
import { DIAGNOSTICS_VERSION, buildDiagnostics, renderDiagnostics } from '../lib/diagnostics.js'
import { EvidenceLedger } from '../lib/evidence.js'
import { createSessionState, SESSION_STATES, sessionStatesOf } from '../lib/state.js'
import { preview, redactSecrets } from '../lib/util.js'
import * as Guard from '../lib/index.js'
import {
  callTool,
  createAgent,
  deliverSessionEvent,
  mountGuardHarness,
  resultText,
  userMessage,
} from './helpers/harness.js'

const states = (ctx) => sessionStatesOf(Guard.default, ctx)

/** A credential that must never survive into any diagnostic artifact. */
const SECRET = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx1234'
/** A distinctive request string, used to prove raw user text is never reported. */
const REQUEST_TEXT = 'ZEBRA-CONFIDENTIAL-REQUEST-9271'
/** Text that fills the recorded argument preview without being a credential. */
const BENIGN_PREVIEW = 'OPERATOR-NOTE-4711 rotate the deployment key'

const CREDENTIALS = [
  ['an OpenAI-style key', 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx1234'],
  ['a GitHub token', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
  ['an AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
  ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
]

/** Resolve the effective configuration exactly the way the plugin loader does. */
function liveConfig(overrides = {}) {
  const declared = Config(overrides)
  return { config: createConfigView(declared).live(), policy: resolvePolicy(declared) }
}

/** Build a report from a real session bucket, the way the diagnostics tool does. */
function reportFor(state, { detail = false, includeSensitiveContent = false } = {}) {
  const { config, policy } = liveConfig({ diagnostics: { includeSensitiveContent } })
  return buildDiagnostics({
    policy,
    config,
    state,
    ledger: new EvidenceLedger(state, { maxRecords: 200 }),
    sessionId: state.key,
    detail,
    includeSensitiveContent,
  })
}

/** A real session bucket that has recorded one call carrying a preview. */
function bucketWithCall(argumentsPreview) {
  const state = createSessionState('diagnostics-session')
  state.seq = 3
  state.calls.push({ at: 1, toolName: 'write', isError: false, risk: 'MEDIUM', argumentsPreview })
  state.mutatedFiles.add('/tmp/reported.txt')
  state.sessionMutatedFiles.add('/tmp/reported.txt')
  state.counters.preExecuteChecked = 3
  return state
}

test('credential-shaped values become a stable placeholder', () => {
  for (const [label, secret] of CREDENTIALS) {
    const text = `before ${secret} after`
    const redacted = redactSecrets(text)
    assert.doesNotMatch(redacted, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${label} must not survive redaction`)
    assert.match(redacted, /<redacted:[0-9a-f]{8}>/, `${label} must be replaced by a tagged placeholder`)
    // Only the credential is replaced: the operator still sees the sentence.
    assert.match(redacted, /^before /)
    assert.match(redacted, / after$/)
    // The placeholder is a function of the secret, not of the call: diagnostics
    // can group two sightings of the same secret without printing it.
    assert.equal(redactSecrets(text), redacted, `${label} must redact identically on a second call`)
    if (label === 'an OpenAI-style key') {
      assert.notEqual(redactSecrets(text), redactSecrets('before sk-proj-ZzYyXxWwVvUuTtSsRrQqPpOo1234 after'))
    }
  }
})

test('a private key block is replaced as one unit', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7Z\n-----END RSA PRIVATE KEY-----'
  const redacted = redactSecrets(`config before\n${pem}\nconfig after`)
  assert.doesNotMatch(redacted, /BEGIN RSA PRIVATE KEY/)
  assert.doesNotMatch(redacted, /MIIEowIBAAKCAQEA7Z/, 'the key body must not survive either')
  assert.match(redacted, /config before\n<redacted:[0-9a-f]{8}>\nconfig after/)
})

test('named credential fields keep the field name and lose the value', () => {
  // Keeping the name tells the operator which field leaked; the value is gone.
  assert.match(redactSecrets('password=hunter2'), /^password=<redacted:[0-9a-f]{8}>$/)
  assert.match(redactSecrets('api_key: "abc123def"'), /^api_key=<redacted:[0-9a-f]{8}>$/)
  assert.match(redactSecrets('secret=s3cr3t-value'), /^secret=<redacted:[0-9a-f]{8}>$/)
})

test('benign text is left byte-identical', () => {
  // The patterns must be bounded: ordinary words that merely start like a
  // credential are not secrets, and mangling them would corrupt diagnostics.
  const benign = 'The tokenizer splits identifiers; the keyboard shortcut is fine.'
  assert.equal(redactSecrets(benign), benign)
  assert.equal(redactSecrets('No credentials appear in this line.'), 'No credentials appear in this line.')

  // Two sightings of the same secret inside one string share one tag.
  const twice = redactSecrets(`a ${SECRET} b ${SECRET}`)
  const tags = twice.match(/<redacted:[0-9a-f]{8}>/g)
  assert.equal(tags.length, 2)
  assert.equal(tags[0], tags[1])
})

test('preview bounds long text and marks the omission', () => {
  const long = 'abcdefghij'.repeat(100)
  const bounded = preview(long, 100)
  assert.ok(bounded.length < long.length)
  assert.ok(bounded.startsWith(long.slice(0, 60)), 'the head is kept')
  assert.ok(bounded.endsWith(long.slice(-40)), 'the tail is kept')
  assert.ok(bounded.includes('(+900 chars)'), 'the omission is stated, so the reader knows text is missing')
  assert.equal(bounded.length, 116, 'head + marker + tail is the whole bound')
  assert.ok(!bounded.includes(long.slice(200, 300)), 'the omitted middle is really gone')

  assert.equal(preview('short', 100), 'short', 'text inside the cap is not decorated')
  assert.match(preview('x'.repeat(500)), /\(\+100 chars\)/, 'the default cap is 400 characters')
})

test('the default report contains no tool-argument content at all', () => {
  const state = bucketWithCall(`${SECRET} ${BENIGN_PREVIEW}`)
  const report = reportFor(state)
  assert.equal(Object.hasOwn(report, 'samples'), false, 'argument previews are opt-in, not opt-out')
  assert.equal(report.features.sensitiveContent, false)

  const serialized = JSON.stringify(report)
  assert.ok(!serialized.includes(SECRET), 'a credential must not be serialized into a default report')
  assert.ok(!serialized.includes(BENIGN_PREVIEW), 'no argument text may be serialized into a default report')
  const rendered = renderDiagnostics(report)
  assert.ok(!rendered.includes(SECRET))
  assert.ok(!rendered.includes(BENIGN_PREVIEW))
})

test('a secret in a recorded call preview still cannot leak into the rendered report', () => {
  // The bucket is deliberately hostile: it carries a raw credential in
  // `argumentsPreview`, as if an earlier layer had failed to redact it.
  const state = bucketWithCall(SECRET)
  const report = reportFor(state, { includeSensitiveContent: true })
  assert.equal(Object.hasOwn(report, 'samples'), true, 'the option enables bounded previews')
  assert.equal(report.samples.length, 1)
  assert.ok(!report.samples[0].argumentsPreview.includes(SECRET), 'redaction is mandatory even with sensitive content enabled')
  assert.match(report.samples[0].argumentsPreview, /<redacted:[0-9a-f]{8}>/)

  const rendered = renderDiagnostics(report)
  assert.ok(!rendered.includes(SECRET), 'the rendered text must not carry the credential')
  assert.ok(!JSON.stringify(report).includes(SECRET), 'neither may the structured report')
})

test('the report never contains the session raw request text', () => {
  const state = bucketWithCall(BENIGN_PREVIEW)
  state.requirement = REQUEST_TEXT
  const report = reportFor(state, { detail: true })
  assert.equal(Object.hasOwn(report, 'requirement'), false, 'the stored request is not a report field')
  assert.ok(!JSON.stringify(report).includes(REQUEST_TEXT), 'the request text must not appear anywhere in the report')
  assert.ok(!renderDiagnostics(report).includes(REQUEST_TEXT))
})

test('renderDiagnostics reports a bounded, counter-only snapshot', () => {
  const state = bucketWithCall(BENIGN_PREVIEW)
  state.counters.stallsBlocked = 0
  state.counters.gateInjections = 2
  const report = reportFor(state)
  assert.equal(report.version, DIAGNOSTICS_VERSION)
  const rendered = renderDiagnostics(report)
  assert.match(rendered, /^sbjw diagnostics v1 \(/)
  assert.match(rendered, /mode: balanced — identical-repeat block at 5/)
  assert.match(rendered, /session: diagnostics-session/)
  assert.match(rendered, /session calls: 3; risk counts: \{"UNKNOWN":0,"LOW":0,"MEDIUM":1,"HIGH":0,"CRITICAL":0\}/)
  assert.match(rendered, /mutations: 1 file\(s\) this session/)
  assert.match(rendered, /counters: [^\n]*preExecuteChecked=3[^\n]*gateInjections=2/)
  assert.ok(!rendered.includes('stallsBlocked'), 'a zero counter is noise and is omitted')

  // A host with no session yet still gets a usable report.
  const empty = renderDiagnostics(buildDiagnostics({ policy: liveConfig().policy, config: liveConfig().config }))
  assert.match(empty, /session: none recorded yet/)

  // The text the model reads is hard-bounded, whatever the session accumulated.
  state.unexplainedFailures.push({ key: 'k', text: 'f'.repeat(6000), at: 1 })
  const capped = renderDiagnostics(reportFor(state, { detail: true }))
  assert.ok(capped.length <= 4000, `the rendered report must stay bounded, got ${capped.length}`)
})

test('the sbjw tool reports counters without leaking tool arguments', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'diagnostics-pipeline')
  const bucket = states().peek(agent.session)

  const write = await callTool(
    probe.ctx,
    'write',
    { file_path: '/tmp/sbjw-diag.txt', content: 'safe', justification: `rotate ${SECRET}; verification: rerun node --test` },
    { agent },
  )
  assert.equal(write.isError, false, 'the call under test must actually run')
  const recorded = bucket.calls.find((call) => call.toolName === 'write')
  assert.ok(recorded.argumentsPreview.includes('<redacted:'), 'the guard redacts the preview before it stores it')
  assert.ok(!recorded.argumentsPreview.includes(SECRET), 'the raw credential is never retained in session state')

  const rendered = resultText(await callTool(probe.ctx, 'sbjw', { detail: true }, { agent }))
  assert.match(rendered, /session calls: 2/)
  assert.match(rendered, /counters: [^\n]*preExecuteChecked=2/)
  assert.ok(!rendered.includes(SECRET), 'the rendered report must never carry the credential')
  assert.ok(!rendered.includes('rotate'), 'the rendered report must never quote the tool arguments')
})

test('a delivered user request never appears in the diagnostics report', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'diagnostics-request')
  const bucket = states().peek(agent.session)

  deliverSessionEvent(probe.ctx, agent, 'user/message', userMessage(REQUEST_TEXT))
  assert.equal(bucket.requirement, REQUEST_TEXT, 'the guard does record the request, so its absence below is meaningful')

  await callTool(probe.ctx, 'write', { file_path: '/tmp/sbjw-diag.txt', content: 'safe' }, { agent })
  const rendered = resultText(await callTool(probe.ctx, 'sbjw', { detail: true }, { agent }))
  assert.ok(rendered.includes('session: diagnostics-request'), 'the report is about this session')
  assert.ok(!rendered.includes(REQUEST_TEXT), 'raw request text is never part of the report, even with detail enabled')
})

test('argument previews stay out of the model-visible report and appear only when the option is enabled', async (t) => {
  // Even with `includeSensitiveContent` on, the tool renders only the bounded
  // summary: the option governs the returned report object, and the renderer
  // never prints samples. That is why the option's effect is asserted on the
  // report built from this session's real state below.
  const probe = await mountGuardHarness({ config: { diagnostics: { includeSensitiveContent: true } } })
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'diagnostics-samples')
  const bucket = states().peek(agent.session)

  await callTool(
    probe.ctx,
    'write',
    { file_path: '/tmp/sbjw-diag.txt', content: 'safe', justification: `rotate ${SECRET}` },
    { agent },
  )
  const rendered = resultText(await callTool(probe.ctx, 'sbjw', { detail: true }, { agent }))
  assert.match(rendered, /counters:/)
  assert.ok(!rendered.includes(SECRET), 'enabling the option must never print a raw credential')
  assert.ok(!rendered.includes('rotate'), 'the rendered report never quotes the argument preview')

  const { config, policy } = liveConfig({ diagnostics: { includeSensitiveContent: true } })
  const base = { policy, config, state: bucket, ledger: new EvidenceLedger(bucket, { maxRecords: 200 }), sessionId: 'diagnostics-samples' }
  const off = buildDiagnostics({ ...base, includeSensitiveContent: false })
  const on = buildDiagnostics({ ...base, includeSensitiveContent: true })
  assert.equal(Object.hasOwn(off, 'samples'), false, 'no samples section while the option is off')
  // The diagnostics call itself is recorded too, so the sample carrying the
  // argument preview is selected by tool name rather than by position.
  const writeSample = on.samples.find((sample) => sample.toolName === 'write')
  assert.ok(writeSample, 'the option exposes the recorded calls')
  assert.match(writeSample.argumentsPreview, /^rotate <redacted:[0-9a-f]{8}>$/, 'the sample is redacted as well as bounded')
  for (const sample of on.samples) {
    assert.ok(!String(sample.argumentsPreview).includes(SECRET), 'every exposed preview must be redacted')
  }
  assert.ok(!JSON.stringify(on).includes(SECRET), 'redaction is unconditional: the option controls verbosity, not exposure')
})

test('a failure description is redacted before it reaches the report', async (t) => {
  const probe = await mountGuardHarness()
  t.after(() => probe.ctx.fiber.dispose())
  const agent = await createAgent(probe.harness, 'diagnostics-failure')

  const failed = await callTool(probe.ctx, 'probe_echo', { text: `boom: could not read config token=${SECRET}`, fail: true }, { agent })
  assert.equal(failed.isError, true, 'the call must really fail for its text to be recorded')

  const rendered = resultText(await callTool(probe.ctx, 'sbjw', { detail: true }, { agent }))
  assert.match(rendered, /open failures: /, 'an unexplained failure is reported so the operator can act on it')
  assert.match(rendered, /<redacted:[0-9a-f]{8}>/, 'the credential in the failure text is redacted in place')
  assert.ok(!rendered.includes(SECRET), 'the raw credential never reaches the report')
})

// REFERENCE FINDING (not fixed here): the named-credential pattern stops at the
// first whitespace, so a scheme-prefixed header leaks the token after it.
test('an Authorization header value is redacted as a whole', () => {
  const redacted = redactSecrets('authorization: Bearer abc123def456')
  assert.ok(!redacted.includes('abc123def456'), 'the credential after the scheme must be redacted too')
})

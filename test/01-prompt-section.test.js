import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Guard from '../lib/index.js'
import { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, policyText } from '../lib/prompt.js'

test('the reliability policy registers as exactly one ordered system-prompt section', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Guard, {})

  const assembly = await ctx.systemPrompt.assemble({})
  const matching = assembly.sections.filter((entry) => entry.name === PROMPT_SECTION_NAME)
  assert.equal(matching.length, 1, 'the guard must register exactly one section')
  const section = matching[0]
  // The assembly returns sections in ascending order, so the declared order is
  // observable as placement: after the identity/persona prefix and before the
  // deployment persona suffix.
  const names = assembly.sections.map((entry) => entry.name)
  assert.ok(names.indexOf(PROMPT_SECTION_NAME) > 0, 'the policy must not be the first section')
  assert.ok(
    names.indexOf(PROMPT_SECTION_NAME) < names.indexOf('deployment:persona-suffix'),
    'the policy must precede the deployment persona suffix',
  )
  assert.equal(section.interpolate, false, 'the policy must not interpolate prompt variables')
  assert.equal(section.text, policyText('compact'))
  assert.equal(PROMPT_SECTION_ORDER, 8000, 'the documented placement order is part of the public contract')
})

test('the registered policy covers every required concern exactly once', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Guard, {})

  const assembly = await ctx.systemPrompt.assemble({})
  const text = assembly.sections.find((entry) => entry.name === PROMPT_SECTION_NAME).text
  const concerns = {
    'evidence before conclusion': /Evidence before conclusion/,
    'observe before change': /Observe before change/,
    'fact / inference / unknown': /Separate fact, inference, and unknown/,
    'current state overrides stale memory': /Current state beats stale memory/,
    'root-cause diagnosis': /Diagnose the root cause before patching/,
    'minimal patch': /Minimal patch/,
    'platform awareness': /Platform awareness/,
    'safe mutation': /Safe mutation/,
    'verify after change': /Verify after change/,
    'completion gate': /Completion gate/,
    'context hygiene': /Context hygiene/,
    'freshness': /Freshness\./,
    'truthful status reporting': /Never describe an action as done/,
  }
  for (const [concern, pattern] of Object.entries(concerns)) {
    assert.match(text, pattern, `the policy must cover: ${concern}`)
  }
})

test('the policy never asks for private chain-of-thought', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Guard, {})

  const assembly = await ctx.systemPrompt.assemble({})
  const text = assembly.sections.find((entry) => entry.name === PROMPT_SECTION_NAME).text
  assert.doesNotMatch(text, /think (?:step[- ]by[- ]step|out loud)|show your (?:reasoning|thinking)|chain[- ]of[- ]thought|内部推理/i)
  // The compact default must stay token-cheap: it is a policy, not a manual.
  assert.ok(text.length < 4200, `compact policy is ${text.length} characters; keep it under 4200`)
})

test('the full verbosity variant appends the per-class verification matrix', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Guard, { prompt: { verbosity: 'full' } })

  const assembly = await ctx.systemPrompt.assemble({})
  const text = assembly.sections.find((entry) => entry.name === PROMPT_SECTION_NAME).text
  assert.match(text, /Required verification per change class/)
  for (const klass of ['Source code', 'Build or packaging', 'Long-running service', 'Configuration', 'Installation']) {
    assert.match(text, new RegExp(klass))
  }
  assert.ok(text.length > policyText('compact').length)
})

test('disabling the prompt policy removes the section without breaking assembly', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Guard, { prompt: { enabled: false } })

  const assembly = await ctx.systemPrompt.assemble({})
  assert.equal(
    assembly.sections.find((entry) => entry.name === PROMPT_SECTION_NAME),
    undefined,
  )
  assert.ok(assembly.sections.length > 0, 'the first-party sections must still assemble')
})

test('a profile without the system-prompt service still loads the guard', async (t) => {
  // The guard must degrade, not fail: `systemPrompt` is read with ctx.get.
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(
    { name: 'tools-only', inject: [], apply(inner) {} },
  )
  const guarded = ctx.plugin(Guard, {})
  // `tools` never appears here, so the fiber stays withheld; the point of this
  // test is that registration itself must not throw.
  assert.ok(guarded !== undefined)
})

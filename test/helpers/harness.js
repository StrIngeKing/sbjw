/**
 * Shared test harness.
 *
 * Every test drives the REAL official pipeline: the tool registry's own
 * pre-execute / execute / post-execute / result stages, the real session log,
 * and — where a turn is involved — the production AgentLoop mounted by the
 * official testkit. Nothing official is mocked. The only test-owned pieces are
 * the tool definitions under examination and, for turn-level tests, a scripted
 * `LlmAdapter`, which is the official public extension point for a model
 * backend.
 *
 * @module test/helpers/harness
 */

import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Guard from '../../lib/index.js'

/** A logger that records every line instead of printing it. */
export function recordingLogger() {
  const lines = []
  const logger = {
    lines,
    debug: (message) => lines.push(['debug', String(message)]),
    info: (message) => lines.push(['info', String(message)]),
    warn: (message) => lines.push(['warn', String(message)]),
    error: (message) => lines.push(['error', String(message)]),
    at(level) {
      return lines.filter(([entryLevel]) => entryLevel === level).map(([, message]) => message)
    },
  }
  return logger
}

/**
 * Mount the official prerequisites, the guard, and the probe tools.
 *
 * @param options - harness options.
 * @param options.config - guard configuration overrides.
 * @param options.tools - whether to register the probe tools (default true).
 * @returns the context, guard fiber, logger, and probe tool helpers.
 */
export async function mountGuardHarness({ config = {}, tools = true, plugin = Guard, profileDir } = {}) {
  const ctx = new Context()
  const logger = recordingLogger()
  ctx.logger = logger
  if (profileDir) ctx.provide('profileContext', { dir: profileDir })

  await mountAgentLoopTestDependencies(ctx)
  const guardFiber = ctx.plugin(plugin, config)
  await guardFiber
  if (ctx.get('tools') === undefined) throw new Error('the tool registry did not activate; the harness topology is wrong')

  const events = []
  ctx.on('tools/pre-execute', (exec, next) => {
    events.push(`pre:${exec.name}`)
    return next()
  })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    events.push(`post:${exec.name}`)
    if (process.env.SBJW_TRACE_HARNESS === '1') {
      process.stderr.write(`[harness-post] enter name=${exec.name} resultKeys=${JSON.stringify(Object.keys(result ?? {}))}\n`)
    }
    const downstream = await next()
    if (process.env.SBJW_TRACE_HARNESS === '1') {
      process.stderr.write(`[harness-post] downstream keys=${JSON.stringify(Object.keys(downstream ?? {}))}\n`)
    }
    return downstream
  })
  ctx.on('tools/result', (exec, result) => {
    events.push(`result:${exec.name}:isError=${result.isError === true}`)
  })

  if (tools) registerProbeTools(ctx)

  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, guardFiber, logger, events, harness }
}

/** Register the probe tool family used by the tests. */
export function registerProbeTools(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'write',
      description: 'Test double for a single-file writer.',
      parameters: {
        file_path: { type: 'string', required: true, description: 'Target path.' },
        content: { type: 'string', required: true, description: 'Full new content.' },
        justification: { type: 'string', description: 'Stated plan.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        return `wrote ${args.file_path} (${args.content.length} bytes)`
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'pwsh',
      description: 'Test double for the pwsh tool.',
      parameters: {
        command: { type: 'string', required: true, description: 'Shell command.' },
        description: { type: 'string', description: 'Stated intent.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        return `ran: ${args.command}`
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'probe_read',
      description: 'Test double for a file reader.',
      parameters: { file_path: { type: 'string', required: true, description: 'Target path.' } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        return `contents of ${args.file_path}`
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'probe_echo',
      description: 'Test double that echoes a scripted result, including failure.',
      parameters: {
        text: { type: 'string', description: 'Text to echo.' },
        fail: { type: 'boolean', description: 'Throw instead of returning.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        if (args.fail === true) throw new Error(args.text ?? 'scripted failure')
        return args.text ?? 'ok'
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'probe_test',
      description: 'Test double for a test runner; the result text is scripted by the caller.',
      parameters: {
        output: { type: 'string', required: true, description: 'Exact runner output.' },
        failWith: { type: 'string', description: 'When present, the call fails with this message instead of returning the output.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        if (typeof args.failWith === 'string' && args.failWith !== '') throw new Error(args.failWith)
        return args.output
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'subagent',
      description: 'Test double for the subagent tool: returns the scripted reviewer report.',
      parameters: { report: { type: 'string', required: true, description: 'Reviewer report text.' } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        return args.report
      },
    }),
  )
}

/**
 * Invoke one tool through the real registry.
 *
 * @param ctx - the harness context.
 * @param name - tool name.
 * @param args - tool arguments.
 * @param options - invocation options.
 * @param options.agent - the calling agent, when the call must be attributed to a session.
 * @param options.callId - explicit call id.
 * @returns the finalized result.
 */
export async function callTool(ctx, name, args, { agent, callId } = {}) {
  const controller = new AbortController()
  return ctx.tools.execute({
    name,
    callId: callId ?? `call-${name}-${Math.random().toString(36).slice(2, 9)}`,
    arguments: args,
    signal: controller.signal,
    ...(agent === undefined ? {} : { agent }),
  })
}

/** Read the concatenated text content of a result. */
export function resultText(result) {
  return (result.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => String(part.text))
    .join('\n')
}

/** Read the source kinds of a result's additional contexts. */
export function contextKinds(result) {
  return (result.additionalContexts ?? []).map((message) => message.source?.kind)
}

/** Read the guard's injected notices from a result. */
export function guardNotices(result) {
  return (result.additionalContexts ?? [])
    .filter((message) => message.source?.kind === 'sbjw')
    .map((message) => ({
      tag: message.source?.tag,
      text: (message.content ?? []).map((part) => part.text).join('\n'),
    }))
}

/**
 * Build a message-shaped object for direct session/event dispatch in tests.
 *
 * @param text - the message text.
 * @param source - the message source tag.
 * @returns a user-role message.
 */
export function userMessage(text, source = { kind: 'user' }) {
  return {
    role: 'user',
    id: `test-${Math.random().toString(36).slice(2, 9)}`,
    content: [{ type: 'text', text }],
    source,
  }
}

/** Expose the guard's session-state bucket for assertions. */
export function stateOfFiber(guardFiber) {
  return guardFiber
}

/**
 * Create a real agent on the harness so tool calls carry a live session.
 *
 * @param harness - the testkit harness.
 * @param id - session id.
 * @param options - agent options.
 * @returns the production agent.
 */
export async function createAgent(harness, id, options = {}) {
  return harness.create(SessionId(id), options, { cwd: process.cwd() })
}

/**
 * Read a message's text content.
 *
 * @param message - a message-shaped object.
 * @returns the joined text parts.
 */
export function messageText(message) {
  return (message?.content ?? [])
    .filter((part) => part?.type === 'text')
    .map((part) => String(part.text))
    .join('\n')
}

/** Whether a result was reported as a failure by the pipeline. */
export function isErrorResult(result) {
  return result?.isError === true
}

/**
 * Append a durable session event, exactly as the real runtime does.
 *
 * @param agent - the owning agent.
 * @param type - the event type.
 * @param data - the event payload.
 * @returns the appended event.
 */
export function appendSessionEvent(agent, type, data) {
  return agent.session.append(type, data)
}

/**
 * Deliver a session event without going through the durable surface planner.
 *
 * Some event types (notably `assistant/message`) are surface-eligible and
 * require a `surfaceOp` marker the surface manager validates. Tests that only
 * exercise an event consumer use this, so the assertion covers the consumer
 * rather than the surface bookkeeping.
 *
 * @param ctx - the harness context.
 * @param agent - the owning agent.
 * @param type - the event type.
 * @param data - the event payload.
 * @returns the delivered event.
 */
export function deliverSessionEvent(ctx, agent, type, data) {
  const event = { type, seq: 0, time: Date.now(), data }
  ctx.emit('session/event', agent.session, event)
  return event
}

/**
 * Build an assistant message event payload carrying one text block.
 *
 * @param text - the message text.
 * @returns the `assistant/message` event data.
 */
export function assistantMessageData(text) {
  return {
    message: {
      role: 'assistant',
      id: `assistant-${Math.random().toString(36).slice(2, 9)}`,
      content: [{ type: 'text', text }],
      source: { kind: 'assistant' },
    },
  }
}
